const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const SCHEMES_PATH = path.join(DATA_DIR, "schemes.json");
const LEADS_PATH = path.join(DATA_DIR, "leads.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function loadSchemes() {
  return JSON.parse(fs.readFileSync(SCHEMES_PATH, "utf8"));
}

function loadLeads() {
  if (!fs.existsSync(LEADS_PATH)) return [];
  return JSON.parse(fs.readFileSync(LEADS_PATH, "utf8"));
}

function saveLead(lead) {
  const leads = loadLeads();
  leads.push(lead);
  fs.writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2));
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/schemes", (req, res) => {
  res.json(loadSchemes());
});

app.post("/api/calculate", (req, res) => {
  const { schemeId, monthlyAmount, tenureMonths, digitalAmount } = req.body || {};
  const { schemes, goldRatePerGram22K, goldRatePerGram24K } = loadSchemes();
  const scheme = schemes.find((s) => s.id === schemeId);

  if (!scheme) return res.status(400).json({ error: "Unknown scheme" });

  if (scheme.type === "digital-gold") {
    const amount = Number(digitalAmount);
    if (!Number.isFinite(amount) || amount < scheme.minAmount) {
      return res.status(400).json({ error: `Minimum amount is ₹${scheme.minAmount}` });
    }
    const grams = amount / goldRatePerGram24K;
    return res.json({
      schemeId,
      amount,
      ratePerGram: goldRatePerGram24K,
      gramsAccumulated: Number(grams.toFixed(4)),
    });
  }

  const monthly = Number(monthlyAmount);
  if (!Number.isFinite(monthly) || monthly < (scheme.minMonthlyAmount || 0)) {
    return res.status(400).json({ error: `Minimum installment is ₹${scheme.minMonthlyAmount}` });
  }

  let tenure = Number(tenureMonths) || scheme.tenureMonths;
  if (scheme.tenureOptions && !scheme.tenureOptions.includes(tenure)) {
    tenure = scheme.tenureOptions[0];
  }

  const totalPaid = monthly * tenure;
  let bonus = 0;

  if (scheme.bonusMonths) {
    bonus = monthly * scheme.bonusMonths;
  } else if (scheme.bonusPercentByTenure) {
    const pct = scheme.bonusPercentByTenure[String(tenure)] || 0;
    bonus = Math.round((totalPaid * pct) / 100);
  }

  const maturityValue = totalPaid + bonus;
  const gramsAtMaturity = maturityValue / goldRatePerGram22K;

  res.json({
    schemeId,
    monthlyAmount: monthly,
    tenureMonths: tenure,
    totalPaid,
    bonus,
    maturityValue,
    ratePerGram: goldRatePerGram22K,
    approxGrams: Number(gramsAtMaturity.toFixed(3)),
  });
});

app.post("/api/enroll", (req, res) => {
  const { name, phone, email, schemeId, monthlyAmount, branch } = req.body || {};

  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
  if (!phone || !/^[0-9+\-\s]{7,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: "Email address looks invalid" });
  }

  const { schemes } = loadSchemes();
  const scheme = schemes.find((s) => s.id === schemeId);
  if (!scheme) return res.status(400).json({ error: "Please select a valid scheme" });

  const referenceId = "RGL-" + crypto.randomBytes(4).toString("hex").toUpperCase();

  saveLead({
    referenceId,
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: email ? String(email).trim() : null,
    schemeId,
    schemeName: scheme.name,
    monthlyAmount: monthlyAmount ? Number(monthlyAmount) : null,
    branch: branch || null,
    submittedAt: new Date().toISOString(),
  });

  res.json({ referenceId, message: "Thank you! Our team will contact you within 24 hours." });
});

// Simple protected view for the business owner to review submitted enquiries.
// Set ADMIN_KEY as an environment variable to enable; disabled by default.
app.get("/api/leads", (req, res) => {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Not authorized" });
  }
  res.json(loadLeads());
});

app.listen(PORT, () => console.log(`Regal Gold Investment website running on port ${PORT}`));
