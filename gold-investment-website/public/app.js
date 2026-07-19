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

  function renderRate(config) {
    document.getElementById("rate24k").textContent = `24K: ${money(config.goldRatePerGram24K)}/g`;
    document.getElementById("rateDate").textContent = `As of ${config.updatedOn}`;
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
    box.appendChild(el("h4", null, "At today's rate"));
    const dl = document.createElement("dl");

    function row(label, value, isHighlight) {
      dl.appendChild(el("dt", null, label));
      dl.appendChild(el("dd", isHighlight ? "highlight" : null, value));
    }

    row("Rate (24K)", `${money(data.ratePerGram)}/g`);
    row("Amount", money(data.amount));
    row("Gold", `${data.grams} g`, true);

    box.appendChild(dl);
    box.hidden = false;
  }

  function showInvestError(msg) {
    const err = document.getElementById("investError");
    err.textContent = msg;
    err.hidden = false;
    document.getElementById("investSuccess").hidden = true;
  }

  async function submitInvestment(e) {
    e.preventDefault();
    document.getElementById("investError").hidden = true;
    document.getElementById("investSuccess").hidden = true;

    const payload = {
      name: document.getElementById("investName").value,
      phone: document.getElementById("investPhone").value,
      email: document.getElementById("investEmail").value,
      amount: document.getElementById("investAmount").value || null,
    };

    try {
      const res = await fetch("/api/invest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showInvestError(data.error || "Could not submit");

      const success = document.getElementById("investSuccess");
      success.textContent = `${data.message} Your reference ID: ${data.referenceId}`;
      success.hidden = false;
      document.getElementById("investForm").reset();
    } catch (err) {
      showInvestError("Something went wrong. Please try again.");
    }
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

    renderRate(config);
    renderFeatures(config.features);
    renderSteps(config.steps);
    document.getElementById("calcAmount").placeholder = `Min ₹${config.minPurchaseAmount}`;

    document.getElementById("calcSubmit").addEventListener("click", runCalculation);
    document.getElementById("investForm").addEventListener("submit", submitInvestment);
  }

  init();
})();
