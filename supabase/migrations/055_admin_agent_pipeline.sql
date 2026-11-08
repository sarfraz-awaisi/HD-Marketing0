-- Update 055: administrators' Lead pipeline, agent by agent, and the two
-- counts on an agent's own Lead pipeline. Apply after 054 (it needs only
-- 053). Safe to rerun.
--
-- * admin_pipeline_agents: every agent with their pipeline numbers, found by
--   name or UID, 20 at a time.
-- * admin_agent_pipeline: one agent's pipeline, with the agent's own search
--   and filters (updates 052 and 053), plus the leads that agent spoke to
--   that are now someone else's, listed apart.
-- * agent_pipeline_attribution: for an agent's own Lead pipeline, My
--   pipeline (every lead of theirs with an answered call, as agent_lead_list
--   lists them) and Personally contacted (those with an answered call the
--   agent made), and, for the leads on the page, who recorded the latest
--   answered call when it was not the agent.
--
-- Who spoke to a lead comes only from recorded facts. An answered call
-- counts for an agent when it is filed under the agent (calls.agent_id) and
-- the audit log names the agent as the one who recorded it ("create" or
-- "call.manual_logged", as in update 050). calls.agent_id alone is not
-- enough: a call an administrator logs is filed under the lead's agent. A
-- call without such an entry counts for no one. No answer, Busy, Wrong
-- number and Number off never count as speaking to a lead.
--
-- * Current pipeline: leads assigned to the agent now (not deleted) that the
--   agent spoke to. The latest contact, the latest call, the outcome filter
--   and the note are the agent's own; the temperature and next follow-up are
--   the lead's, as in the agent's own pipeline.
-- * Earlier contacts: leads the agent spoke to that are now assigned to
--   someone else or no one. They never count in the agent's numbers.
--
-- The administrators' functions are for administrators only, the counts for
-- the agent themself; both are checked here as well as by the server. No
-- table, no data and no existing function changes; agent_lead_list stays as
-- it is.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.agent_lead_list(uuid,jsonb)') is null or to_regclass('public.audit_log_note_records') is null
  or to_regprocedure('public.report_person(uuid)') is null or to_regprocedure('public.accounts_admin(uuid)') is null then
  raise exception 'Apply CRM updates up to 053 before update 055.';
 end if;
end $$;

-- The leads one agent spoke to (not deleted): the agent's latest answered
-- call and latest call of any kind on each, ordered as in update 053.
create or replace function public.agent_spoken_leads(p_agent uuid)
returns table(lead_id uuid,contact_at timestamptz,contact_outcome text,last_call_at timestamptz,last_call_outcome text,last_call_connected boolean)
language sql stable security definer set search_path='' as $$
 with own as (
  select c.lead_id,c.started_at,c.outcome,c.status='completed' connected,
   row_number() over(partition by c.lead_id order by c.started_at desc,c.created_at desc,c.id desc) latest,
   row_number() over(partition by c.lead_id,c.status='completed' order by c.started_at desc,c.created_at desc,c.id desc) latest_of_kind
  from public.calls c
  where c.agent_id=p_agent
   and (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
    and a.action in ('create','call.manual_logged') order by a.id limit 1)=p_agent
 )
 select o.lead_id,
  max(o.started_at) filter (where o.connected and o.latest_of_kind=1),
  max(o.outcome) filter (where o.connected and o.latest_of_kind=1),
  max(o.started_at) filter (where o.latest=1),
  max(o.outcome) filter (where o.latest=1),
  bool_or(o.connected) filter (where o.latest=1)
 from own o join public.leads l on l.id=o.lead_id and l.deleted_at is null
 group by o.lead_id having bool_or(o.connected)
$$;

-- One agent's numbers, across every page: the directory and the agent's own
-- page show the same. Follow-ups due are pending ones due by the end of
-- today (Pakistan time), overdue ones included, on all the agent's leads, as
-- the dashboard's call activity counts them (update 038).
create or replace function public.agent_pipeline_numbers(p_agent uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 with spoken as (
  select s.lead_id,l.assigned_agent from public.agent_spoken_leads(p_agent) s join public.leads l on l.id=s.lead_id
 ), current_leads as (
  select s.lead_id,case tp.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end temperature
  from spoken s
  left join lateral (select t.tag from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=s.lead_id and t.tag in ('Hot lead','Warm lead','Cold lead')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) tp on true
  where s.assigned_agent=p_agent
 ), due as (
  select f.due_at from public.followups f join public.leads l on l.id=f.lead_id
  where l.assigned_agent=p_agent and l.deleted_at is null and f.status='pending'
   and f.due_at<(date_trunc('day',now() at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi'
 ), others as (
  -- The agent's leads with an answered call from someone else only: the
  -- agent's own Lead pipeline lists them, but they are not this agent's
  -- contacts. Each is named by who recorded its latest answered call: an
  -- administrator, another agent (before a reassignment), or no one on
  -- record (an older call without an audit entry).
  select lc.recorder,p.role recorder_role from public.leads l
  cross join lateral (select (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
     and a.action in ('create','call.manual_logged') order by a.id limit 1) recorder
    from public.calls c where c.lead_id=l.id and c.status='completed'
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc
  left join public.profiles p on p.id=lc.recorder
  where l.assigned_agent=p_agent and l.deleted_at is null
   and not exists(select 1 from spoken s where s.lead_id=l.id)
 )
 select jsonb_build_object(
  'contacted',(select count(*) from current_leads),
  'hot',(select count(*) from current_leads where temperature='hot'),
  'warm',(select count(*) from current_leads where temperature='warm'),
  'cold',(select count(*) from current_leads where temperature='cold'),
  'none',(select count(*) from current_leads where temperature is null),
  'followups_due',(select count(*) from due),
  'followups_overdue',(select count(*) from due where due_at<now()),
  'earlier',(select count(*) from spoken where assigned_agent is distinct from p_agent),
  'answered_by_others',(select count(*) from others),
  'answered_by_admins',(select count(*) from others where recorder_role='admin'),
  'answered_by_other_agents',(select count(*) from others where recorder is not null and recorder_role is distinct from 'admin'),
  'answered_unrecorded',(select count(*) from others where recorder is null))
$$;

-- ------------------------------------------------------- the directory
create or replace function public.admin_pipeline_agents(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_search text;v_like text;v_uid text;v_page integer;
 v_limit constant integer=20;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e
   where e.key not in ('search','page') or jsonb_typeof(e.value) not in ('string','number')) then
  raise exception 'Choose valid filters' using errcode='22023';end if;
 v_search=nullif(btrim(coalesce(q->>'search','')),'');
 begin
  v_page=coalesce((q->>'page')::integer,1);
 exception when others then raise exception 'Choose valid filters' using errcode='22023';
 end;
 if v_page not between 1 and 100000 or length(coalesce(v_search,''))>100 then
  raise exception 'Choose valid filters' using errcode='22023';end if;
 -- A name, or the first digits of a six-digit UID.
 if v_search is not null then
  v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  if v_search ~ '^[0-9]{1,6}$' then v_uid=v_search;end if;
 end if;
 with agents as (
  select p.id,p.uid,p.name,p.active from public.profiles p
  where p.role='agent' and p.deleted_at is null
   and (v_search is null or p.name ilike v_like or (v_uid is not null and p.uid::text like v_uid||'%'))
 ), ordered as (
  select g.*,row_number() over(order by g.active desc,lower(g.name),g.id) rn from agents g
 )
 select jsonb_build_object('page',v_page,'limit',v_limit,'count',(select count(*) from agents),
  -- Numbers for this page's agents only.
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'uid',o.uid,'name',o.name,'active',o.active)
    ||public.agent_pipeline_numbers(o.id) order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- ------------------------------------------------------- one agent
-- view 'current' (the default) takes search, temperature, outcome and page,
-- as the agent's own pipeline does; 'earlier' takes search and page.
-- Search: four or more digits are part of a contact number, anything else
-- part of the customer's name (update 053).
create or replace function public.admin_agent_pipeline(p_actor uuid,p_agent uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);agent public.profiles;v_view text;v_search text;v_temperature text;
 v_outcome text;v_page integer;v_limit constant integer=20;v_digits text;v_phone text;v_like text;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 select * into agent from public.profiles p where p.id=p_agent and p.role='agent' and p.deleted_at is null;
 if not found then raise exception 'Choose an agent from the list' using errcode='P0002';end if;
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e
   where e.key not in ('view','search','temperature','outcome','page') or jsonb_typeof(e.value) not in ('string','number')) then
  raise exception 'Choose valid pipeline filters' using errcode='22023';end if;
 v_view=coalesce(q->>'view','current');v_search=nullif(btrim(coalesce(q->>'search','')),'');
 v_temperature=q->>'temperature';v_outcome=q->>'outcome';
 begin
  v_page=coalesce((q->>'page')::integer,1);
 exception when others then raise exception 'Choose valid pipeline filters' using errcode='22023';
 end;
 if v_view not in ('current','earlier') or v_page not between 1 and 100000 or length(coalesce(v_search,''))>100
  or (v_temperature is not null and v_temperature not in ('hot','warm','cold','none'))
  or (v_outcome is not null and v_outcome not in ('No answer','Busy','Wrong number','Number off','Interested',
   'Not interested','Follow-up required','Site visit scheduled','Deal discussion'))
  or (v_view='earlier' and (v_temperature is not null or v_outcome is not null)) then
  raise exception 'Choose valid pipeline filters' using errcode='22023';end if;
 if v_search is not null then
  v_digits=regexp_replace(v_search,'[^0-9]','','g');
  if v_search ~ '^[0-9 ()+.-]+$' and length(v_digits) between 4 and 15 then
   v_phone=case when v_digits like '00%' and length(v_digits)>=12 then substr(v_digits,3)
    when v_digits like '03%' then '92'||substr(v_digits,2)
    when v_digits ~ '^3[0-9]{9}$' then '92'||v_digits else v_digits end;
  else
   v_digits=null;v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  end if;
 end if;
 with spoken as (
  select l.id,l.lead_no,l.name,l.email,l.masked_phone,l.assigned_agent,l.status,l.source,l.created_at,
   l.last_activity_at,l.assigned_at,s.contact_at,s.contact_outcome,s.last_call_at,s.last_call_outcome,s.last_call_connected
  from public.agent_spoken_leads(p_agent) s join public.leads l on l.id=s.lead_id
  where case when v_view='current' then l.assigned_agent=p_agent else l.assigned_agent is distinct from p_agent end
 ), matched as (
  select sp.*,
   case tp.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end temperature,
   tp.started_at temperature_at
  from spoken sp
  -- The lead's latest temperature, as in the agent's own pipeline.
  left join lateral (select t.tag,c.started_at from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where v_view='current' and c.lead_id=sp.id and t.tag in ('Hot lead','Warm lead','Cold lead')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) tp on true
  where (v_search is null
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=sp.id
     and (p.phone like '%'||v_digits||'%' or p.phone like '%'||v_phone||'%')))
    or (v_like is not null and sp.name ilike v_like))
   and (v_outcome is null or sp.last_call_outcome=v_outcome)
 ), hits as (
  select m.* from matched m where v_temperature is null or coalesce(m.temperature,'none')=v_temperature
 ), ordered as (
  select h.*,row_number() over(order by h.contact_at desc,h.lead_no desc) rn from hits h
 )
 select jsonb_build_object('agent',jsonb_build_object('id',agent.id,'uid',agent.uid,'name',agent.name,'active',agent.active),
  'view',v_view,'page',v_page,'limit',v_limit,'count',(select count(*) from hits),
  'summary',public.agent_pipeline_numbers(p_agent),
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'lead_no',o.lead_no,'name',o.name,'email',o.email,
     'masked_phone',o.masked_phone,'assigned_agent',o.assigned_agent,'status',o.status,'source',o.source,
     'created_at',o.created_at,'last_activity_at',o.last_activity_at,'assigned_at',o.assigned_at,
     'last_contact_at',o.contact_at,'last_contact_outcome',o.contact_outcome,
     'last_call_at',o.last_call_at,'last_call_outcome',o.last_call_outcome,'last_call_connected',o.last_call_connected,
     'temperature',o.temperature,'temperature_at',o.temperature_at,
     'next_followup_at',case when v_view='current' then (select min(f.due_at) from public.followups f
      where f.lead_id=o.id and f.status='pending') end,
     -- Earlier contacts: who has the lead now (null when no one).
     'owner',case when v_view='earlier' then public.report_person(o.assigned_agent) end)
     -- The agent's own latest note on the lead, as in update 053.
     ||coalesce((select jsonb_build_object('note',x.body,'note_at',x.at) from (
       select n.body,n.created_at at from public.notes n where n.lead_id=o.id and btrim(n.body)<>''
        and exists(select 1 from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text
         and a.action='create' and a.actor_id=p_agent)
       union all
       select c.notes,c.created_at from public.calls c where c.lead_id=o.id and btrim(coalesce(c.notes,''))<>''
        and exists(select 1 from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
         and a.action in ('create','call.manual_logged') and a.actor_id=p_agent)
      ) x order by x.at desc limit 1),jsonb_build_object('note',null,'note_at',null))
     order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- ------------------------------------------------ an agent's own pipeline
-- The agent's two counts, across every lead, and for the given leads of
-- theirs (one page) who recorded the latest answered call when it was not
-- the agent: 'admin', 'agent' (another agent, before a reassignment) or
-- 'unknown' (no audit entry: the caller is never guessed). Leads that are not
-- the agent's are left out.
create or replace function public.agent_pipeline_attribution(p_actor uuid,p_leads uuid[]) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_numbers jsonb;result jsonb;
begin
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if p_leads is null or cardinality(p_leads)>100 then raise exception 'Choose valid leads' using errcode='22023';end if;
 v_numbers=public.agent_pipeline_numbers(p_actor);
 select jsonb_build_object(
  'pipeline',(v_numbers->>'contacted')::integer+(v_numbers->>'answered_by_others')::integer,
  'personally_contacted',(v_numbers->>'contacted')::integer,
  'answered_by',coalesce(jsonb_object_agg(x.id::text,x.kind) filter (where x.kind is not null),'{}'::jsonb))
 into result
 from (select l.id,case when lc.id is null or w.recorder=p_actor then null when w.recorder is null then 'unknown'
    when r.role='admin' then 'admin' else 'agent' end kind
  from public.leads l
  left join lateral (select c.id from public.calls c where c.lead_id=l.id and c.status='completed'
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  left join lateral (select a.actor_id recorder from public.audit_log a where a.entity='calls' and a.entity_id=lc.id::text
   and a.action in ('create','call.manual_logged') order by a.id limit 1) w on true
  left join public.profiles r on r.id=w.recorder
  where l.id=any(p_leads) and l.assigned_agent=p_actor and l.deleted_at is null) x;
 return result;
end $$;

-- Browsers reach none of this; the server's service role calls only the
-- three API functions. The helpers are for the database owner and tests.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('agent_spoken_leads','agent_pipeline_numbers','admin_pipeline_agents','admin_agent_pipeline','agent_pipeline_attribution') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('admin_pipeline_agents','admin_agent_pipeline','agent_pipeline_attribution') then
   execute format('grant execute on function %s to service_role',f.signature);
  else execute format('revoke all on function %s from service_role',f.signature);end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
