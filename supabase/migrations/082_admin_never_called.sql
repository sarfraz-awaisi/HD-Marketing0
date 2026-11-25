-- Update 082: All leads finds the leads their agents have never called, for
-- one agent or several at once, and moves them on safely. Apply after 081.
-- Safe to rerun. No call, lead, assignment or audit entry is changed.
--
-- * lead_never_called: a lead (not in Deleted leads) with an agent who has
--   saved no call outcome on it since receiving it, its current assignment
--   (leads.assigned_at, set again whenever the lead changes agent). Any
--   saved outcome counts as called (No answer, Busy and Number off too); a
--   call with no outcome saved does not. A call counts for whoever logged
--   it, as Team performance and the Daily KPIs count calls (updates 061,
--   063, 081): an administrator's call on the lead, or the earlier agent's,
--   leaves it never called by the current agent. The deadline and the
--   first-call time play no part; as in New and Missed first call (updates
--   038, 061), Won and Lost leads are not waiting for a call, unless Lost
--   before reaching their current agent.
-- * admin_lead_list (All leads) takes call: never_called, and agents: 1–100
--   distinct agents, for the leads assigned to any of them. agent (one
--   agent) and every other filter are unchanged.
-- * admin_distribute_never_called: Assign to agents from a Never called
--   list. Under the assignment lock it checks the selected leads again:
--   those their agent has called since stay with that agent (kept), and the
--   rest go through admin_distribute_leads (update 062) unchanged, with its
--   preview, plan, stale check, assignments and audit. A lead called after
--   the preview changes the plan, so nothing moves and the new plan, with
--   the lead kept, comes back to confirm.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text)') is null
  or to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.report_recorded_by(text,uuid)') is null
  or to_regprocedure('public.kpi_rules_problem(text,text,text,integer,boolean)') is null
  or position('call_activity' in pg_get_functiondef('public.kpi_rules_problem(text,text,text,integer,boolean)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 081 before update 082.';
 end if;
end $$;

create or replace function public.lead_never_called(p_lead uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select l.assigned_agent is not null
   and not exists(select 1 from public.calls c where c.lead_id=l.id and c.outcome is not null
    and c.created_at>=coalesce(l.assigned_at,'-infinity')
    and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=l.assigned_agent)
   and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))
  from public.active_leads l where l.id=p_lead),false)
$$;

-- Small, checked edits to All leads, as in update 063: each text must
-- appear exactly once, or the update stops and changes nothing. On a rerun
-- the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ($t$'page','ids','country','usage')$t$,
   $t$'page','ids','country','usage','agents')$t$),
  ($t$or jsonb_typeof(e.value) not in ('string','number','boolean')) then$t$,
   $t$or (e.key<>'agents' and jsonb_typeof(e.value) not in ('string','number','boolean'))
    or (e.key='agents' and jsonb_typeof(e.value)<>'array')) then$t$),
  ($t$v_temperature text;v_outcome text;v_usage integer;$t$,
   $t$v_temperature text;v_outcome text;v_usage integer;v_agents uuid[];$t$),
  ($t$v_agent=(q->>'agent')::uuid;$t$,
   $t$v_agent=(q->>'agent')::uuid;
  v_agents=case when q->'agents' is not null then array(select x::uuid from jsonb_array_elements_text(q->'agents') x) end;$t$),
  ($t$or (v_agent is not null and v_assignment='unassigned')$t$,
   $t$or (v_agent is not null and v_assignment='unassigned')
  or (v_agents is not null and (v_agent is not null or v_assignment='unassigned' or cardinality(v_agents) not between 1 and 100
   or (select count(distinct x) from unnest(v_agents) x)<>cardinality(v_agents)))$t$),
  ($t$v_call not in ('uncalled','missed','not_connected'))$t$,
   $t$v_call not in ('uncalled','missed','not_connected','never_called'))$t$),
  ($t$and (v_agent is null or l.assigned_agent=v_agent) matches$t$,
   $t$and (v_agent is null or l.assigned_agent=v_agent) and (v_agents is null or l.assigned_agent=any(v_agents)) matches$t$),
  -- Update 082: never called by the current agent since receiving the lead.
  ($t$and (v_call is null or (v_call='not_connected' and public.lead_not_connected(l.id)) or (v_call<>'not_connected' and l.first_call_at is null$t$,
   $t$and (v_call is null or (v_call='never_called' and public.lead_never_called(l.id)) or (v_call='not_connected' and public.lead_not_connected(l.id))
    or (v_call not in ('not_connected','never_called') and l.first_call_at is null$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 082 found an unexpected version of admin_lead_list: apply CRM updates up to 081 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- Assign to agents from a Never called list: the selected leads checked
-- again under the assignment lock, the called ones kept with their agent,
-- the rest planned and moved by admin_distribute_leads, which takes the
-- same lock and the same row locks in the same order. A lead marked Won or
-- Lost meanwhile stays too.
create or replace function public.admin_distribute_never_called(p_actor uuid,p_lead_ids uuid[],p_agents uuid[],
 p_apply boolean,p_token text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_kept jsonb;v_called uuid[];v_rest uuid[];result jsonb;
begin
 if p_apply then perform pg_advisory_xact_lock(873420);end if;
 perform public.accounts_admin(p_actor);
 if p_apply is null or p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or p_agents is null or cardinality(p_agents) not between 1 and 50 then
  raise exception 'Choose 1–500 distinct leads and 1–50 distinct agents' using errcode='22023';end if;
 -- A call being logged on one of these leads (log_manual_call locks the
 -- lead) finishes first and is seen, or waits until the move is done.
 if p_apply then
  perform 1 from public.profiles where id=any(p_agents) order by id for share;
  perform 1 from public.leads where id=any(p_lead_ids) order by id for update;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'result','kept',
   'reason',case when l.status in ('won','lost') and not public.lead_first_call_reopened(l.id)
    then 'Marked '||initcap(l.status)||': stays with '||coalesce(p.name,'its agent')
    else 'Called by '||coalesce(p.name,'its agent')||' since receiving it: stays with '||coalesce(p.name,'its agent') end)
   order by l.lead_no,l.id),'[]'::jsonb),coalesce(array_agg(l.id),'{}')
  into v_kept,v_called
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and l.assigned_agent is not null and not public.lead_never_called(l.id);
 v_rest=array(select x from unnest(p_lead_ids) x where x<>all(v_called));
 if cardinality(v_rest)=0 then
  raise exception 'Choose other leads: every selected lead has been called by its agent since receiving it, so nothing moves.' using errcode='22023';
 end if;
 result=public.admin_distribute_leads(p_actor,v_rest,p_agents,p_apply,p_token,p_request);
 return result||jsonb_build_object('kept',jsonb_array_length(v_kept),'results',(result->'results')||v_kept);
end $$;

-- Browsers reach none of this: the server's service role carries out the
-- moves; the helper is the database's own.
revoke all on function public.lead_never_called(uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text) from public,anon,authenticated;
grant execute on function public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
