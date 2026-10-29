-- Apply after 041. Safe to rerun. Administrator attendance entries (update
-- 042): an administrator can enter or correct another employee's attendance
-- for earlier days, one day or up to 31 at a time, for example the days
-- before the CRM started tracking attendance. The attendance model of 040 is
-- unchanged:
-- * a worked day (present, late or a half day) is an attendance record with a
--   check-in and check-out; punctuality and durations come from
--   attendance_compute under that day's rules, and the record is marked
--   corrected;
-- * an absence is still never stored: it is a scheduled working day in the
--   employee's attendance period with no record, holiday or approved leave;
-- * leave is an approved one-day leave row that names the administrator who
--   recorded it.
-- A day before the employee's own attendance start counts only once it is
-- entered: it gets an attendance period of its own, marked with the
-- administrator who entered it. Days nobody entered stay uncounted and never
-- become absences. Entering a day before tracking began also moves the first
-- rules' start back, so the day counts under the same rules; employees whose
-- attendance starts later are unaffected. An entered day can be removed
-- again. Every change is audited with the values before and after. Nothing
-- notifies anyone: these are earlier days, not today's live attendance.
-- Installing this update changes no existing attendance, leave, correction,
-- period or rule; it only adds two empty columns and new functions.
-- Errors raised here use SQLSTATE HA<http status> (HA400, HA403, HA404,
-- HA409) with messages that are safe to show to the signed-in user.
begin;
do $$ begin
 if to_regprocedure('public.attendance_compute(date,time,time,integer,timestamptz,timestamptz)') is null then
  raise exception 'Apply CRM update 040 (attendance) before update 042.';
 end if;
end $$;

-- Leave an administrator recorded directly, rather than one an employee
-- requested. Only such leave can later be changed or removed here.
alter table public.attendance_leave_requests add column if not exists recorded_by uuid references public.profiles(id);
alter table public.attendance_leave_requests drop constraint if exists attendance_leave_recorded;
alter table public.attendance_leave_requests add constraint attendance_leave_recorded
 check(recorded_by is null or (status='approved' and reviewer_id=recorded_by));
-- Attendance periods an administrator entered for earlier days (always
-- closed). Periods opened and closed with the account keep recorded_by null.
alter table public.attendance_periods add column if not exists recorded_by uuid references public.profiles(id);
alter table public.attendance_periods drop constraint if exists attendance_periods_recorded;
alter table public.attendance_periods add constraint attendance_periods_recorded check(recorded_by is null or ends_on is not null);

-- The rules for a day: the version in force, or for a day before tracking
-- began, the first version (which an entry would extend back to that day).
create or replace function public.attendance_admin_rules(p_day date) returns public.attendance_policies language sql stable security definer set search_path='' as $$
 select * from (
  select * from public.attendance_policies a where a.effective_from<=p_day and (a.effective_to is null or a.effective_to>=p_day)
  union all
  select * from (select * from public.attendance_policies order by effective_from limit 1) f where p_day<f.effective_from
 ) r limit 1
$$;

-- Keeps entered periods tidy: drops one that counts no working day (left by a
-- removal), and joins entered periods separated only by days off or holidays,
-- running the last one up to the next period, so a weekend between entered
-- weeks shows as a day off rather than outside attendance.
create or replace function public.attendance_admin_tidy(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.attendance_periods;b public.attendance_periods;changed boolean;
begin
 delete from public.attendance_periods e where e.user_id=p_user and e.recorded_by is not null and not exists(
  select 1 from generate_series(e.starts_on::timestamp,e.ends_on::timestamp,interval '1 day') g
  where extract(isodow from g::date)::smallint=any((public.attendance_admin_rules(g::date)).work_days)
   and not exists(select 1 from public.attendance_holidays h where h.holiday_date=g::date));
 loop
  changed=false;a=null;
  for b in select * from public.attendance_periods where user_id=p_user order by starts_on loop
   if a.recorded_by is not null and b.starts_on>a.ends_on and not exists(
    select 1 from generate_series((a.ends_on+1)::timestamp,(b.starts_on-1)::timestamp,interval '1 day') g
    where extract(isodow from g::date)::smallint=any((public.attendance_admin_rules(g::date)).work_days)
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

-- One employee's day as an administrator sees it before changing it: the
-- derived state, record, leave, rules, whether the day is counted (and only
-- because it was entered), and the audited history of that day.
create or replace function public.attendance_admin_day_at(p_actor uuid,p_user uuid,p_day date,p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);person public.profiles;rules public.attendance_policies;
 rec public.attendance_records;lv public.attendance_leave_requests;d record;
begin
 if p_day is null then raise exception 'Choose a date' using errcode='HA400';end if;
 select * into person from public.profiles where id=p_user and role in ('admin','agent') and deleted_at is null;
 if not found then raise exception 'Employee not found' using errcode='HA404';end if;
 rules=public.attendance_admin_rules(p_day);
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

-- Plan, and unless p_dry_run apply, attendance for earlier days. Each entry is
-- {date, status: present|late|half_day|absent|leave|clear, check_in,
-- check_out ("HH:MM", Pakistan time), leave_type}; clear removes an entered
-- day so it is no longer counted. Every date gets one result: create,
-- update, unchanged, skip (existing attendance kept because p_replace is
-- false) or error (with the reason). Malformed input raises instead. The
-- dates that can be saved are saved together in this transaction.
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
 select * into person from public.profiles where id=p_user and role in ('admin','agent') and deleted_at is null for share;
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
  rules=public.attendance_admin_rules(day);
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
     rules=public.attendance_policy_on(day);
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
create or replace function public.attendance_admin_day(p_actor uuid,p_user uuid,p_day date) returns jsonb language sql security definer set search_path='' as $$
 select public.attendance_admin_day_at(p_actor,p_user,p_day,now())
$$;
create or replace function public.attendance_admin_set(p_actor uuid,p_user uuid,p_entries jsonb,p_reason text,p_replace boolean,p_dry_run boolean,p_request text)
returns jsonb language sql security definer set search_path='' as $$
 select public.attendance_admin_set_at(p_actor,p_user,p_entries,p_reason,p_replace,p_dry_run,p_request,now())
$$;

-- Browser roles get nothing. The API calls the service-role functions; the
-- explicit-time forms and the tidy helper are for the database owner only.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('attendance_admin_rules','attendance_admin_tidy','attendance_admin_day_at','attendance_admin_set_at','attendance_admin_day','attendance_admin_set') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('attendance_admin_tidy','attendance_admin_day_at','attendance_admin_set_at') then
   execute format('revoke all on function %s from service_role',f.signature);
  else
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
