-- Read-only check for update 049 (dealer affiliate network). Run it in the
-- CRM's Supabase SQL Editor before 049, right after it, and after the code
-- release. It is one SELECT: it changes nothing and returns schema flags and
-- row counts only, no customer, dealer or account details.
-- Before 049: release_stage = 'at 048, ready for 049'. Note the existing_*
-- counts; after 049 they must be the same (apart from new activity).
-- After 049: release_stage = 'at 049', every *_must_be_0 column 0, and
-- dealer_api_functions = 8. Expected values: docs/DEALER_NETWORK_RELEASE.md.
select
 current_setting('server_version') as postgres_version,
 to_regclass('public.shift_schedules') is not null as update_048_installed,
 to_regclass('public.dealers') is not null as update_049_installed,
 case
  when to_regclass('public.dealers') is not null then 'at 049'
  when to_regclass('public.shift_schedules') is not null then 'at 048, ready for 049'
  else 'NOT READY: apply the earlier updates first'
 end as release_stage,
 -- Existing records, compared before and after 049.
 (select count(*) from public.profiles) as existing_profiles,
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.properties) as existing_properties,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- 049 itself (null before it is installed).
 case when to_regclass('public.dealers') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.dealers',false,true,'')))[1]::text::bigint end as dealers,
 case when to_regclass('public.dealers') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.dealers where status=''pending'' and deleted_at is null',false,true,'')))[1]::text::bigint end as dealers_pending,
 (select relrowsecurity from pg_class where oid=to_regclass('public.dealers')) as dealers_rls_enabled,
 case when to_regclass('public.dealers') is not null then
  (select count(*) from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p
   where has_table_privilege(r,'public.dealers',p)) end as browser_table_privileges_must_be_0,
 (select count(*) from pg_proc f join pg_namespace n on n.oid=f.pronamespace
  where n.nspname='public' and f.proname like 'dealer%'
   and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f join pg_namespace n on n.oid=f.pronamespace
  where n.nspname='public' and f.proname like 'dealer%' and has_function_privilege('service_role',f.oid,'execute')) as dealer_api_functions,
 -- PostgREST runs stable functions read-only; the API functions must not be.
 (select count(*) from pg_proc f join pg_namespace n on n.oid=f.pronamespace
  where n.nspname='public' and f.proname like 'dealer%' and has_function_privilege('service_role',f.oid,'execute')
   and f.provolatile<>'v') as stable_api_functions_must_be_0,
 (select count(*) from pg_indexes where schemaname='public' and indexname in
  ('dealers_client_key','dealers_owner_phone','dealers_owner_created','dealers_status_created','dealers_phone','audit_log_dealers')) as dealer_indexes_expected_6,
 (select count(*) from public.audit_log where entity='dealers') as dealer_audit_entries;
