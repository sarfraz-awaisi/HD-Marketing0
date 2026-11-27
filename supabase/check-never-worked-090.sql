-- Read-only check for update 090 (Never Worked: Assigned but Never Called
-- and source-agent numbers). Changes nothing and shows counts only, no
-- customer details. Before: release_stage = 'at 089, ready for 090' and
-- edits_fit true. After: 'at 090'. assigned_uncalled is how many active,
-- assigned leads have no call outcome saved by their current agent since
-- they received them (before the Won/Lost and call outcome rules).
with f(fn,body) as (
 select x,pg_get_functiondef(x::regprocedure) from (values ('public.admin_lead_list(uuid,jsonb)'),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)')) v(x)
), s as (
 select count(*) filter (where position('Update 090' in body)>0)
   +(to_regprocedure('public.lead_agent_uncalled(uuid)') is not null)::integer
   +(to_regprocedure('public.admin_distribute_agent_uncalled(uuid,uuid[],uuid[],boolean,text,text)') is not null)::integer done,
  bool_and(position('Update 088' in body)>0)
   and position('Update 089' in pg_get_functiondef('public.attendance_employees(uuid)'::regprocedure))>0 at089 from f
)
select
 case when s.done=4 then 'at 090'
  when s.done>0 then 'PARTLY at 090: run update 090 again'
  when s.at089 then 'at 089, ready for 090'
  else 'NOT READY: apply CRM updates up to 089 exactly' end release_stage,
 -- Each text update 090 edits appears exactly once (before 090 only).
 case when s.done<4 then (select bool_and((length(f.body)-length(replace(f.body,v.t,'')))/length(v.t)=1)
  from (values
  ('public.admin_lead_list(uuid,jsonb)',$t$v_outcomes text[];v_open boolean;$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$where e.key not in ('first','search',$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$v_open=coalesce((q->>'reassignable')::boolean,false);$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$ if v_search is not null then$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$   and (v_temperature is null or coalesce($t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$   ||coalesce((select string_agg(distinct a.agent_id::text$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$for item in select l.id,l.name,l.status,$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$v_entry=jsonb_build_object('id',item.id,'name',item.name,'from',item.assigned_agent,$t$)
  ) v(fn,t) join f on f.fn=v.fn where position('Update 090' in f.body)=0) end edits_fit,
 (select count(*) from public.active_leads) active_leads,
 (select count(*) from public.active_leads l where l.assigned_agent is not null
  and not exists(select 1 from public.calls c where c.lead_id=l.id and c.outcome is not null
   and c.created_at>=coalesce(l.assigned_at,'-infinity')
   and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=l.assigned_agent)) assigned_uncalled,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
