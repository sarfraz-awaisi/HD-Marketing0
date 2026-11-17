-- Read-only check for update 069 (Delete instantly; 14 days to restore).
-- Run it in the CRM's Supabase SQL Editor before 069 and right after it. It
-- is one SELECT: it changes nothing and returns flags and counts only, no
-- customer details.
-- Before 069: release_stage = 'at 068, ready for 069' and
-- transactions_open_over_1_min = 0. bin_14_to_30_days is how many deleted
-- leads can no longer be restored once 069 is applied.
-- After 069: release_stage = 'at 069'; every count is the same (069 erases
-- nothing by itself).
select
 case
  when to_regprocedure('public.erase_deleted_leads(uuid[],uuid,text)') is not null then 'at 069'
  when exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='leads' and column_name='ad_name') then 'at 068, ready for 069'
  else 'NOT READY: apply update 068 first'
 end as release_stage,
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 -- Deleted leads by how long ago they were deleted.
 (select count(*) from public.leads where deleted_at is not null) as leads_in_deleted_leads,
 (select count(*) from public.leads where deleted_at>now()-interval '14 days') as bin_under_14_days,
 (select count(*) from public.leads where deleted_at<=now()-interval '14 days'
   and deleted_at>now()-interval '30 days') as bin_14_to_30_days,
 -- Past 30 days: only the background job erases them, and it is not running.
 (select count(*) from public.leads where deleted_at<=now()-interval '30 days') as bin_over_30_days,
 (select count(*) from public.lead_imports where deleted_at is not null and delete_mode='file_and_leads') as deleted_files_with_leads,
 (select max(last_run_at) from crm_private.lead_purge_runs) as daily_erasure_last_run,
 (select count(*) from public.audit_log where action in ('lead.erased','lead.file_erased')) as deleted_instantly,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
