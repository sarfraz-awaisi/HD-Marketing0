-- Update 076: administrators manage every KPI's rules, including the KPIs
-- the CRM fills in (update 072). Apply after 075. Safe to rerun. No KPI,
-- answer, evidence or verification is changed by this update.
--
-- * A KPI the CRM fills in may now take any frequency, answer type and
--   target its records can measure (kpi_rules_problem). Each count it
--   measures can be read as a number, or as Yes once at least one counts:
--   - social media links approved, verified listings with owner details,
--     approved project visits, approved video links: daily or weekly,
--     Yes / No or a number;
--   - assigned calls: daily Yes / No only. It is decided day by day (every
--     lead due that day called by its deadline); there is no number to reach
--     and no rule for a whole week.
--   A target the evidence limits make impossible is refused: agents add up
--   to 5 social media links a day and 20 video links a week. Anything else
--   is refused with the reason, never stored.
-- * A Yes/No KPI has an expected answer (kpi_versions.expect_yes, Yes by
--   default and for every KPI so far). Agents' own KPIs may expect No; a KPI
--   the CRM fills in always expects Yes.
-- * When rules change: as update 070. Tomorrow for a daily KPI; next Monday
--   for a weekly one or a change between daily and weekly; earlier days and
--   weeks keep their rules. A KPI the CRM fills in now always waits for the
--   next period: its current period already has results, so it is never
--   corrected in place.
-- * Audit history keeps the rules before and after each change (a change
--   to a waiting change is from those rules), a waiting change that was
--   cancelled, and the previous question.
-- * The administrators' list says how many answers each KPI has under its
--   current rules, so the page can say when a change will start.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_lead_agent_history(uuid,uuid)') is null
  or to_regprocedure('public.kpi_apply_rules(uuid,jsonb,uuid,date)') is null
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='kpi_versions' and column_name='measure') then
  raise exception 'Apply CRM updates up to 075 before update 076.';
 end if;
end $$;

-- ------------------------------------------------------- expected answer
-- No default rewrite: a constant default is stored once, not per row.
alter table public.kpi_versions add column if not exists expect_yes boolean not null default true;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.kpi_versions'::regclass and conname='kpi_versions_expect') then
  alter table public.kpi_versions add constraint kpi_versions_expect check(answer_type='yes_no' or expect_yes);
 end if;
end $$;

-- ------------------------------------------- what each source can measure
-- The reason a set of rules cannot be measured, or null when it can.
create or replace function public.kpi_rules_problem(p_measure text,p_frequency text,p_answer_type text,p_target integer,p_expect_yes boolean)
returns text language sql immutable set search_path='' as $$
 select case
  when p_measure='self' then null
  when p_measure not in ('calls','social','inventory','visits','video') then 'This KPI''s CRM source is not known.'
  when p_answer_type='yes_no' and not p_expect_yes then
   'A KPI the CRM fills in expects Yes: it counts work that was done and approved, so No cannot be its expected answer.'
  when p_measure='calls' and p_frequency<>'day' then
   'Assigned calls is decided day by day: Yes when every lead due that day got its first call by its deadline. There is no rule for a whole week, so it stays Daily.'
  when p_measure='calls' and p_answer_type<>'yes_no' then
   'Assigned calls has no number to reach: the CRM checks that every lead due that day was called by its deadline. Keep Yes / No; each day still shows the calls due, on time and late.'
  when p_measure='social' and p_answer_type='number' and p_target>case p_frequency when 'day' then 5 else 35 end then
   'Agents can add up to 5 social media links a day, so the target can be at most 5 a day or 35 a week.'
  when p_measure='video' and p_answer_type='number' and p_target>case p_frequency when 'day' then 2 else 20 end then
   'Agents can add up to 20 video links a week, so the target can be at most 2 a day (a week can have 7 working days) or 20 a week.'
  end
$$;
revoke all on function public.kpi_rules_problem(text,text,text,integer,boolean) from public,anon,authenticated,service_role;

-- The table holds to the same rules (the function above gives the reason).
alter table public.kpi_versions drop constraint if exists kpi_versions_measure;
alter table public.kpi_versions add constraint kpi_versions_measure check(
 measure='self'
 or ((answer_type='number' or expect_yes) and (
  (measure='calls' and frequency='day' and answer_type='yes_no')
  or measure in ('inventory','visits')
  or (measure='social' and (answer_type='yes_no' or target<=case frequency when 'day' then 5 else 35 end))
  or (measure='video' and (answer_type='yes_no' or target<=case frequency when 'day' then 2 else 20 end)))));

-- Small, checked edits of updates 070 and 072's functions, as in updates
-- 061 to 075: each text must appear exactly once, or the update stops and
-- changes nothing. On a rerun the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- Rules as the pages read them, with the expected answer.
  ('public.kpi_version_json(kpi_versions)',
   $t$'agent_ids',to_jsonb(v.agent_ids),'measure',v.measure)$t$,
   $t$'agent_ids',to_jsonb(v.agent_ids),'measure',v.measure,'expected',case when v.expect_yes then 'yes' else 'no' end)$t$),
  -- An administrator may set the expected answer.
  ('public.kpi_check(jsonb,boolean)',
   $t$'title','question','description','position','frequency','answer_type','target','active','agent_ids')$t$,
   $t$'title','question','description','position','frequency','answer_type','target','active','agent_ids','expected')$t$),
  ('public.kpi_check(jsonb,boolean)',
   $t$  raise exception 'Choose Yes/No or Number' using errcode='22023';end if;$t$,
   $t$  raise exception 'Choose Yes/No or Number' using errcode='22023';end if;
 -- Update 076: the expected answer of a Yes/No KPI.
 if p_data ? 'expected' and (jsonb_typeof(p_data->'expected')<>'string' or p_data->>'expected' not in ('yes','no')) then
  raise exception 'Choose Yes or No as the expected answer' using errcode='22023';end if;$t$),
  -- A new KPI keeps its expected answer.
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   $t$    coalesce((p_data->>'active')::boolean,true),agents,p_actor);$t$,
   $t$    coalesce((p_data->>'active')::boolean,true),agents,p_actor,
    p_data->>'answer_type'='number' or coalesce(p_data->>'expected','yes')='yes');$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   $t$  insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
   values(k.id,1,effective,$t$,
   $t$  insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by,expect_yes)
   values(k.id,1,effective,$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   $t$'target',case when p_data->>'answer_type'='yes_no' then 1 else (p_data->>'target')::integer end));$t$,
   $t$'target',case when p_data->>'answer_type'='yes_no' then 1 else (p_data->>'target')::integer end,
    'expected',case when p_data->>'answer_type'='yes_no' then coalesce(p_data->>'expected','yes') end));$t$),
  -- A change keeps the rules before and after it, for Audit history.
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   'declare today date=public.kpi_today(p_now);k public.kpis;before public.kpis;effective date;agents uuid[];',
   'declare today date=public.kpi_today(p_now);k public.kpis;before public.kpis;effective date;agents uuid[];rules_before jsonb;rules_after jsonb;cancelled date;'),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   $t$  effective=public.kpi_apply_rules(p_id,p_data-'title'-'question'-'description'-'position',p_actor,today);$t$,
   $t$  -- Update 076: the latest rules before the change (a waiting change, if
  -- any, is what a new one replaces) and after it, or the waiting change
  -- that going back to today's rules cancels.
  select public.kpi_version_json(v) into rules_before from public.kpi_versions v where v.kpi_id=p_id order by v.effective_from desc limit 1;
  effective=public.kpi_apply_rules(p_id,p_data-'title'-'question'-'description'-'position',p_actor,today);
  if effective is not null then
   select public.kpi_version_json(v) into rules_after from public.kpi_versions v where v.kpi_id=p_id order by v.effective_from desc limit 1;
  else
   if (rules_before->>'effective_from')::date>today then cancelled=(rules_before->>'effective_from')::date;end if;
   rules_before=null;
  end if;$t$),
  ('public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)',
   $t$'previous_title',case when before.title<>k.title then before.title end,'rules_from',effective));$t$,
   $t$'previous_title',case when before.title<>k.title then before.title end,'rules_from',effective,
    'previous_question',case when before.question<>k.question then before.question end,
    'rules_before',rules_before,'rules_after',rules_after,'cancelled_change_from',cancelled));$t$),
  -- The rules: the expected answer, and what the CRM can measure.
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   'declare cur public.kpi_versions;latest public.kpi_versions;nxt public.kpi_versions;start date;',
   'declare cur public.kpi_versions;latest public.kpi_versions;nxt public.kpi_versions;start date;problem text;'),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ nxt.active=coalesce((p_rules->>'active')::boolean,latest.active);$t$,
   $t$ nxt.active=coalesce((p_rules->>'active')::boolean,latest.active);
 -- Update 076: a number has no expected answer; a Yes/No KPI keeps its own
 -- unless a new one is given.
 nxt.expect_yes=case when nxt.answer_type='number' then true
  when p_rules ? 'expected' then p_rules->>'expected'='yes' else latest.expect_yes end;$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ -- Update 072: how a KPI is measured is part of its rules, and a KPI the
 -- CRM fills in keeps its frequency and answer type.
 if latest.measure<>'self' and (nxt.frequency,nxt.answer_type) is distinct from (latest.frequency,latest.answer_type) then
  raise exception 'This KPI is filled in by the CRM: its frequency and answer type stay as they are' using errcode='22023';end if;$t$,
   $t$ -- Update 076: how a KPI is measured is part of its rules. A KPI the CRM
 -- fills in may take any rules its records can measure; others are refused
 -- with the reason.
 problem=public.kpi_rules_problem(nxt.measure,nxt.frequency,nxt.answer_type,nxt.target,nxt.expect_yes);
 if problem is not null then raise exception '%',problem using errcode='22023';end if;$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,cur.measure) then$t$,
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure,nxt.expect_yes) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,cur.measure,cur.expect_yes) then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids,latest.measure) and latest.effective_from>p_today then$t$,
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure,nxt.expect_yes) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids,latest.measure,latest.expect_yes) and latest.effective_from>p_today then$t$),
  -- Only an agents' own KPI is corrected in place.
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   ' if nxt.frequency=cur.frequency
  and cur.effective_from=',
   ' if nxt.frequency=cur.frequency and cur.measure=''self''
  and cur.effective_from='),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$agent_ids=nxt.agent_ids,measure=nxt.measure,$t$,
   $t$agent_ids=nxt.agent_ids,measure=nxt.measure,expect_yes=nxt.expect_yes,$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by,measure)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor,nxt.measure);$t$,
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by,measure,expect_yes)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor,nxt.measure,nxt.expect_yes);$t$),
  -- The administrators' list: answers under each KPI's current rules.
  ('public.kpi_admin_list(uuid,timestamp with time zone)',
   $t$     (select count(*) from public.kpi_submissions s where s.kpi_id=k.id))$t$,
   $t$     (select count(*) from public.kpi_submissions s where s.kpi_id=k.id),
     -- Update 076: answers under the rules in effect today.
     'current_answers',(select count(*) from public.kpi_submissions s where s.kpi_id=k.id
      and s.version=(public.kpi_version_on(k.id,public.kpi_today(p_now))).version))$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 076 found an unexpected version of %: apply CRM updates up to 075 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
commit;
