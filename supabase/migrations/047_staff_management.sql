-- Apply after 046. Safe to rerun. Staff accounts, departments and shifts
-- (update 047).
-- * A third role, staff, for office employees who are not sales agents
--   (video editors, designers, developers, IT support and others). Staff
--   check in and out, request leave, receive daily tasks, submit daily
--   reports and use the checkout approvals of 045, exactly like agents. They
--   get no leads, calls, inventory, documents or reports: the API refuses
--   every other request from a staff account.
-- * Departments (Sales, Media, Technical, Operations / Other, and any an
--   administrator adds later) are separate from roles. Every account can
--   have a department, a job title and a joining date.
-- * Shifts per employee: from a chosen date (today or later) an employee can
--   follow their own shift instead of the company policy. Each attendance
--   record keeps the shift it was recorded with, and earlier days keep the
--   rules they had, so nothing already recorded or reported changes.
-- * Tasks can go to chosen people, all agents, all staff or whole
--   departments; each person gets their own assignment, decided when the task
--   is assigned. Performance can be filtered by department.
-- Existing accounts, UIDs, attendance, leave, tasks and reports are
-- unchanged; existing accounts have no department until one is chosen.
-- Functions keep their names and arguments. Two get a further version with a
-- department filter (task_performance, attendance_leave_page); the earlier
-- versions still work. Never apply an older update again after this one.
-- Runs as one transaction in a few seconds; profiles, tasks and a few small
-- tables are locked briefly. If a lock is not available within 5 seconds
-- everything rolls back unchanged: run it again later.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.property_category_list()') is null
  or to_regprocedure('public.task_missing_reports_at(uuid,date,date,timestamp with time zone)') is null
  or to_regprocedure('public.attendance_admin_rules(date)') is null then
  raise exception 'Apply CRM updates up to 046 before update 047.';
 end if;
end $$;

-- ----------------------------------------------------------------- roles
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check(role in ('admin','agent','staff'));
alter table public.account_provisioning drop constraint if exists account_provisioning_requested_role_check;
alter table public.account_provisioning add constraint account_provisioning_requested_role_check check(requested_role in ('admin','agent','staff'));
-- The sign-in history grows; its rows are checked without blocking sign-ins.
alter table public.login_events drop constraint if exists login_events_portal_check;
alter table public.login_events add constraint login_events_portal_check check(portal in ('admin','agent','staff')) not valid;
alter table public.login_events validate constraint login_events_portal_check;

-- ----------------------------------------------------------- departments
-- Never deleted (profiles keep their link); an inactive department gets no
-- new members or tasks.
create table if not exists public.departments(
 id uuid primary key default gen_random_uuid(),
 name text not null check(name=btrim(name) and length(name) between 2 and 60),
 sort_order integer not null default 100 check(sort_order between 0 and 10000),
 active boolean not null default true,
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists departments_name on public.departments(lower(name));
do $$ begin
 if not exists(select 1 from pg_trigger where tgrelid='public.departments'::regclass and tgname='touch_updated') then
  create trigger touch_updated before update on public.departments for each row execute function public.touch_updated();
 end if;
end $$;
insert into public.departments(name,sort_order)
select v.name,v.n from (values ('Sales',10),('Media',20),('Technical',30),('Operations / Other',40)) v(name,n)
where not exists(select 1 from public.departments d where lower(d.name)=lower(v.name));

alter table public.profiles
 add column if not exists department_id uuid references public.departments(id),
 add column if not exists job_title text,
 add column if not exists joined_on date;
alter table public.profiles drop constraint if exists profiles_employee_details;
alter table public.profiles add constraint profiles_employee_details check(
 (job_title is null or (job_title=btrim(job_title) and length(job_title) between 1 and 80))
 and (joined_on is null or joined_on>='1990-01-01'));
create index if not exists profiles_department on public.profiles(department_id) where department_id is not null;

-- Chosen when an account is created and saved with its profile.
alter table public.account_provisioning
 add column if not exists requested_department_id uuid references public.departments(id),
 add column if not exists requested_job_title text;
alter table public.account_provisioning drop constraint if exists account_provisioning_requested_job_title;
alter table public.account_provisioning add constraint account_provisioning_requested_job_title check(
 requested_job_title is null or (requested_job_title=btrim(requested_job_title) and length(requested_job_title) between 1 and 80));

-- ---------------------------------------------------------------- shifts
-- From effective_from until the next row, the employee follows either the
-- company policy (follows_company) or this shift. No row: the company policy.
create table if not exists public.employee_shifts(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 effective_from date not null,
 follows_company boolean not null default false,
 label text,
 shift_start time,
 shift_end time,
 work_days smallint[],
 grace_minutes integer,
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 unique(user_id,effective_from),
 constraint employee_shifts_times check(
  (follows_company and label is null and shift_start is null and shift_end is null and work_days is null and grace_minutes is null)
  or (not follows_company and label=btrim(label) and length(label) between 1 and 60
   and shift_end>shift_start and cardinality(work_days) between 1 and 7 and work_days<@'{1,2,3,4,5,6,7}'::smallint[]
   and grace_minutes between 0 and 120 and make_interval(mins=>grace_minutes)<shift_end-shift_start))
);

do $$ declare t text; begin
 foreach t in array array['departments','employee_shifts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

-- ----------------------------------------------------------------- tasks
-- Who a task was for, in words, as it was when assigned.
alter table public.tasks add column if not exists audience jsonb;
alter table public.tasks drop constraint if exists tasks_category_check;
alter table public.tasks add constraint tasks_category_check check(category in ('calls','follow_ups','site_visits','listings','meetings',
 'documents','media','technical','operations','other'));

-- ---------------------------------------------------------------- helpers
create or replace function public.department_name(p_id uuid) returns text language sql stable security definer set search_path='' as $$
 select name from public.departments where id=p_id
$$;
-- The rules for an employee on a day: p_base (the company rules for that
-- day) with the employee's own shift in force that day, if they have one.
create or replace function public.attendance_shift_apply(p_base public.attendance_policies,p_user uuid,p_day date) returns public.attendance_policies language plpgsql stable security definer set search_path='' as $$
declare s public.employee_shifts;result public.attendance_policies=p_base;
begin
 if p_base.id is null then return p_base;end if;
 select * into s from public.employee_shifts where user_id=p_user and effective_from<=p_day order by effective_from desc limit 1;
 if found and not s.follows_company then
  result.name=s.label;result.shift_start=s.shift_start;result.shift_end=s.shift_end;
  result.work_days=s.work_days;result.grace_minutes=s.grace_minutes;
 end if;
 return result;
end $$;
create or replace function public.attendance_policy_for(p_user uuid,p_day date) returns public.attendance_policies language sql stable security definer set search_path='' as $$
 select public.attendance_shift_apply(public.attendance_policy_on(p_day),p_user,p_day)
$$;
create or replace function public.attendance_admin_rules_for(p_user uuid,p_day date) returns public.attendance_policies language sql stable security definer set search_path='' as $$
 select public.attendance_shift_apply(public.attendance_admin_rules(p_day),p_user,p_day)
$$;
-- The shift an employee follows on a day, and the next change if one is set.
create or replace function public.employee_shift_info(p_user uuid,p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 with s as (select * from public.employee_shifts where user_id=p_user and effective_from<=p_day order by effective_from desc limit 1),
  pol as (select * from public.attendance_policy_for(p_user,p_day)),
  nxt as (select * from public.employee_shifts where user_id=p_user and effective_from>p_day order by effective_from limit 1)
 select jsonb_build_object('source',case when exists(select 1 from s where not follows_company) then 'assigned' else 'company' end,
  'label',(select name from pol),'shift_start',(select to_char(shift_start,'HH24:MI') from pol),
  'shift_end',(select to_char(shift_end,'HH24:MI') from pol),'work_days',(select to_jsonb(work_days) from pol),
  'grace_minutes',(select grace_minutes from pol),'effective_from',(select effective_from from s),
  'upcoming',(select jsonb_build_object('effective_from',n.effective_from,'source',case when n.follows_company then 'company' else 'assigned' end,
    'label',n.label,'shift_start',to_char(n.shift_start,'HH24:MI'),'shift_end',to_char(n.shift_end,'HH24:MI'),
    'work_days',to_jsonb(n.work_days),'grace_minutes',n.grace_minutes) from nxt n))
$$;

-- Chosen people for a task: active agents and staff only.
create or replace function public.task_agents(p_ids jsonb,p_all boolean) returns uuid[] language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];bad public.profiles;
begin
 if p_all then
  return array(select id from public.profiles where role='agent' and active and deleted_at is null order by name,id);
 end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 200 then
  raise exception 'Choose at least one person' using errcode='HA400';end if;
 select array_agg(distinct x::uuid) into ids from jsonb_array_elements_text(p_ids) x;
 select p.* into bad from unnest(ids) i left join public.profiles p on p.id=i
  where p.id is null or p.role not in ('agent','staff') or not p.active or p.deleted_at is not null limit 1;
 if found then
  raise exception '% is not an active % and can''t be given tasks',coalesce(bad.name,'An account'),
   case bad.role when 'agent' then 'agent' when 'staff' then 'staff member' else 'agent or staff member' end using errcode='HA400';end if;
 return ids;
end $$;
-- Everyone a new task goes to: chosen people, all active agents, all active
-- staff and the active agents and staff of chosen departments, as they are
-- now. Someone who joins a department later is not added.
create or replace function public.task_recipients(p_data jsonb) returns uuid[] language plpgsql stable security definer set search_path='' as $$
declare ids uuid[]='{}';deps uuid[];bad text;any_group boolean=false;
begin
 if jsonb_typeof(p_data->'assignees') not in ('array','null') then raise exception 'Choose at least one person' using errcode='HA400';end if;
 if jsonb_typeof(p_data->'departments') not in ('array','null') or jsonb_array_length(coalesce(nullif(p_data->'departments','null'::jsonb),'[]'::jsonb))>20 then
  raise exception 'Choose departments from the list' using errcode='HA400';end if;
 if jsonb_array_length(coalesce(nullif(p_data->'assignees','null'::jsonb),'[]'::jsonb))>0 then
  ids=ids||public.task_agents(p_data->'assignees',false);end if;
 if coalesce((p_data->>'all_agents')::boolean,false) then any_group=true;ids=ids||public.task_agents(null,true);end if;
 if coalesce((p_data->>'all_staff')::boolean,false) then
  any_group=true;ids=ids||array(select id from public.profiles where role='staff' and active and deleted_at is null);end if;
 if jsonb_array_length(coalesce(nullif(p_data->'departments','null'::jsonb),'[]'::jsonb))>0 then
  any_group=true;
  select array_agg(distinct x::uuid) into deps from jsonb_array_elements_text(p_data->'departments') x;
  select coalesce(d.name,'A department') into bad from unnest(deps) i left join public.departments d on d.id=i where d.id is null or not d.active limit 1;
  if bad is not null then raise exception '% is not an active department',bad using errcode='HA400';end if;
  ids=ids||array(select id from public.profiles where department_id=any(deps) and role in ('agent','staff') and active and deleted_at is null);
 end if;
 if cardinality(ids)=0 and not any_group then raise exception 'Choose at least one person' using errcode='HA400';end if;
 return array(select distinct x from unnest(ids) x);
end $$;
-- The groups a task was assigned to, in words, kept with the task.
create or replace function public.task_audience(p_data jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 select nullif(jsonb_strip_nulls(jsonb_build_object(
  'all_agents',case when coalesce((p_data->>'all_agents')::boolean,false) then true end,
  'all_staff',case when coalesce((p_data->>'all_staff')::boolean,false) then true end,
  'departments',case when jsonb_typeof(p_data->'departments')='array' and jsonb_array_length(p_data->'departments')>0 then
   (select jsonb_agg(d.name order by d.sort_order,lower(d.name)) from public.departments d
    where d.id::text in (select jsonb_array_elements_text(p_data->'departments'))) end,
  'people',case when jsonb_typeof(p_data->'assignees')='array' and jsonb_array_length(p_data->'assignees')>0 then
   jsonb_array_length(p_data->'assignees') end)),'{}'::jsonb)
$$;


-- ------------------------------------------- restated for staff and shifts

-- As in 040, for staff too.
create or replace function public.attendance_member(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent','staff') for share;
 if not found then raise exception 'Your account is not active' using errcode='HA403';end if;
 return actor;
end $$;

-- As in 040, for staff too, with each employee's own shift for the day.
create or replace function public.attendance_days(p_from date,p_to date,p_user uuid,p_now timestamptz)
returns table(user_id uuid,day date,tracked boolean,eligible boolean,scheduled boolean,holiday text,leave_type text,record_id uuid,
 check_in_at timestamptz,check_out_at timestamptz,state text,punctuality text,late_minutes integer,beyond_grace_minutes integer,
 worked_minutes integer,early_departure_minutes integer,overtime_minutes integer,corrected boolean,shift_start time,shift_end time,
 pending_correction boolean)
language sql stable security definer set search_path='' as $$
 with today as (select public.attendance_local_date(p_now) d),
 people as (
  select p.id from public.profiles p
  where (p_user is null or p.id=p_user) and p.role in ('admin','agent','staff')
   and (exists(select 1 from public.attendance_periods e where e.user_id=p.id and e.starts_on<=p_to and (e.ends_on is null or e.ends_on>=p_from))
    or exists(select 1 from public.attendance_records r where r.user_id=p.id and r.attendance_date between p_from and p_to))
 ),
 days as (select g::date d from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g),
 base as (
  select pe.id uid,dd.d,pol.id pol_id,pol.work_days,pol.shift_start pol_start,pol.shift_end pol_end,
   exists(select 1 from public.attendance_periods e where e.user_id=pe.id and e.starts_on<=dd.d and (e.ends_on is null or e.ends_on>=dd.d)) ok,
   (select h.name from public.attendance_holidays h where h.holiday_date=dd.d) hol,
   (select l.leave_type from public.attendance_leave_requests l where l.user_id=pe.id and l.status='approved' and dd.d between l.start_date and l.end_date limit 1) lv,
   r.*
  from people pe cross join days dd
  left join lateral public.attendance_policy_for(pe.id,dd.d) pol on true
  left join public.attendance_records r on r.user_id=pe.id and r.attendance_date=dd.d
 )
 select b.uid,b.d,b.pol_id is not null,b.ok,
  b.pol_id is not null and b.ok and extract(isodow from b.d)::smallint=any(b.work_days),
  b.hol,b.lv,b.id,b.check_in_at,b.check_out_at,
  case
   when b.id is not null then case when b.state='checked_in' and b.d<t.d then 'incomplete' else b.state end
   when b.pol_id is null then 'not_tracked'
   when not b.ok then 'not_employed'
   when not (extract(isodow from b.d)::smallint=any(b.work_days)) then 'day_off'
   when b.hol is not null then 'holiday'
   when b.lv is not null then 'leave'
   when b.d>t.d then 'upcoming'
   when b.d=t.d and p_now<public.attendance_moment(b.d,b.pol_end) then 'not_checked_in'
   else 'absent'
  end,
  b.punctuality,b.late_minutes,b.beyond_grace_minutes,b.worked_minutes,b.early_departure_minutes,b.overtime_minutes,
  coalesce(b.corrected,false),coalesce(b.shift_start,b.pol_start),coalesce(b.shift_end,b.pol_end),
  exists(select 1 from public.attendance_corrections c where c.user_id=b.uid and c.attendance_date=b.d and c.status='pending')
 from base b cross join today t
$$;

-- As in 040, with the employee's own shift, department and job title.
create or replace function public.attendance_me(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(now());pol public.attendance_policies=public.attendance_policy_for(p_actor,today);
 month_start date=date_trunc('month',today)::date;result jsonb;
begin
 select jsonb_build_object(
  'server_now',now(),'date',today,
  'employee',jsonb_build_object('id',actor.id,'name',actor.name,'uid',actor.uid,'role',actor.role,
   'department',public.department_name(actor.department_id),'job_title',actor.job_title),
  'policy',case when pol.id is null then null else jsonb_build_object('name',pol.name,'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),
   'work_days',to_jsonb(pol.work_days),'grace_minutes',pol.grace_minutes,'timezone',pol.timezone,
   'assigned',exists(select 1 from public.employee_shifts s where s.user_id=p_actor and s.effective_from<=today and not s.follows_company
    and s.effective_from=(select max(x.effective_from) from public.employee_shifts x where x.user_id=p_actor and x.effective_from<=today))) end,
  'today',(select to_jsonb(d) from public.attendance_days(today,today,p_actor,now()) d),
  'month',(select to_jsonb(t)-'user_id' from public.attendance_totals(month_start,today,p_actor,now()) t),
  'recent',(select coalesce(jsonb_agg(to_jsonb(d)-'user_id' order by d.day desc),'[]'::jsonb) from public.attendance_days(today-13,today,p_actor,now()) d where d.state not in ('not_tracked','not_employed')),
  'incomplete',(select coalesce(jsonb_agg(jsonb_build_object('date',d.day,'check_in_at',d.check_in_at,'pending_correction',d.pending_correction) order by d.day desc),'[]'::jsonb)
   from public.attendance_days(today-45,today-1,p_actor,now()) d where d.state='incomplete'),
  'pending_leave',(select count(*) from public.attendance_leave_requests where user_id=p_actor and status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where user_id=p_actor and status='pending')) into result;
 return result;
end $$;

-- As in 040, recording the employee's own shift for the day.
create or replace function public.attendance_check_in_at(p_actor uuid,p_at timestamptz,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);day date=public.attendance_local_date(p_at);pol public.attendance_policies;
 holiday text;result public.attendance_records;calc record;closed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 pol=public.attendance_policy_for(p_actor,day);
 if pol.id is null then raise exception 'Attendance tracking has not started yet' using errcode='HA409';end if;
 if not exists(select 1 from public.attendance_periods e where e.user_id=p_actor and e.starts_on<=day and (e.ends_on is null or e.ends_on>=day)) then
  raise exception 'Attendance is not enabled for your account today' using errcode='HA409';end if;
 if not (extract(isodow from day)::smallint=any(pol.work_days)) then
  raise exception 'Today is a scheduled day off. No check-in is needed.' using errcode='HA409';end if;
 select name into holiday from public.attendance_holidays where holiday_date=day;
 if holiday is not null then raise exception 'Today is a company holiday (%). No check-in is needed.',holiday using errcode='HA409';end if;
 if exists(select 1 from public.attendance_leave_requests where user_id=p_actor and status='approved' and day between start_date and end_date) then
  raise exception 'You are on approved leave today. Ask an administrator if you need to work.' using errcode='HA409';end if;
 if exists(select 1 from public.attendance_records where user_id=p_actor and attendance_date=day) then
  raise exception 'You have already checked in today' using errcode='HA409';end if;
 -- A session left open on an earlier day is closed as incomplete (never
 -- given an invented check-out) so the new day can start.
 update public.attendance_records set state='incomplete' where user_id=p_actor and state='checked_in' and attendance_date<day;
 get diagnostics closed=row_count;
 select * into calc from public.attendance_compute(day,pol.shift_start,pol.shift_end,pol.grace_minutes,p_at,null);
 insert into public.attendance_records(user_id,attendance_date,policy_id,shift_start,shift_end,grace_minutes,check_in_at,state,
  punctuality,late_minutes,beyond_grace_minutes)
 values(p_actor,day,pol.id,pol.shift_start,pol.shift_end,pol.grace_minutes,p_at,'checked_in',calc.punctuality,calc.late_minutes,calc.beyond_grace_minutes)
 returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.check_in','attendance_records',result.id::text,p_request,
   jsonb_build_object('date',day,'punctuality',calc.punctuality,'late_minutes',calc.late_minutes,'closed_incomplete',closed));
 return public.attendance_record_json(result)||jsonb_build_object('closed_incomplete',closed);
end $$;

-- As in 040, counting staff too. The times shown are the company shift.
create or replace function public.attendance_overview(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());pol public.attendance_policies=public.attendance_policy_on(today);result jsonb;
begin
 with d as (select * from public.attendance_days(today,today,null,now()) where eligible or record_id is not null)
 select jsonb_build_object('date',today,'server_now',now(),
  'is_workday',pol.id is not null and extract(isodow from today)::smallint=any(pol.work_days),
  'holiday',(select name from public.attendance_holidays where holiday_date=today),
  'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),'grace_minutes',pol.grace_minutes,
  'employees',jsonb_build_object(
   'active',(select count(*) from public.profiles where active and deleted_at is null and role in ('admin','agent','staff')),
   'agents',(select count(*) from public.profiles where active and deleted_at is null and role='agent'),
   'admins',(select count(*) from public.profiles where active and deleted_at is null and role='admin'),
   'staff',(select count(*) from public.profiles where active and deleted_at is null and role='staff')),
  -- Each employee has exactly one state today; punctuality is a separate view
  -- of those who checked in.
  'states',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from (select state,count(*) n from d group by state) s),
  'punctuality',(select coalesce(jsonb_object_agg(punctuality,n),'{}'::jsonb) from (select punctuality,count(*) n from d where punctuality is not null group by punctuality) s),
  'incomplete_30_days',(select count(*) from public.attendance_records where attendance_date between today-30 and today-1 and state in ('checked_in','incomplete')),
  'pending_leave',(select count(*) from public.attendance_leave_requests where status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where status='pending'),
  'on_leave_today',(select count(*) from d where leave_type is not null)) into result;
 return result;
end $$;

-- As in 040, for staff too, with each employee's department.
create or replace function public.attendance_daily(p_actor uuid,p_date date,p_search text,p_role text,p_state text,p_punctuality text,p_account text,p_page integer,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);term text=nullif(btrim(coalesce(p_search,'')),'');result jsonb;
begin
 if p_date is null or p_page not between 1 and 100000 or p_limit not between 1 and 1000 or length(coalesce(p_search,''))>100
  or (p_role is not null and p_role not in ('admin','agent','staff')) or (p_account is not null and p_account not in ('active','inactive')) then
  raise exception 'Invalid register filter' using errcode='HA400';end if;
 with rows as (
  select d.*,p.name,p.uid,p.role,public.department_name(p.department_id) department,(p.active and p.deleted_at is null) account_active
  from public.attendance_days(p_date,p_date,null,now()) d join public.profiles p on p.id=d.user_id
  where (d.eligible or d.record_id is not null)
 ), filtered as (
  select * from rows r
  where (term is null or r.name ilike '%'||term||'%' or r.uid::text=term)
   and (p_role is null or r.role=p_role) and (p_state is null or r.state=p_state) and (p_punctuality is null or r.punctuality=p_punctuality)
   and (p_account is null or r.account_active=(p_account='active'))
 ), page as (select * from filtered order by name,user_id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('date',p_date,
  'data',coalesce((select jsonb_agg(to_jsonb(page) order by name,user_id) from page),'[]'::jsonb),
  'count',(select count(*) from filtered),'page',p_page,'limit',p_limit,
  'summary',jsonb_build_object('total',(select count(*) from rows),
   'states',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from (select state,count(*) n from rows group by state) s),
   'punctuality',(select coalesce(jsonb_object_agg(punctuality,n),'{}'::jsonb) from (select punctuality,count(*) n from rows where punctuality is not null group by punctuality) s)))
 into result;
 return result;
end $$;

-- As in 040, for staff too, with each employee's department.
create or replace function public.attendance_period(p_actor uuid,p_from date,p_to date,p_search text,p_role text,p_account text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);term text=nullif(btrim(coalesce(p_search,'')),'');result jsonb;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or length(coalesce(p_search,''))>100
  or (p_role is not null and p_role not in ('admin','agent','staff')) or (p_account is not null and p_account not in ('active','inactive')) then
  raise exception 'Choose a range of up to 31 days' using errcode='HA400';end if;
 with people as (
  select p.id,p.name,p.uid,p.role,public.department_name(p.department_id) department,(p.active and p.deleted_at is null) account_active from public.profiles p
  where p.role in ('admin','agent','staff') and (term is null or p.name ilike '%'||term||'%' or p.uid::text=term)
   and (p_role is null or p.role=p_role) and (p_account is null or (p.active and p.deleted_at is null)=(p_account='active'))
 ), days as (select d.* from public.attendance_days(p_from,p_to,null,now()) d join people pe on pe.id=d.user_id),
 totals as (select t.* from public.attendance_totals(p_from,p_to,null,now()) t join people pe on pe.id=t.user_id)
 select jsonb_build_object('from',p_from,'to',p_to,
  'employees',coalesce((select jsonb_agg(jsonb_build_object('user_id',pe.id,'name',pe.name,'uid',pe.uid,'role',pe.role,'department',pe.department,'active',pe.account_active)
    ||(to_jsonb(t)-'user_id')
    ||jsonb_build_object('days',(select jsonb_agg(jsonb_build_object('date',d.day,'state',d.state,'punctuality',d.punctuality,'late_minutes',d.late_minutes,
      'worked_minutes',d.worked_minutes,'check_in_at',d.check_in_at,'check_out_at',d.check_out_at) order by d.day) from days d where d.user_id=pe.id))
    order by pe.name,pe.id)
   from people pe join totals t on t.user_id=pe.id),'[]'::jsonb),
  'trend',coalesce((select jsonb_agg(jsonb_build_object('date',x.day,'present',x.present,'late',x.late,'absent',x.absent,'leave',x.leave,'incomplete',x.incomplete) order by x.day)
   from (select day,count(*) filter(where state in ('checked_out','checked_in')) present,count(*) filter(where punctuality='late') late,
    count(*) filter(where state='absent') absent,count(*) filter(where state='leave') leave,count(*) filter(where state='incomplete') incomplete
    from days group by day) x),'[]'::jsonb))
 into result;
 return result;
end $$;

-- As in 040, for staff too, with each employee's department.
create or replace function public.attendance_employees(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'role',p.role,'department',public.department_name(p.department_id),'active',p.active and p.deleted_at is null) order by p.name,p.id),'[]'::jsonb)
  from public.profiles p where p.role in ('admin','agent','staff')
   and (exists(select 1 from public.attendance_periods e where e.user_id=p.id) or exists(select 1 from public.attendance_records r where r.user_id=p.id)));
end $$;

-- As in 040, for staff too, with the department, job title and shift.
create or replace function public.attendance_employee(p_actor uuid,p_user uuid,p_from date,p_to date) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);person public.profiles;result jsonb;
begin
 if actor.role<>'admin' and p_user is distinct from p_actor then raise exception 'You can only view your own attendance' using errcode='HA403';end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>400 then raise exception 'Choose a date range of up to 400 days' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and role in ('admin','agent','staff');
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 select jsonb_build_object(
  'employee',jsonb_build_object('id',person.id,'name',person.name,'uid',person.uid,'role',person.role,'active',person.active and person.deleted_at is null,
   'department',public.department_name(person.department_id),'job_title',person.job_title,
   'shift',public.employee_shift_info(person.id,public.attendance_local_date(now())),
   'periods',(select coalesce(jsonb_agg(jsonb_build_object('starts_on',starts_on,'ends_on',ends_on) order by starts_on),'[]'::jsonb) from public.attendance_periods where user_id=person.id)),
  'from',p_from,'to',p_to,
  'totals',(select to_jsonb(t)-'user_id' from public.attendance_totals(p_from,p_to,p_user,now()) t),
  'days',(select coalesce(jsonb_agg(to_jsonb(d)-'user_id' order by d.day desc),'[]'::jsonb) from public.attendance_days(p_from,p_to,p_user,now()) d where d.state not in ('not_tracked','upcoming')),
  'leave',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc),'[]'::jsonb) from (select * from public.attendance_leave_requests where user_id=p_user order by created_at desc limit 50) l),
  'corrections',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc),'[]'::jsonb) from (select * from public.attendance_corrections where user_id=p_user order by created_at desc limit 50) c))
 into result;
 return result;
end $$;

-- As in 040, checking the day against the employee's own shift.
create or replace function public.attendance_correction_request(p_actor uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(now());day date;kind text;pol public.attendance_policies;
 rec public.attendance_records;want_in timestamptz;want_out timestamptz;result public.attendance_corrections;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['attendance_date','correction_type','requested_check_in_at','requested_check_out_at','reason'])<>'{}'::jsonb then
  raise exception 'Invalid correction request' using errcode='HA400';end if;
 day=(p_data->>'attendance_date')::date;kind=p_data->>'correction_type';
 want_in=(p_data->>'requested_check_in_at')::timestamptz;want_out=(p_data->>'requested_check_out_at')::timestamptz;
 if day is null or day>today or day<today-45 then raise exception 'Choose a date from the last 45 days' using errcode='HA400';end if;
 if kind is null or kind not in ('missing_check_in','missing_check_out','incorrect_check_in','incorrect_check_out') then
  raise exception 'Choose a correction type' using errcode='HA400';end if;
 pol=public.attendance_policy_for(p_actor,day);
 if pol.id is null or not exists(select 1 from public.attendance_periods e where e.user_id=p_actor and e.starts_on<=day and (e.ends_on is null or e.ends_on>=day)) then
  raise exception 'Attendance was not tracked for you on that date' using errcode='HA400';end if;
 if not (extract(isodow from day)::smallint=any(pol.work_days)) or exists(select 1 from public.attendance_holidays where holiday_date=day) then
  raise exception 'That date was a day off or holiday' using errcode='HA400';end if;
 if (want_in is not null and public.attendance_local_date(want_in)<>day) or (want_out is not null and public.attendance_local_date(want_out)<>day) then
  raise exception 'Requested times must be on the selected date' using errcode='HA400';end if;
 if (want_in is not null and want_in>now()) or (want_out is not null and want_out>now()) then
  raise exception 'Requested times cannot be in the future' using errcode='HA400';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 select * into rec from public.attendance_records where user_id=p_actor and attendance_date=day;
 if kind='missing_check_in' then
  if rec.id is not null then raise exception 'A check-in already exists for that date. Choose Incorrect check-in instead.' using errcode='HA409';end if;
  if want_in is null then raise exception 'Enter the time you started work' using errcode='HA400';end if;
 elsif rec.id is null then raise exception 'There is no check-in for that date. Choose Missing check-in instead.' using errcode='HA409';
 elsif kind='missing_check_out' then
  if rec.check_out_at is not null then raise exception 'A check-out already exists for that date. Choose Incorrect check-out instead.' using errcode='HA409';end if;
  if day=today and rec.state='checked_in' then raise exception 'You can still check out today with the Check out button' using errcode='HA409';end if;
  if want_out is null then raise exception 'Enter the time you finished work' using errcode='HA400';end if;
 elsif kind='incorrect_check_in' then
  if want_in is null then raise exception 'Enter the correct check-in time' using errcode='HA400';end if;
 else
  if rec.check_out_at is null then raise exception 'There is no check-out to correct. Choose Missing check-out instead.' using errcode='HA409';end if;
  if want_out is null then raise exception 'Enter the correct check-out time' using errcode='HA400';end if;
 end if;
 if coalesce(want_out,rec.check_out_at) is not null and coalesce(want_out,rec.check_out_at)<=coalesce(want_in,rec.check_in_at) then
  raise exception 'Check-out must be after check-in' using errcode='HA400';end if;
 if exists(select 1 from public.attendance_corrections where user_id=p_actor and attendance_date=day and status='pending') then
  raise exception 'You already have a pending correction for that date' using errcode='HA409';end if;
 insert into public.attendance_corrections(user_id,attendance_date,record_id,correction_type,original_check_in_at,original_check_out_at,
  requested_check_in_at,requested_check_out_at,reason)
 values(p_actor,day,rec.id,kind,rec.check_in_at,rec.check_out_at,want_in,want_out,btrim(p_data->>'reason')) returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.correction_requested','attendance_corrections',result.id::text,p_request,
   jsonb_build_object('date',day,'correction_type',kind));
 perform public.attendance_notify_admins(p_actor,'attendance_request','correction:'||result.id,'Attendance correction: '||actor.name,
  case kind when 'missing_check_in' then 'Missing check-in' when 'missing_check_out' then 'Missing check-out' when 'incorrect_check_in' then 'Incorrect check-in' else 'Incorrect check-out' end
   ||' on '||to_char(day,'DD Mon')||'. Review it in Attendance management.','/attendance-management?tab=corrections');
 return to_jsonb(result);
end $$;

-- As in 040, creating a missing day with the employee's own shift.
create or replace function public.attendance_correction_review(p_actor uuid,p_id uuid,p_decision text,p_note text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);item public.attendance_corrections;rec public.attendance_records;pol public.attendance_policies;
 new_in timestamptz;new_out timestamptz;calc record;today date=public.attendance_local_date(now());before jsonb;
begin
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject' using errcode='HA400';end if;
 if p_note is not null and length(p_note)>300 then raise exception 'Use a review note of 300 characters or fewer' using errcode='HA400';end if;
 select * into item from public.attendance_corrections where id=p_id for update;
 if not found then raise exception 'Correction request not found' using errcode='HA404';end if;
 if item.user_id=p_actor then raise exception 'You cannot review your own correction. Another administrator must review it.' using errcode='HA403';end if;
 if item.status<>'pending' then raise exception 'This request has already been reviewed' using errcode='HA409';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||item.user_id,40));
 if p_decision='approved' then
  select * into rec from public.attendance_records where user_id=item.user_id and attendance_date=item.attendance_date for update;
  -- The record must still be what the employee saw when they asked.
  if (item.record_id is null and rec.id is not null) or (item.record_id is not null and (rec.id is distinct from item.record_id
   or rec.check_in_at is distinct from item.original_check_in_at or rec.check_out_at is distinct from item.original_check_out_at)) then
   raise exception 'This attendance changed after the request was made. Reject it and ask for a new request.' using errcode='HA409';end if;
  new_in=coalesce(item.requested_check_in_at,rec.check_in_at);
  new_out=coalesce(item.requested_check_out_at,rec.check_out_at);
  if new_out is not null and new_out<=new_in then raise exception 'Check-out must be after check-in' using errcode='HA400';end if;
  if rec.id is null then
   pol=public.attendance_policy_for(item.user_id,item.attendance_date);
   if pol.id is null then raise exception 'Attendance was not tracked on that date' using errcode='HA409';end if;
   select * into calc from public.attendance_compute(item.attendance_date,pol.shift_start,pol.shift_end,pol.grace_minutes,new_in,new_out);
   insert into public.attendance_records(user_id,attendance_date,policy_id,shift_start,shift_end,grace_minutes,check_in_at,check_out_at,state,
    punctuality,late_minutes,beyond_grace_minutes,worked_minutes,early_departure_minutes,overtime_minutes,corrected)
   values(item.user_id,item.attendance_date,pol.id,pol.shift_start,pol.shift_end,pol.grace_minutes,new_in,new_out,
    case when new_out is not null then 'checked_out' when item.attendance_date<today then 'incomplete' else 'checked_in' end,
    calc.punctuality,calc.late_minutes,calc.beyond_grace_minutes,calc.worked_minutes,calc.early_departure_minutes,calc.overtime_minutes,true)
   returning * into rec;
   before=null;
  else
   before=jsonb_build_object('check_in_at',rec.check_in_at,'check_out_at',rec.check_out_at,'state',rec.state,'punctuality',rec.punctuality,'worked_minutes',rec.worked_minutes);
   select * into calc from public.attendance_compute(rec.attendance_date,rec.shift_start,rec.shift_end,rec.grace_minutes,new_in,new_out);
   update public.attendance_records set check_in_at=new_in,check_out_at=new_out,
    state=case when new_out is not null then 'checked_out' when attendance_date<today then 'incomplete' else 'checked_in' end,
    punctuality=calc.punctuality,late_minutes=calc.late_minutes,beyond_grace_minutes=calc.beyond_grace_minutes,worked_minutes=calc.worked_minutes,
    early_departure_minutes=calc.early_departure_minutes,overtime_minutes=calc.overtime_minutes,corrected=true
   where id=rec.id returning * into rec;
  end if;
  update public.attendance_corrections set record_id=rec.id where id=p_id;
 end if;
 update public.attendance_corrections set status=p_decision,reviewer_id=p_actor,review_note=nullif(btrim(p_note),''),reviewed_at=now()
 where id=p_id returning * into item;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.correction_'||p_decision,'attendance_corrections',p_id::text,p_request,
   jsonb_build_object('user_id',item.user_id,'date',item.attendance_date,'correction_type',item.correction_type,'record_id',item.record_id,
    'before',before,'after',case when p_decision='approved' then jsonb_build_object('check_in_at',rec.check_in_at,'check_out_at',rec.check_out_at,
     'state',rec.state,'punctuality',rec.punctuality,'worked_minutes',rec.worked_minutes) end));
 perform public.push_notification(item.user_id,'attendance_review','correction:'||item.id,
  case when p_decision='approved' then 'Attendance correction approved' else 'Attendance correction not approved' end,
  'Your correction for '||to_char(item.attendance_date,'DD Mon')||case when p_decision='approved' then ' has been applied' else ' was not approved' end||
  coalesce('. Note: '||item.review_note,'.'),'/attendance',null);
 return to_jsonb(item);
end $$;

-- As in 042, with the employee's own working days.
create or replace function public.attendance_admin_tidy(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.attendance_periods;b public.attendance_periods;changed boolean;
begin
 delete from public.attendance_periods e where e.user_id=p_user and e.recorded_by is not null and not exists(
  select 1 from generate_series(e.starts_on::timestamp,e.ends_on::timestamp,interval '1 day') g
  where extract(isodow from g::date)::smallint=any((public.attendance_admin_rules_for(p_user,g::date)).work_days)
   and not exists(select 1 from public.attendance_holidays h where h.holiday_date=g::date));
 loop
  changed=false;a=null;
  for b in select * from public.attendance_periods where user_id=p_user order by starts_on loop
   if a.recorded_by is not null and b.starts_on>a.ends_on and not exists(
    select 1 from generate_series((a.ends_on+1)::timestamp,(b.starts_on-1)::timestamp,interval '1 day') g
    where extract(isodow from g::date)::smallint=any((public.attendance_admin_rules_for(p_user,g::date)).work_days)
     and not exists(select 1 from public.attendance_holidays h where h.holiday_date=g::date)) then
    if b.recorded_by is not null then
     delete from public.attendance_periods where id=b.id;
     update public.attendance_periods set ends_on=b.ends_on where id=a.id;
     changed=true;exit;
    elsif a.ends_on<b.starts_on-1 then
     update public.attendance_periods set ends_on=b.starts_on-1 where id=a.id;
    end if;
   end if;
   a=b;
  end loop;
  exit when not changed;
 end loop;
end $$;

-- As in 042, for staff too, with the employee's own shift.
create or replace function public.attendance_admin_day_at(p_actor uuid,p_user uuid,p_day date,p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);person public.profiles;rules public.attendance_policies;
 rec public.attendance_records;lv public.attendance_leave_requests;d record;
begin
 if p_day is null then raise exception 'Choose a date' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and role in ('admin','agent','staff') and deleted_at is null;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 rules=public.attendance_admin_rules_for(p_user,p_day);
 select * into rec from public.attendance_records where user_id=p_user and attendance_date=p_day;
 select * into lv from public.attendance_leave_requests where user_id=p_user and status='approved' and p_day between start_date and end_date order by created_at limit 1;
 select * into d from public.attendance_days(p_day,p_day,p_user,p_now) limit 1;
 return jsonb_build_object('date',p_day,'today',public.attendance_local_date(p_now),'self',p_user=p_actor,
  'employee',jsonb_build_object('id',person.id,'name',person.name,'uid',person.uid,'role',person.role,'active',person.active),
  'state',coalesce(d.state,case when rules.id is null then 'not_tracked' else 'not_employed' end),
  'record',case when rec.id is not null then jsonb_build_object('id',rec.id,'check_in_at',rec.check_in_at,'check_out_at',rec.check_out_at,
   'state',rec.state,'punctuality',rec.punctuality,'late_minutes',rec.late_minutes,'worked_minutes',rec.worked_minutes,
   'early_departure_minutes',rec.early_departure_minutes,'corrected',rec.corrected) end,
  'leave',case when lv.id is not null then jsonb_build_object('id',lv.id,'leave_type',lv.leave_type,'start_date',lv.start_date,'end_date',lv.end_date,
   'recorded_by_admin',lv.recorded_by is not null) end,
  'rules',case when rules.id is not null then jsonb_build_object('shift_start',to_char(rules.shift_start,'HH24:MI'),'shift_end',to_char(rules.shift_end,'HH24:MI'),
   'grace_minutes',rules.grace_minutes,'work_days',to_jsonb(rules.work_days)) end,
  'holiday',(select name from public.attendance_holidays where holiday_date=p_day),
  'pending_correction',exists(select 1 from public.attendance_corrections where user_id=p_user and attendance_date=p_day and status='pending'),
  'attendance_start',(select min(starts_on) from public.attendance_periods where user_id=p_user and recorded_by is null),
  'counted',exists(select 1 from public.attendance_periods e where e.user_id=p_user and e.starts_on<=p_day and (e.ends_on is null or e.ends_on>=p_day)),
  'entered',not exists(select 1 from public.attendance_periods e where e.user_id=p_user and e.recorded_by is null and e.starts_on<=p_day and (e.ends_on is null or e.ends_on>=p_day))
   and exists(select 1 from public.attendance_periods e where e.user_id=p_user and e.recorded_by is not null and e.starts_on<=p_day and e.ends_on>=p_day),
  'tracking_started',(select min(effective_from) from public.attendance_policies),
  'history',(select coalesce(jsonb_agg(jsonb_build_object('at',a.created_at,'action',a.action,'by',coalesce(p.name,'System'),
    'before',a.metadata->'before','after',a.metadata->'after','reason',a.metadata->>'reason') order by a.created_at desc),'[]'::jsonb)
   from (select * from public.audit_log a where a.action like 'attendance.%' and a.metadata->>'date'=p_day::text
    and (a.metadata->>'user_id'=p_user::text or (a.actor_id=p_user and a.action in ('attendance.check_in','attendance.check_out')))
    order by a.created_at desc limit 50) a left join public.profiles p on p.id=a.actor_id));
end $$;

-- As in 042, for staff too, with the employee's own shift.
create or replace function public.attendance_admin_set_at(p_actor uuid,p_user uuid,p_entries jsonb,p_reason text,p_replace boolean,p_dry_run boolean,p_request text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);person public.profiles;today date=public.attendance_local_date(p_now);
 note text=nullif(btrim(coalesce(p_reason,'')),'');overwrite boolean=coalesce(p_replace,false);first_policy public.attendance_policies;
 real_start date;new_tracking date;item jsonb;p jsonb;day date;wanted text;wanted_leave text;t_in time;t_out time;
 rules public.attendance_policies;rec public.attendance_records;lv public.attendance_leave_requests;holiday_name text;
 covered boolean;covered_real boolean;in_at timestamptz;out_at timestamptz;calc record;outcome text;message text;was jsonb;will jsonb;
 plan jsonb='[]'::jsonb;counted jsonb;target_id text;audit_entity text;seg public.attendance_periods;seg_next public.attendance_periods;
begin
 if p_user is null or jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 31 then
  raise exception 'Choose between 1 and 31 dates' using errcode='HA400';end if;
 if note is not null and length(note)>300 then raise exception 'Use a reason of 300 characters or fewer' using errcode='HA400';end if;
 if p_user=p_actor then raise exception 'You cannot change your own attendance. Another administrator must do it.' using errcode='HA403';end if;
 select * into person from public.profiles where id=p_user and role in ('admin','agent','staff') and deleted_at is null for share;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 if exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e) is distinct from 'object'
   or (e-array['date','status','check_in','check_out','leave_type'])<>'{}'::jsonb
   or coalesce(e->>'date','')!~'^\d{4}-\d{2}-\d{2}$'
   or coalesce(e->>'status','') not in ('present','late','half_day','absent','leave','clear')
   or (e ? 'check_in' and coalesce(e->>'check_in','')!~'^([01]\d|2[0-3]):[0-5]\d$')
   or (e ? 'check_out' and coalesce(e->>'check_out','')!~'^([01]\d|2[0-3]):[0-5]\d$')
   or (e ? 'leave_type' and coalesce(e->>'leave_type','') not in ('casual','sick','emergency','unpaid','other'))) then
  raise exception 'Invalid attendance entry' using errcode='HA400';end if;
 if (select count(distinct e->>'date') from jsonb_array_elements(p_entries) e)<>jsonb_array_length(p_entries) then
  raise exception 'Enter each date once' using errcode='HA400';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_user,40));
 select * into first_policy from public.attendance_policies order by effective_from limit 1;
 if first_policy.id is null then raise exception 'Attendance tracking is not set up yet' using errcode='HA409';end if;
 -- The account's own attendance (opened when it was enabled) starts here;
 -- only days before it can be entered as extra counted days.
 select min(starts_on) into real_start from public.attendance_periods where user_id=p_user and recorded_by is null;
 if real_start is null then raise exception 'This account has never been enabled for attendance' using errcode='HA409';end if;

 -- 1. Decide every date without changing anything.
 for item in select e from jsonb_array_elements(p_entries) e order by e->>'date' loop
  day=(item->>'date')::date;wanted=item->>'status';wanted_leave=item->>'leave_type';
  t_in=(item->>'check_in')::time;t_out=(item->>'check_out')::time;
  outcome=null;message=null;will=null;in_at=null;out_at=null;
  rules=public.attendance_admin_rules_for(p_user,day);
  select * into rec from public.attendance_records where user_id=p_user and attendance_date=day for update;
  select * into lv from public.attendance_leave_requests l where l.user_id=p_user and l.status='approved' and day between l.start_date and l.end_date
   order by l.created_at limit 1 for update;
  holiday_name=(select h.name from public.attendance_holidays h where h.holiday_date=day);
  covered=exists(select 1 from public.attendance_periods e where e.user_id=p_user and e.starts_on<=day and (e.ends_on is null or e.ends_on>=day));
  covered_real=exists(select 1 from public.attendance_periods e where e.user_id=p_user and e.recorded_by is null and e.starts_on<=day and (e.ends_on is null or e.ends_on>=day));
  was=jsonb_build_object('state',case when rec.id is not null then case when rec.state='checked_in' then 'incomplete' else rec.state end
    when lv.id is not null and covered then 'leave' when covered then 'absent' else 'not_counted' end,
   'check_in_at',rec.check_in_at,'check_out_at',rec.check_out_at,'punctuality',rec.punctuality,'leave_type',lv.leave_type);
  if day>today then outcome='error';message='Future dates cannot be entered';
  elsif day=today then outcome='error';message='Today''s attendance uses check-in and check-out. Choose an earlier day.';
  elsif day<today-366 then outcome='error';message='Choose a date within the last year';
  elsif rules.id is null then outcome='error';message='Attendance rules are not set up for this date';
  elsif not (extract(isodow from day)::smallint=any(rules.work_days)) then outcome='error';message='Scheduled day off';
  elsif holiday_name is not null then outcome='error';message='Company holiday: '||holiday_name;
  elsif not covered and day>=real_start then outcome='error';message='The account was not active on this date';
  elsif exists(select 1 from public.attendance_corrections c where c.user_id=p_user and c.attendance_date=day and c.status='pending') then
   outcome='error';message='A correction request for this day is waiting. Review it first.';
  elsif wanted in ('present','late','half_day') then
   if t_in is null or t_out is null then outcome='error';message='Enter both the check-in and check-out times';
   elsif t_out<=t_in then outcome='error';message='Check-out must be after check-in';
   else
    in_at=public.attendance_moment(day,t_in);out_at=public.attendance_moment(day,t_out);
    select * into calc from public.attendance_compute(day,coalesce(rec.shift_start,rules.shift_start),coalesce(rec.shift_end,rules.shift_end),
     coalesce(rec.grace_minutes,rules.grace_minutes),in_at,out_at);
    if wanted='late' and calc.punctuality<>'late' then outcome='error';
     message=format('A %s check-in is within the %s-minute grace period, so the day is not late',to_char(t_in,'HH24:MI'),coalesce(rec.grace_minutes,rules.grace_minutes));
    elsif wanted='half_day' and calc.early_departure_minutes=0 then outcome='error';
     message=format('A half day ends before the shift ends at %s',to_char(coalesce(rec.shift_end,rules.shift_end),'HH24:MI'));
    elsif rec.id is not null then
     if rec.check_in_at=in_at and rec.check_out_at is not distinct from out_at and covered then outcome='unchanged';message='Already recorded with these times';
     elsif not overwrite then outcome='skip';message='Already recorded. Choose to replace existing attendance to change it.';
     else outcome='update';end if;
    elsif lv.id is not null then
     if not overwrite then outcome='skip';message='On approved leave. Choose to replace existing attendance to record work instead.';
     else outcome='update';end if;
    else outcome='create';end if;
    will=jsonb_build_object('state','checked_out','check_in_at',in_at,'check_out_at',out_at,'punctuality',calc.punctuality,
     'late_minutes',calc.late_minutes,'worked_minutes',calc.worked_minutes,'early_departure_minutes',calc.early_departure_minutes);
   end if;
  elsif wanted='absent' then
   if rec.id is not null then
    if not overwrite then outcome='skip';message='Already recorded as worked. Choose to replace existing attendance to mark it absent.';
    elsif exists(select 1 from public.attendance_corrections c where c.record_id=rec.id) then outcome='error';
     message='This day has correction history, so its record cannot be removed';
    else outcome='update';end if;
   elsif lv.id is not null then
    if not overwrite then outcome='skip';message='On approved leave. Choose to replace existing attendance to mark it absent.';
    elsif lv.recorded_by is null or lv.start_date<>lv.end_date then outcome='error';
     message='This day is covered by an approved leave request, which cannot be changed here';
    else outcome='update';end if;
   elsif covered then outcome='unchanged';message='Already counted as absent';
   else outcome='create';end if;
   will=jsonb_build_object('state','absent');
  elsif wanted='leave' then
   if wanted_leave is null then outcome='error';message='Choose the leave type';
   elsif exists(select 1 from public.attendance_leave_requests l where l.user_id=p_user and l.status='pending' and day between l.start_date and l.end_date) then
    outcome='error';message='A leave request covering this day is waiting. Review it instead.';
   elsif rec.id is not null then
    if not overwrite then outcome='skip';message='Already recorded as worked. Choose to replace existing attendance to record leave.';
    elsif exists(select 1 from public.attendance_corrections c where c.record_id=rec.id) then outcome='error';
     message='This day has correction history, so its record cannot be removed';
    else outcome='update';end if;
   elsif lv.id is not null then
    if lv.leave_type=wanted_leave and covered then outcome='unchanged';message='Already on this leave';
    elsif not overwrite then outcome='skip';message='Already on approved leave. Choose to replace existing attendance to change it.';
    elsif lv.recorded_by is null or lv.start_date<>lv.end_date then outcome='error';
     message='This day is covered by an approved leave request, which cannot be changed here';
    else outcome='update';end if;
   else outcome='create';end if;
   will=jsonb_build_object('state','leave','leave_type',wanted_leave);
  else
   -- clear: remove an entered day, so it is no longer counted.
   if covered_real then outcome='error';
    message='This day is part of the employee''s own attendance. Mark it absent or enter attendance instead.';
   elsif not covered and rec.id is null and lv.id is null then outcome='unchanged';message='Not counted';
   elsif not overwrite then outcome='skip';message='Choose to replace existing attendance to remove it.';
   elsif rec.id is not null and exists(select 1 from public.attendance_corrections c where c.record_id=rec.id) then outcome='error';
    message='This day has correction history, so its record cannot be removed';
   elsif lv.id is not null and (lv.recorded_by is null or lv.start_date<>lv.end_date) then outcome='error';
    message='This day is covered by an approved leave request, which cannot be changed here';
   else outcome='update';end if;
   will=jsonb_build_object('state','not_counted');
  end if;
  plan=plan||jsonb_build_array(jsonb_build_object('date',day,'status',wanted,'result',outcome,'message',message,'before',was,
   'after',case when outcome in ('create','update') then will end,
   '_record',rec.id,'_leave',lv.id,'_leave_admin',lv.recorded_by is not null and lv.start_date=lv.end_date,'_in',in_at,'_out',out_at,'_type',wanted_leave,
   '_count',not covered and wanted<>'clear'));
 end loop;

 -- 2. The days that become counted, and the start of tracking they need.
 select coalesce(jsonb_agg(x->'date' order by x->>'date'),'[]'::jsonb) into counted from jsonb_array_elements(plan) x
  where x->>'result' in ('create','update') and (x->>'_count')::boolean;
 select min((x->>'date')::date) into new_tracking from jsonb_array_elements(plan) x where x->>'result' in ('create','update') and (x->>'date')::date<first_policy.effective_from;

 -- 3. Apply.
 if not coalesce(p_dry_run,false) then
  if new_tracking is not null then
   perform pg_advisory_xact_lock(873440);
   update public.attendance_policies set effective_from=new_tracking where id=first_policy.id and effective_from>new_tracking;
   insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'attendance.tracking_start_moved','attendance_policies',first_policy.id::text,p_request,
     jsonb_build_object('user_id',p_user,'from',first_policy.effective_from,'to',new_tracking,'reason',note));
  end if;
  for p in select x from jsonb_array_elements(plan) x where x->>'result' in ('create','update') loop
   day=(p->>'date')::date;wanted=p->>'status';audit_entity='attendance_records';target_id=p->>'_record';
   -- Count an entered day: join it to an entered period next to it, or give
   -- it its own.
   if (p->>'_count')::boolean then
    select * into seg from public.attendance_periods where user_id=p_user and recorded_by is not null and ends_on=day-1 for update;
    select * into seg_next from public.attendance_periods where user_id=p_user and recorded_by is not null and starts_on=day+1 for update;
    if seg.id is not null and seg_next.id is not null then
     delete from public.attendance_periods where id=seg_next.id;
     update public.attendance_periods set ends_on=seg_next.ends_on where id=seg.id;
    elsif seg.id is not null then update public.attendance_periods set ends_on=day where id=seg.id;
    elsif seg_next.id is not null then update public.attendance_periods set starts_on=day where id=seg_next.id;
    else insert into public.attendance_periods(user_id,starts_on,ends_on,recorded_by) values(p_user,day,day,p_actor);
    end if;
   end if;
   if wanted in ('present','late','half_day') then
    in_at=(p->>'_in')::timestamptz;out_at=(p->>'_out')::timestamptz;
    if p->>'_record' is not null then
     select * into rec from public.attendance_records where id=(p->>'_record')::uuid for update;
     select * into calc from public.attendance_compute(day,rec.shift_start,rec.shift_end,rec.grace_minutes,in_at,out_at);
     update public.attendance_records set check_in_at=in_at,check_out_at=out_at,state='checked_out',punctuality=calc.punctuality,
      late_minutes=calc.late_minutes,beyond_grace_minutes=calc.beyond_grace_minutes,worked_minutes=calc.worked_minutes,
      early_departure_minutes=calc.early_departure_minutes,overtime_minutes=calc.overtime_minutes,corrected=true where id=rec.id;
    else
     rules=public.attendance_policy_for(p_user,day);
     select * into calc from public.attendance_compute(day,rules.shift_start,rules.shift_end,rules.grace_minutes,in_at,out_at);
     insert into public.attendance_records(user_id,attendance_date,policy_id,shift_start,shift_end,grace_minutes,check_in_at,check_out_at,state,
      punctuality,late_minutes,beyond_grace_minutes,worked_minutes,early_departure_minutes,overtime_minutes,corrected)
     values(p_user,day,rules.id,rules.shift_start,rules.shift_end,rules.grace_minutes,in_at,out_at,'checked_out',calc.punctuality,calc.late_minutes,
      calc.beyond_grace_minutes,calc.worked_minutes,calc.early_departure_minutes,calc.overtime_minutes,true)
     returning id::text into target_id;
     -- Leave recorded here gives way to the worked day. Leave the employee
     -- requested stays on file; a check-in counts as present anyway.
     if (p->>'_leave_admin')::boolean then delete from public.attendance_leave_requests where id=(p->>'_leave')::uuid;end if;
    end if;
   elsif wanted='absent' then
    if p->>'_record' is not null then delete from public.attendance_records where id=(p->>'_record')::uuid;
    elsif p->>'_leave' is not null then
     audit_entity='attendance_leave_requests';target_id=p->>'_leave';
     delete from public.attendance_leave_requests where id=(p->>'_leave')::uuid;
    else audit_entity='attendance_periods';target_id=p_user::text;
    end if;
   elsif wanted='leave' then
    if p->>'_record' is not null then delete from public.attendance_records where id=(p->>'_record')::uuid;end if;
    audit_entity='attendance_leave_requests';
    if p->>'_leave' is not null then
     target_id=p->>'_leave';
     if (p->>'_leave_admin')::boolean then
      update public.attendance_leave_requests set leave_type=p->>'_type' where id=(p->>'_leave')::uuid;
     end if;
    else
     -- The administrator's reason stays in the audit log; the employee sees
     -- this leave in their own list.
     insert into public.attendance_leave_requests(user_id,leave_type,start_date,end_date,reason,status,reviewer_id,reviewed_at,recorded_by)
     values(p_user,p->>'_type',day,day,'Recorded by an administrator','approved',p_actor,now(),p_actor)
     returning id::text into target_id;
    end if;
   else
    if p->>'_record' is not null then delete from public.attendance_records where id=(p->>'_record')::uuid;end if;
    if (p->>'_leave_admin')::boolean then
     delete from public.attendance_leave_requests where id=(p->>'_leave')::uuid;
     if target_id is null then audit_entity='attendance_leave_requests';target_id=p->>'_leave';end if;
    end if;
    if target_id is null then audit_entity='attendance_periods';target_id=p_user::text;end if;
    -- Stop counting the day: shrink or split the entered period holding it.
    select * into seg from public.attendance_periods where user_id=p_user and recorded_by is not null and starts_on<=day and ends_on>=day for update;
    if seg.id is not null then
     if seg.starts_on=day and seg.ends_on=day then delete from public.attendance_periods where id=seg.id;
     elsif seg.starts_on=day then update public.attendance_periods set starts_on=day+1 where id=seg.id;
     elsif seg.ends_on=day then update public.attendance_periods set ends_on=day-1 where id=seg.id;
     else
      update public.attendance_periods set ends_on=day-1 where id=seg.id;
      insert into public.attendance_periods(user_id,starts_on,ends_on,recorded_by) values(p_user,day+1,seg.ends_on,seg.recorded_by);
     end if;
    end if;
   end if;
   insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p->>'result'='create' then 'attendance.manual_create' else 'attendance.manual_update' end,audit_entity,target_id,p_request,
     jsonb_build_object('user_id',p_user,'date',day,'status',wanted,'before',p->'before','after',p->'after','reason',note,
      'counted',(p->>'_count')::boolean));
  end loop;
  perform public.attendance_admin_tidy(p_user);
 end if;
 return jsonb_build_object('dry_run',coalesce(p_dry_run,false),
  'employee',jsonb_build_object('id',person.id,'name',person.name,'uid',person.uid,'role',person.role),
  'results',(select coalesce(jsonb_agg(x-array['_record','_leave','_leave_admin','_in','_out','_type','_count'] order by x->>'date'),'[]'::jsonb) from jsonb_array_elements(plan) x),
  'summary',(select jsonb_build_object('created',count(*) filter(where x->>'result'='create'),'updated',count(*) filter(where x->>'result'='update'),
    'unchanged',count(*) filter(where x->>'result'='unchanged'),'skipped',count(*) filter(where x->>'result'='skip'),
    'failed',count(*) filter(where x->>'result'='error')) from jsonb_array_elements(plan) x),
  'counted_days',counted,
  'tracking_start',case when new_tracking is not null then jsonb_build_object('from',first_policy.effective_from,'to',new_tracking) end);
end $$;

-- As in 045, for agents and staff.
create or replace function public.task_checkout_check(p_actor public.profiles,p_rec public.attendance_records,p_at timestamptz,p_lock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare day date=p_rec.attendance_date;report boolean;req public.task_checkout_requests;
 ends timestamptz=public.attendance_moment(p_rec.attendance_date,p_rec.shift_end);
begin
 if p_actor.role not in ('agent','staff') or not public.task_rules_on(day) then
  return jsonb_build_object('allowed',true,'required',false);end if;
 report=exists(select 1 from public.task_daily_reports where user_id=p_actor.id and work_date=day);
 if p_lock then
  select * into req from public.task_checkout_requests where user_id=p_actor.id and work_date=day and status='approved' and used_at is null for update;
 else
  select * into req from public.task_checkout_requests where user_id=p_actor.id and work_date=day and status='approved' and used_at is null;
 end if;
 if req.id is not null and req.kind='emergency' then
  return case when report or req.waive_report then jsonb_build_object('allowed',true,'required',true,'request_id',req.id,'kind','emergency')
   else jsonb_build_object('allowed',false,'required',true,'reason','Submit your daily work report before checking out. Your emergency approval did not waive the report.') end;
 end if;
 if p_at<ends then
  if req.id is not null and report then
   return jsonb_build_object('allowed',true,'required',true,'request_id',req.id,'kind','early');end if;
  return jsonb_build_object('allowed',false,'required',true,'reason',
   format('Checking out before your shift ends at %s needs an approved early or emergency checkout request.',to_char(p_rec.shift_end,'FMHH12:MI AM')));
 end if;
 if not report then
  return jsonb_build_object('allowed',false,'required',true,'reason','Please submit your daily work report before checking out.');end if;
 return jsonb_build_object('allowed',true,'required',true)||case when req.id is null then '{}'::jsonb else jsonb_build_object('request_id',req.id,'kind',req.kind) end;
end $$;

-- As in 045, for agents and staff, with the employee's own shift.
create or replace function public.task_checkout_state_at(p_actor uuid,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);rec public.attendance_records;
 summary jsonb=public.task_day(p_actor,today);report boolean;pending public.task_checkout_requests;approved public.task_checkout_requests;
 early text[]='{}';gate jsonb;limits jsonb=public.task_request_limits(p_actor,'early',today,p_at);
 urgent jsonb=public.task_request_limits(p_actor,'emergency',today,p_at);
begin
 select * into rec from public.attendance_records where user_id=p_actor and attendance_date=today;
 report=exists(select 1 from public.task_daily_reports where user_id=p_actor and work_date=today);
 select * into pending from public.task_checkout_requests where user_id=p_actor and work_date=today and status='pending';
 select * into approved from public.task_checkout_requests where user_id=p_actor and work_date=today and status='approved';
 if rec.id is not null and rec.state='checked_in' then gate=public.task_checkout_check(actor,rec,p_at,false);end if;
 -- Reasons an early request isn't available yet, in the order to fix them.
 if actor.role not in ('agent','staff') then early=early||'Only agents and staff request early checkout.'::text;
 elsif not public.task_rules_on(today) then early=early||'Checkout rules are off, so no approval is needed.'::text;
 elsif rec.id is null then early=early||'Check in first.'::text;
 elsif rec.state<>'checked_in' then early=early||'You have already checked out today.'::text;
 elsif p_at>=public.attendance_moment(today,rec.shift_end) then early=early||'Your shift has ended; check out normally.'::text;
 else
  if (summary->>'due_count')::integer=0 then early=early||'You have no tasks due today. Check out at the end of your shift, or ask for an emergency checkout.'::text;
  elsif not (summary->>'all_due_completed')::boolean then
   early=early||case when (summary->>'overdue')::integer>0 then format('Finish your %s overdue task(s) first.',summary->>'overdue')
    else format('Complete every task due today first (%s of %s done).',summary->>'due_completed',summary->>'due_count') end;
  end if;
  if not report then early=early||'Submit your daily report first.'::text;end if;
  if pending.id is not null then early=early||'You already have a request waiting for an administrator.'::text;end if;
  if approved.id is not null then early=early||'Your checkout request is already approved.'::text;end if;
  if (limits->>'limit_reached')::boolean then early=early||'You have reached today''s limit of 3 early checkout requests.'::text;
  elsif (limits->>'waiting')::boolean then
   early=early||format('You can ask again from %s, 15 minutes after your last request was rejected.',public.task_time_text((limits->>'retry_at')::timestamptz));
  end if;
 end if;
 return jsonb_build_object('date',today,'rules_active',public.task_rules_on(today),'required',actor.role in ('agent','staff') and public.task_rules_on(today),
  'attendance_state',rec.state,'shift_end',to_char(coalesce(rec.shift_end,(public.attendance_policy_for(p_actor,today)).shift_end),'HH24:MI'),
  'before_shift_end',rec.id is not null and p_at<public.attendance_moment(today,rec.shift_end),
  'report_submitted',report,'tasks',summary,
  'pending_request',case when pending.id is null then null else public.task_request_json(pending,today) end,
  'approved_request',case when approved.id is null then null else public.task_request_json(approved,today) end,
  'can_check_out',coalesce((gate->>'allowed')::boolean,false),'blocked_reason',case when gate is not null and not (gate->>'allowed')::boolean then gate->>'reason' end,
  'can_request_early',cardinality(early)=0,'early_blockers',to_jsonb(early),
  'can_request_emergency',coalesce(actor.role in ('agent','staff') and public.task_rules_on(today) and rec.state='checked_in' and pending.id is null and approved.id is null
   and not (urgent->>'limit_reached')::boolean,false),
  'early_resubmission',limits-'reasons','emergency_resubmission',urgent-'reasons');
end $$;

-- As in 045, for agents and staff.
create or replace function public.task_report_submit_at(p_actor uuid,p_day date,p_remarks text,p_amend boolean,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);day date=coalesce(p_day,today);
 r public.task_daily_reports;snap jsonb;pct numeric;n integer;
begin
 if actor.role not in ('agent','staff') then raise exception 'Daily reports are for agents and staff' using errcode='HA403';end if;
 if day>today or day<today-7 then raise exception 'Choose today or one of the last seven days' using errcode='HA400';end if;
 if length(p_remarks)>1000 then raise exception 'Keep the remarks under 1000 characters' using errcode='HA400';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 select * into r from public.task_daily_reports where user_id=p_actor and work_date=day for update;
 if r.id is not null and r.status='reviewed' then
  raise exception 'This report was reviewed by an administrator and can''t be changed' using errcode='HA409';end if;
 if r.id is not null and not coalesce(p_amend,false) then
  raise exception 'You already submitted the report for %. Choose Amend report to change it.',public.task_day_text(day) using errcode='HA409';end if;
 select coalesce(jsonb_agg(jsonb_build_object('assignment_id',x.id,'title',t.title,'kind',t.kind,'target_quantity',t.target_quantity,'unit',t.unit,
   'completed_quantity',x.completed_quantity,'status',x.status,'due_on',t.due_on,'percent',public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status))
   order by t.due_on,t.title,x.id),'[]'::jsonb),round(avg(public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status)),1),count(*)
 into snap,pct,n from public.task_assignments x join public.tasks t on t.id=x.task_id
 where x.user_id=p_actor and x.status<>'cancelled' and t.task_date<=day and t.due_on>=day;
 if r.id is null then
  insert into public.task_daily_reports(user_id,work_date,remarks,tasks,task_count,completion_percent,submitted_at)
  values(p_actor,day,nullif(btrim(p_remarks),''),snap,n,pct,p_at) returning * into r;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'task.report_submit','task_daily_reports',r.id::text,p_request,jsonb_build_object('user_id',p_actor,'date',day,'task_count',n,
   'completion_percent',pct,'late',day<today));
  perform public.task_notify_admins(p_actor,'task_report','task-reports:'||day,'Daily report: '||left(actor.name,150),
   format('%s submitted the report for %s: %s.',actor.name,public.task_day_text(day),
    case when n=0 then 'no tasks that day' else format('%s%% across %s task(s)',pct,n) end),
   '/task-management?tab=reports&date='||day,'%s daily reports for '||public.task_day_text(day),'Open Daily reports to review them.');
 else
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'task.report_amend','task_daily_reports',r.id::text,p_request,jsonb_build_object('user_id',p_actor,'date',day,
   'before',jsonb_build_object('completion_percent',r.completion_percent,'task_count',r.task_count,'remarks_changed',r.remarks is distinct from nullif(btrim(p_remarks),''),
    'tasks',(select coalesce(jsonb_agg(jsonb_build_object('title',e->>'title','completed_quantity',e->'completed_quantity','status',e->>'status')),'[]'::jsonb) from jsonb_array_elements(r.tasks) e)),
   'after',jsonb_build_object('completion_percent',pct,'task_count',n)));
  update public.task_daily_reports set remarks=nullif(btrim(p_remarks),''),tasks=snap,task_count=n,completion_percent=pct,amended_at=p_at,
   amendment_count=amendment_count+1 where id=r.id returning * into r;
 end if;
 return public.task_report_json(r);
end $$;

-- As in 045, for agents and staff.
create or replace function public.task_checkout_request_at(p_actor uuid,p_kind text,p_reason text,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);rec public.attendance_records;
 state jsonb;summary jsonb;req public.task_checkout_requests;report boolean;limits jsonb;
begin
 if actor.role not in ('agent','staff') then raise exception 'Only agents and staff request checkout approval' using errcode='HA403';end if;
 if p_kind not in ('early','emergency') then raise exception 'Choose early or emergency checkout' using errcode='HA400';end if;
 if length(p_reason)>500 then raise exception 'Keep the reason under 500 characters' using errcode='HA400';end if;
 if p_kind='emergency' and length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Tell the administrator briefly what happened' using errcode='HA400';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 if not public.task_rules_on(today) then raise exception 'Checkout rules are off, so you can check out without approval' using errcode='HA409';end if;
 select * into rec from public.attendance_records where user_id=p_actor and attendance_date=today;
 if rec.id is null then raise exception 'Check in first' using errcode='HA409';end if;
 if rec.state<>'checked_in' then raise exception 'You have already checked out today' using errcode='HA409';end if;
 if exists(select 1 from public.task_checkout_requests where user_id=p_actor and work_date=today and status='pending') then
  raise exception 'You already have a request waiting for an administrator' using errcode='HA409';end if;
 if exists(select 1 from public.task_checkout_requests where user_id=p_actor and work_date=today and status='approved') then
  raise exception 'Your checkout request is already approved' using errcode='HA409';end if;
 limits=public.task_request_limits(p_actor,p_kind,today,p_at);
 if (limits->>'limit_reached')::boolean then
  raise exception 'You have reached today''s limit of 3 % checkout requests. Please speak to an administrator.',p_kind using errcode='HA429';end if;
 if (limits->>'explanation_required')::boolean then
  if length(btrim(coalesce(p_reason,'')))<10 then
   raise exception 'Your last % checkout request was rejected. Explain what has changed (at least 10 characters).',p_kind using errcode='HA400';end if;
  if limits->'reasons' ? lower(regexp_replace(btrim(p_reason),'\s+',' ','g')) then
   raise exception 'This explanation repeats an earlier request. Explain what has changed since then.' using errcode='HA409';end if;
  if (limits->>'waiting')::boolean then
   raise exception 'You can ask again from %, 15 minutes after your last request was rejected.',public.task_time_text((limits->>'retry_at')::timestamptz) using errcode='HA429';end if;
 end if;
 if p_kind='early' then
  state=public.task_checkout_state_at(p_actor,p_at);
  if not (state->>'can_request_early')::boolean then raise exception '%',state->'early_blockers'->>0 using errcode='HA409';end if;
 end if;
 summary=public.task_day(p_actor,today);
 report=exists(select 1 from public.task_daily_reports where user_id=p_actor and work_date=today);
 insert into public.task_checkout_requests(user_id,work_date,kind,reason,requested_at,shift_end,completion_percent,report_submitted)
 values(p_actor,today,p_kind,nullif(btrim(p_reason),''),p_at,rec.shift_end,(summary->>'completion_percent')::numeric,report) returning * into req;
 -- The emergency reason stays in the request, not in notifications or the audit.
 perform public.task_notify_admins(p_actor,'checkout_request','checkout:'||req.id,
  format('%s checkout request: %s',case p_kind when 'early' then 'Early' else 'Emergency' end,left(actor.name,150)),
  case p_kind when 'early' then format('%s has completed all required daily tasks and requested checkout at %s. Normal shift end: %s. Task completion: %s%%. Report: submitted.',
    actor.name,public.task_time_text(p_at),to_char(rec.shift_end,'FMHH12:MI AM'),coalesce(req.completion_percent::text,'0'))
   else format('%s requested an emergency checkout at %s. Task completion: %s. Report: %s. Open the request to read the reason.',
    actor.name,public.task_time_text(p_at),coalesce(req.completion_percent::text||'%','no tasks'),case when report then 'submitted' else 'not submitted' end) end,
  '/task-management?tab=requests',null,null);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(p_actor,'checkout.request','task_checkout_requests',req.id::text,p_request,jsonb_build_object('user_id',p_actor,'kind',p_kind,'date',today,
  'completion_percent',req.completion_percent,'report_submitted',report,'shift_end',to_char(rec.shift_end,'HH24:MI'),
  'attempt',(limits->>'count')::integer+1));
 return public.task_request_json(req,today);
end $$;

-- As in 045, for agents and staff, with each person's role and department.
create or replace function public.task_admin_overview(p_actor uuid,p_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);day date=coalesce(p_day,public.attendance_local_date(now()));
begin
 return (with a as (select x.*,t.kind,t.target_quantity,t.task_date,t.due_on from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.status<>'cancelled' and t.task_date<=day and t.due_on>=day),
  agents as (select p.id,p.name,p.uid,p.role,public.department_name(p.department_id) department from public.profiles p where p.role in ('agent','staff') and p.active and p.deleted_at is null),
  r as (select * from public.task_daily_reports where work_date=day)
 select jsonb_build_object('date',day,'rules_active',public.task_rules_on(day),
  'active_tasks',(select count(distinct task_id) from a),'assigned_today',(select count(*) from public.tasks t where t.task_date=day and t.cancelled_at is null),
  'assignments',(select count(*) from a),'completed',(select count(*) from a where status='completed'),
  'pending',(select count(*) from a where status<>'completed'),'average_percent',(select round(avg(public.task_percent(kind,target_quantity,completed_quantity,status)),1) from a),
  'reports_submitted',(select count(*) from r),'reports_to_review',(select count(*) from public.task_daily_reports where status='submitted'),
  'missing_reports',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'uid',g.uid,'role',g.role,'department',g.department) order by g.name),'[]'::jsonb) from agents g
   where exists(select 1 from a where a.user_id=g.id) and not exists(select 1 from r where r.user_id=g.id)),
  'agents_with_tasks',(select count(distinct user_id) from a),
  'pending_early',(select count(*) from public.task_checkout_requests where status='pending' and kind='early' and work_date=day),
  'pending_emergency',(select count(*) from public.task_checkout_requests where status='pending' and kind='emergency'),
  'overdue_reports',(select jsonb_array_length(public.task_missing_reports(p_actor,day-7,day-1)->'data')),
  'people',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'uid',g.uid,'role',g.role,'department',g.department,
    'tasks',(select count(*) from a where a.user_id=g.id),'completed',(select count(*) from a where a.user_id=g.id and status='completed'),
    'percent',(select round(avg(public.task_percent(kind,target_quantity,completed_quantity,status)),1) from a where a.user_id=g.id),
    'report',(select jsonb_build_object('id',r.id,'status',r.status,'completion_percent',r.completion_percent) from r where r.user_id=g.id)) order by g.name),'[]'::jsonb)
   from agents g)));
end $$;

-- As in 045, for agents and staff: chosen people, all agents, all staff
-- and whole departments, as they are when the task is assigned.
create or replace function public.task_create_at(p_actor uuid,p_data jsonb,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(p_at);t public.tasks;
 ids uuid[];key uuid;day date;due date;kind text;dup text;u uuid;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['scope','title','description','instructions','category','priority','kind',
  'target_quantity','unit','task_date','due_on','assignees','all_agents','all_staff','departments','client_key','allow_duplicate'])<>'{}'::jsonb then
  raise exception 'Unsupported task details' using errcode='HA400';end if;
 key=(p_data->>'client_key')::uuid;
 if key is null then raise exception 'Invalid request' using errcode='HA400';end if;
 -- The same submission again (a double click or a retry) returns the task.
 select * into t from public.tasks where created_by=actor.id and client_key=key;
 if found then return public.task_detail(p_actor,t.id);end if;
 if length(btrim(coalesce(p_data->>'title','')))<3 then raise exception 'Enter a task title' using errcode='HA400';end if;
 kind=p_data->>'kind';day=coalesce((p_data->>'task_date')::date,today);due=coalesce((p_data->>'due_on')::date,day);
 if p_data->>'scope' not in ('team','individual') or kind not in ('measurable','simple') then
  raise exception 'Choose a team or individual task, measurable or simple' using errcode='HA400';end if;
 if day<today or day>today+60 then raise exception 'Choose today or a date up to 60 days ahead' using errcode='HA400';end if;
 if due<day or due>day+31 then raise exception 'The due date must be on or after the task date, within 31 days' using errcode='HA400';end if;
 if kind='measurable' and (p_data->>'target_quantity' is null or nullif(btrim(p_data->>'unit'),'') is null) then
  raise exception 'A measurable task needs a target and a unit, for example 50 calls' using errcode='HA400';end if;
 if p_data->>'scope'='individual' and (coalesce((p_data->>'all_agents')::boolean,false) or coalesce((p_data->>'all_staff')::boolean,false)
  or jsonb_array_length(coalesce(p_data->'departments','[]'::jsonb))>0) then
  raise exception 'An individual task is for one person' using errcode='HA400';end if;
 ids=public.task_recipients(p_data);
 if cardinality(ids)=0 then raise exception 'There are no active employees to assign' using errcode='HA400';end if;
 if p_data->>'scope'='individual' and cardinality(ids)<>1 then raise exception 'An individual task is for one person' using errcode='HA400';end if;
 if not coalesce((p_data->>'allow_duplicate')::boolean,false) then
  select p.name into dup from public.task_assignments x join public.tasks o on o.id=x.task_id join public.profiles p on p.id=x.user_id
   where x.user_id=any(ids) and x.status<>'cancelled' and o.task_date=day and lower(btrim(o.title))=lower(btrim(p_data->>'title')) limit 1;
  if dup is not null then
   raise exception '% already has “%” on %. Choose Assign anyway to add it again.',dup,btrim(p_data->>'title'),public.task_day_text(day) using errcode='HA409';end if;
 end if;
 insert into public.tasks(scope,title,description,instructions,category,priority,kind,target_quantity,unit,task_date,due_on,client_key,created_by,updated_by,audience)
 values(p_data->>'scope',btrim(p_data->>'title'),nullif(btrim(p_data->>'description'),''),nullif(btrim(p_data->>'instructions'),''),
  nullif(p_data->>'category',''),coalesce(p_data->>'priority','normal'),kind,
  case when kind='measurable' then (p_data->>'target_quantity')::integer end,case when kind='measurable' then btrim(p_data->>'unit') end,
  day,due,key,actor.id,actor.id,public.task_audience(p_data)) returning * into t;
 insert into public.task_assignments(task_id,user_id) select t.id,i from unnest(ids) i;
 foreach u in array ids loop
  perform public.push_notification(u,'task_assigned','task:'||t.id,'New task: '||left(t.title,180),
   format('%s assigned this for %s%s.',actor.name,public.task_day_text(t.task_date),
    case when t.kind='measurable' then format(': target %s %s',t.target_quantity,t.unit) else '' end),'/my-tasks',null);
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.create','tasks',t.id::text,p_request,jsonb_build_object('scope',t.scope,'title',t.title,'kind',t.kind,
  'target_quantity',t.target_quantity,'unit',t.unit,'date',t.task_date,'due_on',t.due_on,'priority',t.priority,'assignee_count',cardinality(ids),
  'audience',t.audience)
  ||case when cardinality(ids)=1 then jsonb_build_object('user_id',ids[1]) else '{}'::jsonb end);
 return public.task_detail(p_actor,t.id);
end $$;

-- As in 045; an individual task is for one person, agent or staff.
create or replace function public.task_update_at(p_actor uuid,p_task uuid,p_data jsonb,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(p_at);t public.tasks;n public.tasks;
 fields text[];added uuid[]='{}';u uuid;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','instructions','category','priority','target_quantity',
  'unit','due_on','add_assignees','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported task details' using errcode='HA400';end if;
 select * into t from public.tasks where id=p_task for update;
 if not found then raise exception 'Task not found' using errcode='HA404';end if;
 if t.cancelled_at is not null then raise exception 'This task was cancelled' using errcode='HA409';end if;
 if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from t.updated_at then
  raise exception 'Someone else changed this task. Reload it and repeat your change.' using errcode='HA409';end if;
 if t.kind='simple' and (p_data?'target_quantity' or p_data?'unit') then
  raise exception 'A simple task has no target' using errcode='HA400';end if;
 n=t;
 if p_data?'title' then n.title=btrim(p_data->>'title');end if;
 if p_data?'description' then n.description=nullif(btrim(p_data->>'description'),'');end if;
 if p_data?'instructions' then n.instructions=nullif(btrim(p_data->>'instructions'),'');end if;
 if p_data?'category' then n.category=nullif(p_data->>'category','');end if;
 if p_data?'priority' then n.priority=p_data->>'priority';end if;
 if p_data?'target_quantity' then n.target_quantity=(p_data->>'target_quantity')::integer;end if;
 if p_data?'unit' then n.unit=btrim(p_data->>'unit');end if;
 if p_data?'due_on' then n.due_on=(p_data->>'due_on')::date;
  if n.due_on<>t.due_on and (n.due_on<greatest(t.task_date,today) or n.due_on>t.task_date+31) then
   raise exception 'Choose a due date from today, within 31 days of the task date' using errcode='HA400';end if;
 end if;
 fields=array(select k from unnest(array['title','description','instructions','category','priority','target_quantity','unit','due_on']) k
  where to_jsonb(t)->k is distinct from to_jsonb(n)->k);
 if p_data?'add_assignees' then
  if t.scope='individual' then raise exception 'An individual task is for one person' using errcode='HA400';end if;
  added=array(select i from unnest(public.task_agents(p_data->'add_assignees',false)) i
   where not exists(select 1 from public.task_assignments x where x.task_id=t.id and x.user_id=i and x.status<>'cancelled'));
 end if;
 if cardinality(fields)=0 and cardinality(added)=0 then return public.task_detail(p_actor,t.id);end if;
 update public.tasks set title=n.title,description=n.description,instructions=n.instructions,category=n.category,priority=n.priority,
  target_quantity=n.target_quantity,unit=n.unit,due_on=n.due_on,updated_by=actor.id where id=t.id returning * into n;
 if 'target_quantity'=any(fields) then
  update public.task_assignments set status=public.task_status_for(n.target_quantity,completed_quantity),
   completed_at=case when public.task_status_for(n.target_quantity,completed_quantity)='completed' then coalesce(completed_at,p_at) end
  where task_id=t.id and status<>'cancelled' and verified_status is null;
 end if;
 -- Someone removed earlier gets the task back as new.
 foreach u in array added loop
  insert into public.task_assignments as x(task_id,user_id) values(t.id,u)
  on conflict(task_id,user_id) do update set status='pending',completed_quantity=0,employee_note=null,progress_at=null,completed_at=null,
   cancelled_at=null,cancelled_by=null,cancel_reason=null,verified_status=null,verified_quantity=null,verified_by=null,verified_at=null,review_note=null;
  perform public.push_notification(u,'task_assigned','task:'||t.id||':'||gen_random_uuid(),'New task: '||left(n.title,180),
   format('%s assigned this for %s.',actor.name,public.task_day_text(n.task_date)),'/my-tasks',null);
 end loop;
 if cardinality(fields)>0 then
  for u in select user_id from public.task_assignments where task_id=t.id and status<>'cancelled' and not (user_id=any(added)) loop
   perform public.push_notification(u,'task_updated','task-update:'||t.id||':'||gen_random_uuid(),'Task updated: '||left(n.title,180),
    format('%s changed this task (%s).',actor.name,array_to_string(array(select replace(f,'_',' ') from unnest(fields) f),', ')),'/my-tasks',null);
  end loop;
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.update','tasks',t.id::text,p_request,jsonb_build_object('title',n.title,'fields',to_jsonb(fields),'added_count',cardinality(added),
  'before',jsonb_build_object('target_quantity',t.target_quantity,'due_on',t.due_on,'title',t.title),
  'after',jsonb_build_object('target_quantity',n.target_quantity,'due_on',n.due_on,'title',n.title)));
 return public.task_detail(p_actor,t.id);
end $$;

-- As in 036, for staff accounts too.
create or replace function public.begin_account_provisioning(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_email text,p_name text,p_role text,p_active boolean,p_uid integer,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare chosen integer;taken text;
begin
 -- Same lock order as invitations, deletion and account role edits.
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if p_id is null or p_email is null or p_email<>lower(btrim(p_email)) or length(p_email)>254 or p_email!~'^[^@[:space:]]+@gmail\.com$'
 or p_role is null or p_role not in ('admin','agent','staff') or p_active is null or nullif(btrim(p_name),'') is null or length(p_name)>200
 or (p_uid is not null and p_uid not between 100000 and 999999) then
  raise exception 'Invalid account request' using errcode='22023';end if;
 -- No background worker: abandoned reservations resolve on the next request.
 -- An Auth user created by an interrupted request keeps its UID, disabled.
 with recovered as (
  update public.account_provisioning q set status=case when exists(select 1 from public.profiles p where p.id=q.id) then 'completed' else 'failed' end,finished_at=now()
  where q.status='creating' and q.lease_until<=now() returning q.id,q.status
 ) insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  select p_actor,'account.create_recovered','profiles',id::text,p_request,jsonb_build_object('status',status) from recovered;
 if exists(select 1 from auth.users u where lower(to_jsonb(u)->>'email')=p_email)
 or exists(select 1 from public.account_invitations where lower(email)=p_email)
 or exists(select 1 from public.account_creation_requests where normalized_email=p_email and status not in ('expired','cancelled','completed'))
 or exists(select 1 from public.account_provisioning where normalized_email=p_email and status='creating') then
  raise exception 'An account with this email already exists' using errcode='23505';end if;
 if p_uid is not null and (exists(select 1 from public.profiles where uid=p_uid)
 or exists(select 1 from public.account_provisioning where uid=p_uid and status<>'failed')) then
  raise exception 'This UID is already assigned to another account. Please choose a different UID.' using errcode='PT409';end if;
 for attempt in 1..5 loop
  chosen=coalesce(p_uid,public.generate_account_uid());
  begin
   insert into public.account_provisioning(id,uid,uid_source,normalized_email,requested_name,requested_role,desired_active,requested_by,status,lease_until)
    values(p_id,chosen,case when p_uid is null then 'auto' else 'manual' end,p_email,btrim(p_name),p_role,p_active,p_actor,'creating',now()+interval '5 minutes');
   exit;
  exception when unique_violation then
   -- Unique indexes stay authoritative. A rare generated collision draws again;
   -- a manual UID is never silently replaced.
   get stacked diagnostics taken=constraint_name;
   if taken='account_provisioning_uid' and p_uid is null and attempt<5 then continue;end if;
   if taken='account_provisioning_uid' then
    raise exception 'This UID is already assigned to another account. Please choose a different UID.' using errcode='PT409';end if;
   raise exception 'An account with this email already exists' using errcode='23505';
  end;
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'account.create_requested','profiles',p_id::text,p_request,jsonb_build_object('uid',chosen,'uid_source',case when p_uid is null then 'auto' else 'manual' end,'role',p_role));
 return jsonb_build_object('id',p_id,'uid',chosen,'uid_source',case when p_uid is null then 'auto' else 'manual' end);
end $$;

-- As in 036, also saving the department and job title chosen at creation.
create or replace function public.complete_account_provisioning(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.account_provisioning;profile public.profiles;u jsonb;
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into r from public.account_provisioning where id=p_id and requested_by=p_actor for update;
 if r.id is null then raise exception 'Account creation request not found' using errcode='P0002';end if;
 if r.status='completed' then return public.account_provisioning_summary(p_id);end if;
 if r.status<>'creating' then raise exception 'Account creation was cancelled' using errcode='40001';end if;
 select to_jsonb(a) into u from auth.users a where a.id=p_id;
 if u is null or lower(u->>'email') is distinct from r.normalized_email or nullif(u->>'email_confirmed_at','') is null
 or u->'raw_app_meta_data'->>'crm_account_request' is distinct from p_id::text or nullif(u->>'deleted_at','') is not null then
  raise exception 'Auth account could not be confirmed' using errcode='22023';end if;
 select * into profile from public.profiles where id=p_id for update;
 if profile.id is null or profile.uid is distinct from r.uid or profile.deletion_requested_at is not null then
  raise exception 'Account profile could not be confirmed' using errcode='22023';end if;
 update public.profiles set name=r.requested_name,role=r.requested_role,active=r.desired_active,
  department_id=coalesce(r.requested_department_id,department_id),job_title=coalesce(r.requested_job_title,job_title) where id=p_id;
 update public.account_provisioning set status='completed',finished_at=now() where id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'account.created','profiles',p_id::text,p_request,jsonb_build_object('uid',r.uid,'uid_source',r.uid_source,'role',r.requested_role,'active',r.desired_active)
   ||case when r.requested_department_id is not null then jsonb_build_object('department',public.department_name(r.requested_department_id)) else '{}'::jsonb end
   ||case when r.requested_job_title is not null then jsonb_build_object('job_title',r.requested_job_title) else '{}'::jsonb end);
 return public.account_provisioning_summary(p_id);
end $$;

-- As in 036, for staff too, with each account's department and job title.
create or replace function public.accounts_page_032(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint; summary jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_role not in ('','admin','agent','staff') or p_access not in ('','active','disabled','pending','expired','cancelled','deleting') then raise exception 'Invalid account filters' using errcode='22023'; end if;
  with records as (
    select p.id,p.uid,p.name,p.role,public.department_name(p.department_id) department,p.job_title,p.active,p.created_at,coalesce(d.confirmation_email,to_jsonb(u)->>'email') email,
      to_jsonb(u)->>'last_sign_in_at' last_sign_in_at,to_jsonb(u)->>'email_confirmed_at' email_confirmed_at,
      to_jsonb(u)->>'banned_until' banned_until,public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at') account_status,i.requested_at invitation_date,i.expires_at invitation_expires_at,i.accepted_at invitation_accepted_at,i.state invitation_state,(i.user_id is not null or (nullif(to_jsonb(u)->>'email_confirmed_at','') is null and to_jsonb(u)->'raw_app_meta_data'->>'crm_provisioning'='true')) invitation_required
    from public.profiles p join auth.users u on u.id=p.id left join public.account_invitations i on i.user_id=p.id left join crm_private.account_deletions d on d.user_id=p.id where p.deleted_at is null
  ), eligible as (
    select * from records where (p_role='' or role=p_role) and (p_access='' or (p_access='active' and account_status='active') or (p_access='disabled' and account_status in ('suspended','deletion_pending')) or (p_access='deleting' and account_status='deletion_pending') or (p_access='pending' and account_status in ('pending_invitation','pending_verification')) or (p_access='expired' and account_status='invitation_expired') or (p_access='cancelled' and account_status='invitation_cancelled'))
      and (p_search='' or position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(coalesce(email,'')))>0 or position(p_search in uid::text)>0)
  ), page_rows as (select * from eligible order by created_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'::jsonb),(select count(*) from eligible),
    (select jsonb_build_object('total',count(*),'admins',count(*) filter(where role='admin' and account_status='active'),'agents',count(*) filter(where role='agent' and account_status='active'),'staff',count(*) filter(where role='staff' and account_status='active'),'disabled',count(*) filter(where account_status='suspended'),'pending',count(*) filter(where account_status in ('pending_invitation','pending_verification')),'expired',count(*) filter(where account_status='invitation_expired')) from records)
    into rows,total,summary;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit,'summary',summary);
end $$;

-- As in 037, with the Staff sign-in.
create or replace function public.record_login_attempt(p_email text,p_success boolean,p_user uuid,p_portal text,p_ip text,p_agent text,
 p_max integer,p_window integer,p_lock integer,p_business_start integer,p_business_end integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare address text=lower(btrim(p_email));attempt crm_private.login_attempts;account uuid;result text;local_hour integer;
begin
 if address is null or length(address) not between 3 and 254 or p_success is null or (p_portal is not null and p_portal not in ('admin','agent','staff'))
 or p_max not between 1 and 20 or p_window not between 1 and 1440 or p_lock not between 1 and 1440
 or p_business_start not between 0 and 23 or p_business_end not between 0 and 23 then
  raise exception 'Invalid login attempt' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('login:'||address,37));
 -- p_user comes only from a successful Supabase sign-in for this address.
 select p.id into account from public.profiles p join auth.users u on u.id=p.id
  where (p_success and p.id=p_user) or (not p_success and lower(to_jsonb(u)->>'email')=address) limit 1;
 select * into attempt from crm_private.login_attempts where email=address for update;
 if attempt.locked_until>now() then
  result='locked';
 elsif p_success then
  result='success';
  delete from crm_private.login_attempts where email=address;
 else
  result='failed';
  insert into crm_private.login_attempts(email,failures,window_started) values(address,1,now())
  on conflict(email) do update set
   failures=case when crm_private.login_attempts.window_started<=now()-make_interval(mins=>p_window) or crm_private.login_attempts.locked_until is not null then 1 else crm_private.login_attempts.failures+1 end,
   window_started=case when crm_private.login_attempts.window_started<=now()-make_interval(mins=>p_window) or crm_private.login_attempts.locked_until is not null then now() else crm_private.login_attempts.window_started end,
   locked_until=null,updated_at=now()
  returning * into attempt;
  if attempt.failures>=p_max then
   update crm_private.login_attempts set locked_until=now()+make_interval(mins=>p_lock),updated_at=now() where email=address returning * into attempt;
   if account is not null then
    insert into public.security_alerts(type,severity,user_id,message,metadata)
     values('account_login_locked','warning',account,'Sign-in locked after repeated incorrect passwords.',
      jsonb_build_object('failures',attempt.failures,'locked_until',attempt.locked_until,'ip',left(p_ip,100)));
   end if;
  end if;
 end if;
 insert into public.login_events(user_id,email,portal,outcome,ip,user_agent)
  values(account,address,p_portal,result,left(p_ip,100),left(p_agent,300));
 if result='success' and account is not null then
  local_hour=extract(hour from now() at time zone 'Asia/Karachi')::integer;
  if (p_business_start<p_business_end and (local_hour<p_business_start or local_hour>=p_business_end))
  or (p_business_start>p_business_end and local_hour>=p_business_end and local_hour<p_business_start) then
   insert into public.security_alerts(type,severity,user_id,message,metadata)
    values('after_hours_login','info',account,'Signed in outside business hours.',
     jsonb_build_object('portal',p_portal,'ip',left(p_ip,100),'pakistan_hour',local_hour));
  end if;
 end if;
 return jsonb_build_object('outcome',result,'locked',coalesce(attempt.locked_until>now(),false),
  'locked_until',case when attempt.locked_until>now() then attempt.locked_until end);
end $$;

-- --------------------------------------------- department filters
-- As in 045, for agents and staff, with each person's role and department,
-- department totals and a department filter (p_department, null for all).
create or replace function public.task_performance(p_actor uuid,p_from date,p_to date,p_user uuid,p_department uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>92 then raise exception 'Choose a range of up to 93 days' using errcode='HA400';end if;
 return (with a as (select x.user_id,t.due_on,t.kind,t.target_quantity,x.completed_quantity,x.status,x.verified_status,x.verified_quantity,
    public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status) pct,
    case when x.verified_status is null then null when x.verified_status='not_done' then 0.0 when t.kind='measurable'
     then least(100,round(coalesce(x.verified_quantity,x.completed_quantity)*100.0/t.target_quantity,1)) else 100.0 end vpct
   from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.status<>'cancelled' and t.due_on between p_from and p_to and (p_user is null or x.user_id=p_user) and (p_department is null or x.user_id in (select id from public.profiles where department_id=p_department))),
  r as (select * from public.task_daily_reports where work_date between p_from and p_to and (p_user is null or user_id=p_user) and (p_department is null or user_id in (select id from public.profiles where department_id=p_department))),
  q as (select * from public.task_checkout_requests where work_date between p_from and p_to and (p_user is null or user_id=p_user) and (p_department is null or user_id in (select id from public.profiles where department_id=p_department))),
  people as (select p.* from public.profiles p where p.id in (select user_id from a union select user_id from r union select user_id from q)
   or (p_user is null and p.role in ('agent','staff') and p.active and p.deleted_at is null
    and (p_department is null or p.department_id=p_department)) or p.id=p_user)
 select jsonb_build_object('from',p_from,'to',p_to,
  'totals',jsonb_build_object('assignments',(select count(*) from a),'completed',(select count(*) from a where status='completed'),
   'average_percent',(select round(avg(pct),1) from a),'verified',(select count(*) from a where verified_status is not null),
   'verified_average_percent',(select round(avg(vpct),1) from a),'reports',(select count(*) from r),
   'early_approved',(select count(*) from q where kind='early' and status='approved'),'emergency_approved',(select count(*) from q where kind='emergency' and status='approved')),
  'employees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'active',p.active and p.deleted_at is null,
    'role',p.role,'department',public.department_name(p.department_id),
    'assignments',(select count(*) from a where user_id=p.id),'completed',(select count(*) from a where user_id=p.id and status='completed'),
    'average_percent',(select round(avg(pct),1) from a where user_id=p.id),
    'verified',(select count(*) from a where user_id=p.id and verified_status is not null),
    'verified_average_percent',(select round(avg(vpct),1) from a where user_id=p.id),
    'task_days',(select count(distinct due_on) from a where user_id=p.id),
    'reports',(select count(*) from r where user_id=p.id),'reports_reviewed',(select count(*) from r where user_id=p.id and status='reviewed'),
    'missing_reports',(select count(*) from (select distinct due_on from a where user_id=p.id and due_on<public.attendance_local_date(now())) d
     where not exists(select 1 from r where r.user_id=p.id and r.work_date=d.due_on)),
    'early',(select jsonb_build_object('approved',count(*) filter(where status='approved'),'rejected',count(*) filter(where status='rejected'),
      'pending',count(*) filter(where status='pending')) from q where user_id=p.id and kind='early'),
    'emergency',(select jsonb_build_object('approved',count(*) filter(where status='approved'),'rejected',count(*) filter(where status='rejected'),
      'pending',count(*) filter(where status='pending')) from q where user_id=p.id and kind='emergency'))
   order by p.name,p.id),'[]'::jsonb) from people p),
  -- Each department's assignments, averaged with equal weight per task as
  -- elsewhere; membership is each person's current department.
  'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'active',d.active,
    'employees',(select count(*) from public.profiles p where p.department_id=d.id and p.role in ('agent','staff') and p.active and p.deleted_at is null),
    'assignments',(select count(*) from a join public.profiles p on p.id=a.user_id where p.department_id=d.id),
    'completed',(select count(*) from a join public.profiles p on p.id=a.user_id where p.department_id=d.id and a.status='completed'),
    'average_percent',(select round(avg(a.pct),1) from a join public.profiles p on p.id=a.user_id where p.department_id=d.id),
    'reports',(select count(*) from r join public.profiles p on p.id=r.user_id where p.department_id=d.id))
   order by d.sort_order,lower(d.name)),'[]'::jsonb) from public.departments d where p_department is null or d.id=p_department),
  'days',(select coalesce(jsonb_agg(jsonb_build_object('date',d,'assignments',(select count(*) from a where due_on=d),
    'completed',(select count(*) from a where due_on=d and status='completed'),'average_percent',(select round(avg(pct),1) from a where due_on=d),
    'reports',(select count(*) from r where work_date=d)) order by d),'[]'::jsonb)
   from generate_series(p_from,p_to,interval '1 day') g(dd),lateral (select g.dd::date d) x)));
end $$;
-- The 045 call without a department.
create or replace function public.task_performance(p_actor uuid,p_from date,p_to date,p_user uuid) returns jsonb language sql security definer set search_path='' as $$
 select public.task_performance(p_actor,p_from,p_to,p_user,null::uuid)
$$;
-- As in 040, with each employee's department and a department filter.
create or replace function public.attendance_leave_page(p_actor uuid,p_mine boolean,p_status text,p_user uuid,p_page integer,p_limit integer,p_department uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);scope uuid;result jsonb;
begin
 if (p_status is not null and p_status not in ('pending','approved','rejected','cancelled')) or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid filter' using errcode='HA400';end if;
 scope=case when actor.role<>'admin' or coalesce(p_mine,false) then p_actor else p_user end;
 with visible as (
  select l.*,p.name employee_name,p.uid employee_uid,p.role employee_role,public.department_name(p.department_id) employee_department,r.name reviewer_name
  from public.attendance_leave_requests l join public.profiles p on p.id=l.user_id left join public.profiles r on r.id=l.reviewer_id
  where (scope is null or l.user_id=scope) and (p_status is null or l.status=p_status)
   and (p_department is null or p.department_id=p_department)
 ), page as (select * from visible order by case status when 'pending' then 0 else 1 end,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by case status when 'pending' then 0 else 1 end,created_at desc,id) from page),'[]'::jsonb),
  'count',(select count(*) from visible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;
-- The 040 call without a department.
create or replace function public.attendance_leave_page(p_actor uuid,p_mine boolean,p_status text,p_user uuid,p_page integer,p_limit integer) returns jsonb language sql security definer set search_path='' as $$
 select public.attendance_leave_page(p_actor,p_mine,p_status,p_user,p_page,p_limit,null::uuid)
$$;

-- -------------------------------------------------------------- accounts
-- The department and job title of an account being created, set by the API
-- after begin_account_provisioning reserves it and before the login exists;
-- complete_account_provisioning saves them with the role.
create or replace function public.account_provisioning_details(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_department uuid,p_job_title text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.account_provisioning;title text=nullif(regexp_replace(btrim(coalesce(p_job_title,'')),'\s+',' ','g'),'');
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into r from public.account_provisioning where id=p_id and requested_by=p_actor for update;
 if r.id is null or r.status<>'creating' then raise exception 'Account creation request not found' using errcode='P0002';end if;
 if length(title)>80 then raise exception 'Invalid account request' using errcode='22023';end if;
 if p_department is not null and not exists(select 1 from public.departments where id=p_department and active) then
  raise exception 'Invalid account request' using errcode='22023';end if;
 update public.account_provisioning set requested_department_id=p_department,requested_job_title=title where id=p_id;
 return jsonb_build_object('id',p_id,'department',public.department_name(p_department),'job_title',title);
end $$;

-- As in 022 (with the active-leads check of 032), for staff too. Staff never
-- hold leads, so an agent with leads hands them over before becoming staff
-- (the handover dialog can make that change). The audit also records a
-- change of role or access.
create or replace function public.update_account_022(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.profiles; result public.profiles;
begin
  -- Serialize account-role/access edits before locking administrator rows.
  perform pg_advisory_xact_lock(873420);
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}'::jsonb or (p_data-array['name','role','active'])<>'{}'::jsonb
    or (p_data?'name' and (jsonb_typeof(p_data->'name')<>'string' or length(btrim(p_data->>'name')) not between 1 and 200))
    or (p_data?'role' and coalesce(p_data->>'role','') not in ('admin','agent','staff'))
    or (p_data?'active' and jsonb_typeof(p_data->'active') is distinct from 'boolean') then raise exception 'Invalid account fields' using errcode='22023'; end if;
  select * into target from public.profiles where id=p_target for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if target.role='agent' and p_data?'active' and not (p_data->>'active')::boolean
    and exists(select 1 from public.active_leads where assigned_agent=p_target) then
    raise exception 'Use the agent handover dialog before disabling an agent with leads' using errcode='22023'; end if;
  if target.role='agent' and p_data->>'role'='staff' and exists(select 1 from public.active_leads where assigned_agent=p_target) then
    raise exception 'Use the agent handover dialog to hand over this agent''s leads before changing the account to Staff' using errcode='22023'; end if;
  if p_target=p_actor and ((p_data?'role' and p_data->>'role'<>'admin') or (p_data?'active' and not (p_data->>'active')::boolean)) then raise exception 'You cannot disable or demote your own administrator account' using errcode='22023'; end if;
  if target.active and target.role='admin' and (coalesce(p_data->>'role',target.role)<>'admin' or not coalesce((p_data->>'active')::boolean,target.active))
    and (select count(*) from public.profiles where role='admin' and active)<=1 then raise exception 'Keep at least one active administrator' using errcode='22023'; end if;
  update public.profiles set name=case when p_data?'name' then btrim(p_data->>'name') else name end,
    role=coalesce(p_data->>'role',role),active=coalesce((p_data->>'active')::boolean,active) where id=p_target returning * into result;
  if not result.active or result.role<>'admin' then delete from public.account_unlocks where admin_id=p_target; end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'manage_account','profiles',p_target::text,p_request,
    jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data))))
    ||case when result.role<>target.role then jsonb_build_object('role_from',target.role,'role_to',result.role) else '{}'::jsonb end
    ||case when result.active<>target.active then jsonb_build_object('active',result.active) else '{}'::jsonb end);
  return to_jsonb(result);
end $$;

-- ---------------------------------------------------- employee management
-- Administrators only, through attendance_admin. Departments, job titles,
-- joining dates and shifts are working details, not account access, so they
-- do not need the Accounts PIN.
create or replace function public.employee_departments(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 return (select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'active',d.active,'sort_order',d.sort_order,
   'agents',(select count(*) from public.profiles p where p.department_id=d.id and p.role='agent' and p.active and p.deleted_at is null),
   'staff',(select count(*) from public.profiles p where p.department_id=d.id and p.role='staff' and p.active and p.deleted_at is null),
   'members',(select count(*) from public.profiles p where p.department_id=d.id and p.active and p.deleted_at is null))
  order by d.sort_order,lower(d.name)),'[]'::jsonb) from public.departments d);
end $$;
-- p_id null creates a department. Departments are renamed or deactivated,
-- never deleted, so every past link stays readable.
create or replace function public.department_save(p_actor uuid,p_id uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);before public.departments;result public.departments;
 nm text=regexp_replace(btrim(coalesce(p_data->>'name','')),'\s+',' ','g');
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['name','active','sort_order'])<>'{}'::jsonb
  or (p_data?'active' and jsonb_typeof(p_data->'active') is distinct from 'boolean')
  or (p_data?'sort_order' and (jsonb_typeof(p_data->'sort_order') is distinct from 'number' or (p_data->>'sort_order')::numeric not between 0 and 10000
   or (p_data->>'sort_order')::numeric<>trunc((p_data->>'sort_order')::numeric))) then
  raise exception 'Invalid department details' using errcode='HA400';end if;
 if (p_id is null or p_data?'name') and length(nm) not between 2 and 60 then
  raise exception 'Enter a department name of 2 to 60 characters' using errcode='HA400';end if;
 begin
  if p_id is null then
   insert into public.departments(name,sort_order,active,created_by)
   values(nm,coalesce((p_data->>'sort_order')::integer,100),coalesce((p_data->>'active')::boolean,true),actor.id) returning * into result;
   insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(actor.id,'department.created','departments',result.id::text,p_request,jsonb_build_object('name',result.name));
  else
   select * into before from public.departments where id=p_id for update;
   if not found then raise exception 'Department not found' using errcode='HA404';end if;
   update public.departments set name=case when p_data?'name' then nm else name end,active=coalesce((p_data->>'active')::boolean,active),
    sort_order=coalesce((p_data->>'sort_order')::integer,sort_order) where id=p_id returning * into result;
   if result.name<>before.name or result.active<>before.active or result.sort_order<>before.sort_order then
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(actor.id,'department.updated','departments',p_id::text,p_request,jsonb_build_object('name',result.name,
     'before',jsonb_build_object('name',before.name,'active',before.active),'after',jsonb_build_object('name',result.name,'active',result.active)));
   end if;
  end if;
 exception when unique_violation then
  raise exception 'A department called % already exists',nm using errcode='HA409';
 end;
 return to_jsonb(result);
end $$;
-- One employee as administrators manage them: profile, department, job
-- title, joining date and shifts (the attendance, tasks and leave come from
-- the existing attendance and task functions).
create or replace function public.employee_detail(p_actor uuid,p_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);p public.profiles;today date=public.attendance_local_date(now());
begin
 select * into p from public.profiles where id=p_user and deleted_at is null and role in ('admin','agent','staff');
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 return jsonb_build_object('id',p.id,'uid',p.uid,'name',p.name,'role',p.role,'active',p.active,
  'email',(select to_jsonb(u)->>'email' from auth.users u where u.id=p.id),
  'department_id',p.department_id,'department',public.department_name(p.department_id),'job_title',p.job_title,'joined_on',p.joined_on,
  'created_at',p.created_at,'today',today,'shift',public.employee_shift_info(p.id,today),
  'shifts',(select coalesce(jsonb_agg(jsonb_build_object('effective_from',s.effective_from,
    'source',case when s.follows_company then 'company' else 'assigned' end,'label',s.label,
    'shift_start',to_char(s.shift_start,'HH24:MI'),'shift_end',to_char(s.shift_end,'HH24:MI'),'work_days',to_jsonb(s.work_days),
    'grace_minutes',s.grace_minutes,'created_by_name',(select name from public.profiles where id=s.created_by),'created_at',s.created_at,
    'upcoming',s.effective_from>today) order by s.effective_from desc),'[]'::jsonb) from public.employee_shifts s where s.user_id=p.id));
end $$;
create or replace function public.employee_profile_save(p_actor uuid,p_user uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);before public.profiles;result public.profiles;dep uuid;title text;joined date;
 changes jsonb='{}'::jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}'::jsonb or (p_data-array['department_id','job_title','joined_on'])<>'{}'::jsonb
  or (p_data?'department_id' and jsonb_typeof(p_data->'department_id') not in ('string','null'))
  or (p_data?'job_title' and jsonb_typeof(p_data->'job_title') not in ('string','null'))
  or (p_data?'joined_on' and jsonb_typeof(p_data->'joined_on') not in ('string','null')) then
  raise exception 'Invalid employee details' using errcode='HA400';end if;
 select * into before from public.profiles where id=p_user and deleted_at is null and role in ('admin','agent','staff') for update;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 dep=case when p_data?'department_id' then (p_data->>'department_id')::uuid else before.department_id end;
 if dep is distinct from before.department_id and dep is not null and not exists(select 1 from public.departments where id=dep and active) then
  raise exception 'Choose an active department' using errcode='HA400';end if;
 title=case when p_data?'job_title' then nullif(regexp_replace(btrim(coalesce(p_data->>'job_title','')),'\s+',' ','g'),'') else before.job_title end;
 if length(title)>80 then raise exception 'Use a job title of up to 80 characters' using errcode='HA400';end if;
 joined=case when p_data?'joined_on' then (p_data->>'joined_on')::date else before.joined_on end;
 if joined is not null and joined is distinct from before.joined_on and (joined<'1990-01-01' or joined>public.attendance_local_date(now())+366) then
  raise exception 'Choose a joining date between 1990 and a year from now' using errcode='HA400';end if;
 update public.profiles set department_id=dep,job_title=title,joined_on=joined where id=p_user returning * into result;
 if result.department_id is distinct from before.department_id then
  changes=changes||jsonb_build_object('department',jsonb_build_object('before',public.department_name(before.department_id),'after',public.department_name(result.department_id)));end if;
 if result.job_title is distinct from before.job_title then
  changes=changes||jsonb_build_object('job_title',jsonb_build_object('before',before.job_title,'after',result.job_title));end if;
 if result.joined_on is distinct from before.joined_on then
  changes=changes||jsonb_build_object('joined_on',jsonb_build_object('before',before.joined_on,'after',result.joined_on));end if;
 if changes<>'{}'::jsonb then
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'employee.updated','profiles',p_user::text,p_request,jsonb_build_object('user_id',p_user,'role',result.role,'changes',changes));
 end if;
 return public.employee_detail(p_actor,p_user);
end $$;
-- A shift from a date: today or later, so days already worked keep their
-- rules. Saving the same date again replaces that change.
create or replace function public.employee_shift_save(p_actor uuid,p_user uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);person public.profiles;today date=public.attendance_local_date(now());
 starts date;company boolean;days smallint[];label text;s_start time;s_end time;grace integer;before jsonb;saved public.employee_shifts;
begin
 if jsonb_typeof(p_data) is distinct from 'object'
  or (p_data-array['effective_from','follows_company','label','shift_start','shift_end','work_days','grace_minutes'])<>'{}'::jsonb
  or (p_data?'follows_company' and jsonb_typeof(p_data->'follows_company') is distinct from 'boolean') then
  raise exception 'Invalid shift details' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and deleted_at is null and role in ('admin','agent','staff') for share;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 starts=coalesce((p_data->>'effective_from')::date,today);
 if starts<today or starts>today+365 then
  raise exception 'Choose today or a date up to a year ahead. Days already worked keep the shift they had.' using errcode='HA400';end if;
 company=coalesce((p_data->>'follows_company')::boolean,false);
 if not company then
  label=nullif(regexp_replace(btrim(coalesce(p_data->>'label','')),'\s+',' ','g'),'');
  if label is null or length(label)>60 then raise exception 'Name the shift (up to 60 characters)' using errcode='HA400';end if;
  s_start=(p_data->>'shift_start')::time;s_end=(p_data->>'shift_end')::time;grace=(p_data->>'grace_minutes')::integer;
  if s_start is null or s_end is null or s_end<=s_start then
   raise exception 'The shift must end after it starts, on the same day' using errcode='HA400';end if;
  if jsonb_typeof(p_data->'work_days') is distinct from 'array' then raise exception 'Choose the working days' using errcode='HA400';end if;
  days=array(select distinct x::smallint from jsonb_array_elements_text(p_data->'work_days') x order by 1);
  if cardinality(days) not between 1 and 7 or not days<@'{1,2,3,4,5,6,7}'::smallint[] then
   raise exception 'Choose the working days' using errcode='HA400';end if;
  if grace is null or grace not between 0 and 120 or make_interval(mins=>grace)>=s_end-s_start then
   raise exception 'Choose a grace period of 0 to 120 minutes, shorter than the shift' using errcode='HA400';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_user,40));
 before=public.employee_shift_info(p_user,starts);
 insert into public.employee_shifts(user_id,effective_from,follows_company,label,shift_start,shift_end,work_days,grace_minutes,created_by)
 values(p_user,starts,company,label,s_start,s_end,days,grace,actor.id)
 on conflict(user_id,effective_from) do update set follows_company=excluded.follows_company,label=excluded.label,shift_start=excluded.shift_start,
  shift_end=excluded.shift_end,work_days=excluded.work_days,grace_minutes=excluded.grace_minutes,created_by=excluded.created_by,created_at=now()
 returning * into saved;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'employee.shift_changed','profiles',p_user::text,p_request,jsonb_build_object('user_id',p_user,'role',person.role,
  'effective_from',starts,'before',before-'upcoming'-'effective_from','after',public.employee_shift_info(p_user,starts)-'upcoming'-'effective_from'));
 return public.employee_detail(p_actor,p_user);
end $$;
-- Only a change that has not started yet can be withdrawn.
create or replace function public.employee_shift_cancel(p_actor uuid,p_user uuid,p_from date,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());gone public.employee_shifts;
begin
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_user,40));
 delete from public.employee_shifts where user_id=p_user and effective_from=p_from and effective_from>today returning * into gone;
 if not found then raise exception 'Only a shift change that has not started yet can be withdrawn' using errcode='HA409';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'employee.shift_cancelled','profiles',p_user::text,p_request,jsonb_build_object('user_id',p_user,'effective_from',p_from,
  'label',gone.label,'follows_company',gone.follows_company));
 return public.employee_detail(p_actor,p_user);
end $$;
-- Every employee with today's attendance and tasks, for Employee
-- management. Filters: search, role, department (an id or 'none'), account
-- (active, inactive), attendance (present, late or a day state) and tasks
-- (none, incomplete, complete).
create or replace function public.employees_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);today date=public.attendance_local_date(now());
 term text=nullif(lower(btrim(coalesce(f->>'search',''))),'');result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 or jsonb_typeof(f)<>'object'
  or (f-array['search','role','department','account','attendance','tasks'])<>'{}'::jsonb or length(coalesce(f->>'search',''))>100
  or coalesce(f->>'role','admin') not in ('admin','agent','staff') or coalesce(f->>'account','active') not in ('active','inactive')
  or coalesce(f->>'tasks','none') not in ('none','incomplete','complete')
  or coalesce(f->>'attendance','present') not in ('present','late','absent','leave','not_checked_in','checked_in','checked_out','incomplete','day_off','holiday','not_tracked')
  or (f->>'department' is not null and f->>'department'<>'none' and f->>'department'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'Invalid employee filter' using errcode='HA400';end if;
 with people as (
  select p.*,to_jsonb(u)->>'email' email from public.profiles p join auth.users u on u.id=p.id
  where p.deleted_at is null and p.role in ('admin','agent','staff')
 ), days as (select * from public.attendance_days(today,today,null,now())),
 work as (
  select x.user_id,count(*) tasks,count(*) filter(where x.status='completed') completed,
   round(avg(public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status)),1) pct
  from public.task_assignments x join public.tasks t on t.id=x.task_id
  where x.status<>'cancelled' and t.task_date<=today and t.due_on>=today group by x.user_id
 ), rows as (
  select pe.id,pe.uid,pe.name,pe.email,pe.role,pe.department_id,public.department_name(pe.department_id) department,pe.job_title,pe.joined_on,
   pe.active,coalesce(d.state,'not_tracked') attendance_state,d.punctuality,d.late_minutes,d.check_in_at,d.check_out_at,d.leave_type,
   coalesce(w.tasks,0) tasks,coalesce(w.completed,0) completed,w.pct task_percent,
   exists(select 1 from public.task_daily_reports r where r.user_id=pe.id and r.work_date=today) report_submitted
  from people pe left join days d on d.user_id=pe.id left join work w on w.user_id=pe.id
 ), filtered as (
  select * from rows r
  where (term is null or position(term in lower(r.name))>0 or position(term in lower(coalesce(r.email,'')))>0 or r.uid::text=term
    or position(term in lower(coalesce(r.job_title,'')))>0)
   and (f->>'role' is null or r.role=f->>'role')
   and (f->>'department' is null or (f->>'department'='none' and r.department_id is null) or r.department_id::text=f->>'department')
   and (f->>'account' is null or r.active=(f->>'account'='active'))
   and (f->>'attendance' is null or (f->>'attendance'='present' and r.attendance_state in ('checked_in','checked_out'))
    or (f->>'attendance'='late' and r.punctuality='late') or r.attendance_state=f->>'attendance')
   and (f->>'tasks' is null or (f->>'tasks'='none' and r.tasks=0) or (f->>'tasks'='complete' and r.tasks>0 and r.completed=r.tasks)
    or (f->>'tasks'='incomplete' and r.tasks>r.completed))
 ), page as (select * from filtered order by lower(name),id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('date',today,'count',(select count(*) from filtered),'page',p_page,'limit',p_limit,
  'data',coalesce((select jsonb_agg(to_jsonb(pg)||jsonb_build_object('shift',public.employee_shift_info(pg.id,today)) order by lower(pg.name),pg.id)
   from page pg),'[]'::jsonb),
  'summary',jsonb_build_object('active',(select count(*) from rows where active),
   'admins',(select count(*) from rows where active and role='admin'),'agents',(select count(*) from rows where active and role='agent'),
   'staff',(select count(*) from rows where active and role='staff'),
   'present',(select count(*) from rows where active and attendance_state in ('checked_in','checked_out')),
   'late',(select count(*) from rows where active and punctuality='late'),
   'absent',(select count(*) from rows where active and attendance_state='absent'),
   'on_leave',(select count(*) from rows where active and attendance_state='leave'),
   'without_department',(select count(*) from rows where active and department_id is null))) into result;
 return result;
end $$;
-- The signed-in employee's own working details, for My profile.
create or replace function public.employee_me(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);
begin
 return jsonb_build_object('id',actor.id,'uid',actor.uid,'name',actor.name,'role',actor.role,
  'email',(select to_jsonb(u)->>'email' from auth.users u where u.id=actor.id),
  'department',public.department_name(actor.department_id),'job_title',actor.job_title,'joined_on',actor.joined_on,
  'shift',public.employee_shift_info(actor.id,public.attendance_local_date(now())));
end $$;


-- ---------------------------------------------------------------- grants
-- Browser roles get nothing. Restated functions keep their privileges (the
-- API calls the same ones as before); the new ones the API calls are granted
-- to the service role, and the new helpers run only inside other functions.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('account_provisioning_details','employee_departments','department_save','employee_detail','employee_profile_save','employee_shift_save','employee_shift_cancel','employees_page','employee_me','task_performance','attendance_leave_page','department_name','attendance_shift_apply','attendance_policy_for','attendance_admin_rules_for','employee_shift_info','task_recipients','task_audience','attendance_member','attendance_days','attendance_me','attendance_check_in_at','attendance_overview','attendance_daily','attendance_period','attendance_employees','attendance_employee','attendance_correction_request','attendance_correction_review','attendance_admin_tidy','attendance_admin_day_at','attendance_admin_set_at','task_checkout_check','task_checkout_state_at','task_report_submit_at','task_checkout_request_at','task_admin_overview','task_create_at','task_update_at','task_agents','begin_account_provisioning','complete_account_provisioning','accounts_page_032','record_login_attempt','update_account_022') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('account_provisioning_details','employee_departments','department_save','employee_detail','employee_profile_save','employee_shift_save','employee_shift_cancel','employees_page','employee_me','task_performance','attendance_leave_page') then
   execute format('grant execute on function %s to service_role',f.signature);
  elsif f.proname in ('department_name','attendance_shift_apply','attendance_policy_for','attendance_admin_rules_for','employee_shift_info','task_recipients','task_audience') then
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
