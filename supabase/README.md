# Quote form backend

The website submits to the `submit-lead` Edge Function. It verifies a single-use Cloudflare Turnstile token, checks its hostname and action, validates bounded input, and invokes a service-role-only database function. The database allows three submissions per normalized contact per hour, 60 globally per hour, and 300 globally per day. Limits use hashed contact identifiers; counters older than two days are removed on the next request.

`nolimitwebs.com` and `www.nolimitwebs.com` save verified requests. The `stripe-sandbox.nolimitwebs.pages.dev` origin verifies requests but never saves production leads or sends notifications.

## Deployment

Supabase functions and SQL are deployed separately from Cloudflare Pages. A GitHub merge does not deploy this backend automatically.

1. For a new database, apply `migrations.sql`, then the dated files in `migrations/` in filename order.
2. Configure `TURNSTILE_SECRET_KEY` in Supabase Edge Function secrets. It must never be placed in the repository or website assets. The public site key belongs in `site/site.js`.
3. Deploy `functions/submit-lead/` using the configuration in `config.toml`. The public endpoint performs its own Turnstile verification. It has no endpoint for reading leads.
4. Preserve the existing `notify-lead` function and its database trigger. Its secrets are `RESEND_API_KEY`, `LEAD_NOTIFY_FROM`, and `LEAD_NOTIFY_TO`. It authenticates database notifications using the private `app_settings` hook secret.
5. Deploy the website and verify a normal request before applying the migration that closes direct anonymous inserts. Old cached forms must reload after this cutover.

Anonymous and ordinary authenticated users must have no direct access to the lead table or the rate-limit RPC. Signing up to Supabase does not make someone an authorized team member. Service-role keys stay on the server; they must not be shared with sales reps or client websites.

## Verification

Run `node --test tests/*.test.mjs` at the repository root. Live checks must also verify normal submissions, invalid/missing token rejection, database permission denial, and rate limits. Automated unit tests use mocks and are not a substitute for these live checks.

For a database rate-limit test, use a transaction and roll it back; pg_net notifications are not sent until commit. Never use real customer details in tests.

## Operational limits

Turnstile and submission limits reduce abuse but do not eliminate all spam or denial-of-service risk. Origin checks alone are not authentication. If verification or the database is unavailable, the form fails closed and shows the public phone and support email.

Backups and restore procedures should be tested independently. Do not assume a monitoring schedule or backup policy exists based only on this document.
