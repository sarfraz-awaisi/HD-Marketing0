-- Read-only check for update 062 (All leads: share selected leads among
-- chosen agents in turn). Run it in the CRM's Supabase SQL Editor before
-- 062 and right after it. It is one SELECT: it changes nothing and returns
-- flags and counts only, no customer or account details.
-- Before 062: release_stage = 'at 061, ready for 062' and
-- transactions_open_over_1_min = 0. Note the counts; after 062 they must be
-- the same (apart from new activity).
-- After 062: release_stage = 'at 062', browser_function_access_must_be_0 = 0
-- and server_functions = 3.
select
 case
  when to_regprocedure('public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text)') is not null then 'at 062'
  when to_regprocedure('public.agent_workspaces(uuid,uuid[])') is not null then 'at 061, ready for 062'
  else 'NOT READY: apply update 061 first'
 end as release_stage,
 (select count(*) from public.profiles where role='agent' and active and deleted_at is null) as active_agents,
 -- Existing records, compared before and after 062.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null) as assigned_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('assign_unassigned_leads','admin_assign_leads','admin_distribute_leads')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('assign_unassigned_leads','admin_assign_leads','admin_distribute_leads')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
