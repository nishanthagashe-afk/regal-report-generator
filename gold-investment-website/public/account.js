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

  // Create an element with an optional class and text.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const views = {
    login: document.getElementById("loginView"),
    register: document.getElementById("registerView"),
    dashboard: document.getElementById("dashboardView"),
  };

  function show(view) {
    Object.entries(views).forEach(([name, el]) => (el.hidden = name !== view));
    if (view === "login") resetLoginForm();
  }

  // Clear any half-finished OTP state so a fresh login always starts at step 1.
  function resetLoginForm() {
    document.getElementById("loginOtp").value = "";
    document.getElementById("otpStep").hidden = true;
    document.getElementById("sendOtpBtn").hidden = false;
    document.getElementById("verifyOtpBtn").hidden = true;
    document.getElementById("resendOtpBtn").hidden = true;
    document.getElementById("loginError").hidden = true;
    clearInterval(resendTimer);
  }

  function setError(id, msg) {
    const node = document.getElementById(id);
    if (msg) {
      node.textContent = msg;
      node.hidden = false;
    } else {
      node.hidden = true;
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
        data.source === "jab"
          ? `JAB Bengaluru · live · ${new Date(data.asOf).toLocaleTimeString("en-IN")}`
          : `JAB Bengaluru · as of ${data.asOf}`;
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
      renderPaymentDetails(config.payment);
    } catch (e) {
      /* defaults are fine */
    }
  }

  function renderPaymentDetails(pay) {
    if (!pay) return;
    const dl = document.getElementById("payDetailsList");
    dl.innerHTML = "";
    const rows = [
      ["UPI ID (VPA)", pay.vpa],
      ["Bank", pay.bankName],
      ["Account name", pay.accountName],
      ["Account number", pay.accountNumber],
      ["Branch", pay.branch],
      ["IFSC", pay.ifsc],
      ["MMID", pay.mmid],
    ];
    rows.forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    });
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
      success.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      setError("registerError", err.message);
    }
  });

  // ── OTP login ──────────────────────────────────────────────────────────────
  let resendTimer = null;

  function startResendCountdown() {
    const btn = document.getElementById("resendOtpBtn");
    btn.hidden = false;
    let left = 30;
    btn.disabled = true;
    btn.textContent = `Resend OTP (${left}s)`;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(resendTimer);
        btn.disabled = false;
        btn.textContent = "Resend OTP";
      } else {
        btn.textContent = `Resend OTP (${left}s)`;
      }
    }, 1000);
  }

  async function requestOtp() {
    setError("loginError", null);
    const identifier = document.getElementById("loginIdentifier").value.trim();
    if (!identifier) return setError("loginError", "Enter your registered mobile number or email");
    try {
      const data = await api("/api/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      document.getElementById("otpStep").hidden = false;
      document.getElementById("sendOtpBtn").hidden = true;
      document.getElementById("verifyOtpBtn").hidden = false;
      const note = document.getElementById("otpSentNote");
      note.textContent = data.message + (data.demoOtp ? ` · Demo OTP: ${data.demoOtp}` : "");
      startResendCountdown();
      document.getElementById("loginOtp").focus();
    } catch (err) {
      setError("loginError", err.message);
    }
  }

  document.getElementById("sendOtpBtn").addEventListener("click", requestOtp);
  document.getElementById("resendOtpBtn").addEventListener("click", requestOtp);

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("loginError", null);
    try {
      const data = await api("/api/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: document.getElementById("loginIdentifier").value.trim(),
          otp: document.getElementById("loginOtp").value.trim(),
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
        `Withdraw ${money(scheme.cashWithdrawalValue)} to your bank account · or take ${acc.totals.grams} g in gold coins (making charge ≈ ${money(scheme.estimatedMakingCharge)})`;
      redeemActions.hidden = false;
    } else {
      redeemStatus.textContent = from
        ? `Locked until ${from}. After that date you can withdraw the full value to your bank or take gold coins.`
        : "Redemption opens 11 months after your first purchase.";
      redeemActions.hidden = true;
    }

    // Savings plan
    const plan = acc.savingPlan;
    const planStatus = document.getElementById("planStatus");
    if (plan) {
      document.getElementById("planFreq").value = plan.frequency;
      document.getElementById("planAmount").value = plan.amount;
      planStatus.textContent = plan.active
        ? `Active: ${money(plan.amount)} ${plan.frequency}`
        : `Paused: ${money(plan.amount)} ${plan.frequency}`;
      document.getElementById("planStartBtn").textContent = plan.active ? "Update plan" : "Resume plan";
      document.getElementById("planPauseBtn").hidden = !plan.active;
    } else {
      planStatus.textContent = "";
      document.getElementById("planStartBtn").textContent = "Start plan";
      document.getElementById("planPauseBtn").hidden = true;
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
      const payout = r.mode === "cash" ? (r.bank || "Bank transfer") : "Gold coins";
      [date, r.mode === "cash" ? "Bank transfer" : "Gold coins", r.grams + " g", money(r.ratePerGram), value, payout, r.status]
        .forEach((v, i) => {
          const td = document.createElement("td");
          td.textContent = v;
          if (i >= 2 && i <= 4) td.className = "num";
          tr.appendChild(td);
        });
      const invoiceTd = document.createElement("td");
      invoiceTd.className = "num";
      const invLink = document.createElement("a");
      invLink.href = "#";
      invLink.className = "receipt-link";
      invLink.textContent = "PDF";
      invLink.addEventListener("click", (e) => {
        e.preventDefault();
        downloadDocument(`/api/invoices/${r.id}`, `Aparanji_Invoice_${r.id}.pdf`);
      });
      invoiceTd.appendChild(invLink);
      tr.appendChild(invoiceTd);
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

  // PDFs need the auth header, so fetch as a blob and trigger the download.
  async function downloadDocument(apiPath, filename) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(apiPath, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error("Could not download the document");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(err.message);
    }
  }

  function downloadReceipt(purchaseId) {
    return downloadDocument(`/api/receipts/${purchaseId}`, `Aparanji_Receipt_${purchaseId}.pdf`);
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
      if (data.payment) {
        document.getElementById("payAmount").textContent = money(data.payment.amount);
        document.getElementById("payUpiBtn").href = data.payment.upiLink;
        document.getElementById("payQr").src = data.payment.qrUrl;
        document.getElementById("payNow").hidden = false;
      }
      buyAmountInput.value = "";
      document.getElementById("buyPreview").textContent = "";
    } catch (err) {
      setError("buyError", err.message);
    }
  });

  // ── Savings plan ───────────────────────────────────────────────────────────
  async function saveSavingPlan(active) {
    setError("planError", null);
    document.getElementById("planSuccess").hidden = true;
    try {
      const data = await api("/api/saving-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frequency: document.getElementById("planFreq").value,
          amount: Number(document.getElementById("planAmount").value),
          active,
        }),
      });
      renderAccount(data.account);
      const success = document.getElementById("planSuccess");
      success.textContent = data.message;
      success.hidden = false;
    } catch (err) {
      setError("planError", err.message);
    }
  }
  document.getElementById("planStartBtn").addEventListener("click", () => saveSavingPlan(true));
  document.getElementById("planPauseBtn").addEventListener("click", () => saveSavingPlan(false));

  // ── Redeem / withdraw ──────────────────────────────────────────────────────
  const bankForm = document.getElementById("bankForm");

  function renderAcknowledgement(ack) {
    const box = document.getElementById("withdrawAck");
    box.innerHTML = "";
    box.appendChild(el("h4", null, "Withdrawal request received"));
    const dl = document.createElement("dl");
    const row = (label, value) => { dl.appendChild(el("dt", null, label)); dl.appendChild(el("dd", null, value)); };
    row("Reference", ack.referenceId);
    row("Amount", money(ack.amount));
    row("Gold redeemed", ack.grams + " g");
    row("Payout to", ack.bank);
    row("Expected", ack.expectedBy);
    box.appendChild(dl);
    const link = el("a", "receipt-link", "Download acknowledgement / invoice (PDF)");
    link.href = "#";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      downloadDocument(`/api/invoices/${ack.referenceId}`, `Aparanji_Withdrawal_${ack.referenceId}.pdf`);
    });
    box.appendChild(link);
    box.hidden = false;
  }

  async function submitRedeem(mode, bankDetails) {
    setError("redeemError", null);
    document.getElementById("redeemSuccess").hidden = true;
    document.getElementById("withdrawAck").hidden = true;
    try {
      const data = await api("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bankDetails ? { mode, bankDetails } : { mode }),
      });
      renderAccount(data.account);
      bankForm.hidden = true;
      bankForm.reset();
      if (data.acknowledgement) {
        renderAcknowledgement(data.acknowledgement);
      } else {
        const success = document.getElementById("redeemSuccess");
        success.textContent = data.message + " ";
        if (data.invoiceId) {
          const link = el("a", "receipt-link", "Download invoice (PDF)");
          link.href = "#";
          link.addEventListener("click", (e) => {
            e.preventDefault();
            downloadDocument(`/api/invoices/${data.invoiceId}`, `Aparanji_Invoice_${data.invoiceId}.pdf`);
          });
          success.appendChild(link);
        }
        success.hidden = false;
      }
    } catch (err) {
      setError("redeemError", err.message);
    }
  }

  // "Withdraw to bank" reveals the bank-details form; "Take gold coins" confirms directly.
  document.getElementById("withdrawBtn").addEventListener("click", () => {
    setError("redeemError", null);
    document.getElementById("redeemSuccess").hidden = true;
    document.getElementById("withdrawAck").hidden = true;
    bankForm.hidden = false;
    document.getElementById("bankAccountHolder").focus();
  });
  document.getElementById("bankCancelBtn").addEventListener("click", () => {
    bankForm.hidden = true;
    bankForm.reset();
  });
  bankForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const bankDetails = {
      accountHolder: document.getElementById("bankAccountHolder").value.trim(),
      bankName: document.getElementById("bankName").value.trim(),
      accountNumber: document.getElementById("bankAccountNumber").value.trim(),
      ifsc: document.getElementById("bankIfsc").value.trim().toUpperCase(),
    };
    submitRedeem("cash", bankDetails);
  });
  document.getElementById("coinsBtn").addEventListener("click", () => {
    if (!window.confirm("This will close your current scheme cycle and redeem your full balance as gold coins (1% making charge applies). Continue?")) return;
    submitRedeem("coins");
  });

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
