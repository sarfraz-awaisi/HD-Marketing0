-- Update 063: team reports administrators can trust, day by day, week by
-- week and month by month, and a dashboard that says what it counts.
-- Apply after 062. Safe to rerun.
--
-- * One source for every number and the records behind it:
--   report_team_records lists the records of a metric for an agent (or all
--   agents) in a period; report_team counts them per agent, report_team_days
--   per Pakistan day, and report_team_drilldown pages them.
-- * Leads received: unique leads per agent, each judged at its first arrival
--   in the period as first time or from another agent; every assignment
--   event stays in the agent's history.
-- * Calls belong to whoever recorded them (the audit log); a call with no
--   such record stays with the agent it is filed under. Calls an
--   administrator logs on an agent's lead are counted apart.
-- * First calls are the agent's own: an administrator's call never counts as
--   an agent's first call, on any lead. An administrator's answered call is
--   still a customer connection.
-- * Missed first-call deadlines are worked out from each assignment's
--   deadline and first call, so reports are right whether or not the
--   background job has stamped them. Existing stamps stay.
-- * Not connected (overdue): the deadline has passed and nobody has had an
--   answered call since the lead reached its current agent. All leads gets
--   this filter, and marks a last call from an earlier assignment.
-- * The dashboard pipeline counts every open lead by its current stage.
--
-- No table and no row changes. New: lead_not_connected,
-- report_team_records, report_team, report_team_days and
-- report_team_drilldown. Replaced: record_first_call, call_activity and
-- crm_metrics (update 039's). Checked edits: admin_lead_list,
-- report_today_records, report_agents and report_records.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text)') is null
  or to_regprocedure('public.lead_first_call_reopened(uuid)') is null
  or to_regprocedure('public.report_recorded_by(text,uuid)') is null
  or to_regprocedure('public.crm_metrics_038(uuid,timestamptz,timestamptz,uuid,text)') is null then
  raise exception 'Apply CRM updates up to 062 before update 063.';
 end if;
end $$;

-- ------------------------------------------------------- first calls
-- As in update 061, for every lead: an administrator's call is never the
-- agent's first call (it stays a customer connection).
create or replace function public.record_first_call() returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz;actor uuid=nullif(current_setting('hd.actor_id',true),'')::uuid;
begin
 if actor is distinct from new.agent_id and exists(select 1 from public.profiles p where p.id=actor and p.role='admin') then
  return null;end if;
 update public.leads l set first_call_at=greatest(new.started_at,l.assigned_at)
  where l.id=new.lead_id and l.assigned_agent=new.agent_id and l.first_call_at is null and l.assigned_at is not null
  returning l.first_call_at into stamp;
 if stamp is not null then
  update public.assignments a set first_call_at=stamp
   where a.id=(select x.id from public.assignments x where x.lead_id=new.lead_id order by x.created_at desc,x.id desc limit 1)
    and a.agent_id=new.agent_id and a.first_call_at is null;
 end if;
 return null;
end $$;

-- Overdue and not connected: the lead's first-call deadline has passed and
-- no one has had an answered call since it reached its current agent.
create or replace function public.lead_not_connected(p_lead uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select l.assigned_agent is not null and l.assigned_at is not null and l.call_due_at<now()
   and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))
   and not exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed' and c.created_at>=l.assigned_at)
  from public.active_leads l where l.id=p_lead),false)
$$;

-- ------------------------------------------------------- the records
-- The records behind one metric, for one agent (or every agent: p_agent
-- null), in a period. Each row names the agent it counts for (o_agent), so
-- every agent's numbers add up to the all-agents row. Deleted leads never
-- count. Metrics ending in _now describe the present, whatever the period.
create or replace function public.report_team_records(p_metric text,p_agent uuid,p_from timestamptz,p_to timestamptz)
returns table(o_lead uuid,o_kind text,o_record uuid,o_at timestamptz,o_agent uuid)
language plpgsql stable security definer set search_path='' as $$
begin
 if p_metric in ('received','received_first_time','received_reassigned') then
  -- One row per agent and lead: the lead's first arrival in the period,
  -- from another agent if any other agent had the lead before.
  return query
  with arrivals as (
   select distinct on (a.agent_id,a.lead_id) a.id,a.lead_id,a.agent_id,a.created_at
   from public.assignments a join public.active_leads l on l.id=a.lead_id
   where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.created_at>=p_from and a.created_at<p_to
   order by a.agent_id,a.lead_id,a.created_at,a.id
  )
  select x.lead_id,'assignment'::text,x.id,x.created_at,x.agent_id from arrivals x
  where p_metric='received' or (p_metric='received_reassigned')=exists(select 1 from public.assignments o
   where o.lead_id=x.lead_id and o.agent_id is not null and o.agent_id<>x.agent_id and (o.created_at,o.id)<(x.created_at,x.id));
 elsif p_metric in ('assignment_events','moved_away') then
  -- Assignments in the period with who had the lead just before.
  return query
  with moves as (
   select a.id,a.lead_id,a.agent_id,a.created_at,
    (select o.agent_id from public.assignments o where o.lead_id=a.lead_id and (o.created_at,o.id)<(a.created_at,a.id)
     order by o.created_at desc,o.id desc limit 1) before_agent
   from public.assignments a join public.active_leads l on l.id=a.lead_id
   where a.created_at>=p_from and a.created_at<p_to
  )
  -- Moved away counts for the agent who had the lead; an event in the
  -- history for the agent it concerns (the receiving agent, for all agents).
  select m.lead_id,'assignment'::text,m.id,m.created_at,
   case when p_metric='moved_away' then m.before_agent else coalesce(p_agent,m.agent_id,m.before_agent) end
  from moves m
  where case when p_metric='moved_away' then m.before_agent is not null and m.agent_id is distinct from m.before_agent
    and (p_agent is null or m.before_agent=p_agent)
   else (p_agent is null and (m.agent_id is not null or m.before_agent is not null))
    or m.agent_id=p_agent or (m.before_agent=p_agent and m.agent_id is distinct from p_agent) end;
 elsif p_metric in ('calls','answered','not_answered','interested','not_interested','followup_required','leads_called','leads_answered') then
  -- Calls an agent recorded (the audit log names who; a call with no such
  -- record stays with the agent it is filed under), by when they started.
  -- An agent records calls only on their own leads.
  return query
  with own as (
   select c.id,c.lead_id,c.started_at,c.created_at,r.who
   from public.calls c join public.active_leads l on l.id=c.lead_id
   cross join lateral (select coalesce(public.report_recorded_by('calls',c.id),c.agent_id) who) r
   join public.profiles p on p.id=r.who and p.role='agent'
   where (p_agent is null or c.agent_id=p_agent) and (p_agent is null or r.who=p_agent)
    and c.started_at>=p_from and c.started_at<p_to
    and case p_metric when 'answered' then c.status='completed' when 'leads_answered' then c.status='completed'
     when 'not_answered' then c.status<>'completed' when 'interested' then c.outcome='Interested'
     when 'not_interested' then c.outcome='Not interested' when 'followup_required' then c.outcome='Follow-up required'
     else true end
  )
  select o.lead_id,'call'::text,o.id,o.started_at,o.who from own o
  where p_metric not in ('leads_called','leads_answered') or o.id=(select x.id from own x where x.who=o.who and x.lead_id=o.lead_id
   order by x.started_at desc,x.created_at desc,x.id desc limit 1);
 elsif p_metric='admin_calls' then
  -- Calls an administrator logged on an agent's lead, counted for that
  -- agent's row but never as the agent's own.
  return query
  select c.lead_id,'call'::text,c.id,c.started_at,c.agent_id
  from public.calls c join public.active_leads l on l.id=c.lead_id
  join public.profiles ow on ow.id=c.agent_id and ow.role='agent'
  where (p_agent is null or c.agent_id=p_agent) and c.started_at>=p_from and c.started_at<p_to
   and exists(select 1 from public.profiles p where p.id=public.report_recorded_by('calls',c.id) and p.role='admin');
 elsif p_metric in ('first_calls','on_time') then
  return query
  select a.lead_id,'assignment'::text,a.id,a.first_call_at,a.agent_id
  from public.assignments a join public.active_leads l on l.id=a.lead_id
  where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.first_call_at>=p_from and a.first_call_at<p_to
   and (p_metric='first_calls' or (a.call_due_at is not null and a.first_call_at<=a.call_due_at));
 elsif p_metric='deadlines_missed' then
  -- The deadline fell in the period and has passed, the agent still had the
  -- lead then, and their first call came later or not at all. A lead won
  -- by then, or lost by then without having come from another agent, had
  -- no first call to make (update 061).
  return query
  select a.lead_id,'assignment'::text,a.id,a.call_due_at,a.agent_id
  from public.assignments a join public.active_leads l on l.id=a.lead_id
  where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent)
   and a.call_due_at>=p_from and a.call_due_at<p_to and a.call_due_at<now()
   and (a.first_call_at is null or a.first_call_at>a.call_due_at)
   and not exists(select 1 from public.assignments n where n.lead_id=a.lead_id and (n.created_at,n.id)>(a.created_at,a.id)
    and n.created_at<=a.call_due_at)
   and coalesce((select h.to_status from public.lead_status_history h where h.lead_id=a.lead_id and h.created_at<=a.call_due_at
     order by h.created_at desc,h.id desc limit 1),'new') not in ('won',
    case when exists(select 1 from public.assignments o where o.lead_id=a.lead_id and o.agent_id is not null
     and o.agent_id<>a.agent_id and (o.created_at,o.id)<(a.created_at,a.id)) then 'won' else 'lost' end);
 elsif p_metric='followups_created' then
  return query
  select f.lead_id,'followup'::text,f.id,f.created_at,r.who
  from public.followups f join public.active_leads l on l.id=f.lead_id
  cross join lateral (select public.report_recorded_by('followups',f.id) who) r
  join public.profiles p on p.id=r.who and p.role='agent'
  where (p_agent is null or r.who=p_agent) and f.created_at>=p_from and f.created_at<p_to;
 elsif p_metric='followups_completed' then
  return query
  select f.lead_id,'followup'::text,f.id,f.completed_at,f.agent_id
  from public.followups f join public.active_leads l on l.id=f.lead_id
  join public.profiles p on p.id=f.agent_id and p.role='agent'
  where (p_agent is null or f.agent_id=p_agent) and f.status='completed' and f.completed_at>=p_from and f.completed_at<p_to;
 elsif p_metric='notes' then
  return query
  select n.lead_id,'note'::text,n.id,n.created_at,au.actor_id
  from public.notes n join public.active_leads l on l.id=n.lead_id
  join lateral (select a.actor_id from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text and a.action='create'
   order by a.id limit 1) au on true
  join public.profiles p on p.id=au.actor_id and p.role='agent'
  where (p_agent is null or au.actor_id=p_agent) and n.created_at>=p_from and n.created_at<p_to;
 elsif p_metric='waiting_now' then
  return query
  select l.id,'lead'::text,null::uuid,l.call_due_at,l.assigned_agent from public.active_leads l
  where l.assigned_agent is not null and (p_agent is null or l.assigned_agent=p_agent)
   and l.first_call_at is null and l.call_due_at>=now() and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id));
 elsif p_metric in ('missed_now','idle_now') then
  return query
  select q.id,'lead'::text,null::uuid,q.since,q.assigned_agent from public.lead_review_queue q
  where (p_agent is null or q.assigned_agent=p_agent) and q.kind=case p_metric when 'missed_now' then 'missed' else 'idle' end;
 elsif p_metric='not_connected_now' then
  return query
  select l.id,'lead'::text,null::uuid,l.call_due_at,l.assigned_agent from public.active_leads l
  where l.assigned_agent is not null and (p_agent is null or l.assigned_agent=p_agent) and l.assigned_at is not null
   and l.call_due_at<now() and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))
   and not exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed' and c.created_at>=l.assigned_at);
 elsif p_metric='followups_overdue_now' then
  return query
  select f.lead_id,'followup'::text,f.id,f.due_at,l.assigned_agent
  from public.followups f join public.active_leads l on l.id=f.lead_id
  where l.assigned_agent is not null and (p_agent is null or l.assigned_agent=p_agent) and f.status='pending' and f.due_at<now();
 else
  raise exception 'Choose a report number to open' using errcode='22023';
 end if;
end $$;

-- ------------------------------------------------------- the reports
-- Every agent's numbers for a period (Pakistan days, as the caller sends
-- them), and the sum of all agents. Active agents are listed, and any other
-- agent with records in the period.
create or replace function public.report_team(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_metrics text[]=array['received','received_first_time','received_reassigned','moved_away',
 'calls','answered','not_answered','leads_called','leads_answered','interested','not_interested','followup_required',
 'admin_calls','first_calls','on_time','deadlines_missed','followups_created','followups_completed','notes',
 'waiting_now','missed_now','not_connected_now','followups_overdue_now'];result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '367 days' then
  raise exception 'Choose a date range of up to a year' using errcode='22023';end if;
 with counts as (
  select m.metric,r.o_agent agent_id,count(*) n
  from unnest(v_metrics) m(metric) cross join lateral public.report_team_records(m.metric,null,p_from,p_to) r
  group by 1,2
 ), talk as (
  select c.agent_id,round(coalesce(sum(c.duration_seconds),0)/60.0) minutes
  from public.report_team_records('answered',null,p_from,p_to) r join public.calls c on c.id=r.o_record group by 1
 ), speed as (
  select a.agent_id,round(avg(public.working_minutes(a.created_at,a.first_call_at))) minutes
  from public.report_team_records('first_calls',null,p_from,p_to) r join public.assignments a on a.id=r.o_record group by 1
 ), agents as (
  select p.id,p.name,p.uid,p.active from public.profiles p
  where p.role='agent' and ((p.active and p.deleted_at is null) or exists(select 1 from counts c where c.agent_id=p.id
   and c.metric not like '%\_now'))
 ), rows as (
  select g.id,g.name,jsonb_build_object('agent_id',g.id,'name',g.name,'uid',g.uid,'active',g.active)
   ||(select jsonb_object_agg(m.metric,coalesce(c.n,0)) from unnest(v_metrics) m(metric)
      left join counts c on c.metric=m.metric and c.agent_id=g.id)
   ||jsonb_build_object('talk_minutes',coalesce((select t.minutes from talk t where t.agent_id=g.id),0),
     'avg_first_call_minutes',(select s.minutes from speed s where s.agent_id=g.id)) data
  from agents g
 )
 select jsonb_build_object('from',p_from,'to',p_to,'metrics',to_jsonb(v_metrics),
  'agents',coalesce((select jsonb_agg(r.data order by lower(r.name),r.id) from rows r),'[]'::jsonb),
  -- The sum of the agents' rows: a lead two agents each received counts
  -- for both.
  'total',(select jsonb_object_agg(m.metric,coalesce((select sum((r.data->>m.metric)::bigint) from rows r),0))
   from unnest(v_metrics||array['talk_minutes']) m(metric)))
 into result;
 return result;
end $$;

-- One agent (or every agent) day by day, Pakistan days. Each record counts
-- on the day it happened, so the days add up to the period.
create or replace function public.report_team_days(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_metrics text[]=array['received','calls','answered','leads_called','first_calls','deadlines_missed',
 'followups_completed','notes'];result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '62 days' then
  raise exception 'Choose a date range of up to 62 days' using errcode='22023';end if;
 if p_agent is not null and not exists(select 1 from public.profiles p where p.id=p_agent and p.role='agent') then
  raise exception 'Choose an agent from the list' using errcode='22023';end if;
 with days as (
  select d::date pk_day from generate_series((p_from at time zone 'Asia/Karachi')::date,
   ((p_to at time zone 'Asia/Karachi')-interval '1 microsecond')::date,interval '1 day') d
 ), counts as (
  select m.metric,(r.o_at at time zone 'Asia/Karachi')::date pk_day,count(*) n
  from unnest(v_metrics) m(metric) cross join lateral public.report_team_records(m.metric,p_agent,p_from,p_to) r
  group by 1,2
 )
 select jsonb_build_object('metrics',to_jsonb(v_metrics),'days',coalesce(jsonb_agg(
   jsonb_build_object('day',d.pk_day)||(select jsonb_object_agg(m.metric,coalesce((select c.n from counts c
     where c.metric=m.metric and c.pk_day=d.pk_day),0)) from unnest(v_metrics) m(metric)) order by d.pk_day),'[]'::jsonb))
 into result from days d;
 return result;
end $$;

-- The records behind one number, 25 or 50 at a time: the record, its lead
-- and the agent it counts for. Administrators only.
create or replace function public.report_team_drilldown(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_metric text=q->>'metric';v_agent uuid;v_from timestamptz;v_to timestamptz;
 v_page integer;v_limit integer;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_object_keys(q) k where k not in ('metric','agent','from','to','page','limit'))
  or v_metric is null or v_metric not in ('received','received_first_time','received_reassigned','assignment_events','moved_away',
   'calls','answered','not_answered','leads_called','leads_answered','interested','not_interested','followup_required',
   'admin_calls','first_calls','on_time','deadlines_missed','followups_created','followups_completed','notes',
   'waiting_now','missed_now','not_connected_now','followups_overdue_now','idle_now') then
  raise exception 'Choose a report number to open' using errcode='22023';end if;
 begin
  v_agent=nullif(q->>'agent','')::uuid;v_from=(q->>'from')::timestamptz;v_to=(q->>'to')::timestamptz;
  v_page=coalesce((q->>'page')::integer,1);v_limit=coalesce((q->>'limit')::integer,25);
 exception when others then raise exception 'Choose a valid date range and page' using errcode='22023';
 end;
 if v_from is null or v_to is null or v_from>=v_to or v_to-v_from>interval '367 days'
  or v_page not between 1 and 100000 or v_limit not in (25,50) then
  raise exception 'Choose a valid date range and page' using errcode='22023';end if;
 if v_agent is not null and not exists(select 1 from public.profiles p where p.id=v_agent and p.role='agent') then
  raise exception 'Choose an agent from the list' using errcode='22023';end if;
 with recs as (
  select r.*,row_number() over(order by r.o_at desc nulls last,r.o_record,r.o_lead) rn
  from public.report_team_records(v_metric,v_agent,v_from,v_to) r
 )
 select jsonb_build_object('metric',v_metric,'count',(select count(*) from recs),'page',v_page,'limit',v_limit,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',coalesce(x.o_record,x.o_lead),'kind',x.o_kind,'at',x.o_at,
     'agent',public.report_person(x.o_agent),
     'lead',(select jsonb_build_object('id',l.id,'number',public.format_lead_no(l.lead_no),'name',l.name,'status',l.status,
       'assigned_agent',public.report_person(l.assigned_agent),'assigned_at',l.assigned_at,'call_due_at',l.call_due_at,
       'first_call_at',l.first_call_at) from public.leads l where l.id=x.o_lead),
     'record',case x.o_kind
      when 'call' then (select public.report_call_json(c) from public.calls c where c.id=x.o_record)
      when 'assignment' then (select jsonb_build_object('id',a.id,'at',a.created_at,'agent',public.report_person(a.agent_id),
        'from',(select public.report_person(o.agent_id) from public.assignments o where o.lead_id=a.lead_id
          and (o.created_at,o.id)<(a.created_at,a.id) order by o.created_at desc,o.id desc limit 1),
        'by',public.report_person(a.actor_id),'call_due_at',a.call_due_at,'first_call_at',a.first_call_at,
        -- How the move was made: the action of the same request.
        'how',(select s.action from public.audit_log m join public.audit_log s on s.request_id=m.request_id
          and s.action in ('lead.bulk_assigned','lead.bulk_distributed','assign_file','meta.bulk_assigned')
          where m.action='assign' and m.entity='leads' and m.entity_id=a.lead_id::text and m.created_at=a.created_at
          order by s.id limit 1))
        from public.assignments a where a.id=x.o_record)
      when 'followup' then (select jsonb_build_object('id',f.id,'due_at',f.due_at,'status',f.status,'completed_at',f.completed_at,
        'notes',left(f.notes,300),'agent',public.report_person(f.agent_id),
        'added_by',public.report_person(public.report_recorded_by('followups',f.id))) from public.followups f where f.id=x.o_record)
      when 'note' then (select jsonb_build_object('id',n.id,'body',left(n.body,300),'by',public.report_person(x.o_agent))
        from public.notes n where n.id=x.o_record)
     end) order by x.rn)
   from recs x where x.rn>(v_page-1)*v_limit and x.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- ------------------------------------------------------- the dashboard
-- As in updates 038 and 061, with the counting rules above: calls are the
-- agent's own (and an administrator's on the agent's leads apart), leads
-- received are unique, and Not connected (overdue) is shown beside Missed
-- first call.
create or replace function public.call_activity(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;s public.crm_settings;today date=(now() at time zone 'Asia/Karachi')::date;day_start timestamptz;
 day_end timestamptz;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 select * into s from public.crm_settings where id;
 day_start=today::timestamp at time zone 'Asia/Karachi';day_end=(today+1)::timestamp at time zone 'Asia/Karachi';
 select jsonb_build_object('date',today,'is_workday',extract(isodow from today)::smallint=any(s.work_days),
  'work_start',to_char(s.work_start,'HH24:MI'),'work_end',to_char(s.work_end,'HH24:MI'),'idle_days',s.idle_days,
  'from',day_start,'to',day_end,
  'agents',coalesce(jsonb_agg(x.data order by x.name,x.id),'[]'::jsonb)) into result
 from (select p.id,p.name,jsonb_build_object('agent_id',p.id,'name',p.name,'uid',p.uid,
   'received_today',(select count(*) from public.report_team_records('received',p.id,day_start,day_end)),
   'calls_today',(select count(*) from public.report_team_records('calls',p.id,day_start,day_end)),
   'connected_today',(select count(*) from public.report_team_records('answered',p.id,day_start,day_end)),
   'leads_called_today',(select count(*) from public.report_team_records('leads_called',p.id,day_start,day_end)),
   'admin_calls_today',(select count(*) from public.report_team_records('admin_calls',p.id,day_start,day_end)),
   'first_calls_today',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.first_call_at>=day_start),
   'assigned_today',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.created_at>=day_start),
   'waiting',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.first_call_at is null and l.call_due_at>=now() and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))),
   'missed',(select count(*) from public.lead_review_queue q where q.assigned_agent=p.id and q.kind='missed'),
   'not_connected',(select count(*) from public.report_team_records('not_connected_now',p.id,day_start,day_end)),
   'idle',(select count(*) from public.lead_review_queue q where q.assigned_agent=p.id and q.kind='idle'),
   'followups_due_today',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id where l.assigned_agent=p.id and f.status='pending' and f.due_at>=now() and f.due_at<day_start+interval '1 day'),
   'followups_overdue',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id where l.assigned_agent=p.id and f.status='pending' and f.due_at<now())) data
  from public.profiles p where p.active and p.role='agent' and (actor.role='admin' or p.id=p_actor)) x;
 return result;
end $$;

-- As in update 039, plus every open lead (not won or lost) by its current
-- stage, for the dashboard's pipeline: an agent's own, everyone's for an
-- administrator.
create or replace function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;scope uuid=p_agent;
begin
 result=public.crm_metrics_038(p_actor,p_from,p_to,p_agent,p_source);
 if exists(select 1 from public.profiles where id=p_actor and role='agent') then scope=p_actor;end if;
 return result||jsonb_build_object(
  'leads_contacted',(select count(distinct c.lead_id) from public.calls c join public.active_leads l on l.id=c.lead_id
   where c.started_at>=p_from and c.started_at<p_to and (scope is null or c.agent_id=scope) and (p_source is null or l.source=p_source)),
  'followups_completed',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id
   where f.status='completed' and f.completed_at>=p_from and f.completed_at<p_to and (scope is null or f.agent_id=scope) and (p_source is null or l.source=p_source)),
  'open_by_status',(select coalesce(jsonb_object_agg(x.status,x.n),'{}'::jsonb) from (
   select l.status,count(*) n from public.active_leads l where l.status not in ('won','lost')
    and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source) group by l.status) x));
end $$;

-- Small, checked edits to existing functions, as in update 061: each text
-- must appear exactly as many times as expected, or the update stops and
-- changes nothing. On a rerun the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- All leads: the Not connected (overdue) filter, and whether the last call
  -- came before the lead's current assignment.
  ('public.admin_lead_list(uuid,jsonb)',
   $t$or (v_call is not null and v_call not in ('uncalled','missed'))$t$,
   $t$or (v_call is not null and v_call not in ('uncalled','missed','not_connected'))$t$,1),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$and (v_call is null or (l.first_call_at is null$t$,
   $t$and (v_call is null or (v_call='not_connected' and public.lead_not_connected(l.id)) or (v_call<>'not_connected' and l.first_call_at is null$t$,1),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$left join lateral (select c.started_at,c.outcome,c.status from public.calls c where c.lead_id=l.id$t$,
   $t$left join lateral (select c.started_at,c.outcome,c.status,c.created_at from public.calls c where c.lead_id=l.id$t$,1),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$la.status='completed' last_call_connected$t$,
   $t$la.status='completed' last_call_connected,la.created_at<coalesce(l.assigned_at,'-infinity') last_call_earlier$t$,1),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$'last_call_connected',s.last_call_connected)$t$,
   $t$'last_call_connected',s.last_call_connected,'last_call_earlier',s.last_call_earlier)$t$,1),
  -- Today's calls behind the dashboard numbers: the agent's own.
  ('public.report_today_records(text,uuid)',
   $t$where c.agent_id=p_agent and c.started_at>=v_start$t$,
   $t$where c.agent_id=p_agent and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=p_agent and c.started_at>=v_start$t$,1),
  -- An agent's own activity report (update 039): calls they recorded.
  ('public.report_agents(uuid,timestamptz,timestamptz)',
   $t$where c.agent_id=p.id and $t$,
   $t$where c.agent_id=p.id and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=p.id and $t$,3),
  ('public.report_records(text,text,text,timestamptz,timestamptz,uuid,text)',
   $t$where c.agent_id=v_who and case when p_metric='calls'$t$,
   $t$where c.agent_id=v_who and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=v_who and case when p_metric='calls'$t$,1)
 ) v(signature,old_text,new_text,expected) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>item.expected then
   raise exception 'Update 063 found an unexpected version of %: apply CRM updates up to 062 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- ------------------------------------------------------- access
-- Browsers reach none of this. The server's service role calls the three
-- reports; the rest are helpers.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('lead_not_connected','report_team_records','report_team','report_team_days','report_team_drilldown') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('report_team','report_team_days','report_team_drilldown') then
   execute format('grant execute on function %s to service_role',f.signature);
  else execute format('revoke all on function %s from service_role',f.signature);end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
