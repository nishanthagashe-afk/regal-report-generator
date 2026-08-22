# Aparanji — Deployment & Go-Live Runbook

Aparanji is a Node/Express app (`gold-investment-website/`). It stores customer
records, KYC uploads and generated PDFs on disk under `DATA_DIR`, so production
needs a **persistent disk**. This runbook covers a Render deploy; the included
`Dockerfile` works on any container host too.

## Secrets you must set (never commit these)

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Signs login sessions. Required in production (the app refuses to boot without it). Render can auto-generate it. |
| `ADMIN_KEY` | Unlocks the admin console at `/admin.html`. Choose a long random value. |
| `DATA_DIR` | Path to the persistent disk (e.g. `/data`). |
| `NODE_ENV` | `production`. |

Generate a secret locally:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

OTP delivery (needed for real customer logins — see `.env.example`):
`SMTP_HOST/PORT/USER/PASS/FROM` for email, `SMS_GATEWAY_URL` + `SMS_API_KEY`
for SMS. Until these are set, real customers cannot receive an OTP.

## Staging on Render (recommended first)

1. **dashboard.render.com → New → Blueprint** and connect this repo. Render reads
   `gold-investment-website/render.yaml` and proposes the **aparanji** web service
   with a 1 GB disk. The disk needs the **Starter plan** (the free tier has no
   persistent storage).
2. **Environment** → set:
   - `ADMIN_KEY` = your admin key
   - `OTP_DEBUG` = `1`  *(staging only — shows the OTP on screen so you can test
     logins without an SMS provider; REMOVE before public launch)*
   - `SESSION_SECRET` is auto-generated; `NODE_ENV`/`DATA_DIR` come from the blueprint.
3. **Deploy.** Build `npm install`, start `node server.js`, health check `/health`.
4. **Trial the full flow** on the live URL:
   - Register a test customer, log in (OTP shows on screen in staging).
   - Buy gold → `/admin.html` (sign in with `ADMIN_KEY`) → confirm payment → receipt.
   - Withdraw → admin marks paid → payment acknowledgement PDF.
   - Gold coins → admin adds tracking → dispatched.
   - Check the rate ticker: "JAB Bengaluru · live" means scraping works from the
     server; "as of <date>" means JAB blocks the server and you maintain the rate
     in `data/config.json` (one line, from jab.org.in).

## Flip to public launch

1. Remove `OTP_DEBUG`.
2. Add SMS (DLT-registered gateway, e.g. MSG91) and/or SMTP credentials; confirm a
   real OTP arrives.
3. Make a ₹1 test payment to the `valanka@federal` VPA and confirm it lands in the
   Valanka Federal Bank account.
4. Complete legal/compliance sign-off (digital gold + deposit-scheme rules + DPDP
   Act for Aadhaar/PAN). Fill the blank company fields in `data/config.json`
   (CIN, GSTIN, registered office, grievance officer).
5. Point your custom domain at the Render service and share the URL.

## Operating notes

- **Back up `DATA_DIR`** regularly — it holds all customer records and KYC.
- Update the JAB fallback rate in `data/config.json` (`goldRatePerGram24K` /
  `updatedOn`) whenever the live scrape is unavailable.
- Admin console: `/admin.html` → withdrawal requests, pending payments, coin
  shipments, customer master.
