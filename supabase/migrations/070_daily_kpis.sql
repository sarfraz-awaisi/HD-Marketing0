-- Update 070: Daily KPIs. Administrators define daily or weekly KPI
-- questions (Yes/No or a number, with a target); agents answer them for each
-- Pakistan day; administrators see daily, weekly and monthly results.
-- Apply after 069. Safe to rerun.
--
-- History is never rewritten:
-- * kpis holds each KPI's current wording, order and archive state. Every
--   answer keeps the wording it was given (kpi_submissions.question).
-- * kpi_versions holds the rules (frequency, answer type, target, on/off,
--   which agents) with the Pakistan day they take effect. A change takes
--   effect from the next period (tomorrow for a daily KPI, next Monday for a
--   weekly one, or when switching between them), so earlier and current
--   periods keep the rules they started with. Only a version that began this
--   period and that no one has answered under is corrected in place.
-- * kpi_submissions holds one answer per agent, KPI and day, under the
--   version in effect that day. Saving again replaces that day's answer, so a
--   weekly total is the sum of distinct days and can never be inflated.
--
-- The existing sales targets (public.targets and its functions) are not
-- changed. Only the CRM's server reads or changes these tables, through the
-- functions below, which check the person: administrators manage KPIs and see
-- everyone; an agent answers and sees only their own.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.erase_deleted_leads(uuid[],uuid,text)') is null
  or to_regprocedure('public.accounts_admin(uuid)') is null
  or to_regprocedure('public.attendance_days(date,date,uuid,timestamp with time zone)') is null then
  raise exception 'Apply CRM updates up to 069 before update 070.';
 end if;
end $$;

create table if not exists public.kpis(
 id uuid primary key default gen_random_uuid(),
 title text not null check(title=btrim(title) and length(title) between 1 and 80),
 question text not null check(question=btrim(question) and length(question) between 1 and 300),
 description text check(description is null or (description=btrim(description) and length(description) between 1 and 500)),
 position integer not null default 0 check(position between 0 and 1000),
 archived_at timestamptz,
 archived_by uuid references public.profiles(id),
 -- Empty for the five KPIs this update creates.
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_by uuid references public.profiles(id),
 updated_at timestamptz not null default now());

create table if not exists public.kpi_versions(
 kpi_id uuid not null references public.kpis(id),
 version integer not null check(version>=1),
 -- The Pakistan day these rules take effect; a weekly KPI's on a Monday.
 effective_from date not null,
 frequency text not null check(frequency in ('day','week')),
 answer_type text not null check(answer_type in ('yes_no','number')),
 -- Yes/No: 1 (the answer Yes). Number: the count per day or per week.
 target integer not null check(target between 1 and 10000),
 active boolean not null default true,
 -- Empty: every agent.
 agent_ids uuid[] check(agent_ids is null or cardinality(agent_ids) between 1 and 500),
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 primary key(kpi_id,version),
 unique(kpi_id,effective_from),
 check(answer_type='number' or target=1),
 check(frequency='day' or extract(isodow from effective_from)=1));

create table if not exists public.kpi_submissions(
 id uuid primary key default gen_random_uuid(),
 kpi_id uuid not null references public.kpis(id),
 agent_id uuid not null references public.profiles(id),
 -- The Pakistan day of the activity, apart from when it was saved.
 activity_date date not null,
 version integer not null,
 -- The wording the agent answered.
 question text not null check(length(question) between 1 and 300),
 answer_yes boolean,
 answer_count integer check(answer_count between 0 and 1000),
 submitted_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(kpi_id,agent_id,activity_date),
 foreign key(kpi_id,version) references public.kpi_versions(kpi_id,version),
 check((answer_yes is null)<>(answer_count is null)));
create index if not exists kpi_submissions_agent_day on public.kpi_submissions(agent_id,activity_date);
create index if not exists kpi_submissions_day on public.kpi_submissions(activity_date);

alter table public.kpis enable row level security;
alter table public.kpi_versions enable row level security;
alter table public.kpi_submissions enable row level security;
revoke all on public.kpis,public.kpi_versions,public.kpi_submissions from public,anon,authenticated;
grant all on public.kpis,public.kpi_versions,public.kpi_submissions to service_role;

-- --------------------------------------------------------------- helpers
-- The Pakistan day of an instant, and the Monday of a day's week.
create or replace function public.kpi_today(p_now timestamptz) returns date language sql stable set search_path='' as $$
 select (p_now at time zone 'Asia/Karachi')::date
$$;
create or replace function public.kpi_week_start(p_day date) returns date language sql immutable set search_path='' as $$
 select p_day-(extract(isodow from p_day)::integer-1)
$$;
-- The rules in effect on a day: the latest that took effect by then. Weekly
-- rules only ever start on a Monday, so they hold for the whole week.
create or replace function public.kpi_version_on(p_kpi uuid,p_day date) returns public.kpi_versions language sql stable set search_path='' as $$
 select v.* from public.kpi_versions v where v.kpi_id=p_kpi and v.effective_from<=p_day
 order by v.effective_from desc limit 1
$$;
-- A KPI as administrators and agents read it.
create or replace function public.kpi_json(k public.kpis) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',k.id,'title',k.title,'question',k.question,'description',k.description,
  'position',k.position,'archived_at',k.archived_at,'created_at',k.created_at,'updated_at',k.updated_at)
$$;
create or replace function public.kpi_version_json(v public.kpi_versions) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('kpi_id',v.kpi_id,'version',v.version,'effective_from',v.effective_from,'frequency',v.frequency,
  'answer_type',v.answer_type,'target',v.target,'active',v.active,'agent_ids',to_jsonb(v.agent_ids))
$$;

-- New rules for a KPI. Unchanged rules change nothing (and cancel a change
-- waiting for the next period). Otherwise they take effect from the next
-- period, replacing any change already waiting; a version that began this
-- period, that no one has answered under and that keeps its frequency is
-- corrected in place instead. Returns the day the rules take effect, or
-- null when nothing changed.
create or replace function public.kpi_apply_rules(p_kpi uuid,p_rules jsonb,p_actor uuid,p_today date) returns date language plpgsql security definer set search_path='' as $$
declare cur public.kpi_versions;latest public.kpi_versions;nxt public.kpi_versions;start date;
begin
 cur=public.kpi_version_on(p_kpi,p_today);
 if cur.kpi_id is null then raise exception 'KPI not found' using errcode='P0002';end if;
 select * into latest from public.kpi_versions where kpi_id=p_kpi order by effective_from desc limit 1;
 if p_rules->>'answer_type'='number' and latest.answer_type='yes_no' and not p_rules ? 'target' then
  raise exception 'Choose a target from 1 to 10,000' using errcode='22023';end if;
 nxt=latest;
 nxt.frequency=coalesce(p_rules->>'frequency',latest.frequency);
 nxt.answer_type=coalesce(p_rules->>'answer_type',latest.answer_type);
 nxt.target=case when nxt.answer_type='yes_no' then 1 else coalesce((p_rules->>'target')::integer,latest.target) end;
 nxt.active=coalesce((p_rules->>'active')::boolean,latest.active);
 if p_rules ? 'agent_ids' then
  nxt.agent_ids=case when jsonb_typeof(p_rules->'agent_ids')='array'
   then (select array_agg(distinct x::uuid order by x::uuid) from jsonb_array_elements_text(p_rules->'agent_ids') x) end;
 end if;
 if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids) then
  delete from public.kpi_versions where kpi_id=p_kpi and effective_from>p_today;
  return null;
 end if;
 if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids) and latest.effective_from>p_today then
  return latest.effective_from;
 end if;
 delete from public.kpi_versions where kpi_id=p_kpi and effective_from>p_today;
 if nxt.frequency=cur.frequency
  and cur.effective_from=(case when cur.frequency='week' then public.kpi_week_start(p_today) else p_today end)
  and not exists(select 1 from public.kpi_submissions s where s.kpi_id=p_kpi and s.version=cur.version) then
  update public.kpi_versions set answer_type=nxt.answer_type,target=nxt.target,active=nxt.active,agent_ids=nxt.agent_ids,
   created_by=p_actor,created_at=now() where kpi_id=p_kpi and version=cur.version;
  return cur.effective_from;
 end if;
 start=case when cur.frequency='week' or nxt.frequency='week' then public.kpi_week_start(p_today)+7 else p_today+1 end;
 insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor);
 return start;
end $$;

-- Checks an administrator's KPI fields; raises one plain message.
create or replace function public.kpi_check(p_data jsonb,p_create boolean) returns void language plpgsql immutable set search_path='' as $$
declare k text;
begin
 if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid KPI' using errcode='22023';end if;
 for k in select jsonb_object_keys(p_data) loop
  if k not in ('title','question','description','position','frequency','answer_type','target','active','agent_ids') then
   raise exception 'Invalid KPI field' using errcode='22023';end if;
 end loop;
 if p_create and (p_data->>'title' is null or p_data->>'question' is null or p_data->>'frequency' is null or p_data->>'answer_type' is null) then
  raise exception 'Choose a title, question, frequency and answer type' using errcode='22023';end if;
 if p_data ? 'frequency' and p_data->>'frequency' not in ('day','week') then
  raise exception 'Choose daily or weekly' using errcode='22023';end if;
 if p_data ? 'answer_type' and p_data->>'answer_type' not in ('yes_no','number') then
  raise exception 'Choose Yes/No or Number' using errcode='22023';end if;
 if p_data ? 'target' and not (case when jsonb_typeof(p_data->'target')='number'
  then (p_data->>'target')::numeric=floor((p_data->>'target')::numeric) and (p_data->>'target')::numeric between 1 and 10000 else false end) then
  raise exception 'Choose a target from 1 to 10,000' using errcode='22023';end if;
 if p_data ? 'position' and not (case when jsonb_typeof(p_data->'position')='number'
  then (p_data->>'position')::numeric=floor((p_data->>'position')::numeric) and (p_data->>'position')::numeric between 0 and 1000 else false end) then
  raise exception 'Choose a position from 0 to 1,000' using errcode='22023';end if;
 if p_data ? 'active' and jsonb_typeof(p_data->'active')<>'boolean' then
  raise exception 'Invalid KPI field' using errcode='22023';end if;
 if p_data ? 'agent_ids' and jsonb_typeof(p_data->'agent_ids') not in ('null','array') then
  raise exception 'Invalid KPI field' using errcode='22023';end if;
 if p_data ? 'agent_ids' and jsonb_typeof(p_data->'agent_ids')='array' and exists(select 1 from jsonb_array_elements(p_data->'agent_ids') x
   where jsonb_typeof(x)<>'string' or x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'Choose agents from the list' using errcode='22023';end if;
 if (p_data ? 'title' and (jsonb_typeof(p_data->'title')<>'string' or length(btrim(p_data->>'title')) not between 1 and 80))
  or (p_data ? 'question' and (jsonb_typeof(p_data->'question')<>'string' or length(btrim(p_data->>'question')) not between 1 and 300))
  or (p_data ? 'description' and jsonb_typeof(p_data->'description') not in ('string','null'))
  or (jsonb_typeof(p_data->'description')='string' and length(btrim(p_data->>'description'))>500) then
  raise exception 'Use a title of up to 80 characters, a question of up to 300 and a description of up to 500' using errcode='22023';end if;
 if p_create and p_data->>'answer_type'='number' and not p_data ? 'target' then
  raise exception 'Choose a target from 1 to 10,000' using errcode='22023';end if;
end $$;

-- ------------------------------------------------- administrators: manage
-- Every KPI (archived ones too), all their rules, and how many answers each
-- has: the server works out what is in effect today and what is waiting.
-- Read functions stay volatile: they lock the reader's profile row.
create or replace function public.kpi_admin_list(p_actor uuid,p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return jsonb_build_object('today',public.kpi_today(p_now),
  'kpis',coalesce((select jsonb_agg(public.kpi_json(k)||jsonb_build_object('answers',
     (select count(*) from public.kpi_submissions s where s.kpi_id=k.id)) order by k.position,k.created_at,k.id) from public.kpis k),'[]'::jsonb),
  'versions',coalesce((select jsonb_agg(public.kpi_version_json(v) order by v.kpi_id,v.effective_from) from public.kpi_versions v),'[]'::jsonb));
end $$;

-- Creates (p_id null) or changes a KPI. Wording and order change at once;
-- rules as in kpi_apply_rules.
create or replace function public.kpi_save(p_actor uuid,p_id uuid,p_data jsonb,p_request text,p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
declare today date=public.kpi_today(p_now);k public.kpis;before public.kpis;effective date;agents uuid[];
begin
 perform pg_advisory_xact_lock(870070);
 perform public.accounts_admin(p_actor);
 perform public.kpi_check(p_data,p_id is null);
 if p_data ? 'agent_ids' and jsonb_typeof(p_data->'agent_ids')='array' then
  select array_agg(distinct x::uuid order by x::uuid) into agents from jsonb_array_elements_text(p_data->'agent_ids') x;
  if coalesce(cardinality(agents),0)=0 or cardinality(agents)>500
   or exists(select 1 from unnest(agents) a where not exists(select 1 from public.profiles p where p.id=a and p.role='agent')) then
   raise exception 'Choose agents from the list' using errcode='22023';end if;
 end if;
 if p_id is null then
  insert into public.kpis(title,question,description,position,created_by,updated_by)
   values(btrim(p_data->>'title'),btrim(p_data->>'question'),nullif(btrim(coalesce(p_data->>'description','')),''),
    coalesce((p_data->>'position')::integer,(select coalesce(max(position),0)+1 from public.kpis)),p_actor,p_actor)
   returning * into k;
  effective=case when p_data->>'frequency'='week' then public.kpi_week_start(today) else today end;
  insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
   values(k.id,1,effective,p_data->>'frequency',p_data->>'answer_type',
    case when p_data->>'answer_type'='yes_no' then 1 else (p_data->>'target')::integer end,
    coalesce((p_data->>'active')::boolean,true),agents,p_actor);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'kpi.created','kpis',k.id::text,p_request,jsonb_build_object('title',k.title,'effective_from',effective,
    'frequency',p_data->>'frequency','answer_type',p_data->>'answer_type','target',case when p_data->>'answer_type'='yes_no' then 1 else (p_data->>'target')::integer end));
 else
  select * into before from public.kpis where id=p_id for update;
  if not found then raise exception 'KPI not found' using errcode='P0002';end if;
  if before.archived_at is not null then raise exception 'Restore this KPI before changing it' using errcode='22023';end if;
  update public.kpis set title=coalesce(btrim(p_data->>'title'),title),question=coalesce(btrim(p_data->>'question'),question),
   description=case when p_data ? 'description' then nullif(btrim(coalesce(p_data->>'description','')),'') else description end,
   position=coalesce((p_data->>'position')::integer,position),updated_by=p_actor,updated_at=now()
   where id=p_id returning * into k;
  effective=public.kpi_apply_rules(p_id,p_data-'title'-'question'-'description'-'position',p_actor,today);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'kpi.updated','kpis',k.id::text,p_request,jsonb_build_object('title',k.title,
    'fields',(select coalesce(jsonb_agg(f order by f),'[]'::jsonb) from jsonb_object_keys(p_data) f),
    'previous_title',case when before.title<>k.title then before.title end,'rules_from',effective));
 end if;
 return public.kpi_json(k)||jsonb_build_object('rules_from',effective);
end $$;

-- Archives a KPI (it stops from the next period; its answers stay) or brings
-- it back (from the next period).
create or replace function public.kpi_archive(p_actor uuid,p_id uuid,p_archived boolean,p_request text,p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
declare k public.kpis;effective date;
begin
 perform pg_advisory_xact_lock(870070);
 perform public.accounts_admin(p_actor);
 select * into k from public.kpis where id=p_id for update;
 if not found then raise exception 'KPI not found' using errcode='P0002';end if;
 if p_archived is null or (k.archived_at is not null)=p_archived then return public.kpi_json(k);end if;
 update public.kpis set archived_at=case when p_archived then now() end,archived_by=case when p_archived then p_actor end,
  updated_by=p_actor,updated_at=now() where id=p_id returning * into k;
 effective=public.kpi_apply_rules(p_id,jsonb_build_object('active',not p_archived),p_actor,public.kpi_today(p_now));
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,case when p_archived then 'kpi.archived' else 'kpi.restored' end,'kpis',k.id::text,p_request,
   jsonb_build_object('title',k.title,'rules_from',effective));
 return public.kpi_json(k)||jsonb_build_object('rules_from',effective);
end $$;

-- Deletes a KPI no one has answered; one with answers can only be archived.
create or replace function public.kpi_delete(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare k public.kpis;
begin
 perform pg_advisory_xact_lock(870070);
 perform public.accounts_admin(p_actor);
 select * into k from public.kpis where id=p_id for update;
 if not found then raise exception 'KPI not found' using errcode='P0002';end if;
 if exists(select 1 from public.kpi_submissions where kpi_id=p_id) then
  raise exception 'This KPI has answers. Archive it instead, so its history stays.' using errcode='22023';end if;
 delete from public.kpi_versions where kpi_id=p_id;
 delete from public.kpis where id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'kpi.deleted','kpis',p_id::text,p_request,jsonb_build_object('title',k.title));
 return jsonb_build_object('deleted',true);
end $$;

-- ---------------------------------------------------------- agents: answer
-- An agent's answers for one Pakistan day: [{kpi_id, answer}], where answer
-- is true/false for Yes/No and a whole number from 0 for Number. Daily KPIs
-- are answered on their day; weekly KPIs on any day of the current week up
-- to today. Saving again replaces the day's answer. All or nothing.
create or replace function public.kpi_submit(p_actor uuid,p_day date,p_answers jsonb,p_request text,p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
declare today date=public.kpi_today(p_now);item jsonb;k public.kpis;v public.kpi_versions;old public.kpi_submissions;
 yes boolean;n integer;changes jsonb='[]';saved integer=0;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active and role='agent') then
  raise exception 'Agent access required' using errcode='42501';end if;
 if p_day is null or p_day>today or p_day<public.kpi_week_start(today) then
  raise exception 'Choose a day of this week, up to today' using errcode='22023';end if;
 if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers) not between 1 and 50
  or (select count(distinct x->>'kpi_id') from jsonb_array_elements(p_answers) x)<>jsonb_array_length(p_answers) then
  raise exception 'Invalid answers' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_answers) loop
  if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>2
   or not item ? 'kpi_id' or not item ? 'answer' or jsonb_typeof(item->'kpi_id')<>'string'
   or item->>'kpi_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception 'Invalid answers' using errcode='22023';end if;
  select * into k from public.kpis where id=(item->>'kpi_id')::uuid;
  v=public.kpi_version_on((item->>'kpi_id')::uuid,p_day);
  if k.id is null or v.kpi_id is null or not v.active or not (v.agent_ids is null or p_actor=any(v.agent_ids)) then
   raise exception 'This KPI is not one of yours for that day' using errcode='22023';end if;
  if v.frequency='day' and p_day<>today then
   raise exception 'Daily KPIs can only be answered on the day' using errcode='22023';end if;
  yes=null;n=null;
  if v.answer_type='yes_no' then
   if jsonb_typeof(item->'answer')<>'boolean' then raise exception 'Answer % with Yes or No',k.title using errcode='22023';end if;
   yes=(item->>'answer')::boolean;
  else
   if not (case when jsonb_typeof(item->'answer')='number' then (item->>'answer')::numeric=floor((item->>'answer')::numeric)
    and (item->>'answer')::numeric between 0 and 1000 else false end) then
    raise exception 'Answer % with a whole number from 0 to 1,000',k.title using errcode='22023';end if;
   n=(item->>'answer')::integer;
  end if;
  select * into old from public.kpi_submissions where kpi_id=k.id and agent_id=p_actor and activity_date=p_day for update;
  if old.id is not null and old.answer_yes is not distinct from yes and old.answer_count is not distinct from n then continue;end if;
  insert into public.kpi_submissions(kpi_id,agent_id,activity_date,version,question,answer_yes,answer_count)
   values(k.id,p_actor,p_day,v.version,k.question,yes,n)
   on conflict(kpi_id,agent_id,activity_date) do update set answer_yes=excluded.answer_yes,answer_count=excluded.answer_count,
    question=excluded.question,updated_at=now();
  saved=saved+1;
  changes=changes||jsonb_build_array(jsonb_build_object('kpi_id',k.id,'title',k.title,
   'before',case when old.id is null then null else coalesce(to_jsonb(old.answer_yes),to_jsonb(old.answer_count)) end,
   'after',coalesce(to_jsonb(yes),to_jsonb(n))));
 end loop;
 if saved>0 then
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'kpi.answers_saved','kpi_submissions',null,p_request,jsonb_build_object('agent_id',p_actor,'day',p_day,'answers',changes));
 end if;
 return jsonb_build_object('day',p_day,'saved',saved);
end $$;

-- ----------------------------------------------------------- read: facts
-- Everything the server needs to show one agent's day or week, or the
-- administrators' report, for whole weeks around p_from..p_to: the KPIs,
-- all their rules, the agents, each agent's working days (from attendance:
-- shift days, holidays, approved leave and employment periods) and the
-- answers. Administrators: anyone; an agent: only themselves.
create or replace function public.kpi_facts(p_actor uuid,p_from date,p_to date,p_agent uuid,p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;span_from date;span_to date;work smallint[];
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null or actor.role not in ('admin','agent') or (actor.role='agent' and p_agent is distinct from p_actor) then
  raise exception 'You can only see your own KPIs' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then
  raise exception 'Choose a date range of up to a year' using errcode='22023';end if;
 if p_agent is not null and not exists(select 1 from public.profiles where id=p_agent and role='agent') then
  raise exception 'Choose an agent from the list' using errcode='22023';end if;
 span_from=public.kpi_week_start(p_from);span_to=public.kpi_week_start(p_to)+6;
 select s.work_days into work from public.crm_settings s limit 1;
 return (with cal as (
   select d.user_id,d.day,
    case when not d.eligible then 'not_employed'
     when d.holiday is not null then 'holiday'
     when d.leave_type is not null then 'leave'
     when not d.tracked then case when extract(isodow from d.day)::smallint=any(coalesce(work,'{1,2,3,4,5,6}')) then 'work' else 'day_off' end
     when not d.scheduled then 'day_off'
     else 'work' end status
   from public.attendance_days(span_from,span_to,p_agent,p_now) d
   join public.profiles p on p.id=d.user_id and p.role='agent'),
  people as (
   select p.* from public.profiles p where p.role='agent' and (p_agent is null or p.id=p_agent)
    and (exists(select 1 from cal c where c.user_id=p.id and c.status<>'not_employed')
     or exists(select 1 from public.kpi_submissions s where s.agent_id=p.id and s.activity_date between span_from and span_to)
     or p.id=p_agent))
  select jsonb_build_object('today',public.kpi_today(p_now),'from',p_from,'to',p_to,'span_from',span_from,'span_to',span_to,
   'kpis',coalesce((select jsonb_agg(public.kpi_json(k) order by k.position,k.created_at,k.id) from public.kpis k),'[]'::jsonb),
   'versions',coalesce((select jsonb_agg(public.kpi_version_json(v) order by v.kpi_id,v.effective_from) from public.kpi_versions v),'[]'::jsonb),
   'agents',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'active',p.active) order by p.name,p.id) from people p),'[]'::jsonb),
   'days',coalesce((select jsonb_agg(jsonb_build_array(c.user_id,c.day,c.status) order by c.user_id,c.day) from cal c
     where c.user_id in (select id from people)),'[]'::jsonb),
   'answers',coalesce((select jsonb_agg(jsonb_build_object('kpi_id',s.kpi_id,'agent_id',s.agent_id,'day',s.activity_date,'version',s.version,
     'question',s.question,'yes',s.answer_yes,'count',s.answer_count,'submitted_at',s.submitted_at,'updated_at',s.updated_at)
     order by s.activity_date,s.agent_id,s.kpi_id)
    from public.kpi_submissions s where s.activity_date between span_from and span_to and s.agent_id in (select id from people)),'[]'::jsonb)));
end $$;

-- ----------------------------------------------------- the first five KPIs
-- Once, when there are no KPIs yet. Daily ones from today, weekly ones from
-- this week's Monday (Pakistan time).
do $seed$
declare today date=public.kpi_today(now());k uuid;item record;
begin
 if exists(select 1 from public.kpis) then return;end if;
 for item in select * from (values
  (1,'Assigned calls answered','Did you answer your assigned calls today?',null,'day','yes_no',1),
  (2,'Social media activity','Did you complete your social media activity today?',null,'day','yes_no',1),
  (3,'Project visits','How many project visits did you complete today?','Target: 3 visits a week, counted from each day''s entries.','week','number',3),
  (4,'Verified inventory with owner details','How many verified property inventories with owner details did you complete today?',
    'Self-reported count. Do not enter owner contact details here.','day','number',1),
  (5,'HD Marketing video','How many videos did you complete for the HD Marketing page today?','Target: 1 video a week.','week','number',1)
 ) s(position,title,question,description,frequency,answer_type,target) loop
  insert into public.kpis(title,question,description,position) values(item.title,item.question,item.description,item.position) returning id into k;
  insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target)
   values(k,1,case when item.frequency='week' then public.kpi_week_start(today) else today end,item.frequency,item.answer_type,item.target);
 end loop;
end $seed$;

-- Only the CRM's server calls the functions; the helpers only from them.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('kpi_today','kpi_week_start','kpi_version_on','kpi_json','kpi_version_json','kpi_apply_rules','kpi_check',
   'kpi_admin_list','kpi_save','kpi_archive','kpi_delete','kpi_submit','kpi_facts') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname in ('kpi_admin_list','kpi_save','kpi_archive','kpi_delete','kpi_submit','kpi_facts') then
   execute format('grant execute on function %s to service_role',fn.signature);
  else
   execute format('revoke all on function %s from service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
