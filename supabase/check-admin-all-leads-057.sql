-- Read-only check for update 057 (administrators' All leads). Run it in the
-- CRM's Supabase SQL Editor before 057 and right after it. It is one SELECT:
-- it changes nothing and returns flags and counts only, no customer or
-- account details.
-- Before 057: release_stage = 'at 056, ready for 057' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 057
-- they must be the same (apart from new activity).
-- After 057: release_stage = 'at 057', browser_function_access_must_be_0 = 0
-- and server_functions = 2.
select
 to_regprocedure('public.lead_ad_inquiries(uuid,uuid)') is not null as update_056_installed,
 case
  when to_regprocedure('public.admin_lead_list(uuid,jsonb)') is not null
   and to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is not null then 'at 057'
  when to_regprocedure('public.lead_ad_inquiries(uuid,uuid)') is not null
   and to_regprocedure('public.assign_leads_bulk(uuid[],uuid,text,uuid,text)') is not null then 'at 056, ready for 057'
  else 'NOT READY: apply update 056 first'
 end as release_stage,
 -- Existing records, compared before and after 057.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null) as assigned_leads,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is null) as unassigned_leads,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.lead_imports) as existing_lead_files,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Only the server may call the new functions; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
