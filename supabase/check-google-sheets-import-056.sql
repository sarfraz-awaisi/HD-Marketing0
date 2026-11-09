-- Read-only check for update 056 (Google Sheets lead import). Run it in the
-- CRM's Supabase SQL Editor before 056 and right after it. It is one SELECT:
-- it changes nothing and returns flags and counts only, no customer or
-- account details.
-- Before 056: release_stage = 'at 055, ready for 056' and
-- transactions_open_over_1_min = 0. Note the existing_* counts and
-- lead_file_formats; after 056 they must be the same (apart from new
-- activity).
-- After 056: release_stage = 'at 056', every *_must_be_0 column 0,
-- server_functions = 12, sheets_file_type_allowed and
-- inquiry_notifications_allowed true, and sheets_turned_on,
-- histories_confirmed and active_keys 0 until the owner turns the import on.
select
 to_regprocedure('public.agent_pipeline_attribution(uuid,uuid[])') is not null as update_055_installed,
 case
  when to_regclass('public.sheet_sources') is not null and to_regclass('crm_private.sheet_lead_receipts') is not null
   and to_regclass('crm_private.sheet_lead_inquiries') is not null and to_regclass('crm_private.sheet_row_rejections') is not null
   and to_regclass('crm_private.sheet_sync_keys') is not null
   and to_regprocedure('public.sheet_sync_import(text,uuid,jsonb,text)') is not null
   and to_regprocedure('public.lead_ad_inquiries(uuid,uuid)') is not null then 'at 056'
  when to_regprocedure('public.agent_pipeline_attribution(uuid,uuid[])') is not null then 'at 055, ready for 056'
  else 'NOT READY: apply update 055 first'
 end as release_stage,
 -- Existing records, compared before and after 056.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.lead_imports) as existing_lead_files,
 (select jsonb_object_agg(file_format,n) from (select file_format,count(*) n from public.lead_imports group by 1) f) as lead_file_formats,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- 056's lead-file type.
 coalesce((select pg_get_constraintdef(oid) like '%sheets%' from pg_constraint where conname='lead_imports_file_format_check'
  and conrelid='public.lead_imports'::regclass),false) as sheets_file_type_allowed,
 -- 056's notice to an agent about a customer's repeat inquiry.
 coalesce((select pg_get_constraintdef(oid) like '%ad_inquiry%' from pg_constraint where conname='notifications_type_check'
  and conrelid='public.notifications'::regclass),false) as inquiry_notifications_allowed,
 (select count(*) from public.notifications) as existing_notifications,
 -- The import starts off: no Sheet turned on, no historical import confirmed
 -- and no key until the owner sets it up (null before 056).
 case when to_regclass('public.sheet_sources') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.sheet_sources',false,true,'')))[1]::text::int end as sheets_configured,
 case when to_regclass('public.sheet_sources') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.sheet_sources where enabled',false,true,'')))[1]::text::int end as sheets_turned_on,
 case when to_regclass('public.sheet_sources') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.sheet_sources where history_confirmed_at is not null',false,true,'')))[1]::text::int end as histories_confirmed,
 case when to_regclass('crm_private.sheet_sync_keys') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from crm_private.sheet_sync_keys where revoked_at is null',false,true,'')))[1]::text::int end as active_keys,
 -- Only the server may call the new functions; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and (f.proname like 'sheet\_%' or f.proname='lead_ad_inquiries')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where ((n.nspname='public' and c.relname='sheet_sources') or (n.nspname='crm_private' and c.relname like 'sheet\_%'))
  and (has_table_privilege('anon',c.oid,'select,insert,update,delete') or has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))) as browser_table_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('sheet_sync_owner','sheet_file_counts','sheet_history_pending','sheet_confirm_history')
  and has_function_privilege('service_role',f.oid,'execute')) as server_helper_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('sheet_sync_auth','sheet_sync_sources','sheet_sync_pending','sheet_sync_import','sheet_sync_report','sheet_sources_overview',
   'sheet_source_rejections','sheet_source_save','sheet_source_new_file','sheet_sync_key_create','sheet_sync_key_revoke','lead_ad_inquiries')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
