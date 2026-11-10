-- Read-only check for update 058 (All leads: call outcome and temperature
-- filters). Run it in the CRM's Supabase SQL Editor before 058 and right
-- after it. It is one SELECT: it changes nothing and returns flags and counts
-- only, no customer or account details.
-- Before 058: release_stage = 'at 057, ready for 058' and
-- transactions_open_over_1_min = 0. Note the counts; after 058 they must be
-- the same (apart from new activity).
-- After 058: release_stage = 'at 058', browser_function_access_must_be_0 = 0
-- and server_functions = 2.
select
 to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is not null as update_057_installed,
 case
  when to_regprocedure('public.admin_lead_list(uuid,jsonb)') is not null
   and pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure) like '%v_outcome%' then 'at 058'
  when to_regprocedure('public.admin_lead_list(uuid,jsonb)') is not null
   and to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is not null then 'at 057, ready for 058'
  else 'NOT READY: apply update 057 first'
 end as release_stage,
 -- Existing records, compared before and after 058.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null) as assigned_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- For information: leads by the outcome of their latest call, as the new
 -- filter counts them (none: no call yet).
 (select jsonb_object_agg(outcome,n) from (select coalesce(x.outcome,'none') outcome,count(*) n from public.leads l
   left join lateral (select c.outcome from public.calls c where c.lead_id=l.id
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) x on true
   where l.deleted_at is null group by 1) o) as leads_by_latest_call,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
