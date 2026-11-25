-- Read-only check for update 083 (Never called = never called by anyone).
-- Changes nothing. Before: release_stage = 'at 082, ready for 083'. After:
-- 'at 083', with how many assigned leads no one has called yet.
with s as (select
  to_regprocedure('public.lead_never_called(uuid)') is not null at_082,
  coalesce(position('report_recorded_by' in pg_get_functiondef(to_regprocedure('public.lead_never_called(uuid)'))),1)=0 by_anyone,
  position('Called meanwhile' in coalesce(pg_get_functiondef(to_regprocedure('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)')),''))>0 kept)
select
 case when by_anyone and kept then 'at 083'
  when at_082 and not by_anyone and not kept then 'at 082, ready for 083'
  else 'NOT READY: apply CRM updates up to 082 exactly' end release_stage,
 (select count(*) from public.active_leads where assigned_agent is not null) assigned_leads,
 case when at_082 then (xpath('/row/n/text()',query_to_xml(
  'select count(*) n from public.active_leads l where public.lead_never_called(l.id)',false,true,'')))[1]::text::int end never_called_now,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
