-- Read-only check for update 080 (the single worker lease and Meta
-- connection health). Changes nothing. Before: release_stage = 'at 079,
-- ready for 080'. After: 'at 080' with browser_can_use_it = false and
-- worker_leases = 0 until a worker is started.
with f as (select count(*) n from pg_proc where oid in (
  coalesce(to_regprocedure('public.worker_lease(uuid,integer,text[])')::oid,0),
  coalesce(to_regprocedure('public.worker_lease_release(uuid)')::oid,0),
  coalesce(to_regprocedure('public.meta_health(uuid)')::oid,0))),
r as (select role from unnest(array['anon','authenticated']) role)
select
 case
  when (select n from f)=3 and to_regclass('crm_private.worker_lease') is not null then 'at 080'
  when (select n from f)=0 and to_regclass('crm_private.worker_lease') is null
   and to_regprocedure('public.meta_summary(uuid)') is not null
   and (select position('''Closed lost''' in pg_get_constraintdef(oid))>0 from pg_constraint
    where conrelid='public.calls'::regclass and conname='calls_outcome_check') then 'at 079, ready for 080'
  else 'NOT READY: apply CRM updates up to 079 exactly' end release_stage,
 (select n from f) functions_present,
 case when (select n from f)=3 then exists(select 1 from r where
   has_function_privilege(role,'public.worker_lease(uuid,integer,text[])','execute')
   or has_function_privilege(role,'public.worker_lease_release(uuid)','execute')
   or has_function_privilege(role,'public.meta_health(uuid)','execute')) end browser_can_use_it,
 case when to_regclass('crm_private.worker_lease') is not null
  then (xpath('/row/n/text()',query_to_xml('select count(*) n from crm_private.worker_lease',false,true,'')))[1]::text::int end worker_leases,
 (select count(*) from public.meta_submissions) meta_submissions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min;
