-- Read-only check for update 086 (Select all up to 2,000 leads on Never
-- assigned, and selecting the first leads of a list). Changes nothing and
-- shows counts only, no customer details. Before: release_stage = 'at 085,
-- ready for 086' and edits_fit true. After: 'at 086'. most_never_assigned
-- is the most leads any one active agent has never had: Select all covers
-- them when it is 2,000 or fewer.
with s as (select
  pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure) body,
  to_regprocedure('public.kpi_measures(date,date,uuid,timestamp with time zone)') is not null
   and position('today_calls' in pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure))>0 at_085),
had as (select a.agent_id,a.lead_id from public.assignments a join public.active_leads l on l.id=a.lead_id
  union select l.assigned_agent,l.id from public.active_leads l where l.assigned_agent is not null)
select
 case when position('v_first' in body)>0 then 'at 086'
  when at_085 and position('never_assigned' in body)>0 then 'at 085, ready for 086'
  else 'NOT READY: apply CRM updates up to 085 exactly' end release_stage,
 -- Each text update 086 edits appears exactly once (before 086 only).
 case when position('v_first' in body)=0 then (select bool_and((length(body)-length(replace(body,v.t,'')))/length(v.t)=1) from (values
  ($t$v_ids boolean;v_limit constant integer=20;$t$),($t$where e.key not in ('search',$t$),
  ($t$v_ids=coalesce((q->>'ids')::boolean,false);$t$),($t$ if v_search is not null then
  v_digits=regexp_replace($t$),
  ($t$'ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from kept where matches))$t$),
  ($t$ if v_ids and (result->>'count')::bigint>500 then$t$)) v(t)) end edits_fit,
 (select count(*) from public.active_leads) active_leads,
 (select max((select count(*) from public.active_leads)-(select count(*) from had h where h.agent_id=p.id))
  from public.profiles p where p.role='agent' and p.active and p.deleted_at is null) most_never_assigned,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
