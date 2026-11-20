-- Read-only check for update 075 (Lead Usage on All leads and each lead's
-- agent history). Run it in the CRM's Supabase SQL Editor before 075 and
-- right after it. It is one SELECT: it changes nothing and returns counts
-- only, never a customer's details.
-- Before 075: release_stage = 'at 074, ready for 075' (every text 075 edits
-- in admin_lead_list is there exactly once) and
-- transactions_open_over_1_min = 0.
-- After 075: release_stage = 'at 075' and history_function = 1.
-- used_by_2 … used_by_5 are what the Lead Usage choices show with no other
-- filter; used_by_6_or_more are in no choice. agents_removed_without_record:
-- live leads with no agent whose last assignment was to an agent (moved to
-- Deleted leads and restored); their agent's period shows "end not
-- recorded". agent_without_assignment_record should be 0.
with edits(old_text) as (values
  ('v_temperature text;v_outcome text;'),
  ($t$'page','ids','country')$t$),
  ($t$v_agent=(q->>'agent')::uuid;v_import=(q->>'import')::uuid;$t$),
  ($t$if v_page not between 1 and 100000 or length(coalesce(v_search,''))>100$t$),
  ('select l.id,l.assigned_agent,l.created_at,l.call_due_at,'),
  ('), ordered as ('),
  ('select b.id,row_number() over(order by'),
  ('from base b where b.matches'),
  ('select o.rn,l.*,'),
  ($t$ select case when v_ids then jsonb_build_object('count',(select count(*) from base where matches),$t$),
  ($t$'last_call_earlier',s.last_call_earlier)$t$)
), list as (
 select coalesce(pg_get_functiondef(to_regprocedure('public.admin_lead_list(uuid,jsonb)')),'') body
), used as (
 select l.id,l.assigned_agent,(select count(distinct a.agent_id) from public.assignments a where a.lead_id=l.id) n,
  (select a.agent_id from public.assignments a where a.lead_id=l.id order by a.created_at desc,a.id desc limit 1) last_agent,
  exists(select 1 from public.assignments a where a.lead_id=l.id) any_row
 from public.leads l where l.deleted_at is null
)
select
 case
  when to_regprocedure('public.admin_lead_agent_history(uuid,uuid)') is not null
   and position('agents_used' in (select body from list))>0 then 'at 075'
  when to_regprocedure('public.lead_file_export_rows(uuid,uuid[])') is null then 'NOT READY: apply update 074 first'
  when (select count(*) from edits e,list where (length(list.body)-length(replace(list.body,e.old_text,'')))/length(e.old_text)=1)=11
   then 'at 074, ready for 075'
  else 'NOT READY: admin_lead_list is not the version 075 edits'
 end as release_stage,
 (select count(*) from pg_proc where pronamespace='public'::regnamespace and provolatile='v'
  and proname='admin_lead_agent_history') as history_function,
 (select count(*) from used) as live_leads,
 (select count(*) from used where n=2) as used_by_2,
 (select count(*) from used where n=3) as used_by_3,
 (select count(*) from used where n=4) as used_by_4,
 (select count(*) from used where n=5) as used_by_5,
 (select count(*) from used where n>=6) as used_by_6_or_more,
 (select count(*) from used where assigned_agent is null and last_agent is not null) as agents_removed_without_record,
 (select count(*) from used where assigned_agent is not null and (not any_row or last_agent is distinct from assigned_agent)) as agent_without_assignment_record,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
