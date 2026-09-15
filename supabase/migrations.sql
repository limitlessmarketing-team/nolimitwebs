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

-- All lead writes go through the server-verified submit-lead function.
-- Public and ordinary authenticated roles have no direct table access.
drop policy if exists "anon can submit a lead" on public.portfolio_leads;
revoke all on table public.portfolio_leads from public, anon, authenticated;

-- Lead contents are server-only; signing in does not grant team access.
drop policy if exists "authenticated can read leads" on public.portfolio_leads;


-- ----------------------------------------------------------------------------
-- 2. grant_portfolio_leads_insert_to_service_role
-- RLS policies alone are not enough — Postgres also checks table GRANTs first.
-- Without this, inserts fail with "permission denied for table".
-- ----------------------------------------------------------------------------

grant insert on table public.portfolio_leads to service_role;
revoke select on table public.portfolio_leads from anon, authenticated;


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


-- SMS consent records: keep clean rebuilds consistent with the live schema.
begin;
alter table public.portfolio_leads add column if not exists sms_consent jsonb;
comment on column public.portfolio_leads.sms_consent is 'Historical website SMS consent evidence; NULL means no recorded proof. Does not override later STOP/opt-outs.';
alter table public.portfolio_leads add constraint portfolio_leads_sms_consent_shape check (
 sms_consent is null or coalesce((
 jsonb_typeof(sms_consent) = 'object'
 and jsonb_typeof(sms_consent->'opted_in') = 'boolean'
 and sms_consent ? 'recorded_at'
 and (sms_consent->>'opted_in' = 'false' or (
  length(coalesce(phone,'')) > 0
  and sms_consent->>'phone' = phone
  and sms_consent->>'disclosure_version' = '2026-09-15-v1'
  and sms_consent->>'method' = 'website_checkbox'
  and length(coalesce(sms_consent->>'disclosure_text','')) > 40
 ))
 ), false));
create or replace function public.submit_verified_lead(lead_data jsonb, contact_hash text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  bucket_name text;
  window_time timestamptz;
  max_hits integer;
  updated_hits integer;
begin
  if contact_hash is null or contact_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid contact hash';
  end if;
  -- Only service_role can execute this function. It receives no SQL or table names.
  -- Remove counters older than two days on each request; contact identifiers are hashed.
  delete from public.lead_intake_limits where window_start < now() - interval '2 days';
  for bucket_name, window_time, max_hits in
    select 'contact:' || contact_hash, date_trunc('hour', now()), 3
    union all select 'global-hour', date_trunc('hour', now()), 60
    union all select 'global-day', date_trunc('day', now()), 300
  loop
    updated_hits := null;
    insert into public.lead_intake_limits as limits(bucket, window_start, hits)
      values (bucket_name, window_time, 1)
      on conflict (bucket, window_start) do update set hits = limits.hits + 1
      where limits.hits < max_hits
      returning hits into updated_hits;
    if updated_hits is null then return false; end if;
  end loop;
  insert into public.portfolio_leads(name,business,phone,email,message,source,sms_consent)
    values (lead_data->>'name',coalesce(lead_data->>'business',''),coalesce(lead_data->>'phone',''),
      coalesce(lead_data->>'email',''),coalesce(lead_data->>'message',''),'portfolio',
      case when jsonb_typeof(lead_data->'sms_consent') = 'object' then
        jsonb_set(lead_data->'sms_consent', '{recorded_at}', to_jsonb(now())) else null end);
  return true;
end;
$$;
revoke all on function public.submit_verified_lead(jsonb,text) from public, anon, authenticated;
grant execute on function public.submit_verified_lead(jsonb,text) to service_role;
grant insert on table public.portfolio_leads to service_role;
drop policy if exists "authenticated can read leads" on public.portfolio_leads;
revoke select on table public.portfolio_leads from anon, authenticated;
notify pgrst, 'reload schema';
commit;
