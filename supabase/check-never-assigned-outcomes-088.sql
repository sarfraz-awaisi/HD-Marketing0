-- Read-only check for update 088 (Never assigned leaves out leads an agent
-- is working on). Changes nothing and shows counts only, no customer
-- details. Before: release_stage = 'at 087, ready for 088' and edits_fit
-- true. After: 'at 088'. left_out is how many active leads Never assigned
-- leaves out by their latest saved call outcome.
with f(fn,body) as (
 select x,pg_get_functiondef(x::regprocedure) from (values ('public.admin_lead_list(uuid,jsonb)'),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)')) v(x)
), s as (
 select count(*) filter (where position('Update 088' in body)>0) done,
  bool_or(fn like 'public.admin_lead_list%' and position('Update 087' in body)>0) at087 from f
)
select
 case when s.done=2 then 'at 088'
  when s.done=1 then 'PARTLY at 088: run update 088 again'
  when s.at087 then 'at 087, ready for 088'
  else 'NOT READY: apply CRM updates up to 087 exactly' end release_stage,
 -- Each text update 088 edits appears exactly once (before 088 only).
 case when s.done<2 then (select bool_and((length(f.body)-length(replace(f.body,v.t,'')))/length(v.t)=1)
  from (values
  ('public.admin_lead_list(uuid,jsonb)',$t$v_agents uuid[];v_never uuid[];$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$'usage','agents','never_assigned')
    or (e.key not in ('agents','never_assigned') and jsonb_typeof(e.value) not in ('string','number','boolean'))
    or (e.key in ('agents','never_assigned') and jsonb_typeof(e.value)<>'array')) then$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$v_never=case when q->'never_assigned' is not null then array(select x::uuid from jsonb_array_elements_text(q->'never_assigned') x) end;$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$ -- Update 086: the first leads, only when asking for IDs.$t$),
  ('public.admin_lead_list(uuid,jsonb)',$t$   and (v_outcome is null or (select c.outcome from public.calls c where c.lead_id=l.id
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) is not distinct from v_outcome)$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$   ||coalesce(l.status,'-')||':'||coalesce(public.lead_first_call_reopened(l.id)::text,'-')||':'$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$    union select l.assigned_agent where l.assigned_agent is not null) had
  from public.active_leads l$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',$t$  elsif item.status in ('won','lost') and not public.lead_first_call_reopened(item.id) then$t$)
  ) v(fn,t) join f on f.fn=v.fn where position('Update 088' in f.body)=0) end edits_fit,
 (select count(*) from public.active_leads) active_leads,
 (select count(*) from public.active_leads l where (select c.outcome from public.calls c where c.lead_id=l.id and c.outcome is not null
  order by c.started_at desc,c.created_at desc,c.id desc limit 1)
  in ('Interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost')) left_out,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
