const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

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
const RATE_HISTORY_PATH = path.join(DATA_DIR, "rate-history.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const RECEIPTS_DIR = path.join(DATA_DIR, "receipts");
const INVOICES_DIR = path.join(DATA_DIR, "invoices");
const ACKS_DIR = path.join(DATA_DIR, "acks");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
fs.mkdirSync(INVOICES_DIR, { recursive: true });
fs.mkdirSync(ACKS_DIR, { recursive: true });

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

// ── Live 24K gold rate — Jewellers' Association Bangalore (jab.org.in) ────────
// The gold rate is sourced ONLY from JAB — never MCX or international spot.
// Primary: scrape the published 24K (999) per-gram rate from jab.org.in.
// Fallback: the JAB rate entered by staff in config.json (goldRatePerGram24K /
// updatedOn) — still a real JAB figure, just keyed in manually rather than
// scraped. Clients poll /api/rate every second and get the cached value.
const RATE_REFRESH_MS = 30 * 1000;

let rateCache = { ratePerGram: null, source: null, asOf: null, fetchedAt: 0 };

async function fetchText(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Extract the 24K (999) per-gram rate from the JAB (Jewellers' Association
// Bangalore) homepage. Tolerant of markup changes: scans both the visible text
// and the raw HTML (in case rates are embedded in an inline script/JSON), looks
// for a figure near a 999/24K label, and scales per-10g values down to per-gram.
function parseJabRate(html) {
  const patterns = [
    /(?:999|24\s*(?:k|kt|ct|carat|karat))[^0-9]{0,60}?(?:rs\.?|inr|₹)?\s*([\d,]{4,8})(?:\.\d+)?/i,
    /(?:fine\s*gold|gold\s*999)[^0-9]{0,60}?([\d,]{4,8})(?:\.\d+)?/i,
  ];
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;?/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
  const raw = html.replace(/\s+/g, " ");

  for (const source of [visible, raw]) {
    for (const re of patterns) {
      const m = source.match(re);
      if (!m) continue;
      let value = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      if (value >= 40000 && value <= 400000) value = value / 10; // per 10 g
      if (value >= 4000 && value <= 40000) return Math.round(value); // per gram
    }
  }
  throw new Error("Could not find a 24K rate on the JAB page");
}

async function fetchJabRatePerGram() {
  return parseJabRate(await fetchText("https://jab.org.in/"));
}

async function refreshLiveRate() {
  // JAB published rate, scraped live — the only rate basis for the site.
  const ratePerGram = await fetchJabRatePerGram(); // throws if unavailable
  rateCache = {
    ratePerGram,
    source: "jab",
    asOf: new Date().toISOString(),
    fetchedAt: Date.now(),
  };
  recordRatePoint(ratePerGram);
}

// Append at most one history point per day from the live feed, so the price
// graph keeps extending itself once the site is deployed.
function recordRatePoint(ratePerGram) {
  try {
    const history = JSON.parse(fs.readFileSync(RATE_HISTORY_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const last = history.points[history.points.length - 1];
    if (last && last.date === today) {
      last.ratePerGram = ratePerGram;
    } else {
      history.points.push({ date: today, ratePerGram });
    }
    if (history.points.length > 1000) history.points = history.points.slice(-1000);
    fs.writeFileSync(RATE_HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error("Rate history write failed:", e.message);
  }
}

async function getRate() {
  if (Date.now() - rateCache.fetchedAt > RATE_REFRESH_MS) {
    try {
      await refreshLiveRate();
    } catch (e) {
      // JAB scrape unavailable: fall back to the JAB rate staff keyed into
      // config.json. Keep a previously scraped live value if we have one.
      if (rateCache.source !== "jab" || !rateCache.ratePerGram) {
        const config = loadConfig();
        rateCache = {
          ratePerGram: config.goldRatePerGram24K,
          source: "jab-manual",
          asOf: config.updatedOn,
          fetchedAt: Date.now(),
        };
        recordRatePoint(rateCache.ratePerGram);
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
const maskAccount = (a) => (a.length > 4 ? "XXXX" + a.slice(-4) : a);

function normalizeIfsc(raw) {
  const ifsc = String(raw || "").trim().toUpperCase();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ? ifsc : null;
}

function normalizeAccountNumber(raw) {
  const acc = String(raw || "").replace(/\s/g, "");
  return /^\d{9,18}$/.test(acc) ? acc : null;
}

// Validate the bank details a customer supplies for a bank-transfer withdrawal.
// Returns { ok: true, bankDetails } or { ok: false, error }.
function validateBankDetails(raw) {
  const bankName = String(raw?.bankName || "").trim();
  const accountHolder = String(raw?.accountHolder || "").trim();
  const accountNumber = normalizeAccountNumber(raw?.accountNumber);
  const ifsc = normalizeIfsc(raw?.ifsc);
  if (!bankName) return { ok: false, error: "Enter your bank name" };
  if (!accountHolder) return { ok: false, error: "Enter the account holder's name" };
  if (!accountNumber) return { ok: false, error: "Enter a valid account number (9–18 digits)" };
  if (!ifsc) return { ok: false, error: "Enter a valid IFSC code (e.g. HDFC0001234)" };
  return { ok: true, bankDetails: { bankName, accountHolder, accountNumber, ifsc } };
}

// Validate the shipping address for a gold-coin redemption.
function validateShippingAddress(raw) {
  const name = String(raw?.name || "").trim();
  const addressLine = String(raw?.addressLine || "").trim();
  const city = String(raw?.city || "").trim();
  const pincode = String(raw?.pincode || "").replace(/\s/g, "");
  const phone = normalizeMobile(raw?.phone);
  if (!name) return { ok: false, error: "Enter the recipient's name" };
  if (addressLine.length < 8) return { ok: false, error: "Enter the full delivery address" };
  if (!city) return { ok: false, error: "Enter the city / town" };
  if (!/^\d{6}$/.test(pincode)) return { ok: false, error: "Enter a valid 6-digit PIN code" };
  if (!phone) return { ok: false, error: "Enter a valid 10-digit contact number" };
  return { ok: true, shipping: { name, addressLine, city, pincode, phone } };
}

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

// Confirmed purchases only — pending (unpaid) deposits do not count as holdings.
const confirmedPurchases = (customer) => customer.purchases.filter((p) => p.status === "confirmed");

async function accountView(customer) {
  const config = loadConfig();
  const { ratePerGram: rate, source: rateSource, asOf: rateAsOf } = await getRate();
  const confirmed = confirmedPurchases(customer);
  const totalInvested = confirmed.reduce((s, p) => s + p.amount, 0);
  const totalGst = confirmed.reduce((s, p) => s + (p.gst || 0), 0);
  const totalPaid = totalInvested + totalGst;
  const totalGrams = Number(confirmed.reduce((s, p) => s + p.grams, 0).toFixed(4));
  const currentValue = Math.round(totalGrams * rate);
  const firstConfirmed = confirmed[0];
  const redeemableFrom = firstConfirmed ? addMonths(firstConfirmed.date, config.lockInMonths) : null;
  const matured = Boolean(redeemableFrom && Date.now() >= new Date(redeemableFrom).getTime());
  const monthsRemaining = redeemableFrom
    ? Math.max(0, Math.ceil((new Date(redeemableFrom).getTime() - Date.now()) / (30.44 * 24 * 3600 * 1000)))
    : null;
  const pendingCount = customer.purchases.filter((p) => p.status === "pending").length;
  return {
    accountId: customer.accountId,
    name: customer.name,
    mobile: customer.mobile,
    email: customer.email,
    aadhaar: maskAadhaar(customer.aadhaar),
    pan: maskPan(customer.pan),
    kycStatus: customer.kycVerified ? "Verified" : "Under verification",
    createdAt: customer.createdAt,
    pendingCount,
    purchases: customer.purchases.map((p) => ({
      id: p.id,
      date: p.date,
      amount: p.amount,
      gst: p.gst || 0,
      totalPaid: p.totalPaid || p.amount,
      ratePerGram: p.ratePerGram,
      grams: p.grams,
      status: p.status || "confirmed",
      paymentRef: p.paymentRef || null,
      receiptAvailable: (p.status || "confirmed") === "confirmed",
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
      matured,
      monthsRemaining,
      redemption: "Gold coins (1% making charge) or cash withdrawal of equivalent value",
      makingChargePercent: config.makingChargePercent,
      estimatedMakingCharge: Math.round((currentValue * config.makingChargePercent) / 100),
      cashWithdrawalValue: currentValue,
    },
    redemptions: (customer.redemptions || []).map((r) => ({
      id: r.id,
      date: r.date,
      mode: r.mode,
      grams: r.grams,
      ratePerGram: r.ratePerGram,
      grossValue: r.grossValue,
      makingCharge: r.makingCharge,
      netPayout: r.netPayout,
      bank: r.bankDetails
        ? `${r.bankDetails.bankName} · A/c ${maskAccount(r.bankDetails.accountNumber)} · ${r.bankDetails.ifsc}`
        : null,
      payment: r.payment
        ? { reference: r.payment.reference, method: r.payment.method, paidOn: r.payment.paidOn }
        : null,
      shipment: r.shipment
        ? {
            addressLine: r.shipment.addressLine,
            city: r.shipment.city,
            pincode: r.shipment.pincode,
            courier: r.shipment.courier || null,
            trackingNumber: r.shipment.trackingNumber || null,
            dispatchedOn: r.shipment.dispatchedOn || null,
          }
        : null,
      status: r.status,
    })),
    savingPlan: customer.savingPlan || null,
    todayRatePerGram: rate,
    rateSource,
    rateAsOf,
  };
}

// ── PDF receipt voucher ──────────────────────────────────────────────────────
// Built-in PDF fonts have no rupee glyph, so amounts use "Rs." on paper.
const rs = (n) => "Rs. " + Number(n).toLocaleString("en-IN");

function generateReceiptPdf(customer, purchase, runningTotals, config) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(RECEIPTS_DIR, `${purchase.id}.pdf`);
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ink = "#16130f";
    const gold = "#c9a24b";
    const goldDark = "#8a6d24";
    const muted = "#6b6355";
    const pageWidth = doc.page.width;
    const left = 50;
    const right = pageWidth - 50;

    // Header band
    doc.rect(0, 0, pageWidth, 110).fill(ink);
    doc.circle(left + 22, 55, 22).fill(gold);
    doc.fillColor(ink).font("Times-Bold").fontSize(24).text("A", left + 14, 42);
    doc.fillColor("#faf6ec").font("Times-Bold").fontSize(22).text("Aparanji", left + 58, 36);
    doc.fillColor(gold).font("Helvetica").fontSize(9)
      .text("YOUR GOLD COIN PARTNER", left + 58, 64, { characterSpacing: 1 });
    doc.fillColor("#faf6ec").font("Helvetica-Bold").fontSize(15)
      .text("RECEIPT VOUCHER", left, 48, { align: "right", width: right - left });

    // Receipt meta
    let y = 140;
    doc.fillColor(muted).font("Helvetica").fontSize(10);
    doc.text(`Receipt No: ${purchase.id}`, left, y);
    const when = new Date(purchase.date).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    doc.text(`Date: ${when}`, left, y, { align: "right", width: right - left });

    // Customer block
    y += 30;
    doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("RECEIVED FROM", left, y);
    y += 18;
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(customer.name, left, y);
    y += 16;
    doc.fillColor(muted).font("Helvetica").fontSize(10)
      .text(`Account: ${customer.accountId}   ·   Mobile: ${customer.mobile}   ·   Email: ${customer.email}`, left, y);
    y += 14;
    doc.text(`PAN: ${maskPan(customer.pan)}   ·   Aadhaar: ${maskAadhaar(customer.aadhaar)}`, left, y);

    // Amount table
    y += 34;
    const rows = [
      ["Gold value", rs(purchase.amount)],
      [`GST (${config.gstPercent}%)`, rs(purchase.gst)],
      ["Total amount received", rs(purchase.totalPaid)],
      ["Rate applied (24K 999)", rs(purchase.ratePerGram) + " / gram"],
      ["Gold credited", purchase.grams.toFixed(4) + " g"],
    ];
    const rowH = 26;
    rows.forEach(([label, value], i) => {
      const rowY = y + i * rowH;
      if (i % 2 === 0) doc.rect(left, rowY, right - left, rowH).fill("#faf6ec");
      const bold = label.startsWith("Total") || label.startsWith("Gold credited");
      doc.fillColor(bold ? ink : muted).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
        .text(label, left + 12, rowY + 7);
      doc.fillColor(bold ? goldDark : ink).font("Helvetica-Bold").fontSize(11)
        .text(value, left, rowY + 7, { align: "right", width: right - left - 12 });
    });
    y += rows.length * rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(gold).stroke();

    // Balance after this deposit
    y += 20;
    doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("ACCOUNT BALANCE AFTER THIS DEPOSIT", left, y);
    y += 18;
    doc.fillColor(ink).font("Helvetica").fontSize(10.5).text(
      `Total gold held: ${runningTotals.grams.toFixed(4)} g   ·   Total invested: ${rs(runningTotals.invested)} (+ ${rs(runningTotals.gst)} GST)`,
      left, y
    );

    // How to pay
    const pay = config.payment;
    if (pay) {
      y += 30;
      doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("HOW TO PAY", left, y);
      y += 18;
      doc.fillColor(ink).font("Helvetica").fontSize(10)
        .text(`UPI: ${pay.vpa}   ·   MMID: ${pay.mmid}`, left, y);
      y += 14;
      doc.text(
        `Bank transfer (NEFT/IMPS): ${pay.accountName} · ${pay.bankName}, ${pay.branch} · ` +
        `A/c ${pay.accountNumber} · IFSC ${pay.ifsc}`,
        left, y, { width: right - left }
      );
      y = doc.y + 6;
      doc.fillColor(muted).fontSize(9)
        .text(`Please quote receipt number ${purchase.id} in the payment remarks.`, left, y);
      y = doc.y;
    }

    // Scheme terms
    y += 30;
    doc.fillColor(muted).font("Helvetica").fontSize(9).text(
      `Scheme terms: ${config.lockInMonths}-month lock-in from your first purchase. On maturity, redeem as gold coins ` +
      `(${config.makingChargePercent}% making charge at closure) or withdraw the equivalent value in money. ` +
      `Gold rate is the Jewellers' Association Bangalore (jab.org.in) 24K rate published at the time of purchase.`,
      left, y, { width: right - left }
    );

    // Footer
    doc.fillColor(muted).font("Helvetica-Oblique").fontSize(8.5).text(
      "This is a computer-generated receipt and does not require a signature.",
      left, doc.page.height - 70, { align: "center", width: right - left }
    );

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// ── Redemption invoice ───────────────────────────────────────────────────────
// Accumulated grams × gold rate on the redemption date, plus the 1% making
// charge only when gold coins are taken. No fresh GST: it was already paid on
// each scheme deposit, which the invoice states explicitly.
function generateInvoicePdf(customer, redemption, config) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(INVOICES_DIR, `${redemption.id}.pdf`);
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ink = "#16130f";
    const gold = "#c9a24b";
    const goldDark = "#8a6d24";
    const muted = "#6b6355";
    const pageWidth = doc.page.width;
    const left = 50;
    const right = pageWidth - 50;
    const isCoins = redemption.mode === "coins";

    // Header band
    doc.rect(0, 0, pageWidth, 110).fill(ink);
    doc.circle(left + 22, 55, 22).fill(gold);
    doc.fillColor(ink).font("Times-Bold").fontSize(24).text("A", left + 14, 42);
    doc.fillColor("#faf6ec").font("Times-Bold").fontSize(22).text("Aparanji", left + 58, 36);
    doc.fillColor(gold).font("Helvetica").fontSize(9)
      .text("YOUR GOLD COIN PARTNER", left + 58, 64, { characterSpacing: 1 });
    doc.fillColor("#faf6ec").font("Helvetica-Bold").fontSize(15)
      .text("REDEMPTION INVOICE", left, 48, { align: "right", width: right - left });

    // Invoice meta
    let y = 140;
    doc.fillColor(muted).font("Helvetica").fontSize(10);
    doc.text(`Invoice No: ${redemption.id}`, left, y);
    const when = new Date(redemption.date).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    doc.text(`Date of redemption: ${when}`, left, y, { align: "right", width: right - left });
    y += 14;
    doc.fillColor(goldDark).font("Helvetica-Bold")
      .text(`Redemption mode: ${isCoins ? "Gold coins" : "Cash withdrawal to bank account"}`, left, y);

    // Customer block
    y += 26;
    doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("BILLED TO", left, y);
    y += 18;
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(customer.name, left, y);
    y += 16;
    doc.fillColor(muted).font("Helvetica").fontSize(10)
      .text(`Account: ${customer.accountId}   ·   Mobile: ${customer.mobile}   ·   Email: ${customer.email}`, left, y);
    y += 14;
    doc.text(`PAN: ${maskPan(customer.pan)}   ·   Aadhaar: ${maskAadhaar(customer.aadhaar)}`, left, y);

    // Deposits covered by this redemption
    const deposits = redemption.purchases || [];
    const totalInvested = deposits.reduce((s, p) => s + p.amount, 0);
    const gstPaid = deposits.reduce((s, p) => s + (p.gst || 0), 0);
    const firstDate = deposits.length ? new Date(deposits[0].date) : null;
    y += 26;
    doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("SCHEME SUMMARY", left, y);
    y += 18;
    const fmtDate = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    doc.fillColor(ink).font("Helvetica").fontSize(10.5).text(
      `${deposits.length} deposit${deposits.length === 1 ? "" : "s"}` +
      (firstDate ? ` since ${fmtDate(firstDate)}` : "") +
      `   ·   Total invested: ${rs(totalInvested)}   ·   GST already paid: ${rs(gstPaid)}`,
      left, y
    );

    // Amount table
    y += 30;
    const rows = [
      ["Accumulated gold", redemption.grams.toFixed(4) + " g"],
      ["Gold rate on date of redemption (24K 999)", rs(redemption.ratePerGram) + " / gram"],
      ["Gross redemption value", rs(redemption.grossValue)],
    ];
    if (isCoins) {
      rows.push([`Making charge on gold coins (${config.makingChargePercent}%)`, rs(redemption.makingCharge)]);
      rows.push(["Total invoice value", rs(redemption.grossValue + redemption.makingCharge)]);
    } else {
      rows.push(["Making charge", "Nil — cash withdrawal"]);
      rows.push(["Amount payable to your bank account", rs(redemption.grossValue)]);
    }
    const rowH = 26;
    rows.forEach(([label, value], i) => {
      const rowY = y + i * rowH;
      if (i % 2 === 0) doc.rect(left, rowY, right - left, rowH).fill("#faf6ec");
      const bold = i >= rows.length - 1;
      doc.fillColor(bold ? ink : muted).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
        .text(label, left + 12, rowY + 7);
      doc.fillColor(bold ? goldDark : ink).font("Helvetica-Bold").fontSize(11)
        .text(value, left, rowY + 7, { align: "right", width: right - left - 12 });
    });
    y += rows.length * rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(gold).stroke();

    // Settlement + GST notes
    y += 20;
    const bd = redemption.bankDetails;
    const sh = redemption.shipment;
    doc.fillColor(ink).font("Helvetica").fontSize(10).text(
      isCoins
        ? `Settlement: ${redemption.grams.toFixed(4)} g of 24K gold coins (making charge ${rs(redemption.makingCharge)}) to be shipped to` +
          (sh ? ` ${sh.name}, ${sh.addressLine}, ${sh.city} - ${sh.pincode}, phone ${sh.phone}.` : " your registered address.")
        : `Settlement: ${rs(redemption.grossValue)} to be transferred within 2 working days by bank transfer to` +
          (bd ? ` ${bd.accountHolder}, ${bd.bankName}, A/c ${bd.accountNumber}, IFSC ${bd.ifsc}.` : " your registered bank account."),
      left, y, { width: right - left }
    );
    y = doc.y + 12;
    doc.fillColor(muted).font("Helvetica").fontSize(9).text(
      `GST: inclusive. GST @ ${config.gstPercent}% totalling ${rs(gstPaid)} was already collected on each scheme deposit ` +
      `covered by this invoice; no further GST is charged on redemption.`,
      left, y, { width: right - left }
    );

    // Footer
    doc.fillColor(muted).font("Helvetica-Oblique").fontSize(8.5).text(
      "This is a computer-generated invoice and does not require a signature.",
      left, doc.page.height - 70, { align: "center", width: right - left }
    );

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// Totals up to and including the given purchase index.
function totalsUpTo(purchases, index) {
  const slice = purchases.slice(0, index + 1);
  return {
    invested: slice.reduce((s, p) => s + p.amount, 0),
    gst: slice.reduce((s, p) => s + (p.gst || 0), 0),
    grams: slice.reduce((s, p) => s + p.grams, 0),
  };
}

// ── Withdrawal payment acknowledgement ───────────────────────────────────────
// Generated once an administrator records that the bank transfer was made.
function generatePaymentAckPdf(customer, redemption) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(ACKS_DIR, `${redemption.id}.pdf`);
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ink = "#16130f", gold = "#c9a24b", goldDark = "#8a6d24", muted = "#6b6355", green = "#2f7d4f";
    const pageWidth = doc.page.width, left = 50, right = pageWidth - 50;
    const bd = redemption.bankDetails || {};
    const pay = redemption.payment || {};

    doc.rect(0, 0, pageWidth, 110).fill(ink);
    doc.circle(left + 22, 55, 22).fill(gold);
    doc.fillColor(ink).font("Times-Bold").fontSize(24).text("A", left + 14, 42);
    doc.fillColor("#faf6ec").font("Times-Bold").fontSize(22).text("Aparanji", left + 58, 36);
    doc.fillColor(gold).font("Helvetica").fontSize(9)
      .text("YOUR GOLD COIN PARTNER", left + 58, 64, { characterSpacing: 1 });
    doc.fillColor("#faf6ec").font("Helvetica-Bold").fontSize(15)
      .text("PAYMENT ACKNOWLEDGEMENT", left, 48, { align: "right", width: right - left });

    let y = 140;
    doc.fillColor(muted).font("Helvetica").fontSize(10);
    doc.text(`Reference: ${redemption.id}`, left, y);
    doc.text(`Acknowledgement date: ${new Date(pay.paidOn || Date.now()).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
      left, y, { align: "right", width: right - left });

    y += 26;
    doc.fillColor(green).font("Helvetica-Bold").fontSize(13)
      .text(`Payment of ${rs(redemption.grossValue)} made successfully.`, left, y);

    y += 26;
    doc.fillColor(goldDark).font("Helvetica-Bold").fontSize(11).text("PAID TO", left, y);
    y += 18;
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(customer.name, left, y);
    y += 16;
    doc.fillColor(muted).font("Helvetica").fontSize(10)
      .text(`Account: ${customer.accountId}   ·   Mobile: ${customer.mobile}   ·   Email: ${customer.email}`, left, y);

    y += 30;
    const rows = [
      ["Gold redeemed", redemption.grams.toFixed(4) + " g"],
      ["Rate on redemption (24K 999)", rs(redemption.ratePerGram) + " / gram"],
      ["Amount transferred", rs(redemption.grossValue)],
      ["Beneficiary bank", `${bd.bankName || "-"} (A/c ${bd.accountNumber || "-"}, IFSC ${bd.ifsc || "-"})`],
      ["Payment method", pay.method || "Bank transfer (NEFT/IMPS)"],
      ["Bank reference / UTR", pay.reference || "-"],
      ["Paid on", new Date(pay.paidOn || Date.now()).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })],
    ];
    const rowH = 26;
    rows.forEach(([label, value], i) => {
      const rowY = y + i * rowH;
      if (i % 2 === 0) doc.rect(left, rowY, right - left, rowH).fill("#faf6ec");
      const bold = label === "Amount transferred";
      doc.fillColor(bold ? ink : muted).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10.5)
        .text(label, left + 12, rowY + 7);
      doc.fillColor(bold ? goldDark : ink).font("Helvetica-Bold").fontSize(10.5)
        .text(value, left, rowY + 7, { align: "right", width: right - left - 12 });
    });
    y += rows.length * rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(gold).stroke();

    y += 18;
    if (pay.note) {
      doc.fillColor(ink).font("Helvetica").fontSize(10).text(`Note: ${pay.note}`, left, y, { width: right - left });
      y = doc.y + 8;
    }
    doc.fillColor(muted).font("Helvetica").fontSize(9).text(
      "This acknowledges that the above withdrawal has been settled to your bank account. " +
      "If the amount is not reflected in your account within 2 working days of the paid-on date, please contact us with this reference.",
      left, y, { width: right - left }
    );

    doc.fillColor(muted).font("Helvetica-Oblique").fontSize(8.5).text(
      "This is a computer-generated acknowledgement and does not require a signature.",
      left, doc.page.height - 70, { align: "center", width: right - left }
    );

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// ── Public endpoints ─────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/config", (req, res) => res.json(loadConfig()));

// Live 24K rate — clients poll this every second; served from the server cache.
app.get("/api/rate", async (req, res) => {
  const { ratePerGram, source, asOf } = await getRate();
  res.json({ ratePerGram24K: ratePerGram, source, asOf });
});

// UPI deep link for a payment (opens GPay/PhonePe/Paytm etc. on mobile).
function buildUpiLink(amount, note) {
  const { payment } = loadConfig();
  const params = new URLSearchParams({
    pa: payment.vpa,
    pn: payment.accountName,
    am: String(amount),
    cu: "INR",
    tn: note,
  });
  return "upi://pay?" + params.toString();
}

// QR code (PNG) for a UPI payment — scan from any UPI app on desktop.
app.get("/api/payment-qr", async (req, res) => {
  const amount = Number(req.query.amount);
  const note = String(req.query.note || "Aparanji gold purchase").slice(0, 60);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  try {
    const png = await QRCode.toBuffer(buildUpiLink(Math.round(amount), note), {
      type: "png", width: 280, margin: 2,
    });
    res.set("Content-Type", "image/png").set("Cache-Control", "no-store").send(png);
  } catch (e) {
    console.error("QR generation failed:", e.message);
    res.status(500).json({ error: "Could not generate the payment QR" });
  }
});

// Rate history for the price graph (seed points + daily live appends).
app.get("/api/rate-history", async (req, res) => {
  let points = [];
  try {
    points = JSON.parse(fs.readFileSync(RATE_HISTORY_PATH, "utf8")).points;
  } catch (e) {
    /* serve just today's rate below */
  }
  const { ratePerGram } = await getRate();
  const today = new Date().toISOString().slice(0, 10);
  const last = points[points.length - 1];
  if (!last || last.date !== today) points = [...points, { date: today, ratePerGram }];
  res.json({ points });
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
      message: `Account created! Your account ID is ${accountId}. Log in any time with an OTP sent to your registered mobile or email. Our team will verify your KYC within 24 hours.`,
    });
  });
});

// ── OTP login ────────────────────────────────────────────────────────────────
// Every customer logs in with a one-time code sent to their registered mobile
// or email. OTPs are 6 digits, HMAC-hashed in memory, valid 5 minutes, with
// send and attempt rate limits.
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_SENDS = 3;
const OTP_SEND_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const otpStore = new Map(); // accountId -> { hash, expiresAt, attempts, sends: [ts], channel, destination }

function findCustomerByIdentifier(identifier) {
  const raw = String(identifier || "").trim();
  const customers = loadCustomers();
  if (raw.includes("@")) {
    const email = raw.toLowerCase();
    return customers.find((c) => c.email.toLowerCase() === email) || null;
  }
  const mobile = normalizeMobile(raw);
  if (!mobile) return null;
  return customers.find((c) => c.mobile === mobile) || null;
}

const hashOtp = (otp, accountId) =>
  crypto.createHmac("sha256", SESSION_SECRET).update(`${accountId}:${otp}`).digest("hex");

const maskMobile = (m) => "XXXXXX" + m.slice(-4);
const maskEmail = (e) => {
  const [user, domain] = e.split("@");
  return user[0] + "***" + user.slice(-1) + "@" + domain;
};

// Delivery: uses SMTP for email / an SMS gateway webhook when configured via
// environment variables; otherwise logs to the server console so the team can
// relay codes manually. With OTP_DEBUG=1 the code is echoed to the client —
// for local testing only, never set in production.
async function deliverOtp(channel, destination, otp) {
  const message = `${otp} is your Aparanji login OTP. Valid for 5 minutes. Do not share it with anyone.`;
  if (channel === "email" && process.env.SMTP_HOST) {
    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "1",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: destination,
      subject: "Your Aparanji login OTP",
      text: message,
    });
    return;
  }
  if (channel === "mobile" && process.env.SMS_GATEWAY_URL) {
    const res = await fetch(process.env.SMS_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (process.env.SMS_API_KEY || ""),
      },
      body: JSON.stringify({ to: "+91" + destination, message }),
    });
    if (!res.ok) throw new Error(`SMS gateway HTTP ${res.status}`);
    return;
  }
  console.log(`[OTP] ${channel} → ${destination}: ${otp} (no ${channel} provider configured — relay manually)`);
}

app.post("/api/otp/request", async (req, res) => {
  const identifier = String(req.body?.identifier || "").trim();
  const customer = findCustomerByIdentifier(identifier);
  if (!customer) {
    return res.status(404).json({ error: "No account found for that mobile number or email" });
  }

  const now = Date.now();
  const entry = otpStore.get(customer.accountId) || { sends: [] };
  entry.sends = entry.sends.filter((t) => now - t < OTP_SEND_WINDOW_MS);
  if (entry.sends.length >= OTP_MAX_SENDS) {
    return res.status(429).json({ error: "Too many OTP requests — please try again in a few minutes" });
  }

  const channel = identifier.includes("@") ? "email" : "mobile";
  const destination = channel === "email" ? customer.email : customer.mobile;
  const otp = String(crypto.randomInt(100000, 1000000));

  entry.hash = hashOtp(otp, customer.accountId);
  entry.expiresAt = now + OTP_TTL_MS;
  entry.attempts = 0;
  entry.channel = channel;
  entry.destination = destination;
  entry.sends.push(now);
  otpStore.set(customer.accountId, entry);

  try {
    await deliverOtp(channel, destination, otp);
  } catch (e) {
    console.error("OTP delivery failed:", e.message);
    otpStore.delete(customer.accountId);
    return res.status(500).json({ error: "Could not send the OTP — please try again" });
  }

  const masked = channel === "email" ? maskEmail(destination) : maskMobile(destination);
  const payload = { message: `OTP sent to ${masked}`, channel, destination: masked };
  if (process.env.OTP_DEBUG === "1") payload.demoOtp = otp;
  res.json(payload);
});

app.post("/api/otp/verify", (req, res) => {
  const identifier = String(req.body?.identifier || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const customer = findCustomerByIdentifier(identifier);
  if (!customer) return res.status(404).json({ error: "No account found for that mobile number or email" });

  const entry = otpStore.get(customer.accountId);
  if (!entry || !entry.hash) return res.status(400).json({ error: "Request an OTP first" });
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(customer.accountId);
    return res.status(400).json({ error: "This OTP has expired — request a new one" });
  }
  entry.attempts += 1;
  if (entry.attempts > OTP_MAX_ATTEMPTS) {
    otpStore.delete(customer.accountId);
    return res.status(429).json({ error: "Too many wrong attempts — request a new OTP" });
  }
  if (!/^\d{6}$/.test(otp) ||
      !crypto.timingSafeEqual(Buffer.from(hashOtp(otp, customer.accountId)), Buffer.from(entry.hash))) {
    return res.status(401).json({ error: "Incorrect OTP — please check and try again" });
  }

  otpStore.delete(customer.accountId);
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
  const purchase = {
    id: "PUR-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    date: new Date().toISOString(),
    amount,
    gst,
    totalPaid: amount + gst,
    ratePerGram: rate,
    grams: Number((amount / rate).toFixed(4)),
    status: "pending",          // "pending" until admin confirms payment, then "confirmed"
    paymentRef: null,
    paymentConfirmedAt: null,
  };
  customer.purchases.push(purchase);
  saveCustomers(customers);

  // No receipt is generated here — the receipt PDF is created only once payment
  // is received and confirmed (with remarks/reference) by an administrator.
  const totalPayable = amount + gst;
  res.json({
    message: `Purchase recorded — total payable ₹${totalPayable.toLocaleString("en-IN")} (incl. ${config.gstPercent}% GST). Pay via UPI or bank transfer using reference ${purchase.id}. Once we receive and confirm your payment, your gold is credited and your receipt becomes available to download.`,
    purchaseId: purchase.id,
    payment: {
      amount: totalPayable,
      upiLink: buildUpiLink(totalPayable, `Aparanji ${purchase.id}`),
      qrUrl: `/api/payment-qr?amount=${totalPayable}&note=${encodeURIComponent("Aparanji " + purchase.id)}`,
    },
    account: await accountView(customer),
  });
});

// ── Download a deposit receipt voucher ───────────────────────────────────────
app.get("/api/receipts/:purchaseId", requireAuth, async (req, res) => {
  const purchaseId = String(req.params.purchaseId || "");
  if (!/^PUR-[A-F0-9]+$/.test(purchaseId)) return res.status(400).json({ error: "Invalid receipt ID" });

  // The receipt must belong to this customer — active purchases or redeemed ones.
  const customer = req.customer;
  const all = [
    ...customer.purchases,
    ...(customer.redemptions || []).flatMap((r) => r.purchases || []),
  ];
  const index = all.findIndex((p) => p.id === purchaseId);
  if (index === -1) return res.status(404).json({ error: "Receipt not found" });
  if ((all[index].status || "confirmed") !== "confirmed") {
    return res.status(409).json({ error: "Receipt is available only after your payment is confirmed" });
  }

  const filePath = path.join(RECEIPTS_DIR, `${purchaseId}.pdf`);
  if (!fs.existsSync(filePath)) {
    try {
      await generateReceiptPdf(customer, all[index], totalsUpTo(all, index), loadConfig());
    } catch (e) {
      console.error("Receipt regeneration failed:", e.message);
      return res.status(500).json({ error: "Could not generate the receipt — please try again" });
    }
  }
  res.download(filePath, `Aparanji_Receipt_${purchaseId}.pdf`);
});

// ── Daily / monthly savings plan ─────────────────────────────────────────────
app.post("/api/saving-plan", requireAuth, async (req, res) => {
  const { frequency, amount, active } = req.body || {};
  if (frequency !== "daily" && frequency !== "monthly") {
    return res.status(400).json({ error: "Choose a daily or monthly plan" });
  }
  const min = frequency === "daily" ? 10 : 500;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < min) {
    return res.status(400).json({ error: `Minimum ${frequency} saving is ₹${min}` });
  }

  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === req.customer.accountId);
  customer.savingPlan = {
    frequency,
    amount: Math.round(amt),
    active: Boolean(active),
    updatedAt: new Date().toISOString(),
  };
  saveCustomers(customers);

  res.json({
    message: customer.savingPlan.active
      ? `Savings plan active — ₹${customer.savingPlan.amount.toLocaleString("en-IN")} ${frequency}. Our team will contact you to set up the UPI Autopay mandate.`
      : "Savings plan paused. Resume any time.",
    account: await accountView(customer),
  });
});

// ── Scheme closure: withdraw cash or take gold coins after the lock-in ───────
app.post("/api/redeem", requireAuth, async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "cash" && mode !== "coins") {
    return res.status(400).json({ error: "Choose how to redeem: cash or coins" });
  }

  // Bank-transfer withdrawals require the customer's payout account details;
  // gold-coin redemptions require a shipping address.
  let bankDetails = null;
  let shipping = null;
  if (mode === "cash") {
    const check = validateBankDetails(req.body?.bankDetails);
    if (!check.ok) return res.status(400).json({ error: check.error });
    bankDetails = check.bankDetails;
  } else {
    const check = validateShippingAddress(req.body?.shippingAddress);
    if (!check.ok) return res.status(400).json({ error: check.error });
    shipping = check.shipping;
  }

  const config = loadConfig();
  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === req.customer.accountId);
  const confirmed = confirmedPurchases(customer);

  if (!confirmed.length) {
    return res.status(400).json({ error: "You have no confirmed holdings to redeem" });
  }

  // Lock-in: the scheme term must be complete before any withdrawal.
  const redeemableFrom = new Date(addMonths(confirmed[0].date, config.lockInMonths));
  if (Date.now() < redeemableFrom.getTime()) {
    const from = redeemableFrom.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const monthsLeft = Math.max(1, Math.ceil((redeemableFrom.getTime() - Date.now()) / (30.44 * 24 * 3600 * 1000)));
    return res.status(403).json({
      error: `Withdrawal is not allowed yet. This is a ${config.lockInMonths}-month scheme — please pay the remaining ${monthsLeft} month${monthsLeft === 1 ? "" : "s"} of installments and withdraw on or after ${from}.`,
      monthsRemaining: monthsLeft,
      redeemableFrom: redeemableFrom.toISOString(),
    });
  }

  const { ratePerGram: rate } = await getRate();
  const grams = Number(confirmed.reduce((s, p) => s + p.grams, 0).toFixed(4));
  const grossValue = Math.round(grams * rate);
  const makingCharge = mode === "coins" ? Math.round((grossValue * config.makingChargePercent) / 100) : 0;
  const netPayout = mode === "cash" ? grossValue : 0;
  const confirmedIds = new Set(confirmed.map((p) => p.id));

  const redemption = {
    id: "RED-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    date: new Date().toISOString(),
    mode,
    grams,
    ratePerGram: rate,
    grossValue,
    makingCharge,
    netPayout,
    bankDetails, // null for coin redemptions
    payment: null, // filled by admin when the withdrawal is paid
    shipment: shipping
      ? { ...shipping, courier: null, trackingNumber: null, dispatchedOn: null }
      : null,
    status: "processing",
    purchases: confirmed,
  };
  customer.redemptions = customer.redemptions || [];
  customer.redemptions.push(redemption);
  // Only the confirmed holdings are redeemed; any pending (unpaid) deposits stay.
  customer.purchases = customer.purchases.filter((p) => !confirmedIds.has(p.id));
  saveCustomers(customers);

  // Generate the invoice; a PDF hiccup must not fail the redemption itself.
  try {
    await generateInvoicePdf(customer, redemption, config);
  } catch (e) {
    console.error("Invoice generation failed:", e.message);
  }

  const acknowledgement =
    mode === "cash"
      ? {
          type: "withdrawal",
          referenceId: redemption.id,
          amount: grossValue,
          grams,
          bank: `${bankDetails.bankName} · A/c ${maskAccount(bankDetails.accountNumber)} · ${bankDetails.ifsc}`,
          expectedBy: "within 2 working days",
        }
      : {
          type: "coins",
          referenceId: redemption.id,
          grams,
          makingCharge,
          shipTo: `${shipping.name}, ${shipping.city} - ${shipping.pincode}`,
          expectedBy: "dispatched within 5–7 working days",
        };

  const message =
    mode === "cash"
      ? `Withdrawal request received. Reference ${redemption.id} — ₹${grossValue.toLocaleString("en-IN")} for ${grams} g will be transferred to ${bankDetails.bankName} A/c ${maskAccount(bankDetails.accountNumber)} within 2 working days. You will receive a payment acknowledgement once the transfer is made.`
      : `Gold coin request received. Reference ${redemption.id} — ${grams} g of 24K coins (making charge ₹${makingCharge.toLocaleString("en-IN")} at ${config.makingChargePercent}%) will be shipped to ${shipping.city} - ${shipping.pincode}. Track the shipment status on this page.`;

  res.json({ message, invoiceId: redemption.id, acknowledgement, account: await accountView(customer) });
});

// ── Download a redemption invoice ────────────────────────────────────────────
app.get("/api/invoices/:redemptionId", requireAuth, async (req, res) => {
  const redemptionId = String(req.params.redemptionId || "");
  if (!/^RED-[A-F0-9]+$/.test(redemptionId)) return res.status(400).json({ error: "Invalid invoice ID" });

  const redemption = (req.customer.redemptions || []).find((r) => r.id === redemptionId);
  if (!redemption) return res.status(404).json({ error: "Invoice not found" });

  const filePath = path.join(INVOICES_DIR, `${redemptionId}.pdf`);
  if (!fs.existsSync(filePath)) {
    try {
      await generateInvoicePdf(req.customer, redemption, loadConfig());
    } catch (e) {
      console.error("Invoice regeneration failed:", e.message);
      return res.status(500).json({ error: "Could not generate the invoice — please try again" });
    }
  }
  res.download(filePath, `Aparanji_Invoice_${redemptionId}.pdf`);
});

// ── Download a withdrawal payment acknowledgement (customer) ─────────────────
app.get("/api/acks/:redemptionId", requireAuth, (req, res) => {
  const id = String(req.params.redemptionId || "");
  if (!/^RED-[A-F0-9]+$/.test(id)) return res.status(400).json({ error: "Invalid reference" });
  const redemption = (req.customer.redemptions || []).find((r) => r.id === id);
  if (!redemption) return res.status(404).json({ error: "Not found" });
  if (redemption.status !== "paid") {
    return res.status(409).json({ error: "The payment acknowledgement is available once your withdrawal is paid" });
  }
  const filePath = path.join(ACKS_DIR, `${id}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Acknowledgement not found" });
  res.download(filePath, `Aparanji_Payment_Acknowledgement_${id}.pdf`);
});

// ── Admin ────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Not authorized" });
  }
  next();
}

// Admin console data: pending payments, withdrawal requests, coin shipments,
// and the customer master — assembled from all customers.
app.get("/api/admin/data", requireAdmin, (req, res) => {
  const customers = loadCustomers();
  const pendingPayments = [];
  const withdrawals = [];
  const shipments = [];
  const master = [];

  for (const c of customers) {
    const grams = confirmedPurchases(c).reduce((s, p) => s + p.grams, 0);
    master.push({
      accountId: c.accountId, name: c.name, mobile: c.mobile, email: c.email,
      pan: maskPan(c.pan), aadhaar: maskAadhaar(c.aadhaar),
      kyc: c.kycVerified ? "Verified" : "Under verification",
      createdAt: c.createdAt,
      confirmedGrams: Number(grams.toFixed(4)),
      pending: c.purchases.filter((p) => (p.status || "confirmed") === "pending").length,
    });
    for (const p of c.purchases) {
      if ((p.status || "confirmed") === "pending") {
        pendingPayments.push({
          accountId: c.accountId, name: c.name, mobile: c.mobile,
          purchaseId: p.id, date: p.date, amount: p.amount, gst: p.gst, totalPaid: p.totalPaid,
          ratePerGram: p.ratePerGram, grams: p.grams,
        });
      }
    }
    for (const r of c.redemptions || []) {
      if (r.mode === "cash") {
        withdrawals.push({
          accountId: c.accountId, name: c.name, mobile: c.mobile, email: c.email,
          redemptionId: r.id, date: r.date, grams: r.grams, amount: r.grossValue,
          status: r.status, // processing | paid
          bank: r.bankDetails
            ? { accountHolder: r.bankDetails.accountHolder, bankName: r.bankDetails.bankName, accountNumber: r.bankDetails.accountNumber, ifsc: r.bankDetails.ifsc }
            : null,
          payment: r.payment || null,
        });
      } else {
        shipments.push({
          accountId: c.accountId, name: c.name, mobile: c.mobile,
          redemptionId: r.id, date: r.date, grams: r.grams, makingCharge: r.makingCharge,
          status: r.status, // processing | dispatched
          shipTo: r.shipment || null,
        });
      }
    }
  }

  const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);
  res.json({
    pendingPayments: pendingPayments.sort(byDateDesc),
    withdrawals: withdrawals.sort(byDateDesc),
    shipments: shipments.sort(byDateDesc),
    master: master.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  });
});

// Confirm a customer's payment for a pending purchase → credit gold, make receipt.
app.post("/api/admin/confirm-payment", requireAdmin, async (req, res) => {
  const { accountId, purchaseId, reference } = req.body || {};
  if (!reference || !String(reference).trim()) {
    return res.status(400).json({ error: "Enter the payment reference / remarks" });
  }
  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === accountId);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  const purchase = customer.purchases.find((p) => p.id === purchaseId);
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  if ((purchase.status || "confirmed") === "confirmed") {
    return res.status(409).json({ error: "This purchase is already confirmed" });
  }
  purchase.status = "confirmed";
  purchase.paymentRef = String(reference).trim();
  purchase.paymentConfirmedAt = new Date().toISOString();
  saveCustomers(customers);

  // Now that payment is confirmed, generate the receipt.
  try {
    const index = customer.purchases.findIndex((p) => p.id === purchaseId);
    await generateReceiptPdf(customer, purchase, totalsUpTo(customer.purchases, index), loadConfig());
  } catch (e) {
    console.error("Receipt generation failed:", e.message);
  }
  res.json({ message: `Payment confirmed for ${purchaseId}. Gold credited and receipt generated.` });
});

// Record that a withdrawal was paid → store payment details, make acknowledgement.
app.post("/api/admin/pay-withdrawal", requireAdmin, async (req, res) => {
  const { accountId, redemptionId, reference, method, paidOn, note } = req.body || {};
  if (!reference || !String(reference).trim()) {
    return res.status(400).json({ error: "Enter the bank reference / UTR number" });
  }
  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === accountId);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  const redemption = (customer.redemptions || []).find((r) => r.id === redemptionId && r.mode === "cash");
  if (!redemption) return res.status(404).json({ error: "Withdrawal request not found" });
  if (redemption.status === "paid") return res.status(409).json({ error: "This withdrawal is already marked paid" });

  redemption.status = "paid";
  redemption.payment = {
    reference: String(reference).trim(),
    method: (method && String(method).trim()) || "Bank transfer (NEFT/IMPS)",
    paidOn: paidOn ? new Date(paidOn).toISOString() : new Date().toISOString(),
    note: note ? String(note).trim() : null,
    recordedAt: new Date().toISOString(),
  };
  saveCustomers(customers);

  try {
    await generatePaymentAckPdf(customer, redemption);
  } catch (e) {
    console.error("Acknowledgement generation failed:", e.message);
  }
  res.json({ message: `Withdrawal ${redemptionId} marked paid and acknowledgement generated.` });
});

// Record dispatch of gold coins → courier + tracking.
app.post("/api/admin/dispatch-coins", requireAdmin, (req, res) => {
  const { accountId, redemptionId, courier, trackingNumber } = req.body || {};
  if (!courier || !String(courier).trim()) return res.status(400).json({ error: "Enter the courier / logistics partner" });
  if (!trackingNumber || !String(trackingNumber).trim()) return res.status(400).json({ error: "Enter the tracking number" });
  const customers = loadCustomers();
  const customer = customers.find((c) => c.accountId === accountId);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  const redemption = (customer.redemptions || []).find((r) => r.id === redemptionId && r.mode === "coins");
  if (!redemption) return res.status(404).json({ error: "Coin redemption not found" });
  if (!redemption.shipment) return res.status(400).json({ error: "No shipping address on this request" });

  redemption.status = "dispatched";
  redemption.shipment.courier = String(courier).trim();
  redemption.shipment.trackingNumber = String(trackingNumber).trim();
  redemption.shipment.dispatchedOn = new Date().toISOString();
  saveCustomers(customers);
  res.json({ message: `Coins for ${redemptionId} marked dispatched (${courier}, ${trackingNumber}).` });
});

// Admin PDF downloads (receipt / invoice / acknowledgement) by id.
app.get("/api/admin/pdf/:kind/:id", requireAdmin, (req, res) => {
  const { kind, id } = req.params;
  const map = { receipt: [RECEIPTS_DIR, "PUR"], invoice: [INVOICES_DIR, "RED"], ack: [ACKS_DIR, "RED"] };
  const entry = map[kind];
  if (!entry || !new RegExp(`^${entry[1]}-[A-F0-9]+$`).test(id)) return res.status(400).json({ error: "Bad request" });
  const filePath = path.join(entry[0], `${id}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Document not found" });
  res.download(filePath, `Aparanji_${kind}_${id}.pdf`);
});

// Full customer list (raw) — kept for export/backup.
app.get("/api/customers", requireAdmin, (req, res) => {
  res.json(loadCustomers());
});

app.listen(PORT, () => console.log(`Aparanji Digital Gold website running on port ${PORT}`));
