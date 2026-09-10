-- ============================================================================
-- Supabase schema for the nolimitwebs.com lead capture + email notifier.
--
-- These statements are already applied to the live project
-- (ref sdpmvuedcfepbedntdev, display name "Limitless-Client-Portal").
-- This file exists so the setup can be rebuilt from scratch if that project
-- is ever lost, and so the design is reviewable without digging through the
-- Supabase dashboard.
--
-- Run in this order. Applied 2026-08-19 / 2026-08-20; rebuilt on project sdpmvuedcfepbedntdev 2026-08-31.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. create_portfolio_leads
-- One row per contact-form submission.
-- ----------------------------------------------------------------------------

create table if not exists public.portfolio_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business text default '',
  phone text default '',
  email text default '',
  message text default '',
  source text default 'portfolio',
  created_at timestamptz not null default now(),
  constraint portfolio_leads_name_len check (char_length(name) between 1 and 200),
  constraint portfolio_leads_business_len check (char_length(business) <= 200),
  constraint portfolio_leads_phone_len check (char_length(phone) <= 50),
  constraint portfolio_leads_email_len check (char_length(email) <= 200),
  constraint portfolio_leads_message_len check (char_length(message) <= 4000),
  -- A lead we cannot contact is not a lead.
  constraint portfolio_leads_has_contact check (
    char_length(coalesce(phone, '')) > 0 or char_length(coalesce(email, '')) > 0
  )
);

alter table public.portfolio_leads enable row level security;

-- The site is static, so the publishable key ships in the page. Safety comes
-- from this policy pair: anon may INSERT and nothing else. There is deliberately
-- no SELECT/UPDATE/DELETE policy for anon, so a visitor holding that key can
-- submit a lead but can never read, edit or delete one.
create policy "anon can submit a lead"
  on public.portfolio_leads for insert to anon
  with check (source = 'portfolio');

create policy "authenticated can read leads"
  on public.portfolio_leads for select to authenticated
  using (true);


-- ----------------------------------------------------------------------------
-- 2. grant_portfolio_leads_insert_to_anon
-- RLS policies alone are not enough — Postgres also checks table GRANTs first.
-- Without this, inserts fail with "permission denied for table".
-- ----------------------------------------------------------------------------

grant insert on table public.portfolio_leads to anon;
grant select on table public.portfolio_leads to authenticated;


-- ----------------------------------------------------------------------------
-- 3. lead_notification_settings
-- Private key/value store. Holds the shared secret the database uses to prove
-- to the Edge Function that a webhook call really came from the database.
-- RLS is on with NO policies and the public roles have no grants, so neither
-- anon nor a signed-in user can read it. Only the service role can.
-- ----------------------------------------------------------------------------

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

revoke all on table public.app_settings from anon, authenticated;

-- Generated inside the database so the secret is never typed, pasted or
-- transmitted anywhere.
insert into public.app_settings (key, value)
values ('lead_hook_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- 4. notify_new_lead_trigger
-- Calls the notify-lead Edge Function after each insert.
-- ----------------------------------------------------------------------------

create extension if not exists pg_net;

create or replace function public.notify_new_lead()
returns trigger
language plpgsql
security definer            -- needed to read the hook secret
set search_path = public, net, extensions
as $$
declare
  hook_secret text;
  fn_url text := 'https://sdpmvuedcfepbedntdev.supabase.co/functions/v1/notify-lead';
begin
  select value into hook_secret from public.app_settings where key = 'lead_hook_secret';

  if hook_secret is null then
    raise warning 'notify_new_lead: no lead_hook_secret configured, skipping';
    return new;
  end if;

  -- pg_net queues this asynchronously, so a slow or failing email provider
  -- can never delay or block the visitor's form submission.
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-hook-secret', hook_secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'name', new.name,
        'business', new.business,
        'phone', new.phone,
        'email', new.email,
        'message', new.message,
        'created_at', new.created_at
      )
    ),
    timeout_milliseconds := 8000
  );

  return new;
exception when others then
  -- A broken notifier must never cost us the lead itself.
  raise warning 'notify_new_lead failed: %', sqlerrm;
  return new;
end;
$$;

revoke all on function public.notify_new_lead() from anon, authenticated;

drop trigger if exists on_new_portfolio_lead on public.portfolio_leads;

create trigger on_new_portfolio_lead
after insert on public.portfolio_leads
for each row execute function public.notify_new_lead();


-- ----------------------------------------------------------------------------
-- 5. app_settings_service_role_grant
-- The blanket revoke in step 3 also stripped what service_role inherited, which
-- made the Edge Function unable to read the secret ("Server not configured").
-- Grant it back explicitly. anon and authenticated stay locked out.
-- ----------------------------------------------------------------------------

grant select, insert, update, delete on table public.app_settings to service_role;

notify pgrst, 'reload schema';
