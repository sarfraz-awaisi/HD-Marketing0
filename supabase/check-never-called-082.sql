-- Read-only check for update 082 (All leads: Never called and several
-- agents at once). Changes nothing. Before: release_stage = 'at 081, ready
-- for 082'. After: 'at 082', browsers cannot use it, and how many assigned
-- leads have not been called by their agent since receiving them.
with s as (select
  to_regprocedure('public.lead_never_called(uuid)') is not null helper,
  to_regprocedure('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)') is not null distribute,
  position('never_called' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))>0 list,
  position('call_activity' in pg_get_functiondef('public.kpi_rules_problem(text,text,text,integer,boolean)'::regprocedure))>0 at_081)
select
 case when helper and distribute and list then 'at 082'
  when not helper and not distribute and not list and at_081 then 'at 081, ready for 082'
  else 'NOT READY: apply CRM updates up to 081 exactly' end release_stage,
 case when helper and distribute then
  has_function_privilege('anon','public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)','execute')
  or has_function_privilege('authenticated','public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)','execute')
  or has_function_privilege('authenticated','public.lead_never_called(uuid)','execute') end browser_can_use_it,
 (select count(*) from public.active_leads where assigned_agent is not null) assigned_leads,
 case when helper then (xpath('/row/n/text()',query_to_xml(
  'select count(*) n from public.active_leads l where public.lead_never_called(l.id)',false,true,'')))[1]::text::int end never_called_now,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
