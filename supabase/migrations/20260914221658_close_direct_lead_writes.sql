-- Apply after deploying and verifying the protected website form.
begin;
drop policy if exists "anon can submit a lead" on public.portfolio_leads;
revoke all on table public.portfolio_leads from public, anon, authenticated;
grant insert on table public.portfolio_leads to service_role;
notify pgrst, 'reload schema';
commit;
