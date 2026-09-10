# Website proposal checkout

## Status

Published to **https://nolimitwebs.com** on September 9, 2026. PR #1 is merged.
Production uses the approved live restricted key and live webhook signing secret;
Preview retains separate sandbox credentials. The live native proposal workflow
is active and Stripe's public terms URL points to `/billing-terms/`.

Hosting moved from Vercel to **Cloudflare Pages** on September 10, 2026. The
three API routes are now Cloudflare Pages Functions (`functions/api/`) sharing
`lib/stripe.mjs`; the behaviour and URLs are unchanged.

All 25 automated billing tests pass. Sandbox Checkout collected the 50% deposit,
saved the authorized card, and passed the signed webhook handoff. The launch
workflow collected the remaining 50% and created monthly hosting with a 30-day
delay. A replay preserved the completed launch and existing subscription.
Production pages, privacy headers and unsigned-webhook rejection were checked.
No real customer was charged or messaged during setup.

Start in [Client proposal — website deposit and hosting](https://dashboard.stripe.com/acct_1UDajlFTuwNJOMsb/workflows/wf_61VNGHXOtjIInrtXe16VMyh7IBSQ87fRjENquoOACKb2).
Enter project name, full build cents and monthly hosting cents; run once and copy
the payment link result's `plink_` ID into `https://nolimitwebs.com/proposal/#`.
Verify the displayed amounts before sharing the resulting proposal URL.

The static `site/` folder remains the served root. Cloudflare Pages Functions
connect the static proposal pages to Stripe. The homepage and Supabase lead
capture are unchanged. No separate customer database or external billing app
is introduced.

## Client flow

1. Team creates a client-specific, single-payment Stripe Payment Link using the
   native proposal workflow described below. All prices are chosen by the team.
2. Share `https://nolimitwebs.com/proposal/#plink_...` using the Payment Link's
   **object ID**, not its `buy.stripe.com` URL token. This link is a bearer link:
   anyone it is forwarded to can view the proposal. It exposes no client email,
   address, payment method or other client records.
3. The page reads the deposit price and hosting price directly from Stripe.
   No browser input sets an amount. It shows the 50% deposit, equal launch
   balance and monthly hosting separately.
4. Stripe collects the client's name, business name and email, payment details
   and explicit agreement to the billing authorization. A completed deposit
   closes the single-payment link and creates a paid invoice.
5. A signed Stripe webhook verifies the payment, consent, amounts and saved
   card. It sets the customer's default invoice card, records the Checkout
   Session ID and authorization version, then sets `launch_status=ready`.
6. At launch the team uses the existing **Website launch — final balance and
   monthly hosting** workflow with the paid deposit invoice ID. This charges
   the other half and starts hosting with a 30-day trial/delay, then monthly
   until canceled. Notify the client of launch and first hosting billing date.

Do not use the old deposit-invoice workflow as well for the same project.
Do not run the launch workflow simultaneously or rerun a declined final charge;
resolve the already-created final invoice. The pre-existing launch workflow
uses status markers, not an atomic concurrency lock.

## Cloudflare Pages configuration

The Pages project is connected to this repository with production branch
`main`, no build command, and build output directory `site`. `wrangler.toml`
at the repository root records this plus the `nodejs_compat` compatibility
flag the functions need (`node:crypto`, `node:buffer`). There are no runtime
dependencies. The API uses the pinned Stripe version `2026-08-26.dahlia`.

Add encrypted variables under the Pages project → Settings → Variables and
secrets (never GitHub files or frontend JS):

- `STRIPE_SECRET_KEY`: matching account's server key. Prefer a restricted key
  with read access to Payment Links, Prices, Checkout Sessions, PaymentIntents,
  PaymentMethods and Invoices, and write access to Customers and Invoices.
- `STRIPE_MODE`: `test` for sandbox previews; `live` only for production.
- `STRIPE_WEBHOOK_SECRET`: signing secret of the matching event destination.

Keep test and live secrets in separate Pages environments (Production vs
Preview). Do not set a live key on Preview deployments. The webhook signing
secret is different for each destination. No Supabase or Resend secrets are
needed for this integration.

Create a Stripe snapshot event destination to
`https://<deployment-host>/api/stripe-webhook`, API `2026-08-26.dahlia`, for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Use the stable preview deployment URL for sandbox and `nolimitwebs.com` for live.
The webhook verifies the original request bytes and a five-minute signature
tolerance. Incomplete setup returns 500 so Stripe retries; logs contain only
an event ID. Replays after launch do not reset the launch state or default card.

## Native Stripe proposal workflow

Create a separate on-demand workflow; keep the existing deposit workflow for
manual invoicing. Inputs: project name, full build amount in USD cents,
monthly hosting amount in USD cents. Stripe's native monetary bindings require
Decimal fields. Enter integer cent amounts: $2,000 = 200000 and $99 = 9900.
Minimums are 100000 build cents and 5000 monthly hosting cents. Use whole-dollar
build prices; the website rejects fractional-dollar builds, fractional cents,
and any mismatch between the team's inputs and the generated prices.

1. **Create preview invoice**: currency USD; one invoice item with currency USD,
   unit amount decimal = full build cent input, quantity decimal `0.5`.
   Use the resulting `subtotal_excluding_tax` as the deposit amount. This is a
   calculation preview, not a bill to send.
2. **Create price**: currency USD, unit amount decimal = monthly hosting cent input,
   recurring interval `month`, count 1; product name `Monthly website hosting`.
3. **Create payment link**:
   - one line item, quantity 1; no adjustable quantity;
   - inline price data: USD, **unit amount** = step 1 subtotal excluding tax,
     product data name `Website build — 50% deposit`, no recurring settings;
   - `customer_creation=always`, `payment_method_types[0]=card`;
   - `name_collection[individual][enabled]=true`, business name enabled and optional;
   - `payment_intent_data[setup_future_usage]=off_session`;
   - `restrictions[completed_sessions][limit]=1`;
   - `consent_collection[terms_of_service]=required`;
   - no promotion codes or automatic tax in this approved untaxed workflow;
   - metadata `flow=website_proposal_v1`, `authorization_version=2026-09-09`,
     `project_name=<input>`, `hosting_price_id=<monthly price ID>`,
     `build_total_cents=<input>`, `hosting_monthly_cents=<input>`;
   - `invoice_creation[enabled]=true`; invoice description `Website build — 50% deposit`;
   - invoice metadata `launch_status=awaiting_checkout`, hosting price ID;
   - invoice footer `Thank you for choosing Limitless Marketing Group. nolimitwebs.com | contact@limitlessxcollective.com`;
   - completion redirect `https://nolimitwebs.com/payment-complete/#session_id={CHECKOUT_SESSION_ID}`;
   - custom terms text: “I authorize the deposit shown above, saving my card,
     an equal final build payment when my website goes live, and the monthly
     hosting amount shown in my proposal starting 30 days after launch until
     canceled. Changes require separate approval. Cancel future hosting renewals
     at contact@limitlessxcollective.com before the next renewal. I accept the
     [billing terms](https://nolimitwebs.com/billing-terms/).”

Always send the website proposal URL so the client sees the full build and
hosting prices and personalized authorization before entering Stripe Checkout.
Stripe's native action editor replaces a text field with a single data reference;
it does not concatenate the dynamic amounts into custom terms text. Exact accepted
amounts are captured in Checkout metadata and on the paid invoice by the webhook.

Configure Stripe business Public details Terms URL as
`https://nolimitwebs.com/billing-terms/` before requiring terms acceptance.
Use a sandbox-accessible version of the same page while testing. Preserve the
private legal address, but do not add the home address to public branding.

The custom text and immutable hosting price are part of the client's acceptance.
Do not change the hosting metadata or terms on a link after sharing it: close
that link and issue a new approved proposal. The webhook fails closed if a
checkout's copied hosting price no longer matches its originating link.

Tax treatment is outside this integration. If taxes, discounts, refunds or
credits are introduced, review both proposal and launch calculations before
using these flows; the implementation deliberately rejects mismatched amounts.

## Verification and publication

Run `npm test` (or `node --test tests/billing.test.mjs`) from the repository
root. Coverage: authoritative prices, closed links, incompatible billing
settings, mismatched payments, missing consent, wrong saved cards, retry
behavior and signatures. `npx wrangler pages dev site` runs the site and the
functions locally on the Cloudflare runtime.

Before publishing, verify a real sandbox Checkout Session: client information,
required consent, 50% charge, paid invoice, attached default card, webhook
completion marker, and existing launch workflow producing the other half plus
hosting first billed 30 days later. Repeat the webhook and confirm no reset.
Also check a canceled/unpaid checkout and the mobile proposal layout.

Production publication requires the live environment variables, event
destination, terms URL and tested native proposal workflow. Publishing files
alone does not complete the billing setup.
