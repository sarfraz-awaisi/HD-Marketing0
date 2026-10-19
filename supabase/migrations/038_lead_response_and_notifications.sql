-- Apply after 037. Safe to rerun. First-call tracking (F3), missed-call review
-- (F4: an administrator decides; nothing is reassigned automatically), in-app
-- notifications (F7) and the working hours used for first-call deadlines.
begin;
do $$ begin
 if to_regclass('public.login_events') is null then
  raise exception 'Apply CRM update 037 before sales workflow update 038.';
 end if;
end $$;

-- Working hours in Pakistan time (ISO days: 1 = Monday … 7 = Sunday).
create table if not exists public.crm_settings(
 id boolean primary key default true check(id),
 work_days smallint[] not null default '{1,2,3,4,5,6}' check(cardinality(work_days) between 1 and 7 and work_days<@'{1,2,3,4,5,6,7}'::smallint[]),
 work_start time not null default '10:00',
 work_end time not null default '18:00',
 first_call_grace_minutes integer not null default 120,
 idle_days integer not null default 7 check(idle_days between 1 and 90),
 updated_at timestamptz not null default now(),
 updated_by uuid references public.profiles(id),
 constraint crm_settings_hours check(work_end>work_start),
 constraint crm_settings_grace check(first_call_grace_minutes between 0 and 600 and make_interval(mins=>first_call_grace_minutes)<=work_end-work_start)
);
insert into public.crm_settings(id) values(true) on conflict(id) do nothing;
alter table public.crm_settings enable row level security;
revoke all on public.crm_settings from public,anon,authenticated;
grant all on public.crm_settings to service_role;

create or replace function public.format_pk_time(p_at timestamptz) returns text language sql stable set search_path='' as $$
 select to_char(p_at at time zone 'Asia/Karachi','Dy DD Mon, HH12:MI AM')
$$;
-- A lead must get its first call by the close of the first working day that
-- still has at least the grace period left; otherwise by the next one's close.
create or replace function public.first_call_due(p_at timestamptz) returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare s public.crm_settings;d date;i integer;opens timestamptz;closes timestamptz;
begin
 select * into s from public.crm_settings where id;
 if not found or p_at is null then return p_at+interval '1 day';end if;
 d=(p_at at time zone 'Asia/Karachi')::date;
 for i in 0..14 loop
  if extract(isodow from d+i)::smallint=any(s.work_days) then
   opens=((d+i)+s.work_start) at time zone 'Asia/Karachi';
   closes=((d+i)+s.work_end) at time zone 'Asia/Karachi';
   if closes-greatest(p_at,opens)>=make_interval(mins=>s.first_call_grace_minutes) then return closes;end if;
  end if;
 end loop;
 return p_at+interval '1 day';
end $$;
-- Minutes inside working hours between two moments (bounded to about a year).
create or replace function public.working_minutes(p_from timestamptz,p_to timestamptz) returns integer language plpgsql stable security definer set search_path='' as $$
declare s public.crm_settings;d date;last_day date;total numeric=0;opens timestamptz;closes timestamptz;
begin
 if p_from is null or p_to is null or p_to<=p_from then return 0;end if;
 select * into s from public.crm_settings where id;
 d=(p_from at time zone 'Asia/Karachi')::date;
 last_day=least((p_to at time zone 'Asia/Karachi')::date,d+400);
 while d<=last_day loop
  if extract(isodow from d)::smallint=any(s.work_days) then
   opens=(d+s.work_start) at time zone 'Asia/Karachi';
   closes=(d+s.work_end) at time zone 'Asia/Karachi';
   total=total+greatest(0,extract(epoch from least(closes,p_to)-greatest(opens,p_from))/60);
  end if;
  d=d+1;
 end loop;
 return round(total)::integer;
end $$;

-- Current first-call state per lead; assignments keep the history for reports.
alter table public.leads
 add column if not exists assigned_at timestamptz,
 add column if not exists call_due_at timestamptz,
 add column if not exists first_call_at timestamptz,
 add column if not exists missed_at timestamptz,
 add column if not exists idle_kept_until timestamptz;
alter table public.assignments
 add column if not exists call_due_at timestamptz,
 add column if not exists first_call_at timestamptz,
 add column if not exists missed_at timestamptz,
 add column if not exists reason text check(reason ~ '^[a-z_]{1,40}$');
create or replace view public.active_leads as select * from public.leads where deleted_at is null;
create index if not exists leads_first_call_queue on public.leads(assigned_agent,call_due_at) where first_call_at is null and assigned_agent is not null and deleted_at is null;
create index if not exists leads_owner_activity on public.leads(assigned_agent,last_activity_at) where assigned_agent is not null and deleted_at is null;
create index if not exists assignments_agent_created on public.assignments(agent_id,created_at);
create index if not exists assignments_first_call on public.assignments(first_call_at) where first_call_at is not null;

-- Backfill without changing each lead's "updated" time.
alter table public.leads disable trigger touch_updated;
update public.leads l set assigned_at=coalesce((select max(a.created_at) from public.assignments a where a.lead_id=l.id and a.agent_id=l.assigned_agent),l.created_at)
 where l.assigned_agent is not null and l.assigned_at is null;
update public.leads l set first_call_at=c.first_call
 from (select c.lead_id,min(greatest(c.started_at,x.assigned_at)) first_call from public.calls c join public.leads x on x.id=c.lead_id
  where c.agent_id=x.assigned_agent and c.created_at>=x.assigned_at group by c.lead_id) c
 where c.lead_id=l.id and l.first_call_at is null;
-- Leads already worked past New before this update get no deadline, so older
-- work is never reported as a missed first call.
update public.leads set call_due_at=public.first_call_due(assigned_at)
 where assigned_agent is not null and call_due_at is null and first_call_at is null and status='new';
alter table public.leads enable trigger touch_updated;
with ordered as (
 select a.id,a.lead_id,a.agent_id,a.created_at,lead(a.created_at) over(partition by a.lead_id order by a.created_at,a.id) next_at from public.assignments a
), firsts as (
 select o.id,(select min(greatest(c.started_at,o.created_at)) from public.calls c where c.lead_id=o.lead_id and c.agent_id=o.agent_id
  and c.created_at>=o.created_at and (o.next_at is null or c.created_at<o.next_at)) first_call
 from ordered o where o.agent_id is not null
)
update public.assignments a set first_call_at=f.first_call from firsts f where f.id=a.id and a.first_call_at is null and f.first_call is not null;
update public.assignments a set call_due_at=l.call_due_at from public.leads l
 where l.id=a.lead_id and a.agent_id=l.assigned_agent and a.created_at=l.assigned_at and a.call_due_at is null;

-- Leads waiting for an administrator's decision: a missed first call, or no
-- activity for the configured days without a planned follow-up.
create or replace view public.lead_review_queue as
select l.id,l.assigned_agent,
 case when l.first_call_at is null and l.call_due_at<now() then 'missed' else 'idle' end as kind,
 case when l.first_call_at is null and l.call_due_at<now() then l.call_due_at else l.last_activity_at end as since
from public.active_leads l cross join public.crm_settings s
where s.id and l.assigned_agent is not null and l.status not in ('won','lost') and (
 (l.first_call_at is null and l.call_due_at<now())
 or (l.last_activity_at<now()-make_interval(days=>s.idle_days) and (l.idle_kept_until is null or l.idle_kept_until<now())
  and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now())));
revoke all on public.lead_review_queue from public,anon,authenticated;
grant select on public.lead_review_queue to service_role;

-- In-app notifications. Text never contains phone numbers; any row naming a
-- customer is linked to that lead, so erasing the lead erases the notice.
create table if not exists public.notifications(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 type text not null check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed','missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow')),
 title text not null check(length(title) between 1 and 200),
 body text check(length(body)<=500),
 link text check(link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
 lead_id uuid references public.leads(id) on delete cascade,
 group_key text not null check(length(group_key) between 1 and 120),
 item_count integer not null default 1 check(item_count>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 read_at timestamptz,
 unique(user_id,type,group_key)
);
create index if not exists notifications_inbox on public.notifications(user_id,updated_at desc);
create index if not exists notifications_unread on public.notifications(user_id) where read_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from public,anon,authenticated;
grant all on public.notifications to service_role;
-- One notice per user, type and group. With p_many_title, a repeat in the same
-- group (for example one bulk assignment) becomes a counted summary instead.
create or replace function public.push_notification(p_user uuid,p_type text,p_group text,p_title text,p_body text,p_link text,p_lead uuid,
 p_many_title text default null,p_many_body text default null,p_many_link text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_user is null or not exists(select 1 from public.profiles where id=p_user and active) then return;end if;
 insert into public.notifications as n(user_id,type,group_key,title,body,link,lead_id)
 values(p_user,p_type,p_group,left(p_title,200),left(p_body,500),p_link,p_lead)
 on conflict(user_id,type,group_key) do update set item_count=n.item_count+1,title=left(format(p_many_title,n.item_count+1),200),
  body=left(p_many_body,500),link=p_many_link,lead_id=null,updated_at=now(),read_at=null
 where p_many_title is not null;
end $$;
insert into public.notifications(user_id,type,group_key,title,body,link,lead_id,created_at,updated_at)
select r.agent_id,'followup_due','followup:'||f.id||':'||floor(extract(epoch from r.due_at))::bigint,
 'Follow-up due: '||public.format_lead_no(l.lead_no),left(l.name||' · '||public.format_pk_time(r.due_at),500),'/leads/'||l.id,l.id,r.created_at,r.created_at
from public.reminders r join public.followups f on f.id=r.followup_id join public.active_leads l on l.id=f.lead_id
where r.read_at is null and f.status='pending'
on conflict(user_id,type,group_key) do nothing;

-- Every owner change (single, bulk, file, offboarding, social) restarts the
-- first-call clock for the new owner.
create or replace function public.track_lead_owner() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.assigned_agent is distinct from old.assigned_agent then
  new.first_call_at=null;new.missed_at=null;new.idle_kept_until=null;
  if new.assigned_agent is null then new.assigned_at=null;new.call_due_at=null;
  else new.assigned_at=now();new.call_due_at=public.first_call_due(now());end if;
 end if;
 return new;
end $$;
drop trigger if exists track_lead_owner on public.leads;
create trigger track_lead_owner before insert or update of assigned_agent on public.leads for each row execute function public.track_lead_owner();
create or replace function public.notify_lead_owner() returns trigger language plpgsql security definer set search_path='' as $$
declare grp text='tx:'||txid_current()::text;label text=public.format_lead_no(new.lead_no);
begin
 if tg_op='UPDATE' and new.assigned_agent is not distinct from old.assigned_agent then return null;end if;
 if new.assigned_agent is not null then
  perform public.push_notification(new.assigned_agent,'lead_assigned',grp,'New lead assigned: '||label,
   new.name||' · First call due by '||public.format_pk_time(new.call_due_at),'/leads/'||new.id,new.id,
   '%s new leads assigned to you','Open My leads and make the first calls before their deadlines.','/leads?view=all&call=uncalled');
 end if;
 if tg_op='UPDATE' and old.assigned_agent is not null then
  perform public.push_notification(old.assigned_agent,'lead_moved_away',grp,'Lead reassigned: '||label,
   'An administrator moved '||new.name||case when new.assigned_agent is null then ' back to the admin team.' else ' to another agent.' end,null,new.id,
   '%s of your leads were reassigned','An administrator moved them out of your list.',null);
 end if;
 return null;
end $$;
drop trigger if exists notify_lead_owner on public.leads;
create trigger notify_lead_owner after insert or update of assigned_agent on public.leads for each row execute function public.notify_lead_owner();
create or replace function public.stamp_assignment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.agent_id is not null then
  select call_due_at into new.call_due_at from public.leads where id=new.lead_id and assigned_agent=new.agent_id;
 end if;
 new.reason=coalesce(new.reason,nullif(current_setting('hd.assignment_reason',true),''));
 return new;
end $$;
drop trigger if exists stamp_assignment on public.assignments;
create trigger stamp_assignment before insert on public.assignments for each row execute function public.stamp_assignment();
-- The owner's first logged call (any outcome) stops the first-call clock.
create or replace function public.record_first_call() returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz;
begin
 update public.leads l set first_call_at=greatest(new.started_at,l.assigned_at)
  where l.id=new.lead_id and l.assigned_agent=new.agent_id and l.first_call_at is null and l.assigned_at is not null
  returning l.first_call_at into stamp;
 if stamp is not null then
  update public.assignments a set first_call_at=stamp
   where a.id=(select x.id from public.assignments x where x.lead_id=new.lead_id order by x.created_at desc,x.id desc limit 1)
    and a.agent_id=new.agent_id and a.first_call_at is null;
 end if;
 return null;
end $$;
drop trigger if exists record_first_call on public.calls;
create trigger record_first_call after insert on public.calls for each row execute function public.record_first_call();

-- Background check (every job tick): missed first calls, the afternoon
-- reminder, tomorrow's visits and the admins' end-of-day call summary.
create or replace function public.lead_response_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.crm_settings;today date=(now() at time zone 'Asia/Karachi')::date;workday boolean;opens timestamptz;closes timestamptz;day_start timestamptz;
 item record;missed integer=0;due_soon integer=0;visits integer=0;summaries integer=0;total integer;quiet integer;breakdown text;
begin
 if not pg_try_advisory_xact_lock(hashtext('hd_job_response')) then return '{"skipped":true}'::jsonb;end if;
 select * into s from public.crm_settings where id;
 workday=extract(isodow from today)::smallint=any(s.work_days);
 opens=(today+s.work_start) at time zone 'Asia/Karachi';
 closes=(today+s.work_end) at time zone 'Asia/Karachi';
 day_start=today::timestamp at time zone 'Asia/Karachi';
 for item in
  update public.leads l set missed_at=now()
  where l.deleted_at is null and l.assigned_agent is not null and l.first_call_at is null and l.missed_at is null
   and l.call_due_at<now() and l.status not in ('won','lost')
  returning l.id,l.lead_no,l.name,l.assigned_agent
 loop
  missed=missed+1;
  update public.assignments a set missed_at=now()
   where a.id=(select x.id from public.assignments x where x.lead_id=item.id order by x.created_at desc,x.id desc limit 1)
    and a.agent_id=item.assigned_agent and a.missed_at is null;
  perform public.push_notification(item.assigned_agent,'first_call_missed','day:'||today,'Missed first call: '||public.format_lead_no(item.lead_no),
   'Call '||item.name||' now. Your admin will decide whether to keep this lead with you or reassign it.','/leads/'||item.id,item.id,
   '%s first calls missed','Call them now. Your admin will decide whether to keep them with you or reassign them.','/leads?view=all&call=missed');
 end loop;
 if missed>0 then
  select sum(n)::integer,string_agg(format('%s: %s',name,n),' · ' order by n desc,name) into total,breakdown
  from (select p.name,count(*) n from public.lead_review_queue q join public.profiles p on p.id=q.assigned_agent where q.kind='missed' group by p.id,p.name) x;
  if total>0 then
   insert into public.notifications(user_id,type,group_key,title,body,link,item_count)
   select a.id,'missed_calls_review','day:'||today,format('Missed first calls: %s lead%s to review',total,case when total=1 then '' else 's' end),
    left(breakdown||'. Choose Keep or Reassign on the Overview.',500),'/?review=missed',total
   from public.profiles a where a.active and a.role='admin'
   on conflict(user_id,type,group_key) do update set title=excluded.title,body=excluded.body,item_count=excluded.item_count,updated_at=now(),read_at=null;
  end if;
 end if;
 if workday and now()>=closes-make_interval(mins=>s.first_call_grace_minutes) and now()<closes then
  insert into public.notifications(user_id,type,group_key,title,body,link,item_count)
  select l.assigned_agent,'calls_due_soon','day:'||today,
   format('%s lead%s need%s a first call today',count(*),case when count(*)=1 then '' else 's' end,case when count(*)=1 then 's' else '' end),
   'Call before '||to_char(closes at time zone 'Asia/Karachi','HH12:MI AM')||'. Missed first calls are reported to your admin.','/leads?view=all&call=uncalled',count(*)
  from public.active_leads l join public.profiles p on p.id=l.assigned_agent and p.active
  where l.first_call_at is null and l.call_due_at>now() and l.call_due_at<=closes and l.status not in ('won','lost')
  group by l.assigned_agent
  on conflict(user_id,type,group_key) do nothing;
  get diagnostics due_soon=row_count;
 end if;
 if now()>=closes then
  insert into public.notifications(user_id,type,group_key,title,body,link,item_count)
  select v.agent_id,'visit_tomorrow','day:'||(today+1),format('%s site visit%s tomorrow',count(*),case when count(*)=1 then '' else 's' end),
   'First at '||to_char(min(v.scheduled_at) at time zone 'Asia/Karachi','HH12:MI AM')||'. Confirm with your customers today.','/visits',count(*)
  from public.visits v join public.active_leads l on l.id=v.lead_id join public.profiles p on p.id=v.agent_id and p.active
  where v.status='scheduled' and v.scheduled_at>=((today+1)::timestamp at time zone 'Asia/Karachi') and v.scheduled_at<((today+2)::timestamp at time zone 'Asia/Karachi')
  group by v.agent_id
  on conflict(user_id,type,group_key) do nothing;
  get diagnostics visits=row_count;
 end if;
 if workday and now()>=closes then
  select coalesce(sum(n),0)::integer,count(*) filter(where n=0)::integer,string_agg(format('%s: %s call%s',name,n,case when n=1 then '' else 's' end),' · ' order by name)
   into total,quiet,breakdown
  from (select p.name,(select count(*) from public.calls c where c.agent_id=p.id and c.started_at>=day_start
   and exists(select 1 from public.active_leads l where l.id=c.lead_id)) n from public.profiles p where p.active and p.role='agent') x;
  if breakdown is not null then
   insert into public.notifications(user_id,type,group_key,title,body,link,item_count)
   select a.id,'daily_call_summary','day:'||today,format('Today''s calls: %s',total)||case when quiet>0 then format(' · %s agent%s made no calls',quiet,case when quiet=1 then '' else 's' end) else '' end,
    left(breakdown,500),'/',greatest(total,1)
   from public.profiles a where a.active and a.role='admin'
   on conflict(user_id,type,group_key) do nothing;
   get diagnostics summaries=row_count;
  end if;
 end if;
 return jsonb_build_object('affected',missed,'due_soon',due_soon,'visits',visits,'summaries',summaries);
end $$;

-- Jobs: the 7-day "stale" job no longer moves leads; idle leads join the
-- review list. Follow-up reminders also appear in the notification bell.
do $$ begin
 if to_regprocedure('public.run_crm_job_037(text,jsonb)') is null then
  alter function public.run_crm_job(text,jsonb) rename to run_crm_job_037;
 end if;
 if to_regprocedure('public.crm_metrics_037(uuid,timestamptz,timestamptz,uuid,text)') is null then
  alter function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text) rename to crm_metrics_037;
 end if;
end $$;
create or replace function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;n integer;
begin
 if p_job='stale' then
  -- Update 038: leads move only after an administrator's decision.
  return jsonb_build_object('affected',0,'disabled',true);
 elsif p_job='response' then
  return public.lead_response_job();
 end if;
 result=public.run_crm_job_037(p_job,p_settings);
 if p_job='followups' and not coalesce((result->>'skipped')::boolean,false) then
  insert into public.notifications(user_id,type,group_key,title,body,link,lead_id)
  select p.id,'followup_due','followup:'||f.id||':'||floor(extract(epoch from f.due_at))::bigint,'Follow-up due: '||public.format_lead_no(l.lead_no),
   left(l.name||' · '||public.format_pk_time(f.due_at),500),'/leads/'||l.id,l.id
  from public.followups f join public.active_leads l on l.id=f.lead_id join public.profiles p on p.id=coalesce(l.assigned_agent,f.agent_id)
  where p.active and f.status='pending' and f.due_at<=now()+interval '1 day'
  on conflict(user_id,type,group_key) do nothing;
  get diagnostics n=row_count;
  result=result||jsonb_build_object('notified',n);
 end if;
 return result;
end $$;
delete from public.job_heartbeats where job='reassignStaleLeads';
alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
alter table public.job_heartbeats add constraint job_heartbeats_job_check check(job in('deleteOldRecordings','reportInactiveLeadOwners','leadResponseCheck','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads'));
create or replace function public.system_status(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;fresh boolean;version integer;backup jsonb;last_run timestamptz;
begin
 perform id from public.profiles where id=p_actor and active and role='admin' for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 select max(v.version) into version from public.crm_schema_versions v;
 select jsonb_agg(jsonb_build_object('job',expected.job,'status',case when h.job is null then 'not_started' when h.last_run_at<=now()-interval '5 minutes' then 'stale' else h.last_status end,'last_success_at',h.last_success_at,'last_error_at',h.last_error_at,'last_run_at',h.last_run_at)),
 bool_and(h.job is not null and h.last_status='success' and h.last_run_at>now()-interval '5 minutes'),case when count(h.job)=8 then min(h.last_run_at) end
 into rows,fresh,last_run
 from unnest(array['deleteOldRecordings','reportInactiveLeadOwners','leadResponseCheck','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads']) expected(job)
 left join public.job_heartbeats h on h.job=expected.job;
 select jsonb_build_object('last_success_at',(select max(created_at) from public.backups where status='success'),
 'last_run_at',(select max(created_at) from public.backups),
 'status',coalesce((select status from public.backups order by created_at desc,id desc limit 1),'not_started')) into backup;
 return jsonb_build_object('ready',version=26 and coalesce(fresh,false),'migration',case when version=26 then 'current' else 'update_required' end,
 'installed_version',version,'jobs',rows,'last_job_at',last_run,'backup',backup);
end $$;

-- Overview metrics gain first-call measures for the same range and filters.
create or replace function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;scope uuid=p_agent;
begin
 result=public.crm_metrics_037(p_actor,p_from,p_to,p_agent,p_source);
 if exists(select 1 from public.profiles where id=p_actor and role='agent') then scope=p_actor;end if;
 return result||(select jsonb_build_object('first_calls',count(*),
   'on_time_first_calls',count(*) filter(where a.call_due_at is not null and a.first_call_at<=a.call_due_at),
   'first_calls_with_deadline',count(*) filter(where a.call_due_at is not null),
   'avg_first_call_minutes',round(avg(public.working_minutes(a.created_at,a.first_call_at))))
  from public.assignments a join public.active_leads l on l.id=a.lead_id
  where a.agent_id is not null and a.first_call_at>=p_from and a.first_call_at<p_to and (scope is null or a.agent_id=scope) and (p_source is null or l.source=p_source))
 ||(select jsonb_build_object('missed_in_period',count(*)) from public.assignments a join public.active_leads l on l.id=a.lead_id
  where a.missed_at>=p_from and a.missed_at<p_to and (scope is null or a.agent_id=scope) and (p_source is null or l.source=p_source))
 ||(select jsonb_build_object('uncalled_leads',count(*) filter(where l.call_due_at>=now()),'missed_first_calls',count(*) filter(where l.call_due_at<now()))
  from public.active_leads l where l.assigned_agent is not null and l.first_call_at is null and l.call_due_at is not null and l.status not in ('won','lost')
   and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source));
end $$;

-- Admin review list with decisions. Reassignment reuses the audited bulk path.
create or replace function public.lead_review_page(p_actor uuid,p_kind text,p_page integer,p_limit integer,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.crm_settings;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if p_kind is null or p_kind not in ('missed','idle') or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid review filter' using errcode='22023';end if;
 select * into s from public.crm_settings where id;
 with queue as (
  select q.kind,q.since,l.id,l.lead_no,l.name,l.status,l.source,l.preferred_location,l.assigned_agent,p.name agent_name,p.uid agent_uid,
   l.assigned_at,l.call_due_at,l.last_activity_at
  from public.lead_review_queue q join public.active_leads l on l.id=q.id join public.profiles p on p.id=q.assigned_agent
  where p_agent is null or q.assigned_agent=p_agent
 ), chosen as (select * from queue where kind=p_kind),
 page as (select * from chosen order by since,lead_no limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page)-'kind'-'since' order by since,lead_no) from page),'[]'::jsonb),
  'count',(select count(*) from chosen),'page',p_page,'limit',p_limit,'idle_days',s.idle_days,
  'counts',jsonb_build_object('missed',(select count(*) from queue where kind='missed'),'idle',(select count(*) from queue where kind='idle'))) into result;
 return result;
end $$;
create or replace function public.review_keep_leads(p_actor uuid,p_lead_ids uuid[],p_kind text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.crm_settings;item public.leads;due timestamptz;kept integer=0;skipped integer=0;rows jsonb='[]'::jsonb;grp text='tx:'||txid_current()::text;label text;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if p_kind is null or p_kind not in ('missed','idle') or p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500
  or (select count(distinct x) from unnest(p_lead_ids) x)<>cardinality(p_lead_ids) then
  raise exception 'Choose 1–500 leads to keep' using errcode='22023';end if;
 select * into s from public.crm_settings where id;
 for item in select * from public.active_leads where id=any(p_lead_ids) order by id for update loop
  label=public.format_lead_no(item.lead_no);
  if not exists(select 1 from public.lead_review_queue q where q.id=item.id and q.kind=p_kind) then
   skipped=skipped+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item.id,'result','skipped','reason','No longer needs review'));
  elsif p_kind='missed' then
   due=public.first_call_due(now());
   update public.leads set call_due_at=due,missed_at=null where id=item.id;
   perform public.push_notification(item.assigned_agent,'lead_kept',grp,'Kept with you: '||label,
    'Your admin kept '||item.name||' with you. Make the first call by '||public.format_pk_time(due)||'.','/leads/'||item.id,item.id,
    '%s leads kept with you','Your admin kept them with you. Make the first calls by '||public.format_pk_time(due)||'.','/leads?view=all&call=uncalled');
   insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'lead.review_kept','leads',item.id::text,p_request,jsonb_build_object('kind',p_kind,'agent_id',item.assigned_agent,'call_due_at',due));
   kept=kept+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item.id,'result','kept'));
  else
   update public.leads set idle_kept_until=now()+make_interval(days=>s.idle_days) where id=item.id;
   perform public.push_notification(item.assigned_agent,'lead_kept',grp,'Kept with you: '||label,
    'Your admin kept '||item.name||' with you. Contact the customer and log an update within '||s.idle_days||' days.','/leads/'||item.id,item.id,
    '%s leads kept with you','Your admin kept them with you. Contact these customers and log updates within '||s.idle_days||' days.','/leads?view=all');
   insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'lead.review_kept','leads',item.id::text,p_request,jsonb_build_object('kind',p_kind,'agent_id',item.assigned_agent,'idle_days',s.idle_days));
   kept=kept+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item.id,'result','kept'));
  end if;
 end loop;
 select skipped+count(*),rows||coalesce(jsonb_agg(jsonb_build_object('id',x,'result','skipped','reason','Lead not found')),'[]'::jsonb) into skipped,rows
 from unnest(p_lead_ids) x where not exists(select 1 from public.active_leads where id=x);
 return jsonb_build_object('kept',kept,'skipped',skipped,'results',rows);
end $$;
create or replace function public.review_reassign_leads(p_actor uuid,p_lead_ids uuid[],p_kind text,p_mode text,p_agent uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_kind is null or p_kind not in ('missed','idle') or p_mode is null or p_mode not in ('agent','unassign') then
  raise exception 'Choose an agent or Unassigned for the reviewed leads' using errcode='22023';end if;
 perform set_config('hd.assignment_reason',case p_kind when 'missed' then 'missed_first_call' else 'no_activity' end,true);
 result=public.assign_leads_bulk(p_lead_ids,p_actor,p_mode,p_agent,p_request);
 perform set_config('hd.assignment_reason','',true);
 return result;
end $$;
-- Today's calling per agent (agents see only their own row).
create or replace function public.call_activity(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;s public.crm_settings;today date=(now() at time zone 'Asia/Karachi')::date;day_start timestamptz;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 select * into s from public.crm_settings where id;
 day_start=today::timestamp at time zone 'Asia/Karachi';
 select jsonb_build_object('date',today,'is_workday',extract(isodow from today)::smallint=any(s.work_days),
  'work_start',to_char(s.work_start,'HH24:MI'),'work_end',to_char(s.work_end,'HH24:MI'),'idle_days',s.idle_days,
  'agents',coalesce(jsonb_agg(x.data order by x.name,x.id),'[]'::jsonb)) into result
 from (select p.id,p.name,jsonb_build_object('agent_id',p.id,'name',p.name,'uid',p.uid,
   'calls_today',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.started_at>=day_start),
   'connected_today',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.started_at>=day_start and c.status='completed'),
   'first_calls_today',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.first_call_at>=day_start),
   'assigned_today',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.created_at>=day_start),
   'waiting',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.first_call_at is null and l.call_due_at>=now() and l.status not in ('won','lost')),
   'missed',(select count(*) from public.lead_review_queue q where q.assigned_agent=p.id and q.kind='missed'),
   'idle',(select count(*) from public.lead_review_queue q where q.assigned_agent=p.id and q.kind='idle'),
   'followups_due_today',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id where l.assigned_agent=p.id and f.status='pending' and f.due_at>=now() and f.due_at<day_start+interval '1 day'),
   'followups_overdue',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id where l.assigned_agent=p.id and f.status='pending' and f.due_at<now())) data
  from public.profiles p where p.active and p.role='agent' and (actor.role='admin' or p.id=p_actor)) x;
 return result;
end $$;
-- An agent's leads still waiting for a first call, without contact numbers
-- (so the dashboard never counts as a phone-number view).
create or replace function public.first_call_queue(p_actor uuid,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023';end if;
 with queue as (
  select l.id,l.lead_no,l.name,l.status,l.assigned_agent,l.call_due_at,l.first_call_at,l.call_due_at<now() missed
  from public.active_leads l
  where l.assigned_agent=p_actor and l.first_call_at is null and l.call_due_at is not null and l.status not in ('won','lost')
 ), page as (select * from queue order by call_due_at,lead_no limit p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by call_due_at,lead_no) from page),'[]'::jsonb),
  'waiting',(select count(*) from queue where not missed),'missed',(select count(*) from queue where missed)) into result;
 return result;
end $$;
create or replace function public.work_settings(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.crm_settings;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 select * into s from public.crm_settings where id;
 return jsonb_build_object('work_days',to_jsonb(s.work_days),'work_start',to_char(s.work_start,'HH24:MI'),'work_end',to_char(s.work_end,'HH24:MI'),
  'first_call_grace_minutes',s.first_call_grace_minutes,'idle_days',s.idle_days,'updated_at',s.updated_at);
end $$;
create or replace function public.save_work_settings(p_actor uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare days smallint[];
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['work_days','work_start','work_end','first_call_grace_minutes','idle_days'])<>'{}'::jsonb
  or jsonb_typeof(p_data->'work_days') is distinct from 'array' or jsonb_array_length(p_data->'work_days') not between 1 and 7
  or exists(select 1 from jsonb_array_elements(p_data->'work_days') d where jsonb_typeof(d)<>'number' or d::text not in ('1','2','3','4','5','6','7'))
  or coalesce(p_data->>'work_start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_data->>'work_end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or jsonb_typeof(p_data->'first_call_grace_minutes') is distinct from 'number' or jsonb_typeof(p_data->'idle_days') is distinct from 'number' then
  raise exception 'Invalid working hours' using errcode='22023';end if;
 select array_agg(distinct d::smallint order by d::smallint) into days from jsonb_array_elements_text(p_data->'work_days') d;
 update public.crm_settings set work_days=days,work_start=(p_data->>'work_start')::time,work_end=(p_data->>'work_end')::time,
  first_call_grace_minutes=(p_data->>'first_call_grace_minutes')::integer,idle_days=(p_data->>'idle_days')::integer,updated_at=now(),updated_by=p_actor
 where id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'settings.work_hours_updated','crm_settings','work_hours',p_request,jsonb_build_object('fields',jsonb_build_array('work_days','work_start','work_end','first_call_grace_minutes','idle_days')));
 return public.work_settings(p_actor);
end $$;
-- Notification inbox for the signed-in user only.
create or replace function public.notifications_page(p_actor uuid,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023';end if;
 with visible as (
  select n.id,n.type,n.title,n.body,n.link,n.lead_id,n.item_count,n.created_at,n.updated_at,n.read_at
  from public.notifications n left join public.leads l on l.id=n.lead_id
  where n.user_id=p_actor and (n.lead_id is null or l.deleted_at is null)
 ), page as (select * from visible order by updated_at desc,id limit p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by updated_at desc,id) from page),'[]'::jsonb),
  'unread',(select count(*) from visible where read_at is null)) into result;
 return result;
end $$;
create or replace function public.read_notifications(p_actor uuid,p_ids uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_ids is not null and cardinality(p_ids) not between 1 and 100 then raise exception 'Invalid notifications' using errcode='22023';end if;
 update public.notifications set read_at=now() where user_id=p_actor and read_at is null and (p_ids is null or id=any(p_ids));
 get diagnostics n=row_count;
 return jsonb_build_object('read',n);
end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('format_pk_time','first_call_due','working_minutes','push_notification','track_lead_owner','notify_lead_owner','stamp_assignment','record_first_call',
  'lead_response_job','run_crm_job','run_crm_job_037','system_status','crm_metrics','crm_metrics_037','lead_review_page','review_keep_leads',
  'review_reassign_leads','call_activity','first_call_queue','work_settings','save_work_settings','notifications_page','read_notifications') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
