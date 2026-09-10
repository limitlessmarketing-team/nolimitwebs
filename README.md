# Limitless Marketing Group — portfolio

The portfolio site we send to prospective clients. Rebuilt from scratch in
September 2026; the previous repo (`limitless-marketing-portfolio`) is kept
for history only.

**Live:** https://nolimitwebs.com (Cloudflare Pages)

---

## What's in here

### `site/` — the live site

Plain HTML and CSS, no build step. `index.html` and `styles.css` are the
homepage; the six `*.webp` files are the portfolio screenshots; `proposal/`,
`payment-complete/` and `billing-terms/` are the static client billing pages;
`_headers` sets the privacy headers on those pages. **This is the folder
Cloudflare Pages serves.**

Edit `site/index.html` directly for copy changes. Commit to `main` and
Cloudflare Pages deploys it on its own.

### `functions/` and `lib/` — the Stripe proposal checkout

`functions/api/*.js` are Cloudflare Pages Functions (they become
`/api/proposal`, `/api/payment-status` and `/api/stripe-webhook`). The shared
Stripe logic lives in `lib/stripe.mjs` and is covered by `npm test`.
See [BILLING.md](BILLING.md) for the Stripe setup and the environment
variables the functions need.

### The six demo sites

Each portfolio piece is its own repo and its own Cloudflare Pages project:
`demo-kestrel-heating`, `demo-basalt-roofing`, `demo-halstead-fence`,
`demo-bluestem-landscape`, `demo-formline-concrete`, `demo-alpenglow-painting`
(live at `<name>.pages.dev`, e.g. https://kestrel-heating.pages.dev).

Adding a project to the portfolio: add a card to the "Selected work" grid in
`site/index.html` and drop a 1600×900 screenshot next to the others.


---

## Hosting (Cloudflare Pages)

The Cloudflare Pages project `nolimitwebs` is connected to this repo. Production
branch `main`, no build command, output directory `site` (all in `wrangler.toml`).
Every push to `main` deploys. Other branches get preview URLs.

Environment variables (Pages project → Settings → Variables and secrets):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MODE` (`live` on
Production, `test` on Preview). The Stripe event destination must point at
`https://nolimitwebs.com/api/stripe-webhook`.

Run the whole thing locally with `npx wrangler pages dev site`.
