-- Read-only check for update 079 (the call outcome "Closed lost"). Changes
-- nothing. Before: release_stage = 'at 078, ready for 079'. After: 'at 079'
-- with every place accepting it and closed_lost_calls = 0 until one is saved.
with c as (select pg_get_constraintdef(oid) def from pg_constraint
  where conrelid='public.calls'::regclass and conname='calls_outcome_check'),
f as (select count(*) filter (where pg_get_functiondef(p.oid) like '%''Closed lost''%') n from pg_proc p
  where p.oid in ('public.admin_lead_list(uuid,jsonb)'::regprocedure,'public.agent_lead_list(uuid,jsonb)'::regprocedure,
   'public.admin_agent_pipeline(uuid,uuid,jsonb)'::regprocedure,'public.lead_export_match(jsonb)'::regprocedure,
   'public.lead_file_export_match(jsonb)'::regprocedure))
select
 case
  when (select def like '%''Closed lost''%' from c) and (select n from f)=5 then 'at 079'
  when (select def from c)=$c$CHECK ((outcome = ANY (ARRAY['No answer'::text, 'Busy'::text, 'Wrong number'::text, 'Number off'::text, 'Interested'::text, 'Not interested'::text, 'Follow-up required'::text, 'Site visit scheduled'::text, 'Deal discussion'::text])))$c$
   and (select n from f)=0 and to_regprocedure('public.call_outcome_stage(text)') is not null then 'at 078, ready for 079'
  else 'NOT READY: unexpected outcome list' end release_stage,
 (select def like '%''Closed lost''%' from c) calls_accept_it,
 (select n from f) functions_accepting_it,
 (select count(*) from public.calls where outcome='Closed lost') closed_lost_calls,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min;
