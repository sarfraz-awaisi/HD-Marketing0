-- Read-only check for update 074 (lead export: one lead file's assigned
-- leads in the Lead pipeline export's columns). Run it in the CRM's
-- Supabase SQL Editor before 074 and right after it. It is one SELECT: it
-- changes nothing and returns counts only, never a customer's details.
-- Before 074: release_stage = 'at 073, ready for 074' and
-- transactions_open_over_1_min = 0.
-- After 074: release_stage = 'at 074' and export_functions = 2.
-- The other counts say what the export can list: lead files, and leads
-- assigned to an agent now with a file or with none.
select
 case
  when to_regprocedure('public.lead_file_export_rows(uuid,uuid[])') is not null then 'at 074'
  when to_regprocedure('public.lead_export_rows(uuid,uuid[])') is not null then 'at 073, ready for 074'
  else 'NOT READY: apply update 073 first'
 end as release_stage,
 (select count(*) from pg_proc where pronamespace='public'::regnamespace and provolatile='v'
  and proname in ('lead_file_export_ids','lead_file_export_rows')) as export_functions,
 (select count(*) from public.sheet_sources) as google_sheets,
 (select count(*) from public.lead_imports where deleted_at is null) as lead_files,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null and import_id is not null) as assigned_leads_with_a_file,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null and import_id is null) as assigned_leads_with_no_file,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
