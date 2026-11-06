-- Read-only check for update 051 (agents open their own numbers; Today's
-- calling numbers open). Run it in the CRM's Supabase SQL Editor before 051,
-- right after it, and after the code release. It is one SELECT: it changes
-- nothing and returns schema flags and counts only, no customer or account
-- details.
-- Before 051: release_stage = 'at 050, ready for 051' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 051
-- they must be the same (apart from new activity).
-- After 051: release_stage = 'at 051', every *_must_be_0 column 0 and
-- server_functions = 1. Expected values: docs/AGENT_WORK_RELEASE.md.
select
 to_regprocedure('public.report_drilldown(uuid,jsonb)') is not null as update_050_installed,
 to_regprocedure('public.report_today_records(text,uuid)') is not null as update_051_helpers_installed,
 case
  when position('report_today_value' in coalesce(pg_get_functiondef(to_regprocedure('public.report_drilldown(uuid,jsonb)')),''))>0 then 'at 051'
  when to_regprocedure('public.report_drilldown(uuid,jsonb)') is not null then 'at 050, ready for 051'
  else 'NOT READY: apply update 050 first'
 end as release_stage,
 -- Existing records, compared before and after 051.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Accounts that can open their own numbers after 051.
 (select count(*) from public.profiles where active and role='agent') as active_agents,
 -- 051 itself.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row',
   'report_drilldown','report_today_records','report_today_value')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row',
   'report_drilldown','report_today_records','report_today_value')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 -- PostgREST runs stable functions read-only; the API function locks the
 -- signed-in profile, so it must not be stable.
 (select count(*) from pg_proc f where f.oid=to_regprocedure('public.report_drilldown(uuid,jsonb)') and f.provolatile<>'v') as stable_api_function_must_be_0,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
