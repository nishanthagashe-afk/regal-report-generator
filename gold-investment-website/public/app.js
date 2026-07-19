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

  // ── Live rate ticker (polls every second) ──────────────────────────────────
  async function pollRate() {
    try {
      const res = await fetch("/api/rate");
      const data = await res.json();
      if (!res.ok) return;
      document.getElementById("rate24k").textContent = `24K: ${money(data.ratePerGram24K)}/g`;
      document.getElementById("rateDate").textContent =
        data.source === "jab"
          ? `JAB Bengaluru · ${new Date(data.asOf).toLocaleTimeString("en-IN")}`
          : data.source === "live"
            ? `LIVE · ${new Date(data.asOf).toLocaleTimeString("en-IN")}`
            : `Indicative · as of ${data.asOf}`;
    } catch (e) {
      /* keep last shown rate */
    }
  }
  pollRate();
  setInterval(pollRate, 1000);

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

    renderFeatures(config.features);
    renderSteps(config.steps);
    document.getElementById("calcAmount").placeholder = `Min ₹${config.minPurchaseAmount}`;
    document.getElementById("calcSubmit").addEventListener("click", runCalculation);
  }

  init();
})();
