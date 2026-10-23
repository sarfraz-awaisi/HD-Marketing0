-- Read-only check for inventory update 041. Run it in the CRM's Supabase SQL
-- Editor before applying 041 and again afterwards. It changes nothing and
-- returns schema flags and row counts only, no customer or account details.
-- Expected values are listed in docs/PROPERTY_INVENTORY.md.
select
 current_setting('server_version') as postgres_version,
 current_setting('server_version_num')::integer>=140000 as postgres_14_or_newer,
 to_regclass('public.property_photo_cleanup') is not null as update_013_installed,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='deleted_at') as update_028_installed,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='uid') as update_036_installed,
 to_regprocedure('public.attendance_member(uuid)') is not null as update_040_installed,
 exists(select 1 from pg_trigger where tgrelid='public.properties'::regclass and tgname='touch_updated') as properties_touch_trigger,
 not exists(select 1 from pg_constraint where conrelid='public.properties'::regclass and contype='c'
  and conname not in ('properties_price_check','properties_area_check','properties_area_unit_check','properties_availability_check',
   'properties_purpose_status','properties_location_fields','properties_detail_fields')) as properties_checks_as_expected,
 (select string_agg(conname,', ' order by conname) from pg_constraint where conrelid='public.properties'::regclass and contype='c') as properties_check_names,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='owner_agent_id') as update_041_installed,
 -- Counts to compare with the backup and with the result after 041.
 (select count(*) from public.properties) as properties,
 (select count(*) from public.property_photos) as property_photos,
 (select count(*) from public.leads) as leads,
 (select count(*) from public.visits) as visits,
 (select count(*) from public.deals) as deals,
 (select count(*) from public.properties where availability not in ('available','reserved','sold','rented','archived')
   or area_unit not in ('sq ft','sq yd','marla','kanal','acre')) as properties_outside_rules,
 (select count(*) from public.property_photo_cleanup) as photo_cleanup_queue,
 -- After 041: private (agent-owned) properties. Before rolling the
 -- application back to a release without inventory, this must be 0.
 case when exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='owner_agent_id')
  then (select count(*) from public.properties p where (to_jsonb(p)->>'owner_agent_id') is not null) end as agent_owned_properties,
 (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'inventory%') as inventory_functions,
 (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'inventory%' or p.proname='delete_property')
   and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) as browser_executable_functions,
 has_table_privilege('anon','public.properties','select') or has_table_privilege('authenticated','public.properties','select') as browser_can_read_properties,
 (select c.relrowsecurity from pg_class c where c.oid=to_regclass('public.property_owner_contacts')) as owner_contacts_rls,
 b.id is not null as photo_bucket_exists,
 b.public as photo_bucket_public,
 b.file_size_limit as photo_bucket_size_limit,
 b.allowed_mime_types as photo_bucket_types,
 (select count(*) from pg_policies where schemaname='storage' and tablename='objects'
   and roles && array['public','anon','authenticated']::name[]) as storage_browser_policies,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
   and state is distinct from 'idle' and xact_start<now()-interval '1 minute') as transactions_open_over_1_minute
from (select 1) one left join storage.buckets b on b.id='property-photos';
