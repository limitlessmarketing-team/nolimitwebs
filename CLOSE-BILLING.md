# Close billing integration — production connected

This branch implements native Close Custom Activities connected to the existing
Cloudflare Pages billing backend. It is disabled unless `CLOSE_BILLING_ENABLED`
is explicitly `true`. No new customer-facing app or CRM messaging automation is
introduced.

## Choose the matching proposal and launch actions

Prices are entered in **dollars**, and each proposal can have different pricing.
Do not enter cents. The chosen action fixes its billing plan; prices and plan
cannot be changed after a proposal is created.

| Proposal / Launch action suffix | Upfront | When launched | Hosting |
|---|---|---|---|
| **50% deposit + hosting** | Half the total build price | Remaining half | First payment 30 days after launch, then monthly |
| **100% upfront + hosting** | Entire build price | No build charge | First payment 30 days after launch, then monthly |
| **Hosting only** | Save card; no charge | First hosting payment | Monthly from launch; build included |
| **Website only — no hosting** | Half the total build price | Remaining half | No subscription |

1. Open the client's Lead in Close. Under **Activity**, choose **Proposal —**
   followed by the agreed payment option. Only relevant prices are shown.
2. Enter the project name and agreed prices, then publish. Leave automatic
   output fields blank.
3. Wait for **Proposal ready** and copy **Proposal link** to your client message.
   Creating the proposal does not send a message or mark it paid.
4. Wait for **Deposit paid**, **Website paid in full**, or **Card saved**.
   Stripe confirms this status; the integration supplies **Launch reference**.
5. Once the website is live and billing authorization is on file, add **Launch —**
   with the **same payment option** on the same Lead. Paste the launch reference,
   confirm authorization, and publish. Read the action's description before
   publishing: it states exactly what will be charged.
6. Check **Billing result** and the original proposal's **Billing status**.
   If a payment fails or needs bank verification, recover the existing invoice
   in Stripe. Do not create another proposal or subscription to retry it.

Wrong-path launch actions are rejected before Stripe writes. Duplicate events
and retried launches reuse stored operations. Hosting continues monthly until
canceled in Stripe. Bank authentication or declines can prevent collection.

Forms prefixed **(sandbox)** are test-only. The legacy proposal is hidden from
new manual creation after activation; **Legacy launch — existing proposals only**
remains available for older proposals. Older project records retain their
original prices and 50% payment behavior.

## Configure new forms

`tools/billing-paths.json` defines the four names and descriptions.
`tools/configure-close-paths.py prepare test|live` creates API-only forms with
permissions copied from their existing counterparts. It exports only non-secret
IDs. Add the resulting `paths` to the appropriate `wrangler.toml` configuration,
deploy and verify, then run `activate` for that environment. Activation expands
only the existing webhook's activity-type filter and exposes the new forms.
The old types stay routable for existing proposals. Use a temporary API key,
entered via a masked prompt; revoke it after configuration.

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
  Invoice Items, Subscriptions and Checkout Sessions; read access for Setup
  Intents, Payment Intents, Payment Methods and Charges. No refunds or payouts are requested.
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
    "paymentPlan": "cf_REPLACE", "project": "cf_REPLACE", "build": "cf_REPLACE", "hosting": "cf_REPLACE",
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
  be whole dollars. A positive build uses the deposit path (hosting may be $0).
  A $0 build uses hosting-only and requires a positive monthly hosting price.
  There are no business pricing floors. Stripe payment processing limits still apply.
  Both remain adjustable for each new proposal. The deposit is exactly half of the build.
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

## Missing Close records

If a proposal activity or its parent lead is deleted after billing starts, a
Close API 404 during a status read/update stores `closeSync.status = record_missing`
on the billing project. Subsequent Stripe notifications retain the latest billing
status in that project without calling the missing Close activity. The integration
does not cancel, recreate, or modify the Stripe subscription as part of this check.
Other errors (including authorization failures, rate limits and outages) still retry.

This is an internal review flag and a one-time server warning, not an email or CRM
notification. Admins can find affected projects in the matching environment's D1:

```sql
SELECT id, lead_id, json_extract(state, '$.subscriptionId') AS subscription_id,
       json_extract(state, '$.closeSync.detectedAt') AS detected_at,
       json_extract(state, '$.closeSync.lastBillingStatus') AS billing_status
FROM close_billing_projects
WHERE json_extract(state, '$.closeSync.status') = 'record_missing';
```

A 404 means the record could not be found; it is not proof of why it disappeared.
Do not create another subscription to reconnect it. First review the existing
Stripe customer/subscription. If restoring Close, verify the original activity ID,
lead, organization, activity type and agreed prices. Only then may an administrator
clear the `closeSync` flag in the project state so the next payment notification
can update the restored activity. A new lead has a different identity and requires
an explicit reconciliation. A flagged project cannot trigger a new launch charge.

## Optional domain registration and annual billing

Each of the four proposal actions can include **Domain name (optional)** and
**Domain price (USD/year)**. Enter the domain only (example.com) and the dollar
amount. Leave both blank for clients who supply their own domain. The annual
amount must be at least Stripe's $0.50 USD collection minimum.

The initial invoice lists domain registration separately, paid in full upfront.
A 50% website deposit applies only to the website build. Domain registration is
never charged again at launch. For hosting-only projects with a domain, checkout
collects the domain payment and saves the card; hosting still starts at launch.

After a verified successful payment, a separate annual domain subscription is
created with its first renewal one calendar year after the invoice payment time.
The amount stays the same. February 29 renewals use February 28 in non-leap years.
No proration or additional domain charge is created during setup. The proposal,
Stripe checkout authorization, invoice description and confirmation explain this.

Launch uses the same proposal reference; there is no second domain-price input.
**Domain renewal subscription** identifies the separate Stripe subscription.
Hosting cancellation does not cancel domains, and domain cancellation does not
cancel hosting. Reps should request the intended cancellation from an admin.

Stripe collects payment only. Purchase and actual renewal with the registrar,
registrant ownership, renewal failure handling, and any transfers must still be
managed separately. Existing proposals and subscriptions are not retroactively
charged for domains. To change pricing, retire the old link and issue a new
proposal for the client's approval.

Rollout: deploy code to sandbox, run tools/configure-domain-fields.py test with an
approved temporary Close key, apply the resulting test route configuration,
verify all four paths with sandbox payments and renewals, then repeat the field
configuration for live and deploy. Revoke the temporary key afterward.

## Withdraw an incorrect unpaid proposal

On the same lead, choose **3. Cancel proposal — unpaid only** (or its **(sandbox)** equivalent).
Paste the old **Proposal link** into **Proposal link to cancel**. In **Confirm cancellation**, enter:
`Cancel this unpaid proposal and disable its checkout`
Leave **Cancellation result** blank and publish the activity. Wait for **Proposal canceled — old link and open checkouts disabled** before creating and sharing a replacement proposal.

The action works across all four billing paths, including optional domain charges. It disables that proposal's payment link and expires open Stripe checkouts. It never refunds payments, deletes customers, or cancels hosting/domain subscriptions. Already accepted proposals are refused; a checkout completed during cancellation is flagged for Stripe review. Do not delete the original proposal as a substitute for this action. Cancellation is permanent for that proposal; create a new one to offer corrected terms.
