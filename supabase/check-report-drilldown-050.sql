-- Read-only check for update 050 (report drill-down). Run it in the CRM's
-- Supabase SQL Editor before 050, right after it, and after the code
-- release. It is one SELECT: it changes nothing and returns schema flags and
-- counts only, no customer or account details.
-- Before 050: release_stage = 'at 048 or 049, ready for 050' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 050
-- they must be the same (apart from new activity).
-- After 050: release_stage = 'at 050', activity_index = 1, every *_must_be_0
-- column 0 and server_functions = 1. Expected values:
-- docs/REPORT_DRILLDOWN_RELEASE.md.
select
 current_setting('server_version') as postgres_version,
 to_regclass('public.shift_schedules') is not null as update_048_installed,
 to_regclass('public.dealers') is not null as update_049_installed,
 to_regprocedure('public.report_drilldown(uuid,jsonb)') is not null as update_050_installed,
 case
  when to_regprocedure('public.report_drilldown(uuid,jsonb)') is not null then 'at 050'
  when to_regclass('public.shift_schedules') is not null then 'at 048 or 049, ready for 050'
  else 'NOT READY: apply the earlier updates first'
 end as release_stage,
 -- Existing records, compared before and after 050.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.visits) as existing_visits,
 (select count(*) from public.deals) as existing_deals,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.lead_status_history) as existing_stage_changes,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- The entries the new audit_log index covers (its size and build time).
 (select count(*) from public.audit_log where entity in ('calls','visits','deals','followups')) as activity_audit_entries,
 -- Calls whose caller the audit log does not record: shown as "Caller not
 -- recorded" in the drill-down.
 (select count(*) from public.calls c where not exists(select 1 from public.audit_log a
   where a.entity='calls' and a.entity_id=c.id::text and a.action in ('create','call.manual_logged'))) as calls_without_recorded_caller,
 -- 050 itself.
 (select count(*) from pg_indexes where schemaname='public' and indexname='audit_log_activity_records') as activity_index,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row','report_drilldown')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row','report_drilldown')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 -- PostgREST runs stable functions read-only; the API function locks the
 -- administrator's profile, so it must not be stable.
 (select count(*) from pg_proc f where f.oid=to_regprocedure('public.report_drilldown(uuid,jsonb)') and f.provolatile<>'v') as stable_api_function_must_be_0,
 -- Long transactions would hold up the index build.
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
