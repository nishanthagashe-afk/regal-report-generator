const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEADS_PATH = path.join(DATA_DIR, "leads.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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

app.get("/api/config", (req, res) => {
  res.json(loadConfig());
});

// Convert between rupees and grams at today's rate.
// Accepts either { amount } or { grams }.
app.post("/api/calculate", (req, res) => {
  const { amount, grams } = req.body || {};
  const config = loadConfig();
  const rate = config.goldRatePerGram24K;

  if (amount !== undefined && amount !== null && amount !== "") {
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees < config.minPurchaseAmount) {
      return res.status(400).json({ error: `Minimum purchase is ₹${config.minPurchaseAmount}` });
    }
    return res.json({
      amount: rupees,
      ratePerGram: rate,
      grams: Number((rupees / rate).toFixed(4)),
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
    return res.json({
      grams: g,
      ratePerGram: rate,
      amount: Math.round(rupees),
    });
  }

  res.status(400).json({ error: "Provide an amount in ₹ or grams" });
});

// Investment interest / registration enquiry
app.post("/api/invest", (req, res) => {
  const { name, phone, email, amount } = req.body || {};

  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
  if (!phone || !/^[0-9+\-\s]{7,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: "Email address looks invalid" });
  }

  const config = loadConfig();
  let intendedAmount = null;
  if (amount !== undefined && amount !== null && amount !== "") {
    intendedAmount = Number(amount);
    if (!Number.isFinite(intendedAmount) || intendedAmount < config.minPurchaseAmount) {
      return res.status(400).json({ error: `Minimum investment is ₹${config.minPurchaseAmount}` });
    }
  }

  const referenceId = "APJ-" + crypto.randomBytes(4).toString("hex").toUpperCase();

  saveLead({
    referenceId,
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: email ? String(email).trim() : null,
    intendedAmount,
    submittedAt: new Date().toISOString(),
  });

  res.json({ referenceId, message: "Thank you! Our team will contact you within 24 hours to complete your KYC and activate your account." });
});

// Simple protected view for the business owner to review submitted enquiries.
// Set ADMIN_KEY as an environment variable to enable; disabled by default.
app.get("/api/leads", (req, res) => {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Not authorized" });
  }
  res.json(loadLeads());
});

app.listen(PORT, () => console.log(`Aparanji Digital Gold website running on port ${PORT}`));
