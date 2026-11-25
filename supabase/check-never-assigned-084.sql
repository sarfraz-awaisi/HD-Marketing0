-- Read-only check for update 084 (Never assigned). Changes nothing and
-- shows counts only, no customer details. Before: release_stage = 'at 083,
-- ready for 084' and list_edits_fit true. After: 'at 084' and browsers
-- cannot use it.
-- The assignment history (public.assignments) the page relies on:
-- * history_gaps: assigned leads whose current agent has no assignment
--   record (the page still counts the current agent as assigned);
-- * owner_not_latest_record: assigned leads whose latest record names
--   another agent, an owner change made without a record;
-- * unassigned_after_agent_record: leads with no agent whose latest record
--   names one (removed without a record, as Delete and Restore do); their
--   agents still count as assigned;
-- * leads_older_than_history: leads created before the first record ever
--   saved. Leads and their history began together (update 002; in
--   production, again at the test-data cleanup of 24 October 2026, which
--   emptied both), and every owner change since goes through the database
--   functions that record it, so such a lead was simply created before
--   anyone was assigned a lead: no history is missing.
-- history_gaps and owner_not_latest_record at 0 mean no lead can wrongly
-- show as never assigned to an agent.
with s as (select
  to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is not null distribute,
  position('never_assigned' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))>0 list,
  to_regprocedure('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)') is not null
   and position('Called meanwhile' in pg_get_functiondef('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure))>0 at_083,
  to_regprocedure('public.assign_lead(uuid,uuid,uuid,text)') is not null
   and to_regprocedure('public.accounts_admin(uuid)') is not null
   and to_regprocedure('public.lead_first_call_reopened(uuid)') is not null helpers,
  pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure) body),
latest as (select distinct on (a.lead_id) a.lead_id,a.agent_id from public.assignments a
  order by a.lead_id,a.created_at desc,a.id desc)
select
 case when distribute and list then 'at 084'
  when not distribute and not list and at_083 and helpers then 'at 083, ready for 084'
  else 'NOT READY: apply CRM updates up to 083 exactly' end release_stage,
 -- Each text update 084 edits appears exactly once (before 084 only).
 case when not list then (select bool_and((length(body)-length(replace(body,v.t,'')))/length(v.t)=1) from (values
  ($t$'usage','agents')$t$),($t$(e.key<>'agents' and jsonb_typeof$t$),
  ($t$(e.key='agents' and jsonb_typeof(e.value)<>'array')$t$),($t$v_usage integer;v_agents uuid[];$t$),
  ($t$jsonb_array_elements_text(q->'agents') x) end;$t$),($t$or (v_call is not null and v_call not in$t$),
  ($t$where l.deleted_at is null$t$),($t$'agents_used',s.agents_used)$t$)) v(t)) end list_edits_fit,
 case when distribute then
  has_function_privilege('anon','public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)','execute')
  or has_function_privilege('authenticated','public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)','execute') end browser_can_use_it,
 (select count(*) from public.active_leads) active_leads,
 (select count(*) from public.active_leads where assigned_agent is not null) assigned_leads,
 (select count(*) from public.assignments) assignment_records,
 (select count(*) from public.active_leads l where l.assigned_agent is not null
   and not exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id=l.assigned_agent)) history_gaps,
 (select count(*) from public.active_leads l join latest r on r.lead_id=l.id
   where l.assigned_agent is not null and r.agent_id is distinct from l.assigned_agent) owner_not_latest_record,
 (select count(*) from public.active_leads l join latest r on r.lead_id=l.id
   where l.assigned_agent is null and r.agent_id is not null) unassigned_after_agent_record,
 (select count(*) from public.active_leads l
   where l.created_at<(select min(created_at) from public.assignments)) leads_older_than_history,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
