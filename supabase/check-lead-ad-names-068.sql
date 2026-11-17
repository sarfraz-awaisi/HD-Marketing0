-- Read-only check for update 068 (each lead keeps the name of the
-- advertisement it came from). Run it in the CRM's Supabase SQL Editor
-- before 068 and right after it. It is one SELECT: it changes nothing and
-- returns flags and counts only, no customer details.
-- Before 068: release_stage = 'at 067, ready for 068' and
-- transactions_open_over_1_min = 0; leads_with_ad_name is 0.
-- After 068: release_stage = 'at 068', and leads_with_ad_name =
-- sheet_leads_with_ad_name (the leads a Google Sheet brought in that
-- name an advertisement). Every other count is the same.
select
 case
  when exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='leads' and column_name='ad_name')
   and position('''ad_name'',o.ad_name' in
    pg_get_functiondef(to_regprocedure('public.agent_lead_list(uuid,jsonb)')))>0 then 'at 068'
  when position('followup.reassignment_cancelled' in
   pg_get_functiondef(to_regprocedure('public.handover_lead(uuid,uuid,uuid,text)')))>0 then 'at 067, ready for 068'
  else 'NOT READY: apply update 067 first'
 end as release_stage,
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and source='CSV') as file_leads,
 -- Google Sheets: how many there are and are on, and what they brought in.
 (select count(*) from public.sheet_sources) as sheets,
 (select count(*) from public.sheet_sources where enabled) as sheets_on,
 (select count(*) from crm_private.sheet_lead_inquiries) as sheet_inquiries,
 (select count(*) from crm_private.sheet_lead_inquiries
  where nullif(btrim(ad_name),'') is not null) as sheet_inquiries_with_ad_name,
 (select count(distinct lead_id) from crm_private.sheet_lead_inquiries
  where nullif(btrim(ad_name),'') is not null) as sheet_leads_with_ad_name,
 -- Read through to_jsonb, so the check also runs before 068.
 (select count(*) from public.leads l where to_jsonb(l)->>'ad_name' is not null) as leads_with_ad_name,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
