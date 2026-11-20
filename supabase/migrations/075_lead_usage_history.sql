-- Update 075: Lead Usage on administrators' All leads, and each lead's agent
-- history. Apply after 074. Safe to rerun. No table, row or trigger
-- changes: one list is edited and one read-only function is added.
--
-- A lead's usage is the number of different sales agents it has ever been
-- assigned to: the distinct agents in its assignment history
-- (public.assignments, one row for every assignment and removal since
-- update 002), counted by account ID, so a former or disabled agent still
-- counts and a renamed one is not counted twice.
-- * A lead given back to an agent who had it before is not counted again:
--   Agent A, then B, then A again is used 2 times.
-- * Leaving a lead with no agent (the admin team) is not an agent:
--   A, then the admin team, then B is used 2 times.
-- * A lead in Deleted leads is never listed or counted; an erased lead no
--   longer exists. A restored lead keeps the history it had.
--
-- admin_lead_list (All leads) takes usage: 2, 3, 4 or 5, exactly that many
-- agents, never "at least". The Total, Assigned and Unassigned counts, the
-- pages and Select all follow it, as they follow the other filters. Each
-- list also returns usage: how many leads each choice would show with every
-- other search and filter applied (all: with no usage chosen), and each lead
-- its agents_used.
--
-- admin_lead_agent_history(actor, lead): for administrators only, a live
-- lead's assignment history as periods, oldest first, each with the
-- records made while it lasted, exactly as saved:
-- * a period starts with an assignment and lasts until the next one;
--   assigning the same agent again, with no one in between, stays one
--   period (assigned_again lists when);
-- * end: next (a later assignment ended it), current (it is the lead's
--   assignment now) or not_recorded. Moving a lead to Deleted leads
--   removes its agent without an assignment row (update 032), so after a
--   restore the end of that agent's period was never saved; it is reported,
--   never guessed;
-- * calls, notes, stage changes (lead_status_history), follow-ups, site
--   visits and deals are placed by when they were saved. Who recorded each
--   is its first audit entry (calls, notes, follow-ups, visits, deals) or
--   the row itself (stage changes); an administrator's call is filed under
--   the lead's agent but recorded by the administrator, and is reported as
--   the administrator's. Without a record, who did it is left empty;
-- * temperature is only ever saved with a call (update 052), so each call's
--   tags are its temperature at the time.
-- people names every account mentioned. No phone number, document or
-- recording is returned.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.lead_file_export_rows(uuid,uuid[])') is null
  or to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.accounts_admin(uuid)') is null then
  raise exception 'Apply CRM updates up to 074 before update 075.';
 end if;
end $$;

-- Small, checked edits, as in updates 061 to 068: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('v_temperature text;v_outcome text;',
   'v_temperature text;v_outcome text;v_usage integer;'),
  ($t$'page','ids','country')$t$,
   $t$'page','ids','country','usage')$t$),
  ($t$v_agent=(q->>'agent')::uuid;v_import=(q->>'import')::uuid;$t$,
   $t$v_agent=(q->>'agent')::uuid;v_import=(q->>'import')::uuid;v_usage=(q->>'usage')::integer;$t$),
  ($t$if v_page not between 1 and 100000 or length(coalesce(v_search,''))>100$t$,
   $t$if v_page not between 1 and 100000 or (v_usage is not null and v_usage not between 2 and 5) or length(coalesce(v_search,''))>100$t$),
  -- Each lead's distinct agents, ever.
  ('select l.id,l.assigned_agent,l.created_at,l.call_due_at,',
   $t$select l.id,l.assigned_agent,l.created_at,l.call_due_at,
   -- Update 075: the different agents the lead has been assigned to.
   (select count(distinct a.agent_id)::integer from public.assignments a where a.lead_id=l.id) used,$t$),
  -- Lead usage narrows everything after it, as the other filters do.
  ('), ordered as (',
   $t$), kept as (
  -- Update 075: Lead usage, exactly that many agents.
  select b.* from base b where v_usage is null or b.used=v_usage
 ), ordered as ($t$),
  ('select b.id,row_number() over(order by',
   'select b.id,b.used,row_number() over(order by'),
  ('from base b where b.matches',
   'from kept b where b.matches'),
  ('select o.rn,l.*,',
   'select o.rn,o.used agents_used,l.*,'),
  ($t$ select case when v_ids then jsonb_build_object('count',(select count(*) from base where matches),
   'ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from base where matches))
  else jsonb_build_object('page',v_page,'limit',v_limit,'count',(select count(*) from base where matches),
  'totals',(select jsonb_build_object('total',count(*),'assigned',count(assigned_agent),'unassigned',count(*)-count(assigned_agent)) from base),$t$,
   $t$ select case when v_ids then jsonb_build_object('count',(select count(*) from kept where matches),
   'ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from kept where matches))
  else jsonb_build_object('page',v_page,'limit',v_limit,'count',(select count(*) from kept where matches),
  'totals',(select jsonb_build_object('total',count(*),'assigned',count(assigned_agent),'unassigned',count(*)-count(assigned_agent)) from kept),
  -- Update 075: what each Lead usage choice would show, every other filter
  -- applied.
  'usage',(select jsonb_build_object('all',count(*),'2',count(*) filter (where used=2),'3',count(*) filter (where used=3),
   '4',count(*) filter (where used=4),'5',count(*) filter (where used=5)) from base where matches),$t$),
  ($t$'last_call_earlier',s.last_call_earlier)$t$,
   $t$'last_call_earlier',s.last_call_earlier,'agents_used',s.agents_used)$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 075 found an unexpected version of admin_lead_list: apply CRM updates up to 074 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- A live lead's assignment periods and what was recorded in each (above).
create or replace function public.admin_lead_agent_history(p_actor uuid,p_lead uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_lead public.leads;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 select * into v_lead from public.leads where id=p_lead and deleted_at is null;
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 with recorded as (
  select a.agent_id,a.actor_id,a.created_at,a.reason,a.first_call_at,a.missed_at,
   row_number() over(order by a.created_at,a.id) n
  from public.assignments a where a.lead_id=p_lead
 ), marked as (
  -- A new period whenever the lead goes to someone else (or to no one).
  select r.*,case when r.n>1 and r.agent_id is not distinct from lag(r.agent_id) over(order by r.n) then 0 else 1 end opens
  from recorded r
 ), numbered as (
  select m.*,sum(m.opens) over(order by m.n) seq from marked m
 ), periods as (
  -- Period 0: from the lead's creation to its first assignment.
  select 0::bigint seq,null::uuid agent_id,v_lead.created_at started_at,null::uuid assigned_by,null::text reason,
   '[]'::jsonb assigned_again,null::timestamptz first_call_at,null::timestamptz missed_at
  union all
  select x.seq,(array_agg(x.agent_id order by x.n))[1],min(x.created_at),(array_agg(x.actor_id order by x.n))[1],
   (array_agg(x.reason order by x.n))[1],
   coalesce(jsonb_agg(jsonb_build_object('at',x.created_at,'by',x.actor_id,'reason',x.reason) order by x.n)
    filter (where x.opens=0),'[]'::jsonb),
   min(x.first_call_at),min(x.missed_at)
  from numbered x group by x.seq
 ), spans as (
  select p.*,lead(p.started_at) over(order by p.seq) ended_at,p.seq=max(p.seq) over() is_last from periods p
 ), events as (
  select 'calls' kind,c.created_at at,c.id,jsonb_build_object('id',c.id,'started_at',c.started_at,'saved_at',c.created_at,
    'outcome',c.outcome,'status',c.status,'connected',c.status='completed','answered',c.answered,'method',c.method,
    'duration_seconds',c.duration_seconds,'notes',c.notes,'tags',to_jsonb(coalesce(c.deal_tags,'{}'::text[])),
    'missing_outcome',c.missing_outcome,'filed_under',c.agent_id,
    'recorded_by',(select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
     and a.action in ('create','call.manual_logged') order by a.id limit 1)) item
  from public.calls c where c.lead_id=p_lead
  union all
  select 'notes',n.created_at,n.id,jsonb_build_object('id',n.id,'at',n.created_at,'body',n.body,
    'written_by',(select a.actor_id from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text
     and a.action='create' order by a.id limit 1))
  from public.notes n where n.lead_id=p_lead
  union all
  select 'status_changes',h.created_at,h.id,jsonb_build_object('id',h.id,'at',h.created_at,'from',h.from_status,
    'to',h.to_status,'lost_reason',h.lost_reason,'by',h.actor_id)
  from public.lead_status_history h where h.lead_id=p_lead
  union all
  select 'followups',f.created_at,f.id,jsonb_build_object('id',f.id,'created_at',f.created_at,'due_at',f.due_at,
    'status',f.status,'completed_at',f.completed_at,'notes',f.notes,'responsible',f.agent_id,
    'created_by',(select a.actor_id from public.audit_log a where a.entity='followups' and a.entity_id=f.id::text
     and a.action='create' order by a.id limit 1),
    'cancelled_on_reassignment',exists(select 1 from public.audit_log a where a.entity='followups'
     and a.entity_id=f.id::text and a.action='followup.reassignment_cancelled'))
  from public.followups f where f.lead_id=p_lead
  union all
  select 'visits',v.created_at,v.id,jsonb_build_object('id',v.id,'created_at',v.created_at,'scheduled_at',v.scheduled_at,
    'status',v.status,'notes',v.notes,'responsible',v.agent_id,'property',p.title,
    'created_by',(select a.actor_id from public.audit_log a where a.entity='visits' and a.entity_id=v.id::text
     and a.action='create' order by a.id limit 1),
    'cancelled_on_reassignment',exists(select 1 from public.audit_log a where a.entity='visits'
     and a.entity_id=v.id::text and a.action='visit.reassignment_cancelled'))
  from public.visits v left join public.properties p on p.id=v.property_id where v.lead_id=p_lead
  union all
  select 'deals',d.created_at,d.id,jsonb_build_object('id',d.id,'created_at',d.created_at,'updated_at',d.updated_at,
    'stage',d.stage,'expected_value',d.expected_value,'close_date',d.close_date,'notes',d.notes,
    'lost_reason',d.lost_reason,'lost_note',d.lost_note,'responsible',d.agent_id,'property',p.title,
    'created_by',(select a.actor_id from public.audit_log a where a.entity='deals' and a.entity_id=d.id::text
     and a.action='create' order by a.id limit 1))
  from public.deals d left join public.properties p on p.id=d.property_id where d.lead_id=p_lead
 ), placed as (
  -- Each record in the period it was saved in.
  select e.*,coalesce((select s.seq from spans s where s.started_at<=e.at order by s.seq desc limit 1),0) seq from events e
 ), people as (
  select r.agent_id id from recorded r union select r.actor_id from recorded r
  union select (e.item->>k)::uuid from placed e
   cross join unnest(array['filed_under','recorded_by','written_by','by','responsible','created_by']) k
   where e.item->>k is not null
  union select v_lead.assigned_agent
 )
 select jsonb_build_object(
  'lead',jsonb_build_object('id',v_lead.id,'lead_no',v_lead.lead_no,'name',v_lead.name,'status',v_lead.status,
   'created_at',v_lead.created_at,'assigned_agent',v_lead.assigned_agent,'assigned_at',v_lead.assigned_at),
  'agents_used',(select count(distinct r.agent_id) from recorded r),
  -- The current agent is the latest assignment's (false only if the lead
  -- has an agent no assignment recorded).
  'current_recorded',v_lead.assigned_agent is null
   or v_lead.assigned_agent is not distinct from (select r.agent_id from recorded r order by r.n desc limit 1),
  'periods',coalesce((select jsonb_agg(jsonb_build_object(
    'seq',s.seq,'kind',case when s.seq=0 then 'before' when s.agent_id is null then 'admin_team' else 'agent' end,
    'agent_id',s.agent_id,'started_at',s.started_at,'ended_at',s.ended_at,
    'end',case when not s.is_last then 'next'
     when s.agent_id is not distinct from v_lead.assigned_agent then 'current' else 'not_recorded' end,
    'assigned_by',s.assigned_by,'reason',s.reason,'assigned_again',s.assigned_again,
    'first_call_at',s.first_call_at,'missed_at',s.missed_at,
    'calls',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='calls'),'[]'::jsonb),
    'notes',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='notes'),'[]'::jsonb),
    'status_changes',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='status_changes'),'[]'::jsonb),
    'followups',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='followups'),'[]'::jsonb),
    'visits',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='visits'),'[]'::jsonb),
    'deals',coalesce((select jsonb_agg(e.item order by e.at,e.id) from placed e where e.seq=s.seq and e.kind='deals'),'[]'::jsonb))
    order by s.seq) from spans s
   -- Before the first assignment only when something was saved then, or
   -- the lead has never had one.
   where s.seq>0 or s.is_last or exists(select 1 from placed e where e.seq=0)),'[]'::jsonb),
  'people',coalesce((select jsonb_object_agg(p.id::text,jsonb_build_object('name',p.name,'uid',p.uid,'role',p.role,
    'active',p.active,'deleted',p.deleted_at is not null)) from public.profiles p where p.id in (select x.id from people x)),'{}'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.admin_lead_agent_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_lead_agent_history(uuid,uuid) to service_role;
commit;
