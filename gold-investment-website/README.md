# Aparanji — Digital Gold Investment Website

An independent website for Aparanji, accepting investment exclusively toward
**digital gold purchase**: customers buy 24K 999-purity gold in fractional grams
at the live daily rate, starting from ₹100.

## Features

- **Digital gold only** — no installment schemes, chit-style plans, or rate-lock
  products; a single simple product.
- **Live rate ticker** — today's 24K rate shown site-wide, driven by `data/config.json`.
- **Gold calculator** — converts ₹ → grams or a gram target → ₹ at today's rate.
- **Investment form** — captures name, phone, email, and intended first investment;
  returns a reference ID (e.g. `APJ-3F9A2C10`) and stores the enquiry for KYC follow-up.
- Responsive, gold/black themed design (desktop + mobile), with light/dark support.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend — config, calculator, and investment-enquiry APIs |
| `data/config.json` | Gold rate, minimum purchase, lock-in, and page content (edit this to update rates) |
| `data/leads.json` | Auto-created; stores submitted investment enquiries |
| `public/index.html` | The website markup |
| `public/styles.css` | Styling |
| `public/app.js` | Frontend logic (loads config, runs calculator, submits enquiries) |

## Run locally

```bash
cd gold-investment-website
npm install
node server.js
# Open http://localhost:3000
```

## Updating the gold rate

Edit `data/config.json` — no code changes needed. Update `goldRatePerGram24K` and
`updatedOn` daily (or wire it to a live rate feed later).

## Viewing submitted enquiries

Enquiries are appended to `data/leads.json`. To view them over HTTP, set an
`ADMIN_KEY` environment variable and request:

```bash
curl -H "x-admin-key: <your-admin-key>" https://your-deployed-url/api/leads
```

The endpoint returns `403` if `ADMIN_KEY` is not set, so it's safe by default.

## Deploy

Push to GitHub, then on [Render](https://render.com) create a **Web Service** with:
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- (Optional) **Environment Variable**: `ADMIN_KEY` to enable the enquiries endpoint

## Notes

- The rate applied to a real purchase should be the published rate at execution
  time; the site's calculator is indicative.
- `data/config.json` is the single source of truth used by both the calculator
  and enquiry validation.
