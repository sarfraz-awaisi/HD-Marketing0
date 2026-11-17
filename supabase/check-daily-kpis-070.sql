-- Read-only check for update 070 (Daily KPIs). Run it in the CRM's Supabase
-- SQL Editor before 070 and right after it. It is one SELECT: it changes
-- nothing and returns flags and counts only.
-- Before 070: release_stage = 'at 069, ready for 070' and
-- transactions_open_over_1_min = 0. Note sales_targets.
-- After 070: release_stage = 'at 070', kpis = 5, kpi_answers = 0, and
-- sales_targets unchanged.
select
 case
  when to_regclass('public.kpi_submissions') is not null then 'at 070'
  when to_regprocedure('public.erase_deleted_leads(uuid[],uuid,text)') is not null then 'at 069, ready for 070'
  else 'NOT READY: apply update 069 first'
 end as release_stage,
 (select count(*) from public.targets) as sales_targets,
 (select count(*) from public.profiles where role='agent' and active) as active_agents,
 -- Read through to_regclass, so the check also runs before 070.
 (select count(*) from pg_class where oid=to_regclass('public.kpis')) as kpi_tables_present,
 (xpath('/row/n/text()',query_to_xml(case when to_regclass('public.kpis') is null then 'select 0 n'
   else 'select count(*) n from public.kpis where archived_at is null' end,false,true,'')))[1]::text::int as kpis,
 (xpath('/row/n/text()',query_to_xml(case when to_regclass('public.kpi_submissions') is null then 'select 0 n'
   else 'select count(*) n from public.kpi_submissions' end,false,true,'')))[1]::text::int as kpi_answers,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
