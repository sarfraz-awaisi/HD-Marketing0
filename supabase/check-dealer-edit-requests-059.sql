-- Read-only check for update 059 (agents edit their own dealers; changes to
-- an approved dealer wait for an administrator). Run it in the CRM's Supabase
-- SQL Editor before 059 and right after it. It is one SELECT: it changes
-- nothing and returns flags and counts only, no dealer or account details.
-- Before 059: release_stage = 'at 058, ready for 059' and
-- transactions_open_over_1_min = 0. Note the dealer counts; after 059 they
-- must be the same (apart from new activity).
-- After 059: release_stage = 'at 059', every *_must_be_0 column 0,
-- server_functions = 4 and change_requests = 0.
select
 coalesce((select pg_get_functiondef(p.oid) like '%v_outcome%' from pg_proc p
  where p.oid=to_regprocedure('public.admin_lead_list(uuid,jsonb)')),false) as update_058_installed,
 case
  when to_regclass('public.dealer_change_requests') is not null
   and to_regprocedure('public.dealer_submit_changes(uuid,uuid,jsonb,timestamptz,text)') is not null
   and to_regprocedure('public.dealer_change_review(uuid,uuid,text,text,timestamptz,timestamptz,text)') is not null
   and to_regprocedure('public.dealer_review(uuid,uuid,text,text,timestamptz,text)') is not null then 'at 059'
  when to_regprocedure('public.dealer_update(uuid,uuid,jsonb,timestamptz,text)') is not null
   and coalesce((select pg_get_functiondef(p.oid) like '%v_outcome%' from pg_proc p
    where p.oid=to_regprocedure('public.admin_lead_list(uuid,jsonb)')),false) then 'at 058, ready for 059'
  else 'NOT READY: apply update 058 first'
 end as release_stage,
 -- Existing dealers, compared before and after 059.
 (select count(*) from public.dealers) as existing_dealers,
 (select jsonb_object_agg(status,n) from (select status,count(*) n from public.dealers where deleted_at is null group by 1) s) as dealers_by_status,
 (select count(*) from public.dealers where deleted_at is not null) as deleted_dealers,
 (select count(*) from public.audit_log where entity='dealers') as dealer_audit_entries,
 -- Proposed changes (null before 059; 0 right after).
 case when to_regclass('public.dealer_change_requests') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.dealer_change_requests',false,true,'')))[1]::text::int end as change_requests,
 -- Browsers get nothing; the server only the functions it calls.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace and f.proname like 'dealer%'
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('dealers','dealer_change_requests')
  and (has_table_privilege('anon',c.oid,'select,insert,update,delete') or has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))) as browser_table_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('dealer_values','dealer_change_json','dealer_json')
  and has_function_privilege('service_role',f.oid,'execute')) as server_helper_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.oid in (to_regprocedure('public.dealer_submit_changes(uuid,uuid,jsonb,timestamptz,text)'),
   to_regprocedure('public.dealer_change_review(uuid,uuid,text,text,timestamptz,timestamptz,text)'),
   to_regprocedure('public.dealer_review(uuid,uuid,text,text,timestamptz,text)'),
   to_regprocedure('public.dealers_page(uuid,jsonb,integer,integer)'))
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
