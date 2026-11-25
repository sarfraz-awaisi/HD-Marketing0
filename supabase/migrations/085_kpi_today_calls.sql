-- Update 085: Today calls on administrators' Daily KPI results, next to
-- Calls completed. Apply after 084. Safe to rerun. No table, row, KPI or
-- answer is changed: one read-only function gets one more count.
--
-- kpi_measures returns today_calls per agent and Pakistan day: every call
-- the agent saved an outcome for that day, on any lead (newly assigned or
-- older), each call once, so a lead called twice counts twice. As in
-- Calls completed (update 081): any outcome counts (No answer and Busy
-- too), the day is when the call was saved, a call counts for whoever
-- logged it, and leads in Deleted leads do not count. The results show
-- today's count, as a plain number, whatever period is chosen. It is a
-- count to read, not a KPI: no target, answers or Overall change.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.kpi_measures(date,date,uuid,timestamp with time zone)') is null
  or position('call_activity' in pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure))=0
  or to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is null then
  raise exception 'Apply CRM updates up to 084 before update 085.';
 end if;
end $$;
-- Checked edits, as in updates 061 to 084: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- Each edit leaves update 081's edited text whole, so 081 still reruns
  -- as a no-op.
  ($t$ ), act as ($t$,
   $t$ ), made as (
  -- Update 085: every call the agent saved an outcome for that day, on any
  -- lead, each call once.
  select x.agent_id,x.day,count(*)::integer n from (
   select coalesce(public.report_recorded_by('calls',c.id),c.agent_id) agent_id,(c.created_at at time zone 'Asia/Karachi')::date as day
   from public.calls c join public.active_leads l on l.id=c.lead_id,bounds b
   where c.outcome is not null and c.created_at>=b.lo and c.created_at<b.hi) x
  where x.agent_id is not null and (p_agent is null or x.agent_id=p_agent)
  group by 1,2
 ), act as ($t$),
  ($t$union select agent_id,day from act$t$,
   $t$union select agent_id,day from act union select agent_id,day from made$t$),
  ($t$and a.day=k.day)) order by k.agent_id,k.day)$t$,
   $t$and a.day=k.day))||jsonb_build_object('today_calls',(select m.n from made m where m.agent_id=k.agent_id and m.day=k.day))
  order by k.agent_id,k.day)$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 085 found an unexpected version of kpi_measures: apply CRM updates up to 084 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
