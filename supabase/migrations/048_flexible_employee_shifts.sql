-- Apply after 047. Safe to rerun. Flexible office timings (update 048).
-- Office timings at three levels on top of the company policy, highest
-- first:
--  1. an employee's own shift (employee_shifts, from 047);
--  2. their department's shift;
--  3. the default shift for their role (agents or staff);
--  4. the company policy (attendance_policies), as before.
-- Administrators follow the company policy unless given their own shift.
-- Every timing is dated: a change applies from a chosen day (today or
-- later) until the next change, and earlier days keep the timing they had.
-- Each attendance record already keeps the shift it was recorded with, and
-- days are resolved with the role and department the employee had on that
-- day, so moving someone between departments never rewrites their past.
-- Nothing is deleted: saving the same day again adds a newer version, and a
-- planned change is withdrawn rather than removed. "Inherit" rows end an own
-- or department shift from a date, returning to the next level.
-- Shifts are same-day (they end after they start); overnight shifts are not
-- supported, as before.
-- Every change must start from the latest version of the timing it edits
-- (expected_version / p_version): a save or withdrawal made from an older
-- view is refused instead of overwriting a newer change. The 047 withdrawal
-- function without a version is replaced, so no way around this remains.
-- Existing attendance, leave, tasks, reports and accounts are unchanged.
-- Other functions keep their names and arguments. Never apply an older
-- update again after this one.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regclass('public.employee_shifts') is null
  or to_regprocedure('public.attendance_shift_apply(public.attendance_policies,uuid,date)') is null
  or to_regprocedure('public.employees_page(uuid,jsonb,integer,integer)') is null then
  raise exception 'Apply CRM updates up to 047 before update 048.';
 end if;
end $$;

-- ------------------------------------------------- role and department
-- One row per change. inherits=true ends the timing from that day: a
-- department falls back to the role default, a role to the company policy.
create table if not exists public.shift_schedules(
 id uuid primary key default gen_random_uuid(),
 scope text not null check(scope in ('role','department')),
 role text check(role in ('agent','staff')),
 department_id uuid references public.departments(id),
 effective_from date not null,
 inherits boolean not null default false,
 shift_start time,
 shift_end time,
 work_days smallint[],
 grace_minutes integer,
 reason text check(reason is null or (reason=btrim(reason) and length(reason) between 1 and 300)),
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 withdrawn_at timestamptz,
 withdrawn_by uuid references public.profiles(id),
 constraint shift_schedules_target check((scope='role' and role is not null and department_id is null)
  or (scope='department' and department_id is not null and role is null)),
 constraint shift_schedules_times check(
  (inherits and shift_start is null and shift_end is null and work_days is null and grace_minutes is null)
  or (not inherits and shift_end>shift_start and cardinality(work_days) between 1 and 7 and work_days<@'{1,2,3,4,5,6,7}'::smallint[]
   and grace_minutes between 0 and 120 and make_interval(mins=>grace_minutes)<shift_end-shift_start))
);
create index if not exists shift_schedules_role on public.shift_schedules(role,effective_from desc,created_at desc) where scope='role' and withdrawn_at is null;
create index if not exists shift_schedules_department on public.shift_schedules(department_id,effective_from desc,created_at desc) where scope='department' and withdrawn_at is null;

-- Own shifts (047) keep every version too, with a reason.
alter table public.employee_shifts drop constraint if exists employee_shifts_user_id_effective_from_key;
alter table public.employee_shifts
 add column if not exists reason text,
 add column if not exists withdrawn_at timestamptz,
 add column if not exists withdrawn_by uuid references public.profiles(id);
alter table public.employee_shifts drop constraint if exists employee_shifts_reason;
alter table public.employee_shifts add constraint employee_shifts_reason check(reason is null or (reason=btrim(reason) and length(reason) between 1 and 300));
create index if not exists employee_shifts_current on public.employee_shifts(user_id,effective_from desc,created_at desc) where withdrawn_at is null;

-- The role and department each employee had from each day, so a past day is
-- resolved with the groups of that day. Everyone starts with their current
-- role and department; later changes are recorded from the day they happen.
create table if not exists public.employee_group_history(
 user_id uuid not null references public.profiles(id),
 effective_from date not null,
 role text not null,
 department_id uuid references public.departments(id),
 recorded_at timestamptz not null default now(),
 primary key(user_id,effective_from)
);
insert into public.employee_group_history(user_id,effective_from,role,department_id)
select id,'-infinity',role,department_id from public.profiles on conflict do nothing;
create or replace function public.track_employee_group() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  insert into public.employee_group_history(user_id,effective_from,role,department_id) values(new.id,'-infinity',new.role,new.department_id)
  on conflict(user_id,effective_from) do update set role=excluded.role,department_id=excluded.department_id,recorded_at=now();
 elsif new.role is distinct from old.role or new.department_id is distinct from old.department_id then
  -- An account set up today (created, then given its role and department)
  -- has had these groups from the start.
  if public.attendance_local_date(new.created_at)=public.attendance_local_date(now()) then
   update public.employee_group_history set role=new.role,department_id=new.department_id,recorded_at=now() where user_id=new.id;
  end if;
  insert into public.employee_group_history(user_id,effective_from,role,department_id)
  values(new.id,case when public.attendance_local_date(new.created_at)=public.attendance_local_date(now()) then '-infinity'
   else public.attendance_local_date(now()) end,new.role,new.department_id)
  on conflict(user_id,effective_from) do update set role=excluded.role,department_id=excluded.department_id,recorded_at=now();
 end if;
 return null;
end $$;
create or replace trigger track_employee_group after insert or update of role,department_id on public.profiles
 for each row execute function public.track_employee_group();

do $$ declare t text; begin
 foreach t in array array['shift_schedules','employee_group_history'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

-- Employees are told about a change to their office timing.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary',
 'property_source_updated','property_source_removed',
 'task_assigned','task_updated','task_cancelled','task_report','task_report_reviewed','checkout_request','checkout_decision',
 'shift_changed'));

-- ---------------------------------------------------------------- helpers
create or replace function public.work_days_text(p_days smallint[]) returns text language sql immutable set search_path='' as $$
 with d as (select distinct x from unnest(p_days) x where x between 1 and 7),
  n as (select array_agg(x order by x) a from d)
 select case when n.a is null then null
  when cardinality(n.a)>2 and n.a[cardinality(n.a)]-n.a[1]=cardinality(n.a)-1
   then (array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[n.a[1]]||'–'||(array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[n.a[cardinality(n.a)]]
  else (select string_agg((array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[x],', ' order by x) from unnest(n.a) x) end
 from n
$$;
create or replace function public.shift_hours_text(p_start time,p_end time) returns text language sql immutable set search_path='' as $$
 select to_char(p_start,'FMHH12:MI AM')||' – '||to_char(p_end,'FMHH12:MI AM')
$$;
-- The timing rule for an employee on a day, highest level first; source is
-- individual, department, role or company (the company policy applies).
create or replace function public.employee_schedule_rule(p_user uuid,p_day date)
returns table(source text,source_label text,rule_id uuid,rule_from date,label text,shift_start time,shift_end time,work_days smallint[],grace_minutes integer)
language plpgsql stable security definer set search_path='' as $$
declare own public.employee_shifts;grp public.employee_group_history;sch public.shift_schedules;
begin
 select * into own from public.employee_shifts where user_id=p_user and effective_from<=p_day and withdrawn_at is null
  order by effective_from desc,created_at desc limit 1;
 if found and not own.follows_company then
  return query select 'individual'::text,'Individual shift'::text,own.id,own.effective_from,own.label,own.shift_start,own.shift_end,own.work_days,own.grace_minutes;
  return;
 end if;
 select * into grp from public.employee_group_history where user_id=p_user and effective_from<=p_day order by effective_from desc limit 1;
 if found and grp.role in ('agent','staff') then
  if grp.department_id is not null then
   select * into sch from public.shift_schedules where scope='department' and department_id=grp.department_id and effective_from<=p_day and withdrawn_at is null
    order by effective_from desc,created_at desc limit 1;
   if found and not sch.inherits then
    return query select 'department'::text,coalesce(public.department_name(grp.department_id),'Department')||' department shift',sch.id,sch.effective_from,
     null::text,sch.shift_start,sch.shift_end,sch.work_days,sch.grace_minutes;
    return;
   end if;
  end if;
  select * into sch from public.shift_schedules where scope='role' and role=grp.role and effective_from<=p_day and withdrawn_at is null
   order by effective_from desc,created_at desc limit 1;
  if found and not sch.inherits then
   return query select 'role'::text,case grp.role when 'agent' then 'Agent default shift' else 'Staff default shift' end,sch.id,sch.effective_from,
    null::text,sch.shift_start,sch.shift_end,sch.work_days,sch.grace_minutes;
   return;
  end if;
 end if;
 return query select 'company'::text,'Company default shift'::text,null::uuid,null::date,null::text,null::time,null::time,null::smallint[],null::integer;
end $$;
-- As in 047: p_base (the company rules for the day) with the timing that
-- applies to the employee that day.
create or replace function public.attendance_shift_apply(p_base public.attendance_policies,p_user uuid,p_day date) returns public.attendance_policies language plpgsql stable security definer set search_path='' as $$
declare r record;result public.attendance_policies=p_base;
begin
 if p_base.id is null then return p_base;end if;
 select * into r from public.employee_schedule_rule(p_user,p_day);
 if r.source<>'company' then
  result.name=coalesce(r.label,r.source_label);result.shift_start=r.shift_start;result.shift_end=r.shift_end;
  result.work_days=r.work_days;result.grace_minutes=r.grace_minutes;
 end if;
 return result;
end $$;
-- What an employee follows on a day, and the next day it changes, if any.
create or replace function public.employee_shift_info(p_user uuid,p_day date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r record;pol public.attendance_policies=public.attendance_policy_for(p_user,p_day);grp public.employee_group_history;change_day date;
 u record;upol public.attendance_policies;upcoming jsonb;
begin
 select * into r from public.employee_schedule_rule(p_user,p_day);
 select * into grp from public.employee_group_history where user_id=p_user and effective_from<=p_day order by effective_from desc limit 1;
 -- Days something is planned to change at any level; the first one that
 -- changes this employee's timing or where it comes from.
 for change_day in select distinct d from (
  select effective_from d from public.employee_shifts where user_id=p_user and effective_from>p_day and withdrawn_at is null
  union all select effective_from from public.shift_schedules where scope='department' and department_id=grp.department_id and grp.role in ('agent','staff')
   and effective_from>p_day and withdrawn_at is null
  union all select effective_from from public.shift_schedules where scope='role' and role=grp.role and effective_from>p_day and withdrawn_at is null
  union all select effective_from from public.attendance_policies where effective_from>p_day) x order by d limit 20 loop
  select * into u from public.employee_schedule_rule(p_user,change_day);
  upol=public.attendance_policy_for(p_user,change_day);
  if u.source_label is distinct from r.source_label or upol.name is distinct from pol.name
   or concat_ws('|',upol.shift_start,upol.shift_end,upol.work_days::text,upol.grace_minutes)
    is distinct from concat_ws('|',pol.shift_start,pol.shift_end,pol.work_days::text,pol.grace_minutes) then
   upcoming=jsonb_build_object('effective_from',change_day,'source',u.source,'source_label',u.source_label,
    'label',coalesce(u.label,upol.name),'shift_start',to_char(upol.shift_start,'HH24:MI'),'shift_end',to_char(upol.shift_end,'HH24:MI'),
    'work_days',to_jsonb(upol.work_days),'grace_minutes',upol.grace_minutes);
   exit;
  end if;
 end loop;
 return jsonb_build_object('source',r.source,'source_label',r.source_label,'label',coalesce(r.label,pol.name),
  'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),'work_days',to_jsonb(pol.work_days),
  'grace_minutes',pol.grace_minutes,'effective_from',r.rule_from,'upcoming',upcoming);
end $$;
-- The effective timing as one comparable value, to tell who a change affects.
create or replace function public.shift_signature(p_user uuid,p_day date) returns text language sql stable security definer set search_path='' as $$
 select concat_ws('|',p.shift_start,p.shift_end,p.work_days::text,p.grace_minutes) from public.attendance_policy_for(p_user,p_day) p
$$;
-- In words, for notices: "12:00 PM – 8:00 PM, Mon–Sat (Media department shift)".
create or replace function public.shift_summary(p_user uuid,p_day date) returns text language plpgsql stable security definer set search_path='' as $$
declare pol public.attendance_policies=public.attendance_policy_for(p_user,p_day);r record;
begin
 if pol.id is null then return null;end if;
 select * into r from public.employee_schedule_rule(p_user,p_day);
 return public.shift_hours_text(pol.shift_start,pol.shift_end)||', '||public.work_days_text(pol.work_days)||' ('||r.source_label||')';
end $$;
-- Tells each employee whose timing from p_day differs from p_before (their
-- signatures before the change), once per change (p_group).
create or replace function public.shift_notify(p_before jsonb,p_day date,p_group text,p_intro text) returns integer language plpgsql security definer set search_path='' as $$
declare item record;n integer=0;
begin
 for item in select key::uuid id,value from jsonb_each_text(p_before) loop
  if public.shift_signature(item.id,p_day) is distinct from item.value then
   perform public.push_notification(item.id,'shift_changed',p_group,'Your office timing has been updated',
    left(p_intro||' From '||to_char(p_day,'FMDD FMMonth YYYY')||' your office timing is '
     ||coalesce(public.shift_summary(item.id,p_day),'the company default shift')||'.',500),'/attendance',null);
   n=n+1;
  end if;
 end loop;
 return n;
end $$;
-- Checks a timing in p_data (shift_start, shift_end, work_days,
-- grace_minutes) and the date it starts from.
create or replace function public.shift_parse(p_data jsonb,p_today date,
 out effective_from date,out shift_start time,out shift_end time,out work_days smallint[],out grace_minutes integer,out reason text)
language plpgsql stable set search_path='' as $$
begin
 effective_from=coalesce((p_data->>'effective_from')::date,p_today);
 if effective_from<p_today or effective_from>p_today+365 then
  raise exception 'Choose today or a date up to a year ahead. Days already worked keep the shift they had.' using errcode='HA400';end if;
 reason=nullif(regexp_replace(btrim(coalesce(p_data->>'reason','')),'\s+',' ','g'),'');
 if length(reason)>300 then raise exception 'Keep the reason under 300 characters' using errcode='HA400';end if;
 if coalesce((p_data->>'inherit')::boolean,false) then return;end if;
 shift_start=(p_data->>'shift_start')::time;shift_end=(p_data->>'shift_end')::time;grace_minutes=(p_data->>'grace_minutes')::integer;
 if shift_start is null or shift_end is null or shift_end<=shift_start then
  raise exception 'The shift must end after it starts, on the same day. Overnight shifts are not supported.' using errcode='HA400';end if;
 if jsonb_typeof(p_data->'work_days') is distinct from 'array' then raise exception 'Choose the working days' using errcode='HA400';end if;
 work_days=array(select distinct x::smallint from jsonb_array_elements_text(p_data->'work_days') x order by 1);
 if cardinality(work_days) not between 1 and 7 or not work_days<@'{1,2,3,4,5,6,7}'::smallint[] then
  raise exception 'Choose the working days' using errcode='HA400';end if;
 if grace_minutes is null or grace_minutes not between 0 and 120 or make_interval(mins=>grace_minutes)>=shift_end-shift_start then
  raise exception 'Choose a grace period of 0 to 120 minutes, shorter than the shift' using errcode='HA400';end if;
end $$;
-- A role or department timing as administrators see it.
create or replace function public.shift_schedule_json(p_row public.shift_schedules) returns jsonb language sql stable security definer set search_path='' as $$
 select case when p_row.id is null then null else jsonb_build_object('id',p_row.id,'effective_from',p_row.effective_from,'inherits',p_row.inherits,
  'shift_start',to_char(p_row.shift_start,'HH24:MI'),'shift_end',to_char(p_row.shift_end,'HH24:MI'),'work_days',to_jsonb(p_row.work_days),
  'grace_minutes',p_row.grace_minutes,'reason',p_row.reason,'created_by_name',(select name from public.profiles where id=p_row.created_by),
  'created_at',p_row.created_at) end
$$;
-- The timing set for a role or department on a day (its own rule, if any).
create or replace function public.shift_default_at(p_scope text,p_target text,p_day date) returns public.shift_schedules language sql stable security definer set search_path='' as $$
 select * from public.shift_schedules where scope=p_scope and withdrawn_at is null and effective_from<=p_day
  and case when p_scope='role' then role=p_target else department_id::text=p_target end
 order by effective_from desc,created_at desc limit 1
$$;
-- Active agents and staff in a role or department on a day.
create or replace function public.shift_group_members(p_scope text,p_target text,p_day date) returns uuid[] language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(p.id order by p.id),'{}') from public.profiles p
 join lateral (select * from public.employee_group_history g where g.user_id=p.id and g.effective_from<=p_day order by g.effective_from desc limit 1) g on true
 where p.active and p.deleted_at is null and g.role in ('agent','staff')
  and case when p_scope='role' then g.role=p_target else g.department_id::text=p_target end
$$;
-- Changes when a timing was last saved or withdrawn: a save made from an
-- older view of the timing is refused instead of overwriting the newer one.
create or replace function public.shift_version(p_scope text,p_target text) returns text language sql stable security definer set search_path='' as $$
 select md5(coalesce(string_agg(x.id::text||':'||coalesce(x.withdrawn_at::text,''),',' order by x.id),'')) from (
  select id,withdrawn_at from public.employee_shifts where p_scope='individual' and user_id::text=p_target
  union all select id,withdrawn_at from public.shift_schedules where p_scope in ('role','department') and scope=p_scope
   and case when p_scope='role' then role=p_target else department_id::text=p_target end) x
$$;
-- A role or department with its timing now, its planned changes and how
-- many active employees follow it today.
create or replace function public.shift_target_json(p_scope text,p_target text,p_today date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare members uuid[]=public.shift_group_members(p_scope,p_target,p_today);
begin
 return jsonb_build_object('current',public.shift_schedule_json(public.shift_default_at(p_scope,p_target,p_today)),
  'planned',(select coalesce(jsonb_agg(public.shift_schedule_json(s) order by s.effective_from),'[]'::jsonb) from (
    select distinct on (effective_from) * from public.shift_schedules where scope=p_scope and withdrawn_at is null and effective_from>p_today
     and case when p_scope='role' then role=p_target else department_id::text=p_target end
    order by effective_from,created_at desc) s),
  'version',public.shift_version(p_scope,p_target),'members',cardinality(members),
  'following',(select count(*) from unnest(members) m where (select r.source from public.employee_schedule_rule(m,p_today) r)=p_scope));
end $$;

-- Gives an employee their own timing from a date, or with inherit ends it
-- from that date (they return to their department, role or company timing).
-- p_data: effective_from, label, shift_start, shift_end, work_days,
-- grace_minutes, reason and expected_version (shift_version from
-- employee_detail, required).
create or replace function public.employee_shift_save(p_actor uuid,p_user uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);person public.profiles;today date=public.attendance_local_date(now());
 t record;inherit boolean;shift_label text;cur public.employee_shifts;before jsonb;was jsonb;saved public.employee_shifts;notified integer;
begin
 if jsonb_typeof(p_data) is distinct from 'object'
  or (p_data-array['effective_from','inherit','label','shift_start','shift_end','work_days','grace_minutes','reason','expected_version'])<>'{}'::jsonb
  or (p_data?'inherit' and jsonb_typeof(p_data->'inherit') is distinct from 'boolean') then
  raise exception 'Invalid shift details' using errcode='HA400';end if;
 if jsonb_typeof(p_data->'expected_version') is distinct from 'string' then
  raise exception 'Make this change in Shift management, which checks you are editing the latest timing' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and deleted_at is null and role in ('admin','agent','staff') for share;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 select * into t from public.shift_parse(p_data,today);
 inherit=t.shift_start is null;
 if not inherit then
  shift_label=coalesce(nullif(regexp_replace(btrim(coalesce(p_data->>'label','')),'\s+',' ','g'),''),'Individual shift');
  if length(shift_label)>60 then raise exception 'Keep the shift name under 60 characters' using errcode='HA400';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('shift-schedules',48));
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_user,40));
 if p_data->>'expected_version'<>public.shift_version('individual',p_user::text) then
  raise exception 'This employee''s shift was changed a moment ago. Reload to see the latest before saving.' using errcode='HA409';end if;
 select * into cur from public.employee_shifts where user_id=p_user and effective_from<=t.effective_from and withdrawn_at is null
  order by effective_from desc,created_at desc limit 1;
 if inherit and (cur.id is null or cur.follows_company) then
  raise exception 'This employee has no individual shift on that date' using errcode='HA409';end if;
 if not inherit and cur.id is not null and not cur.follows_company and cur.label=shift_label and cur.shift_start=t.shift_start
  and cur.shift_end=t.shift_end and cur.work_days=t.work_days and cur.grace_minutes=t.grace_minutes then
  raise exception 'This is already their individual shift on that date' using errcode='HA409';end if;
 before=public.employee_shift_info(p_user,t.effective_from);
 was=case when p_user=actor.id then '{}'::jsonb else jsonb_build_object(p_user,public.shift_signature(p_user,t.effective_from)) end;
 insert into public.employee_shifts(user_id,effective_from,follows_company,label,shift_start,shift_end,work_days,grace_minutes,reason,created_by)
 values(p_user,t.effective_from,inherit,shift_label,t.shift_start,t.shift_end,t.work_days,t.grace_minutes,t.reason,actor.id)
 returning * into saved;
 notified=public.shift_notify(was,t.effective_from,'shift:'||saved.id,
  case when inherit then 'Your individual office timing has been removed.' else 'You have been given an individual office timing.' end);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'employee.shift_changed','profiles',p_user::text,p_request,jsonb_build_object('user_id',p_user,'role',person.role,
  'effective_from',t.effective_from,'inherits',inherit,'reason',t.reason,'notified',notified,
  'before',before-'upcoming'-'effective_from','after',public.employee_shift_info(p_user,t.effective_from)-'upcoming'-'effective_from'));
 return public.employee_detail(p_actor,p_user);
end $$;
-- Withdraws an employee's planned change that has not started yet, from the
-- version that was shown (p_version). The row stays in the history, marked
-- withdrawn. Replaces the 047 form without a version.
drop function if exists public.employee_shift_cancel(uuid,uuid,date,text);
create or replace function public.employee_shift_cancel(p_actor uuid,p_user uuid,p_from date,p_version text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());gone public.employee_shifts;
 was jsonb;notified integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('shift-schedules',48));
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_user,40));
 if p_version is null then
  raise exception 'Make this change in Shift management, which checks you are editing the latest timing' using errcode='HA400';end if;
 if p_version<>public.shift_version('individual',p_user::text) then
  raise exception 'This employee''s shift was changed a moment ago. Reload to see the latest before withdrawing.' using errcode='HA409';end if;
 if p_from is null or p_from<=today
  or not exists(select 1 from public.employee_shifts where user_id=p_user and effective_from=p_from and withdrawn_at is null) then
  raise exception 'Only a shift change that has not started yet can be withdrawn' using errcode='HA409';end if;
 was=case when p_user=actor.id then '{}'::jsonb else jsonb_build_object(p_user,public.shift_signature(p_user,p_from)) end;
 with w as (update public.employee_shifts set withdrawn_at=now(),withdrawn_by=actor.id
  where user_id=p_user and effective_from=p_from and withdrawn_at is null returning *)
 select * into gone from w order by created_at desc limit 1;
 notified=public.shift_notify(was,p_from,'shift-withdrawn:'||gone.id,'A planned change to your office timing was withdrawn.');
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'employee.shift_cancelled','profiles',p_user::text,p_request,jsonb_build_object('user_id',p_user,'effective_from',p_from,
  'label',gone.label,'follows_company',gone.follows_company,'inherits',gone.follows_company,'notified',notified));
 return public.employee_detail(p_actor,p_user);
end $$;

-- Sets the timing of a role (p_target agent or staff) or a department
-- (p_target its id) from a date, or with inherit ends it from that date,
-- starting from the version shown (expected_version, required). Everyone
-- whose timing changes is told once.
create or replace function public.shift_default_save(p_actor uuid,p_scope text,p_target text,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());t record;
 dep public.departments;target_name text;cur public.shift_schedules;saved public.shift_schedules;was jsonb;notified integer;
begin
 if p_scope is null or p_scope not in ('role','department') or jsonb_typeof(p_data) is distinct from 'object'
  or (p_data-array['effective_from','inherit','shift_start','shift_end','work_days','grace_minutes','reason','expected_version'])<>'{}'::jsonb
  or (p_data?'inherit' and jsonb_typeof(p_data->'inherit') is distinct from 'boolean') then
  raise exception 'Invalid shift details' using errcode='HA400';end if;
 if jsonb_typeof(p_data->'expected_version') is distinct from 'string' then
  raise exception 'Make this change in Shift management, which checks you are editing the latest timing' using errcode='HA400';end if;
 if p_scope='role' then
  if p_target is null or p_target not in ('agent','staff') then raise exception 'Choose agents or staff' using errcode='HA400';end if;
  target_name=case p_target when 'agent' then 'Agent default' else 'Staff default' end;
 else
  if p_target is null or p_target!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception 'Department not found' using errcode='HA404';end if;
  select * into dep from public.departments where id=p_target::uuid;
  if not found then raise exception 'Department not found' using errcode='HA404';end if;
  target_name=dep.name||' department';
 end if;
 select * into t from public.shift_parse(p_data,today);
 if p_scope='department' and not dep.active and t.shift_start is not null then
  raise exception 'This department is inactive. Make it active before giving it a shift.' using errcode='HA409';end if;
 perform pg_advisory_xact_lock(hashtextextended('shift-schedules',48));
 if p_data->>'expected_version'<>public.shift_version(p_scope,p_target) then
  raise exception 'This shift was changed a moment ago. Reload to see the latest before saving.' using errcode='HA409';end if;
 cur=public.shift_default_at(p_scope,p_target,t.effective_from);
 if t.shift_start is null and (cur.id is null or cur.inherits) then
  raise exception 'The % has no shift of its own on that date',lower(target_name) using errcode='HA409';end if;
 if t.shift_start is not null and cur.id is not null and not cur.inherits and cur.shift_start=t.shift_start and cur.shift_end=t.shift_end
  and cur.work_days=t.work_days and cur.grace_minutes=t.grace_minutes then
  raise exception 'This is already the % shift on that date',lower(target_name) using errcode='HA409';end if;
 select coalesce(jsonb_object_agg(m,coalesce(public.shift_signature(m,t.effective_from),'')),'{}'::jsonb) into was
  from unnest(public.shift_group_members(p_scope,p_target,t.effective_from)) m;
 insert into public.shift_schedules(scope,role,department_id,effective_from,inherits,shift_start,shift_end,work_days,grace_minutes,reason,created_by)
 values(p_scope,case when p_scope='role' then p_target end,case when p_scope='department' then p_target::uuid end,t.effective_from,
  t.shift_start is null,t.shift_start,t.shift_end,t.work_days,t.grace_minutes,t.reason,actor.id)
 returning * into saved;
 notified=public.shift_notify(was,t.effective_from,'shift:'||saved.id,
  case when saved.inherits then 'The '||target_name||' shift has ended.' else 'The '||target_name||' shift has changed.' end);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'shift.default_changed','shift_schedules',saved.id::text,p_request,jsonb_build_object('scope',p_scope,
  'role',saved.role,'department_id',saved.department_id,'department',dep.name,'target',target_name,'effective_from',saved.effective_from,
  'inherits',saved.inherits,'reason',saved.reason,'notified',notified,'affected',(select count(*) from jsonb_object_keys(was)),
  'before',public.shift_schedule_json(cur)-'id'-'created_by_name'-'created_at'-'reason',
  'after',public.shift_schedule_json(saved)-'id'-'created_by_name'-'created_at'-'reason'));
 return public.shift_overview(p_actor);
end $$;
-- Withdraws a planned role or department change that has not started yet,
-- from the version that was shown (p_version). Replaces an earlier draft of
-- this update without a version.
drop function if exists public.shift_default_cancel(uuid,text,text,date,text);
create or replace function public.shift_default_cancel(p_actor uuid,p_scope text,p_target text,p_from date,p_version text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());target_name text;
 gone public.shift_schedules;was jsonb;notified integer;
begin
 if p_scope is null or p_scope not in ('role','department') or p_target is null
  or (p_scope='role' and p_target not in ('agent','staff'))
  or (p_scope='department' and p_target!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'Shift not found' using errcode='HA404';end if;
 target_name=case when p_scope='role' then case p_target when 'agent' then 'Agent default' else 'Staff default' end
  else coalesce(public.department_name(p_target::uuid),'Department')||' department' end;
 perform pg_advisory_xact_lock(hashtextextended('shift-schedules',48));
 if p_version is null then
  raise exception 'Make this change in Shift management, which checks you are editing the latest timing' using errcode='HA400';end if;
 if p_version<>public.shift_version(p_scope,p_target) then
  raise exception 'This shift was changed a moment ago. Reload to see the latest before withdrawing.' using errcode='HA409';end if;
 if p_from is null or p_from<=today or not exists(select 1 from public.shift_schedules where scope=p_scope and effective_from=p_from
   and withdrawn_at is null and case when p_scope='role' then role=p_target else department_id::text=p_target end) then
  raise exception 'Only a shift change that has not started yet can be withdrawn' using errcode='HA409';end if;
 select coalesce(jsonb_object_agg(m,coalesce(public.shift_signature(m,p_from),'')),'{}'::jsonb) into was
  from unnest(public.shift_group_members(p_scope,p_target,p_from)) m;
 with w as (update public.shift_schedules set withdrawn_at=now(),withdrawn_by=actor.id
  where scope=p_scope and effective_from=p_from and withdrawn_at is null
   and case when p_scope='role' then role=p_target else department_id::text=p_target end returning *)
 select * into gone from w order by created_at desc limit 1;
 notified=public.shift_notify(was,p_from,'shift-withdrawn:'||gone.id,'A planned change to the '||target_name||' shift was withdrawn.');
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'shift.default_withdrawn','shift_schedules',gone.id::text,p_request,jsonb_build_object('scope',p_scope,
  'role',gone.role,'department_id',gone.department_id,'department',public.department_name(gone.department_id),'target',target_name,
  'effective_from',p_from,'inherits',gone.inherits,'notified',notified,
  'withdrawn',public.shift_schedule_json(gone)-'id'-'created_by_name'-'created_at'-'reason'));
 return public.shift_overview(p_actor);
end $$;

-- ------------------------------------------------------- administrators
-- These read but are not stable: the API runs stable functions read-only,
-- and the administrator check locks the actor's profile row.
-- The company policy and every role and department timing.
create or replace function public.shift_overview(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());
 pol public.attendance_policies=public.attendance_policy_on(today);
begin
 return jsonb_build_object('today',today,
  'company',case when pol.id is null then null else jsonb_build_object('name',pol.name,'shift_start',to_char(pol.shift_start,'HH24:MI'),
   'shift_end',to_char(pol.shift_end,'HH24:MI'),'work_days',to_jsonb(pol.work_days),'grace_minutes',pol.grace_minutes,
   'effective_from',pol.effective_from) end,
  'roles',(select jsonb_agg(jsonb_build_object('role',r.role,'name',r.name)||public.shift_target_json('role',r.role,today) order by r.n)
   from (values ('agent','Agents',1),('staff','Staff',2)) r(role,name,n)),
  'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'active',d.active)
    ||public.shift_target_json('department',d.id::text,today) order by d.sort_order,lower(d.name)),'[]'::jsonb) from public.departments d),
  'individual',(select count(*) from public.profiles p where p.active and p.deleted_at is null and p.role in ('admin','agent','staff')
   and (select r.source from public.employee_schedule_rule(p.id,today) r)='individual'));
end $$;
-- Employees with the timing they follow today and where it comes from.
-- p_filters: search (name, UID or email), role, department (id or none),
-- source (individual, department, role, company), account (active, inactive).
create or replace function public.shift_employees_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);today date=public.attendance_local_date(now());
 term text=nullif(lower(btrim(coalesce(f->>'search',''))),'');result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 or jsonb_typeof(f)<>'object'
  or (f-array['search','role','department','source','account'])<>'{}'::jsonb or length(coalesce(f->>'search',''))>100
  or coalesce(f->>'role','admin') not in ('admin','agent','staff') or coalesce(f->>'account','active') not in ('active','inactive')
  or coalesce(f->>'source','company') not in ('individual','department','role','company')
  or (f->>'department' is not null and f->>'department'<>'none' and f->>'department'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'Invalid employee filter' using errcode='HA400';end if;
 with people as (
  select p.id,p.uid,p.name,to_jsonb(u)->>'email' email,p.role,p.active,p.department_id,public.department_name(p.department_id) department,
   p.job_title,r.source,r.source_label
  from public.profiles p join auth.users u on u.id=p.id cross join lateral public.employee_schedule_rule(p.id,today) r
  where p.deleted_at is null and p.role in ('admin','agent','staff')
 ), filtered as (
  select * from people pe
  where (term is null or position(term in lower(pe.name))>0 or position(term in lower(coalesce(pe.email,'')))>0 or pe.uid::text=term)
   and (f->>'role' is null or pe.role=f->>'role')
   and (f->>'department' is null or (f->>'department'='none' and pe.department_id is null) or pe.department_id::text=f->>'department')
   and (f->>'account' is null or pe.active=(f->>'account'='active'))
   and (f->>'source' is null or pe.source=f->>'source')
 ), page as (select * from filtered order by lower(name),id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('date',today,'count',(select count(*) from filtered),'page',p_page,'limit',p_limit,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',pg.id,'uid',pg.uid,'name',pg.name,'email',pg.email,'role',pg.role,'active',pg.active,
    'department_id',pg.department_id,'department',pg.department,'job_title',pg.job_title,
    'shift',public.employee_shift_info(pg.id,today),'version',public.shift_version('individual',pg.id::text),
    'planned',(select coalesce(jsonb_agg(jsonb_build_object('effective_from',s.effective_from,'inherits',s.follows_company,'label',s.label,
      'shift_start',to_char(s.shift_start,'HH24:MI'),'shift_end',to_char(s.shift_end,'HH24:MI'),'work_days',to_jsonb(s.work_days),
      'grace_minutes',s.grace_minutes,'reason',s.reason) order by s.effective_from),'[]'::jsonb)
     from (select distinct on (effective_from) * from public.employee_shifts where user_id=pg.id and withdrawn_at is null and effective_from>today
      order by effective_from,created_at desc) s))
   order by lower(pg.name),pg.id) from page pg),'[]'::jsonb),
  'summary',jsonb_build_object('individual',(select count(*) from people where active and source='individual'),
   'department',(select count(*) from people where active and source='department'),
   'role',(select count(*) from people where active and source='role'),
   'company',(select count(*) from people where active and source='company'))) into result;
 return result;
end $$;
-- Every timing ever saved, newest first, with whether it is in effect.
-- p_filters: search (whose timing), scope (individual, role, department),
-- status (current, planned, ended, replaced, withdrawn), user (an employee).
create or replace function public.shift_history_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);today date=public.attendance_local_date(now());
 term text=nullif(lower(btrim(coalesce(f->>'search',''))),'');result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 or jsonb_typeof(f)<>'object'
  or (f-array['search','scope','status','user'])<>'{}'::jsonb or length(coalesce(f->>'search',''))>100
  or coalesce(f->>'scope','role') not in ('individual','role','department')
  or coalesce(f->>'status','current') not in ('current','planned','ended','replaced','withdrawn')
  or (f->>'user' is not null and f->>'user'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'Invalid history filter' using errcode='HA400';end if;
 with entries as (
  select s.id,'individual'::text scope,s.user_id::text target,p.name target_name,p.uid,s.effective_from,s.follows_company inherits,s.label,
   s.shift_start,s.shift_end,s.work_days,s.grace_minutes,s.reason,s.created_by,s.created_at,s.withdrawn_at,s.withdrawn_by
  from public.employee_shifts s join public.profiles p on p.id=s.user_id
  union all
  select s.id,s.scope,coalesce(s.role,s.department_id::text),
   case when s.scope='role' then case s.role when 'agent' then 'Agents' else 'Staff' end else coalesce(public.department_name(s.department_id),'Department') end,
   null,s.effective_from,s.inherits,null,s.shift_start,s.shift_end,s.work_days,s.grace_minutes,s.reason,s.created_by,s.created_at,s.withdrawn_at,s.withdrawn_by
  from public.shift_schedules s
 ), ranked as (
  select e.*,
   case when e.withdrawn_at is not null then 'withdrawn'
    when row_number() over (partition by e.scope,e.target,e.effective_from,e.withdrawn_at is null order by e.created_at desc)>1 then 'replaced'
    when e.effective_from>today then 'planned'
    when e.id=(select c.id from entries c where c.scope=e.scope and c.target=e.target and c.withdrawn_at is null and c.effective_from<=today
     order by c.effective_from desc,c.created_at desc limit 1) then 'current'
    else 'ended' end status
  from entries e
 ), filtered as (
  select * from ranked r
  where (term is null or position(term in lower(r.target_name))>0 or r.uid::text=term)
   and (f->>'scope' is null or r.scope=f->>'scope')
   and (f->>'status' is null or r.status=f->>'status')
   and (f->>'user' is null or (r.scope='individual' and r.target=f->>'user'))
 ), page as (select * from filtered order by created_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('date',today,'count',(select count(*) from filtered),'page',p_page,'limit',p_limit,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',pg.id,'scope',pg.scope,'target',pg.target,'target_name',pg.target_name,'uid',pg.uid,
    'effective_from',pg.effective_from,'inherits',pg.inherits,'label',pg.label,'shift_start',to_char(pg.shift_start,'HH24:MI'),
    'shift_end',to_char(pg.shift_end,'HH24:MI'),'work_days',to_jsonb(pg.work_days),'grace_minutes',pg.grace_minutes,'reason',pg.reason,
    'status',pg.status,'created_by_name',(select name from public.profiles where id=pg.created_by),'created_at',pg.created_at,
    'withdrawn_at',pg.withdrawn_at,'withdrawn_by_name',(select name from public.profiles where id=pg.withdrawn_by))
   order by pg.created_at desc,pg.id) from page pg),'[]'::jsonb)) into result;
 return result;
end $$;
-- As in 047, with every version of the employee's own shift (withdrawn ones
-- included) and the version a save must start from.
create or replace function public.employee_detail(p_actor uuid,p_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);p public.profiles;today date=public.attendance_local_date(now());
begin
 select * into p from public.profiles where id=p_user and deleted_at is null and role in ('admin','agent','staff');
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 return jsonb_build_object('id',p.id,'uid',p.uid,'name',p.name,'role',p.role,'active',p.active,
  'email',(select to_jsonb(u)->>'email' from auth.users u where u.id=p.id),
  'department_id',p.department_id,'department',public.department_name(p.department_id),'job_title',p.job_title,'joined_on',p.joined_on,
  'created_at',p.created_at,'today',today,'shift',public.employee_shift_info(p.id,today),
  'shift_version',public.shift_version('individual',p.id::text),
  'shifts',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'effective_from',s.effective_from,
    'source',case when s.follows_company then 'inherit' else 'individual' end,'inherits',s.follows_company,'label',s.label,
    'shift_start',to_char(s.shift_start,'HH24:MI'),'shift_end',to_char(s.shift_end,'HH24:MI'),'work_days',to_jsonb(s.work_days),
    'grace_minutes',s.grace_minutes,'reason',s.reason,'created_by_name',(select name from public.profiles where id=s.created_by),'created_at',s.created_at,
    'withdrawn_at',s.withdrawn_at,'withdrawn_by_name',(select name from public.profiles where id=s.withdrawn_by),
    'upcoming',s.effective_from>today and s.withdrawn_at is null) order by s.effective_from desc,s.created_at desc),'[]'::jsonb)
   from public.employee_shifts s where s.user_id=p.id));
end $$;
-- As in 047, with where the employee's timing comes from (their own shift,
-- their department's, their role's or the company's) and its next change.
create or replace function public.attendance_me(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(now());pol public.attendance_policies=public.attendance_policy_for(p_actor,today);
 info jsonb=public.employee_shift_info(p_actor,today);month_start date=date_trunc('month',today)::date;result jsonb;
begin
 select jsonb_build_object(
  'server_now',now(),'date',today,
  'employee',jsonb_build_object('id',actor.id,'name',actor.name,'uid',actor.uid,'role',actor.role,
   'department',public.department_name(actor.department_id),'job_title',actor.job_title),
  'policy',case when pol.id is null then null else jsonb_build_object('name',pol.name,'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),
   'work_days',to_jsonb(pol.work_days),'grace_minutes',pol.grace_minutes,'timezone',pol.timezone,
   'assigned',info->>'source'='individual','source',info->'source','source_label',info->'source_label','upcoming',info->'upcoming') end,
  'today',(select to_jsonb(d) from public.attendance_days(today,today,p_actor,now()) d),
  'month',(select to_jsonb(t)-'user_id' from public.attendance_totals(month_start,today,p_actor,now()) t),
  'recent',(select coalesce(jsonb_agg(to_jsonb(d)-'user_id' order by d.day desc),'[]'::jsonb) from public.attendance_days(today-13,today,p_actor,now()) d where d.state not in ('not_tracked','not_employed')),
  'incomplete',(select coalesce(jsonb_agg(jsonb_build_object('date',d.day,'check_in_at',d.check_in_at,'pending_correction',d.pending_correction) order by d.day desc),'[]'::jsonb)
   from public.attendance_days(today-45,today-1,p_actor,now()) d where d.state='incomplete'),
  'pending_leave',(select count(*) from public.attendance_leave_requests where user_id=p_actor and status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where user_id=p_actor and status='pending')) into result;
 return result;
end $$;

-- ---------------------------------------------------------------- grants
-- Browser roles get nothing. Restated functions keep their privileges; the
-- new ones the API calls are granted to the service role, and the helpers run
-- only inside other functions.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('shift_default_save','shift_default_cancel','shift_overview','shift_employees_page','shift_history_page',
   'employee_shift_save','employee_shift_cancel','employee_detail','attendance_me','track_employee_group','work_days_text','shift_hours_text',
   'employee_schedule_rule','attendance_shift_apply','employee_shift_info','shift_signature','shift_summary','shift_notify','shift_parse',
   'shift_schedule_json','shift_default_at','shift_group_members','shift_version','shift_target_json') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('shift_default_save','shift_default_cancel','shift_overview','shift_employees_page','shift_history_page',
   'employee_shift_save','employee_shift_cancel','employee_detail','attendance_me') then
   execute format('grant execute on function %s to service_role',f.signature);
  else
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
