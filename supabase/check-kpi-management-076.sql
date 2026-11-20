-- Read-only check for update 076 (administrators manage every KPI's rules,
-- including the KPIs the CRM fills in). Run it in the CRM's Supabase SQL
-- Editor before 076 and right after it. It is one SELECT: it changes nothing
-- and returns KPI settings and counts only, never an agent's answers or a
-- customer's details.
-- Before 076: release_stage = 'at 075, ready for 076' (every text 076 edits
-- is there exactly once) and transactions_open_over_1_min = 0.
-- After 076: release_stage = 'at 076', rules_check_function = 1 and
-- versions_expecting_no = 0 (no KPI expects No until an administrator
-- chooses it). kpis_now lists each KPI's rules today; changes_waiting the
-- rules changes that start later. Neither changes with 076.
with edits(signature,old_text) as (values
  ('public.kpi_version_json(kpi_versions)',$t$'agent_ids',to_jsonb(v.agent_ids),'measure',v.measure)$t$),
  ('public.kpi_check(jsonb,boolean)',$t$'title','question','description','position','frequency','answer_type','target','active','agent_ids')$t$),
  ('public.kpi_check(jsonb,boolean)',$t$  raise exception 'Choose Yes/No or Number' using errcode='22023';end if;$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',$t$    coalesce((p_data->>'active')::boolean,true),agents,p_actor);$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',$t$  insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
   values(k.id,1,effective,$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',$t$'target',case when p_data->>'answer_type'='yes_no' then 1 else (p_data->>'target')::integer end));$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)','declare today date=public.kpi_today(p_now);k public.kpis;before public.kpis;effective date;agents uuid[];'),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',$t$  effective=public.kpi_apply_rules(p_id,p_data-'title'-'question'-'description'-'position',p_actor,today);$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',$t$'previous_title',case when before.title<>k.title then before.title end,'rules_from',effective));$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)','declare cur public.kpi_versions;latest public.kpi_versions;nxt public.kpi_versions;start date;'),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$ nxt.active=coalesce((p_rules->>'active')::boolean,latest.active);$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$ if latest.measure<>'self' and (nxt.frequency,nxt.answer_type) is distinct from (latest.frequency,latest.answer_type) then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,cur.measure) then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids,latest.measure) and latest.effective_from>p_today then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',' if nxt.frequency=cur.frequency
  and cur.effective_from='),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$agent_ids=nxt.agent_ids,measure=nxt.measure,$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',$t$   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor,nxt.measure);$t$),
  ('public.kpi_admin_list(uuid,timestamp with time zone)',$t$     (select count(*) from public.kpi_submissions s where s.kpi_id=k.id))$t$)
), found as (
 select e.signature,e.old_text,coalesce(pg_get_functiondef(to_regprocedure(e.signature)),'') body from edits e
), today as (
 select (now() at time zone 'Asia/Karachi')::date d
), now_rules as (
 select k.position,k.title,v.frequency,v.answer_type,v.target,v.measure,v.active,v.effective_from
 from public.kpis k,today t,lateral (select * from public.kpi_versions v where v.kpi_id=k.id and v.effective_from<=t.d
  order by v.effective_from desc limit 1) v
 where k.archived_at is null
)
select
 case
  when to_regprocedure('public.kpi_rules_problem(text,text,text,integer,boolean)') is not null
   and exists(select 1 from information_schema.columns where table_schema='public' and table_name='kpi_versions' and column_name='expect_yes')
   then 'at 076'
  when to_regprocedure('public.admin_lead_agent_history(uuid,uuid)') is null then 'NOT READY: apply update 075 first'
  when (select count(*) from found f where (length(f.body)-length(replace(f.body,f.old_text,'')))/length(f.old_text)=1)=18
   then 'at 075, ready for 076'
  else 'NOT READY: a KPI function is not the version 076 edits'
 end as release_stage,
 (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='kpi_rules_problem') as rules_check_function,
 (select count(*) from public.kpis where archived_at is null) as kpis,
 (select count(*) from public.kpi_versions) as kpi_versions,
 (select count(*) from public.kpi_submissions) as kpi_answers,
 (select string_agg(format('%s. %s: %s %s%s, %s',position,title,frequency,answer_type,
   case when answer_type='number' then ' '||target else '' end,measure),' | ' order by position,title) from now_rules) as kpis_now,
 (select coalesce(string_agg(format('%s from %s: %s %s%s',k.title,v.effective_from,v.frequency,v.answer_type,
   case when v.answer_type='number' then ' '||v.target else '' end),' | ' order by v.effective_from),'none')
  from public.kpi_versions v join public.kpis k on k.id=v.kpi_id,today t where v.effective_from>t.d) as changes_waiting,
 (select case when exists(select 1 from information_schema.columns where table_schema='public' and table_name='kpi_versions' and column_name='expect_yes')
   then (xpath('/row/n/text()',query_to_xml('select count(*) n from public.kpi_versions where not expect_yes',false,true,'')))[1]::text::integer end) as versions_expecting_no,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
