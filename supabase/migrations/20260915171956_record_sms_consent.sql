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
