const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

// Honor HTTP(S)_PROXY env vars for outbound market-data fetches, if undici is available.
try {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {
  /* fall back to direct fetch */
}

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const CUSTOMERS_PATH = path.join(DATA_DIR, "customers.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Tokens are signed with this secret; set SESSION_SECRET in production so
// logins survive restarts.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Data helpers ─────────────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ── Live Indian 24K gold rate ────────────────────────────────────────────────
// The INR gold price is fetched live (goldprice.org INR feed first, with a
// spot × USD/INR fallback chain), then adjusted to the Indian market rate by
// applying import duty and local premium from config — Indian published rates
// (IBJA/MCX) sit above converted international spot by roughly these margins.
// Clients poll /api/rate every second and get the cached value. If every feed
// is unreachable, the configured rate in config.json is used as a fallback.
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const RATE_REFRESH_MS = 30 * 1000;

let rateCache = { ratePerGram: null, source: "fallback", asOf: null, fetchedAt: 0 };

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// INR per troy ounce, straight from an INR-denominated feed.
async function fetchInrPerOunceDirect() {
  const data = await fetchJson("https://data-asg.goldprice.org/dbXRates/INR");
  const inrPerOunce = Number(data.items?.[0]?.xauPrice);
  if (!Number.isFinite(inrPerOunce)) throw new Error("Malformed INR gold data");
  return inrPerOunce;
}

// Fallback chain: international spot × USD/INR.
async function fetchInrPerOunceViaUsd() {
  const [gold, fx] = await Promise.all([
    fetchJson("https://api.gold-api.com/price/XAU"),
    fetchJson("https://open.er-api.com/v6/latest/USD"),
  ]);
  const usdPerOunce = Number(gold.price);
  const inrPerUsd = Number(fx.rates?.INR);
  if (!Number.isFinite(usdPerOunce) || !Number.isFinite(inrPerUsd)) {
    throw new Error("Malformed market data");
  }
  return usdPerOunce * inrPerUsd;
}

async function refreshLiveRate() {
  let inrPerOunce;
  try {
    inrPerOunce = await fetchInrPerOunceDirect();
  } catch {
    inrPerOunce = await fetchInrPerOunceViaUsd();
  }

  // Landed Indian market rate: customs import duty + local market premium on
  // top of the INR spot price. Tune both in config.json to track IBJA/MCX.
  const config = loadConfig();
  const duty = 1 + (config.importDutyPercent || 0) / 100;
  const premium = 1 + (config.localPremiumPercent || 0) / 100;

  rateCache = {
    ratePerGram: Math.round((inrPerOunce / GRAMS_PER_TROY_OUNCE) * duty * premium),
    source: "live",
    asOf: new Date().toISOString(),
    fetchedAt: Date.now(),
  };
}

async function getRate() {
  if (Date.now() - rateCache.fetchedAt > RATE_REFRESH_MS) {
    try {
      await refreshLiveRate();
    } catch (e) {
      // Keep serving the last known rate; use the configured rate if we never
      // had a live one. Bump fetchedAt so a dead feed isn't hammered.
      if (!rateCache.ratePerGram) {
        const config = loadConfig();
        rateCache = {
          ratePerGram: config.goldRatePerGram24K,
          source: "fallback",
          asOf: config.updatedOn,
          fetchedAt: Date.now(),
        };
      } else {
        rateCache.fetchedAt = Date.now();
      }
    }
  }
  return rateCache;
}

function loadCustomers() {
  if (!fs.existsSync(CUSTOMERS_PATH)) return [];
  return JSON.parse(fs.readFileSync(CUSTOMERS_PATH, "utf8"));
}

function saveCustomers(customers) {
  fs.writeFileSync(CUSTOMERS_PATH, JSON.stringify(customers, null, 2));
}

// ── KYC document uploads ─────────────────────────────────────────────────────
const ALLOWED_DOC_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = ALLOWED_DOC_TYPES[file.mimetype] || "";
      cb(null, `${file.fieldname}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per document
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error("KYC documents must be JPG, PNG or PDF"));
  },
});

const kycUpload = upload.fields([
  { name: "aadhaarDoc", maxCount: 1 },
  { name: "panDoc", maxCount: 1 },
]);

function removeUploadedFiles(req) {
  for (const field of Object.values(req.files || {})) {
    for (const f of field) fs.unlink(f.path, () => {});
  }
}

// ── Validation ───────────────────────────────────────────────────────────────
function normalizeMobile(raw) {
  const digits = String(raw || "").replace(/[\s\-+]/g, "").replace(/^91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function normalizeAadhaar(raw) {
  const digits = String(raw || "").replace(/\s/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

function normalizePan(raw) {
  const pan = String(raw || "").trim().toUpperCase();
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : null;
}

function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw || "").trim());
}

const maskAadhaar = (a) => "XXXX XXXX " + a.slice(-4);
const maskPan = (p) => "XXXXXX" + p.slice(-4);

// ── Auth tokens ──────────────────────────────────────────────────────────────
function signToken(accountId) {
  const payload = Buffer.from(JSON.stringify({ accountId, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data.accountId;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const accountId = verifyToken(token);
  if (!accountId) return res.status(401).json({ error: "Please log in again" });
  const customer = loadCustomers().find((c) => c.accountId === accountId);
  if (!customer) return res.status(401).json({ error: "Account not found" });
  req.customer = customer;
  next();
}

// ── Portfolio view ───────────────────────────────────────────────────────────
function addMonths(iso, months) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

async function accountView(customer) {
  const config = loadConfig();
  const { ratePerGram: rate, source: rateSource, asOf: rateAsOf } = await getRate();
  const totalInvested = customer.purchases.reduce((s, p) => s + p.amount, 0);
  const totalGst = customer.purchases.reduce((s, p) => s + (p.gst || 0), 0);
  const totalPaid = totalInvested + totalGst;
  const totalGrams = Number(customer.purchases.reduce((s, p) => s + p.grams, 0).toFixed(4));
  const currentValue = Math.round(totalGrams * rate);
  const firstPurchase = customer.purchases[0];
  const redeemableFrom = firstPurchase ? addMonths(firstPurchase.date, config.lockInMonths) : null;
  return {
    accountId: customer.accountId,
    name: customer.name,
    mobile: customer.mobile,
    email: customer.email,
    aadhaar: maskAadhaar(customer.aadhaar),
    pan: maskPan(customer.pan),
    kycStatus: customer.kycVerified ? "Verified" : "Under verification",
    createdAt: customer.createdAt,
    purchases: customer.purchases.map((p) => ({
      date: p.date,
      amount: p.amount,
      gst: p.gst || 0,
      totalPaid: p.totalPaid || p.amount,
      ratePerGram: p.ratePerGram,
      grams: p.grams,
    })),
    totals: {
      invested: totalInvested,
      gst: totalGst,
      totalPaid,
      grams: totalGrams,
      currentValue,
      gainLoss: currentValue - totalPaid,
    },
    scheme: {
      lockInMonths: config.lockInMonths,
      redeemableFrom,
      redemption: "Gold coins (1% making charge) or cash withdrawal of equivalent value",
      makingChargePercent: config.makingChargePercent,
      estimatedMakingCharge: Math.round((currentValue * config.makingChargePercent) / 100),
      cashWithdrawalValue: currentValue,
    },
    todayRatePerGram: rate,
    rateSource,
    rateAsOf,
  };
}

// ── Public endpoints ─────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/config", (req, res) => res.json(loadConfig()));

// Live 24K rate — clients poll this every second; served from the server cache.
app.get("/api/rate", async (req, res) => {
  const { ratePerGram, source, asOf } = await getRate();
  res.json({ ratePerGram24K: ratePerGram, source, asOf });
});

// Convert between rupees and grams at today's rate. Accepts { amount } or { grams }.
app.post("/api/calculate", async (req, res) => {
  const { amount, grams } = req.body || {};
  const config = loadConfig();
  const { ratePerGram: rate } = await getRate();

  const withGst = (rupees) => {
    const gst = Math.round((rupees * config.gstPercent) / 100);
    return { gst, gstPercent: config.gstPercent, totalPayable: Math.round(rupees) + gst };
  };

  if (amount !== undefined && amount !== null && amount !== "") {
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees < config.minPurchaseAmount) {
      return res.status(400).json({ error: `Minimum purchase is ₹${config.minPurchaseAmount}` });
    }
    return res.json({
      amount: rupees,
      ratePerGram: rate,
      grams: Number((rupees / rate).toFixed(4)),
      ...withGst(rupees),
    });
  }

  if (grams !== undefined && grams !== null && grams !== "") {
    const g = Number(grams);
    if (!Number.isFinite(g) || g <= 0) {
      return res.status(400).json({ error: "Enter a valid number of grams" });
    }
    const rupees = g * rate;
    if (rupees < config.minPurchaseAmount) {
      return res.status(400).json({ error: `Minimum purchase is ₹${config.minPurchaseAmount}` });
    }
    return res.json({ grams: g, ratePerGram: rate, amount: Math.round(rupees), ...withGst(rupees) });
  }

  res.status(400).json({ error: "Provide an amount in ₹ or grams" });
});

// ── Account creation with KYC ────────────────────────────────────────────────
app.post("/api/register", (req, res) => {
  kycUpload(req, res, (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({
        error: uploadErr.code === "LIMIT_FILE_SIZE" ? "Each document must be under 5 MB" : uploadErr.message,
      });
    }

    const fail = (status, error) => {
      removeUploadedFiles(req);
      res.status(status).json({ error });
    };

    const { name, mobile, email, aadhaar, pan } = req.body || {};

    if (!name || !String(name).trim()) return fail(400, "Name is required");
    const normMobile = normalizeMobile(mobile);
    if (!normMobile) return fail(400, "Enter a valid 10-digit Indian mobile number");
    if (!isValidEmail(email)) return fail(400, "A valid email address is required");
    const normAadhaar = normalizeAadhaar(aadhaar);
    if (!normAadhaar) return fail(400, "Aadhaar must be a 12-digit number");
    const normPan = normalizePan(pan);
    if (!normPan) return fail(400, "PAN must look like ABCDE1234F");

    const aadhaarDoc = req.files?.aadhaarDoc?.[0];
    const panDoc = req.files?.panDoc?.[0];
    if (!aadhaarDoc) return fail(400, "Please upload your Aadhaar document (JPG, PNG or PDF)");
    if (!panDoc) return fail(400, "Please upload your PAN document (JPG, PNG or PDF)");

    const customers = loadCustomers();
    if (customers.some((c) => c.mobile === normMobile)) {
      return fail(409, "An account already exists for this mobile number — please log in");
    }
    if (customers.some((c) => c.pan === normPan)) {
      return fail(409, "An account already exists for this PAN — please log in");
    }

    const accountId = "APJ-" + crypto.randomBytes(4).toString("hex").toUpperCase();

    customers.push({
      accountId,
      name: String(name).trim(),
      mobile: normMobile,
      email: String(email).trim(),
      aadhaar: normAadhaar,
      pan: normPan,
      aadhaarDocFile: aadhaarDoc.filename,
      panDocFile: panDoc.filename,
      kycVerified: false,
      createdAt: new Date().toISOString(),
      purchases: [],
    });
    saveCustomers(customers);

    res.json({
      accountId,
      message: `Account created! Your account ID is ${accountId}. Keep it safe — you'll use it with your mobile number to log in. Our team will verify your KYC within 24 hours.`,
    });
  });
});

// ── Login: account ID + registered mobile ────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { accountId, mobile } = req.body || {};
  const normMobile = normalizeMobile(mobile);
  const customer = loadCustomers().find(
    (c) => c.accountId === String(accountId || "").trim().toUpperCase() && c.mobile === normMobile
  );
  if (!customer) return res.status(401).json({ error: "Account ID and mobile number don't match" });
  res.json({ token: signToken(customer.accountId), name: customer.name, accountId: customer.accountId });
});

// ── Portfolio ────────────────────────────────────────────────────────────────
app.get("/api/account", requireAuth, async (req, res) => {
  res.json(await accountView(req.customer));
});

// ── Record a gold purchase at the live rate ──────────────────────────────────
app.post("/api/purchase", requireAuth, async (req, res) => {
  const config = loadConfig();
  const rupees = Number(req.body?.amount);
  if (!Number.isFinite(rupees) || rupees < config.minPurchaseAmount) {
    return res.status(400).json({ error: `Minimum purchase is ₹${config.minPurchaseAmount}` });
  }

  const { ratePerGram: rate } = await getRate();
  const amount = Math.round(rupees);
  const gst = Math.round((amount * config.gstPercent) / 100);
  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === req.customer.accountId);
  customer.purchases.push({
    id: "PUR-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    date: new Date().toISOString(),
    amount,
    gst,
    totalPaid: amount + gst,
    ratePerGram: rate,
    grams: Number((amount / rate).toFixed(4)),
  });
  saveCustomers(customers);

  res.json({
    message: `Purchase recorded — total payable ₹${(amount + gst).toLocaleString("en-IN")} (incl. ${config.gstPercent}% GST). Our team will contact you to collect payment and confirm the credit.`,
    account: await accountView(customer),
  });
});

// ── Admin: full customer list (requires ADMIN_KEY env var) ───────────────────
app.get("/api/customers", (req, res) => {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Not authorized" });
  }
  res.json(loadCustomers());
});

app.listen(PORT, () => console.log(`Aparanji Digital Gold website running on port ${PORT}`));
