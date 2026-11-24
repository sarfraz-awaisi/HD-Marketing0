-- Update 081: the Daily KPI "Calls completed": did the agent call, the same
-- day, every lead assigned to them that day? Apply after 080. Safe to
-- rerun. No call, lead or answer is changed.
--
-- * A new way for the CRM to measure a KPI, call_activity, per agent and
--   Pakistan day:
--   - assigned: the leads given to the agent that day (once each), unless
--     moved to someone else that day before the agent called them;
--   - completed: those for which the agent saved a call outcome after
--     receiving them, that same day. Any outcome counts (No answer and Busy
--     too); more calls to the same lead, or calls to older leads, do not
--     add to it.
--   Deleted leads do not count, as in Reports. A call counts for whoever
--   logged it (an administrator's call on an agent's lead counts for the
--   administrator), as Team performance and the first-call deadline count
--   calls (updates 061, 063).
-- * It is a daily Yes/No with no fixed target: Yes when every lead
--   assigned that day was completed that day; a day with nothing assigned
--   has nothing to complete and is not missed.
-- * kpi_measures returns it with the other measures (call_activity), for
--   the facts the Daily KPI pages already read; an agent's facts hold only
--   their own work.
-- * The KPI "Calls completed" is added once, after the first-call deadline
--   KPI, from the first day of Daily KPIs, so earlier days show their real
--   counts.
-- * The first-call deadline KPI ("calls") is unchanged.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.worker_lease(uuid,integer,text[])') is null
  or to_regprocedure('public.kpi_measures(date,date,uuid,timestamp with time zone)') is null
  or to_regprocedure('public.kpi_rules_problem(text,text,text,integer,boolean)') is null then
  raise exception 'Apply CRM updates up to 080 before update 081.';
 end if;
end $$;

-- The table accepts the new measure (daily Yes/No, as the first-call
-- deadline), with update 076's other rules unchanged.
alter table public.kpi_versions drop constraint if exists kpi_versions_measure;
alter table public.kpi_versions add constraint kpi_versions_measure check(
 measure='self'
 or ((answer_type='number' or expect_yes) and (
  (measure in ('calls','call_activity') and frequency='day' and answer_type='yes_no')
  or measure in ('inventory','visits')
  or (measure='social' and (answer_type='yes_no' or target<=case frequency when 'day' then 5 else 35 end))
  or (measure='video' and (answer_type='yes_no' or target<=case frequency when 'day' then 2 else 20 end)))));

-- Checked edits, as in updates 061 to 080: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('public.kpi_rules_problem(text,text,text,integer,boolean)',
   $t$when p_measure not in ('calls','social','inventory','visits','video') then$t$,
   $t$when p_measure not in ('calls','social','inventory','visits','video','call_activity') then$t$),
  ('public.kpi_rules_problem(text,text,text,integer,boolean)',
   $t$  when p_measure='social' and p_answer_type='number'$t$,
   $t$  when p_measure='call_activity' and p_frequency<>'day' then
   'Calls completed is decided day by day: Yes when every lead assigned that day was called that day. There is no rule for a whole week, so it stays Daily.'
  when p_measure='call_activity' and p_answer_type<>'yes_no' then
   'Calls completed has no fixed number: each day''s assigned leads are its target. Keep Yes / No; each day still shows the calls assigned and completed.'
  when p_measure='social' and p_answer_type='number'$t$),
  ('public.kpi_measures(date,date,uuid,timestamp with time zone)',
   $t$ ), keys as ($t$,
   $t$ ), act as (
  -- Update 081: the leads given to the agent that day, once each, and those
  -- the agent saved a call outcome for after receiving them, that same day.
  -- One moved to someone else that day before the agent called it is not
  -- theirs to complete.
  select g.agent_id,g.day,jsonb_build_object('assigned',count(*) filter(where g.done or g.kept),
   'completed',count(*) filter(where g.done)) v
  from (select g.*,
    exists(select 1 from public.calls c where c.lead_id=g.lead_id and c.outcome is not null
     and c.created_at>=g.assigned_at and c.created_at<((g.day+1)::timestamp at time zone 'Asia/Karachi')
     and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=g.agent_id) done,
    (select n.agent_id from public.assignments n where n.lead_id=g.lead_id and n.created_at<((g.day+1)::timestamp at time zone 'Asia/Karachi')
     order by n.created_at desc,n.id desc limit 1) is not distinct from g.agent_id kept
   from (select a.agent_id,(a.created_at at time zone 'Asia/Karachi')::date as day,a.lead_id,min(a.created_at) assigned_at
    from public.assignments a join public.active_leads l on l.id=a.lead_id,bounds b
    where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.created_at>=b.lo and a.created_at<b.hi
    group by 1,2,3) g) g
  group by 1,2
 ), keys as ($t$),
  ('public.kpi_measures(date,date,uuid,timestamp with time zone)',
   $t$select agent_id,day from calls union select agent_id,day from ev union select agent_id,day from inv$t$,
   $t$select agent_id,day from calls union select agent_id,day from ev union select agent_id,day from inv union select agent_id,day from act$t$),
  ('public.kpi_measures(date,date,uuid,timestamp with time zone)',
   $t$'inventory',(select i.v from inv i where i.agent_id=k.agent_id and i.day=k.day))$t$,
   $t$'inventory',(select i.v from inv i where i.agent_id=k.agent_id and i.day=k.day),
   'call_activity',(select a.v from act a where a.agent_id=k.agent_id and a.day=k.day))$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 081 found an unexpected version of %: apply CRM updates up to 080 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- The KPI "Calls completed", once (also when an administrator archived it).
-- It counts from the first day of Daily KPIs, so earlier days show the work
-- done then: the counts come from the saved records, and no agent answers it.
do $seed$
declare since date=coalesce((select min(effective_from) from public.kpi_versions),public.kpi_today(now()));k uuid;place integer;
begin
 if exists(select 1 from public.kpi_versions where measure='call_activity') then return;end if;
 select coalesce((select k.position from public.kpis k join public.kpi_versions v on v.kpi_id=k.id
   where v.measure='calls' and k.archived_at is null order by k.position limit 1),
  (select coalesce(max(position),0)+1 from public.kpis)) into place;
 insert into public.kpis(title,question,description,position)
  values('Calls completed','Did you complete all the calls assigned to you today?',
   'Filled in by the CRM: Yes when you saved a call outcome, the same day, for every lead assigned to you that day. Any outcome counts (No answer and Busy too).',
   place) returning id into k;
 insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,measure)
  values(k,1,since,'day','yes_no',1,'call_activity');
 insert into public.audit_log(action,entity,entity_id,metadata)
  values('kpi.measured_by_crm','kpis',k::text,jsonb_build_object('title','Calls completed','measure','call_activity'));
end $seed$;
commit;
