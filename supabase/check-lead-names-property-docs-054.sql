-- Read-only check for update 054 (customer names, property floors, property
-- PDF documents). Run it in the CRM's Supabase SQL Editor before 054 and
-- right after it. It is one SELECT: it changes nothing and returns flags and
-- counts only, no customer, property or account details.
-- Before 054: release_stage = 'at 053, ready for 054' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 054
-- they must be the same (apart from new activity).
-- After 054: release_stage = 'at 054', document_bucket = 'private, PDF only,
-- 25 MB', every *_must_be_0 column 0 and server_functions = 9.
select
 to_regclass('public.audit_log_note_records') is not null as update_053_installed,
 case
  when to_regprocedure('public.lead_rename(uuid,uuid,text,text)') is not null
   and to_regclass('public.property_documents') is not null
   and exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='floor_level')
   and position('floor_level' in coalesce(pg_get_functiondef(to_regprocedure('public.inventory_save(uuid,uuid,jsonb,text)')),''))>0
   then 'at 054'
  when to_regclass('public.audit_log_note_records') is not null then 'at 053, ready for 054'
  else 'NOT READY: apply update 053 first'
 end as release_stage,
 -- Existing records, compared before and after 054.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.properties) as existing_properties,
 (select count(*) from public.property_photos) as existing_property_photos,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- The bucket for property documents.
 (select case when b.id is null then 'missing'
   else concat_ws(', ',case when b.public then 'PUBLIC' else 'private' end,
    case when b.allowed_mime_types='{application/pdf}' then 'PDF only' else 'OTHER TYPES' end,
    (b.file_size_limit/1048576)::text||' MB') end
  from (select 1) x left join storage.buckets b on b.id='property-documents') as document_bucket,
 -- No Storage policy may let a browser read or write the documents.
 (select count(*) from pg_policies where schemaname='storage' and tablename='objects'
  and (coalesce(qual,'') like '%property-documents%' or coalesce(with_check,'') like '%property-documents%')) as document_storage_policies_must_be_0,
 -- The new tables: row-level security on, no browser access.
 (select count(*) from pg_class c where c.oid in (to_regclass('public.property_documents'),to_regclass('public.property_document_cleanup'))
  and not c.relrowsecurity) as tables_without_rls_must_be_0,
 (select count(*) from pg_class c where c.oid in (to_regclass('public.property_documents'),to_regclass('public.property_document_cleanup'))
  and (has_table_privilege('anon',c.oid,'select,insert,update,delete') or has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))) as browser_table_access_must_be_0,
 -- Only the server may call the new functions; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('lead_rename','inventory_save','inventory_promote','inventory_documents','inventory_document_file',
   'inventory_document_reserve','inventory_document_add','inventory_document_release','inventory_document_remove',
   'promotion_change_text','queue_property_document_file','property_document_json')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('lead_rename','inventory_save','inventory_promote','inventory_documents','inventory_document_file',
   'inventory_document_reserve','inventory_document_add','inventory_document_release','inventory_document_remove')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 -- Properties with a floor recorded: 0 before 054 and straight after it.
 (select count(*) from public.properties p where to_jsonb(p)->>'floor_level' is not null) as properties_with_floor,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
