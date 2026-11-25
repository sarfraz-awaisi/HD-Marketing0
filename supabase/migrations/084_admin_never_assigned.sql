-- Update 084: administrators' Never assigned page: the leads never assigned
-- to the chosen agents, and moving them on only to agents they have never
-- had. Apply after 083. Safe to rerun. No table, row or trigger changes: one
-- list is edited and one function is added.
--
-- A lead was assigned to an agent when its assignment history
-- (public.assignments: every assignment and removal since update 002, the
-- history Lead Usage counts, update 075) holds that agent, or the agent has
-- it now. Assigning the same agent again still counts once; calls play no
-- part. Leads in Deleted leads are never listed.
-- * admin_lead_list (All leads) takes never_assigned: 1–100 distinct
--   agents, for the leads never assigned to any of them. Every other filter,
--   the counts, the pages, Select all and Lead Usage are unchanged and apply
--   with it. Each lead also returns agents_had: the agents it has had.
-- * admin_distribute_never_assigned: Assign to agents from the Never
--   assigned page, with the preview, token and stale check of update 062.
--   Each lead goes only to a chosen agent it has never had, the least loaded
--   of those first, in turn; a lead that had every chosen agent, and a Won
--   or Lost lead (as in update 082), stays where it is (kept). Under the
--   assignment lock the plan is worked out again; if a lead's agent, its
--   history or its stage changed since the preview, nothing moves and the
--   new plan comes back to confirm. Each move is assign_lead, as everywhere.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)') is null
  or position('Called meanwhile' in pg_get_functiondef('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure))=0
  or to_regprocedure('public.assign_lead(uuid,uuid,uuid,text)') is null then
  raise exception 'Apply CRM updates up to 083 before update 084.';
 end if;
end $$;
-- Small, checked edits to All leads, as in update 082: each text must
-- appear exactly once, or the update stops and changes nothing. On a rerun
-- the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ($t$'usage','agents')$t$,
   $t$'usage','agents','never_assigned')$t$),
  ($t$(e.key<>'agents' and jsonb_typeof$t$,
   $t$(e.key not in ('agents','never_assigned') and jsonb_typeof$t$),
  ($t$(e.key='agents' and jsonb_typeof(e.value)<>'array')$t$,
   $t$(e.key in ('agents','never_assigned') and jsonb_typeof(e.value)<>'array')$t$),
  ($t$v_usage integer;v_agents uuid[];$t$,
   $t$v_usage integer;v_agents uuid[];v_never uuid[];$t$),
  ($t$jsonb_array_elements_text(q->'agents') x) end;$t$,
   $t$jsonb_array_elements_text(q->'agents') x) end;
  v_never=case when q->'never_assigned' is not null then array(select x::uuid from jsonb_array_elements_text(q->'never_assigned') x) end;$t$),
  ($t$or (v_call is not null and v_call not in$t$,
   $t$or (v_never is not null and (cardinality(v_never) not between 1 and 100
   or (select count(distinct x) from unnest(v_never) x)<>cardinality(v_never)))
  or (v_call is not null and v_call not in$t$),
  ($t$where l.deleted_at is null$t$,
   $t$where l.deleted_at is null
   -- Update 084: never assigned to any of these agents, by the whole
   -- assignment history and the current agent.
   and (v_never is null or ((l.assigned_agent is null or l.assigned_agent<>all(v_never))
    and not exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id=any(v_never))))$t$),
  ($t$'agents_used',s.agents_used)$t$,
   $t$'agents_used',s.agents_used,
     'agents_had',(select coalesce(jsonb_agg(x.id),'[]'::jsonb) from (select a.agent_id id from public.assignments a
      where a.lead_id=s.id and a.agent_id is not null union select s.assigned_agent where s.assigned_agent is not null) x))$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 084 found an unexpected version of admin_lead_list: apply CRM updates up to 083 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
-- Assign to agents from the Never assigned page. The checks, locks (the
-- assignment lock, then the agents, then the leads, in id order) and the
-- result are those of admin_distribute_leads (update 062); only the plan
-- differs: no lead goes to an agent it has had.
create or replace function public.admin_distribute_never_assigned(p_actor uuid,p_lead_ids uuid[],p_agents uuid[],
 p_apply boolean,p_token text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_ids uuid[];v_names text[];v_k integer;v_load integer[];v_turn integer=0;v_to integer;v_pos integer;
 v_token text;v_bad text;v_plan jsonb='[]';v_results jsonb='[]';v_entry jsonb;item record;v_stays text;
begin
 if p_apply then perform pg_advisory_xact_lock(873420);end if;
 perform public.accounts_admin(p_actor);
 if p_apply is null or p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or p_agents is null or cardinality(p_agents) not between 1 and 50
  or (select count(distinct id) from unnest(p_agents) id)<>cardinality(p_agents) then
  raise exception 'Choose 1–500 distinct leads and 1–50 distinct agents' using errcode='22023';end if;
 if p_apply then perform 1 from public.profiles where id=any(p_agents) order by id for share;end if;
 select string_agg(coalesce(p.name,'an unknown account'),', ' order by p.name) into v_bad
  from unnest(p_agents) x(id) left join public.profiles p on p.id=x.id
  where p.id is null or not p.active or p.role<>'agent' or p.deleted_at is not null;
 if v_bad is not null then
  raise exception 'Choose active agents only (not an active agent: %)',v_bad using errcode='22023';end if;
 select array_agg(p.id order by lower(p.name),p.id),array_agg(p.name order by lower(p.name),p.id) into v_ids,v_names
  from public.profiles p where p.id=any(p_agents);
 v_k=cardinality(v_ids);v_load=array_fill(0,array[v_k]);
 if p_apply then perform 1 from public.leads where id=any(p_lead_ids) order by id for update;end if;
 -- What the plan depends on: each lead's agent, state, stage and the agents
 -- it has had, and the agents with their names.
 select md5(coalesce(string_agg(x.id::text||':'||coalesce(l.assigned_agent::text,'-')||':'
   ||coalesce((l.deleted_at is null)::text,'gone')||':'||coalesce(l.meta_pending_assignment::text,'-')||':'
   ||coalesce(l.status,'-')||':'||coalesce(public.lead_first_call_reopened(l.id)::text,'-')||':'
   ||coalesce((select string_agg(distinct a.agent_id::text,',' order by a.agent_id::text) from public.assignments a where a.lead_id=x.id),''),
   ',' order by x.id),'')||'|'||array_to_string(v_ids,',')||'|'||array_to_string(v_names,','))
  into v_token from unnest(p_lead_ids) x(id) left join public.leads l on l.id=x.id;
 if p_apply and p_token is not null and p_token<>v_token then p_apply=false;end if;

 -- In lead-number order, each lead to the least loaded chosen agent it has
 -- never had, the next agent in turn first when they are even.
 for item in select l.id,l.name,l.status,l.assigned_agent,p.name owner_name,l.meta_pending_assignment,
   array(select a.agent_id from public.assignments a where a.lead_id=l.id and a.agent_id is not null
    union select l.assigned_agent where l.assigned_agent is not null) had
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) order by l.lead_no,l.id loop
  v_to=null;
  v_stays=case when item.assigned_agent is null then 'stays unassigned' else 'stays with '||coalesce(item.owner_name,'its agent') end;
  if v_k>1 and item.meta_pending_assignment then
   v_entry=jsonb_build_object('id',item.id,'name',item.name,'result','failed',
    'reason','An incoming social lead waiting for its first agent: assign it to one agent');
  elsif item.status in ('won','lost') and not public.lead_first_call_reopened(item.id) then
   v_entry=jsonb_build_object('id',item.id,'name',item.name,'result','kept','reason','Marked '||initcap(item.status)||': '||v_stays);
  else
   for i in 0..v_k-1 loop
    v_pos=1+((v_turn+i)%v_k);
    if v_ids[v_pos]<>all(item.had) and (v_to is null or v_load[v_pos]<v_load[v_to]) then v_to=v_pos;end if;
   end loop;
   if v_to is null then
    v_entry=jsonb_build_object('id',item.id,'name',item.name,'result','kept','reason',
     case when v_k=1 then 'Assigned to '||v_names[1]||' before' else 'Assigned before to every chosen agent' end||': '||v_stays);
   else
    v_load[v_to]=v_load[v_to]+1;v_turn=v_to;
    v_entry=jsonb_build_object('id',item.id,'name',item.name,'from',item.assigned_agent,'from_name',item.owner_name,
     'agent',v_ids[v_to],'agent_name',v_names[v_to],
     'result',case when item.assigned_agent is null then 'assigned' else 'reassigned' end,
     'reason',case when item.assigned_agent is null then 'Assigned to '||v_names[v_to]
      else 'Moved from '||coalesce(item.owner_name,'an agent')||' to '||v_names[v_to] end);
   end if;
  end if;
  v_plan=v_plan||jsonb_build_array(v_entry);
 end loop;
 select v_plan||coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',l.name,'result','failed',
   'reason','Lead not found or in Deleted leads') order by x.id),'[]'::jsonb)
  into v_plan from unnest(p_lead_ids) x(id) left join public.leads l on l.id=x.id
  where l.id is null or l.deleted_at is not null;

 -- Carried out: each move is a normal assignment, one lead at a time.
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
  values(p_actor,'lead.bulk_distributed','leads',p_request,jsonb_build_object('agents',v_k,'never_assigned',true,
   'assigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='assigned'),
   'reassigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='reassigned'),
   'skipped',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='kept'),
   'failed',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='failed')));
 end if;
 return jsonb_build_object('applied',p_apply,'stale',p_token is not null and p_token<>v_token,'token',v_token,
  'never_assigned',true,
  'assigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='assigned'),
  'reassigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='reassigned'),
  'skipped',0,
  'kept',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='kept'),
  'failed',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='failed'),
  'agents',(select jsonb_agg(s.agent order by s.pos) from (
    select a.pos,jsonb_build_object('id',v_ids[a.pos],'name',v_names[a.pos],'kept',0,
     'assigned',count(r.value) filter (where r.value->>'result'='assigned'),
     'reassigned',count(r.value) filter (where r.value->>'result'='reassigned'),
     'total',count(r.value) filter (where r.value->>'result' in ('assigned','reassigned'))) agent
    from generate_series(1,v_k) a(pos)
    left join lateral jsonb_array_elements(v_results) r(value) on r.value->>'agent'=v_ids[a.pos]::text
    group by a.pos) s),
  'moved_from',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'count',f.n) order by f.n desc,f.name),'[]'::jsonb)
   from (select r->>'from' id,coalesce(r->>'from_name','an agent') name,count(*) n from jsonb_array_elements(v_results) r
    where r->>'result'='reassigned' group by 1,2) f),
  'results',(select coalesce(jsonb_agg(r order by r->>'result',r->>'name',r->>'id'),'[]'::jsonb) from jsonb_array_elements(v_results) r));
end $$;
-- Browsers reach none of this: the server's service role carries out the
-- moves.
revoke all on function public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text) from public,anon,authenticated;
grant execute on function public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
