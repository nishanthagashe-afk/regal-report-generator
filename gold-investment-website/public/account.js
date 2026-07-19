(function () {
  "use strict";

  const money = (n) =>
    "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  const TOKEN_KEY = "aparanji_token";
  let todayRate = null;
  let gstPercent = 3;
  let currentAccount = null;

  document.getElementById("year").textContent = new Date().getFullYear();

  const nav = document.getElementById("nav");
  document.getElementById("navToggle").addEventListener("click", () => {
    nav.classList.toggle("open");
  });

  const views = {
    login: document.getElementById("loginView"),
    register: document.getElementById("registerView"),
    dashboard: document.getElementById("dashboardView"),
  };

  function show(view) {
    Object.entries(views).forEach(([name, el]) => (el.hidden = name !== view));
  }

  function setError(id, msg) {
    const el = document.getElementById(id);
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  async function api(path, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    options.headers = Object.assign(
      token ? { Authorization: "Bearer " + token } : {},
      options.headers || {}
    );
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  // ── Live rate (polled every second) ────────────────────────────────────────
  async function pollRate() {
    try {
      const res = await fetch("/api/rate");
      const data = await res.json();
      if (!res.ok) return;
      todayRate = data.ratePerGram24K;
      document.getElementById("rate24k").textContent = `24K: ${money(todayRate)}/g`;
      document.getElementById("rateDate").textContent =
        data.source === "live"
          ? `LIVE · ${new Date(data.asOf).toLocaleTimeString("en-IN")}`
          : `Indicative · as of ${data.asOf}`;
      refreshLiveValues();
      updateBuyPreview();
    } catch (e) {
      /* keep last shown rate */
    }
  }
  pollRate();
  setInterval(pollRate, 1000);

  // Recompute the dashboard's current-value figures from the freshest rate.
  function refreshLiveValues() {
    if (!currentAccount || !todayRate || views.dashboard.hidden) return;
    const grams = currentAccount.totals.grams;
    const currentValue = Math.round(grams * todayRate);
    const gain = currentValue - currentAccount.totals.totalPaid;

    document.getElementById("statValue").textContent = money(currentValue);
    document.getElementById("statRateNote").textContent = `at live ${money(todayRate)}/g`;
    const gainEl = document.getElementById("statGain");
    gainEl.textContent = (gain >= 0 ? "+" : "−") + money(Math.abs(gain));
    gainEl.className = "stat-value " + (gain > 0 ? "gain" : gain < 0 ? "loss" : "");
  }

  async function loadConfig() {
    try {
      const config = await api("/api/config");
      gstPercent = config.gstPercent;
      document.getElementById("buyAmount").placeholder = `Min ₹${config.minPurchaseAmount}`;
    } catch (e) {
      /* defaults are fine */
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────
  document.getElementById("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("registerError", null);
    document.getElementById("registerSuccess").hidden = true;

    const form = new FormData();
    form.append("name", document.getElementById("regName").value);
    form.append("mobile", document.getElementById("regMobile").value);
    form.append("email", document.getElementById("regEmail").value);
    form.append("aadhaar", document.getElementById("regAadhaar").value);
    form.append("pan", document.getElementById("regPan").value);
    const aadhaarDoc = document.getElementById("regAadhaarDoc").files[0];
    const panDoc = document.getElementById("regPanDoc").files[0];
    if (aadhaarDoc) form.append("aadhaarDoc", aadhaarDoc);
    if (panDoc) form.append("panDoc", panDoc);

    try {
      const data = await api("/api/register", { method: "POST", body: form });
      const success = document.getElementById("registerSuccess");
      success.textContent = data.message;
      success.hidden = false;
      document.getElementById("registerForm").reset();
      document.getElementById("loginAccountId").value = data.accountId;
      success.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      setError("registerError", err.message);
    }
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("loginError", null);
    try {
      const data = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: document.getElementById("loginAccountId").value,
          mobile: document.getElementById("loginMobile").value,
        }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      await openDashboard();
    } catch (err) {
      setError("loginError", err.message);
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    currentAccount = null;
    show("login");
  });

  document.getElementById("showRegister").addEventListener("click", (e) => {
    e.preventDefault();
    show("register");
  });
  document.getElementById("showLogin").addEventListener("click", (e) => {
    e.preventDefault();
    show("login");
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────
  function renderAccount(acc) {
    currentAccount = acc;
    document.getElementById("dashName").textContent = acc.name;
    document.getElementById("dashAccountId").textContent = acc.accountId;
    const kyc = document.getElementById("dashKyc");
    kyc.textContent = acc.kycStatus;
    kyc.className = "kyc-badge " + (acc.kycStatus === "Verified" ? "kyc-ok" : "kyc-pending");
    document.getElementById("dashContact").textContent =
      `${acc.mobile} · ${acc.email} · Aadhaar ${acc.aadhaar} · PAN ${acc.pan}`;

    document.getElementById("statInvested").textContent = money(acc.totals.totalPaid);
    document.getElementById("statGstNote").textContent =
      `${money(acc.totals.invested)} gold + ${money(acc.totals.gst)} GST`;
    document.getElementById("statGrams").textContent = acc.totals.grams + " g";
    document.getElementById("statValue").textContent = money(acc.totals.currentValue);
    document.getElementById("statRateNote").textContent = `at live ${money(acc.todayRatePerGram)}/g`;

    const gain = acc.totals.gainLoss;
    const gainEl = document.getElementById("statGain");
    gainEl.textContent = (gain >= 0 ? "+" : "−") + money(Math.abs(gain));
    gainEl.className = "stat-value " + (gain > 0 ? "gain" : gain < 0 ? "loss" : "");

    const scheme = acc.scheme;
    const from = scheme.redeemableFrom
      ? new Date(scheme.redeemableFrom).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
      : null;
    document.getElementById("schemeNote").textContent = from
      ? `${scheme.lockInMonths}-month scheme · redeemable from ${from} as gold coins (${scheme.makingChargePercent}% making charge, ≈ ${money(scheme.estimatedMakingCharge)} today) — or withdraw the equivalent value in money instead.`
      : `${scheme.lockInMonths}-month scheme · redemption opens ${scheme.lockInMonths} months after your first purchase — gold coins (${scheme.makingChargePercent}% making charge) or withdraw the equivalent value in money.`;

    // Redeem & withdraw panel
    const redeemStatus = document.getElementById("redeemStatus");
    const redeemActions = document.getElementById("redeemActions");
    if (!acc.purchases.length) {
      redeemStatus.textContent = "No active holdings. Buy gold to start a new scheme cycle.";
      redeemActions.hidden = true;
    } else if (scheme.matured) {
      redeemStatus.textContent = "Your scheme has matured — choose how to redeem:";
      document.getElementById("redeemPreview").textContent =
        `Withdraw ${money(scheme.cashWithdrawalValue)} in cash · or take ${acc.totals.grams} g in gold coins (making charge ≈ ${money(scheme.estimatedMakingCharge)})`;
      redeemActions.hidden = false;
    } else {
      redeemStatus.textContent = from
        ? `Locked until ${from}. After that date you can withdraw the full value in cash or take gold coins.`
        : "Redemption opens 11 months after your first purchase.";
      redeemActions.hidden = true;
    }

    // Redemption history
    const redRows = document.getElementById("redemptionRows");
    redRows.innerHTML = "";
    const redemptions = (acc.redemptions || []).slice().reverse();
    redemptions.forEach((r) => {
      const tr = document.createElement("tr");
      const date = new Date(r.date).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      });
      const value = r.mode === "cash"
        ? money(r.netPayout)
        : `${money(r.grossValue)} − ${money(r.makingCharge)} MC`;
      [date, r.mode === "cash" ? "Cash withdrawal" : "Gold coins", r.grams + " g", money(r.ratePerGram), value, r.status]
        .forEach((v, i) => {
          const td = document.createElement("td");
          td.textContent = v;
          if (i >= 2 && i <= 4) td.className = "num";
          tr.appendChild(td);
        });
      redRows.appendChild(tr);
    });
    document.getElementById("noRedemptions").hidden = redemptions.length > 0;
    document.getElementById("redemptionWrap").hidden = redemptions.length === 0;

    const rows = document.getElementById("purchaseRows");
    rows.innerHTML = "";
    const list = acc.purchases.slice().reverse();
    list.forEach((p) => {
      const tr = document.createElement("tr");
      const date = new Date(p.date).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      });
      [date, money(p.amount), money(p.gst), money(p.totalPaid), money(p.ratePerGram), p.grams + " g"]
        .forEach((v, i) => {
          const td = document.createElement("td");
          td.textContent = v;
          if (i > 0) td.className = "num";
          tr.appendChild(td);
        });
      const receiptTd = document.createElement("td");
      receiptTd.className = "num";
      const link = document.createElement("a");
      link.href = "#";
      link.className = "receipt-link";
      link.textContent = "PDF";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        downloadReceipt(p.id);
      });
      receiptTd.appendChild(link);
      tr.appendChild(receiptTd);
      rows.appendChild(tr);
    });
    document.getElementById("noPurchases").hidden = list.length > 0;
    document.querySelector(".table-wrap").hidden = list.length === 0;
  }

  async function openDashboard() {
    try {
      const acc = await api("/api/account");
      renderAccount(acc);
      show("dashboard");
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
      show("login");
    }
  }

  // ── Buy gold ───────────────────────────────────────────────────────────────
  const buyAmountInput = document.getElementById("buyAmount");

  function updateBuyPreview() {
    const preview = document.getElementById("buyPreview");
    const amount = Number(buyAmountInput.value);
    if (todayRate && Number.isFinite(amount) && amount > 0) {
      const gst = Math.round((amount * gstPercent) / 100);
      preview.textContent =
        `≈ ${(amount / todayRate).toFixed(4)} g at ${money(todayRate)}/g · +${money(gst)} GST → total ${money(amount + gst)}`;
    } else {
      preview.textContent = "";
    }
  }
  buyAmountInput.addEventListener("input", updateBuyPreview);

  // Receipts need the auth header, so fetch as a blob and trigger the download.
  async function downloadReceipt(purchaseId) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(`/api/receipts/${purchaseId}`, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error("Could not download the receipt");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Aparanji_Receipt_${purchaseId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(err.message);
    }
  }

  document.getElementById("buyBtn").addEventListener("click", async () => {
    setError("buyError", null);
    document.getElementById("buySuccess").hidden = true;
    try {
      const data = await api("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number(buyAmountInput.value) }),
      });
      renderAccount(data.account);
      const success = document.getElementById("buySuccess");
      success.textContent = data.message + " ";
      if (data.receiptId) {
        const link = document.createElement("a");
        link.href = "#";
        link.className = "receipt-link";
        link.textContent = "Download receipt (PDF)";
        link.addEventListener("click", (e) => {
          e.preventDefault();
          downloadReceipt(data.receiptId);
        });
        success.appendChild(link);
      }
      success.hidden = false;
      buyAmountInput.value = "";
      document.getElementById("buyPreview").textContent = "";
    } catch (err) {
      setError("buyError", err.message);
    }
  });

  // ── Redeem / withdraw ──────────────────────────────────────────────────────
  async function redeem(mode) {
    setError("redeemError", null);
    document.getElementById("redeemSuccess").hidden = true;

    const label = mode === "cash"
      ? "withdraw your full balance in cash"
      : "redeem your full balance as gold coins (1% making charge applies)";
    if (!window.confirm(`This will close your current scheme cycle and ${label}. Continue?`)) return;

    try {
      const data = await api("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      renderAccount(data.account);
      const success = document.getElementById("redeemSuccess");
      success.textContent = data.message;
      success.hidden = false;
    } catch (err) {
      setError("redeemError", err.message);
    }
  }

  document.getElementById("withdrawBtn").addEventListener("click", () => redeem("cash"));
  document.getElementById("coinsBtn").addEventListener("click", () => redeem("coins"));

  // ── Init ───────────────────────────────────────────────────────────────────
  loadConfig();
  if (localStorage.getItem(TOKEN_KEY)) {
    openDashboard();
  } else if (location.hash === "#register") {
    show("register");
  } else {
    show("login");
  }
})();
