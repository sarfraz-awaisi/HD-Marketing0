-- Read-only check for update 061 (a fresh workspace for reassigned leads).
-- Run it in the CRM's Supabase SQL Editor before 061 and right after it. It
-- is one SELECT: it changes nothing and returns flags and counts only, no
-- customer or account details.
-- Before 061: release_stage = 'at 060, ready for 061' and
-- transactions_open_over_1_min = 0. Note the counts; after 061 they must be
-- the same (apart from new activity).
-- reassigned_lost_waiting_first_call: Lost leads that came from another
-- agent and join their agent's first calls with 061. Of those,
-- deadline_already_passed are reported as missed first calls (to the agent
-- and the administrators) at the next background check after 061.
-- After 061: release_stage = 'at 061', browser_function_access_must_be_0 = 0
-- and server_functions = 9.
with workspace as (
 select l.id,l.status,l.lost_at,l.assigned_at,l.first_call_at,l.call_due_at,
  exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id is not null
   and a.agent_id<>l.assigned_agent and a.created_at<l.assigned_at) reassigned
 from public.leads l
 where l.deleted_at is null and l.assigned_agent is not null and l.assigned_at is not null
)
select
 case
  when to_regprocedure('public.agent_workspaces(uuid,uuid[])') is not null then 'at 061'
  when to_regprocedure('public.admin_assign_leads(uuid[],uuid,uuid,text)') is not null then 'at 060, ready for 061'
  else 'NOT READY: apply update 060 first'
 end as release_stage,
 -- Leads that open a fresh workspace for their agent.
 (select count(*) from workspace where reassigned) as reassigned_leads,
 (select count(*) from workspace where reassigned and first_call_at is null) as reassigned_waiting_first_call,
 (select count(*) from workspace where reassigned and status='lost' and lost_at<assigned_at
  and first_call_at is null and call_due_at is not null) as reassigned_lost_waiting_first_call,
 (select count(*) from workspace where reassigned and status='lost' and lost_at<assigned_at
  and first_call_at is null and call_due_at<now()) as deadline_already_passed,
 -- Existing records, compared before and after 061.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and status='lost') as lost_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.visits) as existing_visits,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('workspace_since','workspace_item','workspace_state','lead_first_call_reopened','lead_workspace',
   'agent_workspaces','report_drill_row_workspace','agent_lead_list','agent_pipeline_attribution','crm_mutate')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('agent_workspaces','workspace_state','lead_first_call_reopened')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
