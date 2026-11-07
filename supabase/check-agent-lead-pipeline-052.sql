-- Read-only check for update 052 (agents' Assigned leads and Lead pipeline).
-- Run it in the CRM's Supabase SQL Editor before 052 and right after it. It
-- is one SELECT: it changes nothing and returns flags and counts only, no
-- customer or account details.
-- Before 052: release_stage = 'at 051, ready for 052' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 052
-- they must be the same (apart from new activity).
-- After 052: release_stage = 'at 052', every *_must_be_0 column 0,
-- server_functions = 1 and numbered_file_leads = file_leads.
select
 to_regprocedure('public.report_today_records(text,uuid)') is not null as update_051_installed,
 case
  when to_regprocedure('public.agent_lead_list(uuid,jsonb)') is not null
   and to_regclass('crm_private.lead_file_rows') is not null then 'at 052'
  when to_regprocedure('public.report_today_records(text,uuid)') is not null then 'at 051, ready for 052'
  else 'NOT READY: apply update 051 first'
 end as release_stage,
 -- Existing records, compared before and after 052.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.lead_imports) as existing_files,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- 052's file numbers (#): every lead in a file has one.
 (select count(*) from public.leads where import_id is not null) as file_leads,
 case when to_regclass('crm_private.lead_file_rows') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from public.leads l join crm_private.lead_file_rows r on r.lead_id=l.id and r.import_id=l.import_id',false,true,'')))[1]::text::bigint
 end as numbered_file_leads,
 (select count(*) from pg_trigger where tgname='number_file_lead' and tgrelid='public.leads'::regclass) as number_trigger,
 -- Only the server may list leads; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('agent_lead_list','number_file_lead')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('agent_lead_list','number_file_lead')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 -- PostgREST runs stable functions read-only; the list locks the signed-in
 -- profile, so it must not be stable.
 (select count(*) from pg_proc f where f.oid=to_regprocedure('public.agent_lead_list(uuid,jsonb)') and f.provolatile<>'v') as stable_api_function_must_be_0,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
