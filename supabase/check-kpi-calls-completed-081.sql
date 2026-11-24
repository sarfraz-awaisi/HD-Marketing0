-- Read-only check for update 081 (the Daily KPI "Calls completed").
-- Changes nothing. Before: release_stage = 'at 080, ready for 081'. After:
-- 'at 081' with the KPI's rules, and yesterday's leads assigned to agents
-- and completed, as the KPI counts them (completed never above assigned).
with s as (select
  position('call_activity' in pg_get_functiondef('public.kpi_rules_problem(text,text,text,integer,boolean)'::regprocedure))>0 rules,
  position('call_activity' in pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure))>0 measures,
  exists(select 1 from public.kpi_versions where measure='call_activity') kpi,
  to_regprocedure('public.worker_lease(uuid,integer,text[])') is not null at_080,
  public.kpi_today(now())-1 d),
y as (select coalesce(sum((x->'call_activity'->>'assigned')::int),0) assigned,coalesce(sum((x->'call_activity'->>'completed')::int),0) completed
  from s,jsonb_array_elements(case when s.measures then public.kpi_measures(s.d,s.d,null,now()) else '[]'::jsonb end) x
  join public.profiles p on p.id=(x->>'agent_id')::uuid and p.role='agent')
select
 case when rules and measures and kpi then 'at 081'
  when not rules and not measures and not kpi and at_080 then 'at 080, ready for 081'
  else 'NOT READY: apply CRM updates up to 080 exactly' end release_stage,
 (select jsonb_build_object('title',k.title,'frequency',v.frequency,'answer_type',v.answer_type,'active',v.active,'from',v.effective_from)
   from public.kpis k join public.kpi_versions v on v.kpi_id=k.id where v.measure='call_activity' order by v.version desc limit 1) calls_completed_kpi,
 d yesterday,
 case when measures then y.assigned end assigned_yesterday,
 case when measures then y.completed end completed_yesterday,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s,y;
