# Close billing integration — production connected

This branch implements native Close Custom Activities connected to the existing
Cloudflare Pages billing backend. It is disabled unless `CLOSE_BILLING_ENABLED`
is explicitly `true`. No new customer-facing app or CRM messaging automation is
introduced.

## Daily use after activation

1. Open the client’s Lead in Close and add **Create website proposal**.
2. Enter a short project name, the **full website build price in dollars**, and
   the **monthly hosting price in dollars**. Publish the activity.
3. Wait for **Proposal ready**. Copy its **Proposal link** into your message to
   the client. The integration does not send that message for you.
4. The client reviews the prices on nolimitwebs.com, enters their details in
   Stripe Checkout, accepts the billing authorization, and pays the 50% deposit.
   Their card is saved for subsequent payments. Close changes to **Deposit paid**.
5. When the website is live, add **Website launched** on the same Lead. Copy
   the deposit invoice ID from the proposal activity. Select **Website is live
   and signed billing authorization is on file**, then publish.
6. Stripe attempts the remaining 50% once and creates the monthly hosting
   subscription with its first payment 30 days after that launch action.
   Hosting renews monthly until canceled. Close shows the latest payment state.

Use **Create website proposal** and **Website launched** for real clients.
The separate forms with **(sandbox)** in their names are for tests only. Each proposal activity is one project; multiple projects may
belong to the same Lead. Output fields are optional and filled automatically.

## Native forms

Prepared in Limitless Marketing Group’s Close organization:

| Action | Type ID | Fields |
|---|---|---|
| Create website proposal (sandbox) | `actitype_3qOOp9oevMJIBkip7wtxB2` | Required: Project name, Website build price (USD), Monthly hosting price (USD). Outputs: Billing status, Proposal link, Deposit invoice ID, Final invoice ID, Hosting subscription ID. |
| Website launched (sandbox) | `actitype_2D8JRXmj5iTkVM68605M2n` | Required: Deposit invoice ID, Launch authorization. Output: Billing result. |

Use separate activity type IDs for sandbox and production. Do not point both
webhook subscriptions at the same pair of action types.

## Deployment configuration

Apply `migrations/0001_close_billing.sql` to a new Cloudflare D1 database and bind
it as `CLOSE_BILLING_DB`. Preview and Production **must use separate databases**.
The tables contain project/Stripe IDs, agreed prices, lock state and minimal
Stripe operation receipts. They do not contain card data or API keys.

Server-only secrets:

- `CLOSE_API_KEY`: API key created for this integration. Close API keys inherit
  the creating user’s permissions; they are not limited to these activity types
  by Close. The application itself only reads and updates Custom Activities.
- `CLOSE_WEBHOOK_SECRET`: hexadecimal signing key returned by the webhook
  subscription creation. Never put it in the browser bundle or Git.
- `STRIPE_SECRET_KEY`: restricted key in the matching Stripe test/live account.
  Requires write access for Prices, Products, Payment Links, Customers, Invoices,
  Invoice Items and Subscriptions; read access for Checkout Sessions, Payment
  Intents, Payment Methods and Charges. No refunds or payouts are requested.
- Existing `STRIPE_WEBHOOK_SECRET`: retain the matching endpoint secret.

Non-secret settings:

- `STRIPE_MODE`: `test` in Preview, `live` in Production.
- `CLOSE_BILLING_ENABLED`: leave unset/false until activation is ready.
- `CLOSE_BILLING_CONFIG`: JSON below, filled with real IDs from the account.
  `enabledAfter` prevents accidentally executing pre-existing setup activities.

```json
{
  "mode": "test",
  "organizationId": "orga_REPLACE",
  "subscriptionId": "whsub_REPLACE",
  "proposalType": "actitype_REPLACE",
  "launchType": "actitype_REPLACE",
  "enabledAfter": "REPLACE_WITH_ACTIVATION_TIMESTAMP",
  "proposalFields": {
    "project": "cf_REPLACE", "build": "cf_REPLACE", "hosting": "cf_REPLACE",
    "status": "cf_REPLACE", "link": "cf_REPLACE", "deposit": "cf_REPLACE",
    "final": "cf_REPLACE", "subscription": "cf_REPLACE"
  },
  "launchFields": {
    "invoice": "cf_REPLACE", "authorization": "cf_REPLACE", "result": "cf_REPLACE"
  }
}
```

Create a Close webhook to `/api/close-webhook` on the matching deployment,
subscribing only to `activity.custom_activity` actions `created` and `updated`.
Use an `extra_filter` on `data.custom_activity_type_id` matching that
environment’s two action types. Keep SSL verification enabled. The handler also
checks subscription ID, organization ID, current published status, creation
date, lead ID and action type before processing. It fetches the current activity
instead of trusting stale webhook field values.

Keep the existing Stripe checkout events and add:

- `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`,
  `invoice.voided`, `invoice.marked_uncollectible`
- `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`

## Billing safeguards and recovery

- Dollar amounts are parsed without floating-point rounding. Build prices must
  be whole dollars, at least $1,000; hosting at least $50. Both remain adjustable
  for each new proposal. The deposit is exactly half of the build.
- A published proposal’s title/prices are immutable in the billing ledger.
  To replace a proposal, deactivate its old Payment Link in Stripe before
  creating another activity. Editing the old activity never reprices a link.
- A single project has one D1 lock. Repeated launch activities for the same
  deposit cannot create a second final invoice or hosting subscription.
- Every Stripe write has a stable idempotency key and a persisted operation
  receipt. If a write outcome is unknown for more than 23 hours, processing
  stops for reconciliation rather than risking Stripe’s 24-hour key expiry.
- Close-managed deposits use `close_ready`, `close_processing` and
  `close_completed`. The existing native Stripe launch workflow requires
  `ready`, so it cannot also launch these deposits. Older Stripe-only proposals
  continue through the original workflow.
- Launch verifies the paid invoice, agreement version and amounts, matching
  client, saved card, hosting price, and absence of refunds/disputes/credit
  notes. Customer credit balances require review before collection.
- A declined final payment remains one open invoice. Hosting is still scheduled
  30 days from launch, as agreed. Resolve the existing unpaid invoice in Stripe;
  republishing the activity does not initiate another charge attempt.
- Partial setup and temporary API errors return non-2xx so the webhook provider
  retries. Stripe/D1 writes resume from durable receipts. Explicit validation
  failures appear as **Review required** in the corresponding Close activity.
- If a Close Lead is merged/moved, this version stops with a mismatch instead
  of guessing a new billing owner. An operator must reconcile that project.
- Payment updates re-read current Stripe invoice/subscription state, so old
  webhook deliveries do not turn a paid invoice into an unpaid one.
- Cancellation, refunds, tax changes, discounts, price amendments and retrying
  a declined final balance remain explicit operations in Stripe. This setup
  does not invent authorization for those changes.

## Sandbox connection

The approved sandbox is deployed at https://stripe-sandbox.nolimitwebs.pages.dev.
PR #2 was merged into `stripe-sandbox`, not `main`. Cloudflare Preview has its
own D1 database and server-only credentials, and the two native Close actions
are labeled **(sandbox)**. Production was activated with PR #3, separate production activity types, encrypted
server credentials, live Stripe webhook events, and an isolated D1 database.
Production deployment: af04d4da-7eca-478b-9dcc-c250f998d0d8.
No real client was charged or messaged during activation; full payment lifecycle
validation was performed in Stripe sandbox.

See `CLOSE-SANDBOX-RESULTS.md` for the actual provider test evidence.

## Validation and release gate

Local checks use SQLite with the actual D1 schema/queries plus simulated Close
and Stripe APIs. Run on Node 24 with `npm test`. They do not prove that live
credentials, permissions, provider API versions or webhook routing work.

Before enabling real billing:

1. Deploy the branch with the feature disabled and verify existing checkout.
2. Connect the sandbox key, Close key/signing secret and Preview-only D1 database.
3. Use a fictional Close Lead and Stripe test card for a real provider test:
   create a proposal, pay its deposit, verify saved card and CRM status, publish
   launch, verify one final payment and hosting 30 days later.
4. Replay the same Close/Stripe deliveries and submit a second launch activity;
   verify no duplicate invoice, payment or subscription.
5. Exercise a failed payment and monthly renewal/cancellation status updates.
6. Review the sandbox result before enabling the separately configured live
   action types, key, webhook and database. Keep **(sandbox)** on the test actions.

## Primary references

- [Close Custom Activities](https://help.close.com/feature-guide/custom-activities)
- [Close activity API](https://developer.close.com/api/resources/activities/custom-activities/get)
- [Close event types](https://developer.close.com/api/resources/events/list-of-event-types)
- [Close webhook signatures](https://developer.close.com/api/resources/webhooks)
- [Close webhook filters](https://developer.close.com/api/resources/webhooks/webhook-filters)
- [Stripe Payment Links](https://docs.stripe.com/api/payment-link/create)
- [Stripe invoice collection](https://docs.stripe.com/api/invoices/pay)
- [Stripe subscriptions](https://docs.stripe.com/api/subscriptions/create)
