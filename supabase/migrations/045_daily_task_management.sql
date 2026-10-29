-- Apply after 044. Safe to rerun. Daily tasks, end-of-day reports and
-- checkout approvals (update 045).
-- * Administrators assign tasks to one agent or to several at once; every
--   agent gets an assignment of their own, tracked independently. A task is
--   measurable (a target quantity such as 50 calls) or simple (pending, in
--   progress, completed).
-- * Agents report progress and submit one daily work report per day, with a
--   snapshot of that day's tasks. Administrators verify tasks and review
--   reports; agents can't change either afterwards.
-- * Agents can ask to check out early (every task due today done and the
--   report submitted) or, in an emergency, at any time. An administrator
--   approves or rejects; an approval lets that agent use the normal
--   check-out, for that workday only. Nobody is checked out automatically.
--   After a rejection the agent may ask again with a new explanation (never a
--   repeat of an earlier one; early requests wait 15 minutes), up to 3
--   requests of each kind a day, cancelled ones included.
-- * Reports for earlier days can be submitted for 7 days; administrators see
--   every overdue report (task_missing_reports).
-- * Checkout rules: from crm_settings.task_rules_from (empty = off, as
--   installed), an agent's check-out needs the daily report, and checking out
--   before the shift ends needs an approved request. The rules sit in
--   attendance_check_out_at itself, so no route can skip them. Days before the
--   start date and administrators are never affected.
-- Nothing here changes existing attendance, leave, corrections, notifications
-- or audit entries. Progress changes and earlier report versions are kept in
-- the append-only audit_log.
-- Errors use SQLSTATE HA<http status> with messages safe to show the user.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.attendance_check_out_at(uuid,timestamp with time zone,text)') is null
  or to_regprocedure('public.inventory_promote(uuid,uuid,uuid,text[],text)') is null then
  raise exception 'Apply CRM updates up to 044 before update 045.';
 end if;
end $$;

-- ----------------------------------------------------------------- tables
-- The date from which the checkout rules apply; empty means off.
alter table public.crm_settings add column if not exists task_rules_from date;

create table if not exists public.tasks(
 id uuid primary key default gen_random_uuid(),
 scope text not null check(scope in ('team','individual')),
 title text not null check(length(btrim(title)) between 3 and 120),
 description text check(length(description)<=1000),
 instructions text check(length(instructions)<=1000),
 category text check(category in ('calls','follow_ups','site_visits','listings','meetings','documents','other')),
 priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 kind text not null check(kind in ('measurable','simple')),
 target_quantity integer check(target_quantity between 1 and 100000),
 unit text check(length(btrim(unit)) between 1 and 30),
 task_date date not null,
 due_on date not null,
 client_key uuid not null,
 created_by uuid not null references public.profiles(id),
 updated_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 cancelled_at timestamptz,
 cancelled_by uuid references public.profiles(id),
 cancel_reason text check(length(cancel_reason)<=300),
 -- A repeated click sends the same key and gets the same task back.
 unique(created_by,client_key),
 check(due_on between task_date and task_date+31),
 check((kind='measurable')=(target_quantity is not null) and (kind='measurable')=(unit is not null)),
 check((cancelled_at is null)=(cancelled_by is null))
);
create index if not exists tasks_dates on public.tasks(due_on,task_date);

-- One row per agent per task. Progress is what the agent reported;
-- verified_* is the administrator's check and never changes the report.
create table if not exists public.task_assignments(
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.tasks(id),
 user_id uuid not null references public.profiles(id),
 status text not null default 'pending' check(status in ('pending','in_progress','completed','cancelled')),
 completed_quantity integer not null default 0 check(completed_quantity between 0 and 1000000),
 employee_note text check(length(employee_note)<=500),
 progress_at timestamptz,
 completed_at timestamptz,
 verified_status text check(verified_status in ('confirmed','adjusted','not_done')),
 verified_quantity integer check(verified_quantity between 0 and 1000000),
 verified_by uuid references public.profiles(id),
 verified_at timestamptz,
 review_note text check(length(review_note)<=500),
 cancelled_at timestamptz,
 cancelled_by uuid references public.profiles(id),
 cancel_reason text check(length(cancel_reason)<=300),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(task_id,user_id),
 check((verified_status is null)=(verified_by is null)),
 check((status='cancelled')=(cancelled_at is not null))
);
create index if not exists task_assignments_user on public.task_assignments(user_id,status);

-- One report per agent per workday. tasks is the snapshot submitted; an
-- amendment replaces it and the audit entry keeps the earlier version.
create table if not exists public.task_daily_reports(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 work_date date not null,
 status text not null default 'submitted' check(status in ('submitted','reviewed')),
 remarks text check(length(remarks)<=1000),
 tasks jsonb not null default '[]'::jsonb check(jsonb_typeof(tasks)='array'),
 task_count integer not null check(task_count>=0),
 completion_percent numeric(5,1) check(completion_percent between 0 and 100),
 submitted_at timestamptz not null default now(),
 amended_at timestamptz,
 amendment_count integer not null default 0 check(amendment_count>=0),
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 review_note text check(length(review_note)<=500),
 unique(user_id,work_date),
 check((status='reviewed')=(reviewed_by is not null))
);
create index if not exists task_daily_reports_day on public.task_daily_reports(work_date);

create table if not exists public.task_checkout_requests(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 work_date date not null,
 kind text not null check(kind in ('early','emergency')),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 reason text check(length(reason)<=500),
 requested_at timestamptz not null default now(),
 shift_end time not null,
 completion_percent numeric(5,1),
 report_submitted boolean not null,
 waive_report boolean not null default false,
 decided_by uuid references public.profiles(id),
 decided_at timestamptz,
 decision_note text check(length(decision_note)<=300),
 used_at timestamptz,
 check((status in ('approved','rejected'))=(decided_by is not null)),
 check(kind='emergency' or not waive_report),
 check(kind='early' or length(btrim(coalesce(reason,'')))>=5),
 check(used_at is null or status='approved')
);
-- One waiting request, and at most one approval, per agent per workday.
create unique index if not exists task_checkout_one_pending on public.task_checkout_requests(user_id,work_date) where status='pending';
create unique index if not exists task_checkout_one_approved on public.task_checkout_requests(user_id,work_date) where status='approved';
create index if not exists task_checkout_queue on public.task_checkout_requests(status,requested_at desc);

do $$ declare t text; begin
 foreach t in array array['tasks','task_assignments','task_daily_reports','task_checkout_requests'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
-- The touch_updated trigger (010) keeps updated_at current.
drop trigger if exists touch_updated on public.tasks;
create trigger touch_updated before update on public.tasks for each row execute function public.touch_updated();
drop trigger if exists touch_updated on public.task_assignments;
create trigger touch_updated before update on public.task_assignments for each row execute function public.touch_updated();

-- Notification types for tasks and checkout requests.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary',
 'property_source_updated','property_source_removed',
 'task_assigned','task_updated','task_cancelled','task_report','task_report_reviewed','checkout_request','checkout_decision'));

-- ------------------------------------------------------- shared helpers
create or replace function public.task_rules_on(p_day date) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select task_rules_from<=p_day from public.crm_settings where id),false)
$$;
create or replace function public.task_day_text(p_day date) returns text language sql immutable set search_path='' as $$
 select to_char(p_day,'FMMonth FMDD, YYYY')
$$;
create or replace function public.task_time_text(p_at timestamptz) returns text language sql stable set search_path='' as $$
 select to_char(p_at at time zone 'Asia/Karachi','FMHH12:MI AM')
$$;
-- A task's completion: measurable tasks by quantity (shown up to 100%),
-- simple tasks 100% when completed and 0% otherwise. Cancelled: none.
create or replace function public.task_percent(p_kind text,p_target integer,p_quantity integer,p_status text) returns numeric language sql immutable set search_path='' as $$
 select case when p_status='cancelled' then null
  when p_kind='measurable' then least(100,round(p_quantity*100.0/p_target,1))
  when p_status='completed' then 100.0 else 0.0 end
$$;
-- Status follows the quantity for measurable tasks.
create or replace function public.task_status_for(p_target integer,p_quantity integer) returns text language sql immutable set search_path='' as $$
 select case when p_quantity>=p_target then 'completed' when p_quantity>0 then 'in_progress' else 'pending' end
$$;
create or replace function public.task_assignment_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',a.id,'task_id',t.id,'scope',t.scope,'title',t.title,'description',t.description,'instructions',t.instructions,
  'category',t.category,'priority',t.priority,'kind',t.kind,'target_quantity',t.target_quantity,'unit',t.unit,'task_date',t.task_date,'due_on',t.due_on,
  'assigned_by',(select name from public.profiles where id=t.created_by),'assigned_at',t.created_at,
  'status',a.status,'completed_quantity',a.completed_quantity,
  'remaining_quantity',case when t.kind='measurable' then greatest(t.target_quantity-a.completed_quantity,0) end,
  'excess_quantity',case when t.kind='measurable' then greatest(a.completed_quantity-t.target_quantity,0) end,
  'percent',public.task_percent(t.kind,t.target_quantity,a.completed_quantity,a.status),
  'employee_note',a.employee_note,'progress_at',a.progress_at,'completed_at',a.completed_at,
  'verified_status',a.verified_status,'verified_quantity',a.verified_quantity,
  'verified_percent',case when a.verified_status is null then null when a.verified_status='not_done' then 0.0
   when t.kind='measurable' then least(100,round(coalesce(a.verified_quantity,a.completed_quantity)*100.0/t.target_quantity,1)) else 100.0 end,
  'verified_by_name',(select name from public.profiles where id=a.verified_by),'verified_at',a.verified_at,'review_note',a.review_note,
  'cancel_reason',coalesce(a.cancel_reason,t.cancel_reason),
  'user_id',a.user_id,'user_name',p.name,'user_uid',p.uid,'user_active',p.active and p.deleted_at is null)
 from public.task_assignments a join public.tasks t on t.id=a.task_id join public.profiles p on p.id=a.user_id where a.id=p_id
$$;
-- One agent's tasks on a day: those running that day (task date to due
-- date), plus earlier tasks still open (overdue).
create or replace function public.task_day(p_user uuid,p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 with a as (select x.status,t.kind,t.target_quantity,x.completed_quantity,t.due_on from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.user_id=p_user and x.status<>'cancelled' and t.task_date<=p_day and t.due_on>=p_day),
  o as (select count(*) n from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.user_id=p_user and x.status not in ('completed','cancelled') and t.due_on<p_day)
 select jsonb_build_object('task_count',(select count(*) from a),'completed',(select count(*) from a where status='completed'),
  'due_count',(select count(*) from a where due_on=p_day),'due_completed',(select count(*) from a where due_on=p_day and status='completed'),
  'overdue',(select n from o),
  'completion_percent',(select round(avg(public.task_percent(kind,target_quantity,completed_quantity,status)),1) from a),
  'all_due_completed',coalesce((select count(*)>0 and bool_and(status='completed') from a where due_on=p_day),false) and (select n from o)=0)
$$;
create or replace function public.task_report_json(p_report public.task_daily_reports) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p_report)||jsonb_build_object('user_name',p.name,'user_uid',p.uid,
  'reviewed_by_name',(select name from public.profiles where id=p_report.reviewed_by))
 from public.profiles p where p.id=p_report.user_id
$$;
create or replace function public.task_request_json(p_req public.task_checkout_requests,p_today date) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p_req)||jsonb_build_object('user_name',p.name,'user_uid',p.uid,
  'decided_by_name',(select name from public.profiles where id=p_req.decided_by),
  -- A waiting request from an earlier day can no longer be used.
  'expired',p_req.status='pending' and p_req.work_date<p_today)
 from public.profiles p where p.id=p_req.user_id
$$;
-- Every active administrator except p_except, in the CRM only.
create or replace function public.task_notify_admins(p_except uuid,p_type text,p_group text,p_title text,p_body text,p_link text,p_many_title text,p_many_body text)
returns void language plpgsql security definer set search_path='' as $$
declare a uuid;
begin
 for a in select id from public.profiles where role='admin' and active and deleted_at is null and id is distinct from p_except loop
  perform public.push_notification(a,p_type,p_group,p_title,p_body,p_link,null,p_many_title,p_many_body,p_link);
 end loop;
end $$;
-- The active agents named, or every active agent; anyone else is refused.
create or replace function public.task_agents(p_ids jsonb,p_all boolean) returns uuid[] language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];bad text;
begin
 if p_all then
  return array(select id from public.profiles where role='agent' and active and deleted_at is null order by name,id);
 end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 200 then
  raise exception 'Choose at least one agent' using errcode='HA400';end if;
 select array_agg(distinct x::uuid) into ids from jsonb_array_elements_text(p_ids) x;
 select coalesce(p.name,'An account') into bad from unnest(ids) i left join public.profiles p on p.id=i
  where p.id is null or p.role<>'agent' or not p.active or p.deleted_at is not null limit 1;
 if bad is not null then raise exception '% is not an active agent and can''t be given tasks',bad using errcode='HA400';end if;
 return ids;
end $$;

-- Requests after a rejection: at most 3 of each kind a day (cancelled ones
-- count, so cancelling and asking again can't flood administrators); a new
-- explanation, different from every earlier one that day; and, for early
-- checkout, 15 minutes after the last rejection.
create or replace function public.task_request_limits(p_user uuid,p_kind text,p_day date,p_at timestamptz) returns jsonb language sql stable security definer set search_path='' as $$
 with q as (select * from public.task_checkout_requests where user_id=p_user and kind=p_kind and work_date=p_day),
  last_rejected as (select * from q where status='rejected' order by decided_at desc limit 1)
 select jsonb_build_object('count',(select count(*) from q),'limit',3,'limit_reached',(select count(*)>=3 from q),
  'rejected',(select count(*) from q where status='rejected'),
  'explanation_required',exists(select 1 from q where status='rejected'),
  'last_rejected_at',(select decided_at from last_rejected),
  'last_rejected_by',(select name from public.profiles where id=(select decided_by from last_rejected)),
  'last_rejection_note',(select decision_note from last_rejected),
  'retry_at',case when p_kind='early' then (select decided_at+interval '15 minutes' from last_rejected) end,
  'waiting',coalesce(p_kind='early' and p_at<(select decided_at+interval '15 minutes' from last_rejected),false),
  'reasons',(select coalesce(jsonb_agg(lower(regexp_replace(btrim(reason),'\s+',' ','g'))),'[]'::jsonb) from q where reason is not null))
$$;

-- ---------------------------------------------------------- the checkout check
-- Whether this agent may check out at p_at, and which approved request that
-- uses. Read by the attendance screen and enforced by attendance_check_out_at.
create or replace function public.task_checkout_check(p_actor public.profiles,p_rec public.attendance_records,p_at timestamptz,p_lock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare day date=p_rec.attendance_date;report boolean;req public.task_checkout_requests;
 ends timestamptz=public.attendance_moment(p_rec.attendance_date,p_rec.shift_end);
begin
 if p_actor.role<>'agent' or not public.task_rules_on(day) then
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

-- As in 040, plus the task checkout rules. A used approval is marked so it
-- can't be reused, and the audit entry names it.
create or replace function public.attendance_check_out_at(p_actor uuid,p_at timestamptz,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);day date=public.attendance_local_date(p_at);rec public.attendance_records;calc record;gate jsonb;
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
 gate=public.task_checkout_check(actor,rec,p_at,true);
 if not (gate->>'allowed')::boolean then raise exception '%',gate->>'reason' using errcode='HA409';end if;
 select * into calc from public.attendance_compute(rec.attendance_date,rec.shift_start,rec.shift_end,rec.grace_minutes,rec.check_in_at,p_at);
 update public.attendance_records set check_out_at=p_at,state='checked_out',worked_minutes=calc.worked_minutes,
  early_departure_minutes=calc.early_departure_minutes,overtime_minutes=calc.overtime_minutes
 where id=rec.id returning * into rec;
 if gate?'request_id' then
  update public.task_checkout_requests set used_at=p_at where id=(gate->>'request_id')::uuid;end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'attendance.check_out','attendance_records',rec.id::text,p_request,
   jsonb_build_object('date',rec.attendance_date,'worked_minutes',calc.worked_minutes,'early_departure_minutes',calc.early_departure_minutes,'overtime_minutes',calc.overtime_minutes)
   ||case when gate?'request_id' then jsonb_build_object('checkout_request_id',gate->>'request_id','checkout_kind',gate->>'kind') else '{}'::jsonb end);
 return public.attendance_record_json(rec);
end $$;

-- What the agent can do about checking out now, for the screens.
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
 if actor.role<>'agent' then early=early||'Only agents request early checkout.'::text;
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
 return jsonb_build_object('date',today,'rules_active',public.task_rules_on(today),'required',actor.role='agent' and public.task_rules_on(today),
  'attendance_state',rec.state,'shift_end',to_char(coalesce(rec.shift_end,(public.attendance_policy_on(today)).shift_end),'HH24:MI'),
  'before_shift_end',rec.id is not null and p_at<public.attendance_moment(today,rec.shift_end),
  'report_submitted',report,'tasks',summary,
  'pending_request',case when pending.id is null then null else public.task_request_json(pending,today) end,
  'approved_request',case when approved.id is null then null else public.task_request_json(approved,today) end,
  'can_check_out',coalesce((gate->>'allowed')::boolean,false),'blocked_reason',case when gate is not null and not (gate->>'allowed')::boolean then gate->>'reason' end,
  'can_request_early',cardinality(early)=0,'early_blockers',to_jsonb(early),
  'can_request_emergency',coalesce(actor.role='agent' and public.task_rules_on(today) and rec.state='checked_in' and pending.id is null and approved.id is null
   and not (urgent->>'limit_reached')::boolean,false),
  'early_resubmission',limits-'reasons','emergency_resubmission',urgent-'reasons');
end $$;
create or replace function public.task_checkout_state(p_actor uuid) returns jsonb language sql security definer set search_path='' as $$
 select public.task_checkout_state_at(p_actor,now())
$$;

-- ---------------------------------------------------------- administrators
create or replace function public.task_create_at(p_actor uuid,p_data jsonb,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(p_at);t public.tasks;
 ids uuid[];key uuid;day date;due date;kind text;dup text;u uuid;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['scope','title','description','instructions','category','priority','kind',
  'target_quantity','unit','task_date','due_on','assignees','all_agents','client_key','allow_duplicate'])<>'{}'::jsonb then
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
 ids=public.task_agents(p_data->'assignees',coalesce((p_data->>'all_agents')::boolean,false));
 if cardinality(ids)=0 then raise exception 'There are no active agents to assign' using errcode='HA400';end if;
 if p_data->>'scope'='individual' and cardinality(ids)<>1 then raise exception 'An individual task is for one agent' using errcode='HA400';end if;
 if not coalesce((p_data->>'allow_duplicate')::boolean,false) then
  select p.name into dup from public.task_assignments x join public.tasks o on o.id=x.task_id join public.profiles p on p.id=x.user_id
   where x.user_id=any(ids) and x.status<>'cancelled' and o.task_date=day and lower(btrim(o.title))=lower(btrim(p_data->>'title')) limit 1;
  if dup is not null then
   raise exception '% already has “%” on %. Choose Assign anyway to add it again.',dup,btrim(p_data->>'title'),public.task_day_text(day) using errcode='HA409';end if;
 end if;
 insert into public.tasks(scope,title,description,instructions,category,priority,kind,target_quantity,unit,task_date,due_on,client_key,created_by,updated_by)
 values(p_data->>'scope',btrim(p_data->>'title'),nullif(btrim(p_data->>'description'),''),nullif(btrim(p_data->>'instructions'),''),
  nullif(p_data->>'category',''),coalesce(p_data->>'priority','normal'),kind,
  case when kind='measurable' then (p_data->>'target_quantity')::integer end,case when kind='measurable' then btrim(p_data->>'unit') end,
  day,due,key,actor.id,actor.id) returning * into t;
 insert into public.task_assignments(task_id,user_id) select t.id,i from unnest(ids) i;
 foreach u in array ids loop
  perform public.push_notification(u,'task_assigned','task:'||t.id,'New task: '||left(t.title,180),
   format('%s assigned this for %s%s.',actor.name,public.task_day_text(t.task_date),
    case when t.kind='measurable' then format(': target %s %s',t.target_quantity,t.unit) else '' end),'/my-tasks',null);
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.create','tasks',t.id::text,p_request,jsonb_build_object('scope',t.scope,'title',t.title,'kind',t.kind,
  'target_quantity',t.target_quantity,'unit',t.unit,'date',t.task_date,'due_on',t.due_on,'priority',t.priority,'assignee_count',cardinality(ids))
  ||case when cardinality(ids)=1 then jsonb_build_object('user_id',ids[1]) else '{}'::jsonb end);
 return public.task_detail(p_actor,t.id);
end $$;
create or replace function public.task_create(p_actor uuid,p_data jsonb,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_create_at(p_actor,p_data,p_request,now())
$$;

-- Changes to a task apply to every agent who has it. A new target
-- recalculates each open, unverified assignment from its reported quantity.
-- Reports already submitted keep the values they were submitted with.
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
  if t.scope='individual' then raise exception 'An individual task is for one agent' using errcode='HA400';end if;
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
create or replace function public.task_update(p_actor uuid,p_task uuid,p_data jsonb,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_update_at(p_actor,p_task,p_data,p_request,now())
$$;

-- Cancelling keeps every assignment and its progress, marked cancelled.
create or replace function public.task_cancel(p_actor uuid,p_task uuid,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);t public.tasks;u uuid;n integer;
begin
 if length(p_reason)>300 then raise exception 'Keep the reason under 300 characters' using errcode='HA400';end if;
 select * into t from public.tasks where id=p_task for update;
 if not found then raise exception 'Task not found' using errcode='HA404';end if;
 if t.cancelled_at is not null then raise exception 'This task was already cancelled' using errcode='HA409';end if;
 update public.tasks set cancelled_at=now(),cancelled_by=actor.id,cancel_reason=nullif(btrim(p_reason),''),updated_by=actor.id where id=t.id;
 n=0;
 for u in update public.task_assignments set status='cancelled',cancelled_at=now(),cancelled_by=actor.id
  where task_id=t.id and status<>'cancelled' returning user_id loop
  n=n+1;
  perform public.push_notification(u,'task_cancelled','task-cancel:'||t.id,'Task cancelled: '||left(t.title,180),
   format('%s cancelled this task.%s',actor.name,coalesce(' '||nullif(btrim(p_reason),''),'')),'/my-tasks',null);
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.cancel','tasks',t.id::text,p_request,jsonb_build_object('title',t.title,'date',t.task_date,'assignee_count',n,
  'reason_given',nullif(btrim(p_reason),'') is not null));
 return public.task_detail(p_actor,t.id);
end $$;
-- Takes one agent off a team task; their progress stays on record.
create or replace function public.task_assignment_cancel(p_actor uuid,p_assignment uuid,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);a public.task_assignments;t public.tasks;
begin
 if length(p_reason)>300 then raise exception 'Keep the reason under 300 characters' using errcode='HA400';end if;
 select * into a from public.task_assignments where id=p_assignment for update;
 if not found then raise exception 'Assignment not found' using errcode='HA404';end if;
 if a.status='cancelled' then raise exception 'This assignment was already cancelled' using errcode='HA409';end if;
 select * into t from public.tasks where id=a.task_id;
 update public.task_assignments set status='cancelled',cancelled_at=now(),cancelled_by=actor.id,cancel_reason=nullif(btrim(p_reason),'') where id=a.id;
 perform public.push_notification(a.user_id,'task_cancelled','task-cancel:'||t.id,'Task cancelled: '||left(t.title,180),
  format('%s took you off this task.%s',actor.name,coalesce(' '||nullif(btrim(p_reason),''),'')),'/my-tasks',null);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.unassign','task_assignments',a.id::text,p_request,jsonb_build_object('user_id',a.user_id,'title',t.title,'date',t.task_date));
 return public.task_detail(p_actor,t.id);
end $$;
-- An administrator's check of one agent's task. The reported values stay.
create or replace function public.task_verify(p_actor uuid,p_assignment uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);a public.task_assignments;t public.tasks;v text=p_data->>'status';q integer;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['status','quantity','note'])<>'{}'::jsonb or v not in ('confirmed','adjusted','not_done') then
  raise exception 'Choose confirmed, adjusted or not done' using errcode='HA400';end if;
 select * into a from public.task_assignments where id=p_assignment for update;
 if not found then raise exception 'Assignment not found' using errcode='HA404';end if;
 if a.status='cancelled' then raise exception 'This assignment was cancelled' using errcode='HA409';end if;
 if a.user_id=actor.id then raise exception 'Another administrator must verify your own task' using errcode='HA403';end if;
 select * into t from public.tasks where id=a.task_id;
 if v='adjusted' then
  if t.kind<>'measurable' then raise exception 'Only a measurable task can be adjusted; choose confirmed or not done' using errcode='HA400';end if;
  q=(p_data->>'quantity')::integer;
  if q is null or q<0 or q>1000000 then raise exception 'Enter the verified quantity' using errcode='HA400';end if;
 end if;
 update public.task_assignments set verified_status=v,verified_quantity=case when v='adjusted' then q when v='confirmed' and t.kind='measurable' then a.completed_quantity when v='not_done' and t.kind='measurable' then 0 end,
  verified_by=actor.id,verified_at=now(),review_note=nullif(btrim(p_data->>'note'),'') where id=a.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.verify','task_assignments',a.id::text,p_request,jsonb_build_object('user_id',a.user_id,'title',t.title,'date',t.task_date,
  'kind',t.kind,'unit',t.unit,'reported_quantity',a.completed_quantity,'reported_status',a.status,'verified_status',v,
  'verified_quantity',case when v='adjusted' then q when t.kind='measurable' and v='confirmed' then a.completed_quantity when t.kind='measurable' then 0 end));
 return public.task_assignment_json(a.id);
end $$;
create or replace function public.task_report_review(p_actor uuid,p_report uuid,p_note text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);r public.task_daily_reports;
begin
 if length(p_note)>500 then raise exception 'Keep the note under 500 characters' using errcode='HA400';end if;
 select * into r from public.task_daily_reports where id=p_report for update;
 if not found then raise exception 'Report not found' using errcode='HA404';end if;
 if r.status='reviewed' then raise exception 'This report was already reviewed' using errcode='HA409';end if;
 if r.user_id=actor.id then raise exception 'Another administrator must review your own report' using errcode='HA403';end if;
 update public.task_daily_reports set status='reviewed',reviewed_by=actor.id,reviewed_at=now(),review_note=nullif(btrim(p_note),'') where id=r.id returning * into r;
 perform public.push_notification(r.user_id,'task_report_reviewed','report-review:'||r.id,'Daily report reviewed',
  format('%s reviewed your daily report for %s.',actor.name,public.task_day_text(r.work_date)),'/my-tasks?tab=reports',null);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,'task.report_review','task_daily_reports',r.id::text,p_request,jsonb_build_object('user_id',r.user_id,'date',r.work_date,
  'completion_percent',r.completion_percent,'note_given',r.review_note is not null));
 return public.task_report_json(r);
end $$;

-- Early requests are decided on their own workday while the agent is still
-- checked in; an approval re-checks that every task due is still done.
-- Emergency requests can also be approved afterwards, to record the
-- exception; the departure time is then fixed through a correction.
create or replace function public.task_checkout_decide_at(p_actor uuid,p_id uuid,p_decision text,p_note text,p_waive boolean,p_request text,p_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(p_at);emp_id uuid;req public.task_checkout_requests;
 rec public.attendance_records;summary jsonb;emp public.profiles;
begin
 if p_decision not in ('approve','reject') then raise exception 'Choose approve or reject' using errcode='HA400';end if;
 if length(p_note)>300 then raise exception 'Keep the note under 300 characters' using errcode='HA400';end if;
 select user_id into emp_id from public.task_checkout_requests where id=p_id;
 if emp_id is null then raise exception 'Request not found' using errcode='HA404';end if;
 -- The same lock as check-out: a decision and a check-out never interleave.
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||emp_id,40));
 select * into req from public.task_checkout_requests where id=p_id for update;
 if req.status<>'pending' then
  raise exception 'This request was already %',case req.status when 'approved' then 'approved' when 'rejected' then 'rejected' else 'cancelled' end using errcode='HA409';end if;
 if req.user_id=actor.id then raise exception 'Another administrator must decide your own request' using errcode='HA403';end if;
 select * into emp from public.profiles where id=req.user_id;
 select * into rec from public.attendance_records where user_id=req.user_id and attendance_date=req.work_date;
 if p_decision='approve' and req.kind='early' then
  if req.work_date<>today then raise exception 'This early checkout request has expired; it was for %',public.task_day_text(req.work_date) using errcode='HA409';end if;
  if rec.state is distinct from 'checked_in' then raise exception '% has already checked out today',emp.name using errcode='HA409';end if;
  summary=public.task_day(req.user_id,req.work_date);
  if not (summary->>'all_due_completed')::boolean then
   raise exception 'Tasks changed since the request: % of % tasks due today are now done. Reject it, or ask % to update their tasks.',
    summary->>'due_completed',summary->>'due_count',emp.name using errcode='HA409';end if;
  if not exists(select 1 from public.task_daily_reports where user_id=req.user_id and work_date=req.work_date) then
   raise exception 'The daily report is missing' using errcode='HA409';end if;
 end if;
 if p_decision='approve' and req.kind='emergency' and req.work_date>today then
  raise exception 'This request is for a later day' using errcode='HA409';end if;
 update public.task_checkout_requests set status=case when p_decision='approve' then 'approved' else 'rejected' end,decided_by=actor.id,decided_at=p_at,
  decision_note=nullif(btrim(p_note),''),waive_report=p_decision='approve' and req.kind='emergency' and coalesce(p_waive,false)
 where id=req.id returning * into req;
 perform public.push_notification(req.user_id,'checkout_decision','checkout-decision:'||req.id,
  format('%s checkout %s',case req.kind when 'early' then 'Early' else 'Emergency' end,req.status),
  format('%s %s your %s checkout request for %s.%s%s',actor.name,req.status,req.kind,public.task_day_text(req.work_date),
   case when req.status='approved' and rec.state='checked_in' and req.work_date=today then ' You can check out now from My attendance.'
    when req.status='approved' then ' If you left without checking out, request a check-out correction for the time you left.'
    else ' Your normal checkout rules still apply.' end,
   case when req.waive_report then ' Your daily report was waived for this checkout.' else '' end),'/attendance',null);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case req.status when 'approved' then 'checkout.approve' else 'checkout.reject' end,'task_checkout_requests',req.id::text,p_request,
  jsonb_build_object('user_id',req.user_id,'kind',req.kind,'date',req.work_date,'waive_report',req.waive_report,'note_given',req.decision_note is not null,
   'retrospective',req.work_date<today));
 return public.task_request_json(req,today);
end $$;
create or replace function public.task_checkout_decide(p_actor uuid,p_id uuid,p_decision text,p_note text,p_waive boolean,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_checkout_decide_at(p_actor,p_id,p_decision,p_note,p_waive,p_request,now())
$$;
create or replace function public.task_settings(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 return (select jsonb_build_object('rules_from',task_rules_from,'rules_active_today',public.task_rules_on(public.attendance_local_date(now())),
  'today',public.attendance_local_date(now())) from public.crm_settings where id);
end $$;
-- The checkout rules start on a chosen day (today or later) or stop now.
create or replace function public.task_settings_save(p_actor uuid,p_from date,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);before date;today date=public.attendance_local_date(now());
begin
 if p_from is not null and (p_from<today or p_from>today+366) then
  raise exception 'Choose today or a later date, within a year' using errcode='HA400';end if;
 select task_rules_from into before from public.crm_settings where id for update;
 if before is not distinct from p_from then return public.task_settings(p_actor);end if;
 update public.crm_settings set task_rules_from=p_from,updated_by=actor.id,updated_at=now() where id;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
 values(actor.id,'task.rules_changed','crm_settings',p_request,jsonb_build_object('from',before,'to',p_from));
 return public.task_settings(p_actor);
end $$;

-- ------------------------------------------------------- administrator reads
create or replace function public.task_detail(p_actor uuid,p_task uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);t public.tasks;
begin
 select * into t from public.tasks where id=p_task;
 if not found then raise exception 'Task not found' using errcode='HA404';end if;
 return to_jsonb(t)-'client_key'||jsonb_build_object('created_by_name',(select name from public.profiles where id=t.created_by),
  'cancelled_by_name',(select name from public.profiles where id=t.cancelled_by),
  'assignments',(select coalesce(jsonb_agg(public.task_assignment_json(x.id) order by p.name,x.id),'[]'::jsonb)
   from public.task_assignments x join public.profiles p on p.id=x.user_id where x.task_id=t.id));
end $$;
-- p_filters: scope, from, to (task days), status (open|cancelled), user, search.
create or replace function public.task_admin_tasks(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);term text=nullif(lower(btrim(f->>'search')),'');result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then raise exception 'Choose a valid page' using errcode='HA400';end if;
 with s as (
  select t.* from public.tasks t
  where (f->>'scope' is null or t.scope=f->>'scope')
   and (f->>'from' is null or t.due_on>=(f->>'from')::date) and (f->>'to' is null or t.task_date<=(f->>'to')::date)
   and (f->>'status' is null or (f->>'status'='open' and t.cancelled_at is null) or (f->>'status'='cancelled' and t.cancelled_at is not null))
   and (f->>'user' is null or exists(select 1 from public.task_assignments x where x.task_id=t.id and x.user_id=(f->>'user')::uuid))
   and (term is null or position(term in lower(t.title))>0)
 ), page as (select * from s order by task_date desc,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('count',(select count(*) from s),'page',p_page,'limit',p_limit,'data',coalesce(jsonb_agg(
  to_jsonb(p)-'client_key'||jsonb_build_object('created_by_name',(select name from public.profiles where id=p.created_by),
   'assignees',(select count(*) from public.task_assignments x where x.task_id=p.id and x.status<>'cancelled'),
   'completed',(select count(*) from public.task_assignments x where x.task_id=p.id and x.status='completed'),
   'verified',(select count(*) from public.task_assignments x where x.task_id=p.id and x.verified_status is not null),
   'average_percent',(select round(avg(public.task_percent(p.kind,p.target_quantity,x.completed_quantity,x.status)),1) from public.task_assignments x where x.task_id=p.id and x.status<>'cancelled'),
   'assignee_names',(select coalesce(jsonb_agg(pr.name order by pr.name),'[]'::jsonb) from (select pr.name from public.task_assignments x join public.profiles pr on pr.id=x.user_id
     where x.task_id=p.id and x.status<>'cancelled' order by pr.name limit 3) pr))
  order by p.task_date desc,p.created_at desc,p.id),'[]'::jsonb)) into result from page p;
 return result;
end $$;
create or replace function public.task_admin_overview(p_actor uuid,p_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);day date=coalesce(p_day,public.attendance_local_date(now()));
begin
 return (with a as (select x.*,t.kind,t.target_quantity,t.task_date,t.due_on from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.status<>'cancelled' and t.task_date<=day and t.due_on>=day),
  agents as (select p.id,p.name,p.uid from public.profiles p where p.role='agent' and p.active and p.deleted_at is null),
  r as (select * from public.task_daily_reports where work_date=day)
 select jsonb_build_object('date',day,'rules_active',public.task_rules_on(day),
  'active_tasks',(select count(distinct task_id) from a),'assigned_today',(select count(*) from public.tasks t where t.task_date=day and t.cancelled_at is null),
  'assignments',(select count(*) from a),'completed',(select count(*) from a where status='completed'),
  'pending',(select count(*) from a where status<>'completed'),'average_percent',(select round(avg(public.task_percent(kind,target_quantity,completed_quantity,status)),1) from a),
  'reports_submitted',(select count(*) from r),'reports_to_review',(select count(*) from public.task_daily_reports where status='submitted'),
  'missing_reports',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'uid',g.uid) order by g.name),'[]'::jsonb) from agents g
   where exists(select 1 from a where a.user_id=g.id) and not exists(select 1 from r where r.user_id=g.id)),
  'agents_with_tasks',(select count(distinct user_id) from a),
  'pending_early',(select count(*) from public.task_checkout_requests where status='pending' and kind='early' and work_date=day),
  'pending_emergency',(select count(*) from public.task_checkout_requests where status='pending' and kind='emergency'),
  'overdue_reports',(select jsonb_array_length(public.task_missing_reports(p_actor,day-7,day-1)->'data')),
  'people',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'uid',g.uid,
    'tasks',(select count(*) from a where a.user_id=g.id),'completed',(select count(*) from a where a.user_id=g.id and status='completed'),
    'percent',(select round(avg(public.task_percent(kind,target_quantity,completed_quantity,status)),1) from a where a.user_id=g.id),
    'report',(select jsonb_build_object('id',r.id,'status',r.status,'completion_percent',r.completion_percent) from r where r.user_id=g.id)) order by g.name),'[]'::jsonb)
   from agents g)));
end $$;
-- p_filters: date, from, to, user, status (submitted|reviewed).
create or replace function public.task_reports(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then raise exception 'Choose a valid page' using errcode='HA400';end if;
 with s as (select r.* from public.task_daily_reports r where (f->>'from' is null or r.work_date>=(f->>'from')::date)
   and (f->>'to' is null or r.work_date<=(f->>'to')::date) and (f->>'user' is null or r.user_id=(f->>'user')::uuid)
   and (f->>'status' is null or r.status=f->>'status')),
  page as (select * from s order by work_date desc,submitted_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('count',(select count(*) from s),'page',p_page,'limit',p_limit,
  'data',coalesce(jsonb_agg(public.task_report_json(p) order by p.work_date desc,p.submitted_at desc,p.id),'[]'::jsonb)) into result from page p;
 return result;
end $$;
-- The administrators' queue, newest first; p_filters: status, kind, user, from, to.
create or replace function public.task_checkout_requests_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);f jsonb=coalesce(p_filters,'{}'::jsonb);today date=public.attendance_local_date(now());result jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then raise exception 'Choose a valid page' using errcode='HA400';end if;
 with s as (select q.* from public.task_checkout_requests q where (f->>'status' is null or q.status=f->>'status')
   and (f->>'kind' is null or q.kind=f->>'kind') and (f->>'user' is null or q.user_id=(f->>'user')::uuid)
   and (f->>'from' is null or q.work_date>=(f->>'from')::date) and (f->>'to' is null or q.work_date<=(f->>'to')::date)),
  page as (select * from s order by (status='pending') desc,requested_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('count',(select count(*) from s),'page',p_page,'limit',p_limit,
  'data',coalesce(jsonb_agg(public.task_request_json(p,today)||jsonb_build_object(
   'report_id',(select id from public.task_daily_reports r where r.user_id=p.user_id and r.work_date=p.work_date),
   'attendance_state',(select state from public.attendance_records a where a.user_id=p.user_id and a.attendance_date=p.work_date),
   'tasks_now',public.task_day(p.user_id,p.work_date))
   order by (p.status='pending') desc,p.requested_at desc,p.id),'[]'::jsonb)) into result from page p;
 return result;
end $$;
-- Daily reports still owed: earlier days on which an agent had tasks due and
-- sent no report, newest first. Agents can submit them for 7 days.
create or replace function public.task_missing_reports_at(p_actor uuid,p_from date,p_to date,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);today date=public.attendance_local_date(p_at);result jsonb;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>92 then raise exception 'Choose a range of up to 93 days' using errcode='HA400';end if;
 with d as (select x.user_id,t.due_on work_day,count(*) tasks,round(avg(public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status)),1) pct
   from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.status<>'cancelled' and t.due_on between p_from and least(p_to,today-1) group by x.user_id,t.due_on)
 select jsonb_build_object('count',count(*),'data',coalesce(jsonb_agg(jsonb_build_object('user_id',p.id,'name',p.name,'uid',p.uid,
   'active',p.active and p.deleted_at is null,'work_date',d.work_day,'tasks',d.tasks,'completion_percent',d.pct,
   'can_still_submit',d.work_day>=today-7,'submit_until',d.work_day+7,
   'report_waived',exists(select 1 from public.task_checkout_requests q where q.user_id=d.user_id and q.work_date=d.work_day and q.status='approved' and q.waive_report))
   order by d.work_day desc,p.name,p.id),'[]'::jsonb)) into result
 from d join public.profiles p on p.id=d.user_id
 where not exists(select 1 from public.task_daily_reports r where r.user_id=d.user_id and r.work_date=d.work_day);
 return result;
end $$;
create or replace function public.task_missing_reports(p_actor uuid,p_from date,p_to date) returns jsonb language sql security definer set search_path='' as $$
 select public.task_missing_reports_at(p_actor,p_from,p_to,now())
$$;

-- Performance from the actual assignments, reports and requests, by agent and by day.
create or replace function public.task_performance(p_actor uuid,p_from date,p_to date,p_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_admin(p_actor);
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>92 then raise exception 'Choose a range of up to 93 days' using errcode='HA400';end if;
 return (with a as (select x.user_id,t.due_on,t.kind,t.target_quantity,x.completed_quantity,x.status,x.verified_status,x.verified_quantity,
    public.task_percent(t.kind,t.target_quantity,x.completed_quantity,x.status) pct,
    case when x.verified_status is null then null when x.verified_status='not_done' then 0.0 when t.kind='measurable'
     then least(100,round(coalesce(x.verified_quantity,x.completed_quantity)*100.0/t.target_quantity,1)) else 100.0 end vpct
   from public.task_assignments x join public.tasks t on t.id=x.task_id
   where x.status<>'cancelled' and t.due_on between p_from and p_to and (p_user is null or x.user_id=p_user)),
  r as (select * from public.task_daily_reports where work_date between p_from and p_to and (p_user is null or user_id=p_user)),
  q as (select * from public.task_checkout_requests where work_date between p_from and p_to and (p_user is null or user_id=p_user)),
  people as (select p.* from public.profiles p where p.id in (select user_id from a union select user_id from r union select user_id from q)
   or (p_user is null and p.role='agent' and p.active and p.deleted_at is null) or p.id=p_user)
 select jsonb_build_object('from',p_from,'to',p_to,
  'totals',jsonb_build_object('assignments',(select count(*) from a),'completed',(select count(*) from a where status='completed'),
   'average_percent',(select round(avg(pct),1) from a),'verified',(select count(*) from a where verified_status is not null),
   'verified_average_percent',(select round(avg(vpct),1) from a),'reports',(select count(*) from r),
   'early_approved',(select count(*) from q where kind='early' and status='approved'),'emergency_approved',(select count(*) from q where kind='emergency' and status='approved')),
  'employees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'active',p.active and p.deleted_at is null,
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
  'days',(select coalesce(jsonb_agg(jsonb_build_object('date',d,'assignments',(select count(*) from a where due_on=d),
    'completed',(select count(*) from a where due_on=d and status='completed'),'average_percent',(select round(avg(pct),1) from a where due_on=d),
    'reports',(select count(*) from r where work_date=d)) order by d),'[]'::jsonb)
   from generate_series(p_from,p_to,interval '1 day') g(dd),lateral (select g.dd::date d) x)));
end $$;

-- ----------------------------------------------------------------- agents
create or replace function public.task_my_at(p_actor uuid,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);
begin
 return (with mine as (select x.id,x.status,x.completed_at,t.task_date,t.due_on,t.priority from public.task_assignments x join public.tasks t on t.id=x.task_id where x.user_id=p_actor)
 select jsonb_build_object('date',today,'role',actor.role,'rules_active',public.task_rules_on(today),
  'today',(select coalesce(jsonb_agg(public.task_assignment_json(m.id) order by m.status='completed',array_position(array['urgent','high','normal','low'],m.priority),m.due_on,m.id),'[]'::jsonb)
   from mine m where m.status<>'cancelled' and m.task_date<=today and m.due_on>=today),
  'overdue',(select coalesce(jsonb_agg(public.task_assignment_json(m.id) order by m.due_on,m.id),'[]'::jsonb)
   from mine m where m.status not in ('completed','cancelled') and m.due_on<today),
  'upcoming',(select coalesce(jsonb_agg(public.task_assignment_json(m.id) order by m.task_date,m.id),'[]'::jsonb)
   from mine m where m.status<>'cancelled' and m.task_date>today and m.task_date<=today+14),
  'completed',(select coalesce(jsonb_agg(public.task_assignment_json(m.id) order by m.completed_at desc,m.id),'[]'::jsonb)
   from (select * from mine m where m.status='completed' and m.due_on<today and m.due_on>=today-14 order by m.completed_at desc limit 30) m),
  'summary',public.task_day(p_actor,today),
  'report',(select public.task_report_json(r) from public.task_daily_reports r where r.user_id=p_actor and r.work_date=today),
  -- Earlier days with tasks and no report (for example after an emergency).
  'missing_reports',(select coalesce(jsonb_agg(d order by d desc),'[]'::jsonb) from (select distinct m.due_on d from mine m
   where m.status<>'cancelled' and m.due_on between today-7 and today-1
    and not exists(select 1 from public.task_daily_reports r where r.user_id=p_actor and r.work_date=m.due_on)) x),
  'reports',(select coalesce(jsonb_agg(public.task_report_json(r) order by r.work_date desc),'[]'::jsonb)
   from (select * from public.task_daily_reports where user_id=p_actor order by work_date desc limit 30) r),
  'requests',(select coalesce(jsonb_agg(public.task_request_json(q,today) order by q.requested_at desc),'[]'::jsonb)
   from (select * from public.task_checkout_requests where user_id=p_actor order by requested_at desc limit 20) q),
  'checkout',public.task_checkout_state_at(p_actor,p_at)));
end $$;
create or replace function public.task_my(p_actor uuid) returns jsonb language sql security definer set search_path='' as $$
 select public.task_my_at(p_actor,now())
$$;
-- An agent's own progress. Measurable tasks take a quantity (the status
-- follows it); simple tasks take a status.
create or replace function public.task_progress_at(p_actor uuid,p_assignment uuid,p_data jsonb,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);a public.task_assignments;t public.tasks;
 q integer;s text;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['quantity','status','note'])<>'{}'::jsonb then
  raise exception 'Unsupported progress details' using errcode='HA400';end if;
 select * into a from public.task_assignments where id=p_assignment for update;
 -- Someone else's task is reported as missing, never as forbidden.
 if not found or a.user_id<>p_actor then raise exception 'Task not found' using errcode='HA404';end if;
 select * into t from public.tasks where id=a.task_id;
 if a.status='cancelled' then raise exception 'This task was cancelled' using errcode='HA409';end if;
 if a.verified_status is not null then raise exception 'An administrator has verified this task, so it can no longer be changed' using errcode='HA409';end if;
 if t.task_date>today then raise exception 'This task starts on %',public.task_day_text(t.task_date) using errcode='HA409';end if;
 if exists(select 1 from public.task_daily_reports r where r.user_id=p_actor and r.work_date=t.due_on and r.status='reviewed') then
  raise exception 'Your report for % was reviewed, so this task can no longer be changed',public.task_day_text(t.due_on) using errcode='HA409';end if;
 if length(p_data->>'note')>500 then raise exception 'Keep the note under 500 characters' using errcode='HA400';end if;
 if t.kind='measurable' then
  q=(p_data->>'quantity')::integer;
  if q is null or q<0 or q>1000000 then raise exception 'Enter how many you completed' using errcode='HA400';end if;
  s=public.task_status_for(t.target_quantity,q);
 else
  s=p_data->>'status';q=0;
  if s not in ('pending','in_progress','completed') then raise exception 'Choose pending, in progress or completed' using errcode='HA400';end if;
 end if;
 update public.task_assignments set completed_quantity=q,status=s,employee_note=case when p_data?'note' then nullif(btrim(p_data->>'note'),'') else employee_note end,
  progress_at=p_at,completed_at=case when s='completed' then coalesce(completed_at,p_at) end where id=a.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(p_actor,'task.progress','task_assignments',a.id::text,p_request,jsonb_build_object('user_id',p_actor,'title',t.title,'date',t.task_date,
  'kind',t.kind,'unit',t.unit,'target_quantity',t.target_quantity,'before',jsonb_build_object('quantity',a.completed_quantity,'status',a.status),
  'after',jsonb_build_object('quantity',q,'status',s)));
 return public.task_assignment_json(a.id);
end $$;
create or replace function public.task_progress(p_actor uuid,p_assignment uuid,p_data jsonb,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_progress_at(p_actor,p_assignment,p_data,p_request,now())
$$;
-- One report per workday: today, or one of the last seven days (a day
-- missed after an emergency). A second submission must say it amends the
-- first; a reviewed report can't change.
create or replace function public.task_report_submit_at(p_actor uuid,p_day date,p_remarks text,p_amend boolean,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);day date=coalesce(p_day,today);
 r public.task_daily_reports;snap jsonb;pct numeric;n integer;
begin
 if actor.role<>'agent' then raise exception 'Daily reports are for agents' using errcode='HA403';end if;
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
create or replace function public.task_report_submit(p_actor uuid,p_day date,p_remarks text,p_amend boolean,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_report_submit_at(p_actor,p_day,p_remarks,p_amend,p_request,now())
$$;
-- An agent's own report, or any report for an administrator.
create or replace function public.task_report_detail(p_actor uuid,p_report uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);r public.task_daily_reports;
begin
 select * into r from public.task_daily_reports where id=p_report;
 if not found or (actor.role<>'admin' and r.user_id<>p_actor) then raise exception 'Report not found' using errcode='HA404';end if;
 return public.task_report_json(r)||jsonb_build_object('assignments',(select coalesce(jsonb_agg(public.task_assignment_json((e->>'assignment_id')::uuid)),'[]'::jsonb)
  from jsonb_array_elements(r.tasks) e where actor.role='admin'));
end $$;
create or replace function public.task_checkout_request_at(p_actor uuid,p_kind text,p_reason text,p_request text,p_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);today date=public.attendance_local_date(p_at);rec public.attendance_records;
 state jsonb;summary jsonb;req public.task_checkout_requests;report boolean;limits jsonb;
begin
 if actor.role<>'agent' then raise exception 'Only agents request checkout approval' using errcode='HA403';end if;
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
create or replace function public.task_checkout_request(p_actor uuid,p_kind text,p_reason text,p_request text) returns jsonb language sql security definer set search_path='' as $$
 select public.task_checkout_request_at(p_actor,p_kind,p_reason,p_request,now())
$$;
create or replace function public.task_checkout_cancel(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.attendance_member(p_actor);req public.task_checkout_requests;
begin
 perform pg_advisory_xact_lock(hashtextextended('attendance:'||p_actor,40));
 select * into req from public.task_checkout_requests where id=p_id for update;
 if not found or req.user_id<>p_actor then raise exception 'Request not found' using errcode='HA404';end if;
 if req.status<>'pending' then raise exception 'Only a waiting request can be cancelled' using errcode='HA409';end if;
 update public.task_checkout_requests set status='cancelled' where id=req.id returning * into req;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(p_actor,'checkout.cancel','task_checkout_requests',req.id::text,p_request,jsonb_build_object('user_id',p_actor,'kind',req.kind,'date',req.work_date));
 return public.task_request_json(req,public.attendance_local_date(now()));
end $$;

-- ---------------------------------------------------------------- grants
-- Browser roles get nothing. The API calls the service-role functions; the
-- explicit-time forms and helpers are for the database owner and tests only.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'task\_%' or p.proname='attendance_check_out_at') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('task_create','task_update','task_cancel','task_assignment_cancel','task_verify','task_report_review','task_checkout_decide',
   'task_settings','task_settings_save','task_detail','task_admin_tasks','task_admin_overview','task_reports','task_checkout_requests_page',
   'task_performance','task_missing_reports','task_my','task_progress','task_report_submit','task_report_detail','task_checkout_request','task_checkout_cancel',
   'task_checkout_state') then
   execute format('grant execute on function %s to service_role',f.signature);
  else
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
