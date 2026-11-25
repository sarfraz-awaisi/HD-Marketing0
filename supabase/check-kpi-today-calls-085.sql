-- Read-only check for update 085 (Today calls on Daily KPI results).
-- Changes nothing and shows counts only. Before: release_stage = 'at 084,
-- ready for 085'. After: 'at 085', and today's saved calls in total.
with s as (select
  position('today_calls' in pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure))>0 at_085,
  to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is not null at_084,
  ((now() at time zone 'Asia/Karachi')::date) today)
select
 case when at_085 then 'at 085'
  when at_084 then 'at 084, ready for 085'
  else 'NOT READY: apply CRM updates up to 084 exactly' end release_stage,
 case when at_085 then (select coalesce(sum((m->>'today_calls')::int),0)
  from jsonb_array_elements(public.kpi_measures(today,today,null,now())) m) end today_calls_total,
 (select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id
  where c.outcome is not null and (c.created_at at time zone 'Asia/Karachi')::date=today) calls_saved_today,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
