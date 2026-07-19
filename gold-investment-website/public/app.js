(function () {
  "use strict";

  const money = (n) =>
    "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  let schemesData = null;

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

  function renderRate(data) {
    document.getElementById("rate22k").textContent = `22K: ${money(data.goldRatePerGram22K)}/g`;
    document.getElementById("rate24k").textContent = `24K: ${money(data.goldRatePerGram24K)}/g`;
    document.getElementById("rateDate").textContent = `As of ${data.updatedOn}`;
  }

  function renderSchemeCards(schemes) {
    const container = document.getElementById("schemeCards");
    container.innerHTML = "";
    schemes.forEach((s) => {
      const card = el("div", "scheme-card");
      card.appendChild(el("h3", null, s.name));
      card.appendChild(el("p", "tagline", s.tagline));
      card.appendChild(el("p", "desc", s.description));
      const ul = el("ul");
      (s.highlights || []).forEach((h) => ul.appendChild(el("li", null, h)));
      card.appendChild(ul);
      container.appendChild(card);
    });
  }

  function populateSchemeSelect(select, schemes) {
    select.innerHTML = "";
    schemes.forEach((s) => {
      const opt = el("option", null, s.name);
      opt.value = s.id;
      select.appendChild(opt);
    });
  }

  function populateBranches(schemesPayload) {
    const list = document.getElementById("branchList");
    const branchSelect = document.getElementById("enrollBranch");
    list.innerHTML = "";
    branchSelect.innerHTML = "";
    branchSelect.appendChild(el("option", null, "No preference"));
    (schemesPayload.branches || []).forEach((b) => {
      list.appendChild(el("li", null, b));
      const opt = el("option", null, b);
      branchSelect.appendChild(opt);
    });
  }

  function currentScheme(id) {
    return schemesData.schemes.find((s) => s.id === id);
  }

  function updateCalcFieldsForScheme() {
    const schemeId = document.getElementById("calcScheme").value;
    const scheme = currentScheme(schemeId);
    const installmentFields = document.getElementById("calcInstallmentFields");
    const digitalFields = document.getElementById("calcDigitalFields");
    const tenureField = document.getElementById("calcTenureField");
    const tenureSelect = document.getElementById("calcTenure");

    if (!scheme) return;

    if (scheme.type === "digital-gold") {
      installmentFields.hidden = true;
      digitalFields.hidden = false;
      return;
    }

    installmentFields.hidden = false;
    digitalFields.hidden = true;

    const monthlyInput = document.getElementById("calcMonthly");
    monthlyInput.placeholder = `Min ₹${scheme.minMonthlyAmount}`;

    if (scheme.tenureOptions) {
      tenureField.hidden = false;
      tenureSelect.innerHTML = "";
      scheme.tenureOptions.forEach((t) => {
        const opt = el("option", null, `${t} months`);
        opt.value = t;
        tenureSelect.appendChild(opt);
      });
    } else {
      tenureField.hidden = true;
    }
  }

  function showCalcError(msg) {
    const err = document.getElementById("calcError");
    err.textContent = msg;
    err.hidden = false;
    document.getElementById("calcResult").hidden = true;
  }

  async function runCalculation() {
    const schemeId = document.getElementById("calcScheme").value;
    const scheme = currentScheme(schemeId);
    document.getElementById("calcError").hidden = true;

    const payload = { schemeId };
    if (scheme.type === "digital-gold") {
      payload.digitalAmount = Number(document.getElementById("calcDigitalAmount").value);
    } else {
      payload.monthlyAmount = Number(document.getElementById("calcMonthly").value);
      const tenureSelect = document.getElementById("calcTenure");
      if (!tenureSelect.hidden) payload.tenureMonths = Number(tenureSelect.value);
    }

    try {
      const res = await fetch("/api/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showCalcError(data.error || "Could not calculate");
      renderCalcResult(scheme, data);
    } catch (e) {
      showCalcError("Something went wrong. Please try again.");
    }
  }

  function renderCalcResult(scheme, data) {
    const box = document.getElementById("calcResult");
    box.innerHTML = "";
    box.appendChild(el("h4", null, `${scheme.name} — indicative outcome`));
    const dl = document.createElement("dl");

    function row(label, value, isHighlight) {
      dl.appendChild(el("dt", null, label));
      dl.appendChild(el("dd", isHighlight ? "highlight" : null, value));
    }

    if (data.gramsAccumulated !== undefined) {
      row("Amount invested", money(data.amount));
      row("Rate used (24K)", `${money(data.ratePerGram)}/g`);
      row("Grams accumulated", `${data.gramsAccumulated} g`);
    } else {
      row("Total installments", `${data.tenureMonths} months`);
      row("Total you pay in", money(data.totalPaid));
      row("Scheme bonus", money(data.bonus));
      row("Maturity value", money(data.maturityValue), true);
      row("Approx. gold (22K)", `${data.approxGrams} g`);
    }

    box.appendChild(dl);
    box.hidden = false;
  }

  function showEnrollError(msg) {
    const err = document.getElementById("enrollError");
    err.textContent = msg;
    err.hidden = false;
    document.getElementById("enrollSuccess").hidden = true;
  }

  async function submitEnrollment(e) {
    e.preventDefault();
    document.getElementById("enrollError").hidden = true;
    document.getElementById("enrollSuccess").hidden = true;

    const payload = {
      name: document.getElementById("enrollName").value,
      phone: document.getElementById("enrollPhone").value,
      email: document.getElementById("enrollEmail").value,
      schemeId: document.getElementById("enrollScheme").value,
      monthlyAmount: document.getElementById("enrollMonthly").value || null,
      branch: document.getElementById("enrollBranch").value,
    };

    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showEnrollError(data.error || "Could not submit enquiry");

      const success = document.getElementById("enrollSuccess");
      success.textContent = `${data.message} Your reference ID: ${data.referenceId}`;
      success.hidden = false;
      document.getElementById("enrollForm").reset();
    } catch (err) {
      showEnrollError("Something went wrong. Please try again.");
    }
  }

  async function init() {
    try {
      const res = await fetch("/api/schemes");
      schemesData = await res.json();
    } catch (e) {
      document.getElementById("schemeCards").innerHTML =
        '<p class="loading">Could not load schemes. Please refresh the page.</p>';
      return;
    }

    renderRate(schemesData);
    renderSchemeCards(schemesData.schemes);
    populateSchemeSelect(document.getElementById("calcScheme"), schemesData.schemes);
    populateSchemeSelect(document.getElementById("enrollScheme"), schemesData.schemes);
    populateBranches(schemesData);

    updateCalcFieldsForScheme();
    document.getElementById("calcScheme").addEventListener("change", updateCalcFieldsForScheme);
    document.getElementById("calcSubmit").addEventListener("click", runCalculation);
    document.getElementById("enrollForm").addEventListener("submit", submitEnrollment);
  }

  init();
})();
