# FishTrade — Cloudflare D1 shared business manager

A mobile-friendly fish business ledger running on Cloudflare Workers with Cloudflare **D1 (SQLite)**. Partners use the same URL and the same live database.

## Features

- Purchases, supplier bill status, payment method and remarks
- Sales invoices with multiple items and rejected items excluded from totals
- Partner contributions (Ajay and Abhishek) with notes
- Fish cost/selling prices, dashboard, CSV and JSON exports
- Mobile-responsive layout, touch-sized buttons, horizontal scrolling for tables
- Single shared sign-in password, secure HttpOnly session cookies, 7-day sessions
- Optimistic version check to prevent silent overwrites by other browsers
- Initial data: **9 purchases, 8 invoices, 8 contribution rows, 6 fish prices**, sourced from the provided ledger

## What you need

- Free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- Node.js 20 or newer and a terminal (Mac / Windows / Linux)
- No domain purchase required. A free `.workers.dev` link is assigned upon deployment.

## Deploy in about 8 steps

1. Extract this ZIP into a folder named `fishtrade-cloudflare`. Open a terminal in that folder.
2. Install tooling:

   ```sh
   npm install
   npx wrangler login
   ```

   Cloudflare prompts you to authorize access in your browser.

3. Create D1 SQLite database:

   ```sh
   npx wrangler d1 create fishtrade-ledger
   ```

4. Copy the `database_id` UUID from the output and replace `REPLACE_WITH_YOUR_DATABASE_ID` in **wrangler.jsonc**. Keep the D1 binding name as `DB`.
5. Create the SQL tables and import the supplied sample records into your remote D1 database:

   ```sh
   npm run migrate:remote
   ```

   Confirm when prompted. **Only migrate once.** Do not delete the existing database if you redeploy the site later.

6. Set a strong shared password (use 16+ random characters):

   ```sh
   npx wrangler secret put APP_PASSWORD
   ```

   It prompts for a value privately. Tell partners the password through a safe channel.

7. Set an **independent random session-signing secret**, ideally 32+ random characters and not the same as the business password:

   ```sh
   npx wrangler secret put SESSION_SECRET
   ```

8. Publish the live site:

   ```sh
   npm run deploy
   ```

Wrangler prints the deployed `https://fishtrade-partners.<YOUR-SUBDOMAIN>.workers.dev` URL. Share it only with your partners. The login screen protects data from visitors without the password.

## Updates

After editing front-end or back-end code, run `npm run deploy`. Do not recreate the D1 database or reset the database ID: the existing transactions remain. The browser **Refresh** button loads changes from another partner. Changes do not stream instantly without refresh.

## Backups

Use the app's **Settings → Download JSON backup** on a regular schedule. You can also use Cloudflare's D1 database export and Time Travel recovery. A JSON backup can be restored in Settings; restoring overwrites all other records and should be coordinated among partners.

## Important financial reconciliation

- The source's original `₹16,02,500` sales total omitted the 30 Sep invoice (₹1,30,000). Eight provided invoices total ₹17,32,500 (excluding rejected items).
- An unexplained ₹43,600 debit and ₹2,500 noted from Anish Sharma are not automatically counted.
- The ₹65,000 bill marked **on hold** is retained but excluded from booked purchases.
- Partner contributions are not the same as revenue, equity shares, or profit distribution.
- The sales-minus-purchases KPI is **not** net accounting profit (does not account for all expenses, collections, taxes, or inventory).

## Security / production limitations

This is a functional **small-group starter**, not a full enterprise ERP. All partners share **one** password, so edits cannot be attributed to individual partners, and everyone has full edit privileges. For distinct partner accounts, per-person access levels, or an edit audit log, extend the authentication and database schema before wide rollout. The app cannot guarantee real-time simultaneous collaboration: conflicting updates produce a visible error, and the unsaved editor can be exported as a JSON backup before refreshing. Transactions are stored on Cloudflare's infrastructure, not in a downloadable `.sqlite` file inside the app.

Keep backup exports private because they contain business financial data. Rotate the shared password promptly if it is exposed, and rotate SESSION_SECRET to invalidate existing sessions.

## Local development (optional)

To run on localhost, apply the migration locally first: `npm run migrate:local`. Then create a `.dev.vars` file with `APP_PASSWORD=...` and `SESSION_SECRET=...` (never commit or upload secrets). Run `npm run dev`. Your deployed database and local DB are separate.

## Relevant documentation

- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/configuration/secrets/
