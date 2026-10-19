-- Apply after 039. Safe to rerun. Smart attendance for Admins and Agents:
-- versioned policy (10:00–18:00, Monday–Saturday, 15-minute grace, Pakistan
-- time), check-in/out with the database clock, holidays, leave and correction
-- requests reviewed by another administrator, and reports derived from the
-- schedule so absences are never stored or invented. Lead ownership is never
-- changed by anything in this update.
-- Errors raised here use SQLSTATE HA<http status> (HA400, HA403, HA404,
-- HA409) with messages that are safe to show to the signed-in user.
begin;
do $$ begin
 if to_regclass('public.notifications') is null or to_regprocedure('public.report_scope(uuid,uuid,timestamptz,timestamptz)') is null then
  raise exception 'Apply CRM updates 038 and 039 before attendance update 040.';
 end if;
end $$;

-- ---------------------------------------------------------------- policy
create table if not exists public.attendance_policies(
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 80),
 -- The whole CRM works in Pakistan time; other zones are not supported.
 timezone text not null default 'Asia/Karachi' check(timezone='Asia/Karachi'),
 shift_start time not null,
 shift_end time not null,
 work_days smallint[] not null check(cardinality(work_days) between 1 and 7 and work_days<@'{1,2,3,4,5,6,7}'::smallint[]),
 grace_minutes integer not null check(grace_minutes between 0 and 120),
 -- Break tracking is not supported yet; worked time is check-in to check-out.
 break_tracking boolean not null default false check(not break_tracking),
 effective_from date not null unique,
 effective_to date,
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint attendance_policies_shift check(shift_end>shift_start and make_interval(mins=>grace_minutes)<shift_end-shift_start),
 constraint attendance_policies_dates check(effective_to is null or effective_to>=effective_from)
);
create or replace function public.guard_attendance_policy() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.attendance_policies p where p.id<>new.id
  and daterange(p.effective_from,p.effective_to,'[]') && daterange(new.effective_from,new.effective_to,'[]')) then
  raise exception 'Attendance policy periods cannot overlap' using errcode='HA409';
 end if;
 new.updated_at=now();
 return new;
end $$;
drop trigger if exists guard_attendance_policy on public.attendance_policies;
create trigger guard_attendance_policy before insert or update on public.attendance_policies for each row execute function public.guard_attendance_policy();
-- Tracking starts on the day this update is installed (Pakistan date).
insert into public.attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from)
select 'HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,(now() at time zone 'Asia/Karachi')::date
where not exists(select 1 from public.attendance_policies);

-- Pakistan calendar helpers.
create or replace function public.attendance_local_date(p_at timestamptz) returns date language sql stable set search_path='' as $$
 select (p_at at time zone 'Asia/Karachi')::date
$$;
create or replace function public.attendance_moment(p_day date,p_time time) returns timestamptz language sql stable set search_path='' as $$
 select (p_day+p_time) at time zone 'Asia/Karachi'
$$;
create or replace function public.attendance_policy_on(p_day date) returns public.attendance_policies language sql stable security definer set search_path='' as $$
 select * from public.attendance_policies where effective_from<=p_day and (effective_to is null or effective_to>=p_day) limit 1
$$;

-- ------------------------------------------------- attendance eligibility
-- Accounts have no hire/leave dates, so attendance counts only while an
-- account is active. A period opens when an account is enabled and closes
-- when it is disabled or deleted; history is kept.
create table if not exists public.attendance_periods(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 starts_on date not null,
 ends_on date,
 created_at timestamptz not null default now(),
 check(ends_on is null or ends_on>=starts_on)
);
create unique index if not exists attendance_periods_open on public.attendance_periods(user_id) where ends_on is null;
create index if not exists attendance_periods_user on public.attendance_periods(user_id,starts_on);
insert into public.attendance_periods(user_id,starts_on)
select p.id,(select min(effective_from) from public.attendance_policies) from public.profiles p
where p.active and p.deleted_at is null and p.role in ('admin','agent')
 and not exists(select 1 from public.attendance_periods e where e.user_id=p.id);
create or replace function public.track_attendance_period() returns trigger language plpgsql security definer set search_path='' as $$
declare was boolean=false;now_on boolean=new.active and new.deleted_at is null;today date=public.attendance_local_date(now());
begin
 if tg_op='UPDATE' then was=old.active and old.deleted_at is null;end if;
 if now_on and not was then
  insert into public.attendance_periods(user_id,starts_on) values(new.id,today)
  on conflict(user_id) where ends_on is null do nothing;
 elsif was and not now_on then
  update public.attendance_periods set ends_on=greatest(starts_on,today) where user_id=new.id and ends_on is null;
 end if;
 return null;
end $$;
drop trigger if exists track_attendance_period on public.profiles;
create trigger track_attendance_period after insert or update of active,deleted_at on public.profiles for each row execute function public.track_attendance_period();

-- ---------------------------------------------------------------- records
create table if not exists public.attendance_records(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 attendance_date date not null,
 policy_id uuid not null references public.attendance_policies(id),
 -- Snapshot of the rules used, so later policy changes never rewrite history.
 shift_start time not null,
 shift_end time not null,
 grace_minutes integer not null,
 timezone text not null default 'Asia/Karachi',
 check_in_at timestamptz not null,
 check_out_at timestamptz,
 state text not null default 'checked_in' check(state in ('checked_in','checked_out','incomplete')),
 punctuality text not null check(punctuality in ('on_time','within_grace','late')),
 late_minutes integer not null default 0 check(late_minutes>=0),
 beyond_grace_minutes integer not null default 0 check(beyond_grace_minutes>=0),
 worked_minutes integer check(worked_minutes>=0),
 early_departure_minutes integer check(early_departure_minutes>=0),
 overtime_minutes integer check(overtime_minutes>=0),
 corrected boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,attendance_date),
 constraint attendance_records_order check(check_out_at is null or check_out_at>check_in_at),
 constraint attendance_records_state check((state='checked_out')=(check_out_at is not null)),
 constraint attendance_records_totals check(state<>'checked_out' or (worked_minutes is not null and early_departure_minutes is not null and overtime_minutes is not null))
);
create unique index if not exists attendance_records_one_open on public.attendance_records(user_id) where state='checked_in';
create index if not exists attendance_records_day on public.attendance_records(attendance_date,user_id);

create table if not exists public.attendance_holidays(
 id uuid primary key default gen_random_uuid(),
 holiday_date date not null unique,
 name text not null check(length(btrim(name)) between 1 and 80),
 description text check(length(description)<=300),
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now()
);

create table if not exists public.attendance_leave_requests(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 leave_type text not null check(leave_type in ('casual','sick','emergency','unpaid','other')),
 start_date date not null,
 end_date date not null,
 reason text not null check(length(btrim(reason)) between 3 and 500),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 reviewer_id uuid references public.profiles(id),
 review_note text check(length(review_note)<=300),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint attendance_leave_dates check(start_date<=end_date and end_date-start_date<=30),
 constraint attendance_leave_review check((status in ('approved','rejected'))=(reviewer_id is not null and reviewed_at is not null)),
 constraint attendance_leave_not_self check(reviewer_id is distinct from user_id)
);
create index if not exists attendance_leave_user on public.attendance_leave_requests(user_id,start_date,end_date);
create index if not exists attendance_leave_status on public.attendance_leave_requests(status,created_at desc);

create table if not exists public.attendance_corrections(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 attendance_date date not null,
 record_id uuid references public.attendance_records(id),
 correction_type text not null check(correction_type in ('missing_check_in','missing_check_out','incorrect_check_in','incorrect_check_out')),
 original_check_in_at timestamptz,
 original_check_out_at timestamptz,
 requested_check_in_at timestamptz,
 requested_check_out_at timestamptz,
 reason text not null check(length(btrim(reason)) between 3 and 500),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 reviewer_id uuid references public.profiles(id),
 review_note text check(length(review_note)<=300),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint attendance_corrections_times check(requested_check_in_at is not null or requested_check_out_at is not null),
 constraint attendance_corrections_review check((status in ('approved','rejected'))=(reviewer_id is not null and reviewed_at is not null)),
 constraint attendance_corrections_not_self check(reviewer_id is distinct from user_id)
);
create unique index if not exists attendance_corrections_one_pending on public.attendance_corrections(user_id,attendance_date) where status='pending';
create index if not exists attendance_corrections_status on public.attendance_corrections(status,created_at desc);

do $$ declare t text;begin
 foreach t in array array['attendance_policies','attendance_periods','attendance_records','attendance_holidays','attendance_leave_requests','attendance_corrections'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 foreach t in array array['attendance_records','attendance_leave_requests','attendance_corrections'] loop
  execute format('drop trigger if exists touch_updated on public.%I',t);
  execute format('create trigger touch_updated before update on public.%I for each row execute function public.touch_updated()',t);
 end loop;
end $$;

-- Notification types for attendance.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary'));

-- ------------------------------------------------------- shared helpers
create or replace function public.attendance_member(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent') for share;
 if not found then raise exception 'Your account is not active' using errcode='HA403';end if;
 return actor;
end $$;
create or replace function public.attendance_admin(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);
begin
 if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
 return actor;
end $$;
-- Punctuality and durations in whole minutes. 10:15:59 is within a 15-minute
-- grace period; 10:16 is late. Early departure and overtime compare the
-- check-out with the shift end.
create or replace function public.attendance_compute(p_day date,p_start time,p_end time,p_grace integer,p_in timestamptz,p_out timestamptz)
returns table(punctuality text,late_minutes integer,beyond_grace_minutes integer,worked_minutes integer,early_departure_minutes integer,overtime_minutes integer)
language sql stable set search_path='' as $$
 select case when x.late<=0 then 'on_time' when x.late<=p_grace then 'within_grace' else 'late' end,
  greatest(x.late,0),greatest(x.late-p_grace,0),
  case when p_out is null then null else floor(extract(epoch from p_out-p_in)/60)::integer end,
  case when p_out is null then null else greatest(floor(extract(epoch from public.attendance_moment(p_day,p_end)-p_out)/60)::integer,0) end,
  case when p_out is null then null else greatest(floor(extract(epoch from p_out-public.attendance_moment(p_day,p_end))/60)::integer,0) end
 from (select floor(extract(epoch from p_in-public.attendance_moment(p_day,p_start))/60)::integer late) x
$$;
create or replace function public.attendance_record_json(p_record public.attendance_records) returns jsonb language sql stable set search_path='' as $$
 select to_jsonb(p_record)-'timezone'
$$;

-- One row per employee per day with the derived state. Reports, the
-- register and personal history all read from here, so they always agree.
-- States: checked_in, checked_out, incomplete, absent, not_checked_in (today
-- before the shift ends), leave, holiday, day_off, upcoming, not_employed,
-- not_tracked.
create or replace function public.attendance_days(p_from date,p_to date,p_user uuid,p_now timestamptz)
returns table(user_id uuid,day date,tracked boolean,eligible boolean,scheduled boolean,holiday text,leave_type text,record_id uuid,
 check_in_at timestamptz,check_out_at timestamptz,state text,punctuality text,late_minutes integer,beyond_grace_minutes integer,
 worked_minutes integer,early_departure_minutes integer,overtime_minutes integer,corrected boolean,shift_start time,shift_end time,
 pending_correction boolean)
language sql stable security definer set search_path='' as $$
 with today as (select public.attendance_local_date(p_now) d),
 people as (
  select p.id from public.profiles p
  where (p_user is null or p.id=p_user) and p.role in ('admin','agent')
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
  left join lateral (select * from public.attendance_policies a where a.effective_from<=dd.d and (a.effective_to is null or a.effective_to>=dd.d) limit 1) pol on true
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
-- Totals per employee over a range. Attendance % = present ÷ eligible × 100.
-- Eligible days are scheduled, elapsed working days that are not holidays or
-- approved leave: present + incomplete + absent. Incomplete days count
-- against the percentage until a correction is approved; today before the
-- shift ends is not counted.
create or replace function public.attendance_totals(p_from date,p_to date,p_user uuid,p_now timestamptz)
returns table(user_id uuid,scheduled_days integer,eligible_days integer,present_days integer,absent_days integer,leave_days integer,
 holiday_days integer,incomplete_days integer,on_time_days integer,within_grace_days integer,late_days integer,completed_days integer,
 worked_minutes integer,early_departure_days integer,early_departure_minutes integer,overtime_minutes integer,attendance_percent numeric)
language sql stable security definer set search_path='' as $$
 select d.user_id,
  (count(*) filter(where d.scheduled and d.state<>'upcoming'))::integer,
  (count(*) filter(where d.state in ('checked_out','checked_in','incomplete','absent')))::integer,
  (count(*) filter(where d.state in ('checked_out','checked_in')))::integer,
  (count(*) filter(where d.state='absent'))::integer,
  (count(*) filter(where d.state='leave'))::integer,
  (count(*) filter(where d.state='holiday'))::integer,
  (count(*) filter(where d.state='incomplete'))::integer,
  (count(*) filter(where d.punctuality='on_time'))::integer,
  (count(*) filter(where d.punctuality='within_grace'))::integer,
  (count(*) filter(where d.punctuality='late'))::integer,
  (count(*) filter(where d.state='checked_out'))::integer,
  coalesce(sum(d.worked_minutes) filter(where d.state='checked_out'),0)::integer,
  (count(*) filter(where d.early_departure_minutes>0))::integer,
  coalesce(sum(d.early_departure_minutes),0)::integer,
  coalesce(sum(d.overtime_minutes),0)::integer,
  case when count(*) filter(where d.state in ('checked_out','checked_in','incomplete','absent'))>0 then
   round(100.0*count(*) filter(where d.state in ('checked_out','checked_in'))/count(*) filter(where d.state in ('checked_out','checked_in','incomplete','absent')),1) end
 from public.attendance_days(p_from,p_to,p_user,p_now) d
 group by d.user_id
$$;

-- ------------------------------------------------- check-in and check-out
-- The *_at forms take the moment explicitly for tests; only the database
-- owner can call them. The API calls the now() forms.
create or replace function public.attendance_check_in_at(p_actor uuid,p_at timestamptz,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);day date=public.attendance_local_date(p_at);pol public.attendance_policies;
 holiday text;result public.attendance_records;calc record;closed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 pol=public.attendance_policy_on(day);
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
create or replace function public.attendance_check_out_at(p_actor uuid,p_at timestamptz,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);day date=public.attendance_local_date(p_at);rec public.attendance_records;calc record;
begin
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 select * into rec from public.attendance_records where user_id=p_actor and attendance_date=day for update;
 if not found then
  if exists(select 1 from public.attendance_records where user_id=p_actor and state='checked_in' and attendance_date<day) then
   raise exception 'Your last check-in was never closed. Request a correction for that day, then check in for today.' using errcode='HA409';end if;
  raise exception 'You have not checked in today' using errcode='HA409';
 end if;
 if rec.state<>'checked_in' then raise exception 'You have already checked out today' using errcode='HA409';end if;
 if p_at<=rec.check_in_at then raise exception 'Check-out must be after check-in' using errcode='HA409';end if;
 select * into calc from public.attendance_compute(rec.attendance_date,rec.shift_start,rec.shift_end,rec.grace_minutes,rec.check_in_at,p_at);
 update public.attendance_records set check_out_at=p_at,state='checked_out',worked_minutes=calc.worked_minutes,
  early_departure_minutes=calc.early_departure_minutes,overtime_minutes=calc.overtime_minutes
 where id=rec.id returning * into rec;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.check_out','attendance_records',rec.id::text,p_request,
   jsonb_build_object('date',rec.attendance_date,'worked_minutes',calc.worked_minutes,'early_departure_minutes',calc.early_departure_minutes,'overtime_minutes',calc.overtime_minutes));
 return public.attendance_record_json(rec);
end $$;
create or replace function public.attendance_check_in(p_actor uuid,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.attendance_check_in_at(p_actor,now(),p_request)
$$;
create or replace function public.attendance_check_out(p_actor uuid,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.attendance_check_out_at(p_actor,now(),p_request)
$$;

-- ------------------------------------------------ personal attendance view
create or replace function public.attendance_me(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(now());pol public.attendance_policies=public.attendance_policy_on(today);
 month_start date=date_trunc('month',today)::date;result jsonb;
begin
 select jsonb_build_object(
  'server_now',now(),'date',today,
  'employee',jsonb_build_object('id',actor.id,'name',actor.name,'uid',actor.uid,'role',actor.role),
  'policy',case when pol.id is null then null else jsonb_build_object('name',pol.name,'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),
   'work_days',to_jsonb(pol.work_days),'grace_minutes',pol.grace_minutes,'timezone',pol.timezone) end,
  'today',(select to_jsonb(d) from public.attendance_days(today,today,p_actor,now()) d),
  'month',(select to_jsonb(t)-'user_id' from public.attendance_totals(month_start,today,p_actor,now()) t),
  'recent',(select coalesce(jsonb_agg(to_jsonb(d)-'user_id' order by d.day desc),'[]'::jsonb) from public.attendance_days(today-13,today,p_actor,now()) d where d.state not in ('not_tracked','not_employed')),
  'incomplete',(select coalesce(jsonb_agg(jsonb_build_object('date',d.day,'check_in_at',d.check_in_at,'pending_correction',d.pending_correction) order by d.day desc),'[]'::jsonb)
   from public.attendance_days(today-45,today-1,p_actor,now()) d where d.state='incomplete'),
  'pending_leave',(select count(*) from public.attendance_leave_requests where user_id=p_actor and status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where user_id=p_actor and status='pending')) into result;
 return result;
end $$;
-- History for one employee: themselves, or anyone for an administrator.
create or replace function public.attendance_employee(p_actor uuid,p_user uuid,p_from date,p_to date) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);person public.profiles;result jsonb;
begin
 if actor.role<>'admin' and p_user is distinct from p_actor then raise exception 'You can only view your own attendance' using errcode='HA403';end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>400 then raise exception 'Choose a date range of up to 400 days' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and role in ('admin','agent');
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 select jsonb_build_object(
  'employee',jsonb_build_object('id',person.id,'name',person.name,'uid',person.uid,'role',person.role,'active',person.active and person.deleted_at is null,
   'periods',(select coalesce(jsonb_agg(jsonb_build_object('starts_on',starts_on,'ends_on',ends_on) order by starts_on),'[]'::jsonb) from public.attendance_periods where user_id=person.id)),
  'from',p_from,'to',p_to,
  'totals',(select to_jsonb(t)-'user_id' from public.attendance_totals(p_from,p_to,p_user,now()) t),
  'days',(select coalesce(jsonb_agg(to_jsonb(d)-'user_id' order by d.day desc),'[]'::jsonb) from public.attendance_days(p_from,p_to,p_user,now()) d where d.state not in ('not_tracked','upcoming')),
  'leave',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc),'[]'::jsonb) from (select * from public.attendance_leave_requests where user_id=p_user order by created_at desc limit 50) l),
  'corrections',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc),'[]'::jsonb) from (select * from public.attendance_corrections where user_id=p_user order by created_at desc limit 50) c))
 into result;
 return result;
end $$;

-- ------------------------------------------------------------ leave
create or replace function public.attendance_notify_admins(p_except uuid,p_type text,p_group text,p_title text,p_body text,p_link text) returns void language plpgsql security definer set search_path='' as $$
declare a uuid;
begin
 for a in select id from public.profiles where role='admin' and active and deleted_at is null and id<>p_except loop
  perform public.push_notification(a,p_type,p_group,p_title,p_body,p_link,null);
 end loop;
end $$;
create or replace function public.attendance_leave_request(p_actor uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(now());s date;e date;result public.attendance_leave_requests;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['leave_type','start_date','end_date','reason'])<>'{}'::jsonb then
  raise exception 'Invalid leave request' using errcode='HA400';end if;
 s=(p_data->>'start_date')::date;e=(p_data->>'end_date')::date;
 if s is null or e is null or s>e then raise exception 'The leave must end on or after its start date' using errcode='HA400';end if;
 if e-s>30 then raise exception 'Request at most 31 days at a time' using errcode='HA400';end if;
 if s<today-30 or e>today+365 then raise exception 'Leave must start within the last 30 days and end within a year' using errcode='HA400';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 if exists(select 1 from public.attendance_leave_requests where user_id=p_actor and status in ('pending','approved') and start_date<=e and end_date>=s) then
  raise exception 'You already have a pending or approved leave request for some of these dates' using errcode='HA409';end if;
 insert into public.attendance_leave_requests(user_id,leave_type,start_date,end_date,reason)
 values(p_actor,p_data->>'leave_type',s,e,btrim(p_data->>'reason')) returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.leave_requested','attendance_leave_requests',result.id::text,p_request,
   jsonb_build_object('leave_type',result.leave_type,'start_date',s,'end_date',e));
 perform public.attendance_notify_admins(p_actor,'attendance_request','leave:'||result.id,'Leave request: '||actor.name,
  initcap(result.leave_type)||' leave '||to_char(s,'DD Mon')||case when e>s then ' – '||to_char(e,'DD Mon') else '' end||'. Approve or reject it in Attendance management.',
  '/attendance-management?tab=leave');
 return to_jsonb(result);
end $$;
create or replace function public.attendance_leave_cancel(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);result public.attendance_leave_requests;
begin
 select * into result from public.attendance_leave_requests where id=p_id and user_id=p_actor for update;
 if not found then raise exception 'Leave request not found' using errcode='HA404';end if;
 if result.status<>'pending' then raise exception 'Only a pending request can be cancelled' using errcode='HA409';end if;
 update public.attendance_leave_requests set status='cancelled' where id=p_id returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.leave_cancelled','attendance_leave_requests',p_id::text,p_request,'{}'::jsonb);
 return to_jsonb(result);
end $$;
create or replace function public.attendance_leave_review(p_actor uuid,p_id uuid,p_decision text,p_note text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);item public.attendance_leave_requests;
begin
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject' using errcode='HA400';end if;
 if p_note is not null and length(p_note)>300 then raise exception 'Use a review note of 300 characters or fewer' using errcode='HA400';end if;
 select * into item from public.attendance_leave_requests where id=p_id for update;
 if not found then raise exception 'Leave request not found' using errcode='HA404';end if;
 if item.user_id=p_actor then raise exception 'You cannot review your own leave request. Another administrator must review it.' using errcode='HA403';end if;
 if item.status<>'pending' then raise exception 'This request has already been reviewed' using errcode='HA409';end if;
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||item.user_id,40));
 if p_decision='approved' and exists(select 1 from public.attendance_leave_requests where user_id=item.user_id and id<>item.id and status='approved'
  and start_date<=item.end_date and end_date>=item.start_date) then
  raise exception 'These dates overlap leave that is already approved' using errcode='HA409';end if;
 update public.attendance_leave_requests set status=p_decision,reviewer_id=p_actor,review_note=nullif(btrim(p_note),''),reviewed_at=now()
 where id=p_id returning * into item;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.leave_'||p_decision,'attendance_leave_requests',p_id::text,p_request,
   jsonb_build_object('user_id',item.user_id,'start_date',item.start_date,'end_date',item.end_date,'leave_type',item.leave_type));
 perform public.push_notification(item.user_id,'attendance_review','leave:'||item.id,
  case when p_decision='approved' then 'Leave approved' else 'Leave not approved' end,
  initcap(item.leave_type)||' leave '||to_char(item.start_date,'DD Mon')||case when item.end_date>item.start_date then ' – '||to_char(item.end_date,'DD Mon') else '' end||
  coalesce('. Note: '||item.review_note,'.'),'/attendance',null);
 return to_jsonb(item);
end $$;
create or replace function public.attendance_leave_page(p_actor uuid,p_mine boolean,p_status text,p_user uuid,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);scope uuid;result jsonb;
begin
 if (p_status is not null and p_status not in ('pending','approved','rejected','cancelled')) or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid filter' using errcode='HA400';end if;
 scope=case when actor.role<>'admin' or coalesce(p_mine,false) then p_actor else p_user end;
 with visible as (
  select l.*,p.name employee_name,p.uid employee_uid,p.role employee_role,r.name reviewer_name
  from public.attendance_leave_requests l join public.profiles p on p.id=l.user_id left join public.profiles r on r.id=l.reviewer_id
  where (scope is null or l.user_id=scope) and (p_status is null or l.status=p_status)
 ), page as (select * from visible order by case status when 'pending' then 0 else 1 end,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by case status when 'pending' then 0 else 1 end,created_at desc,id) from page),'[]'::jsonb),
  'count',(select count(*) from visible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;

-- ------------------------------------------------------ corrections
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
 pol=public.attendance_policy_on(day);
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
create or replace function public.attendance_correction_cancel(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);result public.attendance_corrections;
begin
 select * into result from public.attendance_corrections where id=p_id and user_id=p_actor for update;
 if not found then raise exception 'Correction request not found' using errcode='HA404';end if;
 if result.status<>'pending' then raise exception 'Only a pending request can be cancelled' using errcode='HA409';end if;
 update public.attendance_corrections set status='cancelled' where id=p_id returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.correction_cancelled','attendance_corrections',p_id::text,p_request,'{}'::jsonb);
 return to_jsonb(result);
end $$;
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
   pol=public.attendance_policy_on(item.attendance_date);
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
create or replace function public.attendance_correction_page(p_actor uuid,p_mine boolean,p_status text,p_user uuid,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);scope uuid;result jsonb;
begin
 if (p_status is not null and p_status not in ('pending','approved','rejected','cancelled')) or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid filter' using errcode='HA400';end if;
 scope=case when actor.role<>'admin' or coalesce(p_mine,false) then p_actor else p_user end;
 with visible as (
  select c.*,p.name employee_name,p.uid employee_uid,p.role employee_role,r.name reviewer_name
  from public.attendance_corrections c join public.profiles p on p.id=c.user_id left join public.profiles r on r.id=c.reviewer_id
  where (scope is null or c.user_id=scope) and (p_status is null or c.status=p_status)
 ), page as (select * from visible order by case status when 'pending' then 0 else 1 end,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by case status when 'pending' then 0 else 1 end,created_at desc,id) from page),'[]'::jsonb),
  'count',(select count(*) from visible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;

-- ------------------------------------------------- admin views and reports
create or replace function public.attendance_overview(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());pol public.attendance_policies=public.attendance_policy_on(today);result jsonb;
begin
 with d as (select * from public.attendance_days(today,today,null,now()) where eligible or record_id is not null)
 select jsonb_build_object('date',today,'server_now',now(),
  'is_workday',pol.id is not null and extract(isodow from today)::smallint=any(pol.work_days),
  'holiday',(select name from public.attendance_holidays where holiday_date=today),
  'shift_start',to_char(pol.shift_start,'HH24:MI'),'shift_end',to_char(pol.shift_end,'HH24:MI'),'grace_minutes',pol.grace_minutes,
  'employees',jsonb_build_object(
   'active',(select count(*) from public.profiles where active and deleted_at is null and role in ('admin','agent')),
   'agents',(select count(*) from public.profiles where active and deleted_at is null and role='agent'),
   'admins',(select count(*) from public.profiles where active and deleted_at is null and role='admin')),
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
-- The full register for one date: every employee eligible that day (or with
-- a record), never only those who checked in.
create or replace function public.attendance_daily(p_actor uuid,p_date date,p_search text,p_role text,p_state text,p_punctuality text,p_account text,p_page integer,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);term text=nullif(btrim(coalesce(p_search,'')),'');result jsonb;
begin
 if p_date is null or p_page not between 1 and 100000 or p_limit not between 1 and 1000 or length(coalesce(p_search,''))>100
  or (p_role is not null and p_role not in ('admin','agent')) or (p_account is not null and p_account not in ('active','inactive')) then
  raise exception 'Invalid register filter' using errcode='HA400';end if;
 with rows as (
  select d.*,p.name,p.uid,p.role,(p.active and p.deleted_at is null) account_active
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
-- Weekly and monthly reports: totals per employee, each day's state, and a
-- per-day trend for charts. Totals come from the same daily rows.
create or replace function public.attendance_period(p_actor uuid,p_from date,p_to date,p_search text,p_role text,p_account text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);term text=nullif(btrim(coalesce(p_search,'')),'');result jsonb;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or length(coalesce(p_search,''))>100
  or (p_role is not null and p_role not in ('admin','agent')) or (p_account is not null and p_account not in ('active','inactive')) then
  raise exception 'Choose a range of up to 31 days' using errcode='HA400';end if;
 with people as (
  select p.id,p.name,p.uid,p.role,(p.active and p.deleted_at is null) account_active from public.profiles p
  where p.role in ('admin','agent') and (term is null or p.name ilike '%'||term||'%' or p.uid::text=term)
   and (p_role is null or p.role=p_role) and (p_account is null or (p.active and p.deleted_at is null)=(p_account='active'))
 ), days as (select d.* from public.attendance_days(p_from,p_to,null,now()) d join people pe on pe.id=d.user_id),
 totals as (select t.* from public.attendance_totals(p_from,p_to,null,now()) t join people pe on pe.id=t.user_id)
 select jsonb_build_object('from',p_from,'to',p_to,
  'employees',coalesce((select jsonb_agg(jsonb_build_object('user_id',pe.id,'name',pe.name,'uid',pe.uid,'role',pe.role,'active',pe.account_active)
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
create or replace function public.attendance_employees(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'role',p.role,'active',p.active and p.deleted_at is null) order by p.name,p.id),'[]'::jsonb)
  from public.profiles p where p.role in ('admin','agent')
   and (exists(select 1 from public.attendance_periods e where e.user_id=p.id) or exists(select 1 from public.attendance_records r where r.user_id=p.id)));
end $$;

-- --------------------------------------------- holidays and settings
create or replace function public.attendance_holidays_list(p_actor uuid,p_year integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);
begin
 if p_year is null or p_year not between 2000 and 2100 then raise exception 'Choose a year' using errcode='HA400';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'holiday_date',h.holiday_date,'name',h.name,'description',h.description,'created_by_name',p.name) order by h.holiday_date),'[]'::jsonb)
  from public.attendance_holidays h left join public.profiles p on p.id=h.created_by where extract(year from h.holiday_date)=p_year);
end $$;
create or replace function public.attendance_holiday_save(p_actor uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);result public.attendance_holidays;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['holiday_date','name','description'])<>'{}'::jsonb or (p_data->>'holiday_date') is null then
  raise exception 'Invalid holiday' using errcode='HA400';end if;
 if exists(select 1 from public.attendance_holidays where holiday_date=(p_data->>'holiday_date')::date) then
  raise exception 'A holiday already exists on that date' using errcode='HA409';end if;
 insert into public.attendance_holidays(holiday_date,name,description,created_by)
 values((p_data->>'holiday_date')::date,btrim(p_data->>'name'),nullif(btrim(coalesce(p_data->>'description','')),''),p_actor) returning * into result;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.holiday_added','attendance_holidays',result.id::text,p_request,jsonb_build_object('date',result.holiday_date));
 return to_jsonb(result);
end $$;
create or replace function public.attendance_holiday_delete(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);result public.attendance_holidays;
begin
 delete from public.attendance_holidays where id=p_id returning * into result;
 if not found then raise exception 'Holiday not found' using errcode='HA404';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.holiday_removed','attendance_holidays',p_id::text,p_request,jsonb_build_object('date',result.holiday_date,'name',result.name));
 return to_jsonb(result);
end $$;
create or replace function public.attendance_policies_list(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());
begin
 return jsonb_build_object('today',today,'tracking_started',(select min(effective_from) from public.attendance_policies),
  'current',(select to_jsonb(p) from public.attendance_policies p where p.effective_from<=today and (p.effective_to is null or p.effective_to>=today)),
  'versions',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('records',(select count(*) from public.attendance_records r where r.policy_id=p.id)) order by p.effective_from desc),'[]'::jsonb)
   from public.attendance_policies p));
end $$;
-- A change takes effect from a chosen date (today or later). Earlier days
-- keep the rules they were recorded under.
create or replace function public.attendance_policy_save(p_actor uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(now());starts date;existing public.attendance_policies;
 days smallint[];result public.attendance_policies;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['name','shift_start','shift_end','work_days','grace_minutes','effective_from'])<>'{}'::jsonb
  or jsonb_typeof(p_data->'work_days') is distinct from 'array'
  or exists(select 1 from jsonb_array_elements(p_data->'work_days') d where d::text not in ('1','2','3','4','5','6','7')) then
  raise exception 'Invalid attendance settings' using errcode='HA400';end if;
 starts=(p_data->>'effective_from')::date;
 if starts is null or starts<today or starts>today+365 then raise exception 'Changes can start today or on a later date within a year' using errcode='HA400';end if;
 select array_agg(distinct d::smallint order by d::smallint) into days from jsonb_array_elements_text(p_data->'work_days') d;
 perform pg_advisory_xact_lock(873440);
 if exists(select 1 from public.attendance_policies where effective_from>starts) then
  raise exception 'A later change is already scheduled. Edit that one instead.' using errcode='HA409';end if;
 select * into existing from public.attendance_policies where effective_from=starts for update;
 if existing.id is not null then
  if exists(select 1 from public.attendance_records where policy_id=existing.id) then
   raise exception 'Attendance has already been recorded under the rules starting that day. Choose a later date.' using errcode='HA409';end if;
  update public.attendance_policies set name=btrim(p_data->>'name'),shift_start=(p_data->>'shift_start')::time,shift_end=(p_data->>'shift_end')::time,
   work_days=days,grace_minutes=(p_data->>'grace_minutes')::integer,created_by=p_actor where id=existing.id returning * into result;
 else
  update public.attendance_policies set effective_to=starts-1 where effective_from<starts and (effective_to is null or effective_to>=starts);
  insert into public.attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from,created_by)
  values(btrim(p_data->>'name'),(p_data->>'shift_start')::time,(p_data->>'shift_end')::time,days,(p_data->>'grace_minutes')::integer,starts,p_actor)
  returning * into result;
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.policy_saved','attendance_policies',result.id::text,p_request,
   jsonb_build_object('effective_from',starts,'fields',jsonb_build_array('name','shift_start','shift_end','work_days','grace_minutes')));
 return to_jsonb(result);
end $$;

-- ------------------------------------------- background reconciliation
-- Idempotent: closes sessions left open on earlier days as incomplete
-- (without inventing a check-out), tells the employee once, and sends the
-- admins one attendance summary after the shift on a working day.
create or replace function public.attendance_reconcile(p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare today date=public.attendance_local_date(p_now);pol public.attendance_policies=public.attendance_policy_on(today);item record;closed integer=0;sent integer=0;
 present integer;late integer;absent integer;leave integer;late_names text;absent_names text;
begin
 if not pg_try_advisory_xact_lock(hashtext('hd_job_attendance')) then return '{"skipped":true}'::jsonb;end if;
 for item in update public.attendance_records r set state='incomplete' where r.state='checked_in' and r.attendance_date<today
  returning r.id,r.user_id,r.attendance_date,r.check_in_at loop
  closed=closed+1;
  perform public.push_notification(item.user_id,'attendance_incomplete','att:'||item.id,'Check-out missing for '||to_char(item.attendance_date,'Dy DD Mon'),
   'You checked in at '||to_char(item.check_in_at at time zone 'Asia/Karachi','HH12:MI AM')||' but never checked out. Request a correction so the day counts.','/attendance',null);
  insert into public.audit_log(action,entity,entity_id,request_id,metadata)
   values('attendance.marked_incomplete','attendance_records',item.id::text,'job:attendance',jsonb_build_object('user_id',item.user_id,'date',item.attendance_date));
 end loop;
 if pol.id is not null and extract(isodow from today)::smallint=any(pol.work_days)
  and not exists(select 1 from public.attendance_holidays where holiday_date=today)
  and p_now>=public.attendance_moment(today,pol.shift_end) then
  select count(*) filter(where d.state in ('checked_out','checked_in')),count(*) filter(where d.punctuality='late'),count(*) filter(where d.state='absent'),
   count(*) filter(where d.state='leave'),
   string_agg(p.name||' ('||d.late_minutes||' min)',', ' order by p.name) filter(where d.punctuality='late'),
   string_agg(p.name,', ' order by p.name) filter(where d.state='absent')
   into present,late,absent,leave,late_names,absent_names
  from public.attendance_days(today,today,null,p_now) d join public.profiles p on p.id=d.user_id where d.eligible;
  if present+absent+leave>0 then
   insert into public.notifications(user_id,type,group_key,title,body,link,item_count)
   select a.id,'attendance_summary','day:'||today,format('Today''s attendance: %s present, %s absent',present,absent),
    left(concat_ws(' · ',case when late>0 then 'Late: '||late_names end,case when absent>0 then 'Absent: '||absent_names end,
     case when leave>0 then leave||' on leave' end,'Open Attendance management for details.'),500),'/attendance-management',greatest(present,1)
   from public.profiles a where a.role='admin' and a.active and a.deleted_at is null
   on conflict(user_id,type,group_key) do nothing;
   get diagnostics sent=row_count;
  end if;
 end if;
 return jsonb_build_object('affected',closed,'summaries',sent);
end $$;
do $$ begin
 if to_regprocedure('public.run_crm_job_039(text,jsonb)') is null then
  alter function public.run_crm_job(text,jsonb) rename to run_crm_job_039;
 end if;
end $$;
create or replace function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_job='attendance' then return public.attendance_reconcile(now());end if;
 return public.run_crm_job_039(p_job,p_settings);
end $$;
alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
alter table public.job_heartbeats add constraint job_heartbeats_job_check check(job in('deleteOldRecordings','reportInactiveLeadOwners','leadResponseCheck','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads','attendanceReconciliation'));
create or replace function public.system_status(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;fresh boolean;version integer;backup jsonb;last_run timestamptz;
begin
 perform id from public.profiles where id=p_actor and active and role='admin' for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 select max(v.version) into version from public.crm_schema_versions v;
 select jsonb_agg(jsonb_build_object('job',expected.job,'status',case when h.job is null then 'not_started' when h.last_run_at<=now()-interval '5 minutes' then 'stale' else h.last_status end,'last_success_at',h.last_success_at,'last_error_at',h.last_error_at,'last_run_at',h.last_run_at)),
 bool_and(h.job is not null and h.last_status='success' and h.last_run_at>now()-interval '5 minutes'),case when count(h.job)=9 then min(h.last_run_at) end
 into rows,fresh,last_run
 from unnest(array['deleteOldRecordings','reportInactiveLeadOwners','leadResponseCheck','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads','attendanceReconciliation']) expected(job)
 left join public.job_heartbeats h on h.job=expected.job;
 select jsonb_build_object('last_success_at',(select max(created_at) from public.backups where status='success'),
 'last_run_at',(select max(created_at) from public.backups),
 'status',coalesce((select status from public.backups order by created_at desc,id desc limit 1),'not_started')) into backup;
 return jsonb_build_object('ready',version=26 and coalesce(fresh,false),'migration',case when version=26 then 'current' else 'update_required' end,
 'installed_version',version,'jobs',rows,'last_job_at',last_run,'backup',backup);
end $$;

-- Browser roles get nothing. The API calls the service-role functions; the
-- explicit-time forms are for the database owner and tests only.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
 ('guard_attendance_policy','attendance_local_date','attendance_moment','attendance_policy_on','track_attendance_period','attendance_member','attendance_admin',
  'attendance_compute','attendance_record_json','attendance_days','attendance_totals','attendance_check_in_at','attendance_check_out_at','attendance_check_in',
  'attendance_check_out','attendance_me','attendance_employee','attendance_notify_admins','attendance_leave_request','attendance_leave_cancel',
  'attendance_leave_review','attendance_leave_page','attendance_correction_request','attendance_correction_cancel','attendance_correction_review',
  'attendance_correction_page','attendance_overview','attendance_daily','attendance_period','attendance_employees','attendance_holidays_list',
  'attendance_holiday_save','attendance_holiday_delete','attendance_policies_list','attendance_policy_save','attendance_reconcile','run_crm_job',
  'run_crm_job_039','system_status') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname not in ('attendance_check_in_at','attendance_check_out_at') then
   execute format('grant execute on function %s to service_role',f.signature);
  else
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
