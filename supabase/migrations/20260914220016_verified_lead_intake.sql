begin;
create table if not exists public.lead_intake_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null check (hits > 0),
  primary key (bucket, window_start)
);
alter table public.lead_intake_limits enable row level security;
revoke all on table public.lead_intake_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.lead_intake_limits to service_role;

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
  insert into public.portfolio_leads(name,business,phone,email,message,source)
    values (lead_data->>'name',coalesce(lead_data->>'business',''),coalesce(lead_data->>'phone',''),
      coalesce(lead_data->>'email',''),coalesce(lead_data->>'message',''),'portfolio');
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
-- Close anonymous INSERT only after the verified endpoint and new frontend pass live checks.
