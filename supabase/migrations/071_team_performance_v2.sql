-- Update 071: Team performance's eight columns, and selecting every
-- matching lead in Deleted leads for Delete instantly. Apply after 070.
-- Safe to rerun. No table, row, trigger, policy or index changes: only the
-- functions below.
--
-- Team performance (report_team_records, from update 063):
-- * Leads received counts only a change of agent. A lead given again to the
--   agent who already had it is not received again; New and From another
--   agent split the leads received as before.
-- * Moved away counts each lead once per agent: leads that went from the
--   agent to another agent in the period. A lead moved back to the
--   administrators, or deleted, has not moved to another agent; every move
--   stays in Assignment history.
-- * Follow-ups (followup_leads) counts leads, not calls: each lead whose
--   latest call in the agent's own assignment of it, saved by the end of the
--   period, ended Follow-up required. For a period still running that is the
--   lead's agent now; for an earlier period, the agent who had the lead at
--   its end, rebuilt from the assignment history.
-- * Time (report_team's worked_minutes) adds up the attendance of checked-out
--   days, as the Attendance totals do. A day without a checkout adds nothing
--   and is counted apart (open_days, incomplete_days).
-- Deleted leads (active_leads) count in none of them, and every record is
-- kept, so a restored lead counts again.
--
-- Deleted leads: deleted_lead_ids lists every lead a search of Deleted leads
-- matches (as deleted_leads_page finds them, up to 2,000), and
-- erase_deleted_leads_preview says what Delete instantly would erase. Both
-- only read. Erasing stays erase_deleted_leads (update 069), up to 500 leads
-- a call, each lead checked again then.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.kpi_facts(uuid,date,date,uuid,timestamp with time zone)') is null
  or to_regprocedure('public.report_team_records(text,uuid,timestamp with time zone,timestamp with time zone)') is null
  or to_regprocedure('public.erase_deleted_leads(uuid[],uuid,text)') is null
  or to_regprocedure('public.deleted_leads_page(uuid,integer,integer,text)') is null
  or to_regprocedure('public.workspace_since(uuid)') is null then
  raise exception 'Apply CRM updates up to 070 before update 071.';
 end if;
end $$;

-- Who had a lead just before a moment, from its assignment history, and
-- when their assignment of it began if another agent had it before them
-- (leads.assigned_at and workspace_since, as they read at that moment).
create or replace function public.team_owner_at(p_lead uuid,p_at timestamptz)
returns table(o_agent uuid,o_since timestamptz)
language sql stable security definer set search_path='' as $$
 with h as (
  select a.id,a.agent_id,a.created_at from public.assignments a where a.lead_id=p_lead and a.created_at<p_at
 ), cur as (
  select h.id,h.agent_id,h.created_at from h order by h.created_at desc,h.id desc limit 1
 ), brk as (
  -- The latest assignment before it to anyone else, or to no one.
  select h.id,h.created_at from h,cur where h.agent_id is distinct from cur.agent_id
  order by h.created_at desc,h.id desc limit 1
 ), run as (
  select min(h.created_at) start from h,cur where h.agent_id=cur.agent_id
   and not exists(select 1 from brk where (h.created_at,h.id)<=(brk.created_at,brk.id))
 )
 select cur.agent_id,case when exists(select 1 from h,run where h.agent_id is not null
   and h.agent_id<>cur.agent_id and h.created_at<run.start) then run.start end
 from cur,run where cur.agent_id is not null
$$;

-- Every lead a search of Deleted leads matches, in the page's order, so
-- "Select all matching" selects exactly what the pages list.
create or replace function public.deleted_lead_ids(p_actor uuid,p_search text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 perform public.accounts_admin(p_actor);
 if p_search is null or length(p_search)>100 then raise exception 'Invalid bin filters' using errcode='22023';end if;
 with eligible as(select l.id,l.deleted_at from public.leads l join public.profiles p on p.id=l.deleted_by where l.deleted_at is not null and (p_search='' or position(lower(p_search) in lower(l.name))>0 or public.format_lead_no(l.lead_no) ilike '%'||p_search||'%' or l.lead_no::text=ltrim(p_search,'0')))
 select jsonb_build_object('count',(select count(*) from eligible),'limit',2000,
  'ids',coalesce((select jsonb_agg(e.id order by e.deleted_at desc,e.id) from (select * from eligible order by deleted_at desc,id limit 2000) e),'[]'))
 into result;
 return result;
end $$;

-- What Delete instantly would erase now: which of the chosen leads can be
-- erased (in Deleted leads, no won deal), which cannot and why, and how many
-- of their records go with them. It changes nothing; erasing checks every
-- lead again.
create or replace function public.erase_deleted_leads_preview(p_actor uuid,p_lead_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;day_start timestamptz=date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';begin
 perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 2000 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–2,000 distinct leads' using errcode='22023';end if;
 with chosen as (
  select c.id,l.id lead_id,l.deleted_at,exists(select 1 from public.deals d where d.lead_id=l.id and d.stage='won') won
  from unnest(p_lead_ids) c(id) left join public.leads l on l.id=c.id
 ), ok as (select lead_id id from chosen where deleted_at is not null and not won)
 select jsonb_build_object(
  'selected',cardinality(p_lead_ids),
  'eligible',(select count(*) from ok),
  'eligible_ids',coalesce((select jsonb_agg(id order by id) from ok),'[]'),
  'won_deal',(select count(*) from chosen where deleted_at is not null and won),
  -- Restored since they were selected, or no longer in the CRM at all
  -- (already erased).
  'not_in_bin',(select count(*) from chosen where lead_id is not null and deleted_at is null),
  'missing',(select count(*) from chosen where lead_id is null),
  'records',jsonb_build_object(
   'calls',(select count(*) from public.calls c join ok on ok.id=c.lead_id),
   'recordings',(select count(*) from crm_private.recordings r join public.calls c on c.id=r.call_id join ok on ok.id=c.lead_id where r.deleted_at is null),
   'notes',(select count(*) from public.notes n join ok on ok.id=n.lead_id),
   'followups',(select count(*) from public.followups f join ok on ok.id=f.lead_id),
   'visits',(select count(*) from public.visits v join ok on ok.id=v.lead_id),
   'deals',(select count(*) from public.deals d join ok on ok.id=d.lead_id),
   'documents',(select count(*) from public.knowledge_documents k join ok on ok.id=k.lead_id)),
  -- Leads from a Google Sheet: the Sheet row keeps its receipt, so the
  -- next sync does not bring the lead back.
  'sheet_leads',(select count(distinct r.lead_id) from crm_private.sheet_lead_receipts r join ok on ok.id=r.lead_id),
  -- Today's permanent deletions so far; more than 50 in a Pakistan day
  -- raises the security alert (update 069).
  'erased_today',(select coalesce(sum((metadata->>'erased')::int),0)::int from public.audit_log
   where action in ('lead.erased','lead.file_erased') and created_at>=day_start),
  'alert_over',50)
 into result;
 return result;
end $$;

-- Small, checked edits, as in updates 061 to 070: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
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
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 071 found an unexpected version of %: apply CRM updates up to 070 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- Only the CRM's server calls the new functions; team_owner_at only from
-- the report.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('team_owner_at','deleted_lead_ids','erase_deleted_leads_preview') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname='team_owner_at' then
   execute format('revoke all on function %s from service_role',fn.signature);
  else
   execute format('grant execute on function %s to service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
