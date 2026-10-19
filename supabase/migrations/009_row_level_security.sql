-- Browser roles have no direct CRM grants: API enforces role and ownership.
-- In particular, the phone vault and recordings are never exposed in public REST.
do $$ declare t text; begin foreach t in array array['profiles','leads','assignments','notes','calls','properties','property_photos','targets','followups','visits','reminders','deals','audit_log','integration_events'] loop execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated',t); end loop; end $$;
revoke all on all tables in schema crm_private from public,anon,authenticated;
grant all on all tables in schema public,crm_private to service_role;
grant usage,select on all sequences in schema public to service_role;
-- No browser storage policies. Only authorized server routes issue signed URLs.
create function public.private_phone(p_lead uuid) returns text language sql security definer set search_path='' as $$ select phone from crm_private.lead_phones where lead_id=p_lead $$;
revoke all on function public.private_phone(uuid) from public,anon,authenticated;
grant execute on function public.private_phone(uuid) to service_role;
