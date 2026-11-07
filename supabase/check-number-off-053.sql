-- Read-only check for update 053 (Number off; agents' notes in their lead
-- lists). Run it in the CRM's Supabase SQL Editor before 053 and right after
-- it. It is one SELECT: it changes nothing and returns flags and counts
-- only, no customer or account details.
-- Before 053: release_stage = 'at 052, ready for 053' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 053
-- they must be the same (apart from new activity).
-- After 053: release_stage = 'at 053', every *_must_be_0 column 0 and
-- server_functions = 2.
select
 to_regprocedure('public.agent_lead_list(uuid,jsonb)') is not null as update_052_installed,
 case
  when position('Number off' in coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid='public.calls'::regclass and c.conname='calls_outcome_check'),''))>0
   and position('last_call_outcome' in coalesce(pg_get_functiondef(to_regprocedure('public.agent_lead_list(uuid,jsonb)')),''))>0
   then 'at 053'
  when to_regprocedure('public.agent_lead_list(uuid,jsonb)') is not null then 'at 052, ready for 053'
  else 'NOT READY: apply update 052 first'
 end as release_stage,
 -- Existing records, compared before and after 053.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.audit_log) as existing_audit_entries,
 (select count(*) from public.calls where outcome='Number off') as number_off_calls,
 -- Number off is never an answered call.
 (select count(*) from public.calls where outcome='Number off' and (answered or status='completed')) as answered_number_off_must_be_0,
 -- Only the server may log calls or list leads; browsers never.
 (select count(*) from pg_proc f where f.oid in (to_regprocedure('public.log_manual_call(uuid,uuid,jsonb,text)'),
   to_regprocedure('public.agent_lead_list(uuid,jsonb)'))
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.oid in (to_regprocedure('public.log_manual_call(uuid,uuid,jsonb,text)'),
   to_regprocedure('public.agent_lead_list(uuid,jsonb)'))
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 -- PostgREST runs stable functions read-only; the list locks the signed-in
 -- profile, so it must not be stable.
 (select count(*) from pg_proc f where f.oid=to_regprocedure('public.agent_lead_list(uuid,jsonb)') and f.provolatile<>'v') as stable_api_function_must_be_0,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
