-- Read-only check for update 064 (phone numbers from any country in the
-- Google Sheets import). Run it in the CRM's Supabase SQL Editor before 064
-- and right after it. It is one SELECT: it changes nothing and returns flags
-- and counts only, no customer or account details.
-- Before 064: release_stage = 'at 063, ready for 064' and
-- transactions_open_over_1_min = 0. Note the counts; after 064 they must be
-- the same (apart from new activity).
-- After 064: release_stage = 'at 064', new_reasons_accepted = true and
-- browser_function_access_must_be_0 = 0.
select
 case
  when exists(select 1 from pg_constraint where conrelid=to_regclass('crm_private.sheet_row_rejections')
   and conname='sheet_row_rejections_reason_check' and pg_get_constraintdef(oid) like '%phone_needs_country%') then 'at 064'
  when to_regprocedure('public.report_team(uuid,timestamptz,timestamptz)') is not null then 'at 063, ready for 064'
  else 'NOT READY: apply update 063 first'
 end as release_stage,
 -- Existing records, compared before and after 064.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from crm_private.lead_phones) as lead_numbers,
 (select count(*) from crm_private.sheet_lead_receipts) as sheet_rows_imported,
 (select count(*) from crm_private.sheet_lead_inquiries) as sheet_inquiries,
 (select count(*) from crm_private.sheet_row_rejections) as sheet_rows_rejected,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- How the stored numbers are written (none is changed by 064).
 (select count(*) from crm_private.lead_phones where phone like '+92%') as pakistani_numbers,
 (select count(*) from crm_private.lead_phones where phone !~ '^\+92') as other_country_numbers,
 -- Written with the 0 after +92 (+920300…): an older form the import's
 -- +92300… does not match, so such a lead is not found as a repeat inquiry.
 (select count(*) from crm_private.lead_phones where phone ~ '^\+920') as numbers_with_0_after_92,
 (select count(*) from crm_private.lead_phones where phone !~ '^\+[1-9][0-9]{9,14}$') as numbers_not_in_e164_form,
 (select count(*) from crm_private.sheet_row_rejections where reason in ('phone_invalid','phone_missing','phone_needs_country')) as phone_rejections_now,
 -- The import records the two new reasons after 064.
 coalesce(position('phone_needs_country' in pg_get_functiondef(to_regprocedure('public.sheet_sync_import(text,uuid,jsonb,text)')))>0,false) as new_reasons_accepted,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('sheet_sync_import','sheet_sync_pending','sheet_sync_owner')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
