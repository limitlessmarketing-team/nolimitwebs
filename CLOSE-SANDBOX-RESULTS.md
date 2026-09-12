# Close → Stripe sandbox test results

Tested September 11, 2026 (America/Denver), September 12 UTC. The tests used
actual Close actions, Stripe sandbox payments and signed provider webhooks,
served by Cloudflare Pages Preview. No real payments or client messages were sent.

## Result

The proposal, deposit, launch, monthly collection, failed-payment, and cancellation
status paths passed. The integration is available only through the **(sandbox)** Close actions.
Production activation is a separate remaining step.

| Check | Observed result |
|---|---|
| Adjustable prices entered in Close | $3,000 total website build and $149 monthly hosting entered in dollars. Proposal displayed $1,500 deposit, $1,500 final balance, and $149 hosting. |
| Client Checkout | Client name/business fields and billing authorization displayed; fictional client paid $1,500 using Stripe's 4242 test card. |
| Save card | The successful deposit's payment method became the customer's default card. |
| Deposit notification | Actual Stripe webhook updated the Close proposal to Deposit paid. |
| Launch | Publishing Website launched charged the saved test card $1,500 and created one hosting subscription. |
| Delay | Subscription created September 12 at 01:11:35 UTC with trial ending October 12 at 01:11:35 UTC: exactly 30 days. |
| Duplicate launch | A second published launch returned the same final invoice and subscription. D1 recorded one final-pay and one hosting-subscription operation. Stripe showed two build payments total. |
| First monthly hosting payment | Advancing the Stripe test clock beyond the trial and invoice processing window generated and paid $149 automatically. Close showed “Final balance paid. Hosting active — latest invoice paid.” |
| Failed renewal | Changed only the fictional subscription to Stripe's decline-after-attach test card, then advanced to November 12. The next $149 invoice failed; Stripe showed Past due/Retrying. Close showed “Final balance paid. Hosting past_due — latest invoice open, payment needs attention.” |

| Cancellation | Canceled the fictional subscription immediately without a refund. Stripe showed Canceled / No future invoices; Close showed “Final balance paid. Hosting canceled — latest invoice open, payment needs attention.” The unpaid test invoice remains as evidence. |

## Provider evidence

- [Fictional Close Lead](https://app.close.com/lead/lead_y9CSrgUelcDwlxvZDVedGhsLTUcroUWZWv8OhbSlXM2/): **SANDBOX — Billing QA — Not a sales prospect**. No email or phone on the Close contact.
- [Stripe test customer](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/customers/cus_VF9m9ZKfRgmIXy): **Sandbox Billing QA**, using billing-qa@example.com.
- [Deposit invoice](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/invoices/in_1UEfSfFQvnqRSMf7of0jHGuk): 5APKVFEH-0001, $1,500 paid.
- [Final invoice](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/invoices/in_1UEfTZFQvnqRSMf7OI3S9ean): 5APKVFEH-0002, $1,500 paid.
- [Hosting subscription](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/subscriptions/sub_1UEfTeFQvnqRSMf75rGrWCEm).
- [First hosting invoice](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/invoices/in_1UEfYGFQvnqRSMf7ORxxbmj1): 5APKVFEH-0004, $149 paid.
- [Failed renewal invoice](https://dashboard.stripe.com/acct_1UDajwFQvnqRSMf7/test/invoices/in_1UEfbvFQvnqRSMf723MTWB1N): 5APKVFEH-0005, $149 unpaid at failure check.
- [Sandbox PR #2](https://github.com/limitlessmarketing-team/nolimitwebs/pull/2) merged only into `stripe-sandbox`. Tested deployment `ae54534c-42f7-4bc4-b55c-50f030fd77e9`.

## Additional validation and limits

- All 47 local tests passed, including signature checks, actual D1 SQL/SQLite,
  duplicate delivery, concurrent locking, refunds/disputes, authorization and
  amount mismatches, provider failures, and uncertain Stripe-write recovery.
- Cloudflare Pages Functions compilation passed.
- Live keys, live webhook routing, and production D1 have not been connected for
  Close billing. These sandbox results do not validate the future live setup.
- The existing Stripe-only production flow has not been modified by this release.
- The application sets no hosting end date; the Stripe subscription editor showed
  **Forever**. The sandbox's separate auto-cancellation date is Stripe's
  [90-day test data retention policy](https://support.stripe.com/questions/data-retention-policy-for-test-subscriptions).
- Test failures used Stripe's documented [decline-after-attach card](https://docs.stripe.com/billing/testing).
