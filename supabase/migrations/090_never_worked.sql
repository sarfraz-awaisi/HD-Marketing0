-- Update 090: administrators' Never Worked page (Never assigned until now)
-- gets a second lead category, Assigned but Never Called, and its Assign to
-- agents carries the checks the page's source-agent numbers need. Apply
-- after 089. Safe to rerun. No table, row or trigger changes, and no call,
-- lead, assignment or audit entry is changed: one function and one wrapper
-- are added, two functions are edited.
--
-- * lead_agent_uncalled: a lead (not in Deleted leads) whose current agent
--   has saved no call outcome on it since receiving it (leads.assigned_at,
--   set again whenever the lead changes agent), as update 082 first defined
--   Never called. Any saved outcome counts (No answer and Busy too); a call
--   with no outcome saved does not. A call counts for whoever logged it, as
--   Team performance and the Daily KPIs count calls: an administrator's call,
--   or the earlier agent's, leaves the lead uncalled by its current agent.
--   All leads' Never called (update 083: never called by anyone) is
--   unchanged.
-- * admin_lead_list takes agent_uncalled: the leads uncalled by their
--   current agent, not marked Won or Lost (unless Lost before reaching that
--   agent). The agent filter (agent, agents) is then the current agents. It
--   always leaves out the leads an agent is working on (update 088), and
--   does not go with never_assigned, a first-call filter or Unassigned.
-- * admin_distribute_never_assigned (update 084) also returns each move's
--   lead number, so the server can take each current agent's leads in a
--   fixed order, and a preview is out of date once a selected lead reaches
--   an agent again, even the same agent.
-- * admin_distribute_agent_uncalled: Assign to agents for Assigned but
--   Never Called. Under the assignment lock it checks the selected leads
--   again: those with no agent now, or called by their agent since
--   receiving them, stay where they are (kept), and the rest go through
--   admin_distribute_never_assigned unchanged, with its preview, plan, stale
--   check, assignments and audit. A lead called after the preview changes
--   the plan, so nothing moves and the new plan comes back to confirm.
-- Rerunning update 088 after this one changes nothing.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is null
  or position('Update 088' in pg_get_functiondef('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure))=0
  or position('Update 088' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0
  or to_regprocedure('public.report_recorded_by(text,uuid)') is null
  or to_regprocedure('public.attendance_employees(uuid)') is null
  or position('Update 089' in pg_get_functiondef('public.attendance_employees(uuid)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 089 before update 090.';
 end if;
end $$;

create or replace function public.lead_agent_uncalled(p_lead uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select l.assigned_agent is not null
   and not exists(select 1 from public.calls c where c.lead_id=l.id and c.outcome is not null
    and c.created_at>=coalesce(l.assigned_at,'-infinity')
    and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=l.assigned_agent)
  from public.active_leads l where l.id=p_lead),false)
$$;

-- Checked edits, as in updates 061 to 088: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone. Update 088's edited texts stay whole.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('public.admin_lead_list(uuid,jsonb)',
   $t$v_outcomes text[];v_open boolean;$t$,
   $t$v_outcomes text[];v_open boolean;v_uncalled boolean;$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$where e.key not in ('first','search',$t$,
   $t$where e.key not in ('agent_uncalled','first','search',$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$v_open=coalesce((q->>'reassignable')::boolean,false);$t$,
   $t$v_open=coalesce((q->>'reassignable')::boolean,false);v_uncalled=coalesce((q->>'agent_uncalled')::boolean,false);$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$ if v_search is not null then$t$,
   $t$ -- Update 090: Assigned but Never Called (Never Worked), by the leads'
 -- current agents; always without the leads an agent is working on.
 if v_uncalled and (v_never is not null or v_call is not null or v_assignment='unassigned') then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_open=v_open or v_uncalled;
 if v_search is not null then$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$   and (v_temperature is null or coalesce($t$,
   $t$   -- Update 090: Assigned but Never Called: no call outcome saved by the
   -- current agent since receiving the lead, and not marked Won or Lost
   -- unless Lost before reaching that agent.
   and (not v_uncalled or (public.lead_agent_uncalled(l.id)
    and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))))
   and (v_temperature is null or coalesce($t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$   ||coalesce((select string_agg(distinct a.agent_id::text$t$,
   $t$   -- Update 090: and when it reached its current agent.
   ||coalesce(l.assigned_at::text,'-')||':'
   ||coalesce((select string_agg(distinct a.agent_id::text$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$for item in select l.id,l.name,l.status,$t$,
   $t$for item in select l.id,l.lead_no,l.name,l.status,$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$v_entry=jsonb_build_object('id',item.id,'name',item.name,'from',item.assigned_agent,$t$,
   $t$v_entry=jsonb_build_object('id',item.id,'lead_no',item.lead_no,'name',item.name,'from',item.assigned_agent,$t$)
 ) v(fn,old_text,new_text) loop
  body=pg_get_functiondef(item.fn::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 090 found an unexpected version of %: apply CRM updates up to 089 exactly.',item.fn;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- Assign to agents for Assigned but Never Called. The checks and locks (the
-- assignment lock, then the agents, then the leads, in id order) are those
-- of admin_distribute_never_called (update 083), which locks the same way.
create or replace function public.admin_distribute_agent_uncalled(p_actor uuid,p_lead_ids uuid[],p_agents uuid[],
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
   'reason',case when l.assigned_agent is null then 'No agent now: stays unassigned'
    else 'Called by '||coalesce(p.name,'its agent')||' since receiving it: stays with '||coalesce(p.name,'its agent') end)
   order by l.lead_no,l.id),'[]'::jsonb),coalesce(array_agg(l.id),'{}')
  into v_kept,v_called
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and not public.lead_agent_uncalled(l.id);
 v_rest=array(select x from unnest(p_lead_ids) x where x<>all(v_called));
 -- Every lead stays: nothing to move, in the same shape.
 if cardinality(v_rest)=0 then
  return jsonb_build_object('applied',false,'stale',p_token is not null,
   'token',md5('kept:'||array_to_string(array(select x::text from unnest(v_called) x order by 1),',')),
   'never_assigned',true,'assigned',0,'reassigned',0,'skipped',0,'kept',jsonb_array_length(v_kept),'failed',0,
   'agents',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'kept',0,'assigned',0,'reassigned',0,'total',0)
     order by lower(p.name),p.id),'[]'::jsonb) from public.profiles p where p.id=any(p_agents)),
   'moved_from','[]'::jsonb,'results',v_kept);
 end if;
 result=public.admin_distribute_never_assigned(p_actor,v_rest,p_agents,p_apply,p_token,p_request);
 return result||jsonb_build_object('kept',(result->>'kept')::integer+jsonb_array_length(v_kept),
  'results',(result->'results')||v_kept);
end $$;

-- Browsers reach none of this: the server's service role carries out the
-- moves.
revoke all on function public.lead_agent_uncalled(uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_distribute_agent_uncalled(uuid,uuid[],uuid[],boolean,text,text) from public,anon,authenticated;
grant execute on function public.admin_distribute_agent_uncalled(uuid,uuid[],uuid[],boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
