-- Read-only check for update 071 (Team performance's eight columns and
-- selecting every matching deleted lead). Run it in the CRM's Supabase SQL
-- Editor before 071 and right after it. It is one SELECT: it changes nothing,
-- reads function definitions and returns flags and counts only, never a
-- customer's details.
-- Before 071: release_stage = 'at 070, ready for 071', edits_ready = 9,
-- edits_unexpected = 0 and transactions_open_over_1_min = 0.
-- After 071: release_stage = 'at 071' and edits_applied = 9.
-- The counts say how much the new rules change: same_agent_reassignments
-- (no longer counted as received), moves_to_administrators (no longer
-- counted as moved away), and how many leads are in Deleted leads.
with edits(signature,old_text,new_text) as (values
  -- Leads received: a change of agent only.
  ('public.report_team_records(text,uuid,timestamp with time zone,timestamp with time zone)',
   $t$   where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.created_at>=p_from and a.created_at<p_to
   order by a.agent_id,a.lead_id,a.created_at,a.id$t$,
   $t$   where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.created_at>=p_from and a.created_at<p_to
    -- Update 071: a change of agent only; the lead given again to the agent
    -- who already had it is not received again.
    and a.agent_id is distinct from (select o.agent_id from public.assignments o where o.lead_id=a.lead_id
     and (o.created_at,o.id)<(a.created_at,a.id) order by o.created_at desc,o.id desc limit 1)
   order by a.agent_id,a.lead_id,a.created_at,a.id$t$),
  -- Moved away: each lead once, to another agent; and Follow-ups.
  ('public.report_team_records(text,uuid,timestamp with time zone,timestamp with time zone)',
   $t$ elsif p_metric in ('assignment_events','moved_away') then$t$,
   $t$ elsif p_metric='moved_away' then
  -- Update 071: each lead once for the agent who had it, the first time in
  -- the period it went from them to another agent. A lead moved back to the
  -- administrators, or deleted, has not moved to another agent.
  return query
  select distinct on (m.before_agent,m.lead_id) m.lead_id,'assignment'::text,m.id,m.created_at,m.before_agent
  from (select a.id,a.lead_id,a.agent_id,a.created_at,
    (select o.agent_id from public.assignments o where o.lead_id=a.lead_id and (o.created_at,o.id)<(a.created_at,a.id)
     order by o.created_at desc,o.id desc limit 1) before_agent
   from public.assignments a join public.active_leads l on l.id=a.lead_id
   where a.agent_id is not null and a.created_at>=p_from and a.created_at<p_to) m
  where m.before_agent is not null and m.before_agent<>m.agent_id and (p_agent is null or m.before_agent=p_agent)
  order by m.before_agent,m.lead_id,m.created_at,m.id;
 elsif p_metric='followup_leads' then
  -- Update 071: Follow-ups. Each lead once: those whose latest call in the
  -- agent's own assignment of it (an earlier agent's calls do not count
  -- after a move, as in update 061), saved by the end of the period, ended
  -- Follow-up required. A later call with another outcome, from the agent
  -- or an administrator, ends it. A period still running reads the lead's
  -- agent now; an earlier one, the agent who had it at the period's end.
  return query
  with cand as (
   select l.id,l.assigned_agent from public.active_leads l
   where exists(select 1 from public.calls f where f.lead_id=l.id and f.outcome='Follow-up required'
    and f.created_at<least(p_to,now()))
  )
  select x.id,'call'::text,c.id,c.started_at,o.o_agent
  from cand x
  cross join lateral (
   select x.assigned_agent o_agent,public.workspace_since(x.id) o_since where p_to>now()
   union all
   select t.o_agent,t.o_since from public.team_owner_at(x.id,p_to) t where p_to<=now()
  ) o
  join public.profiles p on p.id=o.o_agent and p.role='agent'
  cross join lateral (
   select y.id,y.outcome,y.started_at from public.calls y where y.lead_id=x.id and y.created_at<least(p_to,now())
    and (o.o_since is null or y.created_at>=o.o_since)
   order by y.started_at desc,y.created_at desc,y.id desc limit 1
  ) c
  where (p_agent is null or o.o_agent=p_agent) and c.outcome='Follow-up required';
 elsif p_metric='assignment_events' then$t$),
  ('public.report_team_records(text,uuid,timestamp with time zone,timestamp with time zone)',
   $t$  -- Moved away counts for the agent who had the lead; an event in the
  -- history for the agent it concerns (the receiving agent, for all agents).
  select m.lead_id,'assignment'::text,m.id,m.created_at,
   case when p_metric='moved_away' then m.before_agent else coalesce(p_agent,m.agent_id,m.before_agent) end
  from moves m
  where case when p_metric='moved_away' then m.before_agent is not null and m.agent_id is distinct from m.before_agent
    and (p_agent is null or m.before_agent=p_agent)
   else (p_agent is null and (m.agent_id is not null or m.before_agent is not null))
    or m.agent_id=p_agent or (m.before_agent=p_agent and m.agent_id is distinct from p_agent) end;$t$,
   $t$  -- An event in the history for the agent it concerns (the receiving
  -- agent, for all agents).
  select m.lead_id,'assignment'::text,m.id,m.created_at,coalesce(p_agent,m.agent_id,m.before_agent)
  from moves m
  where (p_agent is null and (m.agent_id is not null or m.before_agent is not null))
   or m.agent_id=p_agent or (m.before_agent=p_agent and m.agent_id is distinct from p_agent);$t$),
  -- report_team: Follow-ups and Time.
  ('public.report_team(uuid,timestamp with time zone,timestamp with time zone)',
   $t$'waiting_now','missed_now','not_connected_now','followups_overdue_now'];result jsonb;$t$,
   $t$'waiting_now','missed_now','not_connected_now','followups_overdue_now','followup_leads'];result jsonb;$t$),
  ('public.report_team(uuid,timestamp with time zone,timestamp with time zone)',
   $t$ ), agents as ($t$,
   $t$ ), work as (
  -- Update 071: Time, the attendance of the period's Pakistan days. Only a
  -- checked-out day has worked minutes; one still open or never checked
  -- out adds nothing and is counted apart.
  select d.user_id,coalesce(sum(d.worked_minutes) filter(where d.state='checked_out'),0) minutes,
   count(*) filter(where d.state='checked_in') open_days,count(*) filter(where d.state='incomplete') incomplete_days,
   bool_or(d.tracked) tracked
  from public.attendance_days((p_from at time zone 'Asia/Karachi')::date,
   ((p_to at time zone 'Asia/Karachi')-interval '1 microsecond')::date,null,now()) d
  group by 1
 ), agents as ($t$),
  ('public.report_team(uuid,timestamp with time zone,timestamp with time zone)',
   $t$   and c.metric not like '%\_now'))$t$,
   $t$   and c.metric not like '%\_now') or exists(select 1 from work w where w.user_id=p.id and w.minutes>0))$t$),
  ('public.report_team(uuid,timestamp with time zone,timestamp with time zone)',
   $t$     'avg_first_call_minutes',(select s.minutes from speed s where s.agent_id=g.id)) data$t$,
   $t$     'avg_first_call_minutes',(select s.minutes from speed s where s.agent_id=g.id))
   ||(select jsonb_build_object('worked_minutes',coalesce(max(w.minutes),0),'open_days',coalesce(max(w.open_days),0),
     'incomplete_days',coalesce(max(w.incomplete_days),0),'attendance_tracked',coalesce(bool_or(w.tracked),false))
     from work w where w.user_id=g.id) data$t$),
  ('public.report_team(uuid,timestamp with time zone,timestamp with time zone)',
   $t$   from unnest(v_metrics||array['talk_minutes']) m(metric)))$t$,
   $t$   from unnest(v_metrics||array['talk_minutes','worked_minutes','open_days','incomplete_days']) m(metric)))$t$),
  -- The records behind Follow-ups.
  ('public.report_team_drilldown(uuid,jsonb)',
   $t$'waiting_now','missed_now','not_connected_now','followups_overdue_now','idle_now') then$t$,
   $t$'waiting_now','missed_now','not_connected_now','followups_overdue_now','idle_now','followup_leads') then$t$)
), defs as (
 select e.*,case when to_regprocedure(e.signature) is null then null else pg_get_functiondef(to_regprocedure(e.signature)) end body from edits e
), states as (
 select case when body is null then 'missing'
  when position(new_text in body)>0 then 'applied'
  when (length(body)-length(replace(body,old_text,'')))/length(old_text)=1 then 'ready'
  else 'unexpected' end state from defs
)
select
 case
  when to_regprocedure('public.erase_deleted_leads_preview(uuid,uuid[])') is not null
   and (select count(*) from states where state='applied')=(select count(*) from edits) then 'at 071'
  when to_regprocedure('public.kpi_facts(uuid,date,date,uuid,timestamp with time zone)') is not null
   and (select count(*) from states where state='ready')=(select count(*) from edits) then 'at 070, ready for 071'
  else 'NOT READY: see edits_unexpected; apply CRM updates up to 070 exactly'
 end as release_stage,
 (select count(*) from states where state='ready') as edits_ready,
 (select count(*) from states where state='applied') as edits_applied,
 (select count(*) from states where state in ('unexpected','missing')) as edits_unexpected,
 (select count(*) from (select a.agent_id,lag(a.agent_id) over(partition by a.lead_id order by a.created_at,a.id) prev
   from public.assignments a) x where x.agent_id is not null and x.agent_id=x.prev) as same_agent_reassignments,
 (select count(*) from (select a.agent_id,lag(a.agent_id) over(partition by a.lead_id order by a.created_at,a.id) prev
   from public.assignments a) x where x.agent_id is null and x.prev is not null) as moves_to_administrators,
 (select count(*) from public.leads where deleted_at is not null) as leads_in_deleted_leads,
 (select count(*) from public.leads where deleted_at<now()-interval '14 days') as deleted_over_14_days_ago,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
