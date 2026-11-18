-- Read-only check for update 073 (lead export file by file). Run it in the
-- CRM's Supabase SQL Editor before 073 and right after it. It is one
-- SELECT: it changes nothing and returns counts only, never a customer's
-- details.
-- Before 073: release_stage = 'at 072, ready for 073' and
-- transactions_open_over_1_min = 0.
-- After 073: release_stage = 'at 073' and export_functions = 6.
-- The other counts say what the export can tell apart: Google Sheets and
-- other lead files, leads created by a file or with no file, leads whose
-- Sheet row recorded a campaign or ad ID, and leads with only an ad name.
select
 case
  when to_regprocedure('public.lead_export_rows(uuid,uuid[])') is not null then 'at 073'
  when to_regclass('public.kpi_evidence') is not null then 'at 072, ready for 073'
  else 'NOT READY: apply update 072 first'
 end as release_stage,
 (select count(*) from pg_proc where pronamespace='public'::regnamespace and provolatile='v'
  and proname in ('lead_export_sources','lead_export_ids','lead_export_rows','lead_export_calls','lead_export_notes','lead_export_assignments')) as export_functions,
 (select count(*) from public.sheet_sources) as google_sheets,
 (select count(*) from public.lead_imports where file_format<>'sheets' and deleted_at is null) as other_lead_files,
 (select count(*) from public.leads where deleted_at is null and import_id is not null) as leads_from_a_file,
 (select count(*) from public.leads where deleted_at is null and import_id is null) as leads_with_no_file,
 (select count(distinct r.lead_id) from crm_private.sheet_lead_receipts r join crm_private.sheet_lead_inquiries i
   on i.source_id=r.source_id and i.meta_lead_id=r.meta_lead_id join public.leads l on l.id=r.lead_id and l.deleted_at is null
   where r.outcome='created' and (i.campaign_id is not null or i.ad_id is not null)) as leads_with_campaign_or_ad_id,
 (select count(*) from public.leads where deleted_at is null and ad_name is not null) as leads_with_an_ad_name,
 (select count(*) from crm_private.sheet_lead_receipts where outcome='existing') as sheet_repeat_inquiries,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
