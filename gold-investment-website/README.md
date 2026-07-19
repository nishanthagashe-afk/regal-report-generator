# Regal Jewellers — Gold Investment Website

A website for customers to browse, calculate, and enroll in Regal Jewellers' gold
investment schemes: **Regalia**, **Akshyanidhi**, **GoldGram**, **Swarnaraksha**, and
**Swayamvara**.

## Features

- **Scheme showcase** — cards for all five schemes with tenure, minimums, and highlights.
- **Investment calculator** — estimates maturity value / bonus for installment schemes,
  or grams accumulated for the GoldGram digital-gold scheme.
- **Enrollment form** — captures name, phone, email, preferred scheme, amount, and
  branch; returns a reference ID (e.g. `RGL-3F9A2C10`) and stores the enquiry.
- Responsive, gold/black themed design (desktop + mobile), with light/dark support.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend — scheme data, calculator, and enrollment APIs |
| `data/schemes.json` | Scheme definitions and today's gold rate (edit this to update rates/terms) |
| `data/leads.json` | Auto-created; stores submitted enrollment enquiries |
| `public/index.html` | The website markup |
| `public/styles.css` | Styling |
| `public/app.js` | Frontend logic (fetches schemes, runs calculator, submits enrollments) |

## Run locally

```bash
cd gold-investment-website
npm install
node server.js
# Open http://localhost:3000
```

## Updating the gold rate / scheme terms

Edit `data/schemes.json` — no code changes needed. Update `goldRatePerGram22K`,
`goldRatePerGram24K`, and `updatedOn` daily (or wire it to a live rate feed later).

## Viewing submitted enquiries

Enquiries are appended to `data/leads.json`. To view them over HTTP, set an
`ADMIN_KEY` environment variable and request:

```bash
curl -H "x-admin-key: <your-admin-key>" https://your-deployed-url/api/leads
```

The endpoint returns `403` if `ADMIN_KEY` is not set, so it's safe by default.

## Deploy

Same flow as this repo's report-generator app: push to GitHub, then on
[Render](https://render.com) create a **Web Service** with:
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- (Optional) **Environment Variable**: `ADMIN_KEY` to enable the enquiries endpoint

## Notes

- Gold rates and scheme bonuses shown are indicative; `data/schemes.json` is the
  single source of truth used by both the calculator and enrollment validation.
- No real "jar app" source was available to port from — this was designed from
  scratch using the gold-scheme names already referenced in this repository's
  fund position report generator.
