(function () {
  "use strict";

  const KEY_STORE = "aparanji_admin_key";
  const money = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let adminKey = localStorage.getItem(KEY_STORE) || "";

  async function api(path, options = {}) {
    options.headers = Object.assign({ "x-admin-key": adminKey }, options.headers || {});
    const res = await fetch(path, options);
    if (res.status === 403) { logout(); throw new Error("Not authorized — check the admin key"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  function show(view) {
    document.getElementById("adminLogin").hidden = view !== "login";
    document.getElementById("adminConsole").hidden = view !== "console";
    document.getElementById("adminLogout").hidden = view !== "console";
  }

  function logout() {
    localStorage.removeItem(KEY_STORE);
    adminKey = "";
    show("login");
  }

  // ── Login ──
  document.getElementById("adminKeyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("adminLoginError");
    err.hidden = true;
    adminKey = document.getElementById("adminKey").value.trim();
    try {
      await api("/api/admin/data");
      localStorage.setItem(KEY_STORE, adminKey);
      show("console");
      loadData();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
  document.getElementById("adminLogout").addEventListener("click", (e) => { e.preventDefault(); logout(); });

  // ── Tabs ──
  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach((b) => b.classList.toggle("active", b === btn));
      const tab = btn.dataset.tab;
      ["withdrawals", "payments", "shipments", "master"].forEach((t) => {
        document.getElementById("tab-" + t).hidden = t !== tab;
      });
    });
  });
  document.getElementById("refreshBtn").addEventListener("click", loadData);

  function setMsg(text) {
    const m = document.getElementById("adminMsg");
    m.textContent = text || "";
    if (text) setTimeout(() => { if (m.textContent === text) m.textContent = ""; }, 6000);
  }

  function pdfLink(kind, id) {
    const a = el("a", "receipt-link", "PDF");
    a.href = "#";
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const res = await fetch(`/api/admin/pdf/${kind}/${id}`, { headers: { "x-admin-key": adminKey } });
        if (!res.ok) throw new Error("Not available");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = `Aparanji_${kind}_${id}.pdf`;
        document.body.appendChild(link); link.click(); link.remove();
        URL.revokeObjectURL(url);
      } catch (err) { setMsg(err.message); }
    });
    return a;
  }

  // ── Data ──
  async function loadData() {
    try {
      const data = await api("/api/admin/data");
      renderWithdrawals(data.withdrawals);
      renderPayments(data.pendingPayments);
      renderShipments(data.shipments);
      renderMaster(data.master);
      document.getElementById("countWithdrawals").textContent = data.withdrawals.filter((w) => w.status !== "paid").length || "";
      document.getElementById("countPayments").textContent = data.pendingPayments.length || "";
      document.getElementById("countShipments").textContent = data.shipments.filter((s) => s.status !== "dispatched").length || "";
      document.getElementById("countMaster").textContent = data.master.length || "";
    } catch (e) {
      setMsg(e.message);
    }
  }

  function fillTable(tbodyId, emptyId, rows, rowFn) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = "";
    rows.forEach((r) => tbody.appendChild(rowFn(r)));
    document.getElementById(emptyId).hidden = rows.length > 0;
  }

  function renderWithdrawals(list) {
    fillTable("withdrawalRows", "withdrawalsEmpty", list, (w) => {
      const tr = document.createElement("tr");
      const bank = w.bank ? `${w.bank.accountHolder} · ${w.bank.bankName} · A/c ${w.bank.accountNumber} · ${w.bank.ifsc}` : "-";
      tr.appendChild(el("td", null, fmtDate(w.date)));
      tr.appendChild(el("td", null, `${w.name} (${w.mobile})`));
      tr.appendChild(el("td", null, w.redemptionId));
      tr.appendChild(el("td", "num", money(w.amount)));
      tr.appendChild(el("td", null, bank));
      const st = el("td");
      const paid = w.status === "paid";
      st.appendChild(el("span", "pill " + (paid ? "pill-ok" : "pill-pending"), paid ? "Paid" : "Processing"));
      if (paid && w.payment) st.appendChild(el("div", "muted-note", "UTR " + w.payment.reference));
      tr.appendChild(st);
      const act = el("td", "num");
      if (paid) {
        act.appendChild(pdfLink("ack", w.redemptionId));
      } else {
        const b = el("button", "btn btn-primary btn-sm", "Mark paid");
        b.addEventListener("click", () => openPayModal(w));
        act.appendChild(b);
      }
      tr.appendChild(act);
      return tr;
    });
  }

  function renderPayments(list) {
    fillTable("paymentRows", "paymentsEmpty", list, (p) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", null, fmtDate(p.date)));
      tr.appendChild(el("td", null, `${p.name} (${p.mobile})`));
      tr.appendChild(el("td", null, p.purchaseId));
      tr.appendChild(el("td", "num", `${money(p.totalPaid)} (incl. GST ${money(p.gst)})`));
      tr.appendChild(el("td", "num", p.grams + " g"));
      const act = el("td", "num");
      const b = el("button", "btn btn-primary btn-sm", "Confirm payment");
      b.addEventListener("click", () => openConfirmModal(p));
      act.appendChild(b);
      tr.appendChild(act);
      return tr;
    });
  }

  function renderShipments(list) {
    fillTable("shipmentRows", "shipmentsEmpty", list, (s) => {
      const tr = document.createElement("tr");
      const to = s.shipTo ? `${s.shipTo.name}, ${s.shipTo.addressLine}, ${s.shipTo.city} - ${s.shipTo.pincode} (${s.shipTo.phone})` : "-";
      tr.appendChild(el("td", null, fmtDate(s.date)));
      tr.appendChild(el("td", null, `${s.name} (${s.mobile})`));
      tr.appendChild(el("td", null, s.redemptionId));
      tr.appendChild(el("td", "num", s.grams + " g"));
      tr.appendChild(el("td", null, to));
      const st = el("td");
      const sent = s.status === "dispatched";
      st.appendChild(el("span", "pill " + (sent ? "pill-ok" : "pill-pending"), sent ? "Dispatched" : "Processing"));
      if (sent && s.shipTo) st.appendChild(el("div", "muted-note", `${s.shipTo.courier} · ${s.shipTo.trackingNumber}`));
      tr.appendChild(st);
      const act = el("td", "num");
      if (sent) {
        act.appendChild(pdfLink("invoice", s.redemptionId));
      } else {
        const b = el("button", "btn btn-primary btn-sm", "Add tracking");
        b.addEventListener("click", () => openDispatchModal(s));
        act.appendChild(b);
      }
      tr.appendChild(act);
      return tr;
    });
  }

  function renderMaster(list) {
    fillTable("masterRows", "masterEmpty", list, (m) => {
      const tr = document.createElement("tr");
      [m.accountId, m.name, m.mobile, m.email, m.pan].forEach((v) => tr.appendChild(el("td", null, v)));
      const kyc = el("td");
      kyc.appendChild(el("span", "pill " + (m.kyc === "Verified" ? "pill-ok" : "pill-pending"), m.kyc));
      tr.appendChild(kyc);
      tr.appendChild(el("td", "num", m.confirmedGrams + " g"));
      tr.appendChild(el("td", "num", String(m.pending || 0)));
      return tr;
    });
  }

  // ── Action modal ──
  const modal = document.getElementById("adminModal");
  let modalSubmitFn = null;

  function openModal(title, fields, onSubmit) {
    document.getElementById("modalTitle").textContent = title;
    const body = document.getElementById("modalBody");
    body.innerHTML = "";
    fields.forEach((f) => {
      const wrap = el("div", "calc-field");
      wrap.appendChild(el("label", null, f.label));
      const input = el(f.type === "date" ? "input" : "input");
      input.type = f.type || "text";
      input.id = "modal_" + f.name;
      if (f.value) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      wrap.appendChild(input);
      body.appendChild(wrap);
    });
    document.getElementById("modalError").hidden = true;
    modalSubmitFn = onSubmit;
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; modalSubmitFn = null; }
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  document.getElementById("modalSubmit").addEventListener("click", async () => {
    if (!modalSubmitFn) return;
    const err = document.getElementById("modalError");
    err.hidden = true;
    try {
      await modalSubmitFn();
      closeModal();
      loadData();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  const mval = (name) => document.getElementById("modal_" + name).value.trim();

  function openConfirmModal(p) {
    openModal(`Confirm payment — ${p.purchaseId}`, [
      { name: "reference", label: `Payment reference / remarks (e.g. UPI txn or "${p.purchaseId}")`, placeholder: "Payment reference" },
    ], async () => {
      await api("/api/admin/confirm-payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: p.accountId, purchaseId: p.purchaseId, reference: mval("reference") }),
      });
      setMsg(`Payment confirmed for ${p.purchaseId}. Receipt generated.`);
    });
  }

  function openPayModal(w) {
    const today = new Date().toISOString().slice(0, 10);
    openModal(`Mark withdrawal paid — ${w.redemptionId}`, [
      { name: "reference", label: "Bank reference / UTR number", placeholder: "e.g. N012345678901" },
      { name: "method", label: "Payment method", value: "Bank transfer (NEFT/IMPS)" },
      { name: "paidOn", label: "Paid on", type: "date", value: today },
      { name: "note", label: "Note (optional)" },
    ], async () => {
      await api("/api/admin/pay-withdrawal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: w.accountId, redemptionId: w.redemptionId, reference: mval("reference"), method: mval("method"), paidOn: mval("paidOn"), note: mval("note") }),
      });
      setMsg(`Withdrawal ${w.redemptionId} marked paid. Acknowledgement generated.`);
    });
  }

  function openDispatchModal(s) {
    openModal(`Dispatch coins — ${s.redemptionId}`, [
      { name: "courier", label: "Courier / logistics partner", placeholder: "e.g. BlueDart" },
      { name: "trackingNumber", label: "Tracking number", placeholder: "e.g. 1234567890" },
    ], async () => {
      await api("/api/admin/dispatch-coins", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: s.accountId, redemptionId: s.redemptionId, courier: mval("courier"), trackingNumber: mval("trackingNumber") }),
      });
      setMsg(`Coins for ${s.redemptionId} marked dispatched.`);
    });
  }

  // ── Init ──
  if (adminKey) {
    api("/api/admin/data").then(() => { show("console"); loadData(); }).catch(() => { show("login"); });
  } else {
    show("login");
  }
})();
