# Supabase backend — lead capture and email alerts

This folder is a **backup and reference copy**. The live versions of these run
inside Supabase, not from this repo. Nothing here deploys automatically.

## What this does

1. Someone fills out the contact form on nolimitwebs.com.
2. Their browser posts straight to Supabase using the publishable key that ships
   in the page, and a row is saved in `public.portfolio_leads`.
3. Saving that row trips a database trigger (`on_new_portfolio_lead`).
4. The trigger calls the `notify-lead` Edge Function, passing a shared secret so
   the function knows the call really came from the database.
5. The function formats the lead and sends it through Resend to
   contact@nolimitwebs.com, from leads@send.nolimitwebs.com.

Typical end-to-end time: under ten seconds.

## Files

| File | What it is | Where it actually lives |
| --- | --- | --- |
| `migrations.sql` | Every schema change, in order | Supabase → Database |
| `notify-lead.function.ts` | The Edge Function that sends the email | Supabase → Edge Functions → `notify-lead` |

## Why the publishable key in the website is safe

It grants INSERT on `portfolio_leads` and nothing else. There is no SELECT,
UPDATE or DELETE policy or grant for the `anon` role, so someone who copies the
key out of the page source can submit a lead but cannot read, change or delete
your lead list. This was verified against the live database — requesting the
leads with that key returns `permission denied`.

## Secrets (set in the Supabase dashboard, never in this repo)

Supabase → Edge Functions → Secrets:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | Resend sending key, named "Limitless Mockup Form" |
| `LEAD_NOTIFY_TO` | contact@nolimitwebs.com |
| `LEAD_NOTIFY_FROM` | `Limitless Leads <leads@send.nolimitwebs.com>` |

The shared secret between the trigger and the function is **not** a dashboard
secret — it is generated inside the database and stored in `public.app_settings`,
readable only by the service role.

## If you ever have to rebuild this

1. Create a Supabase project.
2. Run `migrations.sql` in the SQL editor, top to bottom.
3. Deploy `notify-lead.function.ts` as an Edge Function named `notify-lead`,
   with JWT verification **off** (it authenticates itself with the shared secret).
4. Add the three secrets above.
5. Update `fn_url` in `migrations.sql` and `leadCapture` in `site.config.ts` to
   point at the new project ref, then redeploy the site.

## Health monitoring

A scheduled task runs Mondays and Thursdays. It queries the leads table — which
doubles as the keep-alive that stops Supabase from pausing this free-tier project
— then checks the site is up and the trigger is still enabled, and pushes an
alert if anything is broken.
