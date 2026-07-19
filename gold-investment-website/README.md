# Aparanji — Digital Gold Investment Website

An independent website for Aparanji, accepting investment exclusively toward
**digital gold purchase**: customers buy 24K 999-purity gold in fractional grams
at the live market rate, starting from ₹100.

## Scheme rules

- **3% GST** is charged on the purchase (gold) value of every buy.
- This is an **11-month scheme**: redemption opens 11 months after the customer's
  first purchase.
- At closure, the customer redeems against **gold coins** with a **1% making
  charge** — or, if they don't want coins, **withdraws the equivalent value in
  money** instead.

## Features

- **Live Indian 24K rate** — the server fetches the INR gold price live
  (goldprice.org INR feed, falling back to spot XAU/USD × USD/INR), then applies
  the configured **import duty** and **local premium** to land on the Indian
  market rate (IBJA/MCX-style), caches for 30 s, and clients poll `/api/rate`
  every second. If every feed is unreachable, the configured rate in
  `data/config.json` is served as a clearly-labelled fallback.
- **Account creation with KYC** — name, mobile, email, Aadhaar number, PAN, and
  uploaded copies of both documents (JPG/PNG/PDF, max 5 MB each). Duplicate
  mobile/PAN registrations are rejected; accounts start as "Under verification".
- **Customer-wise accounts** — each customer logs in (account ID + registered
  mobile) to a personal dashboard showing every purchase with the **invested
  amount, GST paid, rate at which invested, and grams credited**, plus totals:
  gold held, **current value at the live rate**, and gain/loss.
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
- `goldRatePerGram24K` / `updatedOn` — fallback rate when the live feed is down
- `importDutyPercent` (default 6) — customs duty applied on top of INR spot to
  reach the landed Indian rate
- `localPremiumPercent` — extra local market premium; tune it so the displayed
  rate tracks the IBJA/MCX published rate in your market
- `gstPercent`, `lockInMonths`, `makingChargePercent` — scheme terms
- `minPurchaseAmount` — minimum per purchase

Environment variables:
- `SESSION_SECRET` — set in production so customer logins survive restarts
- `ADMIN_KEY` — enables `GET /api/customers` (full customer list) via the
  `x-admin-key` header; endpoint returns 403 when unset

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
