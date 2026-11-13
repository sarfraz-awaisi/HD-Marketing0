-- Read-only check for update 063 (team reports and dashboard numbers). Run
-- it in the CRM's Supabase SQL Editor before 063 and right after it. It is
-- one SELECT: it changes nothing and returns flags and counts only, no
-- customer or account details.
-- Before 063: release_stage = 'at 062, ready for 063' and
-- transactions_open_over_1_min = 0. Note the counts; after 063 they must be
-- the same (apart from new activity).
-- After 063: release_stage = 'at 063', browser_function_access_must_be_0 = 0
-- and server_functions = 3.
select
 case
  when to_regprocedure('public.report_team(uuid,timestamptz,timestamptz)') is not null then 'at 063'
  when to_regprocedure('public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text)') is not null then 'at 062, ready for 063'
  else 'NOT READY: apply update 062 first'
 end as release_stage,
 -- Existing records, compared before and after 063.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and status not in ('won','lost')) as open_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.assignments where missed_at is not null) as existing_missed_stamps,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('lead_not_connected','report_team_records','report_team','report_team_days','report_team_drilldown',
   'call_activity','crm_metrics','record_first_call')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('report_team','report_team_days','report_team_drilldown')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
