(function () {
  "use strict";

  const money = (n) =>
    "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  document.getElementById("year").textContent = new Date().getFullYear();

  // Mobile nav toggle
  const nav = document.getElementById("nav");
  document.getElementById("navToggle").addEventListener("click", () => {
    nav.classList.toggle("open");
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let liveRate = null;
  let gstPercent = 3;

  // ── Live rate ticker (polls every second) ──────────────────────────────────
  async function pollRate() {
    try {
      const res = await fetch("/api/rate");
      const data = await res.json();
      if (!res.ok) return;
      liveRate = data.ratePerGram24K;
      updateRateCalc();
      updateDailyProjection();
      updateRatesTable();
      document.getElementById("rate24k").textContent = `24K: ${money(data.ratePerGram24K)}/g`;
      document.getElementById("rateDate").textContent =
        data.source === "jab"
          ? `JAB Bengaluru · live · ${new Date(data.asOf).toLocaleTimeString("en-IN")}`
          : `JAB Bengaluru · as of ${data.asOf}`;
    } catch (e) {
      /* keep last shown rate */
    }
  }
  pollRate();
  setInterval(pollRate, 1000);

  // ── Gold rate calculator (why-gold tab): purity × grams at the live rate ───
  function updateRateCalc() {
    const result = document.getElementById("rcResult");
    if (!result || !liveRate) return;
    const factor = Number(document.getElementById("rcPurity").value);
    const grams = Number(document.getElementById("rcGrams").value);
    result.innerHTML = "";
    if (!Number.isFinite(grams) || grams <= 0) return;
    const perGram = liveRate * factor;
    const value = grams * perGram;
    const gst = value * gstPercent / 100;
    const row = (l, v, hi) => {
      result.appendChild(el("dt", null, l));
      result.appendChild(el("dd", hi ? "highlight" : null, v));
    };
    row("Rate for this purity", money(perGram) + "/g");
    row("Gold value", money(value));
    row(`GST (${gstPercent}%)`, money(gst));
    row("Total", money(value + gst), true);
  }

  // ── Today's gold rates table (24K/22K/18K × 1g/8g/10g) ─────────────────────
  function updateRatesTable() {
    const tbody = document.querySelector("#ratesTable tbody");
    if (!tbody || !liveRate) return;
    tbody.innerHTML = "";
    [["24K (999)", 1], ["22K (916)", 0.916], ["18K (750)", 0.75]].forEach(([label, factor]) => {
      const perGram = liveRate * factor;
      const tr = document.createElement("tr");
      [label, money(perGram), money(perGram * 8), money(perGram * 10)].forEach((v, i) => {
        const td = el("td", i > 0 ? "num" : null, v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  // ── Daily / monthly saving projection ──────────────────────────────────────
  let savingFreq = "daily";

  function setSavingFreq(freq) {
    savingFreq = freq;
    const slider = document.getElementById("dailyAmount");
    document.getElementById("freqDaily").classList.toggle("active", freq === "daily");
    document.getElementById("freqMonthly").classList.toggle("active", freq === "monthly");
    document.getElementById("dailyAmountCaption").textContent =
      freq === "daily" ? "Daily saving" : "Monthly saving";
    if (freq === "daily") {
      slider.min = 10; slider.max = 1000; slider.step = 10; slider.value = 100;
    } else {
      slider.min = 500; slider.max = 50000; slider.step = 500; slider.value = 5000;
    }
    updateDailyProjection();
  }

  function updateDailyProjection() {
    const slider = document.getElementById("dailyAmount");
    if (!slider || !liveRate) return;
    const amount = Number(slider.value);
    const perDay = savingFreq === "daily";
    document.getElementById("dailyAmountLabel").textContent =
      money(amount) + (perDay ? " / day" : " / month");
    const monthly = perDay ? amount * 30 : amount;
    const yearly = perDay ? amount * 365 : amount * 12;
    document.getElementById("dailyMonthly").textContent = money(monthly);
    document.getElementById("dailyYearly").textContent = money(yearly);
    document.getElementById("dailyGrams").textContent = (yearly / liveRate).toFixed(2) + " g";
  }

  function renderWhyGold(cards) {
    const container = document.getElementById("whyGoldCards");
    container.innerHTML = "";
    (cards || []).forEach((c) => {
      const card = el("div", "scheme-card");
      card.appendChild(el("h3", null, c.title));
      card.appendChild(el("p", "desc", c.description));
      container.appendChild(card);
    });
  }

  function renderAbout(company, payment) {
    if (!company) return;
    document.getElementById("aboutTitle").textContent = "About " + company.legalName;
    document.getElementById("aboutIntro").textContent = company.intro || "";
    document.getElementById("aboutWhat").textContent = company.what || "";
    document.getElementById("aboutCommit").textContent = company.commitment || "";

    // Facts list — only rows that are filled in are shown.
    const facts = document.getElementById("aboutFacts");
    facts.innerHTML = "";
    const rows = [
      ["Legal name", company.legalName],
      ["Brand", company.brand && company.tagline ? `${company.brand} — ${company.tagline}` : company.brand],
      ["Based in", company.cityState],
      ["Registered office", company.registeredOffice],
      ["CIN", company.cin],
      ["GSTIN", company.gstin],
      ["Bankers", payment && payment.bankName ? `${payment.bankName}, ${payment.branch}` : ""],
      ["Email", company.contactEmail],
      ["Phone", company.contactPhone],
      ["Grievance officer", company.grievanceOfficer],
    ];
    rows.forEach(([label, value]) => {
      if (!value) return;
      facts.appendChild(el("dt", null, label));
      facts.appendChild(el("dd", null, value));
    });

    const values = document.getElementById("aboutValues");
    values.innerHTML = "";
    (company.values || []).forEach((v) => {
      const card = el("div", "scheme-card");
      card.appendChild(el("h3", null, v.title));
      card.appendChild(el("p", "desc", v.description));
      values.appendChild(card);
    });
  }

  async function loadPriceChart() {
    try {
      const res = await fetch("/api/rate-history");
      const data = await res.json();
      window.renderPriceChart(document.getElementById("priceChart"), data.points);
      window.renderPriceTable(document.querySelector("#priceTable tbody"), data.points);
    } catch (e) {
      document.getElementById("priceChart").textContent = "Price history unavailable right now.";
    }
  }

  function renderFeatures(features) {
    const container = document.getElementById("featureCards");
    container.innerHTML = "";
    (features || []).forEach((f) => {
      const card = el("div", "scheme-card");
      card.appendChild(el("h3", null, f.title));
      card.appendChild(el("p", "desc", f.description));
      container.appendChild(card);
    });
  }

  function renderSteps(steps) {
    const container = document.getElementById("stepCards");
    container.innerHTML = "";
    (steps || []).forEach((s) => {
      const card = el("div", "step-card");
      card.appendChild(el("span", "step-num", String(s.step)));
      card.appendChild(el("h3", null, s.title));
      card.appendChild(el("p", "desc", s.description));
      container.appendChild(card);
    });
  }

  function showCalcError(msg) {
    const err = document.getElementById("calcError");
    err.textContent = msg;
    err.hidden = false;
    document.getElementById("calcResult").hidden = true;
  }

  async function runCalculation() {
    document.getElementById("calcError").hidden = true;
    const amountVal = document.getElementById("calcAmount").value;
    const gramsVal = document.getElementById("calcGrams").value;

    const payload = {};
    if (amountVal) payload.amount = Number(amountVal);
    else if (gramsVal) payload.grams = Number(gramsVal);
    else return showCalcError("Enter an amount in ₹ or a gram target.");

    try {
      const res = await fetch("/api/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showCalcError(data.error || "Could not calculate");
      renderCalcResult(data);
    } catch (e) {
      showCalcError("Something went wrong. Please try again.");
    }
  }

  function renderCalcResult(data) {
    const box = document.getElementById("calcResult");
    box.innerHTML = "";
    box.appendChild(el("h4", null, "At the current rate"));
    const dl = document.createElement("dl");

    function row(label, value, isHighlight) {
      dl.appendChild(el("dt", null, label));
      dl.appendChild(el("dd", isHighlight ? "highlight" : null, value));
    }

    row("Rate (24K)", `${money(data.ratePerGram)}/g`);
    row("Gold value", money(data.amount));
    row(`GST (${data.gstPercent}%)`, money(data.gst));
    row("Total payable", money(data.totalPayable), true);
    row("Gold credited", `${data.grams} g`, true);

    box.appendChild(dl);
    box.hidden = false;
  }

  // Clear the other calculator field when one is typed into,
  // so it's obvious which input drives the result.
  document.getElementById("calcAmount").addEventListener("input", () => {
    document.getElementById("calcGrams").value = "";
  });
  document.getElementById("calcGrams").addEventListener("input", () => {
    document.getElementById("calcAmount").value = "";
  });

  async function init() {
    let config;
    try {
      const res = await fetch("/api/config");
      config = await res.json();
    } catch (e) {
      document.getElementById("featureCards").innerHTML =
        '<p class="loading">Could not load. Please refresh the page.</p>';
      return;
    }
    gstPercent = config.gstPercent;

    document.getElementById("rcPurity").addEventListener("change", updateRateCalc);
    document.getElementById("rcGrams").addEventListener("input", updateRateCalc);
    document.getElementById("dailyAmount").addEventListener("input", updateDailyProjection);
    document.getElementById("freqDaily").addEventListener("click", () => setSavingFreq("daily"));
    document.getElementById("freqMonthly").addEventListener("click", () => setSavingFreq("monthly"));

    renderWhyGold(config.whyGold);
    renderAbout(config.company, config.payment);
    loadPriceChart();
    renderFeatures(config.features);
    renderSteps(config.steps);
    document.getElementById("calcAmount").placeholder = `Min ₹${config.minPurchaseAmount}`;
    document.getElementById("calcSubmit").addEventListener("click", runCalculation);
  }

  init();
})();
