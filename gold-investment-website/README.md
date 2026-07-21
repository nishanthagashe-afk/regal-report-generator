# Aparanji — Digital Gold Investment Website

An independent website for Aparanji, accepting investment exclusively toward
**digital gold purchase**: customers buy 24K 999-purity gold in fractional grams
at the live Jewellers' Association Bangalore (jab.org.in) rate, starting from ₹100.

## Scheme rules

- **3% GST** is charged on the purchase (gold) value of every buy.
- This is an **11-month scheme**: redemption opens 11 months after the customer's
  first purchase.
- At closure, the customer redeems against **gold coins** with a **1% making
  charge** — or, if they don't want coins, **withdraws the equivalent value in
  money** instead.

## Features

- **Live 24K rate — Jewellers' Association Bangalore (jab.org.in) only** — the
  gold rate is sourced solely from JAB, never MCX or international spot. The
  server scrapes the published 24K (999) per-gram rate from jab.org.in; if that
  is unavailable it falls back to the JAB rate staff key into `data/config.json`
  (`goldRatePerGram24K` / `updatedOn`) — still a real JAB figure. Cached 30 s;
  clients poll `/api/rate` every second. The ticker shows "JAB Bengaluru · live"
  when scraped, or "JAB Bengaluru · as of <date>" on the manual fallback.
- **PDF receipt vouchers** — every deposit generates a branded A4 receipt
  (receipt no., customer + masked KYC, gold value, GST, total received, rate
  applied, grams credited, running balance). Downloadable from the buy
  confirmation and from each purchase row; auth-guarded per customer and
  regenerated on demand if missing.
- **Account creation with KYC** — name, mobile, email, Aadhaar number, PAN, and
  uploaded copies of both documents (JPG/PNG/PDF, max 5 MB each). Duplicate
  mobile/PAN registrations are rejected; accounts start as "Under verification".
- **Customer-wise accounts with OTP login** — customers log in with a 6-digit
  OTP sent to their registered mobile or email (5-minute validity, rate-limited
  sends and attempts). Delivery uses SMTP (`SMTP_HOST/PORT/USER/PASS/FROM`) for
  email and a JSON webhook (`SMS_GATEWAY_URL` + `SMS_API_KEY`) for SMS; with no
  provider configured, codes print to the server log for manual relay, and
  `OTP_DEBUG=1` echoes them to the client (local testing only). The dashboard
  shows every purchase with the **invested amount, GST paid, rate at which
  invested, and grams credited**, plus totals: gold held, **current value at
  the live rate**, and gain/loss.
- **Savings plans & rate tools** — daily/monthly savings plan (stored per
  customer; UPI Autopay mandate set up offline by the team), a purity-wise
  gold rate calculator, a live 24K/22K/18K rates table, and a daily-vs-monthly
  savings projection slider on the homepage.
- **Buy gold** from the dashboard at the live rate (+3% GST), with a live
  preview of grams and total payable.
- **Gold calculator** on the homepage — ₹ → grams or grams → ₹, including GST
  and total payable.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend — live rate, KYC registration, login, portfolio, purchases |
| `data/config.json` | Fallback rate, GST %, lock-in, making charge %, page content |
| `data/customers.json` | Auto-created; customer accounts, KYC details, purchases (never commit) |
| `data/uploads/` | Auto-created; uploaded KYC document files (never commit) |
| `public/index.html` + `app.js` | Homepage: features, steps, calculator, account CTA, FAQ |
| `public/account.html` + `account.js` | Registration with KYC, login, customer dashboard |
| `public/styles.css` | Styling |

## Run locally

```bash
cd gold-investment-website
npm install
node server.js
# Open http://localhost:3000
```

## Configuration

Edit `data/config.json`:
- `goldRatePerGram24K` / `updatedOn` — the JAB (jab.org.in) 24K rate, used only
  when the live scrape is unavailable. Staff should update these from the JAB
  site so the manual fallback is always a real JAB figure.
- `gstPercent`, `lockInMonths`, `makingChargePercent` — scheme terms
- `minPurchaseAmount` — minimum per purchase

Environment variables:
- `SESSION_SECRET` — set in production so customer logins survive restarts
- `ADMIN_KEY` — enables `GET /api/customers` (full customer list) via the
  `x-admin-key` header; endpoint returns 403 when unset

## Admin console

Visit `/admin.html` and sign in with the `ADMIN_KEY` you set. From there staff can:

- **Withdrawal requests** — see every customer bank-transfer request; "Mark paid"
  records the UTR/reference and paid date and generates a payment acknowledgement
  PDF the customer can download.
- **Pending payments** — purchases sit as "Payment pending" until confirmed here
  with the payment reference/remarks; confirming credits the gold and generates
  the receipt (receipts are **not** generated at purchase time).
- **Coin shipments** — gold-coin redemptions carry the customer's shipping
  address; "Add tracking" records courier + tracking number and marks dispatched,
  which the customer then sees on their dashboard.
- **Customer master** — the full customer list with KYC status and holdings.

The admin key is entered in the browser and sent as the `x-admin-key` header; set
a long random `ADMIN_KEY` in production. Withdrawals are also blocked before the
11-month scheme term completes, with a message to complete the remaining
installments.

## Deploy

Push to GitHub, then on [Render](https://render.com) create a **Web Service**:
- **Runtime**: Node · **Build**: `npm install` · **Start**: `node server.js`
- Set `SESSION_SECRET` (any long random string) and optionally `ADMIN_KEY`

> **Note:** customer data and KYC uploads are stored on local disk. On hosts
> with ephemeral disks (e.g. Render free tier) attach a persistent disk or move
> to a database before going live — otherwise customer records are lost on
> redeploy.

## Compliance notes (review before launch)

- Digital gold is an unregulated product in India; have legal/compliance review
  the offering, KYC handling, and scheme terms before taking real money.
- Aadhaar and PAN are sensitive personal data: serve the site over HTTPS only,
  restrict access to `data/`, and consider encryption at rest. API responses
  only ever expose masked Aadhaar/PAN.
