-- Update 062: All leads shares the selected leads among chosen agents in
-- turn (round-robin), or gives them all to one agent, moving leads that
-- other agents have too. Apply after 061. Safe to rerun.
--
-- * admin_distribute_leads works out a plan and, with p_apply, carries it
--   out:
--   - every chosen agent ends with an even share of the selected leads (the
--     shares differ by at most one);
--   - a lead already with one of the chosen agents stays with them while
--     their share allows, so no lead moves without need; the larger shares
--     go first to the agents who already have the most of these leads;
--   - the other leads go to the agents in turn, alphabetically, lowest lead
--     number first, so the same leads and agents always give the same plan;
--   - each move is a normal assignment (updates 022 and 024): calls, notes
--     and history stay with the lead; pending follow-ups, visits and
--     reminders move with it; both agents are notified; and a lead that
--     came from another agent opens a fresh workspace for its new agent
--     (update 061);
--   - with two or more agents, an incoming social lead still waiting for
--     its first agent is refused, as round-robin always has (update 024);
--     with one agent it is assigned.
-- * Without p_apply nothing is locked or changed: the plan is a preview,
--   and its token stands for the leads and agents it was worked out from.
--   With p_apply the plan is worked out again under the assignment lock.
--   If the token no longer matches (another administrator moved or deleted
--   a lead, or an agent was deactivated), nothing changes and the new plan
--   comes back to be confirmed.
--
-- No table, row or existing function changes: one new function.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.agent_workspaces(uuid,uuid[])') is null
  or to_regprocedure('public.admin_assign_leads(uuid[],uuid,uuid,text)') is null then
  raise exception 'Apply CRM updates up to 061 before update 062.';
 end if;
end $$;

create or replace function public.admin_distribute_leads(p_actor uuid,p_lead_ids uuid[],p_agents uuid[],
 p_apply boolean,p_token text,p_request text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_ids uuid[];v_names text[];v_k integer;v_n integer;v_base integer;v_extra integer;
 v_owned integer[];v_room integer[];v_token text;v_turn integer=0;v_to integer;v_bad text;
 v_plan jsonb='[]';v_pool jsonb='[]';v_results jsonb='[]';v_entry jsonb;item record;
begin
 -- Carried out, every assignment waits for this one (as in update 030).
 if p_apply then perform pg_advisory_xact_lock(873420);end if;
 perform public.accounts_admin(p_actor);
 if p_apply is null or p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or p_agents is null or cardinality(p_agents) not between 1 and 50
  or (select count(distinct id) from unnest(p_agents) id)<>cardinality(p_agents) then
  raise exception 'Choose 1–500 distinct leads and 1–50 distinct agents' using errcode='22023';end if;
 -- Active agents only; alphabetical (then by id) is the order of turns.
 if p_apply then perform 1 from public.profiles where id=any(p_agents) order by id for share;end if;
 select string_agg(coalesce(p.name,'an unknown account'),', ' order by p.name) into v_bad
  from unnest(p_agents) x(id) left join public.profiles p on p.id=x.id
  where p.id is null or not p.active or p.role<>'agent' or p.deleted_at is not null;
 if v_bad is not null then
  raise exception 'Choose active agents only (not an active agent: %)',v_bad using errcode='22023';end if;
 select array_agg(p.id order by lower(p.name),p.id),array_agg(p.name order by lower(p.name),p.id) into v_ids,v_names
  from public.profiles p where p.id=any(p_agents);
 v_k=cardinality(v_ids);
 if p_apply then perform 1 from public.leads where id=any(p_lead_ids) order by id for update;end if;
 -- What the plan depends on: each selected lead's agent and state, and the
 -- agents with their names.
 select md5(coalesce(string_agg(x.id::text||':'||coalesce(l.assigned_agent::text,'-')||':'
   ||coalesce((l.deleted_at is null)::text,'gone')||':'||coalesce(l.meta_pending_assignment::text,'-'),',' order by x.id),'')
   ||'|'||array_to_string(v_ids,',')||'|'||array_to_string(v_names,','))
  into v_token from unnest(p_lead_ids) x(id) left join public.leads l on l.id=x.id;
 if p_apply and p_token is not null and p_token<>v_token then p_apply=false;end if;

 -- Even shares: the larger ones go to the agents who already have the most
 -- of these leads, then alphabetically.
 select count(*) into v_n from public.active_leads l
  where l.id=any(p_lead_ids) and (v_k=1 or not l.meta_pending_assignment);
 v_base=v_n/v_k;v_extra=v_n%v_k;
 select array_agg(coalesce(o.n,0) order by a.pos) into v_owned
  from unnest(v_ids) with ordinality a(id,pos)
  left join (select l.assigned_agent id,count(*)::integer n from public.active_leads l
   where l.id=any(p_lead_ids) and (v_k=1 or not l.meta_pending_assignment) group by 1) o on o.id=a.id;
 select array_agg(v_base+case when r.place<=v_extra then 1 else 0 end order by r.pos) into v_room
  from (select a.pos,row_number() over(order by v_owned[a.pos] desc,a.pos) place from generate_series(1,v_k) a(pos)) r;

 -- Leads already with a chosen agent stay while that agent's share allows;
 -- the rest wait in lead-number order.
 for item in select l.id,l.name,l.assigned_agent,p.name owner_name,array_position(v_ids,l.assigned_agent) mine
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and (v_k=1 or not l.meta_pending_assignment) order by l.lead_no,l.id loop
  if item.mine is not null and v_room[item.mine]>0 then
   v_room[item.mine]=v_room[item.mine]-1;
   v_plan=v_plan||jsonb_build_array(jsonb_build_object('id',item.id,'name',item.name,'agent',v_ids[item.mine],
    'agent_name',v_names[item.mine],'result','skipped','reason','Already with '||v_names[item.mine]));
  else
   v_pool=v_pool||jsonb_build_array(jsonb_build_object('id',item.id,'name',item.name,
    'from',item.assigned_agent,'from_name',item.owner_name));
  end if;
 end loop;
 -- The waiting leads go to the agents in turn, skipping those whose share
 -- is full. The shares add up to the leads, so a place is always found.
 for item in select value from jsonb_array_elements(v_pool) loop
  loop
   v_to=1+(v_turn%v_k);v_turn=v_turn+1;
   exit when v_room[v_to]>0;
  end loop;
  v_room[v_to]=v_room[v_to]-1;
  v_plan=v_plan||jsonb_build_array(item.value||jsonb_build_object('agent',v_ids[v_to],'agent_name',v_names[v_to],
   'result',case when item.value->>'from' is null then 'assigned' else 'reassigned' end,
   'reason',case when item.value->>'from' is null then 'Assigned to '||v_names[v_to]
    else 'Moved from '||coalesce(item.value->>'from_name','an agent')||' to '||v_names[v_to] end));
 end loop;
 -- Leads that cannot be planned.
 select v_plan||coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',l.name,'result','failed','reason',
   case when l.id is null or l.deleted_at is not null then 'Lead not found or in Deleted leads'
    else 'An incoming social lead waiting for its first agent: assign it to one agent' end) order by x.id),'[]'::jsonb)
  into v_plan from unnest(p_lead_ids) x(id) left join public.leads l on l.id=x.id
  where l.id is null or l.deleted_at is not null or (v_k>1 and l.meta_pending_assignment);

 -- Carried out: each move is a normal assignment, one lead at a time; a
 -- lead that cannot move is reported and the others still move.
 for item in select value from jsonb_array_elements(v_plan) loop
  v_entry=item.value;
  if p_apply and v_entry->>'result' in ('assigned','reassigned') then
   begin
    perform public.assign_lead((v_entry->>'id')::uuid,p_actor,(v_entry->>'agent')::uuid,p_request);
   exception when sqlstate 'P0002' or sqlstate '22023' then
    v_entry=v_entry||jsonb_build_object('result','failed','reason','Assignment unavailable; check the lead and the agent');
   end;
  end if;
  v_results=v_results||jsonb_build_array(v_entry);
 end loop;
 if p_apply then
  insert into public.audit_log(actor_id,action,entity,request_id,metadata)
  values(p_actor,'lead.bulk_distributed','leads',p_request,jsonb_build_object('agents',v_k,
   'assigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='assigned'),
   'reassigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='reassigned'),
   'skipped',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='skipped'),
   'failed',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='failed')));
 end if;
 return jsonb_build_object('applied',p_apply,'stale',p_token is not null and p_token<>v_token,'token',v_token,
  'assigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='assigned'),
  'reassigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='reassigned'),
  'skipped',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='skipped'),
  'failed',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='failed'),
  -- Each chosen agent: leads kept, newly assigned and moved in, and the
  -- share they end with.
  'agents',(select jsonb_agg(s.agent order by s.pos) from (
    select a.pos,jsonb_build_object('id',v_ids[a.pos],'name',v_names[a.pos],
     'kept',count(r.value) filter (where r.value->>'result'='skipped'),
     'assigned',count(r.value) filter (where r.value->>'result'='assigned'),
     'reassigned',count(r.value) filter (where r.value->>'result'='reassigned'),
     'total',count(r.value) filter (where r.value->>'result' in ('skipped','assigned','reassigned'))) agent
    from generate_series(1,v_k) a(pos)
    left join lateral jsonb_array_elements(v_results) r(value) on r.value->>'agent'=v_ids[a.pos]::text
    group by a.pos) s),
  -- Who the moved leads come from.
  'moved_from',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'count',f.n) order by f.n desc,f.name),'[]'::jsonb)
   from (select r->>'from' id,coalesce(r->>'from_name','an agent') name,count(*) n from jsonb_array_elements(v_results) r
    where r->>'result'='reassigned' group by 1,2) f),
  'results',(select coalesce(jsonb_agg(r order by r->>'result',r->>'name',r->>'id'),'[]'::jsonb) from jsonb_array_elements(v_results) r));
end $$;

-- Only the server's service role calls it; browsers never.
revoke all on function public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text) from public,anon,authenticated;
grant execute on function public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
