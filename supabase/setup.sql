-- HD Marketing CRM: first-time setup for a fresh Supabase project.
-- Run the entire file together in SQL Editor. No passwords or Auth users are included.
-- A transaction rolls back the setup if any statement fails.
BEGIN;
DO $$ BEGIN IF to_regclass('public.profiles') IS NOT NULL THEN RAISE EXCEPTION 'A profiles table already exists. Stop and review the existing database before running first-time setup.'; END IF; END $$;

-- Migration: 001_users_and_roles.sql

create extension if not exists pgcrypto;
create table public.profiles (id uuid primary key references auth.users(id), name text not null, role text not null default 'agent' check(role in ('admin','agent')), active boolean not null default true, created_at timestamptz not null default now());
create schema if not exists crm_private;
revoke all on schema crm_private from public, anon, authenticated;
grant usage on schema crm_private to service_role;
create function public.create_profile() returns trigger language plpgsql security definer set search_path = '' as $$ begin insert into public.profiles(id,name) values(new.id,coalesce(new.raw_user_meta_data->>'name', 'Team member')); return new; end $$;
create trigger auth_profile after insert on auth.users for each row execute function public.create_profile();
revoke all on function public.create_profile() from public,anon,authenticated;
create function public.touch_updated() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;


-- Migration: 002_leads.sql

create table public.leads(id uuid primary key default gen_random_uuid(),name text not null check(length(name)>0),masked_phone text not null,email text,source text not null default 'manual' check(source in ('manual','CSV','Meta','WhatsApp','other')),property_id uuid, budget_min numeric not null default 0 check(budget_min>=0),budget_max numeric check(budget_max>=budget_min),preferred_location text,assigned_agent uuid references public.profiles(id),status text not null default 'new' check(status in ('new','contacted','interested','follow_up','site_visit','negotiation','won','lost')),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),last_activity_at timestamptz not null default now());
create table crm_private.lead_phones(lead_id uuid primary key references public.leads(id) on delete cascade,phone text not null unique);
create table public.assignments(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads(id),agent_id uuid references public.profiles(id),actor_id uuid references public.profiles(id),created_at timestamptz not null default now());
create table public.notes(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads(id),agent_id uuid not null references public.profiles(id),body text not null,created_at timestamptz not null default now());
create index leads_agent_status on public.leads(assigned_agent,status);
create index leads_created on public.leads(created_at);
create index leads_activity on public.leads(last_activity_at);
create index leads_search on public.leads using gin(to_tsvector('simple',name));


-- Migration: 003_calls.sql

create table public.calls(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads(id),agent_id uuid not null references public.profiles(id),provider_call_id text unique,status text not null default 'initiated' check(status in ('initiated','ringing','completed','failed')),started_at timestamptz not null default now(),ended_at timestamptz,duration_seconds integer not null default 0 check(duration_seconds>=0),outcome text check(outcome in ('No answer','Busy','Wrong number','Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion')),notes text,deal_tags text[] not null default '{}',outcome_submitted_at timestamptz,missing_outcome boolean not null default false,created_at timestamptz not null default now());
create table crm_private.recordings(call_id uuid primary key references public.calls(id),storage_path text,provider_ref text,created_at timestamptz not null default now(),deleted_at timestamptz,deletion_attempts int not null default 0,last_error text);
create index calls_agent_started on public.calls(agent_id,started_at);


-- Migration: 004_properties.sql

create table public.properties(id uuid primary key default gen_random_uuid(),title text not null,description text not null default '',location text not null,price numeric not null check(price>=0),type text not null,area numeric not null check(area>0),area_unit text not null check(area_unit in ('sq ft','marla','kanal')),availability text not null default 'available' check(availability in ('available','reserved','sold','archived')),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
alter table public.leads add constraint leads_property foreign key(property_id) references public.properties(id);
create table public.property_photos(id uuid primary key default gen_random_uuid(),property_id uuid not null references public.properties(id),storage_path text not null unique,created_at timestamptz not null default now());
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('property-photos','property-photos',false,5242880,array['image/jpeg','image/png','image/webp']),('recordings','recordings',false,52428800,array['audio/mpeg','audio/wav','audio/ogg']) on conflict(id) do nothing;


-- Migration: 005_targets.sql

create table public.targets(id uuid primary key default gen_random_uuid(),agent_id uuid not null references public.profiles(id),month date not null check(extract(day from month)=1),calls int not null default 0 check(calls>=0),visits int not null default 0 check(visits>=0),deals int not null default 0 check(deals>=0),revenue numeric not null default 0 check(revenue>=0),unique(agent_id,month));


-- Migration: 006_followups_and_visits.sql

create table public.followups(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads(id),agent_id uuid not null references public.profiles(id),due_at timestamptz not null,notes text,status text not null default 'pending' check(status in ('pending','completed','cancelled')),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.visits(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads(id),property_id uuid not null references public.properties(id),agent_id uuid not null references public.profiles(id),scheduled_at timestamptz not null,status text not null default 'scheduled' check(status in ('scheduled','completed','cancelled','no-show')),notes text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.reminders(id uuid primary key default gen_random_uuid(),agent_id uuid not null references public.profiles(id),followup_id uuid not null references public.followups(id),due_at timestamptz not null,read_at timestamptz,created_at timestamptz not null default now(),unique(followup_id,due_at));
create index followups_due on public.followups(agent_id,status,due_at);
create index visits_scheduled on public.visits(agent_id,scheduled_at);


-- Migration: 007_deals.sql

create table public.deals(id uuid primary key default gen_random_uuid(),lead_id uuid not null unique references public.leads(id),property_id uuid not null references public.properties(id),agent_id uuid not null references public.profiles(id),stage text not null check(stage in ('discussion','negotiation','won','lost')),expected_value numeric not null check(expected_value>=0),close_date date,notes text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(stage<>'won' or close_date is not null));
create index deals_agent_close on public.deals(agent_id,close_date);


-- Migration: 008_audit_log.sql

create table public.audit_log(id bigint generated always as identity primary key,actor_id uuid references public.profiles(id),action text not null,entity text not null,entity_id text,request_id text,metadata jsonb not null default '{}',created_at timestamptz not null default now());
create table public.integration_events(provider text not null,event_id text not null,created_at timestamptz not null default now(),primary key(provider,event_id));
create function public.block_audit_changes() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Audit records are append-only'; end $$;
create trigger audit_immutable before update or delete on public.audit_log for each row execute function public.block_audit_changes();


-- Migration: 009_row_level_security.sql

-- Browser roles have no direct CRM grants: API enforces role and ownership.
-- In particular, the phone vault and recordings are never exposed in public REST.
do $$ declare t text; begin foreach t in array array['profiles','leads','assignments','notes','calls','properties','property_photos','targets','followups','visits','reminders','deals','audit_log','integration_events'] loop execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated',t); end loop; end $$;
revoke all on all tables in schema crm_private from public,anon,authenticated;
grant all on all tables in schema public,crm_private to service_role;
grant usage,select on all sequences in schema public to service_role;
-- No browser storage policies. Only authorized server routes issue signed URLs.
create function public.private_phone(p_lead uuid) returns text language sql security definer set search_path='' as $$ select phone from crm_private.lead_phones where lead_id=p_lead $$;
revoke all on function public.private_phone(uuid) from public,anon,authenticated;
grant execute on function public.private_phone(uuid) to service_role;


-- Migration: 010_atomic_operations.sql

create function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare chosen uuid; begin
perform pg_advisory_xact_lock(873420);
if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then raise exception 'Forbidden' using errcode='42501'; end if;
perform 1 from public.leads where id=p_lead for update; if not found then raise exception 'Lead not found'; end if;
chosen=p_agent;
if chosen is null then select p.id into chosen from public.profiles p left join public.assignments a on a.agent_id=p.id where p.active and p.role='agent' group by p.id order by max(a.created_at) nulls first,p.id limit 1; end if;
if chosen is null or not exists(select 1 from public.profiles where id=chosen and active and role='agent') then raise exception 'No active agent'; end if;
update public.leads set assigned_agent=chosen,updated_at=now(),last_activity_at=now() where id=p_lead;
insert into public.assignments(lead_id,agent_id,actor_id) values(p_lead,chosen,p_actor);
insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'assign','leads',p_lead::text,p_request,jsonb_build_object('agent_id',chosen));
return chosen; end $$;

create function public.create_lead(p_data jsonb,p_phone text,p_actor uuid,p_request text) returns public.leads language plpgsql security definer set search_path='' as $$
declare result public.leads; begin
if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then raise exception 'Forbidden' using errcode='42501'; end if;
insert into public.leads(name,masked_phone,email,source,property_id,budget_min,budget_max,preferred_location) values(p_data->>'name',left(p_phone,3)||'******'||right(p_phone,3),nullif(p_data->>'email',''),coalesce(p_data->>'source','manual'),nullif(p_data->>'property_id','')::uuid,coalesce((p_data->>'budget_min')::numeric,0),(p_data->>'budget_max')::numeric,p_data->>'preferred_location') returning * into result;
insert into crm_private.lead_phones(lead_id,phone) values(result.id,p_phone);
insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'create','leads',result.id::text,p_request);
if p_data ? 'assigned_agent' and p_data->>'assigned_agent' is not null then perform public.assign_lead(result.id,p_actor,(p_data->>'assigned_agent')::uuid,p_request); select * into result from public.leads where id=result.id; end if;
return result; end $$;

create function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; lead uuid; existing jsonb; result jsonb; cols text; vals text; sets text; allowed text[]; k text; begin
select * into actor from public.profiles where id=p_actor and active;
if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
if p_table not in ('leads','notes','calls','followups','visits','deals','properties','targets','profiles') then raise exception 'Invalid entity'; end if;
if p_table in ('properties','targets','profiles') and actor.role<>'admin' then raise exception 'Forbidden' using errcode='42501'; end if;
if p_id is not null then execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_table) into existing using p_id; if existing is null then raise exception 'Not found' using errcode='P0002'; end if; end if;
if p_table='leads' then lead=p_id;
elsif p_table in ('notes','calls','followups','visits','deals') then lead=coalesce((existing->>'lead_id')::uuid,(p_data->>'lead_id')::uuid); end if;
if lead is not null then perform 1 from public.leads where id=lead and (actor.role='admin' or assigned_agent=p_actor) for update; if not found then raise exception 'Forbidden' using errcode='42501'; end if; end if;
allowed=case p_table when 'leads' then case when actor.role='admin' then array['name','email','status','source','property_id','budget_min','budget_max','preferred_location'] else array['status'] end when 'notes' then array['lead_id','agent_id','body'] when 'calls' then array['lead_id','agent_id','provider_call_id','status','ended_at','duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome'] when 'followups' then array['lead_id','agent_id','due_at','notes','status'] when 'visits' then array['lead_id','agent_id','property_id','scheduled_at','status','notes'] when 'deals' then array['lead_id','agent_id','property_id','stage','expected_value','close_date','notes'] when 'properties' then array['title','description','location','price','type','area','area_unit','availability'] when 'targets' then array['agent_id','month','calls','visits','deals','revenue'] when 'profiles' then array['name','active'] end;
if p_table in ('notes','calls','followups','visits','deals') then
 if p_id is null then p_data=p_data||jsonb_build_object('agent_id',coalesce((select assigned_agent from public.leads where id=lead),p_actor));
 else p_data=p_data-'lead_id'-'agent_id'; end if;
end if;
for k in select jsonb_object_keys(p_data) loop if not k=any(allowed) then raise exception 'Field forbidden' using errcode='42501'; end if; end loop;
select string_agg(format('%I',key),','),string_agg(format('r.%I',key),','),string_agg(format('%I=r.%I',key,key),',') into cols,vals,sets from jsonb_object_keys(p_data) key;
if cols is null then raise exception 'Empty change'; end if;
if p_id is null then execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_table,cols,vals,p_table,p_table) into result using p_data;
else execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t.*)',p_table,sets,p_table) into result using p_data,p_id; end if;
if lead is not null then update public.leads set last_activity_at=now(),updated_at=now() where id=lead; end if;
insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,case when p_id is null then 'create' else 'update' end,p_table,result->>'id',p_request,jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
return result; end $$;

create function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result jsonb; begin
select * into actor from public.profiles where id=p_actor and active;
if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
if actor.role='agent' then p_agent=p_actor; end if;
with eligible as (select * from public.leads where (p_agent is null or assigned_agent=p_agent) and (p_source is null or source=p_source)),
l as (select * from eligible where created_at>=p_from and created_at<p_to),
c as (select c.* from public.calls c join eligible l on l.id=c.lead_id where (p_agent is null or c.agent_id=p_agent) and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
v as (select v.* from public.visits v join eligible l on l.id=v.lead_id where (p_agent is null or v.agent_id=p_agent) and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to),
d as (select d.* from public.deals d join eligible l on l.id=d.lead_id where (p_agent is null or d.agent_id=p_agent) and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date)
select jsonb_build_object('assigned_leads',(select count(*) from eligible),'today_completed_calls',(select count(*) from public.calls c join eligible l on l.id=c.lead_id where c.status='completed' and (p_agent is null or c.agent_id=p_agent) and (c.ended_at at time zone 'Asia/Karachi')::date=(now() at time zone 'Asia/Karachi')::date),'leads',(select count(*) from l),'completed_calls',(select count(*) from c),'completed_visits',(select count(*) from v),'won_deals',(select count(*) from d),'revenue',(select coalesce(sum(expected_value),0) from d),'active_agents',(select count(*) from public.profiles where active and role='agent'),'due_followups',(select count(*) from public.followups f join eligible l on l.id=f.lead_id where f.status='pending' and f.due_at>=date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi' and f.due_at<=now()+interval '1 day'),'overdue_followups',(select count(*) from public.followups f join eligible l on l.id=f.lead_id where f.status='pending' and f.due_at<now()),'scheduled_visits',(select count(*) from public.visits v join eligible l on l.id=v.lead_id where v.status='scheduled' and v.scheduled_at>=now()),'by_status',(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from l group by status) s),'by_source',(select coalesce(jsonb_object_agg(source,n),'{}') from (select source,count(*) n from l group by source) s)) into result;
return result; end $$;

create function public.crm_leaderboard(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501'; end if;
select coalesce(jsonb_agg(jsonb_build_object('name',p.name,'won_deals',(select count(*) from public.deals d where d.agent_id=p.id and stage='won' and close_date>=(p_from at time zone 'Asia/Karachi')::date and close_date<(p_to at time zone 'Asia/Karachi')::date),'completed_calls',(select count(*) from public.calls c where c.agent_id=p.id and status='completed' and ended_at>=p_from and ended_at<p_to))),'[]') into result from public.profiles p where p.active and p.role='agent'; return result; end $$;

do $$ declare f record; begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('assign_lead','create_lead','crm_mutate','crm_metrics','crm_leaderboard') loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); execute format('grant execute on function %s to service_role',f.signature); end loop; end $$;

do $$ declare t text; begin foreach t in array array['leads','properties','followups','visits','deals'] loop execute format('create trigger touch_updated before update on public.%I for each row execute function public.touch_updated()',t); end loop; end $$;


-- Migration: 011_jobs_and_events.sql

alter table public.targets add column created_at timestamptz not null default now();
create function public.apply_call_event(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.calls; begin
select * into c from public.calls where provider_call_id=p_event->>'provider_call_id' for update;
if c.id is null then raise exception 'Unknown call'; end if;
insert into public.integration_events(provider,event_id) values('mock',p_event->>'event_id') on conflict do nothing;
if not found then return '{"duplicate":true}'::jsonb; end if;
if c.status not in ('completed','failed') then update public.calls set status=p_event->>'status',ended_at=case when p_event->>'status' in ('completed','failed') then coalesce((p_event->>'ended_at')::timestamptz,now()) else ended_at end,duration_seconds=coalesce((p_event->>'duration_seconds')::int,duration_seconds) where id=c.id; end if;
insert into public.audit_log(action,entity,entity_id,metadata) values('webhook','calls',c.id::text,jsonb_build_object('event_id',p_event->>'event_id'));
return '{"accepted":true}'::jsonb; end $$;
create function public.recording_access(p_call uuid) returns jsonb language sql security definer set search_path='' as $$ select jsonb_build_object('storage_path',storage_path) from crm_private.recordings where call_id=p_call and deleted_at is null and created_at>now()-interval '7 days' $$;
create function public.recording_batch(p_days int default 7) returns jsonb language sql security definer set search_path='' as $$ select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select * from crm_private.recordings where deleted_at is null and created_at<=now()-make_interval(days=>least(7,greatest(1,p_days))) order by created_at limit 100) r $$;
create function public.recording_deleted(p_call uuid,p_error text default null) returns void language plpgsql security definer set search_path='' as $$ begin
update crm_private.recordings set deletion_attempts=deletion_attempts+1,last_error=p_error,deleted_at=case when p_error is null then now() else null end where call_id=p_call and deleted_at is null;
if found then insert into public.audit_log(action,entity,entity_id,metadata) values(case when p_error is null then 'recording_deleted' else 'recording_delete_failed' end,'calls',p_call::text,jsonb_build_object('retry_required',p_error is not null)); end if; end $$;
create function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n int; stale_lead record; admin_id uuid; begin
if not pg_try_advisory_xact_lock(hashtext('hd_job_'||p_job)) then return '{"skipped":true}'::jsonb; end if;
if p_job='followups' then
insert into public.reminders(agent_id,followup_id,due_at) select l.assigned_agent,f.id,f.due_at from public.followups f join public.leads l on l.id=f.lead_id join public.profiles p on p.id=l.assigned_agent where p.active and f.status='pending' and f.due_at<=now()+interval '1 day' on conflict(followup_id,due_at) do nothing; get diagnostics n=row_count;
elsif p_job='outcomes' then update public.calls set missing_outcome=true where status='completed' and outcome_submitted_at is null and not missing_outcome and ended_at<now()-make_interval(mins=>coalesce((p_settings->>'grace_minutes')::int,30));get diagnostics n=row_count;
elsif p_job='stale' then
perform pg_advisory_xact_lock(873420);
select id into admin_id from public.profiles where role='admin' and active order by id limit 1;n=0;
if admin_id is not null then for stale_lead in select id from public.leads l where status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;
do $$ declare f record; begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('apply_call_event','recording_access','recording_batch','recording_deleted','run_crm_job') loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); execute format('grant execute on function %s to service_role',f.signature);end loop;end $$;


-- Migration: 012_pipeline_and_lost_reasons.sql

-- F1. Apply once to the existing hosted project; do not rerun setup.sql.


alter table public.leads
  add column lost_reason text,
  add column lost_note text,
  add column lost_at timestamptz;
alter table public.deals
  add column lost_reason text,
  add column lost_note text;

create table public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id),
  lost_reason text,
  request_id text,
  created_at timestamptz not null default now()
);
create index lead_status_history_lead_created
  on public.lead_status_history(lead_id,created_at desc);
alter table public.lead_status_history enable row level security;
revoke all on public.lead_status_history from public,anon,authenticated;
grant all on public.lead_status_history to service_role;
create index leads_lost_reason on public.leads(lost_reason) where status='lost';

-- Preserve existing records without inventing a historical reason.
with changed as (
  update public.leads set lost_reason='other',
    lost_note='Reason not recorded before the pipeline upgrade; loss time uses the previous update time.',
    lost_at=updated_at where status='lost' returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'pipeline_backfill','leads',id::text,'migration:012',
    jsonb_build_object('fields',jsonb_build_array('lost_reason','lost_note','lost_at')) from changed;
with changed as (
  update public.deals set lost_reason='other',
    lost_note='Reason not recorded before the pipeline upgrade.' where stage='lost' returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'pipeline_backfill','deals',id::text,'migration:012',
    jsonb_build_object('fields',jsonb_build_array('lost_reason','lost_note')) from changed;

alter table public.leads drop constraint leads_status_check;
with previous as (
  select id,status as from_status,
    case status when 'follow_up' then 'contacted' when 'site_visit' then 'visit_scheduled' end as to_status
  from public.leads where status in ('follow_up','site_visit')
), changed as (
  update public.leads l set status=p.to_status from previous p where l.id=p.id
  returning l.id,p.from_status,p.to_status
)
insert into public.lead_status_history(lead_id,from_status,to_status,request_id)
  select id,from_status,to_status,'migration:012' from changed;
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'status_change','leads',lead_id::text,request_id,
    jsonb_build_object('from_status',from_status,'to_status',to_status,'fields',jsonb_build_array('status'))
  from public.lead_status_history where request_id='migration:012';

alter table public.leads
  add constraint leads_status_check check(status in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost')),
  add constraint leads_lost_reason_check check(lost_reason in ('price','location','budget','not_interested','no_response','bought_elsewhere','wrong_number','other')),
  add constraint leads_lost_note_check check(char_length(lost_note)<=500),
  add constraint leads_lost_requires_reason check(status<>'lost' or lost_reason is not null);
alter table public.deals
  add constraint deals_lost_reason_check check(lost_reason in ('price','location','budget','not_interested','no_response','bought_elsewhere','wrong_number','other')),
  add constraint deals_lost_note_check check(char_length(lost_note)<=500),
  add constraint deals_lost_requires_reason check(stage<>'lost' or lost_reason is not null);

create function public.prepare_lead_status() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status='lost' then
    if new.lost_reason is null then
      raise exception 'Lost leads require a reason' using errcode='23514';
    end if;
    if tg_op='INSERT' then new.lost_at=now();
    elsif old.status<>'lost' then new.lost_at=now();
    else new.lost_at=old.lost_at; end if;
  else
    new.lost_reason=null; new.lost_note=null; new.lost_at=null;
  end if;
  return new;
end $$;
create trigger prepare_lead_status before insert or update of status,lost_reason,lost_note
  on public.leads for each row execute function public.prepare_lead_status();

create function public.record_lead_status_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor uuid; request text; fields jsonb;
begin
  if old.status is not distinct from new.status then return new; end if;
  actor=nullif(current_setting('hd.actor_id',true),'')::uuid;
  request=nullif(current_setting('hd.request_id',true),'');
  fields=coalesce(nullif(current_setting('hd.changed_fields',true),'')::jsonb,'["status"]'::jsonb);
  insert into public.lead_status_history(lead_id,from_status,to_status,actor_id,lost_reason,request_id)
    values(new.id,old.status,new.status,actor,new.lost_reason,request);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(actor,'status_change','leads',new.id::text,request,
      jsonb_build_object('from_status',old.status,'to_status',new.status,'fields',fields));
  return new;
end $$;
create trigger record_lead_status_change after update of status on public.leads
  for each row execute function public.record_lead_status_change();

create function public.advance_lead_status(
  p_lead uuid,p_status text,p_actor uuid,p_request text,
  p_reason text default null,p_note text default null
) returns void language plpgsql security definer set search_path='' as $$
declare current_lead public.leads; stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'];
begin
  select * into current_lead from public.leads where id=p_lead for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  -- A null actor is reserved for the trusted, signed provider event boundary.
  if p_actor is not null and not exists(
    select 1 from public.profiles where id=p_actor and active
      and (role='admin' or current_lead.assigned_agent=p_actor)
  ) then raise exception 'Forbidden' using errcode='42501'; end if;
  if array_position(stages,p_status) is null then raise exception 'Invalid stage' using errcode='23514'; end if;
  if p_status='lost' and p_reason is null then raise exception 'Lost leads require a reason' using errcode='23514'; end if;
  -- Automated activity cannot reopen a terminal lead or move it backwards.
  if current_lead.status in ('won','lost') or
    array_position(stages,p_status)<=array_position(stages,current_lead.status) then return; end if;
  perform set_config('hd.actor_id',coalesce(p_actor::text,''),true);
  perform set_config('hd.request_id',coalesce(p_request,''),true);
  perform set_config('hd.changed_fields','["status"]',true);
  update public.leads set status=p_status,lost_reason=p_reason,lost_note=p_note,
    last_activity_at=now() where id=p_lead;
end $$;

create or replace function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; lead uuid; existing jsonb; result jsonb;
  cols text; vals text; sets text; allowed text[]; k text; stage text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_table not in ('leads','notes','calls','followups','visits','deals','properties','targets','profiles') then raise exception 'Invalid entity'; end if;
  if p_table in ('properties','targets','profiles') and actor.role<>'admin' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_table) into existing using p_id;
    if existing is null then raise exception 'Not found' using errcode='P0002'; end if;
  end if;
  if p_table='leads' then lead=p_id;
  elsif p_table in ('notes','calls','followups','visits','deals') then lead=coalesce((existing->>'lead_id')::uuid,(p_data->>'lead_id')::uuid); end if;
  if lead is not null then
    perform 1 from public.leads where id=lead and (actor.role='admin' or assigned_agent=p_actor) for update;
    if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  end if;
  allowed=case p_table
    when 'leads' then case when actor.role='admin' then array['name','email','status','source','property_id','budget_min','budget_max','preferred_location','lost_reason','lost_note'] else array['status','lost_reason','lost_note'] end
    when 'notes' then array['lead_id','agent_id','body']
    when 'calls' then array['lead_id','agent_id','provider_call_id','status','ended_at','duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome']
    when 'followups' then array['lead_id','agent_id','due_at','notes','status']
    when 'visits' then array['lead_id','agent_id','property_id','scheduled_at','status','notes']
    when 'deals' then array['lead_id','agent_id','property_id','stage','expected_value','close_date','notes','lost_reason','lost_note']
    when 'properties' then array['title','description','location','price','type','area','area_unit','availability']
    when 'targets' then array['agent_id','month','calls','visits','deals','revenue']
    when 'profiles' then array['name','active'] end;
  if p_table in ('notes','calls','followups','visits','deals') then
    if p_id is null then p_data=p_data||jsonb_build_object('agent_id',coalesce((select assigned_agent from public.leads where id=lead),p_actor));
    else p_data=p_data-'lead_id'-'agent_id'; end if;
  end if;
  for k in select jsonb_object_keys(p_data) loop
    if not k=any(allowed) then raise exception 'Field forbidden' using errcode='42501'; end if;
  end loop;
  if p_data='{}'::jsonb then raise exception 'Empty change'; end if;
  -- Clearing a lost deal must not retain an obsolete reason on the deal record.
  if p_table='deals' and coalesce(p_data->>'stage',existing->>'stage')<>'lost' then
    p_data=p_data||jsonb_build_object('lost_reason',null,'lost_note',null);
  end if;
  perform set_config('hd.actor_id',p_actor::text,true);
  perform set_config('hd.request_id',coalesce(p_request,''),true);
  perform set_config('hd.changed_fields',to_jsonb(array(select jsonb_object_keys(p_data)))::text,true);
  select string_agg(format('%I',key),','),string_agg(format('r.%I',key),','),string_agg(format('%I=r.%I',key,key),',')
    into cols,vals,sets from jsonb_object_keys(p_data) key;
  if cols is null then raise exception 'Empty change'; end if;
  if p_id is null then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_table,cols,vals,p_table,p_table) into result using p_data;
  else
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t.*)',p_table,sets,p_table) into result using p_data,p_id;
  end if;
  if p_table='calls' and result->>'status'='completed' and
    (p_id is null or existing->>'status' is distinct from 'completed') then stage='contacted';
  elsif p_table='visits' and (p_id is null or existing->>'status' is distinct from result->>'status') then
    stage=case result->>'status' when 'scheduled' then 'visit_scheduled' when 'completed' then 'visit_done' end;
  elsif p_table='deals' and (p_id is null or existing->>'stage' is distinct from result->>'stage') then
    stage=case result->>'stage' when 'won' then 'won' when 'lost' then 'lost' else 'negotiation' end;
  end if;
  if stage is not null then
    perform public.advance_lead_status(lead,stage,p_actor,p_request,result->>'lost_reason',result->>'lost_note');
  end if;
  if lead is not null then update public.leads set last_activity_at=now(),updated_at=now() where id=lead; end if;
  -- The status trigger already writes the one audit row for a lead stage change.
  if not (p_table='leads' and p_id is not null and existing->>'status' is distinct from result->>'status') then
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,case when p_id is null then 'create' else 'update' end,p_table,result->>'id',p_request,
        jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
  end if;
  return result;
end $$;

-- Signed call events use the same forward-only helper as manual mock completion.
create or replace function public.apply_call_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.calls;
begin
  select * into c from public.calls where provider_call_id=p_event->>'provider_call_id' for update;
  if c.id is null then raise exception 'Unknown call'; end if;
  insert into public.integration_events(provider,event_id) values('mock',p_event->>'event_id') on conflict do nothing;
  if not found then return '{"duplicate":true}'::jsonb; end if;
  if c.status not in ('completed','failed') then
    update public.calls set status=p_event->>'status',
      ended_at=case when p_event->>'status' in ('completed','failed') then coalesce((p_event->>'ended_at')::timestamptz,now()) else ended_at end,
      duration_seconds=coalesce((p_event->>'duration_seconds')::int,duration_seconds) where id=c.id;
    if p_event->>'status'='completed' then
      perform public.advance_lead_status(c.lead_id,'contacted',null,'webhook:'||(p_event->>'event_id'));
    end if;
  end if;
  insert into public.audit_log(action,entity,entity_id,metadata)
    values('webhook','calls',c.id::text,jsonb_build_object('event_id',p_event->>'event_id'));
  return '{"accepted":true}'::jsonb;
end $$;

revoke all on function public.prepare_lead_status(),public.record_lead_status_change(),
  public.advance_lead_status(uuid,text,uuid,text,text,text),public.crm_mutate(text,uuid,jsonb,uuid,text),
  public.apply_call_event(jsonb) from public,anon,authenticated;
grant execute on function public.prepare_lead_status(),public.record_lead_status_change(),
  public.advance_lead_status(uuid,text,uuid,text,text,text),public.crm_mutate(text,uuid,jsonb,uuid,text),
  public.apply_call_event(jsonb) to service_role;




-- Migration: 013_property_deletion.sql

-- Apply once after migration 012. Existing property records are not deleted.


-- Storage removal happens outside PostgreSQL. Keep a durable retry queue so a
-- temporary Storage failure cannot leave a deleted property's files forgotten.
create table public.property_photo_cleanup (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index property_photo_cleanup_created on public.property_photo_cleanup(created_at);
alter table public.property_photo_cleanup enable row level security;
revoke all on public.property_photo_cleanup from public, anon, authenticated;
grant all on public.property_photo_cleanup to service_role;

create function public.delete_property(p_property uuid, p_actor uuid, p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles; photo_count integer;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  -- This lock also prevents concurrent new foreign-key references or photos
  -- from being attached between the checks and deletion.
  perform id from public.properties where id=p_property for update;
  if not found then raise exception 'Property not found' using errcode='P0002'; end if;
  if exists(select 1 from public.leads where property_id=p_property)
    or exists(select 1 from public.visits where property_id=p_property)
    or exists(select 1 from public.deals where property_id=p_property) then
    raise exception 'Property has linked CRM records' using errcode='23503';
  end if;
  insert into public.property_photo_cleanup(property_id,storage_path)
    select property_id,storage_path from public.property_photos where property_id=p_property;
  get diagnostics photo_count = row_count;
  delete from public.property_photos where property_id=p_property;
  delete from public.properties where id=p_property;
  insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
    values(p_actor,'delete','properties',p_property::text,
      jsonb_build_object('photo_count',photo_count),p_request);
end $$;
revoke all on function public.delete_property(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.delete_property(uuid,uuid,text) to service_role;




-- Migration: 014_import_files_and_assignments.sql

-- Run once on an existing project. Keeps existing leads and phone records.

create table public.lead_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check(length(file_name) between 1 and 200),
  file_format text not null check(file_format in ('csv','xlsx','xls','legacy')),
  worksheet text,
  total_rows integer not null check(total_rows>=0),
  imported_count integer not null default 0 check(imported_count>=0),
  rejected_count integer not null default 0 check(rejected_count>=0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  assigned_agent uuid references public.profiles(id),
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz,
  legacy boolean not null default false,
  check(imported_count+rejected_count=total_rows)
);
alter table public.leads add column import_id uuid references public.lead_imports(id);
create index leads_import_assignment on public.leads(import_id,assigned_agent);
create index lead_imports_created on public.lead_imports(created_at desc,id);
alter table public.lead_imports enable row level security;
revoke all on public.lead_imports from public,anon,authenticated;
grant all on public.lead_imports to service_role;

-- Old imports did not retain filenames. Recover their groups from create-request
-- IDs, without guessing filenames, changing ownership, or touching phone values.
alter table public.leads disable trigger touch_updated;
do $$ declare g record; batch uuid; begin
  for g in
    select coalesce(a.request_id,'legacy:'||l.id::text) as request_key,
      array_agg(l.id) as ids,min(l.created_at) as created_at,
      min(a.actor_id::text)::uuid as actor_id,count(*)::integer as n
    from public.leads l
    left join lateral (
      select request_id,actor_id from public.audit_log
      where entity='leads' and entity_id=l.id::text and action='create'
      order by created_at,id limit 1
    ) a on true
    where l.source='CSV' and l.import_id is null
    group by coalesce(a.request_id,'legacy:'||l.id::text)
  loop
    insert into public.lead_imports(file_name,file_format,total_rows,imported_count,created_by,created_at,legacy)
      values('Earlier import ('||to_char(g.created_at at time zone 'Asia/Karachi','YYYY-MM-DD HH24:MI')||')',
        'legacy',g.n,g.n,g.actor_id,g.created_at,true) returning id into batch;
    update public.leads set import_id=batch where id=any(g.ids);
  end loop;
end $$;
alter table public.leads enable trigger touch_updated;

create function public.import_leads(p_file_name text,p_format text,p_worksheet text,p_rows jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch uuid; r jsonb; created public.leads; results jsonb='[]'; item jsonb; accepted integer=0; rejected integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if p_file_name is null or length(p_file_name) not between 1 and 200
    or p_format is null or p_format not in ('csv','xlsx','xls')
    or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Invalid import' using errcode='22023';
  end if;
  -- Counts are finalized after all row subtransactions have completed.
  insert into public.lead_imports(file_name,file_format,worksheet,total_rows,created_by)
    values(p_file_name,p_format,left(p_worksheet,200),0,p_actor) returning id into batch;
  for r in select value from jsonb_array_elements(p_rows) loop
    if r ? 'error' then
      item=jsonb_build_object('row',r->'row','success',false,'error',r->>'error');
      rejected=rejected+1;
    else
      begin
        if jsonb_typeof(r->'data') is distinct from 'object'
          or coalesce(r->>'phone','') !~ '^\+[1-9][0-9]{9,14}$' then
          raise exception 'Invalid row' using errcode='22023';
        end if;
        created=public.create_lead(r->'data',r->>'phone',p_actor,p_request);
        update public.leads set import_id=batch where id=created.id;
        item=jsonb_build_object('row',r->'row','success',true,'id',created.id);
        if jsonb_typeof(r->'warnings')='array' and jsonb_array_length(r->'warnings')>0 then
          item=item||jsonb_build_object('warnings',r->'warnings');
        end if;
        accepted=accepted+1;
      exception
        when unique_violation then
          item=jsonb_build_object('row',r->'row','success',false,'error','Duplicate phone');
          rejected=rejected+1;
        when others then
          item=jsonb_build_object('row',r->'row','success',false,'error','Row rejected');
          rejected=rejected+1;
      end;
    end if;
    results=results||jsonb_build_array(item);
  end loop;
  update public.lead_imports set total_rows=accepted+rejected,imported_count=accepted,rejected_count=rejected where id=batch;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'import','lead_imports',batch::text,p_request,
      jsonb_build_object('imported_count',accepted,'rejected_count',rejected));
  return jsonb_build_object('import_id',batch,'rows',results);
end $$;

create function public.lead_import_summary(p_import uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; batch public.lead_imports; visible integer; n integer; assigned integer; owners integer; owner_id uuid; owner_name text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  select * into batch from public.lead_imports where id=p_import;
  if not found then return null; end if;
  select count(*)::integer into visible from public.leads
    where import_id=p_import and (actor.role='admin' or assigned_agent=p_actor);
  if actor.role<>'admin' and visible=0 then return null; end if;
  select count(*)::integer,count(assigned_agent)::integer,count(distinct assigned_agent)::integer,min(assigned_agent::text)::uuid
    into n,assigned,owners,owner_id from public.leads where import_id=p_import;
  if owners<>1 or assigned<>n then owner_id=null; end if;
  if actor.role<>'admin' then owner_id=actor.id; end if;
  select name into owner_name from public.profiles where id=owner_id;
  return jsonb_build_object('id',batch.id,'file_name',batch.file_name,'file_format',batch.file_format,
    'worksheet',batch.worksheet,'created_at',batch.created_at,'legacy',batch.legacy,
    'total_rows',batch.total_rows,'imported_count',batch.imported_count,'rejected_count',batch.rejected_count,
    'lead_count',visible,'assigned_agent',owner_id,'assigned_name',owner_name,
    'mixed_assignment',actor.role='admin' and assigned>0 and owner_id is null);
end $$;

create function public.lead_imports_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,p_search text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; results jsonb; n bigint;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  if p_page not between 1 and 100000 or p_limit not between 1 and 100 or length(coalesce(p_search,''))>100 then
    raise exception 'Invalid page' using errcode='22023';
  end if;
  select count(*) into n from public.lead_imports i
    where (actor.role='admin' or exists(select 1 from public.leads l where l.import_id=i.id and l.assigned_agent=p_actor))
      and position(lower(coalesce(p_search,'')) in lower(i.file_name))>0;
  select coalesce(jsonb_agg(public.lead_import_summary(i.id,p_actor) order by i.created_at desc,i.id),'[]') into results
    from (select * from public.lead_imports b
      where (actor.role='admin' or exists(select 1 from public.leads l where l.import_id=b.id and l.assigned_agent=p_actor))
        and position(lower(coalesce(p_search,'')) in lower(b.file_name))>0
      order by b.created_at desc,b.id limit p_limit offset (p_page-1)*p_limit) i;
  return jsonb_build_object('data',results,'count',n,'page',p_page,'limit',p_limit);
end $$;

create function public.assign_lead_import(p_import uuid,p_agent uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch public.lead_imports; lead public.leads; changed integer=0; n integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  perform id from public.profiles where id=p_agent and role='agent' and active for share;
  if not found then raise exception 'Choose an active agent' using errcode='22023'; end if;
  select * into batch from public.lead_imports where id=p_import for update;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  for lead in select * from public.leads where import_id=p_import order by id for update loop
    n=n+1;
    if lead.assigned_agent is distinct from p_agent then
      perform public.assign_lead(lead.id,p_actor,p_agent,p_request);
      changed=changed+1;
    end if;
  end loop;
  if n=0 then raise exception 'File has no accepted leads' using errcode='22023'; end if;
  update public.lead_imports set assigned_agent=p_agent,assigned_by=p_actor,assigned_at=now() where id=p_import;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'assign_file','lead_imports',p_import::text,p_request,
      jsonb_build_object('agent_id',p_agent,'lead_count',n,'assigned_count',changed));
  return jsonb_build_object('id',p_import,'agent_id',p_agent,'lead_count',n,'assigned_count',changed);
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc
    where pronamespace='public'::regnamespace and proname in
      ('import_leads','lead_import_summary','lead_imports_page','assign_lead_import') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;



-- Migration: 015_documentation_and_policies.sql

-- Apply once after migration 014. Existing CRM records are preserved.

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check(length(btrim(title)) between 1 and 200),
  category text not null check(category in ('documentation','policy')),
  content text not null check(length(btrim(content)) between 1 and 50000),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_documents_updated on public.knowledge_documents(updated_at desc,id);
alter table public.knowledge_documents enable row level security;
revoke all on public.knowledge_documents from public,anon,authenticated;
grant all on public.knowledge_documents to service_role;

create table public.knowledge_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id),
  file_name text not null check(length(file_name) between 1 and 200),
  mime_type text not null check(mime_type in ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes integer not null check(size_bytes between 1 and 10485760),
  storage_path text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index knowledge_files_document on public.knowledge_files(document_id,created_at);
-- Reservations are queued before Storage uploads. Failed or interrupted uploads
-- remain recoverable even if compensation cannot reach Storage immediately.
create table public.knowledge_file_cleanup (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  storage_path text not null unique,
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index knowledge_file_cleanup_due on public.knowledge_file_cleanup(not_before);
alter table public.knowledge_files enable row level security;
alter table public.knowledge_file_cleanup enable row level security;
revoke all on public.knowledge_files,public.knowledge_file_cleanup from public,anon,authenticated;
grant all on public.knowledge_files,public.knowledge_file_cleanup to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('knowledge-files','knowledge-files',false,10485760,array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

create function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy') then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),updated_by=p_actor,updated_at=now()
      where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,
      jsonb_build_object('fields',jsonb_build_array('title','category','content')));
  return to_jsonb(result);
end $$;

create function public.delete_knowledge_document(p_id uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  perform id from public.knowledge_documents where id=p_id for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  insert into public.knowledge_file_cleanup(document_id,storage_path)
    select document_id,storage_path from public.knowledge_files where document_id=p_id
    on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where document_id=p_id;
  delete from public.knowledge_documents where id=p_id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id)
    values(p_actor,'delete','knowledge_documents',p_id::text,p_request);
end $$;
create function public.attach_knowledge_file(p_document uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_files;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  perform id from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data-array['file_name','mime_type','size_bytes','storage_path'])<>'{}'::jsonb
    or coalesce(p_data->>'storage_path','') !~ ('^'||p_document::text||'/[0-9a-f-]{36}$')
    or not exists(select 1 from public.knowledge_file_cleanup where storage_path=p_data->>'storage_path' and document_id=p_document) then
    raise exception 'Invalid file metadata' using errcode='22023';
  end if;
  insert into public.knowledge_files(document_id,file_name,mime_type,size_bytes,storage_path,created_by)
    values(p_document,p_data->>'file_name',p_data->>'mime_type',(p_data->>'size_bytes')::integer,p_data->>'storage_path',p_actor)
    returning * into result;
  delete from public.knowledge_file_cleanup where storage_path=result.storage_path;
  update public.knowledge_documents set updated_at=now(),updated_by=p_actor where id=p_document;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'upload_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',result.id));
  return to_jsonb(result)-'storage_path';
end $$;
create function public.delete_knowledge_file(p_document uuid,p_file uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles; attachment public.knowledge_files;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  perform id from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  select * into attachment from public.knowledge_files where id=p_file and document_id=p_document for update;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  insert into public.knowledge_file_cleanup(document_id,storage_path) values(p_document,attachment.storage_path)
    on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where id=p_file;
  update public.knowledge_documents set updated_at=now(),updated_by=p_actor where id=p_document;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'delete_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',p_file));
end $$;
revoke all on function public.save_knowledge_document(uuid,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.delete_knowledge_document(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_knowledge_document(uuid,jsonb,uuid,text) to service_role;
grant execute on function public.delete_knowledge_document(uuid,uuid,text) to service_role;
revoke all on function public.attach_knowledge_file(uuid,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.delete_knowledge_file(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.attach_knowledge_file(uuid,jsonb,uuid,text) to service_role;
grant execute on function public.delete_knowledge_file(uuid,uuid,uuid,text) to service_role;



-- Migration: 016_accounts_and_security.sql

-- Apply once after migration 015. Existing accounts and CRM records are retained.

create table public.account_security (
  admin_id uuid primary key references public.profiles(id),
  pin_hash text not null check(length(pin_hash) between 50 and 500),
  version uuid not null default gen_random_uuid(),
  failed_attempts integer not null default 0 check(failed_attempts between 0 and 5),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
create table public.account_unlocks (
  token_hash text primary key check(length(token_hash)=64),
  admin_id uuid not null references public.profiles(id),
  session_hash text not null check(length(session_hash)=64),
  pin_version uuid not null,
  expires_at timestamptz not null
);
create index account_unlocks_admin on public.account_unlocks(admin_id,expires_at);
alter table public.account_security enable row level security;
alter table public.account_unlocks enable row level security;
revoke all on public.account_security,public.account_unlocks from public,anon,authenticated;
grant all on public.account_security,public.account_unlocks to service_role;

-- Trusted Auth administration can provision an inactive profile before enabling
-- the new account. Ordinary signup metadata still cannot choose a role/access.
create or replace function public.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,name,active) values(new.id,coalesce(new.raw_user_meta_data->>'name','Team member'),
    coalesce(to_jsonb(new)->'raw_app_meta_data'->>'crm_provisioning','false')<>'true');
  return new;
end $$;

create function public.accounts_admin(p_actor uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  perform id from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Administrator access required' using errcode='42501'; end if;
end $$;
create function public.accounts_gate(p_actor uuid,p_session text,p_unlock text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_admin(p_actor);
  perform s.admin_id from public.account_security s join public.account_unlocks u on u.admin_id=s.admin_id and u.pin_version=s.version
    where u.admin_id=p_actor and u.session_hash=p_session and u.token_hash=p_unlock and u.expires_at>now() for share of s,u;
  if not found then raise exception 'Unlock Accounts with your PIN to continue' using errcode='PT423'; end if;
end $$;
create function public.save_accounts_pin(p_actor uuid,p_hash text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare changed timestamptz;
begin
  perform public.accounts_admin(p_actor);
  insert into public.account_security(admin_id,pin_hash) values(p_actor,p_hash)
    on conflict(admin_id) do update set pin_hash=excluded.pin_hash,version=gen_random_uuid(),failed_attempts=0,locked_until=null,updated_at=now()
    returning updated_at into changed;
  delete from public.account_unlocks where admin_id=p_actor;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'set_accounts_pin','account_security',p_actor::text,p_request);
  return jsonb_build_object('configured',true,'updated_at',changed);
end $$;
create function public.unlock_accounts(p_actor uuid,p_session text,p_version uuid,p_valid boolean,p_token text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.account_security; until_time timestamptz; attempts integer;
begin
  perform public.accounts_admin(p_actor);
  select * into settings from public.account_security where admin_id=p_actor for update;
  if not found then return jsonb_build_object('status','setup_required'); end if;
  if settings.locked_until>now() then return jsonb_build_object('status','locked','locked_until',settings.locked_until); end if;
  if settings.version is distinct from p_version then return jsonb_build_object('status','changed'); end if;
  if p_valid is not true then
    attempts=case when settings.locked_until is not null then 1 else settings.failed_attempts+1 end;
    until_time=case when attempts>=5 then now()+interval '15 minutes' else null end;
    update public.account_security set failed_attempts=attempts,locked_until=until_time where admin_id=p_actor;
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'accounts_pin_failed','account_security',p_actor::text,p_request,jsonb_build_object('locked',until_time is not null));
    return jsonb_build_object('status',case when until_time is null then 'incorrect' else 'locked' end,'locked_until',until_time,'remaining',5-attempts);
  end if;
  until_time=now()+interval '15 minutes';
  update public.account_security set failed_attempts=0,locked_until=null where admin_id=p_actor;
  delete from public.account_unlocks where admin_id=p_actor and (expires_at<=now() or session_hash=p_session);
  insert into public.account_unlocks(token_hash,admin_id,session_hash,pin_version,expires_at) values(p_token,p_actor,p_session,settings.version,until_time);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'unlock_accounts','account_security',p_actor::text,p_request);
  return jsonb_build_object('status','allowed','expires_at',until_time);
end $$;
create function public.lock_accounts(p_actor uuid,p_session text,p_unlock text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_admin(p_actor);
  delete from public.account_unlocks where admin_id=p_actor and session_hash=p_session and token_hash=p_unlock;
end $$;

create function public.accounts_page(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint; summary jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_role not in ('','admin','agent') or p_access not in ('','active','disabled') then raise exception 'Invalid account filters' using errcode='22023'; end if;
  with records as (
    select p.id,p.name,p.role,p.active,p.created_at,to_jsonb(u)->>'email' email,
      to_jsonb(u)->>'last_sign_in_at' last_sign_in_at,to_jsonb(u)->>'email_confirmed_at' email_confirmed_at,
      to_jsonb(u)->>'banned_until' banned_until
    from public.profiles p join auth.users u on u.id=p.id
  ), eligible as (
    select * from records where (p_role='' or role=p_role) and (p_access='' or active=(p_access='active'))
      and (p_search='' or position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(coalesce(email,'')))>0)
  ), page_rows as (select * from eligible order by created_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'::jsonb),(select count(*) from eligible),
    (select jsonb_build_object('total',count(*),'admins',count(*) filter(where role='admin' and active),'agents',count(*) filter(where role='agent' and active),'disabled',count(*) filter(where not active)) from records)
    into rows,total,summary;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit,'summary',summary);
end $$;
create function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  select jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'active',p.active,'created_at',p.created_at,
    'email',to_jsonb(u)->>'email','last_sign_in_at',to_jsonb(u)->>'last_sign_in_at','email_confirmed_at',to_jsonb(u)->>'email_confirmed_at','banned_until',to_jsonb(u)->>'banned_until',
    'assigned_leads',(select count(*) from public.leads where assigned_agent=p.id),
    'completed_calls',(select count(*) from public.calls where agent_id=p.id and status='completed'),
    'open_followups',(select count(*) from public.followups where agent_id=p.id and status='pending'))
    into result from public.profiles p join auth.users u on u.id=p.id where p.id=p_target;
  if result is null then raise exception 'Account not found' using errcode='P0002'; end if;
  return result;
end $$;
create function public.update_account(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.profiles; result public.profiles;
begin
  -- Serialize account-role/access edits before locking administrator rows.
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}'::jsonb or (p_data-array['name','role','active'])<>'{}'::jsonb
    or (p_data?'name' and (jsonb_typeof(p_data->'name')<>'string' or length(btrim(p_data->>'name')) not between 1 and 200))
    or (p_data?'role' and coalesce(p_data->>'role','') not in ('admin','agent'))
    or (p_data?'active' and jsonb_typeof(p_data->'active') is distinct from 'boolean') then raise exception 'Invalid account fields' using errcode='22023'; end if;
  select * into target from public.profiles where id=p_target for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if p_target=p_actor and ((p_data?'role' and p_data->>'role'<>'admin') or (p_data?'active' and not (p_data->>'active')::boolean)) then raise exception 'You cannot disable or demote your own administrator account' using errcode='22023'; end if;
  if target.active and target.role='admin' and (coalesce(p_data->>'role',target.role)<>'admin' or not coalesce((p_data->>'active')::boolean,target.active))
    and (select count(*) from public.profiles where role='admin' and active)<=1 then raise exception 'Keep at least one active administrator' using errcode='22023'; end if;
  update public.profiles set name=case when p_data?'name' then btrim(p_data->>'name') else name end,
    role=coalesce(p_data->>'role',role),active=coalesce((p_data->>'active')::boolean,active) where id=p_target returning * into result;
  if not result.active or result.role<>'admin' then delete from public.account_unlocks where admin_id=p_target; end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'manage_account','profiles',p_target::text,p_request,jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
  return to_jsonb(result);
end $$;
create function public.account_action(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_action text,p_request text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_action not in ('create_account_requested','set_password_requested','set_password_completed','set_password_failed') then raise exception 'Invalid account action' using errcode='22023'; end if;
  if p_action<>'create_account_requested' then
    perform id from public.profiles where id=p_target for share;
    if not found then raise exception 'Account not found' using errcode='P0002'; end if;
    if p_target=p_actor then raise exception 'Use your own password recovery flow to change your login password' using errcode='22023'; end if;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,p_action,'profiles',p_target::text,p_request);
end $$;
-- All operations are service-only, with active-role and unlock rechecks inside SQL.
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('accounts_admin','accounts_gate','save_accounts_pin','unlock_accounts','lock_accounts','accounts_page','account_detail','update_account','account_action') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;



-- Migration: 017_document_categories.sql

-- Apply once after migration 016. Existing entries and attachments are retained.

alter table public.knowledge_documents drop constraint knowledge_documents_category_check;
alter table public.knowledge_documents add constraint knowledge_documents_category_check
  check(category in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements'));
alter table public.knowledge_documents
  add column property_name text not null default '' check(length(property_name)<=200),
  add column keywords text not null default '' check(length(keywords)<=500);

create or replace function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents; fields jsonb;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content','property_name','keywords']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements')
    or (p_data?'property_name' and (jsonb_typeof(p_data->'property_name') is distinct from 'string' or length(btrim(p_data->>'property_name'))>200))
    or (p_data?'keywords' and (jsonb_typeof(p_data->'keywords') is distinct from 'string' or length(btrim(p_data->>'keywords'))>500)) then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,property_name,keywords,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),coalesce(btrim(p_data->>'property_name'),''),coalesce(btrim(p_data->>'keywords'),''),p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),
      property_name=case when p_data?'property_name' then btrim(p_data->>'property_name') else property_name end,
      keywords=case when p_data?'keywords' then btrim(p_data->>'keywords') else keywords end,
      updated_by=p_actor,updated_at=now() where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  fields=jsonb_build_array('title','category','content');
  if p_data?'property_name' then fields=fields||jsonb_build_array('property_name'); end if;
  if p_data?'keywords' then fields=fields||jsonb_build_array('keywords'); end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,jsonb_build_object('fields',fields));
  return to_jsonb(result);
end $$;

create function public.list_knowledge_documents(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint;
begin
  perform id from public.profiles where id=p_actor and active and role in ('admin','agent') for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or p_search is null or length(p_search)>100 or p_category is null
    or p_category not in ('','documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements') then
    raise exception 'Invalid document filters' using errcode='22023';
  end if;
  with eligible as (
    select id,title,category,property_name,keywords,created_at,updated_at from public.knowledge_documents
    where (p_category='' or category=p_category)
      and (p_search='' or position(lower(p_search) in lower(title||' '||property_name||' '||keywords||' '||content))>0)
  ), page_rows as (
    select * from eligible order by updated_at desc,id offset (p_page-1)*p_limit limit p_limit
  )
  select coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id) from page_rows r),'[]'::jsonb),
    (select count(*) from eligible) into rows,total;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit);
end $$;
revoke all on function public.save_knowledge_document(uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.save_knowledge_document(uuid,jsonb,uuid,text) to service_role;
revoke all on function public.list_knowledge_documents(uuid,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.list_knowledge_documents(uuid,integer,integer,text,text) to service_role;



-- Migration: 018_manual_call_logging.sql

-- P1: apply once after migration 017 on an existing database.


alter table public.calls
  add column method text not null default 'provider'
    check (method in ('provider','mock','manual')),
  add column answered boolean;

with changed as (
  update public.calls set method='mock' where provider_call_id like 'mock-%'
    returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'call.method_backfilled','calls',id::text,'migration:018',
    jsonb_build_object('fields',jsonb_build_array('method')) from changed;

-- Existing server mutations do not accept a client-selected method. Classify
-- future mock intents as soon as the adapter attaches their mock reference.
create function public.prepare_call_method() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.method<>'manual' and new.provider_call_id like 'mock-%' then
    new.method='mock';
  end if;
  return new;
end $$;
create trigger prepare_call_method before insert or update of provider_call_id
  on public.calls for each row execute function public.prepare_call_method();

-- These invariants also apply to later outcome edits, not just initial logs.
alter table public.calls add constraint calls_manual_values_check check (
  method<>'manual' or (
    answered is not null and outcome is not null and
    duration_seconds between 0 and 7200 and
    ((answered and duration_seconds>=1 and status='completed') or
      (not answered and status='failed' and outcome in ('No answer','Busy','Wrong number'))) and
    ended_at is not null and ended_at=started_at+make_interval(secs=>duration_seconds) and
    provider_call_id is null and outcome_submitted_at is not null and not missing_outcome and
    coalesce(char_length(notes),0)<=4000 and cardinality(deal_tags)<=7 and
    deal_tags <@ array['Hot lead','Warm lead','Cold lead','Budget mismatch','Location mismatch','Ready to visit','Ready to close']::text[]
  )
);
create index calls_method_created on public.calls(method,created_at desc);

create function public.log_manual_call(p_lead uuid,p_actor uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; customer public.leads; result public.calls;
  started timestamptz; seconds integer; did_answer boolean; call_tags text[];
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into customer from public.leads where id=p_lead
    and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' then
    raise exception 'Invalid call fields' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_object_keys(p_data) as field
    where field not in ('answered','started_at','duration_seconds','outcome','notes','deal_tags')) then
    raise exception 'Field forbidden' using errcode='42501';
  end if;
  if jsonb_typeof(p_data->'answered') is distinct from 'boolean' or
    jsonb_typeof(p_data->'started_at') is distinct from 'string' or
    jsonb_typeof(p_data->'duration_seconds') is distinct from 'number' or
    jsonb_typeof(p_data->'outcome') is distinct from 'string' then
    raise exception 'Call start, answered, duration and outcome are required' using errcode='23514';
  end if;
  if (p_data->>'duration_seconds')::numeric not between 0 and 7200 or
    (p_data->>'duration_seconds')::numeric<>floor((p_data->>'duration_seconds')::numeric) then
    raise exception 'Duration must be 0 to 7200 whole seconds' using errcode='23514';
  end if;
  if p_data->>'started_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Use a call start with an explicit timezone' using errcode='23514';
  end if;
  started=(p_data->>'started_at')::timestamptz;
  if not isfinite(started) or started>now()+interval '2 minutes' or
    started<now()-(case when actor.role='admin' then interval '30 days' else interval '48 hours' end) then
    raise exception 'Call start is outside the permitted time window' using errcode='23514';
  end if;
  seconds=(p_data->>'duration_seconds')::integer;
  did_answer=(p_data->>'answered')::boolean;
  if (did_answer and seconds<1) or (not did_answer and
    p_data->>'outcome' not in ('No answer','Busy','Wrong number')) then
    raise exception 'Choose a valid duration and outcome for whether the call was answered' using errcode='23514';
  end if;
  if p_data ? 'notes' and (jsonb_typeof(p_data->'notes')<>'string' or
    char_length(p_data->>'notes')>4000) then
    raise exception 'Use notes of 4000 characters or fewer' using errcode='23514';
  end if;
  if p_data ? 'deal_tags' then
    if jsonb_typeof(p_data->'deal_tags')<>'array' then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
    if exists(select 1 from jsonb_array_elements(p_data->'deal_tags') as tag
      where jsonb_typeof(tag)<>'string') then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
  end if;
  call_tags=array(select jsonb_array_elements_text(coalesce(p_data->'deal_tags','[]'::jsonb)));
  if cardinality(call_tags)>7 or cardinality(call_tags)<>
    (select count(distinct tag) from unnest(call_tags) as tag) then
    raise exception 'Choose distinct supported tags' using errcode='23514';
  end if;
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,
    duration_seconds,outcome,notes,deal_tags,outcome_submitted_at,missing_outcome)
  values(customer.id,case when actor.role='admin' then coalesce(customer.assigned_agent,p_actor) else p_actor end,
    'manual',did_answer,case when did_answer then 'completed' else 'failed' end,
    started,started+make_interval(secs=>seconds),seconds,p_data->>'outcome',
    coalesce(p_data->>'notes',''),call_tags,now(),false) returning * into result;
  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;
  update public.leads set last_activity_at=now(),updated_at=now() where id=customer.id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'call.manual_logged','calls',result.id::text,p_request,
      jsonb_build_object('lead_id',customer.id,'agent_id',result.agent_id,
        'fields',jsonb_build_array('method','answered','started_at','ended_at',
          'duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome')));
  return to_jsonb(result);
end $$;

revoke all on function public.prepare_call_method(),public.log_manual_call(uuid,uuid,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.prepare_call_method(),public.log_manual_call(uuid,uuid,jsonb,text)
  to service_role;




-- Migration: 019_protected_phone_numbers.sql

-- P2: apply once after migration 018. Browser clients use only /api.


create table crm_private.phone_reveals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  revealed_at timestamptz not null default now()
);
create index phone_reveals_user_time on crm_private.phone_reveals(user_id,revealed_at) include (lead_id);
alter table crm_private.phone_reveals enable row level security;
revoke all on crm_private.phone_reveals from public,anon,authenticated;
grant all on crm_private.phone_reveals to service_role;

create table public.security_alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  user_id uuid not null references public.profiles(id),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  check ((reviewed_at is null) = (reviewed_by is null))
);
create index security_alerts_created on public.security_alerts(created_at desc);
create index security_alerts_unreviewed on public.security_alerts(created_at desc) where reviewed_at is null;
-- One warning and one limit alert per agent/Pakistan day, including after review.
create unique index phone_alerts_user_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date))
  where type in ('phone_reveal_warning','phone_reveal_limit');
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from public,anon,authenticated;
grant all on public.security_alerts to service_role;

create function public.phone_reveal_window(p_at timestamptz)
returns table(day date,starts_at timestamptz,resets_at timestamptz)
language sql immutable security definer set search_path='' as $$
  select (p_at at time zone 'Asia/Karachi')::date,
    date_trunc('day',p_at at time zone 'Asia/Karachi') at time zone 'Asia/Karachi',
    (date_trunc('day',p_at at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi'
$$;

create function public.phone_reveal_status(p_actor uuid,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer into shown from crm_private.phone_reveals
    where user_id=p_actor and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  return jsonb_build_object('shown_today',shown,'limit',p_limit,'unlimited',actor.role='admin',
    'remaining',case when actor.role='admin' then null else greatest(0,p_limit-shown) end,
    'day',day_window.day,'reset_at',day_window.resets_at);
end $$;

create function public.reveal_phone(p_lead uuid,p_actor uuid,p_request text,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer; seen boolean;
  number text; alert_id uuid; alert_type text; alert_severity text; alert_message text;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  -- Serialize quota decisions for the same actor, including across API instances.
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,190901));
  perform 1 from public.leads where id=p_lead and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  select phone into number from crm_private.lead_phones where lead_id=p_lead;
  if number is null then raise exception 'Phone unavailable' using errcode='P0002'; end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer,bool_or(lead_id=p_lead) into shown,seen
    from crm_private.phone_reveals where user_id=p_actor
      and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  if actor.role='agent' and not coalesce(seen,false) and shown>=p_limit then
    alert_type='phone_reveal_limit'; alert_severity='critical';
    alert_message='Daily customer number limit reached.';
  else
    insert into crm_private.phone_reveals(user_id,lead_id) values(p_actor,p_lead);
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'lead.phone_revealed','leads',p_lead::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at')));
    if not coalesce(seen,false) then shown=shown+1; end if;
    if actor.role='agent' and shown>=ceil(p_limit*0.8) then
      alert_type='phone_reveal_warning'; alert_severity='warning';
      alert_message='Agent has reached at least 80% of the daily customer number limit.';
    end if;
  end if;
  if alert_type is not null then
    insert into public.security_alerts(type,severity,user_id,message,metadata)
      values(alert_type,alert_severity,p_actor,alert_message,jsonb_build_object('shown_today',shown,'limit',p_limit))
      on conflict do nothing returning id into alert_id;
    if alert_id is not null then
      insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
        values(p_actor,'security.alert_created','security_alerts',alert_id::text,p_request,
          jsonb_build_object('user_id',p_actor,'fields',jsonb_build_array('type','severity','user_id','created_at')));
    end if;
  end if;
  -- Do not raise on quota refusal: an exception would roll its critical alert back.
  if alert_type='phone_reveal_limit' then
    return public.phone_reveal_status(p_actor,p_limit)||jsonb_build_object('allowed',false);
  end if;
  return public.phone_reveal_status(p_actor,p_limit)||
    jsonb_build_object('allowed',true,'phone',number,'expires_in_seconds',120);
end $$;

create function public.security_alerts_summary(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  return (select jsonb_build_object('count',count(*),'critical',count(*) filter(where severity='critical'),
    'warning',count(*) filter(where severity='warning')) from public.security_alerts where reviewed_at is null);
end $$;

create function public.security_alerts_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,
  p_view text default 'unreviewed',p_severity text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or
    p_view is null or p_view not in ('unreviewed','reviewed','all') or
    (p_severity is not null and p_severity not in ('info','warning','critical')) then
    raise exception 'Invalid alert filters' using errcode='22023';
  end if;
  with filtered as (
    select a.*,p.name as user_name from public.security_alerts a join public.profiles p on p.id=a.user_id
    where (p_view='all' or (p_view='unreviewed' and a.reviewed_at is null) or (p_view='reviewed' and a.reviewed_at is not null))
      and (p_severity is null or a.severity=p_severity)
  ), page as (select * from filtered order by created_at desc,id desc limit p_limit offset (p_page-1)*p_limit)
  select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),
    'count',(select count(*) from filtered),'page',p_page,'limit',p_limit) into result;
  return result;
end $$;

create function public.review_security_alert(p_alert uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare alert public.security_alerts;
begin
  perform 1 from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into alert from public.security_alerts where id=p_alert for update;
  if not found then raise exception 'Alert not found' using errcode='P0002'; end if;
  if alert.reviewed_at is null then
    update public.security_alerts set reviewed_at=now(),reviewed_by=p_actor where id=p_alert returning * into alert;
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'security.alert_reviewed','security_alerts',alert.id::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('reviewed_at','reviewed_by')));
  end if;
  return to_jsonb(alert);
end $$;

revoke all on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  to service_role;




-- Migration: 020_account_email_confirmation.sql

-- Apply once after migration 019. No Auth user is automatically confirmed.


create or replace function public.account_action(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_action text,p_request text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_action not in ('create_account_requested','set_password_requested','set_password_completed','set_password_failed','email_confirmation_requested','email_confirmation_sent','email_confirmation_failed') then raise exception 'Invalid account action' using errcode='22023'; end if;
  if p_action<>'create_account_requested' then
    perform id from public.profiles where id=p_target for share;
    if not found then raise exception 'Account not found' using errcode='P0002'; end if;
    if p_target=p_actor then raise exception 'Use your own password recovery flow to change your login password' using errcode='22023'; end if;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,p_action,'profiles',p_target::text,p_request);
end $$;

revoke all on function public.account_action(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.account_action(uuid,text,text,uuid,text,text) to service_role;




-- Migration: 021_visible_lead_contacts.sql

-- Apply once after 020. Authorized lead pages display full contacts automatically.


create function public.lead_contact_phones(p_actor uuid,p_leads uuid[],p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; locked integer; result jsonb;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_leads is null or cardinality(p_leads) not between 1 and 100 or
    (select count(distinct id) from unnest(p_leads) id)<>cardinality(p_leads) then
    raise exception 'Invalid contact selection' using errcode='22023';
  end if;
  perform 1 from public.leads where id=any(p_leads)
    and (actor.role='admin' or assigned_agent=p_actor) order by id for share;
  get diagnostics locked=row_count;
  if locked<>cardinality(p_leads) then raise exception 'Lead not found' using errcode='P0002'; end if;
  insert into crm_private.phone_reveals(user_id,lead_id)
    select p_actor,l.id from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    select p_actor,'lead.phone_revealed','leads',l.id::text,p_request,
      jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at'))
    from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  select jsonb_build_object('phones',coalesce(jsonb_object_agg(l.id::text,p.phone),'{}'::jsonb))
    into result from public.leads l left join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  return result;
end $$;
revoke all on function public.lead_contact_phones(uuid,uuid[],text) from public,anon,authenticated;
grant execute on function public.lead_contact_phones(uuid,uuid[],text) to service_role;




-- Migration: 022_agent_offboarding_and_kyc_access.sql

-- Apply once after 021. Preserve customer records, activity history and private storage.


-- Core prerequisites are checked before any upgrade writes.
do $$ declare missing text; begin
  select string_agg(t.name,', ' order by t.name) into missing from
    (values ('public.profiles'),('public.leads'),('public.followups'),('public.visits'),('public.reminders'),
      ('public.audit_log'),('public.account_security'),('public.account_unlocks'),
      ('public.knowledge_documents'),('public.knowledge_files'),('crm_private.lead_phones')) t(name)
    where to_regclass(t.name) is null;
  if missing is not null then raise exception 'CRM core prerequisites missing: %',missing; end if;
end $$;

-- Ensure the original P2 schema/helpers for partially applied hosted upgrades.
-- Existing rows and the historical reveal/quota behavior are retained.
create table if not exists crm_private.phone_reveals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  revealed_at timestamptz not null default now()
);
create index if not exists phone_reveals_user_time on crm_private.phone_reveals(user_id,revealed_at) include (lead_id);
alter table crm_private.phone_reveals enable row level security;
revoke all on crm_private.phone_reveals from public,anon,authenticated;
grant all on crm_private.phone_reveals to service_role;

create table if not exists public.security_alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  user_id uuid not null references public.profiles(id),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  check ((reviewed_at is null) = (reviewed_by is null))
);
create index if not exists security_alerts_created on public.security_alerts(created_at desc);
create index if not exists security_alerts_unreviewed on public.security_alerts(created_at desc) where reviewed_at is null;
-- One warning and one limit alert per agent/Pakistan day, including after review.
create unique index if not exists phone_alerts_user_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date))
  where type in ('phone_reveal_warning','phone_reveal_limit');
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from public,anon,authenticated;
grant all on public.security_alerts to service_role;

create or replace function public.phone_reveal_window(p_at timestamptz)
returns table(day date,starts_at timestamptz,resets_at timestamptz)
language sql immutable security definer set search_path='' as $$
  select (p_at at time zone 'Asia/Karachi')::date,
    date_trunc('day',p_at at time zone 'Asia/Karachi') at time zone 'Asia/Karachi',
    (date_trunc('day',p_at at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi'
$$;

create or replace function public.phone_reveal_status(p_actor uuid,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer into shown from crm_private.phone_reveals
    where user_id=p_actor and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  return jsonb_build_object('shown_today',shown,'limit',p_limit,'unlimited',actor.role='admin',
    'remaining',case when actor.role='admin' then null else greatest(0,p_limit-shown) end,
    'day',day_window.day,'reset_at',day_window.resets_at);
end $$;

create or replace function public.reveal_phone(p_lead uuid,p_actor uuid,p_request text,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer; seen boolean;
  number text; alert_id uuid; alert_type text; alert_severity text; alert_message text;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  -- Serialize quota decisions for the same actor, including across API instances.
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,190901));
  perform 1 from public.leads where id=p_lead and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  select phone into number from crm_private.lead_phones where lead_id=p_lead;
  if number is null then raise exception 'Phone unavailable' using errcode='P0002'; end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer,bool_or(lead_id=p_lead) into shown,seen
    from crm_private.phone_reveals where user_id=p_actor
      and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  if actor.role='agent' and not coalesce(seen,false) and shown>=p_limit then
    alert_type='phone_reveal_limit'; alert_severity='critical';
    alert_message='Daily customer number limit reached.';
  else
    insert into crm_private.phone_reveals(user_id,lead_id) values(p_actor,p_lead);
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'lead.phone_revealed','leads',p_lead::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at')));
    if not coalesce(seen,false) then shown=shown+1; end if;
    if actor.role='agent' and shown>=ceil(p_limit*0.8) then
      alert_type='phone_reveal_warning'; alert_severity='warning';
      alert_message='Agent has reached at least 80% of the daily customer number limit.';
    end if;
  end if;
  if alert_type is not null then
    insert into public.security_alerts(type,severity,user_id,message,metadata)
      values(alert_type,alert_severity,p_actor,alert_message,jsonb_build_object('shown_today',shown,'limit',p_limit))
      on conflict do nothing returning id into alert_id;
    if alert_id is not null then
      insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
        values(p_actor,'security.alert_created','security_alerts',alert_id::text,p_request,
          jsonb_build_object('user_id',p_actor,'fields',jsonb_build_array('type','severity','user_id','created_at')));
    end if;
  end if;
  -- Do not raise on quota refusal: an exception would roll its critical alert back.
  if alert_type='phone_reveal_limit' then
    return public.phone_reveal_status(p_actor,p_limit)||jsonb_build_object('allowed',false);
  end if;
  return public.phone_reveal_status(p_actor,p_limit)||
    jsonb_build_object('allowed',true,'phone',number,'expires_in_seconds',120);
end $$;

create or replace function public.security_alerts_summary(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  return (select jsonb_build_object('count',count(*),'critical',count(*) filter(where severity='critical'),
    'warning',count(*) filter(where severity='warning')) from public.security_alerts where reviewed_at is null);
end $$;

create or replace function public.security_alerts_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,
  p_view text default 'unreviewed',p_severity text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or
    p_view is null or p_view not in ('unreviewed','reviewed','all') or
    (p_severity is not null and p_severity not in ('info','warning','critical')) then
    raise exception 'Invalid alert filters' using errcode='22023';
  end if;
  with filtered as (
    select a.*,p.name as user_name from public.security_alerts a join public.profiles p on p.id=a.user_id
    where (p_view='all' or (p_view='unreviewed' and a.reviewed_at is null) or (p_view='reviewed' and a.reviewed_at is not null))
      and (p_severity is null or a.severity=p_severity)
  ), page as (select * from filtered order by created_at desc,id desc limit p_limit offset (p_page-1)*p_limit)
  select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),
    'count',(select count(*) from filtered),'page',p_page,'limit',p_limit) into result;
  return result;
end $$;

create or replace function public.review_security_alert(p_alert uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare alert public.security_alerts;
begin
  perform 1 from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into alert from public.security_alerts where id=p_alert for update;
  if not found then raise exception 'Alert not found' using errcode='P0002'; end if;
  if alert.reviewed_at is null then
    update public.security_alerts set reviewed_at=now(),reviewed_by=p_actor where id=p_alert returning * into alert;
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'security.alert_reviewed','security_alerts',alert.id::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('reviewed_at','reviewed_by')));
  end if;
  return to_jsonb(alert);
end $$;

revoke all on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  to service_role;


-- Shared assignment write: pending work follows ownership; completed history stays put.
create function public.handover_lead(p_lead uuid,p_actor uuid,p_owner uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare recipient uuid; f integer; v integer; r integer;
begin
  perform pg_advisory_xact_lock(873420);
  perform id from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_owner is not null then
    perform id from public.profiles where id=p_owner and active and role='agent' for share;
    if not found then raise exception 'Choose an active agent' using errcode='22023'; end if;
  end if;
  perform id from public.leads where id=p_lead for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  recipient=coalesce(p_owner,p_actor);
  update public.leads set assigned_agent=p_owner,updated_at=now(),last_activity_at=now() where id=p_lead;
  insert into public.assignments(lead_id,agent_id,actor_id) values(p_lead,p_owner,p_actor);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'assign','leads',p_lead::text,p_request,jsonb_build_object('agent_id',p_owner));
  update public.followups set agent_id=recipient where lead_id=p_lead and status='pending' and agent_id is distinct from recipient;
  get diagnostics f=row_count;
  update public.visits set agent_id=recipient where lead_id=p_lead and status='scheduled' and agent_id is distinct from recipient;
  get diagnostics v=row_count;
  update public.reminders m set agent_id=recipient from public.followups x
    where m.followup_id=x.id and x.lead_id=p_lead and x.status='pending'
      and m.read_at is null and m.due_at>now() and m.agent_id is distinct from recipient;
  get diagnostics r=row_count;
  return jsonb_build_object('followups',f,'visits',v,'reminders',r);
end $$;

-- Keep the general round-robin algorithm and existing four-argument signature.
create or replace function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare chosen uuid;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501'; end if;
  chosen=p_agent;
  if chosen is null then
    select p.id into chosen from public.profiles p left join public.assignments a on a.agent_id=p.id
      where p.active and p.role='agent' group by p.id order by max(a.created_at) nulls first,p.id limit 1;
  end if;
  if chosen is null then raise exception 'No active agent' using errcode='22023'; end if;
  perform public.handover_lead(p_lead,p_actor,chosen,p_request);
  return chosen;
end $$;

create function public.offboard_preview(p_actor uuid,p_session text,p_unlock text,p_agent uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  perform id from public.profiles where id=p_agent and role='agent' for share;
  if not found then raise exception 'Agent account not found' using errcode='P0002'; end if;
  return jsonb_build_object(
    'leads',(select count(*) from public.leads where assigned_agent=p_agent),
    'followups',(select count(*) from public.followups f join public.leads l on l.id=f.lead_id where l.assigned_agent=p_agent and f.status='pending'),
    'visits',(select count(*) from public.visits v join public.leads l on l.id=v.lead_id where l.assigned_agent=p_agent and v.status='scheduled'),
    'reminders',(select count(*) from public.reminders m join public.followups f on f.id=m.followup_id join public.leads l on l.id=f.lead_id
      where l.assigned_agent=p_agent and f.status='pending' and m.read_at is null and m.due_at>now()));
end $$;

create function public.offboard_agent(p_actor uuid,p_session text,p_unlock text,p_agent uuid,p_mode text,p_target uuid,p_request text,p_changes jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source public.profiles; item record; chosen uuid; workload bigint; loads jsonb; counts jsonb; transferred jsonb;
  n integer=0; f integer=0; v integer=0; r integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_mode is null or p_mode not in ('equal','single','admin')
    or (p_mode='single' and (p_target is null or p_target=p_agent))
    or (p_mode<>'single' and p_target is not null)
    or jsonb_typeof(p_changes) is distinct from 'object' or (p_changes-array['name','role'])<>'{}'::jsonb then
    raise exception 'Invalid handover settings' using errcode='22023'; end if;
  select * into source from public.profiles where id=p_agent for update;
  if not found or source.role<>'agent' then raise exception 'Agent account not found' using errcode='P0002'; end if;
  perform id from public.profiles where active and role='agent' and id<>p_agent order by id for share;
  if p_mode='single' and not exists(select 1 from public.profiles where id=p_target and active and role='agent') then
    raise exception 'Choose an active agent' using errcode='22023'; end if;
  perform id from public.leads where assigned_agent=p_agent order by id for update;
  if p_mode='equal' then
    select coalesce(jsonb_object_agg(p.id::text,(select count(*) from public.leads l where l.assigned_agent=p.id and l.status not in ('won','lost'))),'{}'::jsonb)
      into loads from public.profiles p where p.active and p.role='agent' and p.id<>p_agent;
    if loads='{}'::jsonb and exists(select 1 from public.leads where assigned_agent=p_agent) then
      raise exception 'No other active agents. Choose Keep with admin.' using errcode='22023'; end if;
  end if;
  update public.profiles set active=false where id=p_agent;
  delete from public.account_unlocks where admin_id=p_agent;
  for item in select id from public.leads where assigned_agent=p_agent order by id loop
    chosen=p_target;
    if p_mode='equal' then
      select key::uuid,value::bigint into chosen,workload from jsonb_each_text(loads) order by value::bigint,key limit 1;
      loads=jsonb_set(loads,array[chosen::text],to_jsonb(workload+1));
    end if;
    if p_mode='admin' then
      transferred=public.handover_lead(item.id,p_actor,null,p_request);
    else
      -- Use the unchanged assignment history/audit path, then count transferred work.
      select jsonb_build_object(
        'followups',(select count(*) from public.followups where lead_id=item.id and status='pending' and agent_id is distinct from chosen),
        'visits',(select count(*) from public.visits where lead_id=item.id and status='scheduled' and agent_id is distinct from chosen),
        'reminders',(select count(*) from public.reminders m join public.followups x on x.id=m.followup_id where x.lead_id=item.id and x.status='pending' and m.read_at is null and m.due_at>now() and m.agent_id is distinct from chosen)) into transferred;
      perform public.assign_lead(item.id,p_actor,chosen,p_request);
    end if;
    n=n+1; f=f+(transferred->>'followups')::integer; v=v+(transferred->>'visits')::integer; r=r+(transferred->>'reminders')::integer;
  end loop;
  if p_changes<>'{}'::jsonb then
    perform public.update_account(p_actor,p_session,p_unlock,p_agent,p_changes,p_request);
  end if;
  counts=jsonb_build_object('leads',n,'followups',f,'visits',v,'reminders',r,'mode',p_mode,'target',p_target);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'offboard_agent','profiles',p_agent::text,p_request,counts);
  return counts||jsonb_build_object('id',p_agent,'active',false);
end $$;

-- Client KYC belongs to its document so all its attachments inherit one live rule.
alter table public.knowledge_documents add column lead_id uuid references public.leads(id);
create index knowledge_documents_lead on public.knowledge_documents(lead_id) where lead_id is not null;
create function public.require_kyc_client() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.category='client_kyc' and new.lead_id is null then
    if tg_op='INSERT' then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
    if old.category<>'client_kyc' or old.lead_id is not null then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
  end if;
  return new;
end $$;
create trigger require_kyc_client before insert or update on public.knowledge_documents for each row execute function public.require_kyc_client();

create function public.knowledge_document_access(p_id uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; doc public.knowledge_documents; client public.leads;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  select * into doc from public.knowledge_documents where id=p_id for share;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if doc.category='client_kyc' then
    select * into client from public.leads where id=doc.lead_id for share;
    if actor.role<>'admin' and (client.id is null or client.assigned_agent is distinct from p_actor) then
      raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  return to_jsonb(doc)||jsonb_build_object('lead_name',client.name);
end $$;

create function public.read_knowledge_document(p_id uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare doc jsonb; files jsonb;
begin
  doc=public.knowledge_document_access(p_id,p_actor);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'file_name',file_name,'mime_type',mime_type,'size_bytes',size_bytes,'created_at',created_at) order by created_at,id),'[]'::jsonb)
    into files from public.knowledge_files where document_id=p_id;
  return doc||jsonb_build_object('files',files);
end $$;

create function public.read_knowledge_file(p_document uuid,p_file uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare file public.knowledge_files;
begin
  perform public.knowledge_document_access(p_document,p_actor);
  select * into file from public.knowledge_files where document_id=p_document and id=p_file for share;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  return to_jsonb(file);
end $$;
create function public.authorize_knowledge_download(p_document uuid,p_file uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare file jsonb;
begin
  file=public.read_knowledge_file(p_document,p_file,p_actor);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'download_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',p_file));
  return file;
end $$;

create function public.knowledge_documents_page(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text,p_lead uuid default null,p_unlinked boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; rows jsonb; total bigint;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or p_search is null or length(p_search)>100 or p_category is null or p_unlinked is null
    or p_category not in ('','documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements') then
    raise exception 'Invalid document filters' using errcode='22023'; end if;
  if p_unlinked and actor.role<>'admin' then raise exception 'Entry not found' using errcode='P0002'; end if;
  if p_lead is not null then
    perform id from public.leads where id=p_lead and (actor.role='admin' or assigned_agent=p_actor) for share;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  with eligible as (
    select d.id,d.title,d.category,d.property_name,d.keywords,d.created_at,d.updated_at,d.lead_id,
      case when d.category='client_kyc' then l.name end as lead_name,
      (select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'file_name',f.file_name,'mime_type',f.mime_type,'size_bytes',f.size_bytes,'created_at',f.created_at) order by f.created_at,f.id),'[]'::jsonb) from public.knowledge_files f where f.document_id=d.id) files
    from public.knowledge_documents d left join public.leads l on l.id=d.lead_id
    where (d.category<>'client_kyc' or actor.role='admin' or l.assigned_agent=p_actor)
      and (p_category='' or d.category=p_category)
      and (p_lead is null or (d.category='client_kyc' and d.lead_id=p_lead))
      and (not p_unlinked or (d.category='client_kyc' and d.lead_id is null))
      and (p_search='' or position(lower(p_search) in lower(d.title||' '||d.property_name||' '||d.keywords||' '||d.content))>0)
  ), page_rows as (select * from eligible order by updated_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id) from page_rows r),'[]'::jsonb),(select count(*) from eligible) into rows,total;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit);
end $$;
create or replace function public.list_knowledge_documents(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text)
returns jsonb language sql security definer set search_path='' as $$
  select public.knowledge_documents_page(p_actor,p_page,p_limit,p_search,p_category,null,false)
$$;

create function public.search_kyc_clients(p_actor uuid,p_search text,p_limit integer,p_selected uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
  perform public.accounts_admin(p_actor);
  if p_search is null or length(p_search)>100 or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Invalid client search' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
    select id,name,masked_phone from public.leads where
      (p_selected is not null and id=p_selected) or (p_selected is null and (p_search='' or position(lower(p_search) in lower(name))>0))
      order by name,id limit p_limit
  ) x;
  return rows;
end $$;

-- Alert on work stranded by a direct profile edit; never hand it over automatically.
create unique index inactive_owner_alert_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date)) where type='inactive_agent_leads';
create function public.report_inactive_lead_owners()
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner record; alert_id uuid; actor uuid; n integer=0;
begin
  if not pg_try_advisory_xact_lock(hashtext('hd_job_inactive_owners')) then return '{"skipped":true}'::jsonb; end if;
  perform pg_advisory_xact_lock(873420);
  select id into actor from public.profiles where active and role='admin' order by id limit 1;
  for owner in select p.id,count(*)::integer leads from public.profiles p join public.leads l on l.assigned_agent=p.id where not p.active group by p.id order by p.id loop
    insert into public.security_alerts(type,severity,user_id,message,metadata)
      values('inactive_agent_leads','critical',owner.id,'Inactive account still owns customer work. An administrator must hand it over.',jsonb_build_object('leads',owner.leads))
      on conflict do nothing returning id into alert_id;
    if alert_id is not null then
      n=n+1;
      insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
        values(actor,'inactive_agent_work_found','profiles',owner.id::text,'job:inactive-lead-owners',jsonb_build_object('leads',owner.leads,'alert_id',alert_id));
    end if;
  end loop;
  return jsonb_build_object('affected',n);
end $$;

-- Remaining overrides and grants follow below.

create or replace function public.update_account(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.profiles; result public.profiles;
begin
  -- Serialize account-role/access edits before locking administrator rows.
  perform pg_advisory_xact_lock(873420);
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}'::jsonb or (p_data-array['name','role','active'])<>'{}'::jsonb
    or (p_data?'name' and (jsonb_typeof(p_data->'name')<>'string' or length(btrim(p_data->>'name')) not between 1 and 200))
    or (p_data?'role' and coalesce(p_data->>'role','') not in ('admin','agent'))
    or (p_data?'active' and jsonb_typeof(p_data->'active') is distinct from 'boolean') then raise exception 'Invalid account fields' using errcode='22023'; end if;
  select * into target from public.profiles where id=p_target for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if target.role='agent' and p_data?'active' and not (p_data->>'active')::boolean
    and exists(select 1 from public.leads where assigned_agent=p_target) then
    raise exception 'Use the agent handover dialog before disabling an agent with leads' using errcode='22023'; end if;
  if p_target=p_actor and ((p_data?'role' and p_data->>'role'<>'admin') or (p_data?'active' and not (p_data->>'active')::boolean)) then raise exception 'You cannot disable or demote your own administrator account' using errcode='22023'; end if;
  if target.active and target.role='admin' and (coalesce(p_data->>'role',target.role)<>'admin' or not coalesce((p_data->>'active')::boolean,target.active))
    and (select count(*) from public.profiles where role='admin' and active)<=1 then raise exception 'Keep at least one active administrator' using errcode='22023'; end if;
  update public.profiles set name=case when p_data?'name' then btrim(p_data->>'name') else name end,
    role=coalesce(p_data->>'role',role),active=coalesce((p_data->>'active')::boolean,active) where id=p_target returning * into result;
  if not result.active or result.role<>'admin' then delete from public.account_unlocks where admin_id=p_target; end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'manage_account','profiles',p_target::text,p_request,jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
  return to_jsonb(result);
end $$;

create or replace function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents; fields jsonb; linked uuid; previous public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content','property_name','keywords','lead_id']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements')
    or (p_data?'property_name' and (jsonb_typeof(p_data->'property_name') is distinct from 'string' or length(btrim(p_data->>'property_name'))>200))
    or (p_data?'keywords' and (jsonb_typeof(p_data->'keywords') is distinct from 'string' or length(btrim(p_data->>'keywords'))>500)) then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is not null then
    select * into previous from public.knowledge_documents where id=p_id for update;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  if p_data?'lead_id' and p_data->'lead_id'<>'null'::jsonb and jsonb_typeof(p_data->'lead_id') is distinct from 'string' then
    raise exception 'Invalid client' using errcode='22023'; end if;
  begin
    linked=case when p_data?'lead_id' then nullif(p_data->>'lead_id','')::uuid else previous.lead_id end;
  exception when invalid_text_representation then raise exception 'Choose an existing client' using errcode='22023'; end;
  if p_data->>'category'='client_kyc' then
    if linked is null then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
    perform id from public.leads where id=linked for share;
    if not found then raise exception 'Choose an existing client' using errcode='22023'; end if;
  else linked=null; end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,property_name,keywords,lead_id,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),coalesce(btrim(p_data->>'property_name'),''),coalesce(btrim(p_data->>'keywords'),''),linked,p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),
      property_name=case when p_data?'property_name' then btrim(p_data->>'property_name') else property_name end,
      keywords=case when p_data?'keywords' then btrim(p_data->>'keywords') else keywords end,
      lead_id=linked,updated_by=p_actor,updated_at=now() where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  fields=jsonb_build_array('title','category','content');
  if p_data?'property_name' then fields=fields||jsonb_build_array('property_name'); end if;
  if p_data?'keywords' then fields=fields||jsonb_build_array('keywords'); end if;
  if p_data?'lead_id' then fields=fields||jsonb_build_array('lead_id'); end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,jsonb_build_object('fields',fields));
  return to_jsonb(result);
end $$;

create or replace function public.attach_knowledge_file(p_document uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_files; doc public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  select * into doc from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if doc.category='client_kyc' and doc.lead_id is null then raise exception 'Link Client KYC to a client before attaching files' using errcode='22023'; end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data-array['file_name','mime_type','size_bytes','storage_path'])<>'{}'::jsonb
    or coalesce(p_data->>'storage_path','') !~ ('^'||p_document::text||'/[0-9a-f-]{36}$')
    or not exists(select 1 from public.knowledge_file_cleanup where storage_path=p_data->>'storage_path' and document_id=p_document) then
    raise exception 'Invalid file metadata' using errcode='22023';
  end if;
  insert into public.knowledge_files(document_id,file_name,mime_type,size_bytes,storage_path,created_by)
    values(p_document,p_data->>'file_name',p_data->>'mime_type',(p_data->>'size_bytes')::integer,p_data->>'storage_path',p_actor)
    returning * into result;
  delete from public.knowledge_file_cleanup where storage_path=result.storage_path;
  update public.knowledge_documents set updated_at=now(),updated_by=p_actor where id=p_document;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'upload_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',result.id));
  return to_jsonb(result)-'storage_path';
end $$;

create or replace function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n int; stale_lead record; admin_id uuid; begin
if not pg_try_advisory_xact_lock(hashtext('hd_job_'||p_job)) then return '{"skipped":true}'::jsonb; end if;
if p_job='followups' then
insert into public.reminders(agent_id,followup_id,due_at) select coalesce(l.assigned_agent,f.agent_id),f.id,f.due_at from public.followups f join public.leads l on l.id=f.lead_id join public.profiles p on p.id=coalesce(l.assigned_agent,f.agent_id) where p.active and f.status='pending' and f.due_at<=now()+interval '1 day' on conflict(followup_id,due_at) do nothing; get diagnostics n=row_count;
elsif p_job='outcomes' then update public.calls set missing_outcome=true where status='completed' and outcome_submitted_at is null and not missing_outcome and ended_at<now()-make_interval(mins=>coalesce((p_settings->>'grace_minutes')::int,30));get diagnostics n=row_count;
elsif p_job='stale' then
perform pg_advisory_xact_lock(873420);
select id into admin_id from public.profiles where role='admin' and active order by id limit 1;n=0;
if admin_id is not null then for stale_lead in select id from public.leads l where (l.assigned_agent is null or exists(select 1 from public.profiles p where p.id=l.assigned_agent and p.active)) and status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('handover_lead','assign_lead','offboard_preview','offboard_agent','update_account',
     'require_kyc_client','knowledge_document_access','read_knowledge_document','read_knowledge_file',
     'authorize_knowledge_download','knowledge_documents_page','list_knowledge_documents','search_kyc_clients',
     'save_knowledge_document','attach_knowledge_file','report_inactive_lead_owners','run_crm_job') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst, 'reload schema';



-- Migration: 023_admin_account_invitations.sql

-- Apply once after 022. Existing verified accounts, role/PIN protections and history are retained.

create table public.account_invitations (
  user_id uuid primary key references public.profiles(id),
  email text not null,
  token_hash text not null check(length(token_hash)=64),
  state text not null check(state in ('preparing','sent','failed','accepted','cancelled')),
  desired_active boolean not null default true,
  issued_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  sent_at timestamptz,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz
);
create unique index account_invitations_email on public.account_invitations(lower(email));
alter table public.account_invitations enable row level security;
revoke all on public.account_invitations from public,anon,authenticated;
grant all on public.account_invitations to service_role;

-- Unmanaged Auth signup never grants CRM access. Names/roles cannot override this.
create or replace function public.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,name,active) values(new.id,coalesce(new.raw_user_meta_data->>'name','Team member'),false);
  return new;
end $$;
-- Historical unconfirmed users need verification followed by an admin activation.
with blocked as (
  update public.profiles p set active=false from auth.users u
    where u.id=p.id and p.active and nullif(to_jsonb(u)->>'email_confirmed_at','') is null returning p.id
)
insert into public.audit_log(action,entity,request_id,metadata)
  select 'migration.pending_access_blocked','profiles','migration:023',jsonb_build_object('count',count(*)) from blocked having count(*)>0;

create function public.account_lifecycle(p_id uuid,p_active boolean,p_confirmed text) returns text language plpgsql stable security definer set search_path='' as $$
declare invitation public.account_invitations;
begin
  select * into invitation from public.account_invitations where user_id=p_id;
  if found and invitation.state<>'accepted' then
    if invitation.state='cancelled' then return 'invitation_cancelled'; end if;
    if invitation.expires_at<=now() then return 'invitation_expired'; end if;
    if invitation.state in ('preparing','failed') then return 'pending_invitation'; end if;
    return 'pending_verification';
  end if;
  if nullif(p_confirmed,'') is null then return 'pending_verification'; end if;
  return case when p_active then 'active' else 'suspended' end;
end $$;

create function public.guard_account_activation() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.active then
    if not exists(select 1 from auth.users u where u.id=new.id and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
      raise exception 'This account has not completed email verification' using errcode='22023';
    end if;
    if exists(select 1 from public.account_invitations where user_id=new.id and state<>'accepted') then
      raise exception 'This account has not accepted its invitation' using errcode='22023';
    end if;
  end if;
  return new;
end $$;
create trigger guard_account_activation before insert or update of active on public.profiles for each row execute function public.guard_account_activation();

create function public.check_account_email(p_actor uuid,p_session text,p_unlock text,p_email text,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if exists(select 1 from auth.users u where lower(to_jsonb(u)->>'email')=lower(p_email))
    or exists(select 1 from public.account_invitations where lower(email)=lower(p_email)) then
    raise exception 'An account with this email already exists' using errcode='23505'; end if;
  insert into public.audit_log(actor_id,action,entity,request_id) values(p_actor,'create_account_requested','profiles',p_request);
end $$;

create function public.issue_account_invitation(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_ttl integer,p_active boolean,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation public.account_invitations; email_address text; profile public.profiles;
begin
  perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_target=p_actor or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_ttl is null or p_ttl not between 5 and 60 or p_active is null then
    raise exception 'Invalid invitation' using errcode='22023'; end if;
  select * into profile from public.profiles where id=p_target for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if profile.active and exists(select 1 from auth.users u where u.id=p_target and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
    raise exception 'Account is already active' using errcode='22023'; end if;
  select * into invitation from public.account_invitations where user_id=p_target for update;
  if found and invitation.state='accepted' then raise exception 'Invitation already accepted' using errcode='22023'; end if;
  if found and invitation.requested_at>now()-interval '60 seconds' then raise exception 'Wait a minute before requesting another invitation' using errcode='PT429'; end if;
  select lower(to_jsonb(u)->>'email') into email_address from auth.users u where u.id=p_target;
  if email_address is null then raise exception 'Account email is unavailable' using errcode='22023'; end if;
  update public.profiles set active=false where id=p_target;
  insert into public.account_invitations(user_id,email,token_hash,state,desired_active,issued_by,expires_at)
    values(p_target,email_address,p_hash,'preparing',p_active,p_actor,now()+make_interval(mins=>p_ttl))
    on conflict(user_id) do update set email=excluded.email,token_hash=excluded.token_hash,state='preparing',desired_active=excluded.desired_active,issued_by=p_actor,requested_at=now(),expires_at=excluded.expires_at,sent_at=null,accepted_at=null,cancelled_at=null;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'invitation_requested','profiles',p_target::text,p_request);
  return jsonb_build_object('id',p_target,'email',email_address,'name',profile.name);
end $$;

create function public.finish_account_invitation(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_sent boolean,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  update public.account_invitations set state=case when p_sent then 'sent' else 'failed' end,sent_at=case when p_sent then now() else null end
    where user_id=p_target and token_hash=p_hash and state='preparing';
  if not found then raise exception 'Invitation changed; check the account' using errcode='22023'; end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,case when p_sent then 'invitation_send_requested' else 'invitation_send_failed' end,'profiles',p_target::text,p_request);
end $$;

create function public.cancel_account_invitation(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  perform id from public.profiles where id=p_target for update;
  update public.account_invitations set state='cancelled',cancelled_at=now(),desired_active=false where user_id=p_target and state<>'accepted';
  if not found then raise exception 'Pending invitation not found' using errcode='P0002'; end if;
  update public.profiles set active=false where id=p_target;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'invitation_cancelled','profiles',p_target::text,p_request);
end $$;

create function public.invitation_context(p_actor uuid,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation public.account_invitations; profile public.profiles; account jsonb;
begin
  select * into profile from public.profiles where id=p_actor for share;
  select * into invitation from public.account_invitations where user_id=p_actor and token_hash=p_hash for share;
  select to_jsonb(u) into account from auth.users u where id=p_actor;
  if profile.id is null or invitation.user_id is null or invitation.state<>'sent' or invitation.expires_at<=now()
    or nullif(account->>'email_confirmed_at','') is null or lower(account->>'email') is distinct from invitation.email then
    raise exception 'This invitation is expired, cancelled or no longer valid. Ask your administrator for a new invitation.' using errcode='P0002'; end if;
  return jsonb_build_object('name',profile.name,'role',profile.role,'email',invitation.email,'expires_at',invitation.expires_at,'email_verified',true);
end $$;

create function public.accept_account_invitation(p_actor uuid,p_hash text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation public.account_invitations; profile public.profiles;
begin
  perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
  perform id from public.profiles where id=p_actor for update;
  select * into invitation from public.account_invitations where user_id=p_actor for update;
  perform public.invitation_context(p_actor,p_hash);
  update public.account_invitations set state='accepted',accepted_at=now() where user_id=p_actor;
  update public.profiles set active=invitation.desired_active where id=p_actor returning * into profile;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'invitation_accepted','profiles',p_actor::text,p_request);
  return jsonb_build_object('role',profile.role,'active',profile.active);
end $$;

-- Preserve the audited name/role/continuity/handover checks from migration 022.
alter function public.update_account(uuid,text,text,uuid,jsonb,text) rename to update_account_022;
create function public.update_account(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result=public.update_account_022(p_actor,p_session,p_unlock,p_target,p_data,p_request);
  if p_data?'active' and not (p_data->>'active')::boolean then
    update public.account_invitations set desired_active=false where user_id=p_target and state<>'accepted';
  end if;
  return result;
end $$;
create or replace function public.accounts_page(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint; summary jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_role not in ('','admin','agent') or p_access not in ('','active','disabled','pending','expired','cancelled') then raise exception 'Invalid account filters' using errcode='22023'; end if;
  with records as (
    select p.id,p.name,p.role,p.active,p.created_at,to_jsonb(u)->>'email' email,
      to_jsonb(u)->>'last_sign_in_at' last_sign_in_at,to_jsonb(u)->>'email_confirmed_at' email_confirmed_at,
      to_jsonb(u)->>'banned_until' banned_until,public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at') account_status,i.requested_at invitation_date,i.expires_at invitation_expires_at,i.accepted_at invitation_accepted_at,i.state invitation_state,(i.user_id is not null or (nullif(to_jsonb(u)->>'email_confirmed_at','') is null and to_jsonb(u)->'raw_app_meta_data'->>'crm_provisioning'='true')) invitation_required
    from public.profiles p join auth.users u on u.id=p.id left join public.account_invitations i on i.user_id=p.id
  ), eligible as (
    select * from records where (p_role='' or role=p_role) and (p_access='' or (p_access='active' and account_status='active') or (p_access='disabled' and account_status='suspended') or (p_access='pending' and account_status in ('pending_invitation','pending_verification')) or (p_access='expired' and account_status='invitation_expired') or (p_access='cancelled' and account_status='invitation_cancelled'))
      and (p_search='' or position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(coalesce(email,'')))>0)
  ), page_rows as (select * from eligible order by created_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'::jsonb),(select count(*) from eligible),
    (select jsonb_build_object('total',count(*),'admins',count(*) filter(where role='admin' and account_status='active'),'agents',count(*) filter(where role='agent' and account_status='active'),'disabled',count(*) filter(where account_status='suspended'),'pending',count(*) filter(where account_status in ('pending_invitation','pending_verification')),'expired',count(*) filter(where account_status='invitation_expired')) from records)
    into rows,total,summary;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit,'summary',summary);
end $$;
create or replace function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  select jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'active',p.active,'created_at',p.created_at,
    'email',to_jsonb(u)->>'email','last_sign_in_at',to_jsonb(u)->>'last_sign_in_at','email_confirmed_at',to_jsonb(u)->>'email_confirmed_at','banned_until',to_jsonb(u)->>'banned_until','account_status',public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at'),'invitation_date',i.requested_at,'invitation_expires_at',i.expires_at,'invitation_accepted_at',i.accepted_at,'invitation_state',i.state,'invitation_required',(i.user_id is not null or (nullif(to_jsonb(u)->>'email_confirmed_at','') is null and to_jsonb(u)->'raw_app_meta_data'->>'crm_provisioning'='true')),
    'assigned_leads',(select count(*) from public.leads where assigned_agent=p.id),
    'completed_calls',(select count(*) from public.calls where agent_id=p.id and status='completed'),
    'open_followups',(select count(*) from public.followups where agent_id=p.id and status='pending'))
    into result from public.profiles p join auth.users u on u.id=p.id left join public.account_invitations i on i.user_id=p.id where p.id=p_target;
  if result is null then raise exception 'Account not found' using errcode='P0002'; end if;
  return result;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('create_profile','account_lifecycle','guard_account_activation','check_account_email','issue_account_invitation','finish_account_invitation','cancel_account_invitation','invitation_context','accept_account_invitation','update_account','update_account_022','accounts_page','account_detail') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 024_meta_lead_ads.sql

-- Apply once after 023. No external connection or customer data is seeded.

alter table public.leads add column meta_pending_assignment boolean not null default false;
create index leads_meta_pending on public.leads(created_at desc) where meta_pending_assignment;
create table public.meta_connections(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.profiles(id),provider_user_id text not null unique,
 status text not null default 'connected' check(status in ('connected','attention','disconnected')),
 scopes jsonb not null default '[]',expires_at timestamptz,last_success_at timestamptz,error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table crm_private.meta_credentials(connection_id uuid primary key references public.meta_connections(id),ciphertext text not null);
create table public.meta_pages(
 id text primary key check(id~'^[0-9]{1,40}$'),connection_id uuid not null references public.meta_connections(id),name text not null,
 instagram_id text,instagram_name text,enabled boolean not null default false,subscribed boolean not null default false,
 last_checked_at timestamptz,error_code text);
create table crm_private.meta_page_credentials(page_id text primary key references public.meta_pages(id),ciphertext text not null);
create table public.meta_forms(
 id text primary key check(id~'^[0-9]{1,40}$'),page_id text not null references public.meta_pages(id),name text not null,
 enabled boolean not null default false,questions jsonb not null default '[]',mapping jsonb not null default '{}',last_sync_at timestamptz);
create table crm_private.meta_oauth_states(
 state_hash text primary key,cookie_hash text not null,actor_id uuid not null references public.profiles(id),expires_at timestamptz not null,
 used_at timestamptz,created_at timestamptz not null default now());
create table public.meta_submissions(
 id uuid primary key default gen_random_uuid(),provider_lead_id text not null unique check(provider_lead_id~'^[0-9]{1,40}$'),
 page_id text not null references public.meta_pages(id),form_id text not null references public.meta_forms(id),
 platform text not null default 'meta' check(platform in ('facebook','instagram','meta')),
 ad_id text,ad_name text,adset_id text,adset_name text,campaign_id text,campaign_name text,
 submitted_at timestamptz,received_at timestamptz not null default now(),processed_at timestamptz,
 status text not null default 'queued' check(status in ('queued','processing','retry','created','duplicate','review','failed')),
 lead_id uuid references public.leads(id),attempts integer not null default 0 check(attempts between 0 and 10),
 next_attempt_at timestamptz not null default now(),lease_id uuid,lease_until timestamptz,error_code text,
 warning text,first_assigned_at timestamptz);
create index meta_submissions_queue on public.meta_submissions(next_attempt_at) where status in ('queued','retry','processing');
create index meta_submissions_lead on public.meta_submissions(lead_id);
create table crm_private.meta_answers(submission_id uuid primary key references public.meta_submissions(id),answers jsonb not null default '[]',normalized jsonb not null default '{}',expires_at timestamptz not null);
create table public.meta_notice_reads(actor_id uuid not null references public.profiles(id),submission_id uuid not null references public.meta_submissions(id),read_at timestamptz not null default now(),primary key(actor_id,submission_id));
-- Browser roles never read integrations, raw answers or credentials directly.
do $$ declare t text; begin
 foreach t in array array['public.meta_connections','public.meta_pages','public.meta_forms','public.meta_submissions','public.meta_notice_reads','crm_private.meta_credentials','crm_private.meta_page_credentials','crm_private.meta_oauth_states','crm_private.meta_answers'] loop
 execute format('alter table %s enable row level security',t);execute format('revoke all on %s from public,anon,authenticated',t);execute format('grant all on %s to service_role',t);end loop;
end $$;

create function public.meta_oauth_start(p_actor uuid,p_state text,p_cookie text,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 delete from crm_private.meta_oauth_states where expires_at<now()-interval '1 day';
 insert into crm_private.meta_oauth_states(state_hash,cookie_hash,actor_id,expires_at) values(p_state,p_cookie,p_actor,now()+interval '10 minutes');
 insert into public.audit_log(actor_id,action,entity,request_id) values(p_actor,'meta.connect_requested','meta_connections',p_request);
end $$;
create function public.meta_oauth_consume(p_state text,p_cookie text) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
 update crm_private.meta_oauth_states set used_at=now() where state_hash=p_state and cookie_hash=p_cookie and used_at is null and expires_at>now() returning actor_id into actor;
 if actor is null then raise exception 'Invalid connection session' using errcode='42501';end if;
 perform public.accounts_admin(actor);return actor;
end $$;
create function public.meta_save_connection(p_actor uuid,p_data jsonb,p_request text) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; page jsonb;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 insert into public.meta_connections(owner_id,provider_user_id,scopes,expires_at) values(p_actor,p_data->>'user_id',p_data->'scopes',nullif(p_data->>'expires_at','')::timestamptz)
 on conflict(provider_user_id) do update set owner_id=p_actor,status='connected',scopes=excluded.scopes,expires_at=excluded.expires_at,error_code=null,updated_at=now() returning id into result;
 insert into crm_private.meta_credentials values(result,p_data->>'ciphertext') on conflict(connection_id) do update set ciphertext=excluded.ciphertext;
 -- A reconnect must not keep synchronizing Pages no longer granted by Meta.
 update public.meta_pages set enabled=false,subscribed=false,error_code='reselect_page' where connection_id=result;
 for page in select value from jsonb_array_elements(p_data->'pages') loop
  if exists(select 1 from public.meta_pages where id=page->>'id' and connection_id<>result) then raise exception 'Page already belongs to another connection' using errcode='23505';end if;
  insert into public.meta_pages(id,connection_id,name,instagram_id,instagram_name) values(page->>'id',result,page->>'name',page->>'instagram_id',page->>'instagram_name')
   on conflict(id) do update set name=excluded.name,instagram_id=excluded.instagram_id,instagram_name=excluded.instagram_name,error_code=null;
  insert into crm_private.meta_page_credentials values(page->>'id',page->>'ciphertext') on conflict(page_id) do update set ciphertext=excluded.ciphertext;
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.connected','meta_connections',result::text,p_request);return result;
end $$;
create function public.meta_settings(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return jsonb_build_object(
 'connections',(select coalesce(jsonb_agg(to_jsonb(c) order by created_at),'[]') from public.meta_connections c),
 'pages',(select coalesce(jsonb_agg(to_jsonb(p) order by name,id),'[]') from public.meta_pages p),
 'forms',(select coalesce(jsonb_agg(to_jsonb(f) order by name,id),'[]') from public.meta_forms f));end $$;
create function public.meta_page_secret(p_actor uuid,p_page text) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return (select to_jsonb(p)||jsonb_build_object('ciphertext',v.ciphertext) from public.meta_pages p join crm_private.meta_page_credentials v on v.page_id=p.id join public.meta_connections c on c.id=p.connection_id where p.id=p_page and c.status<>'disconnected');end $$;
create function public.meta_save_forms(p_actor uuid,p_page text,p_forms jsonb,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare f jsonb;
begin perform public.accounts_admin(p_actor);
 if not exists(select 1 from public.meta_pages where id=p_page) then raise exception 'Page not found' using errcode='P0002';end if;
 for f in select value from jsonb_array_elements(p_forms) loop
  if exists(select 1 from public.meta_forms where id=f->>'id' and page_id<>p_page) then raise exception 'Invalid form' using errcode='22023';end if;
  insert into public.meta_forms(id,page_id,name,questions) values(f->>'id',p_page,f->>'name',coalesce(f->'questions','[]')) on conflict(id) do update set name=excluded.name,questions=excluded.questions;
 end loop;
 update public.meta_pages set last_checked_at=now() where id=p_page;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.forms_refreshed','meta_pages',p_page,p_request);
end $$;
create function public.meta_configure(p_actor uuid,p_kind text,p_id text,p_enabled boolean,p_mapping jsonb,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_kind='page' then update public.meta_pages set enabled=p_enabled,subscribed=p_enabled,last_checked_at=now(),error_code=null where id=p_id;
 elsif p_kind='form' then
  if jsonb_typeof(p_mapping) is distinct from 'object' or length(p_mapping::text)>8000 or exists(select 1 from jsonb_each_text(p_mapping) where value not in ('name','first_name','last_name','phone','email','preferred_location','budget_min','budget_max','interested_property','property_type','contact_time','message')) then raise exception 'Invalid field mapping' using errcode='22023';end if;
  update public.meta_forms set enabled=p_enabled,mapping=p_mapping where id=p_id;
 else raise exception 'Invalid configuration' using errcode='22023';end if;
 if not found then raise exception 'Page or form not found' using errcode='P0002';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'meta.configuration_changed','meta_'||p_kind,p_id,p_request,jsonb_build_object('enabled',p_enabled));
end $$;
create function public.meta_disconnect(p_actor uuid,p_id uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 update public.meta_connections set status='disconnected',updated_at=now() where id=p_id;
 if not found then raise exception 'Connection not found' using errcode='P0002';end if;
 update public.meta_pages set enabled=false,subscribed=false where connection_id=p_id;
 delete from crm_private.meta_page_credentials where page_id in(select id from public.meta_pages where connection_id=p_id);
 delete from crm_private.meta_credentials where connection_id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.disconnected','meta_connections',p_id::text,p_request);
end $$;

create function public.meta_enqueue(p_events jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e jsonb;n integer=0;inserted uuid;
begin
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>1000 then raise exception 'Invalid events' using errcode='22023';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if not exists(select 1 from public.meta_forms f join public.meta_pages p on p.id=f.page_id join public.meta_connections c on c.id=p.connection_id where f.id=e->>'form_id' and p.id=e->>'page_id' and f.enabled and p.enabled and p.subscribed and c.status='connected') then continue;end if;
  insert into public.meta_submissions(provider_lead_id,page_id,form_id,ad_id,submitted_at) values(e->>'lead_id',e->>'page_id',e->>'form_id',e->>'ad_id',nullif(e->>'submitted_at','')::timestamptz) on conflict(provider_lead_id) do nothing returning id into inserted;
  if inserted is not null then n=n+1;insert into public.integration_events(provider,event_id) values('meta',e->>'lead_id') on conflict do nothing;end if;
 end loop;return jsonb_build_object('queued',n);
end $$;
create function public.meta_claim(p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if p_limit not between 1 and 20 then raise exception 'Invalid batch' using errcode='22023';end if;
 with chosen as(select s.id from public.meta_submissions s join public.meta_forms f on f.id=s.form_id join public.meta_pages p on p.id=s.page_id join public.meta_connections c on c.id=p.connection_id
 where f.enabled and p.enabled and c.status='connected' and s.attempts<10 and ((s.status in ('queued','retry') and s.next_attempt_at<=now()) or (s.status='processing' and s.lease_until<now())) order by s.received_at for update of s skip locked limit p_limit),
 claimed as(update public.meta_submissions s set status='processing',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' from chosen where s.id=chosen.id returning s.*)
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('mapping',f.mapping,'ciphertext',v.ciphertext)),'[]') into rows from claimed s join public.meta_forms f on f.id=s.form_id join crm_private.meta_page_credentials v on v.page_id=s.page_id;
 return rows;
end $$;
create function public.meta_finish(p_id uuid,p_lease uuid,p_data jsonb,p_answers jsonb,p_attribution jsonb,p_reason text,p_retention integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions; customer uuid; actor uuid;data jsonb;
begin
 perform pg_advisory_xact_lock(873420);
 select * into s from public.meta_submissions where id=p_id for update;
 if s.id is null or s.status<>'processing' or s.lease_id is distinct from p_lease or s.lease_until<=now() then raise exception 'Stale processing lease' using errcode='40001';end if;
 if not exists(select 1 from public.meta_pages p join public.meta_forms f on f.page_id=p.id join public.meta_connections c on c.id=p.connection_id where p.id=s.page_id and f.id=s.form_id and f.enabled and p.enabled and c.status='connected') then raise exception 'Synchronization disabled' using errcode='40001';end if;
 select id into actor from public.profiles where active and role='admin' order by id limit 1 for share;
 if actor is null then raise exception 'No active administrator' using errcode='42501';end if;
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['name','phone','email','preferred_location','budget_min','budget_max','interested_property','property_type','contact_time','message'])<>'{}' then raise exception 'Invalid normalized data' using errcode='22023';end if;
 if p_retention not between 1 and 90 or p_retention is null or length(p_answers::text)>100000 then raise exception 'Invalid retention or answers' using errcode='22023';end if;
 insert into crm_private.meta_answers values(p_id,p_answers,p_data,now()+make_interval(days=>p_retention)) on conflict(submission_id) do update set answers=excluded.answers,normalized=excluded.normalized,expires_at=excluded.expires_at;
 update public.meta_submissions set platform=case when p_attribution->>'platform' in ('facebook','instagram') then p_attribution->>'platform' else 'meta' end,
 ad_id=coalesce(p_attribution->>'ad_id',ad_id),ad_name=p_attribution->>'ad_name',adset_id=p_attribution->>'adset_id',adset_name=p_attribution->>'adset_name',campaign_id=p_attribution->>'campaign_id',campaign_name=p_attribution->>'campaign_name',
 submitted_at=coalesce(nullif(p_attribution->>'submitted_at','')::timestamptz,submitted_at),warning=p_attribution->>'warning' where id=p_id;
 if p_reason is not null or coalesce(p_data->>'phone','')!~'^\+[0-9]{10,15}$' or length(btrim(coalesce(p_data->>'name',''))) not between 1 and 200 then
  update public.meta_submissions set status='review',error_code=coalesce(p_reason,'invalid_customer'),processed_at=now(),lease_id=null,lease_until=null where id=p_id;
 else
  select lead_id into customer from crm_private.lead_phones where phone=p_data->>'phone';
  if customer is null then
   data=(p_data-array['phone','interested_property','property_type','contact_time','message'])||jsonb_build_object('source','Meta');
   begin
    customer=(public.create_lead(data,p_data->>'phone',actor,'meta:'||s.provider_lead_id)).id;
    update public.leads set meta_pending_assignment=true where id=customer;
    update public.meta_submissions set status='created' where id=p_id;
   exception when unique_violation then
    select lead_id into customer from crm_private.lead_phones where phone=p_data->>'phone';
    if customer is null then raise;end if;
    update public.meta_submissions set status='duplicate' where id=p_id;
   end;
  else update public.meta_submissions set status='duplicate' where id=p_id;end if;
  update public.meta_submissions set lead_id=customer,processed_at=now(),error_code=null,lease_id=null,lease_until=null where id=p_id;
 end if;
 update public.meta_forms set last_sync_at=now() where id=s.form_id;
 update public.meta_connections set last_success_at=now(),error_code=null where id=(select connection_id from public.meta_pages where id=s.page_id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(actor,'meta.submission_processed','meta_submissions',p_id::text,'meta:'||s.provider_lead_id,jsonb_build_object('status',(select status from public.meta_submissions where id=p_id),'lead_id',customer));
 return jsonb_build_object('id',p_id,'lead_id',customer,'status',(select status from public.meta_submissions where id=p_id));
end $$;
create function public.meta_fail(p_id uuid,p_lease uuid,p_code text,p_retry boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions;
begin
 select * into s from public.meta_submissions where id=p_id for update;
 if not found or s.lease_id is distinct from p_lease or s.status<>'processing' then return;end if;
 update public.meta_submissions set status=case when p_retry and attempts<10 then 'retry' else 'failed' end,error_code=left(p_code,80),next_attempt_at=now()+make_interval(secs=>least(21600,30*power(2,least(attempts,9)))::integer),lease_id=null,lease_until=null where id=p_id;
 if p_code in ('authorization_expired','permission_denied') then update public.meta_connections set status='attention',error_code=p_code,updated_at=now() where id=(select connection_id from public.meta_pages where id=s.page_id);end if;
 insert into public.audit_log(action,entity,entity_id,metadata) values('meta.processing_failed','meta_submissions',p_id::text,jsonb_build_object('code',left(p_code,80),'attempt',s.attempts));
end $$;
create function public.meta_retry(p_actor uuid,p_id uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);update public.meta_submissions set status='queued',attempts=0,next_attempt_at=now(),error_code=null,lease_id=null,lease_until=null where id=p_id and status in ('failed','review','retry');if not found then raise exception 'Submission is not retryable' using errcode='22023';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.retry_requested','meta_submissions',p_id::text,p_request);end $$;
create function public.meta_resolve(p_actor uuid,p_id uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare lease uuid;answers jsonb;previous jsonb;attr jsonb;result jsonb;
begin perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select to_jsonb(s) into attr from public.meta_submissions s where id=p_id and status='review' for update;
 if attr is null then raise exception 'Review item not found' using errcode='P0002';end if;
 select a.answers,a.normalized into answers,previous from crm_private.meta_answers a where submission_id=p_id and expires_at>now();
 if answers is null then raise exception 'Answers expired; retry retrieval first' using errcode='22023';end if;
 lease=gen_random_uuid();update public.meta_submissions set status='processing',lease_id=lease,lease_until=now()+interval '1 minute' where id=p_id;
 result=public.meta_finish(p_id,lease,previous||p_data,answers,attr,null,30);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.review_resolved','meta_submissions',p_id::text,p_request);return result;
end $$;

-- First assignment is explicit, active-admin controlled. Scheduled round-robin cannot unlock it.
create function public.meta_first_assignment_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.meta_pending_assignment and (new.assigned_agent is distinct from old.assigned_agent or not new.meta_pending_assignment)
   and current_setting('hd.meta_explicit_assignment',true) is distinct from old.id::text then
  raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
 return new;
end $$;
create trigger meta_first_assignment_guard before update on public.leads for each row execute function public.meta_first_assignment_guard();
alter function public.assign_lead(uuid,uuid,uuid,text) rename to assign_lead_023;
create function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare pending boolean;chosen uuid;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select meta_pending_assignment into pending from public.leads where id=p_lead for update;
 if pending then
  if p_agent is null or coalesce(p_request,'') like 'job:%' then raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
  perform set_config('hd.meta_explicit_assignment',p_lead::text,true);
 end if;
 chosen=public.assign_lead_023(p_lead,p_actor,p_agent,p_request);
 if pending then
  update public.leads set meta_pending_assignment=false where id=p_lead;
  update public.meta_submissions set first_assigned_at=now() where lead_id=p_lead and status='created' and first_assigned_at is null;
  perform set_config('hd.meta_explicit_assignment','',true);
 end if;return chosen;
end $$;
create function public.meta_assign(p_actor uuid,p_leads uuid[],p_agent uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target_lead uuid;n integer;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_agent is null or not exists(select 1 from public.profiles where id=p_agent and active and role='agent') or cardinality(p_leads) not between 1 and 100 or (select count(distinct x) from unnest(p_leads)x)<>cardinality(p_leads) then raise exception 'Select leads and an active agent' using errcode='22023';end if;
 perform 1 from public.leads where id=any(p_leads) and assigned_agent is null and meta_pending_assignment order by id for update;get diagnostics n=row_count;
 if n<>cardinality(p_leads) then raise exception 'Some leads were already assigned. Refresh and select again.' using errcode='40001';end if;
 for target_lead in select l.id from public.leads l where l.id=any(p_leads) order by l.id loop perform public.assign_lead(target_lead,p_actor,p_agent,p_request);end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'meta.bulk_assigned','leads',p_request,jsonb_build_object('count',n,'agent_id',p_agent));
 return jsonb_build_object('assigned',n);
end $$;

create or replace function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n int; stale_lead record; admin_id uuid; begin
if not pg_try_advisory_xact_lock(hashtext('hd_job_'||p_job)) then return '{"skipped":true}'::jsonb; end if;
if p_job='followups' then
insert into public.reminders(agent_id,followup_id,due_at) select coalesce(l.assigned_agent,f.agent_id),f.id,f.due_at from public.followups f join public.leads l on l.id=f.lead_id join public.profiles p on p.id=coalesce(l.assigned_agent,f.agent_id) where p.active and f.status='pending' and f.due_at<=now()+interval '1 day' on conflict(followup_id,due_at) do nothing; get diagnostics n=row_count;
elsif p_job='outcomes' then update public.calls set missing_outcome=true where status='completed' and outcome_submitted_at is null and not missing_outcome and ended_at<now()-make_interval(mins=>coalesce((p_settings->>'grace_minutes')::int,30));get diagnostics n=row_count;
elsif p_job='stale' then
perform pg_advisory_xact_lock(873420);
select id into admin_id from public.profiles where role='admin' and active order by id limit 1;n=0;
if admin_id is not null then for stale_lead in select id from public.leads l where not l.meta_pending_assignment and (l.assigned_agent is null or exists(select 1 from public.profiles p where p.id=l.assigned_agent and p.active)) and status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;

create function public.meta_inbox(p_actor uuid,p_filters jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare records jsonb;total integer;ids uuid[];phones jsonb;result jsonb;lim integer;page integer;
begin
 perform public.accounts_admin(p_actor);lim=coalesce((p_filters->>'limit')::int,20);page=coalesce((p_filters->>'page')::int,1);
 if lim not between 1 and 100 or page not between 1 and 100000 then raise exception 'Invalid page' using errcode='22023';end if;
 with eligible as(
 select s.*,l.name,l.email,l.preferred_location,l.budget_min,l.budget_max,l.status lead_status,l.assigned_agent,l.meta_pending_assignment,p.name agent_name,f.name form_name,
   a.normalized->>'interested_property' interested_property,coalesce(l.name,a.normalized->>'name') customer_name
 from public.meta_submissions s left join public.leads l on l.id=s.lead_id left join public.profiles p on p.id=l.assigned_agent join public.meta_forms f on f.id=s.form_id left join crm_private.meta_answers a on a.submission_id=s.id and a.expires_at>now()
 where (coalesce(p_filters->>'platform','')='' or s.platform=p_filters->>'platform')
 and (coalesce(p_filters->>'status','')='' or s.status=p_filters->>'status')
 and (coalesce(p_filters->>'campaign','')='' or s.campaign_id=p_filters->>'campaign')
 and (coalesce(p_filters->>'form','')='' or s.form_id=p_filters->>'form')
 and (coalesce(p_filters->>'assignment','')='' or (p_filters->>'assignment'='unassigned' and l.meta_pending_assignment and l.assigned_agent is null) or(p_filters->>'assignment'='assigned' and l.assigned_agent is not null))
 and (nullif(p_filters->>'from','') is null or s.received_at>= (p_filters->>'from')::timestamptz)
 and (nullif(p_filters->>'to','') is null or s.received_at< (p_filters->>'to')::timestamptz)
 and (coalesce(p_filters->>'search','')='' or position(lower(p_filters->>'search') in lower(coalesce(l.name,a.normalized->>'name','')||' '||coalesce(l.email,a.normalized->>'email','')||' '||coalesce(s.campaign_name,'')||' '||f.name))>0)
 ),paged as(select * from eligible order by case when p_filters->>'sort'='oldest' then received_at end asc,case when coalesce(p_filters->>'sort','newest')='newest' then received_at end desc,id offset (page-1)*lim limit lim)
 select coalesce((select jsonb_agg(to_jsonb(x)) from paged x),'[]'),(select count(*) from eligible),array(select distinct lead_id from paged where lead_id is not null) into records,total,ids;
 if cardinality(ids)>0 then phones=public.lead_contact_phones(p_actor,ids,p_request)->'phones';else phones='{}';end if;
 select coalesce(jsonb_agg(x||jsonb_build_object('phone',phones->>(x->>'lead_id'))),'[]') into result from jsonb_array_elements(records)x;
 return jsonb_build_object('data',result,'count',total);
end $$;
create function public.meta_submission(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions;answers jsonb;normalized jsonb;phone jsonb;
begin perform public.accounts_admin(p_actor);select * into s from public.meta_submissions where id=p_id;
 if not found then raise exception 'Submission not found' using errcode='P0002';end if;
 select a.answers,a.normalized into answers,normalized from crm_private.meta_answers a where submission_id=p_id and expires_at>now();
 if s.lead_id is not null then phone=public.lead_contact_phones(p_actor,array[s.lead_id],p_request)->'phones';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.submission_viewed','meta_submissions',p_id::text,p_request);
 return to_jsonb(s)||jsonb_build_object('answers',answers,'normalized',normalized,'phone',phone->>s.lead_id::text,
 'lead',(select to_jsonb(l) from public.leads l where id=s.lead_id),'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by created_at desc),'[]') from public.assignments a where lead_id=s.lead_id));
end $$;
create function public.meta_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return (select jsonb_build_object('total',count(*),'facebook',count(*) filter(where platform='facebook'),'instagram',count(*) filter(where platform='instagram'),'meta',count(*) filter(where platform='meta'),'review',count(*) filter(where status='review'),'duplicates',count(*) filter(where status='duplicate'),'failures',count(*) filter(where status='failed'),'processing',count(*) filter(where status in('queued','processing','retry')),
 'unassigned',(select count(*) from public.leads where meta_pending_assignment and assigned_agent is null),
 'assigned_today',count(*) filter(where first_assigned_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi')),
 'notifications',(select coalesce(jsonb_agg(to_jsonb(n)),'[]') from (select s.id,s.platform,coalesce(l.name,a.normalized->>'name','Submission needs review') name,s.status from public.meta_submissions s left join public.leads l on l.id=s.lead_id left join crm_private.meta_answers a on a.submission_id=s.id and a.expires_at>now() where s.status in('created','duplicate','review','failed') and not exists(select 1 from public.meta_notice_reads r where r.actor_id=p_actor and r.submission_id=s.id) order by s.received_at desc limit 10)n)) from public.meta_submissions);end $$;
create function public.meta_read_notice(p_actor uuid,p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);insert into public.meta_notice_reads values(p_actor,p_id,now()) on conflict do nothing;end $$;
create function public.meta_report(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin perform public.accounts_admin(p_actor);
 if p_to<=p_from or p_to-p_from>interval '366 days' then raise exception 'Use a reporting range of at most one year' using errcode='22023';end if;
 with s as(select * from public.meta_submissions where received_at>=p_from and received_at<p_to),
 first_inquiry as(select distinct on(lead_id) * from public.meta_submissions where lead_id is not null order by lead_id,received_at,id),
 customers as(select l.*,i.platform,i.campaign_id,i.campaign_name,i.form_id from public.leads l join first_inquiry i on i.lead_id=l.id where i.received_at>=p_from and i.received_at<p_to),
 groups as(select platform,coalesce(campaign_id,'') campaign_id,max(campaign_name) campaign_name,form_id,count(*) submissions,count(distinct lead_id) customer_references from s group by platform,campaign_id,form_id)
 select jsonb_build_object('submissions',(select count(*) from s),'unique_customers',(select count(*) from customers),
 'groups',coalesce((select jsonb_agg(to_jsonb(g)) from groups g),'[]'),
 'assigned',(select count(*) from customers where assigned_agent is not null),'unassigned',(select count(*) from customers where assigned_agent is null),
 'stages',(select coalesce(jsonb_object_agg(status,n),'{}') from(select status,count(*) n from customers group by status)x),
 'completed_visits',(select count(*) from public.visits v where v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to and exists(select 1 from customers c where c.id=v.lead_id)),
 'won_deals',(select count(*) from public.deals d where d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date and exists(select 1 from customers c where c.id=d.lead_id)),
 'revenue',(select coalesce(sum(d.expected_value),0) from public.deals d where d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date and exists(select 1 from customers c where c.id=d.lead_id))) into result;return result;
end $$;
create function public.meta_cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 delete from crm_private.meta_answers where expires_at<=now();
 delete from crm_private.meta_oauth_states where expires_at<now()-interval '1 day';
 -- A worker crashing on its final permitted attempt must still leave a visible failure.
 update public.meta_submissions set status='failed',error_code='attempt_limit',lease_id=null,lease_until=null where status='processing' and lease_until<now() and attempts>=10;
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'meta_%' or proname in('assign_lead','assign_lead_023','run_crm_job')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 025_admin_totp_mfa.sql

-- P5: apply once after 024. Authenticator secrets stay in Supabase Auth.

create table crm_private.mfa_attempts (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),finished_at timestamptz,
 result text not null default 'pending' check(result in ('pending','verified','failed','unavailable'))
);
create index mfa_attempts_user_time on crm_private.mfa_attempts(user_id,created_at desc);
create table crm_private.mfa_resets (
 user_id uuid primary key references public.profiles(id),operation uuid not null unique default gen_random_uuid(),
 actor_id uuid not null references public.profiles(id),started_at timestamptz not null default now(),
 status text not null check(status in ('pending','failed','complete')),completed_at timestamptz
);
alter table crm_private.mfa_attempts enable row level security;
alter table crm_private.mfa_resets enable row level security;
revoke all on crm_private.mfa_attempts,crm_private.mfa_resets from public,anon,authenticated;
grant all on crm_private.mfa_attempts,crm_private.mfa_resets to service_role;
create function public.mfa_session_state(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare state crm_private.mfa_resets;
begin
 perform id from public.profiles where id=p_actor and active for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 select * into state from crm_private.mfa_resets where user_id=p_actor;
 return jsonb_build_object('reset_pending',coalesce(state.status in ('pending','failed'),false),'reset_after',case when state.user_id is null then null else ceil(extract(epoch from state.started_at))::bigint end);
end $$;
create function public.mfa_begin_attempt(p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare attempts integer;failures integer;retry_time timestamptz;attempt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,250501));
 perform id from public.profiles where id=p_actor and active for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 if exists(select 1 from crm_private.mfa_resets where user_id=p_actor and status in('pending','failed')) then raise exception 'Two-factor reset needs administrator recovery' using errcode='55000';end if;
 delete from crm_private.mfa_attempts where created_at<now()-interval '1 day';
 select count(*),count(*) filter(where result='failed'),min(created_at)+interval '15 minutes' into attempts,failures,retry_time from crm_private.mfa_attempts where user_id=p_actor and created_at>now()-interval '15 minutes';
 if failures>=5 or attempts>=10 then return jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch from retry_time-now())))::int);end if;
 insert into crm_private.mfa_attempts(user_id) values(p_actor) returning id into attempt;
 return jsonb_build_object('allowed',true,'attempt_id',attempt);
end $$;
create function public.mfa_finish_attempt(p_actor uuid,p_attempt uuid,p_result text,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,250501));
 if p_result not in ('verified','failed','unavailable') then raise exception 'Invalid result' using errcode='22023';end if;
 update crm_private.mfa_attempts set result=p_result,finished_at=now() where id=p_attempt and user_id=p_actor and result='pending';
 if not found then raise exception 'Attempt not found' using errcode='P0002';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'auth.mfa_'||p_result,'profiles',p_actor::text,p_request);
 if p_result='failed' then
  select count(*) into n from crm_private.mfa_attempts where user_id=p_actor and result='failed' and created_at>now()-interval '15 minutes';
  if n>=5 and not exists(select 1 from public.security_alerts where user_id=p_actor and type='mfa_verification_failures' and created_at>now()-interval '15 minutes') then
   insert into public.security_alerts(type,severity,user_id,message,metadata) values('mfa_verification_failures','critical',p_actor,'Repeated incorrect authenticator codes.',jsonb_build_object('failed_attempts',n,'window_minutes',15));
  end if;
 end if;
end $$;
create function public.mfa_reset_begin(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_request text) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_gate(p_actor,p_session,p_unlock);
 if p_target=p_actor then raise exception 'Another administrator must reset your two-factor login' using errcode='22023';end if;
 perform id from public.profiles where id=p_target for update;
 if not found then raise exception 'Account not found' using errcode='P0002';end if;
 if exists(select 1 from crm_private.mfa_resets where user_id=p_target and status='pending' and started_at>now()-interval '5 minutes') then raise exception 'Reset already running' using errcode='40001';end if;
 insert into crm_private.mfa_resets(user_id,actor_id,status) values(p_target,p_actor,'pending') on conflict(user_id) do update set operation=gen_random_uuid(),actor_id=p_actor,status='pending',started_at=now(),completed_at=null returning operation into result;
 delete from public.account_unlocks where admin_id=p_target;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.mfa_reset_requested','profiles',p_target::text,p_request);
 return result;
end $$;
create function public.mfa_reset_finish(p_actor uuid,p_target uuid,p_operation uuid,p_success boolean,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 update crm_private.mfa_resets set status=case when p_success then 'complete' else 'failed' end,completed_at=case when p_success then now() else null end where user_id=p_target and operation=p_operation and actor_id=p_actor and status='pending';
 if not found then raise exception 'Reset operation changed' using errcode='40001';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,case when p_success then 'account.mfa_reset_completed' else 'account.mfa_reset_failed' end,'profiles',p_target::text,p_request);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('mfa_session_state','mfa_begin_attempt','mfa_finish_attempt','mfa_reset_begin','mfa_reset_finish') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 026_system_monitoring.sql

-- P6: apply once after 025. Operational metadata only; no native MFA policy change.

do $$ begin
 if to_regclass('crm_private.mfa_resets') is null or to_regprocedure('public.meta_cleanup()') is null then
  raise exception 'Apply missing CRM migrations through 025 before update 026.';
 end if;
end $$;
create table public.crm_schema_versions(version integer primary key,installed_at timestamptz not null default now());
insert into public.crm_schema_versions(version) values(26);
create table public.job_heartbeats(
 job text primary key check(job in('deleteOldRecordings','reportInactiveLeadOwners','reassignStaleLeads','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads')),
 last_success_at timestamptz,last_error_at timestamptz,last_error text check(last_error is null or last_error='job_failed'),
 last_run_at timestamptz not null,last_status text not null check(last_status in('success','failed'))
);
create table public.backups(
 id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),
 filename text not null check(filename ~ '^hd-crm-[A-Za-z0-9_-]+\.dump\.age$'),
 status text not null check(status in('success','failed')),bytes bigint not null check(bytes>=0),
 sha256 text check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
 error_code text check(error_code is null or error_code='backup_failed'),
 check(status<>'success' or (bytes>0 and sha256 is not null))
);
create index backups_recent on public.backups(created_at desc);
alter table public.crm_schema_versions enable row level security;
alter table public.job_heartbeats enable row level security;
alter table public.backups enable row level security;
revoke all on public.crm_schema_versions,public.job_heartbeats,public.backups from public,anon,authenticated;
grant all on public.crm_schema_versions,public.job_heartbeats,public.backups to service_role;
create function public.record_job_heartbeat(p_job text,p_success boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_success is null then raise exception 'Invalid heartbeat' using errcode='22023';end if;
 insert into public.job_heartbeats(job,last_success_at,last_error_at,last_error,last_run_at,last_status)
 values(p_job,case when p_success then now() end,case when not p_success then now() end,case when not p_success then 'job_failed' end,now(),case when p_success then 'success' else 'failed' end)
 on conflict(job) do update set last_success_at=case when p_success then now() else job_heartbeats.last_success_at end,
 last_error_at=case when not p_success then now() else job_heartbeats.last_error_at end,
 last_error=case when not p_success then 'job_failed' end,last_run_at=now(),last_status=case when p_success then 'success' else 'failed' end;
end $$;
create function public.record_backup(p_filename text,p_success boolean,p_bytes bigint,p_sha256 text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_success is null then raise exception 'Invalid backup' using errcode='22023';end if;
 insert into public.backups(filename,status,bytes,sha256,error_code) values(p_filename,case when p_success then 'success' else 'failed' end,p_bytes,p_sha256,case when not p_success then 'backup_failed' end);
end $$;
create function public.system_status(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;fresh boolean;version integer;backup jsonb;last_run timestamptz;
begin
 perform id from public.profiles where id=p_actor and active and role='admin' for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 select max(v.version) into version from public.crm_schema_versions v;
 select jsonb_agg(jsonb_build_object('job',expected.job,'status',case when h.job is null then 'not_started' when h.last_run_at<=now()-interval '5 minutes' then 'stale' else h.last_status end,'last_success_at',h.last_success_at,'last_error_at',h.last_error_at,'last_run_at',h.last_run_at)),
 bool_and(h.job is not null and h.last_status='success' and h.last_run_at>now()-interval '5 minutes'),case when count(h.job)=8 then min(h.last_run_at) end
 into rows,fresh,last_run
 from unnest(array['deleteOldRecordings','reportInactiveLeadOwners','reassignStaleLeads','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads']) expected(job)
 left join public.job_heartbeats h on h.job=expected.job;
 select jsonb_build_object('last_success_at',(select max(created_at) from public.backups where status='success'),
 'last_run_at',(select max(created_at) from public.backups),
 'status',coalesce((select status from public.backups order by created_at desc,id desc limit 1),'not_started')) into backup;
 return jsonb_build_object('ready',version=26 and coalesce(fresh,false),'migration',case when version=26 then 'current' else 'update_required' end,
 'installed_version',version,'jobs',rows,'last_job_at',last_run,'backup',backup);
end $$;
revoke all on function public.record_job_heartbeat(text,boolean),public.record_backup(text,boolean,bigint,text),public.system_status(uuid) from public,anon,authenticated;
grant execute on function public.record_job_heartbeat(text,boolean),public.record_backup(text,boolean,bigint,text),public.system_status(uuid) to service_role;
notify pgrst,'reload schema';



-- Migration: 027_loading_performance.sql

-- Apply once after 026. Add indexes/aggregate readers; keep all existing data/grants.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
do $$ declare ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
 execute format('create index leads_name_substring on public.leads using gin(name %I.gin_trgm_ops)',ns);
 execute format('create index properties_title_substring on public.properties using gin(title %I.gin_trgm_ops)',ns);
 execute format('create index lead_imports_filename_substring on public.lead_imports using gin(file_name %I.gin_trgm_ops)',ns);
end $$;
create index leads_owner_created on public.leads(assigned_agent,created_at desc,id);
create index leads_file_owner_created on public.leads(import_id,assigned_agent,created_at desc,id);
create index calls_lead_created on public.calls(lead_id,created_at desc,id);
create index calls_completed_ended on public.calls(ended_at,agent_id) where status='completed';
create index calls_agent_completed_ended on public.calls(agent_id,ended_at) where status='completed';
create index notes_lead_created on public.notes(lead_id,created_at desc,id);
create index assignments_lead_created on public.assignments(lead_id,created_at desc,id);
create index followups_lead_created on public.followups(lead_id,created_at desc,id);
create index followups_pending_due on public.followups(due_at,lead_id) where status='pending';
create index visits_lead_created on public.visits(lead_id,created_at desc,id);
create index visits_status_scheduled on public.visits(status,scheduled_at,agent_id);
create index reminders_unread_owner on public.reminders(agent_id,created_at desc) where read_at is null;
create index property_photos_property_created on public.property_photos(property_id,created_at,id);
create or replace function public.crm_leaderboard(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 with calls as(select agent_id,count(*) n from public.calls where status='completed' and ended_at>=p_from and ended_at<p_to group by agent_id),
 deals as(select agent_id,count(*) n from public.deals where stage='won' and close_date>=(p_from at time zone 'Asia/Karachi')::date and close_date<(p_to at time zone 'Asia/Karachi')::date group by agent_id)
 select coalesce(jsonb_agg(jsonb_build_object('name',p.name,'won_deals',coalesce(d.n,0),'completed_calls',coalesce(c.n,0))),'[]') into result
 from public.profiles p left join calls c on c.agent_id=p.id left join deals d on d.agent_id=p.id where p.active and p.role='agent';
 return result;
end $$;
create function public.dashboard_snapshot(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;followups jsonb;visits jsonb;targets jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'Invalid range' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(f)),'[]') into followups from
  (select f.* from public.followups f join public.leads l on l.id=f.lead_id where f.status='pending' and f.due_at<=now()+interval '1 day' and (actor.role='admin' or l.assigned_agent=p_actor) order by f.created_at desc,f.id limit 5) f;
 select coalesce(jsonb_agg(to_jsonb(v)),'[]') into visits from
  (select v.* from public.visits v join public.leads l on l.id=v.lead_id where v.status='scheduled' and (actor.role='admin' or l.assigned_agent=p_actor) order by v.created_at desc,v.id limit 5) v;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into targets from
  (select t.* from public.targets t where actor.role='agent' and t.agent_id=p_actor order by t.created_at desc,t.id limit 100) t;
 return jsonb_build_object('metrics',public.crm_metrics(p_actor,p_from,p_to,null,null),'leaders',public.crm_leaderboard(p_actor,p_from,p_to),'followups',followups,'visits',visits,'targets',targets);
end $$;
revoke all on function public.dashboard_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.dashboard_snapshot(uuid,timestamptz,timestamptz) to service_role;
create function public.property_cover_photos(p_actor uuid,p_properties uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;result jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if coalesce(cardinality(p_properties),0)>100 then raise exception 'Too many properties' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(photo)),'[]') into result from
 (select distinct on (property_id) property_id,id,storage_path,count(*) over(partition by property_id) photo_count
  from public.property_photos where property_id=any(p_properties) order by property_id,created_at,id) photo;
 return result;
end $$;
revoke all on function public.property_cover_photos(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.property_cover_photos(uuid,uuid[]) to service_role;
-- 26 is the monitoring schema contract. Readiness still checks that contract;
-- this optional performance upgrade adds no monitoring prerequisite or MFA policy.
notify pgrst,'reload schema';



-- Migration: 028_account_deletion.sql

-- Apply once after 027. Delete sign-in access while retaining business history.

do $$ begin
 if to_regprocedure('public.dashboard_snapshot(uuid,timestamp with time zone,timestamp with time zone)') is null or
    to_regprocedure('public.handover_lead(uuid,uuid,uuid,text)') is null or
    to_regclass('public.account_invitations') is null then
  raise exception 'Apply missing CRM migrations through 027 before account deletion update 028.';
 end if;
end $$;
alter table public.profiles add column deletion_requested_at timestamptz,add column deleted_at timestamptz,
 add constraint deleted_account_inactive check(deletion_requested_at is null or not active),
 add constraint deleted_account_requested check(deleted_at is null or deletion_requested_at is not null);
create table crm_private.account_deletions(
 user_id uuid primary key references public.profiles(id),
 requested_by uuid not null references public.profiles(id),
 confirmation_email text,
 operation uuid not null,
 lease_until timestamptz not null,
 counts jsonb not null,
 completed_at timestamptz
);
alter table crm_private.account_deletions enable row level security;
revoke all on crm_private.account_deletions from public,anon,authenticated;
grant all on crm_private.account_deletions to service_role;
create function public.guard_account_deletion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and old.deletion_requested_at is not null and
  (new.active or new.name is distinct from old.name or new.role is distinct from old.role or
   new.deletion_requested_at is distinct from old.deletion_requested_at or
   (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at)) then
  raise exception 'This account is being deleted and cannot be changed' using errcode='22023';
 end if;
 return new;
end $$;
create trigger guard_account_deletion before update on public.profiles for each row execute function public.guard_account_deletion();
create function public.guard_deleted_invitation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.profiles where id=new.user_id and deletion_requested_at is not null) and
  (new.state<>'cancelled' or new.desired_active) then
  raise exception 'This account is being deleted and cannot be changed' using errcode='22023';
 end if;
 return new;
end $$;
create trigger guard_deleted_invitation before insert or update on public.account_invitations for each row execute function public.guard_deleted_invitation();

create function public.prepare_account_deletion(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_email text,p_operation uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.profiles;pending crm_private.account_deletions;email_address text;item record;transferred jsonb;
 n integer=0;f integer=0;v integer=0;r integer=0;x integer;files integer;counts jsonb;
begin
 -- Same lock order as invitations, ownership changes and account role edits.
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into target from public.profiles where id=p_target for update;
 if not found then raise exception 'Account not found' using errcode='P0002';end if;
 if p_target=p_actor then raise exception 'You cannot delete your own administrator account' using errcode='22023';end if;
 select * into pending from crm_private.account_deletions where user_id=p_target for update;
 if target.deleted_at is not null then return pending.counts||jsonb_build_object('deleted',true,'id',p_target);end if;
 email_address=coalesce(pending.confirmation_email,(select to_jsonb(u)->>'email' from auth.users u where u.id=p_target));
 if p_email is null or lower(btrim(p_email)) is distinct from lower(email_address) or p_operation is null then
  raise exception 'Type the account email to confirm deletion' using errcode='22023';end if;
 if pending.user_id is not null then
  if pending.lease_until>now() then raise exception 'Account deletion is already running. Try again shortly.' using errcode='40001';end if;
  update crm_private.account_deletions set operation=p_operation,lease_until=now()+interval '2 minutes' where user_id=p_target;
  return pending.counts||jsonb_build_object('id',p_target,'deleted',false);
 end if;
 if target.active and target.role='admin' and (select count(*) from public.profiles where active and role='admin')<=1 then
  raise exception 'Keep at least one active administrator' using errcode='22023';end if;
 update public.profiles set active=false,deletion_requested_at=now() where id=p_target;
 delete from public.account_unlocks where admin_id=p_target;
 update public.account_invitations set state='cancelled',cancelled_at=coalesce(cancelled_at,now()),desired_active=false where user_id=p_target;
 for item in select id from public.leads where assigned_agent=p_target order by id loop
  transferred=public.handover_lead(item.id,p_actor,null,p_request);
  n=n+1;f=f+(transferred->>'followups')::integer;v=v+(transferred->>'visits')::integer;r=r+(transferred->>'reminders')::integer;
 end loop;
 -- Recover pending work authored by this account for leads already owned elsewhere.
 update public.followups q set agent_id=coalesce(l.assigned_agent,p_actor) from public.leads l where q.lead_id=l.id and q.agent_id=p_target and q.status='pending';
 get diagnostics x=row_count;f=f+x;
 update public.visits q set agent_id=coalesce(l.assigned_agent,p_actor) from public.leads l where q.lead_id=l.id and q.agent_id=p_target and q.status='scheduled';
 get diagnostics x=row_count;v=v+x;
 update public.reminders q set agent_id=f.agent_id from public.followups f where q.followup_id=f.id and q.agent_id=p_target and q.read_at is null and f.status='pending';
 get diagnostics x=row_count;r=r+x;
 update public.lead_imports set assigned_agent=null,assigned_by=p_actor,assigned_at=now() where assigned_agent=p_target;
 get diagnostics files=row_count;
 counts=jsonb_build_object('leads',n,'followups',f,'visits',v,'reminders',r,'files',files);
 insert into crm_private.account_deletions(user_id,requested_by,confirmation_email,operation,lease_until,counts)
  values(p_target,p_actor,email_address,p_operation,now()+interval '2 minutes',counts);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'account.delete_requested','profiles',p_target::text,p_request,counts);
 return counts||jsonb_build_object('id',p_target,'deleted',false);
end $$;
create function public.finish_account_deletion(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_operation uuid,p_success boolean,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pending crm_private.account_deletions;
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 perform id from public.profiles where id=p_target for update;
 select * into pending from crm_private.account_deletions where user_id=p_target for update;
 if not found then raise exception 'Account deletion was not prepared' using errcode='P0002';end if;
 if pending.completed_at is not null then return pending.counts||jsonb_build_object('id',p_target,'deleted',true);end if;
 if pending.operation is distinct from p_operation or p_success is null then raise exception 'Account deletion changed. Try again.' using errcode='40001';end if;
 if p_success then
  if not exists(select 1 from auth.users u where u.id=p_target and nullif(to_jsonb(u)->>'deleted_at','') is not null) then
   raise exception 'Native account deletion could not be confirmed' using errcode='22023';end if;
  update public.profiles set deleted_at=now() where id=p_target;
  -- Release the invitation email for a future, separately verified new account.
  update public.account_invitations set email='deleted:'||p_target::text where user_id=p_target;
  update crm_private.account_deletions set completed_at=now(),confirmation_email=null,lease_until=now() where user_id=p_target;
 else
  update crm_private.account_deletions set lease_until=now() where user_id=p_target;
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,case when p_success then 'account.deleted' else 'account.delete_failed' end,'profiles',p_target::text,p_request,pending.counts);
 return pending.counts||jsonb_build_object('id',p_target,'deleted',p_success);
end $$;

alter function public.account_lifecycle(uuid,boolean,text) rename to account_lifecycle_023;
create function public.account_lifecycle(p_id uuid,p_active boolean,p_confirmed text) returns text language plpgsql stable security definer set search_path='' as $$
declare profile public.profiles;begin
 select * into profile from public.profiles where id=p_id;
 if profile.deleted_at is not null then return 'deleted';end if;
 if profile.deletion_requested_at is not null then return 'deletion_pending';end if;
 return public.account_lifecycle_023(p_id,p_active,p_confirmed);
end $$;
alter function public.account_detail(uuid,text,text,uuid) rename to account_detail_023;
create function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;profile public.profiles;email_address text;begin
 result=public.account_detail_023(p_actor,p_session,p_unlock,p_target);
 select * into profile from public.profiles where id=p_target;
 if profile.deleted_at is not null then raise exception 'Account not found' using errcode='P0002';end if;
 select confirmation_email into email_address from crm_private.account_deletions where user_id=p_target;
 return result||jsonb_build_object('deletion_requested_at',profile.deletion_requested_at,'account_status',public.account_lifecycle(profile.id,profile.active,result->>'email_confirmed_at'),'email',coalesce(email_address,result->>'email'));
end $$;

create or replace function public.accounts_page(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint; summary jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_role not in ('','admin','agent') or p_access not in ('','active','disabled','pending','expired','cancelled','deleting') then raise exception 'Invalid account filters' using errcode='22023'; end if;
  with records as (
    select p.id,p.name,p.role,p.active,p.created_at,coalesce(d.confirmation_email,to_jsonb(u)->>'email') email,
      to_jsonb(u)->>'last_sign_in_at' last_sign_in_at,to_jsonb(u)->>'email_confirmed_at' email_confirmed_at,
      to_jsonb(u)->>'banned_until' banned_until,public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at') account_status,i.requested_at invitation_date,i.expires_at invitation_expires_at,i.accepted_at invitation_accepted_at,i.state invitation_state,(i.user_id is not null or (nullif(to_jsonb(u)->>'email_confirmed_at','') is null and to_jsonb(u)->'raw_app_meta_data'->>'crm_provisioning'='true')) invitation_required
    from public.profiles p join auth.users u on u.id=p.id left join public.account_invitations i on i.user_id=p.id left join crm_private.account_deletions d on d.user_id=p.id where p.deleted_at is null
  ), eligible as (
    select * from records where (p_role='' or role=p_role) and (p_access='' or (p_access='active' and account_status='active') or (p_access='disabled' and account_status in ('suspended','deletion_pending')) or (p_access='deleting' and account_status='deletion_pending') or (p_access='pending' and account_status in ('pending_invitation','pending_verification')) or (p_access='expired' and account_status='invitation_expired') or (p_access='cancelled' and account_status='invitation_cancelled'))
      and (p_search='' or position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(coalesce(email,'')))>0)
  ), page_rows as (select * from eligible order by created_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'::jsonb),(select count(*) from eligible),
    (select jsonb_build_object('total',count(*),'admins',count(*) filter(where role='admin' and account_status='active'),'agents',count(*) filter(where role='agent' and account_status='active'),'disabled',count(*) filter(where account_status='suspended'),'pending',count(*) filter(where account_status in ('pending_invitation','pending_verification')),'expired',count(*) filter(where account_status='invitation_expired')) from records)
    into rows,total,summary;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit,'summary',summary);
end $$;

do $$ declare fn record;begin
 for fn in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('guard_account_deletion','guard_deleted_invitation','prepare_account_deletion','finish_account_deletion','account_lifecycle','account_lifecycle_023','account_detail','account_detail_023','accounts_page') loop
 execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
 execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 029_lead_numbers.sql

-- Apply once after 028. Permanent identity numbers and consistent lead counts.

lock table public.leads in access exclusive mode;
alter table public.leads add column lead_no bigint;
alter table public.leads disable trigger touch_updated;
with numbered as(select id,row_number() over(order by created_at,id) n from public.leads)
update public.leads l set lead_no=n.n from numbered n where n.id=l.id;
alter table public.leads enable trigger touch_updated;
alter table public.leads alter column lead_no set not null;
alter table public.leads alter column lead_no add generated always as identity;
select setval(pg_get_serial_sequence('public.leads','lead_no'),coalesce(max(lead_no),1),count(*)>0) from public.leads;
alter table public.leads add constraint leads_lead_no_key unique(lead_no);
create function public.guard_lead_number() returns trigger language plpgsql set search_path='' as $$
begin
 if new.lead_no is distinct from old.lead_no then raise exception 'Lead number cannot be changed' using errcode='22023';end if;
 return new;
end $$;
create trigger guard_lead_number before update of lead_no on public.leads for each row execute function public.guard_lead_number();
alter function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text) rename to crm_metrics_028;
create function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 result=public.crm_metrics_028(p_actor,p_from,p_to,p_agent,p_source);
 return result||jsonb_build_object('total_leads',(select count(*) from public.leads l where
  (exists(select 1 from public.profiles where id=p_actor and active and role='admin') or l.assigned_agent=p_actor)
  and (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)));
end $$;
create or replace function public.lead_import_summary(p_import uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; batch public.lead_imports; visible integer; n integer; assigned integer; owners integer; owner_id uuid; owner_name text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  select * into batch from public.lead_imports where id=p_import;
  if not found then return null; end if;
  select count(*)::integer into visible from public.leads
    where import_id=p_import and (actor.role='admin' or assigned_agent=p_actor);
  if actor.role<>'admin' and visible=0 then return null; end if;
  select count(*)::integer,count(assigned_agent)::integer,count(distinct assigned_agent)::integer,min(assigned_agent::text)::uuid
    into n,assigned,owners,owner_id from public.leads where import_id=p_import;
  if owners<>1 or assigned<>n then owner_id=null; end if;
  if actor.role<>'admin' then owner_id=actor.id; end if;
  select name into owner_name from public.profiles where id=owner_id;
  return jsonb_build_object('id',batch.id,'file_name',batch.file_name,'file_format',batch.file_format,
    'worksheet',batch.worksheet,'created_at',batch.created_at,'legacy',batch.legacy,
    'total_rows',batch.total_rows,'imported_count',batch.imported_count,'rejected_count',batch.rejected_count,
    'lead_count',visible,'assigned_count',case when actor.role='admin' then assigned else visible end,'unassigned_count',case when actor.role='admin' then n-assigned else 0 end,'assigned_agent',owner_id,'assigned_name',owner_name,
    'mixed_assignment',actor.role='admin' and assigned>0 and owner_id is null);
end $$;
create or replace function public.dashboard_snapshot(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;followups jsonb;visits jsonb;targets jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'Invalid range' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(f)),'[]') into followups from
  (select f.*,l.lead_no,l.name as lead_name from public.followups f join public.leads l on l.id=f.lead_id where f.status='pending' and f.due_at<=now()+interval '1 day' and (actor.role='admin' or l.assigned_agent=p_actor) order by f.created_at desc,f.id limit 5) f;
 select coalesce(jsonb_agg(to_jsonb(v)),'[]') into visits from
  (select v.*,l.lead_no,l.name as lead_name from public.visits v join public.leads l on l.id=v.lead_id where v.status='scheduled' and (actor.role='admin' or l.assigned_agent=p_actor) order by v.created_at desc,v.id limit 5) v;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into targets from
  (select t.* from public.targets t where actor.role='agent' and t.agent_id=p_actor order by t.created_at desc,t.id limit 100) t;
 return jsonb_build_object('metrics',public.crm_metrics(p_actor,p_from,p_to,null,null),'leaders',public.crm_leaderboard(p_actor,p_from,p_to),'followups',followups,'visits',visits,'targets',targets);
end $$;
revoke all on function public.guard_lead_number(),public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text),public.crm_metrics_028(uuid,timestamptz,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text),public.crm_metrics_028(uuid,timestamptz,timestamptz,uuid,text) to service_role;
notify pgrst,'reload schema';



-- Migration: 030_bulk_lead_assignment.sql

-- Apply once after 029. At most 500 distinct leads; existing ownership handover rules remain.

create function public.assign_leads_bulk(p_lead_ids uuid[],p_actor uuid,p_mode text,p_agent uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;owner uuid;chosen uuid;pending boolean;recipients uuid[];rr_index int=0;rows jsonb='[]';n int=0;s int=0;f int=0;reason text;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if p_mode is null or p_mode not in ('agent','round_robin','unassign') or cardinality(p_lead_ids) not between 1 and 500 or p_lead_ids is null
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or (p_mode='agent' and p_agent is null) or (p_mode<>'agent' and p_agent is not null) then
  raise exception 'Choose 1–500 distinct leads and a valid assignment mode' using errcode='22023';end if;
 if p_mode='agent' then
  perform id from public.profiles where id=p_agent and active and role='agent' for share;
  if not found then raise exception 'Choose an active agent' using errcode='22023';end if;
 elsif p_mode='round_robin' then
  perform id from public.profiles where active and role='agent' order by id for share;
  -- now() is constant within a transaction. Capture the initial least-recent
  -- order once and rotate explicitly, rather than repeatedly comparing tied timestamps.
  select array_agg(id order by last_assigned nulls first,id) into recipients from(
   select p.id,max(a.created_at) last_assigned from public.profiles p left join public.assignments a on a.agent_id=p.id
   where p.active and p.role='agent' group by p.id
  ) eligible;
 end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  begin
   select assigned_agent,meta_pending_assignment into owner,pending from public.leads where id=item;
   if not found then raise exception 'Lead not found' using errcode='P0002';end if;
   chosen=p_agent;
   if p_mode='round_robin' then
    if pending then raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
    if coalesce(cardinality(recipients),0)=0 then raise exception 'No active agents' using errcode='22023';end if;
    chosen=recipients[1+(rr_index%cardinality(recipients))];rr_index=rr_index+1;
   end if;
   if owner is not distinct from chosen then
    s=s+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','skipped','reason','Already assigned to this owner'));
   else
    if p_mode='unassign' then perform public.handover_lead(item,p_actor,null,p_request);
    else perform public.assign_lead(item,p_actor,chosen,p_request);end if;
    n=n+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','assigned'));
   end if;
  exception when sqlstate 'P0002' or sqlstate '22023' then
   f=f+1;reason=case when sqlstate='P0002' then 'Lead not found' else 'Assignment unavailable; check the lead and active agents' end;
   rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason',reason));
  end;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_assigned','leads',p_request,jsonb_build_object('assigned',n,'skipped',s,'failed',f));
 return jsonb_build_object('assigned',n,'skipped',s,'failed',f,'results',rows);
end $$;
revoke all on function public.assign_leads_bulk(uuid[],uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.assign_leads_bulk(uuid[],uuid,text,uuid,text) to service_role;
notify pgrst,'reload schema';



-- Migration: 031_admin_lead_editing.sql

-- Apply once after 030. Edit metadata, private phone and ownership atomically.

create function public.normalize_lead_phone(p_phone text) returns text language plpgsql immutable set search_path='' as $$
declare number text;begin
 number=regexp_replace(p_phone,'[[:space:]()+.-]','','g');
 if left(number,2)='00' then number=substr(number,3);end if;
 if left(number,1)='0' then number='92'||substr(number,2);end if;
 if number is null or number !~ '^[1-9][0-9]{9,14}$' then raise exception 'Use a valid international phone number' using errcode='22023';end if;
 return '+'||number;
end $$;
create function public.update_lead_phone(p_lead uuid,p_phone text,p_actor uuid,p_request text) returns void
language plpgsql security definer set search_path='' as $$
declare number text;other_no bigint;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 perform id from public.leads where id=p_lead for update;
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 number=public.normalize_lead_phone(p_phone);
 select l.lead_no into other_no from crm_private.lead_phones p join public.leads l on l.id=p.lead_id where p.phone=number and p.lead_id<>p_lead;
 if found then raise exception 'This number already belongs to HD-%',lpad(other_no::text,greatest(6,length(other_no::text)),'0') using errcode='23505';end if;
 if exists(select 1 from crm_private.lead_phones where lead_id=p_lead and phone=number) then return;end if;
 insert into crm_private.lead_phones(lead_id,phone) values(p_lead,number) on conflict(lead_id) do update set phone=excluded.phone;
 update public.leads set masked_phone=left(number,3)||'******'||right(number,3),updated_at=now() where id=p_lead;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.phone_changed','leads',p_lead::text,p_request,'{}');
end $$;
create function public.edit_lead(p_lead uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;fields jsonb;owner uuid;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 perform id from public.leads where id=p_lead for update;
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}' or (p_data-array['name','email','source','budget_min','budget_max','preferred_location','property_id','phone','assigned_agent','status','lost_reason','lost_note'])<>'{}' then raise exception 'Invalid lead fields' using errcode='22023';end if;
 fields=p_data-'phone'-'assigned_agent';
 if fields<>'{}' then perform public.crm_mutate('leads',p_lead,fields,p_actor,p_request);end if;
 if p_data?'phone' then perform public.update_lead_phone(p_lead,p_data->>'phone',p_actor,p_request);end if;
 if p_data?'assigned_agent' then
  owner=nullif(p_data->>'assigned_agent','')::uuid;
  if owner is not null and not exists(select 1 from public.profiles where id=owner and active and role='agent') then raise exception 'Choose an active agent' using errcode='22023';end if;
  if (select assigned_agent from public.leads where id=p_lead) is distinct from owner then
   if owner is null then perform public.handover_lead(p_lead,p_actor,null,p_request);else perform public.assign_lead(p_lead,p_actor,owner,p_request);end if;
  end if;
 end if;
 select to_jsonb(l) into result from public.leads l where id=p_lead;return result;
end $$;
revoke all on function public.normalize_lead_phone(text),public.update_lead_phone(uuid,text,uuid,text),public.edit_lead(uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.normalize_lead_phone(text),public.update_lead_phone(uuid,text,uuid,text),public.edit_lead(uuid,jsonb,uuid,text) to service_role;
notify pgrst,'reload schema';



-- Migration: 032_deleted_leads_bin.sql

-- Apply once after 031. Soft deletion, 30-day restore, audited bulk actions and durable cleanup.

alter table public.leads add column deleted_at timestamptz,add column deleted_by uuid references public.profiles(id),add column delete_reason text,add column deleted_batch uuid;
alter table public.leads add constraint leads_deletion_state check((deleted_at is null and deleted_by is null and delete_reason is null and deleted_batch is null) or (deleted_at is not null and deleted_by is not null and length(btrim(delete_reason)) between 3 and 300 and deleted_batch is not null));
alter table public.lead_imports add column deleted_at timestamptz,add column deleted_by uuid references public.profiles(id),add column delete_reason text,add column deleted_batch uuid,add column delete_mode text check(delete_mode in ('file_only','file_and_leads'));
create index leads_deleted_recent on public.leads(deleted_at desc,id) where deleted_at is not null;
create index leads_active_created on public.leads(created_at desc,id) where deleted_at is null;
create view public.active_leads as select * from public.leads where deleted_at is null;
revoke all on public.active_leads from public,anon,authenticated;
grant select on public.active_leads to service_role;
create function public.format_lead_no(p_no bigint) returns text language sql immutable set search_path='' as $$select 'HD-'||lpad(p_no::text,greatest(6,length(p_no::text)),'0')$$;

-- Rewrite only read references in known CRM functions. Row types, writes and grants stay.
-- All definitions were installed by 001–031; this transaction rolls back on any mismatch.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in
 ('crm_metrics_028','crm_metrics','dashboard_snapshot','lead_contact_phones','reveal_phone','lead_import_summary','lead_imports_page','assign_lead_import',
 'handover_lead','assign_lead_023','assign_lead','assign_leads_bulk','offboard_preview','offboard_agent','update_account_022','prepare_account_deletion','accounts_page','account_detail_023',
 'advance_lead_status','log_manual_call','edit_lead','update_lead_phone','search_kyc_clients','knowledge_documents_page','knowledge_document_access','save_knowledge_document','report_inactive_lead_owners','run_crm_job','meta_assign','meta_report') loop
  body=pg_get_functiondef(fn.oid);
  body=replace(replace(body,'from public.leads','from public.active_leads'),'join public.leads','join public.active_leads');
  if fn.proname='lead_import_summary' then body=replace(body,'where id=p_import;','where id=p_import and deleted_at is null;');end if;
  if fn.proname='lead_imports_page' then body=replace(body,'where (actor.role=', 'where i.deleted_at is null and (actor.role=');body=replace(body,'where i.deleted_at is null and (actor.role=', 'where i.deleted_at is null and (actor.role=');
   -- The paged inner query uses alias b rather than i.
   body=replace(body,'from public.lead_imports b'||chr(10)||'      where i.deleted_at','from public.lead_imports b'||chr(10)||'      where b.deleted_at');end if;
  if fn.proname='assign_lead_import' then body=replace(body,'where id=p_import for update','where id=p_import and deleted_at is null for update');end if;
  if fn.proname='knowledge_document_access' then body=replace(body,'if doc.category=''client_kyc'' then', 'if doc.lead_id is not null and not exists(select 1 from public.active_leads where id=doc.lead_id) then raise exception ''Entry not found'' using errcode=''P0002'';end if;'||chr(10)||'  if doc.category=''client_kyc'' then');end if;
  if fn.proname='knowledge_documents_page' then body=replace(body,'where (d.category<>''client_kyc''', 'where (d.lead_id is null or l.id is not null) and (d.category<>''client_kyc''');end if;
  execute body;
 end loop;
end $upgrade$;
-- Unscoped leaderboard aggregates must explicitly join eligible customers.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_leaderboard(uuid,timestamptz,timestamptz)'::regprocedure);
 body=replace(body,'from public.calls where status=', 'from public.calls where exists(select 1 from public.active_leads l where l.id=lead_id) and status=');
 body=replace(body,'from public.deals where stage=', 'from public.deals where exists(select 1 from public.active_leads l where l.id=lead_id) and stage=');execute body;
end $upgrade$;

-- SQL writes must reject deleted customers before the older mutation implementation.
alter function public.crm_mutate(text,uuid,jsonb,uuid,text) rename to crm_mutate_031;
create function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid;begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_table='leads' then target=p_id;
 elsif p_table in ('notes','calls','followups','visits','deals') then
  if p_id is null then target=(p_data->>'lead_id')::uuid;
  else execute format('select lead_id from public.%I where id=$1',p_table) into target using p_id;end if;
 end if;
 if target is not null then
  perform id from public.active_leads where id=target for update;
  if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 end if;
 return public.crm_mutate_031(p_table,p_id,p_data,p_actor,p_request);
end $$;
-- Guard the renamed implementation too; all normal mutation lookups use the view.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_mutate_031(text,uuid,jsonb,uuid,text)'::regprocedure);
 body=replace(body,'from public.leads','from public.active_leads');execute body;
end $upgrade$;
create or replace function public.private_phone(p_lead uuid) returns text language sql security definer set search_path='' as $$
 select p.phone from crm_private.lead_phones p join public.active_leads l on l.id=p.lead_id where l.id=p_lead
$$;
create or replace function public.recording_access(p_call uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('storage_path',r.storage_path) from crm_private.recordings r join public.calls c on c.id=r.call_id join public.active_leads l on l.id=c.lead_id where r.call_id=p_call and r.deleted_at is null and r.created_at>now()-interval '7 days'
$$;
-- Reserve phone identity while a lead is recoverable. Both imports and manual creation share this boundary.
alter function public.create_lead(jsonb,text,uuid,text) rename to create_lead_031;
create function public.create_lead(p_data jsonb,p_phone text,p_actor uuid,p_request text) returns public.leads language plpgsql security definer set search_path='' as $$
declare number text;existing public.leads;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);number=public.normalize_lead_phone(p_phone);
 select l.* into existing from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where p.phone=number;
 if existing.deleted_at is not null then raise exception 'This number is in Deleted leads (%). Restore it instead.',public.format_lead_no(existing.lead_no) using errcode='23505';end if;
 return public.create_lead_031(p_data,number,p_actor,p_request);
end $$;
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.import_leads(text,text,text,jsonb,uuid,text)'::regprocedure);
 body=replace(body,'''error'',''Duplicate phone''', '''error'',case when sqlerrm like ''This number is in Deleted leads (HD-%'' then sqlerrm else ''Duplicate phone'' end');execute body;
end $upgrade$;

-- Count delete events over the Pakistan day, including leads later restored.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text)'::regprocedure);
 body=replace(body, 'jsonb_build_object(''total_leads'',', 'jsonb_build_object(''deleted_today'',case when exists(select 1 from public.profiles where id=p_actor and active and role=''admin'') then (select coalesce(sum((metadata->>''deleted'')::int),0) from public.audit_log where action=''lead.bulk_deleted'' and created_at>=(date_trunc(''day'',now() at time zone ''Asia/Karachi'') at time zone ''Asia/Karachi'')) else 0 end,''total_leads'',');execute body;
end $upgrade$;

-- Duplicate phone checks include recoverable leads and return only their stable number.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.update_lead_phone(uuid,text,uuid,text)'::regprocedure);
 body=replace(body,'other_no bigint;', 'other_no bigint;other_deleted timestamptz;');
 body=replace(body,'select l.lead_no into other_no from crm_private.lead_phones p join public.active_leads l', 'select l.lead_no,l.deleted_at into other_no,other_deleted from crm_private.lead_phones p join public.leads l');
 body=replace(body,'if found then raise exception ''This number already belongs', 'if other_deleted is not null then raise exception ''This number is in Deleted leads (%). Restore it instead.'',public.format_lead_no(other_no) using errcode=''23505'';end if;'||chr(10)||' if found then raise exception ''This number already belongs');execute body;
end $upgrade$;

-- Linked KYC attachments and deletion endpoints use the same current lead check.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in ('attach_knowledge_file','delete_knowledge_file','delete_knowledge_document') loop
  body=pg_get_functiondef(fn.oid);
  if fn.proname='delete_knowledge_document' then body=replace(body,'perform id from public.knowledge_documents', 'perform public.knowledge_document_access(p_id,p_actor);'||chr(10)||'  perform id from public.knowledge_documents');
  else body=replace(body,'begin', 'begin'||chr(10)||'  perform public.knowledge_document_access(p_document,p_actor);');end if;
  execute body;
 end loop;
end $upgrade$;
-- Deleted social customers cannot reappear via submission copies or cohort reports.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in ('meta_inbox','meta_summary','meta_submission','meta_report','meta_finish') loop
  body=pg_get_functiondef(fn.oid);
  body=replace(replace(body,'from public.leads','from public.active_leads'),'join public.leads','join public.active_leads');
  if fn.proname='meta_inbox' then
   body=replace(body,'select s.*,l.name,','select s.*,l.lead_no,l.name,');
   body=replace(body,'where (coalesce(p_filters->>''platform''', 'where (s.lead_id is null or l.id is not null) and (coalesce(p_filters->>''platform''');
  elsif fn.proname='meta_submission' then
   body=replace(body,'if not found then raise exception ''Submission not found''', 'if not found or (s.lead_id is not null and not exists(select 1 from public.active_leads where id=s.lead_id)) then raise exception ''Submission not found''');
  elsif fn.proname in ('meta_summary','meta_report') then
   body=replace(body,'from public.meta_submissions where', 'from public.meta_submissions where (lead_id is null or exists(select 1 from public.active_leads l where l.id=lead_id)) and');
   body=replace(body,'from public.meta_submissions);', 'from public.meta_submissions where lead_id is null or exists(select 1 from public.active_leads l where l.id=lead_id));');
   body=replace(body,'where s.status in(''created''', 'where (s.lead_id is null or l.id is not null) and s.status in(''created''');
  elsif fn.proname='meta_finish' then
   body=replace(body,'select lead_id into customer from crm_private.lead_phones where phone=p_data->>''phone'';', 'select p.lead_id into customer from crm_private.lead_phones p join public.active_leads l on l.id=p.lead_id where p.phone=p_data->>''phone'';');
   body=replace(body,'if customer is null then raise;end if;', 'if customer is null then update public.meta_submissions set status=''review'',error_code=''lead_in_deleted_bin'',processed_at=now(),lease_id=null,lease_until=null where id=p_id;return jsonb_build_object(''id'',p_id,''status'',''review'');end if;');
  end if;
  execute body;
 end loop;
end $upgrade$;

create function public.delete_leads(p_lead_ids uuid[],p_actor uuid,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;target public.leads;results jsonb='[]';n int=0;failed int=0;batch uuid=gen_random_uuid();day_count int;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–500 distinct leads' using errcode='22023';end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then raise exception 'Delete reason must contain 3–300 characters' using errcode='22023';end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  select * into target from public.leads where id=item and deleted_at is null;
  if not found then failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Lead not found'));
  elsif exists(select 1 from public.deals where lead_id=item and stage='won') then
   failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Has a won deal'));
  else
   update public.followups set status='cancelled' where lead_id=item and status='pending';
   update public.visits set status='cancelled' where lead_id=item and status='scheduled';
   delete from public.reminders where read_at is null and followup_id in(select id from public.followups where lead_id=item);
   update public.leads set deleted_at=now(),deleted_by=p_actor,delete_reason=btrim(p_reason),deleted_batch=batch,assigned_agent=null where id=item;
   n=n+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','deleted'));
  end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_deleted','leads',p_request,jsonb_build_object('deleted',n,'failed',failed));
 select coalesce(sum((metadata->>'deleted')::int),0)::int into day_count from public.audit_log where action='lead.bulk_deleted' and created_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi');
 if day_count>50 then
  insert into public.security_alerts(type,severity,user_id,message,metadata)
   select 'mass_lead_deletion','critical',p_actor,'More than 50 customer leads were deleted today.',jsonb_build_object('count',day_count)
   where not exists(select 1 from public.security_alerts where type='mass_lead_deletion' and created_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi'));
 end if;
 return jsonb_build_object('deleted',n,'failed',failed,'results',results,'batch',batch);
end $$;
create function public.restore_leads(p_lead_ids uuid[],p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;results jsonb='[]';n int=0;failed int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–500 distinct leads' using errcode='22023';end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  update public.leads set import_id=case when exists(select 1 from public.lead_imports i where i.id=import_id and i.deleted_at is not null) then null else import_id end,deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,assigned_agent=null where id=item and deleted_at>now()-interval '30 days';
  if found then n=n+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','restored'));
  else failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Lead not found or restore period expired'));end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_restored','leads',p_request,jsonb_build_object('restored',n,'failed',failed));
 return jsonb_build_object('restored',n,'failed',failed,'results',results);
end $$;
create function public.deleted_leads_page(p_actor uuid,p_page int,p_limit int,p_search text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 perform public.accounts_admin(p_actor);
 if p_page not between 1 and 100000 or p_limit not between 1 and 100 or p_search is null or length(p_search)>100 then raise exception 'Invalid bin filters' using errcode='22023';end if;
 with eligible as(select l.id,l.lead_no,l.name,l.deleted_at,l.deleted_batch,l.delete_reason,p.name deleted_by_name,greatest(0,ceil(extract(epoch from (l.deleted_at+interval '30 days'-now()))/86400))::int days_left from public.leads l join public.profiles p on p.id=l.deleted_by where l.deleted_at is not null and (p_search='' or position(lower(p_search) in lower(l.name))>0 or public.format_lead_no(l.lead_no) ilike '%'||p_search||'%' or l.lead_no::text=ltrim(p_search,'0'))),
 page_rows as(select * from eligible order by deleted_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'),'count',(select count(*) from eligible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;
create function public.lead_delete_preview(p_actor uuid,p_leads uuid[] default null,p_import uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if (p_leads is null)=(p_import is null) or (p_leads is not null and cardinality(p_leads) not between 1 and 500) then raise exception 'Choose leads or one file' using errcode='22023';end if;
 return (with eligible as(select id from public.active_leads where (p_leads is not null and id=any(p_leads)) or (p_import is not null and import_id=p_import)) select jsonb_build_object('leads',(select count(*) from eligible),'followups',(select count(*) from public.followups where lead_id in(select id from eligible) and status='pending'),'visits',(select count(*) from public.visits where lead_id in(select id from eligible) and status='scheduled'),'won',(select count(*) from public.deals where lead_id in(select id from eligible) and stage='won')));
end $$;
create function public.delete_lead_import(p_import uuid,p_actor uuid,p_mode text,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[];batch uuid=gen_random_uuid();result jsonb;n int=0;failed int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_mode is null or p_mode not in ('file_only','file_and_leads') or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then raise exception 'Delete reason and valid file mode required' using errcode='22023';end if;
 perform id from public.lead_imports where id=p_import and deleted_at is null for update;
 if not found then raise exception 'File not found' using errcode='P0002';end if;
 if p_mode='file_only' then update public.leads set import_id=null where import_id=p_import;
 else
  loop
   select array_agg(id) into ids from (select l.id from public.active_leads l where l.import_id=p_import and not exists(select 1 from public.deals where lead_id=l.id and stage='won') order by id limit 500) q;
   exit when ids is null;
   result=public.delete_leads(ids,p_actor,p_reason,p_request);n=n+(result->>'deleted')::int;
   update public.leads set deleted_batch=batch where id=any(ids) and deleted_at is not null;
  end loop;
  select count(*)::int into failed from public.active_leads where import_id=p_import;
 end if;
 -- Won-deal leads kept by the file operation remain usable as ordinary leads.
 update public.leads set import_id=null where import_id=p_import and deleted_at is null;
 update public.lead_imports set deleted_at=now(),deleted_by=p_actor,delete_reason=btrim(p_reason),deleted_batch=batch,delete_mode=p_mode,assigned_agent=null where id=p_import;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.file_deleted','lead_imports',p_import::text,p_request,jsonb_build_object('deleted',n,'failed',failed,'kept_leads',p_mode='file_only'));
 return jsonb_build_object('deleted',n,'failed',failed,'batch',batch);
end $$;
create function public.deleted_imports_page(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return (select coalesce(jsonb_agg(to_jsonb(i)),'[]') from (select id,file_name,deleted_at,delete_reason,deleted_batch from public.lead_imports where deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' order by deleted_at desc limit 100) i);
end $$;
create function public.restore_lead_import(p_import uuid,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare batch uuid;ids uuid[];result jsonb;n int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select deleted_batch into batch from public.lead_imports where id=p_import and deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' for update;
 if not found then raise exception 'Restore period expired or file not found' using errcode='P0002';end if;
 -- Restore the container first within this transaction so restored members keep it.
 update public.lead_imports set deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,delete_mode=null,assigned_agent=null where id=p_import;
 loop
  select array_agg(id) into ids from(select id from public.leads where import_id=p_import and deleted_batch=batch and deleted_at>now()-interval '30 days' order by id limit 500) q;
  exit when ids is null;result=public.restore_leads(ids,p_actor,p_request);n=n+(result->>'restored')::int;
 end loop;
 update public.lead_imports set deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,delete_mode=null,assigned_agent=null where id=p_import;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.file_restored','lead_imports',p_import::text,p_request,jsonb_build_object('restored',n));
 return jsonb_build_object('restored',n);
end $$;

-- Durable orphan-recording cleanup is independent of soon-to-be-purged call foreign keys.
create table crm_private.lead_recording_cleanup(id uuid primary key default gen_random_uuid(),storage_path text,provider_ref text,created_at timestamptz not null default now());
create table crm_private.lead_purge_runs(id boolean primary key default true check(id),last_run_at timestamptz not null);
alter table crm_private.lead_recording_cleanup enable row level security;
alter table crm_private.lead_purge_runs enable row level security;
revoke all on crm_private.lead_recording_cleanup,crm_private.lead_purge_runs from public,anon,authenticated;
grant all on crm_private.lead_recording_cleanup,crm_private.lead_purge_runs to service_role;
create function public.purge_deleted_leads(p_retention int default 30) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;ids uuid[];n int=0;begin
 if p_retention is null or p_retention not between 30 and 3650 then raise exception 'Retention must be 30–3650 days' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(320032) then return '{"skipped":true}';end if;
 perform pg_advisory_xact_lock(873420);
 if exists(select 1 from crm_private.lead_purge_runs where last_run_at>now()-interval '1 day') then return '{"skipped":true}';end if;
 select array_agg(id) into ids from (select id from public.leads where deleted_at<now()-make_interval(days=>p_retention) order by deleted_at,id limit 200 for update skip locked) q;
 foreach item in array coalesce(ids,'{}'::uuid[]) loop
  -- Won deals are additionally protected if a trusted import changed history after deletion.
  if exists(select 1 from public.deals where lead_id=item and stage='won') then continue;end if;
  insert into crm_private.lead_recording_cleanup(storage_path,provider_ref) select r.storage_path,r.provider_ref from crm_private.recordings r join public.calls c on c.id=r.call_id where c.lead_id=item and r.deleted_at is null;
  insert into public.knowledge_file_cleanup(document_id,storage_path) select f.document_id,f.storage_path from public.knowledge_files f join public.knowledge_documents d on d.id=f.document_id where d.lead_id=item on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where document_id in(select id from public.knowledge_documents where lead_id=item);
  delete from public.knowledge_documents where lead_id=item;
  delete from crm_private.recordings where call_id in(select id from public.calls where lead_id=item);
  delete from public.reminders where followup_id in(select id from public.followups where lead_id=item);
  delete from crm_private.phone_reveals where lead_id=item;
  delete from public.notes where lead_id=item;delete from public.calls where lead_id=item;delete from public.followups where lead_id=item;delete from public.visits where lead_id=item;delete from public.deals where lead_id=item;delete from public.assignments where lead_id=item;delete from public.lead_status_history where lead_id=item;
  -- Remove submission copies so normalized contacts and answers do not survive customer erasure.
  delete from crm_private.meta_answers where submission_id in(select id from public.meta_submissions where lead_id=item);
  delete from public.meta_notice_reads where submission_id in(select id from public.meta_submissions where lead_id=item);
  delete from public.meta_submissions where lead_id=item;
  delete from public.leads where id=item;n=n+1;
 end loop;
 insert into crm_private.lead_purge_runs(id,last_run_at) values(true,now()) on conflict(id) do update set last_run_at=excluded.last_run_at;
 if n>0 then insert into public.audit_log(action,entity,request_id,metadata) values('lead.purged','leads','job:purge-deleted-leads',jsonb_build_object('purged',n));end if;
 return jsonb_build_object('purged',n);
end $$;
create function public.lead_recording_cleanup_batch() returns jsonb language sql security definer set search_path='' as $$select coalesce(jsonb_agg(to_jsonb(r)),'[]') from(select * from crm_private.lead_recording_cleanup order by created_at,id limit 100)r$$;
create function public.lead_recording_cleanup_done(p_id uuid) returns void language sql security definer set search_path='' as $$delete from crm_private.lead_recording_cleanup where id=p_id$$;

-- All new functions and renamed implementations remain service-only.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('format_lead_no','crm_mutate','crm_mutate_031','create_lead','create_lead_031','private_phone','recording_access','delete_leads','restore_leads','deleted_leads_page','lead_delete_preview','delete_lead_import','deleted_imports_page','restore_lead_import','purge_deleted_leads','lead_recording_cleanup_batch','lead_recording_cleanup_done') loop
 execute format('revoke all on function %s from public,anon,authenticated',fn.signature);execute format('grant execute on function %s to service_role',fn.signature);end loop;
end $grants$;
notify pgrst,'reload schema';



-- Migration: 033_agent_email_codes.sql

-- Apply once after 032. Agent email codes are entered by a PIN-unlocked admin.

do $$ begin
 if to_regprocedure('public.purge_deleted_leads(integer)') is null then
  raise exception 'Apply missing CRM updates through 032 before agent email verification update 033.';
 end if;
end $$;
alter table public.account_invitations
 add column delivery_method text not null default 'link' check(delivery_method in ('link','email_otp')),
 add column otp_attempts integer not null default 0 check(otp_attempts between 0 and 5),
 add column otp_verified_at timestamptz,
 add column otp_claim uuid,
 add column otp_claim_until timestamptz;
create function public.agent_email_code_ready(p_actor uuid,p_session text,p_unlock text)
returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_gate(p_actor,p_session,p_unlock);end $$;

-- Keep historical link invitations usable, but never accept a code flow as a link.
alter function public.invitation_context(uuid,text) rename to invitation_context_032;
create function public.invitation_context(p_actor uuid,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.account_invitations where user_id=p_actor and delivery_method='email_otp') then
  raise exception 'Verify this agent email in Accounts using its code' using errcode='P0002';
 end if;
 return public.invitation_context_032(p_actor,p_hash);
end $$;
alter function public.issue_account_invitation(uuid,text,text,uuid,text,integer,boolean,text) rename to issue_account_invitation_032;
create function public.issue_account_invitation(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_ttl integer,p_active boolean,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 result=public.issue_account_invitation_032(p_actor,p_session,p_unlock,p_target,p_hash,p_ttl,p_active,p_request);
 update public.account_invitations set delivery_method='link',otp_attempts=0,otp_verified_at=null,otp_claim=null,otp_claim_until=null where user_id=p_target;
 return result;
end $$;

create function public.issue_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_active boolean,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare profile public.profiles; previous public.account_invitations; address text;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into profile from public.profiles where id=p_target for update;
 if profile.id is null then raise exception 'Account not found' using errcode='P0002';end if;
 if profile.role<>'agent' or profile.active or profile.deletion_requested_at is not null or p_hash is null or p_hash!~'^[a-f0-9]{64}$' then
  raise exception 'Choose a pending agent account' using errcode='22023';end if;
 select * into previous from public.account_invitations where user_id=p_target for update;
 if previous.state='accepted' then raise exception 'Email verification already completed' using errcode='22023';end if;
 if previous.requested_at>now()-interval '60 seconds' then raise exception 'Wait a minute before resending the code' using errcode='PT429';end if;
 select lower(to_jsonb(u)->>'email') into address from auth.users u where u.id=p_target;
 if address is null then raise exception 'Account email is unavailable' using errcode='22023';end if;
 insert into public.account_invitations(user_id,email,token_hash,state,desired_active,issued_by,expires_at,delivery_method)
  values(p_target,address,p_hash,'preparing',coalesce(p_active,previous.desired_active,false),p_actor,now()+interval '10 minutes','email_otp')
  on conflict(user_id) do update set email=excluded.email,token_hash=excluded.token_hash,state='preparing',desired_active=excluded.desired_active,
   issued_by=p_actor,requested_at=now(),expires_at=excluded.expires_at,sent_at=null,accepted_at=null,cancelled_at=null,
   delivery_method='email_otp',otp_attempts=0,otp_verified_at=null,otp_claim=null,otp_claim_until=null;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_requested','profiles',p_target::text,p_request);
 return jsonb_build_object('id',p_target,'name',profile.name,'email',address);
end $$;
create function public.finish_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_sent boolean,p_request text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 update public.account_invitations set state=case when p_sent then 'sent' else 'failed' end,sent_at=case when p_sent then now() else null end
  where user_id=p_target and token_hash=p_hash and delivery_method='email_otp' and state='preparing';
 if not found then raise exception 'Email code changed; request another code' using errcode='40001';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,case when p_sent then 'account.email_code_sent' else 'account.email_code_send_failed' end,'profiles',p_target::text,p_request);
end $$;
-- Native Auth owns the OTP. SQL retains only a request version, attempt count and
-- a short claim, never the code or password. A persisted proof permits safe retry
-- if password administration fails after the native one-use code was consumed.
create function public.agent_email_code_context(p_actor uuid,p_session text,p_unlock text,p_target uuid)
returns public.account_invitations language plpgsql security definer set search_path='' as $$
declare profile public.profiles; flow public.account_invitations;address text;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into profile from public.profiles where id=p_target for update;
 select * into flow from public.account_invitations where user_id=p_target for update;
 select lower(to_jsonb(u)->>'email') into address from auth.users u where u.id=p_target;
 if profile.id is null or profile.role<>'agent' or profile.active or profile.deletion_requested_at is not null or flow.user_id is null
  or flow.delivery_method<>'email_otp' or flow.state<>'sent' or flow.expires_at<=now() or address is distinct from flow.email then
  raise exception 'Email code expired, cancelled or unavailable. Resend the code.' using errcode='22023';end if;
 return flow;
end $$;
create function public.begin_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_claim uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare flow public.account_invitations;begin
 flow=public.agent_email_code_context(p_actor,p_session,p_unlock,p_target);
 if p_claim is null then raise exception 'Invalid verification request' using errcode='22023';end if;
 if flow.otp_claim is not null and flow.otp_claim_until>now() then raise exception 'Verification is already running' using errcode='40001';end if;
 if flow.otp_verified_at is null and flow.otp_attempts>=5 then raise exception 'Too many incorrect codes. Resend the code.' using errcode='PT429';end if;
 update public.account_invitations set otp_claim=p_claim,otp_claim_until=now()+interval '2 minutes',otp_attempts=otp_attempts+case when otp_verified_at is null then 1 else 0 end where user_id=p_target;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_check','profiles',p_target::text,p_request);
 return jsonb_build_object('email',flow.email,'version',flow.token_hash,'verified',flow.otp_verified_at is not null);
end $$;
create function public.mark_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_claim uuid,p_version text,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare flow public.account_invitations;begin
 flow=public.agent_email_code_context(p_actor,p_session,p_unlock,p_target);
 if p_claim is null or p_version is null or flow.otp_claim_until is null or flow.otp_claim is distinct from p_claim or flow.token_hash is distinct from p_version or flow.otp_claim_until<=now()
  or not exists(select 1 from auth.users u where u.id=p_target and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
  raise exception 'Email verification could not be confirmed' using errcode='22023';end if;
 update public.account_invitations set otp_verified_at=coalesce(otp_verified_at,now()) where user_id=p_target;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_verified','profiles',p_target::text,p_request);
end $$;
create function public.release_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_claim uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 update public.account_invitations set otp_claim=null,otp_claim_until=null where user_id=p_target and otp_claim=p_claim;
end $$;
create function public.complete_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_claim uuid,p_version text,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare flow public.account_invitations;begin
 flow=public.agent_email_code_context(p_actor,p_session,p_unlock,p_target);
 if p_claim is null or p_version is null or flow.otp_claim_until is null or flow.otp_verified_at is null or flow.otp_claim is distinct from p_claim or flow.token_hash is distinct from p_version or flow.otp_claim_until<=now()
  or not exists(select 1 from auth.users u where u.id=p_target and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
  raise exception 'Email verification could not be confirmed' using errcode='22023';end if;
 update public.account_invitations set state='accepted',accepted_at=now(),otp_claim=null,otp_claim_until=null where user_id=p_target;
 update public.profiles set active=flow.desired_active where id=p_target;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_completed','profiles',p_target::text,p_request);
 return jsonb_build_object('id',p_target,'role','agent','active',flow.desired_active,'email_verified',true,'message',case when flow.desired_active then 'Email verified and password saved. The agent can now sign in.' else 'Email verified and password saved. Account access remains disabled.' end);
end $$;

-- Extend current readers; retain deletion, handover, MFA and PIN protections.
alter function public.accounts_page(uuid,text,text,integer,integer,text,text,text) rename to accounts_page_032;
create function public.accounts_page(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; rows jsonb;begin
 result=public.accounts_page_032(p_actor,p_session,p_unlock,p_page,p_limit,p_search,p_role,p_access);
 select coalesce(jsonb_agg(r.value||jsonb_build_object('email_verification_method',i.delivery_method,'email_code_verified',i.otp_verified_at is not null) order by r.ordinality),'[]') into rows
  from jsonb_array_elements(result->'data') with ordinality r(value,ordinality) left join public.account_invitations i on i.user_id=(r.value->>'id')::uuid;
 return result||jsonb_build_object('data',rows);
end $$;
alter function public.account_detail(uuid,text,text,uuid) rename to account_detail_032;
create function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;flow public.account_invitations;begin
 result=public.account_detail_032(p_actor,p_session,p_unlock,p_target);
 select * into flow from public.account_invitations where user_id=p_target;
 return result||jsonb_build_object('email_verification_method',flow.delivery_method,'email_code_verified',flow.otp_verified_at is not null);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('invitation_context','invitation_context_032','issue_account_invitation','issue_account_invitation_032','agent_email_code_ready','issue_agent_email_code','finish_agent_email_code','agent_email_code_context','begin_agent_email_code','mark_agent_email_code','release_agent_email_code','complete_agent_email_code','accounts_page','accounts_page_032','account_detail','account_detail_032') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 034_account_email_codes.sql

-- Apply once after 033. Both new Agent and Admin accounts use native email OTP.
-- Delivery still requires a configured sender; this cannot bypass hosted quotas.

do $$ begin
 if to_regprocedure('public.agent_email_code_ready(uuid,text,text)') is null then
  raise exception 'Apply CRM update 033 before account email verification update 034.';
 end if;
end $$;

-- Bind proof to the role selected when the code was issued. A role change must
-- be followed by a fresh code, including while native verification is running.
alter table public.account_invitations add column verification_role text
 check(verification_role in ('agent','admin'));
update public.account_invitations i set verification_role=p.role
 from public.profiles p where p.id=i.user_id and i.delivery_method='email_otp';

create function public.account_email_code_ready(p_actor uuid,p_session text,p_unlock text)
returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_gate(p_actor,p_session,p_unlock);end $$;

create or replace function public.issue_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_active boolean,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare profile public.profiles; previous public.account_invitations; address text;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into profile from public.profiles where id=p_target for update;
 if profile.id is null then raise exception 'Account not found' using errcode='P0002';end if;
 if profile.role not in ('agent','admin') or profile.active or profile.deletion_requested_at is not null or p_hash is null or p_hash!~'^[a-f0-9]{64}$' then
  raise exception 'Choose a pending account' using errcode='22023';end if;
 select * into previous from public.account_invitations where user_id=p_target for update;
 if previous.state='accepted' then raise exception 'Email verification already completed' using errcode='22023';end if;
 if previous.requested_at>now()-interval '60 seconds' then raise exception 'Wait a minute before resending the code' using errcode='PT429';end if;
 select lower(to_jsonb(u)->>'email') into address from auth.users u where u.id=p_target;
 if address is null then raise exception 'Account email is unavailable' using errcode='22023';end if;
 insert into public.account_invitations(user_id,email,token_hash,state,desired_active,issued_by,expires_at,delivery_method,verification_role)
  values(p_target,address,p_hash,'preparing',coalesce(p_active,previous.desired_active,false),p_actor,now()+interval '10 minutes','email_otp',profile.role)
  on conflict(user_id) do update set email=excluded.email,token_hash=excluded.token_hash,state='preparing',desired_active=excluded.desired_active,
   issued_by=p_actor,requested_at=now(),expires_at=excluded.expires_at,sent_at=null,accepted_at=null,cancelled_at=null,
   delivery_method='email_otp',verification_role=excluded.verification_role,otp_attempts=0,otp_verified_at=null,otp_claim=null,otp_claim_until=null;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_requested','profiles',p_target::text,p_request);
 return jsonb_build_object('id',p_target,'name',profile.name,'email',address,'role',profile.role);
end $$;

create or replace function public.agent_email_code_context(p_actor uuid,p_session text,p_unlock text,p_target uuid)
returns public.account_invitations language plpgsql security definer set search_path='' as $$
declare profile public.profiles; flow public.account_invitations;address text;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into profile from public.profiles where id=p_target for update;
 select * into flow from public.account_invitations where user_id=p_target for update;
 select lower(to_jsonb(u)->>'email') into address from auth.users u where u.id=p_target;
 if profile.id is null or profile.role is distinct from flow.verification_role or profile.active or profile.deletion_requested_at is not null or flow.user_id is null
  or flow.delivery_method<>'email_otp' or flow.state<>'sent' or flow.expires_at<=now() or address is distinct from flow.email then
  raise exception 'Email code expired, cancelled or unavailable. Resend the code.' using errcode='22023';end if;
 return flow;
end $$;

create or replace function public.complete_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_claim uuid,p_version text,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare flow public.account_invitations;begin
 flow=public.agent_email_code_context(p_actor,p_session,p_unlock,p_target);
 if p_claim is null or p_version is null or flow.otp_claim_until is null or flow.otp_verified_at is null or flow.otp_claim is distinct from p_claim or flow.token_hash is distinct from p_version or flow.otp_claim_until<=now()
  or not exists(select 1 from auth.users u where u.id=p_target and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
  raise exception 'Email verification could not be confirmed' using errcode='22023';end if;
 update public.account_invitations set state='accepted',accepted_at=now(),otp_claim=null,otp_claim_until=null where user_id=p_target;
 update public.profiles set active=flow.desired_active where id=p_target;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.email_code_completed','profiles',p_target::text,p_request);
 return jsonb_build_object('id',p_target,'role',flow.verification_role,'active',flow.desired_active,'email_verified',true,'message',case when flow.desired_active then 'Email verified and password saved. The account can now sign in.' else 'Email verified and password saved. Account access remains disabled.' end);
end $$;

create or replace function public.invitation_context(p_actor uuid,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.account_invitations where user_id=p_actor and delivery_method='email_otp') then
  raise exception 'Verify this account email in Accounts using its code' using errcode='P0002';
 end if;
 return public.invitation_context_032(p_actor,p_hash);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('account_email_code_ready','issue_agent_email_code','agent_email_code_context','complete_agent_email_code','invitation_context') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 035_pending_account_verification.sql

-- Apply once after 034. Independent OTP challenges precede Auth provisioning.

do $$ begin
 if to_regprocedure('public.account_email_code_ready(uuid,text,text)') is null then
  raise exception 'Apply CRM update 034 before pending account verification update 035.';
 end if;
end $$;
create table public.account_creation_requests (
 id uuid primary key,
 normalized_email text not null,
 requested_name text not null,
 requested_role text not null check(requested_role in ('admin','agent')),
 desired_active boolean not null,
 requested_by_admin_id uuid not null references public.profiles(id),
 request_binding text not null check(request_binding ~ '^[a-f0-9]{64}$'),
 otp_hash text check(otp_hash ~ '^[a-f0-9]{64}$'),
 version uuid not null,
 otp_expires_at timestamptz not null default now()+interval '10 minutes',
 failed_attempts integer not null default 0 check(failed_attempts between 0 and 5),
 resend_count integer not null default 0 check(resend_count between 0 and 4),
 last_sent_at timestamptz not null default now(),
 status text not null check(status in ('preparing','sent','send_failed','locked','expired','cancelled','creating','completed')),
 verified_at timestamptz,
 provisioning_started_at timestamptz,
 claim uuid,
 claim_until timestamptz,
 created_at timestamptz not null default now(),
 completed_at timestamptz
);
create unique index account_creation_email_pending on public.account_creation_requests(normalized_email)
 where status not in ('completed','cancelled','expired');
create index account_creation_owner on public.account_creation_requests(requested_by_admin_id,created_at desc);
create table public.account_creation_events (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.account_creation_requests(id),
 actor_id uuid not null references public.profiles(id),
 operation text not null check(operation in ('send','verify')),
 created_at timestamptz not null default now()
);
create index account_creation_events_window on public.account_creation_events(actor_id,operation,created_at);
alter table public.account_creation_requests enable row level security;
alter table public.account_creation_events enable row level security;
revoke all on public.account_creation_requests,public.account_creation_events from public,anon,authenticated;
grant all on public.account_creation_requests,public.account_creation_events to service_role;
grant usage,select on sequence public.account_creation_events_id_seq to service_role;

-- Only safe status fields can leave the server; never hashes or full recipients.
create function public.account_creation_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('request_id',id,'name',requested_name,'role',requested_role,
 'masked_email',left(split_part(normalized_email,'@',1),1)||'***@'||split_part(normalized_email,'@',2),
 'expires_at',otp_expires_at,'resend_at',last_sent_at+interval '60 seconds','status',status,
 'completed',status='completed','id',case when status='completed' then id else null end)
 from public.account_creation_requests where id=p_id;
$$;
create function public.account_creation_context(p_actor uuid,p_session text,p_unlock text,p_id uuid)
returns public.account_creation_requests language plpgsql security definer set search_path='' as $$
declare r public.account_creation_requests;begin
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 select * into r from public.account_creation_requests where id=p_id and requested_by_admin_id=p_actor;
 if r.id is null then raise exception 'Pending request not found' using errcode='P0002';end if;
 return r;
end $$;
create function public.account_creation_list(p_actor uuid,p_session text,p_unlock text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 return (select coalesce(jsonb_agg(public.account_creation_summary(r.id) order by r.created_at desc),'[]'::jsonb)
 from (select id,created_at from public.account_creation_requests where requested_by_admin_id=p_actor and status not in ('completed','cancelled') order by created_at desc limit 50) r);
end $$;
create function public.prepare_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_email text,p_name text,p_role text,p_active boolean,p_binding text,p_hash text,p_version uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if p_id is null or p_version is null or p_email is null or p_email<>lower(trim(p_email)) or length(p_email)>254
 or p_role not in ('admin','agent') or p_role is null or p_active is null or nullif(trim(p_name),'') is null or length(p_name)>200
 or p_binding is null or p_binding!~'^[a-f0-9]{64}$' or p_hash is null or p_hash!~'^[a-f0-9]{64}$' then
  raise exception 'Invalid account request' using errcode='22023';end if;
 -- No background worker needed to expire never-verified requests. Creating
 -- rows retain their identity reservation until safely recovered.
 update public.account_creation_requests set status='expired',otp_hash=null
 where otp_expires_at<=now() and provisioning_started_at is null and status in ('preparing','sent','send_failed','locked');
 if exists(select 1 from auth.users u where lower(to_jsonb(u)->>'email')=p_email)
 or exists(select 1 from public.account_invitations where lower(email)=p_email)
 or exists(select 1 from public.account_creation_requests where normalized_email=p_email and status not in ('expired','cancelled','completed')) then
  raise exception 'An account or pending request with this email already exists' using errcode='23505';end if;
 if (select count(*) from public.account_creation_events where actor_id=p_actor and operation='send' and created_at>now()-interval '1 hour')>=20
 or (select count(*) from public.account_creation_events e join public.account_creation_requests r on r.id=e.request_id where r.normalized_email=p_email and e.operation='send' and e.created_at>now()-interval '1 hour')>=5 then
  raise exception 'Too many verification requests. Try again later.' using errcode='PT429';end if;
 insert into public.account_creation_requests(id,normalized_email,requested_name,requested_role,desired_active,requested_by_admin_id,request_binding,otp_hash,version,status)
 values(p_id,p_email,p_name,p_role,p_active,p_actor,p_binding,p_hash,p_version,'preparing');
 insert into public.account_creation_events(request_id,actor_id,operation) values(p_id,p_actor,'send');
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.requested','account_creation_requests',p_id::text,p_request);
 return public.account_creation_summary(p_id);
end $$;
create function public.resend_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_hash text,p_version uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.account_creation_requests;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 r=public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 if r.status in ('cancelled','completed') then raise exception 'Request cannot be resent.' using errcode='22023';end if;
 if r.claim is not null and r.claim_until>now() then raise exception 'Creation is already running' using errcode='40001';end if;
 if r.last_sent_at>now()-interval '60 seconds' then raise exception 'Wait 60 seconds before resending.' using errcode='PT429';end if;
 if r.resend_count>=4 or (select count(*) from public.account_creation_events where actor_id=p_actor and operation='send' and created_at>now()-interval '1 hour')>=20
 or (select count(*) from public.account_creation_events e join public.account_creation_requests q on q.id=e.request_id where q.normalized_email=r.normalized_email and e.operation='send' and e.created_at>now()-interval '1 hour')>=5 then
  raise exception 'Too many verification requests. Start a new request later.' using errcode='PT429';end if;
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_version is null then raise exception 'Invalid request' using errcode='22023';end if;
 if exists(select 1 from public.account_creation_requests where normalized_email=r.normalized_email and id<>p_id and status not in ('completed','cancelled','expired')) then raise exception 'Another pending request exists' using errcode='23505';end if;
 update public.account_creation_requests set otp_hash=p_hash,version=p_version,otp_expires_at=now()+interval '10 minutes',failed_attempts=0,resend_count=resend_count+1,last_sent_at=now(),status='preparing',verified_at=null,claim=null,claim_until=null where id=p_id;
 insert into public.account_creation_events(request_id,actor_id,operation) values(p_id,p_actor,'send');
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.resent','account_creation_requests',p_id::text,p_request);
 return public.account_creation_summary(p_id);
end $$;
create function public.finish_account_creation_email(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_version uuid,p_sent boolean,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 update public.account_creation_requests set status=case when p_sent then 'sent' else 'send_failed' end
 where id=p_id and version=p_version and status='preparing';
 if not found then raise exception 'Request changed' using errcode='40001';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,case when p_sent then 'account_creation.email_sent' else 'account_creation.email_failed' end,'account_creation_requests',p_id::text,p_request);
 return public.account_creation_summary(p_id);
end $$;
create function public.begin_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_hash text,p_binding text,p_claim uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.account_creation_requests;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 r=public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 if r.status='completed' then return jsonb_build_object('result','completed')||public.account_creation_summary(p_id);end if;
 if r.status='cancelled' then return jsonb_build_object('result','cancelled');end if;
 if r.failed_attempts>=5 or r.status='locked' then return jsonb_build_object('result','locked');end if;
 if r.otp_expires_at<=now() then return jsonb_build_object('result','expired');end if;
 if r.status not in ('sent','creating') then return jsonb_build_object('result','unavailable');end if;
 if r.claim is not null and r.claim_until>now() then return jsonb_build_object('result','busy');end if;
 if (select count(*) from public.account_creation_events where actor_id=p_actor and operation='verify' and created_at>now()-interval '15 minutes')>=100 then return jsonb_build_object('result','limited');end if;
 insert into public.account_creation_events(request_id,actor_id,operation) values(p_id,p_actor,'verify');
 if p_hash is null or p_hash is distinct from r.otp_hash or p_binding is null or p_binding is distinct from r.request_binding then
  update public.account_creation_requests set failed_attempts=failed_attempts+1,status=case when failed_attempts>=4 then 'locked' else status end where id=p_id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.rejected','account_creation_requests',p_id::text,p_request);
  return jsonb_build_object('result','invalid');
 end if;
 if p_claim is null then raise exception 'Invalid claim' using errcode='22023';end if;
 update public.account_creation_requests set verified_at=coalesce(verified_at,now()),provisioning_started_at=coalesce(provisioning_started_at,now()),status='creating',claim=p_claim,claim_until=now()+interval '2 minutes' where id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.verified','account_creation_requests',p_id::text,p_request);
 return jsonb_build_object('result','allowed');
end $$;
create function public.release_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_claim uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 update public.account_creation_requests set claim=null,claim_until=null where id=p_id and claim=p_claim;
end $$;
create function public.complete_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_claim uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.account_creation_requests;u jsonb;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 r=public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 if r.status='completed' then return public.account_creation_summary(p_id);end if;
 if r.status<>'creating' or r.verified_at is null or p_claim is null or r.claim is distinct from p_claim or r.claim_until is null or r.claim_until<=now() then
  raise exception 'Account creation changed or is already running' using errcode='40001';end if;
 select to_jsonb(a) into u from auth.users a where a.id=p_id;
 if u is null or lower(u->>'email') is distinct from r.normalized_email or nullif(u->>'email_confirmed_at','') is null
 or u->'raw_app_meta_data'->>'crm_account_request' is distinct from p_id::text or nullif(u->>'deleted_at','') is not null then
  raise exception 'Auth account could not be confirmed. Retry verification.' using errcode='22023';end if;
 if exists(select 1 from public.profiles where id=p_id and (active or deletion_requested_at is not null)) then raise exception 'Account changed' using errcode='40001';end if;
 -- Status and role activation share the audited transaction. Auth provisioning
 -- occurs beforehand with a fixed id and trigger-created inactive profile.
 update public.account_creation_requests set status='completed',completed_at=now(),otp_hash=null,claim=null,claim_until=null where id=p_id;
 insert into public.profiles(id,name,role,active) values(p_id,r.requested_name,r.requested_role,r.desired_active)
 on conflict(id) do update set name=excluded.name,role=excluded.role,active=excluded.active;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.completed','profiles',p_id::text,p_request);
 return public.account_creation_summary(p_id);
end $$;
create function public.cancel_account_creation(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.account_creation_requests;begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 r=public.account_creation_context(p_actor,p_session,p_unlock,p_id);
 if r.provisioning_started_at is not null or r.status='completed' then raise exception 'Creation already started. Resume verification to finish.' using errcode='40001';end if;
 update public.account_creation_requests set status='cancelled',otp_hash=null where id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account_creation.cancelled','account_creation_requests',p_id::text,p_request);
end $$;
create function public.guard_pending_account_creation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.account_creation_requests where id=new.id and status<>'completed')
 and (new.active or new.role<>'agent') then raise exception 'Complete pending account verification first' using errcode='22023';end if;
 return new;
end $$;
create trigger guard_pending_account_creation before insert or update of active,role on public.profiles for each row execute function public.guard_pending_account_creation();
-- Old native enrollment and password controls must not modify a half-created
-- independent challenge user or create a second enrollment for its identity.
alter function public.account_detail(uuid,text,text,uuid) rename to account_detail_034;
create function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;pending boolean;begin
 result=public.account_detail_034(p_actor,p_session,p_unlock,p_target);
 select exists(select 1 from public.account_creation_requests where id=p_target and status<>'completed') into pending;
 return result||jsonb_build_object('account_creation_pending',pending)||case when pending then jsonb_build_object('account_status','pending_verification') else '{}'::jsonb end;
end $$;
alter function public.accounts_page(uuid,text,text,integer,integer,text,text,text) rename to accounts_page_034;
create function public.accounts_page(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;rows jsonb;begin
 result=public.accounts_page_034(p_actor,p_session,p_unlock,p_page,p_limit,p_search,p_role,p_access);
 select coalesce(jsonb_agg(r.value||jsonb_build_object('account_creation_pending',q.id is not null)||case when q.id is not null then jsonb_build_object('account_status','pending_verification') else '{}'::jsonb end order by r.ordinality),'[]') into rows
 from jsonb_array_elements(result->'data') with ordinality r(value,ordinality)
 left join public.account_creation_requests q on q.id=(r.value->>'id')::uuid and q.status<>'completed';
 return result||jsonb_build_object('data',rows);
end $$;
alter function public.update_account(uuid,text,text,uuid,jsonb,text) rename to update_account_034;
create function public.update_account(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if exists(select 1 from public.account_creation_requests where id=p_target and status<>'completed') then raise exception 'Resume pending account verification first' using errcode='22023';end if;
 return public.update_account_034(p_actor,p_session,p_unlock,p_target,p_data,p_request);
end $$;
alter function public.account_action(uuid,text,text,uuid,text,text) rename to account_action_034;
create function public.account_action(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_action text,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if exists(select 1 from public.account_creation_requests where id=p_target and status<>'completed') then raise exception 'Resume pending account verification first' using errcode='22023';end if;
 perform public.account_action_034(p_actor,p_session,p_unlock,p_target,p_action,p_request);
end $$;
alter function public.issue_agent_email_code(uuid,text,text,uuid,text,boolean,text) rename to issue_agent_email_code_034;
create function public.issue_agent_email_code(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_hash text,p_active boolean,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if exists(select 1 from public.account_creation_requests where id=p_target and status<>'completed') then raise exception 'Resume pending account verification first' using errcode='22023';end if;
 return public.issue_agent_email_code_034(p_actor,p_session,p_unlock,p_target,p_hash,p_active,p_request);
end $$;
alter function public.agent_email_code_context(uuid,text,text,uuid) rename to agent_email_code_context_034;
create function public.agent_email_code_context(p_actor uuid,p_session text,p_unlock text,p_target uuid) returns public.account_invitations language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if exists(select 1 from public.account_creation_requests where id=p_target and status<>'completed') then raise exception 'Resume pending account verification first' using errcode='22023';end if;
 return public.agent_email_code_context_034(p_actor,p_session,p_unlock,p_target);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('account_creation_summary','account_creation_context','account_creation_list','prepare_account_creation','resend_account_creation','finish_account_creation_email','begin_account_creation','release_account_creation','complete_account_creation','cancel_account_creation','guard_pending_account_creation',
 'update_account','update_account_034','account_action','account_action_034','issue_agent_email_code','issue_agent_email_code_034','agent_email_code_context','agent_email_code_context_034','account_detail','account_detail_034','accounts_page','accounts_page_034') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 036_account_uids.sql

-- Apply after 035. Safe to rerun: existing valid UIDs are never changed.
-- Every Admin/Agent profile receives a permanent six-digit business UID
-- (100000-999999). Supabase Auth UUIDs remain the identity and primary key.
-- New accounts are created directly by a PIN-unlocked admin (no email code).

do $$ begin
 if to_regclass('public.account_creation_requests') is null then
  raise exception 'Apply CRM update 035 before account UID update 036.';
 end if;
end $$;
-- Reinstalled below in this transaction, after any installation repair.
drop trigger if exists assign_account_uid on public.profiles;

-- UID values replaced during installation stay reviewable (SQL Editor only).
create table if not exists crm_private.account_uid_review(
 id bigint generated always as identity primary key,
 profile_id uuid not null references public.profiles(id),
 previous_value text not null,
 reason text not null check(reason in ('invalid','duplicate')),
 assigned_uid integer,
 recorded_at timestamptz not null default now()
);
alter table crm_private.account_uid_review enable row level security;
revoke all on crm_private.account_uid_review from public,anon,authenticated;
grant all on crm_private.account_uid_review to service_role;

-- A uid column added outside these migrations keeps every valid unique value.
-- Invalid values and later duplicates (the earliest account keeps a shared
-- value) are recorded above before they receive a fresh UID.
do $$
declare kind text;
begin
 select data_type into kind from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='uid';
 if kind is null then
  alter table public.profiles add column uid integer;
  return;
 end if;
 alter table public.profiles alter column uid drop default,alter column uid drop not null;
 insert into crm_private.account_uid_review(profile_id,previous_value,reason)
  select id,uid::text,'invalid' from public.profiles where uid is not null and uid::text!~'^[1-9][0-9]{5}$';
 insert into crm_private.account_uid_review(profile_id,previous_value,reason)
  select id,uid::text,'duplicate' from (select id,uid,row_number() over(partition by uid::text order by created_at,id) n
   from public.profiles where uid::text~'^[1-9][0-9]{5}$') d where n>1;
 update public.profiles p set uid=null from crm_private.account_uid_review r where r.profile_id=p.id and r.assigned_uid is null;
 if kind<>'integer' then
  alter table public.profiles alter column uid type integer using (case when uid::text~'^[1-9][0-9]{5}$' then uid::text::integer end);
 end if;
end $$;

-- Direct creation reserves the Auth id, UID, email, name and role before the
-- server-only Auth call. The profile trigger copies them atomically with Auth.
create table if not exists public.account_provisioning(
 id uuid primary key,
 uid integer not null check(uid between 100000 and 999999),
 uid_source text not null check(uid_source in ('auto','manual')),
 normalized_email text not null,
 requested_name text not null,
 requested_role text not null check(requested_role in ('admin','agent')),
 desired_active boolean not null,
 requested_by uuid not null references public.profiles(id),
 status text not null check(status in ('creating','completed','failed')),
 lease_until timestamptz not null,
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create unique index if not exists account_provisioning_uid on public.account_provisioning(uid) where status<>'failed';
create unique index if not exists account_provisioning_email on public.account_provisioning(normalized_email) where status='creating';
create index if not exists account_provisioning_owner on public.account_provisioning(requested_by,created_at desc);
alter table public.account_provisioning enable row level security;
revoke all on public.account_provisioning from public,anon,authenticated;
grant all on public.account_provisioning to service_role;

-- 32 bits from gen_random_uuid(), which PostgreSQL fills using its
-- cryptographic generator (pg_strong_random). Rejection sampling below
-- 4294800000 (900000 * 4772) keeps every six-digit UID equally likely.
create or replace function public.account_uid_candidate() returns integer language plpgsql volatile security definer set search_path='' as $$
declare value bigint;
begin
 loop
  value=('x'||left(replace(gen_random_uuid()::text,'-',''),8))::bit(32)::bigint;
  if value<4294800000 then return 100000+(value%900000)::integer;end if;
 end loop;
end $$;
-- The lock serializes concurrent generators; the UNIQUE constraint on
-- profiles.uid remains the final guarantee.
create or replace function public.generate_account_uid() returns integer language plpgsql volatile security definer set search_path='' as $$
declare candidate integer;
begin
 perform pg_advisory_xact_lock(873437);
 for attempt in 1..200 loop
  candidate=public.account_uid_candidate();
  if not exists(select 1 from public.profiles where uid=candidate)
  and not exists(select 1 from public.account_provisioning where uid=candidate and status<>'failed') then
   return candidate;
  end if;
 end loop;
 raise exception 'No unused account UID is available. Try again.' using errcode='PT503';
end $$;

do $$
declare r record;assigned integer=0;replaced integer;
begin
 for r in select id from public.profiles where uid is null order by created_at,id loop
  update public.profiles set uid=public.generate_account_uid() where id=r.id;
  assigned=assigned+1;
 end loop;
 update crm_private.account_uid_review v set assigned_uid=p.uid from public.profiles p where p.id=v.profile_id and v.assigned_uid is null;
 select count(*) into replaced from crm_private.account_uid_review where recorded_at=now();
 if assigned>0 then
  insert into public.audit_log(action,entity,request_id,metadata)
   values('migration.account_uids_assigned','profiles','migration:036',jsonb_build_object('assigned',assigned,'replaced',replaced));
  raise notice 'Assigned % account UIDs (% invalid or duplicate values replaced and recorded).',assigned,replaced;
 end if;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_uid_range') then
  alter table public.profiles add constraint profiles_uid_range check(uid between 100000 and 999999);
 end if;
 if not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
  where i.indrelid='public.profiles'::regclass and i.indisunique and i.indnkeyatts=1 and i.indpred is null and a.attname='uid') then
  alter table public.profiles add constraint profiles_uid_key unique(uid);
 end if;
end $$;
alter table public.profiles alter column uid set not null;

-- Assigns a reserved or generated UID on insert. UIDs never change afterwards.
create or replace function public.assign_account_uid() returns trigger language plpgsql security definer set search_path='' as $$
declare reserved public.account_provisioning;
begin
 if tg_op='UPDATE' then
  if old.uid is not null and new.uid is distinct from old.uid then
   raise exception 'Account UIDs are permanent and cannot be changed' using errcode='22023';
  end if;
  return new;
 end if;
 if new.uid is null then
  select q.* into reserved from public.account_provisioning q join auth.users u on u.id=q.id
   where q.id=new.id and q.status='creating' and lower(to_jsonb(u)->>'email')=q.normalized_email;
  if reserved.id is not null then
   -- Access stays inactive until the audited completion step.
   new.uid=reserved.uid;new.name=reserved.requested_name;new.role=reserved.requested_role;
  else
   new.uid=public.generate_account_uid();
  end if;
 end if;
 return new;
end $$;
create trigger assign_account_uid before insert or update of uid on public.profiles for each row execute function public.assign_account_uid();

create or replace function public.account_provisioning_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'uid',p.uid,'name',p.name,'email',lower(to_jsonb(u)->>'email'),'role',p.role,'active',p.active,
  'email_confirmed_at',to_jsonb(u)->>'email_confirmed_at',
  'account_status',public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at'),'created_at',p.created_at)
 from public.profiles p join auth.users u on u.id=p.id where p.id=p_id;
$$;
create or replace function public.account_uid_available(p_actor uuid,p_session text,p_unlock text,p_uid integer)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if p_uid is null or p_uid not between 100000 and 999999 then raise exception 'Invalid UID' using errcode='22023';end if;
 return jsonb_build_object('uid',p_uid,'available',not exists(select 1 from public.profiles where uid=p_uid)
  and not exists(select 1 from public.account_provisioning where uid=p_uid and status<>'failed'));
end $$;
create or replace function public.begin_account_provisioning(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_email text,p_name text,p_role text,p_active boolean,p_uid integer,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare chosen integer;taken text;
begin
 -- Same lock order as invitations, deletion and account role edits.
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_gate(p_actor,p_session,p_unlock);
 if p_id is null or p_email is null or p_email<>lower(btrim(p_email)) or length(p_email)>254 or p_email!~'^[^@[:space:]]+@gmail\.com$'
 or p_role is null or p_role not in ('admin','agent') or p_active is null or nullif(btrim(p_name),'') is null or length(p_name)>200
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
-- Releases a reservation only when no Auth user exists for it.
create or replace function public.fail_account_provisioning(p_actor uuid,p_session text,p_unlock text,p_id uuid,p_request text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform pg_advisory_xact_lock(873436);
 perform public.accounts_admin(p_actor);
 update public.account_provisioning set status='failed',finished_at=now()
 where id=p_id and requested_by=p_actor and status='creating' and not exists(select 1 from auth.users u where u.id=p_id);
 if not found then return false;end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'account.create_failed','profiles',p_id::text,p_request);
 return true;
end $$;
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
 update public.profiles set name=r.requested_name,role=r.requested_role,active=r.desired_active where id=p_id;
 update public.account_provisioning set status='completed',finished_at=now() where id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'account.created','profiles',p_id::text,p_request,jsonb_build_object('uid',r.uid,'uid_source',r.uid_source,'role',r.requested_role,'active',r.desired_active));
 return public.account_provisioning_summary(p_id);
end $$;

-- UID column and search in the shared account reader. Later wrappers (033,
-- 035) pass each row through unchanged, so the UID reaches every caller.
create or replace function public.accounts_page_032(p_actor uuid,p_session text,p_unlock text,p_page integer,p_limit integer,p_search text,p_role text,p_access text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint; summary jsonb;
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_role not in ('','admin','agent') or p_access not in ('','active','disabled','pending','expired','cancelled','deleting') then raise exception 'Invalid account filters' using errcode='22023'; end if;
  with records as (
    select p.id,p.uid,p.name,p.role,p.active,p.created_at,coalesce(d.confirmation_email,to_jsonb(u)->>'email') email,
      to_jsonb(u)->>'last_sign_in_at' last_sign_in_at,to_jsonb(u)->>'email_confirmed_at' email_confirmed_at,
      to_jsonb(u)->>'banned_until' banned_until,public.account_lifecycle(p.id,p.active,to_jsonb(u)->>'email_confirmed_at') account_status,i.requested_at invitation_date,i.expires_at invitation_expires_at,i.accepted_at invitation_accepted_at,i.state invitation_state,(i.user_id is not null or (nullif(to_jsonb(u)->>'email_confirmed_at','') is null and to_jsonb(u)->'raw_app_meta_data'->>'crm_provisioning'='true')) invitation_required
    from public.profiles p join auth.users u on u.id=p.id left join public.account_invitations i on i.user_id=p.id left join crm_private.account_deletions d on d.user_id=p.id where p.deleted_at is null
  ), eligible as (
    select * from records where (p_role='' or role=p_role) and (p_access='' or (p_access='active' and account_status='active') or (p_access='disabled' and account_status in ('suspended','deletion_pending')) or (p_access='deleting' and account_status='deletion_pending') or (p_access='pending' and account_status in ('pending_invitation','pending_verification')) or (p_access='expired' and account_status='invitation_expired') or (p_access='cancelled' and account_status='invitation_cancelled'))
      and (p_search='' or position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(coalesce(email,'')))>0 or position(p_search in uid::text)>0)
  ), page_rows as (select * from eligible order by created_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'::jsonb),(select count(*) from eligible),
    (select jsonb_build_object('total',count(*),'admins',count(*) filter(where role='admin' and account_status='active'),'agents',count(*) filter(where role='agent' and account_status='active'),'disabled',count(*) filter(where account_status='suspended'),'pending',count(*) filter(where account_status in ('pending_invitation','pending_verification')),'expired',count(*) filter(where account_status='invitation_expired')) from records)
    into rows,total,summary;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit,'summary',summary);
end $$;
do $$ begin
 if to_regprocedure('public.account_detail_035(uuid,text,text,uuid)') is null then
  alter function public.account_detail(uuid,text,text,uuid) rename to account_detail_035;
 end if;
end $$;
create or replace function public.account_detail(p_actor uuid,p_session text,p_unlock text,p_target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return public.account_detail_035(p_actor,p_session,p_unlock,p_target)||jsonb_build_object('uid',(select uid from public.profiles where id=p_target));
end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('account_uid_candidate','generate_account_uid','assign_account_uid','account_provisioning_summary','account_uid_available','begin_account_provisioning','fail_account_provisioning','complete_account_provisioning','accounts_page_032','account_detail','account_detail_035') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 037_login_security.sql

-- Apply after 036. Safe to rerun. Server-side sign-in with per-account lockout
-- (F21) and login history with lockout/after-hours security alerts (F24).

do $$ begin
 if to_regclass('public.account_provisioning') is null or to_regclass('public.security_alerts') is null then
  raise exception 'Apply CRM update 036 before login security update 037.';
 end if;
end $$;
-- Failed-password counters per normalized email; never exposed to browsers.
create table if not exists crm_private.login_attempts(
 email text primary key check(email=lower(btrim(email)) and length(email) between 3 and 254),
 failures integer not null default 0 check(failures>=0),
 window_started timestamptz not null default now(),
 locked_until timestamptz,
 updated_at timestamptz not null default now()
);
alter table crm_private.login_attempts enable row level security;
revoke all on crm_private.login_attempts from public,anon,authenticated;
grant all on crm_private.login_attempts to service_role;
create table if not exists public.login_events(
 id bigint generated always as identity primary key,
 user_id uuid references public.profiles(id),
 email text not null,
 portal text check(portal in ('admin','agent')),
 outcome text not null check(outcome in ('success','failed','locked')),
 ip text check(length(ip)<=100),
 user_agent text check(length(user_agent)<=300),
 created_at timestamptz not null default now()
);
create index if not exists login_events_created on public.login_events(created_at desc,id desc);
create index if not exists login_events_user on public.login_events(user_id,created_at desc);
alter table public.login_events enable row level security;
revoke all on public.login_events from public,anon,authenticated;
grant all on public.login_events to service_role;
grant usage,select on sequence public.login_events_id_seq to service_role;

create or replace function public.login_attempt_status(p_email text) returns jsonb language plpgsql security definer set search_path='' as $$
declare until_time timestamptz;
begin
 select locked_until into until_time from crm_private.login_attempts where email=lower(btrim(p_email)) and locked_until>now();
 return jsonb_build_object('locked',until_time is not null,'locked_until',until_time);
end $$;
-- Records one sign-in attempt. A current lock refuses even a correct password.
create or replace function public.record_login_attempt(p_email text,p_success boolean,p_user uuid,p_portal text,p_ip text,p_agent text,
 p_max integer,p_window integer,p_lock integer,p_business_start integer,p_business_end integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare address text=lower(btrim(p_email));attempt crm_private.login_attempts;account uuid;result text;local_hour integer;
begin
 if address is null or length(address) not between 3 and 254 or p_success is null or (p_portal is not null and p_portal not in ('admin','agent'))
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
create or replace function public.login_history_page(p_actor uuid,p_page integer,p_limit integer,p_user uuid,p_outcome text,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
  raise exception 'Forbidden' using errcode='42501';end if;
 if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
 or (p_outcome is not null and p_outcome not in ('success','failed','locked')) or (p_from is not null and p_to is not null and p_from>=p_to) then
  raise exception 'Invalid login history filters' using errcode='22023';end if;
 with filtered as (
  select e.id,e.created_at,e.email,e.portal,e.outcome,e.ip,e.user_agent,e.user_id,p.name user_name,p.uid user_uid,p.role user_role
  from public.login_events e left join public.profiles p on p.id=e.user_id
  where (p_user is null or e.user_id=p_user) and (p_outcome is null or e.outcome=p_outcome)
   and (p_from is null or e.created_at>=p_from) and (p_to is null or e.created_at<p_to)
 ), page as (select * from filtered order by created_at desc,id desc limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by created_at desc,id desc) from page),'[]'::jsonb),
  'count',(select count(*) from filtered),'page',p_page,'limit',p_limit,
  'summary',jsonb_build_object(
   'failed_24h',(select count(*) from public.login_events where outcome<>'success' and created_at>now()-interval '24 hours'),
   'locked_now',(select count(*) from crm_private.login_attempts where locked_until>now()))) into result;
 return result;
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('login_attempt_status','record_login_attempt','login_history_page') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 038_lead_response_and_notifications.sql

-- Apply after 037. Safe to rerun. First-call tracking (F3), missed-call review
-- (F4: an administrator decides; nothing is reassigned automatically), in-app
-- notifications (F7) and the working hours used for first-call deadlines.

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



-- Migration: 039_calendar_targets_reports.sql

-- Apply after 038. Safe to rerun. Site visit calendar (F8), daily/weekly/
-- monthly targets with contact and follow-up goals (F10) and source, agent,
-- funnel and lost-lead reports (F12).

do $$ begin
 if to_regclass('public.crm_settings') is null or to_regprocedure('public.first_call_queue(uuid,integer)') is null then
  raise exception 'Apply CRM update 038 before calendar, targets and reports update 039.';
 end if;
end $$;

-- Shared scope check: active user; agents only ever see their own work.
create or replace function public.report_scope(p_actor uuid,p_agent uuid,p_from timestamptz,p_to timestamptz) returns uuid language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '3700 days' then
  raise exception 'Invalid date range' using errcode='22023';end if;
 return case when actor.role='agent' then p_actor else p_agent end;
end $$;

-- F8: visits in a date range (at most 62 days) with names, never phone numbers.
create index if not exists visits_scheduled_at on public.visits(scheduled_at);
create or replace function public.visit_calendar(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 if p_to-p_from>interval '62 days' then raise exception 'Choose at most 62 days' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lead_id',l.id,'lead_no',l.lead_no,'lead_name',l.name,'property_id',v.property_id,
   'property_title',p.title,'property_location',p.location,'agent_id',v.agent_id,'agent_name',a.name,'scheduled_at',v.scheduled_at,
   'status',v.status,'notes',v.notes) order by v.scheduled_at,v.id),'[]'::jsonb) into result
 from public.visits v join public.active_leads l on l.id=v.lead_id join public.properties p on p.id=v.property_id
  left join public.profiles a on a.id=v.agent_id
 where v.scheduled_at>=p_from and v.scheduled_at<p_to
  and (case when exists(select 1 from public.profiles where id=p_actor and role='agent') then l.assigned_agent=p_actor else scope is null or v.agent_id=scope end);
 return result;
end $$;
-- Other scheduled visits of the same agent within 60 minutes of a time.
create or replace function public.visit_conflicts(p_actor uuid,p_lead uuid,p_at timestamptz,p_exclude uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;owner uuid;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_at is null then raise exception 'Choose a visit time' using errcode='22023';end if;
 select coalesce(l.assigned_agent,p_actor) into owner from public.active_leads l
  where l.id=p_lead and (actor.role='admin' or l.assigned_agent=p_actor);
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lead_no',l.lead_no,'lead_name',l.name,'property_title',p.title,'scheduled_at',v.scheduled_at,
   'agent_name',a.name) order by v.scheduled_at),'[]'::jsonb) into result
 from public.visits v join public.active_leads l on l.id=v.lead_id join public.properties p on p.id=v.property_id left join public.profiles a on a.id=v.agent_id
 where v.agent_id=owner and v.status='scheduled' and v.id is distinct from p_exclude
  and v.scheduled_at>p_at-interval '60 minutes' and v.scheduled_at<p_at+interval '60 minutes';
 return jsonb_build_object('agent_id',owner,'conflicts',result);
end $$;

-- F10: targets per day, week (starting Monday) or month. The legacy month
-- column stays as the month containing the period, for older readers.
alter table public.targets
 add column if not exists period text not null default 'month' check(period in ('day','week','month')),
 add column if not exists period_start date,
 add column if not exists leads_contacted integer not null default 0 check(leads_contacted>=0),
 add column if not exists followups_completed integer not null default 0 check(followups_completed>=0),
 add column if not exists updated_at timestamptz not null default now();
update public.targets set period_start=month where period_start is null;
alter table public.targets alter column period_start set not null;
alter table public.targets drop constraint if exists targets_agent_id_month_key;
alter table public.targets drop constraint if exists targets_period_start_check;
alter table public.targets add constraint targets_period_start_check
 check((period<>'month' or extract(day from period_start)=1) and (period<>'week' or extract(isodow from period_start)=1));
create unique index if not exists targets_agent_period on public.targets(agent_id,period,period_start);
create index if not exists targets_period_start on public.targets(period,period_start);
create or replace function public.prepare_target() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.period=coalesce(new.period,'month');
 -- Older writers change only the month column of a monthly target.
 if tg_op='UPDATE' and new.month is distinct from old.month and new.period_start is not distinct from old.period_start and new.period='month' then
  new.period_start=new.month;
 end if;
 new.period_start=coalesce(new.period_start,new.month);
 new.month=date_trunc('month',new.period_start)::date;
 new.updated_at=now();
 return new;
end $$;
drop trigger if exists prepare_target on public.targets;
create trigger prepare_target before insert or update on public.targets for each row execute function public.prepare_target();
-- Follow-ups record when they were completed, for the follow-up goal.
alter table public.followups add column if not exists completed_at timestamptz;
update public.followups set completed_at=updated_at where status='completed' and completed_at is null;
create index if not exists followups_completed on public.followups(agent_id,completed_at) where status='completed';
create or replace function public.stamp_followup_completion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='completed' then new.completed_at=case when tg_op='UPDATE' and old.status='completed' then old.completed_at else now() end;
 else new.completed_at=null;end if;
 return new;
end $$;
drop trigger if exists stamp_followup_completion on public.followups;
create trigger stamp_followup_completion before insert or update of status on public.followups for each row execute function public.stamp_followup_completion();
create or replace function public.target_period_end(p_period text,p_start date) returns date language sql immutable set search_path='' as $$
 select case p_period when 'day' then p_start+1 when 'week' then p_start+7 else (p_start+interval '1 month')::date end
$$;
create or replace function public.targets_page(p_actor uuid,p_period text,p_start date,p_current boolean,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;today date=(now() at time zone 'Asia/Karachi')::date;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if (p_period is not null and p_period not in ('day','week','month')) or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid target filter' using errcode='22023';end if;
 with visible as (
  select t.*,a.name agent_name,a.uid agent_uid,public.target_period_end(t.period,t.period_start) period_end
  from public.targets t join public.profiles a on a.id=t.agent_id
  where (actor.role='admin' or t.agent_id=p_actor) and a.deleted_at is null
   and (p_period is null or t.period=p_period) and (p_start is null or t.period_start=p_start)
   and (not coalesce(p_current,false) or (t.period_start<=today and public.target_period_end(t.period,t.period_start)>today))
 ), page as (select * from visible order by period_start desc,case period when 'day' then 1 when 'week' then 2 else 3 end,agent_name,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by period_start desc,case period when 'day' then 1 when 'week' then 2 else 3 end,agent_name,id) from page),'[]'::jsonb),
  'count',(select count(*) from visible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;
create or replace function public.save_target(p_actor uuid,p_id uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text;result public.targets;existing public.targets;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid target' using errcode='22023';end if;
 for k in select jsonb_object_keys(p_data) loop
  if k not in ('agent_id','period','period_start','calls','visits','deals','revenue','leads_contacted','followups_completed') then
   raise exception 'Invalid target field' using errcode='22023';end if;
 end loop;
 if p_data ? 'agent_id' and not exists(select 1 from public.profiles where id=(p_data->>'agent_id')::uuid and active and role='agent') then
  raise exception 'Choose an active agent' using errcode='22023';end if;
 if p_id is null then
  insert into public.targets(agent_id,period,period_start,month,calls,visits,deals,revenue,leads_contacted,followups_completed)
  values((p_data->>'agent_id')::uuid,coalesce(p_data->>'period','month'),(p_data->>'period_start')::date,(p_data->>'period_start')::date,
   coalesce((p_data->>'calls')::integer,0),coalesce((p_data->>'visits')::integer,0),coalesce((p_data->>'deals')::integer,0),
   coalesce((p_data->>'revenue')::numeric,0),coalesce((p_data->>'leads_contacted')::integer,0),coalesce((p_data->>'followups_completed')::integer,0))
  returning * into result;
 else
  select * into existing from public.targets where id=p_id for update;
  if not found then raise exception 'Target not found' using errcode='P0002';end if;
  update public.targets set agent_id=coalesce((p_data->>'agent_id')::uuid,agent_id),period=coalesce(p_data->>'period',period),
   period_start=coalesce((p_data->>'period_start')::date,period_start),calls=coalesce((p_data->>'calls')::integer,calls),
   visits=coalesce((p_data->>'visits')::integer,visits),deals=coalesce((p_data->>'deals')::integer,deals),revenue=coalesce((p_data->>'revenue')::numeric,revenue),
   leads_contacted=coalesce((p_data->>'leads_contacted')::integer,leads_contacted),followups_completed=coalesce((p_data->>'followups_completed')::integer,followups_completed)
  where id=p_id returning * into result;
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,case when p_id is null then 'create' else 'update' end,'targets',result.id::text,p_request,
   jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data))),'period',result.period));
 return to_jsonb(result);
end $$;
-- Copy each active agent's targets from the previous period into this one.
create or replace function public.copy_targets(p_actor uuid,p_period text,p_start date,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare previous date;copied integer;available integer;
begin
 perform public.accounts_admin(p_actor);
 if p_period is null or p_period not in ('day','week','month') or p_start is null
  or (p_period='week' and extract(isodow from p_start)<>1) or (p_period='month' and extract(day from p_start)<>1) then
  raise exception 'Choose a valid period' using errcode='22023';end if;
 previous=case p_period when 'day' then p_start-1 when 'week' then p_start-7 else (p_start-interval '1 month')::date end;
 select count(*) into available from public.targets t join public.profiles a on a.id=t.agent_id and a.active and a.role='agent'
  where t.period=p_period and t.period_start=previous;
 insert into public.targets(agent_id,period,period_start,month,calls,visits,deals,revenue,leads_contacted,followups_completed)
 select t.agent_id,p_period,p_start,p_start,t.calls,t.visits,t.deals,t.revenue,t.leads_contacted,t.followups_completed
 from public.targets t join public.profiles a on a.id=t.agent_id and a.active and a.role='agent'
 where t.period=p_period and t.period_start=previous
 on conflict(agent_id,period,period_start) do nothing;
 get diagnostics copied=row_count;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
  values(p_actor,'targets.copied','targets',p_request,jsonb_build_object('period',p_period,'from',previous,'to',p_start,'copied',copied));
 return jsonb_build_object('copied',copied,'skipped',available-copied,'from',previous);
end $$;

-- Metrics gain the two new goals for the same range and filters.
do $$ begin
 if to_regprocedure('public.crm_metrics_038(uuid,timestamptz,timestamptz,uuid,text)') is null then
  alter function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text) rename to crm_metrics_038;
 end if;
end $$;
create or replace function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;scope uuid=p_agent;
begin
 result=public.crm_metrics_038(p_actor,p_from,p_to,p_agent,p_source);
 if exists(select 1 from public.profiles where id=p_actor and role='agent') then scope=p_actor;end if;
 return result||jsonb_build_object(
  'leads_contacted',(select count(distinct c.lead_id) from public.calls c join public.active_leads l on l.id=c.lead_id
   where c.started_at>=p_from and c.started_at<p_to and (scope is null or c.agent_id=scope) and (p_source is null or l.source=p_source)),
  'followups_completed',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id
   where f.status='completed' and f.completed_at>=p_from and f.completed_at<p_to and (scope is null or f.agent_id=scope) and (p_source is null or l.source=p_source)));
end $$;

-- F12 reports. Agents only ever receive their own figures.
-- Sources: leads created in the range, and how far that group has got.
create or replace function public.report_sources(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.leads desc,x.source),'[]'::jsonb) into result from (
  select l.source,count(*) leads,
   count(*) filter(where exists(select 1 from public.calls c where c.lead_id=l.id)) contacted,
   count(*) filter(where exists(select 1 from public.visits v where v.lead_id=l.id and v.status='completed')) visited,
   count(*) filter(where l.status='won') won,
   count(*) filter(where l.status='lost') lost,
   coalesce(sum((select d.expected_value from public.deals d where d.lead_id=l.id and d.stage='won')),0) revenue
  from public.active_leads l
  where l.created_at>=p_from and l.created_at<p_to and (scope is null or l.assigned_agent=scope)
  group by l.source) x;
 return result;
end $$;
-- Agents: assignment, first-call speed, calling, visits and sales in the range.
create or replace function public.report_agents(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,null,p_from,p_to);
 select coalesce(jsonb_agg(x.data order by x.name,x.id),'[]'::jsonb) into result from (
  select p.id,p.name,jsonb_build_object('agent_id',p.id,'name',p.name,'uid',p.uid,'active',p.active,
   'assigned',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.created_at>=p_from and a.created_at<p_to),
   'first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to),
   'on_time_first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to and a.first_call_at<=a.call_due_at),
   'first_calls_with_deadline',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to and a.call_due_at is not null),
   'avg_first_call_minutes',(select round(avg(public.working_minutes(a.created_at,a.first_call_at))) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to),
   'missed_first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.missed_at>=p_from and a.missed_at<p_to),
   'calls',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.started_at>=p_from and c.started_at<p_to),
   'connected_calls',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
   'talk_minutes',(select round(coalesce(sum(c.duration_seconds),0)/60.0) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
   'visits_completed',(select count(*) from public.visits v join public.active_leads l on l.id=v.lead_id where v.agent_id=p.id and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to),
   'won_deals',(select count(*) from public.deals d join public.active_leads l on l.id=d.lead_id where d.agent_id=p.id and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date),
   'revenue',(select coalesce(sum(d.expected_value),0) from public.deals d join public.active_leads l on l.id=d.lead_id where d.agent_id=p.id and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date),
   'lost',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to)) data
  from public.profiles p where p.role='agent' and p.deleted_at is null and (scope is null or p.id=scope)
   and (p.active or exists(select 1 from public.assignments a where a.agent_id=p.id and a.created_at>=p_from and a.created_at<p_to))) x;
 return result;
end $$;
-- Funnel: leads created in the range and the furthest stage each reached.
create or replace function public.report_funnel(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'];result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 with cohort as (
  select l.id,l.status from public.active_leads l
  where l.created_at>=p_from and l.created_at<p_to and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source)
 ), reach as (
  select c.id,c.status,greatest(coalesce(array_position(stages,c.status),1),
   coalesce((select max(array_position(stages,h.to_status)) from public.lead_status_history h where h.lead_id=c.id),1)) reached
  from cohort c
 )
 select jsonb_build_object('total',(select count(*) from reach),'lost',(select count(*) from reach where status='lost'),
  'stages',(select jsonb_agg(jsonb_build_object('stage',stages[i],'reached',(select count(*) from reach where reached>=i)) order by i) from generate_subscripts(stages,1) i))
 into result;
 return result;
end $$;
-- Lost leads in the range by reason, source and current agent.
create or replace function public.report_lost(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 with lost as (
  select l.lost_reason,l.source,l.assigned_agent from public.active_leads l
  where l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source)
 )
 select jsonb_build_object('total',(select count(*) from lost),
  'by_reason',(select coalesce(jsonb_agg(jsonb_build_object('reason',lost_reason,'count',n) order by n desc,lost_reason),'[]'::jsonb) from (select lost_reason,count(*) n from lost group by lost_reason) r),
  'by_source',(select coalesce(jsonb_agg(jsonb_build_object('source',source,'count',n) order by n desc,source),'[]'::jsonb) from (select source,count(*) n from lost group by source) r),
  'by_agent',(select coalesce(jsonb_agg(jsonb_build_object('agent_id',assigned_agent,'name',coalesce(p.name,'Unassigned'),'count',n) order by n desc,p.name),'[]'::jsonb)
   from (select assigned_agent,count(*) n from lost group by assigned_agent) r left join public.profiles p on p.id=r.assigned_agent))
 into result;
 return result;
end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('report_scope','visit_calendar','visit_conflicts','prepare_target','stamp_followup_completion','target_period_end','targets_page','save_target',
  'copy_targets','crm_metrics','crm_metrics_038','report_sources','report_agents','report_funnel','report_lost') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 040_attendance.sql

-- Apply after 039. Safe to rerun. Smart attendance for Admins and Agents:
-- versioned policy (10:00–18:00, Monday–Saturday, 15-minute grace, Pakistan
-- time), check-in/out with the database clock, holidays, leave and correction
-- requests reviewed by another administrator, and reports derived from the
-- schedule so absences are never stored or invented. Lead ownership is never
-- changed by anything in this update.
-- Errors raised here use SQLSTATE HA<http status> (HA400, HA403, HA404,
-- HA409) with messages that are safe to show to the signed-in user.

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



-- Migration: 041_property_inventory.sql

-- Apply after 040. Safe to rerun. Property inventory (update 041).
-- Every agent keeps a private inventory. Administrators keep the company
-- inventory: every agent can read it and none can change it. Administrators
-- can read every agent's inventory but cannot change it. Existing properties
-- become company inventory unchanged; no property, photo, lead, visit or deal
-- is deleted, moved or re-linked by this update.
-- The browser still has no table grants (009). These functions run for the
-- API's service role and check the signed-in actor (p_actor) themselves, so
-- ownership never comes from the request body.
-- Errors raised here use SQLSTATE HA<http status> (HA400, HA403, HA404,
-- HA409) with messages that are safe to show to the signed-in user.
-- Runs as one transaction in a few seconds. Leads, visits and deals stay
-- readable throughout; properties and property photos are locked briefly.
-- If a lock is not available within 5 seconds (for example while a backup or
-- large export is running) everything rolls back unchanged: run it again later.
-- Check first with supabase/check-property-inventory.sql (read-only).

set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.attendance_member(uuid)') is null or to_regclass('public.property_photo_cleanup') is null then
  raise exception 'Apply CRM updates 013 and 040 before inventory update 041.';
 end if;
 if current_setting('server_version_num')::integer<140000 then
  raise exception 'Update 041 needs PostgreSQL 14 or newer.';
 end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='deleted_at')
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='uid')
  or not exists(select 1 from pg_trigger where tgrelid='public.properties'::regclass and tgname='touch_updated') then
  raise exception 'Apply CRM updates 010, 028 and 036 before inventory update 041.';
 end if;
 -- Only the checks from 004 (and this update, on a rerun) are expected. Any
 -- other check on properties needs review before its rules are widened.
 if exists(select 1 from pg_constraint where conrelid='public.properties'::regclass and contype='c'
  and conname not in ('properties_price_check','properties_area_check','properties_area_unit_check','properties_availability_check',
   'properties_purpose_status','properties_location_fields','properties_detail_fields')) then
  raise exception 'The properties table has unexpected check constraints. Run supabase/check-property-inventory.sql and review before update 041.';
 end if;
end $$;

-- ------------------------------------------------------------ properties
-- owner_agent_id null = company inventory; otherwise the agent whose private
-- inventory holds the property. Ownership never changes after creation.
alter table public.properties
 add column if not exists owner_agent_id uuid references public.profiles(id),
 add column if not exists property_no bigint generated always as identity,
 add column if not exists purpose text not null default 'sale',
 add column if not exists country text not null default 'Pakistan',
 add column if not exists province text,
 add column if not exists city text,
 add column if not exists area_society text,
 add column if not exists block_sector text,
 add column if not exists street text,
 add column if not exists plot_number text,
 add column if not exists address text,
 add column if not exists map_url text,
 add column if not exists currency text not null default 'PKR',
 add column if not exists price_negotiable boolean not null default false,
 add column if not exists price_notes text,
 add column if not exists bedrooms smallint,
 add column if not exists bathrooms smallint,
 add column if not exists kitchens smallint,
 add column if not exists floors smallint,
 add column if not exists parking_spaces smallint,
 add column if not exists furnishing text,
 add column if not exists construction_status text,
 add column if not exists property_age smallint,
 add column if not exists amenities text[] not null default '{}',
 add column if not exists created_by uuid references public.profiles(id),
 add column if not exists updated_by uuid references public.profiles(id);
-- Derived from the type so the two can never disagree. Older free-text types
-- (for example 'Plot') keep working and count as 'other'.
alter table public.properties add column if not exists category text generated always as (
 case when type in ('House','Apartment','Residential Plot','Portion','Farmhouse') then 'residential'
  when type in ('Shop','Office','Commercial Plot','Warehouse','Building','Commercial') then 'commercial'
  else 'other' end) stored;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='properties_property_no_key') then
  alter table public.properties add constraint properties_property_no_key unique(property_no);
 end if;
end $$;
-- Widened from 004: rentals and more Pakistani size units. 'archived' is
-- shown as Inactive. Areas are stored as entered and never converted.
alter table public.properties drop constraint if exists properties_availability_check;
alter table public.properties add constraint properties_availability_check check(availability in ('available','reserved','sold','rented','archived'));
alter table public.properties drop constraint if exists properties_area_unit_check;
alter table public.properties add constraint properties_area_unit_check check(area_unit in ('sq ft','sq yd','marla','kanal','acre'));
alter table public.properties drop constraint if exists properties_purpose_status;
alter table public.properties add constraint properties_purpose_status check(purpose in ('sale','rent')
 and (availability<>'sold' or purpose='sale') and (availability<>'rented' or purpose='rent')
 -- Other countries and currencies are not supported yet.
 and country='Pakistan' and currency='PKR' and coalesce(length(price_notes),0)<=300);
alter table public.properties drop constraint if exists properties_location_fields;
alter table public.properties add constraint properties_location_fields check(
 (province is null or province in ('Punjab','Sindh','Khyber Pakhtunkhwa','Balochistan','Islamabad Capital Territory','Gilgit-Baltistan','Azad Jammu and Kashmir'))
 and (city is null or length(city) between 1 and 80)
 and coalesce(length(area_society),0)<=120 and coalesce(length(block_sector),0)<=60
 and coalesce(length(street),0)<=120 and coalesce(length(plot_number),0)<=40 and coalesce(length(address),0)<=300
 and (map_url is null or (length(map_url)<=500 and map_url ~ '^https://[^[:space:]]+$')));
alter table public.properties drop constraint if exists properties_detail_fields;
alter table public.properties add constraint properties_detail_fields check(
 (bedrooms is null or bedrooms between 0 and 50) and (bathrooms is null or bathrooms between 0 and 50)
 and (kitchens is null or kitchens between 0 and 20) and (floors is null or floors between 0 and 200)
 and (parking_spaces is null or parking_spaces between 0 and 100) and (property_age is null or property_age between 0 and 200)
 and (furnishing is null or furnishing in ('unfurnished','semi_furnished','furnished'))
 and (construction_status is null or construction_status in ('new','ready','needs_renovation','under_construction','grey_structure'))
 and cardinality(amenities)<=20
 and amenities<@array['electricity','gas','water','sewerage','internet','boundary_wall','security','corner','park_facing',
  'main_road','lift','backup_power','solar','servant_quarter','basement','lawn','drawing_room','store_room']::text[]);
create index if not exists properties_owner_created on public.properties(owner_agent_id,created_at desc,id);
create index if not exists properties_owner_status on public.properties(owner_agent_id,availability,purpose);
create index if not exists properties_city on public.properties(lower(city));

-- Ownership and creator are fixed; only agents keep a private inventory.
create or replace function public.guard_property_owner() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.owner_agent_id is distinct from old.owner_agent_id or new.created_by is distinct from old.created_by) then
  raise exception 'Property ownership cannot be changed' using errcode='HA403';
 end if;
 if tg_op='INSERT' and new.owner_agent_id is not null
  and not exists(select 1 from public.profiles where id=new.owner_agent_id and role='agent') then
  raise exception 'Only agents keep a private inventory' using errcode='HA400';
 end if;
 return new;
end $$;
create or replace trigger guard_property_owner before insert or update on public.properties for each row execute function public.guard_property_owner();

-- Leads, visits and deals link only company inventory. A private property
-- linked to a lead would show its title to whoever owns the lead next.
create or replace function public.guard_property_link() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.property_id is not null and exists(select 1 from public.properties p where p.id=new.property_id and p.owner_agent_id is not null) then
  raise exception 'Only company inventory can be linked to leads, visits or deals' using errcode='22023';
 end if;
 return new;
end $$;
-- create or replace (not drop + create) blocks only writes, never reads.
do $$ declare t text; begin
 foreach t in array array['leads','visits','deals'] loop
  execute format('create or replace trigger guard_property_link before insert or update of property_id on public.%I for each row execute function public.guard_property_link()',t);
 end loop;
end $$;

-- ------------------------------------------------------- owner contacts
-- Kept apart from properties so no property listing can include them.
-- Shared with agents only for company properties an administrator marks.
create table if not exists public.property_owner_contacts(
 property_id uuid primary key references public.properties(id) on delete cascade,
 owner_name text check(length(owner_name) between 1 and 120),
 owner_phone text check(owner_phone ~ '^\+[0-9]{10,15}$'),
 owner_alt_phone text check(owner_alt_phone ~ '^\+[0-9]{10,15}$'),
 owner_notes text check(length(owner_notes) between 1 and 1000),
 share_with_agents boolean not null default false,
 updated_at timestamptz not null default now()
);
alter table public.property_owner_contacts enable row level security;
revoke all on public.property_owner_contacts from public,anon,authenticated;
grant all on public.property_owner_contacts to service_role;

-- --------------------------------------------------------------- photos
-- The first picture by position is the cover.
alter table public.property_photos add column if not exists position integer not null default 0;
create index if not exists property_photos_order on public.property_photos(property_id,position,created_at,id);

-- ------------------------------------------------------- shared helpers
create or replace function public.inventory_member(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent') for share;
 if not found then raise exception 'Your account is not active' using errcode='HA403';end if;
 return actor;
end $$;
-- Agents read the company inventory and their own; administrators read all.
-- Administrators change only the company inventory; agents only their own.
-- Another agent's property is reported as missing, never as forbidden.
create or replace function public.inventory_property_for(p_actor public.profiles,p_property uuid,p_write boolean) returns public.properties language plpgsql security definer set search_path='' as $$
declare prop public.properties;
begin
 if p_write then select * into prop from public.properties where id=p_property for update;
 else select * into prop from public.properties where id=p_property;end if;
 if not found or (p_actor.role='agent' and prop.owner_agent_id<>p_actor.id) then
  raise exception 'Property not found' using errcode='HA404';end if;
 if p_write and prop.owner_agent_id is null and p_actor.role<>'admin' then
  raise exception 'The company inventory is read-only for agents' using errcode='HA403';end if;
 if p_write and prop.owner_agent_id is not null and (p_actor.role<>'agent' or prop.owner_agent_id<>p_actor.id) then
  raise exception 'Agent inventories are read-only for administrators' using errcode='HA403';end if;
 return prop;
end $$;
create or replace function public.inventory_json(p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p_property)||jsonb_build_object(
  'ownership',case when p_property.owner_agent_id is null then 'company' else 'agent' end,
  'owner_agent_name',(select name from public.profiles where id=p_property.owner_agent_id),
  'created_by_name',(select name from public.profiles where id=p_property.created_by),
  'updated_by_name',(select name from public.profiles where id=p_property.updated_by))
$$;
-- Administrators and the owning agent see everything; agents see the name and
-- numbers of a company property only when an administrator shared them.
create or replace function public.inventory_contact(p_actor public.profiles,p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select case
  when p_actor.role='admin' or p_property.owner_agent_id=p_actor.id then to_jsonb(c)-'property_id'
  when p_property.owner_agent_id is null and c.share_with_agents then
   jsonb_build_object('owner_name',c.owner_name,'owner_phone',c.owner_phone,'owner_alt_phone',c.owner_alt_phone,'share_with_agents',true)
  end
 from public.property_owner_contacts c where c.property_id=p_property.id
$$;
-- One inventory, filtered. Callers have already checked the scope and owner.
create or replace function public.inventory_rows(p_scope text,p_owner uuid,p_filters jsonb,p_number bigint) returns setof public.properties language sql stable set search_path='' as $$
 select p.* from public.properties p
 where (case when p_scope='company' then p.owner_agent_id is null else p.owner_agent_id=p_owner end)
  and (nullif(btrim(p_filters->>'search'),'') is null or p.property_no=p_number
   or position(lower(btrim(p_filters->>'search')) in lower(concat_ws(' ',p.title,p.location,p.city,p.area_society,p.block_sector,p.type)))>0)
  and (p_filters->>'type' is null or p.type=p_filters->>'type')
  and (p_filters->>'purpose' is null or p.purpose=p_filters->>'purpose')
  and (p_filters->>'status' is null or p.availability=p_filters->>'status')
  and (nullif(btrim(p_filters->>'city'),'') is null
   or position(lower(btrim(p_filters->>'city')) in lower(concat_ws(' ',p.city,p.area_society,p.location)))>0)
  and (p_filters->>'min_price' is null or p.price>=(p_filters->>'min_price')::numeric)
  and (p_filters->>'max_price' is null or p.price<=(p_filters->>'max_price')::numeric)
$$;
-- p_scope: company, agent (one agent: p_owner), agents (all agents), all.
create or replace function public.inventory_counts(p_scope text,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('total',count(*),'available',count(*) filter(where availability='available'),
  'reserved',count(*) filter(where availability='reserved'),'sold',count(*) filter(where availability='sold'),
  'rented',count(*) filter(where availability='rented'),'inactive',count(*) filter(where availability='archived'),
  'last_updated',max(updated_at))
 from public.properties
 where case p_scope when 'company' then owner_agent_id is null when 'agent' then owner_agent_id=p_owner
  when 'agents' then owner_agent_id is not null else true end
$$;
-- Current agents, plus any account (deleted, disabled or promoted to admin)
-- that still has a private inventory, so no inventory is ever hidden.
create or replace function public.inventory_agent_rows() returns table(id uuid,uid integer,name text,email text,role text,status text) language sql stable set search_path='' as $$
 select p.id,p.uid,p.name,(select to_jsonb(u)->>'email' from auth.users u where u.id=p.id),p.role,
  case when p.deleted_at is not null then 'deleted' when p.active then 'active' else 'inactive' end
 from public.profiles p
 where (p.role='agent' and p.deleted_at is null) or exists(select 1 from public.properties x where x.owner_agent_id=p.id)
$$;

-- ---------------------------------------------------------------- reads
create or replace function public.inventory_page(p_actor uuid,p_scope text,p_agent uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);owner_id uuid;f jsonb=coalesce(p_filters,'{}'::jsonb);
 term text=lower(btrim(coalesce(f->>'search','')));sort_key text=coalesce(f->>'sort','newest');num bigint;total bigint;items jsonb;header jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Choose a valid page' using errcode='HA400';end if;
 if p_scope='mine' then
  if actor.role<>'agent' then raise exception 'Administrators manage the company inventory' using errcode='HA400';end if;
  owner_id=actor.id;
 elsif p_scope='agent' then
  if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
  select to_jsonb(a) into header from public.inventory_agent_rows() a where a.id=p_agent;
  if header is null then raise exception 'Agent not found' using errcode='HA404';end if;
  owner_id=p_agent;
 elsif p_scope is distinct from 'company' then
  raise exception 'Choose an inventory' using errcode='HA400';
 end if;
 -- A reference such as PR-000012 (or 12) also finds that property.
 if term ~ '^(pr-?)?[0-9]{1,15}$' then num=regexp_replace(term,'^pr-?','')::bigint;end if;
 select count(*) into total from public.inventory_rows(p_scope,owner_id,f,num);
 select coalesce(jsonb_agg(public.inventory_json(p.prop)||jsonb_build_object('photo_count',coalesce(ph.n,0),
   'cover_photo_id',ph.id,'cover_path',ph.storage_path)
   order by p.k1,p.k2 desc,p.k3,p.k4 desc,p.k5,p.created_at desc,p.id desc),'[]'::jsonb) into items
 from (select r prop,r.id,r.created_at,case sort_key when 'price_low' then r.price end k1,
   case sort_key when 'price_high' then r.price end k2,case sort_key when 'title' then lower(r.title) end k3,
   case sort_key when 'updated' then r.updated_at end k4,case sort_key when 'oldest' then r.created_at end k5
  from public.inventory_rows(p_scope,owner_id,f,num) r
  order by k1,k2 desc,k3,k4 desc,k5,r.created_at desc,r.id desc
  limit p_limit offset (p_page-1)*p_limit) p
 left join lateral (select x.id,x.storage_path,count(*) over() n from public.property_photos x
  where x.property_id=p.id order by x.position,x.created_at,x.id limit 1) ph on true;
 return jsonb_build_object('data',items,'count',total,'page',p_page,'limit',p_limit)
  ||case when header is null then '{}'::jsonb else jsonb_build_object('agent',header) end;
end $$;
create or replace function public.inventory_property(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return public.inventory_json(prop)||jsonb_build_object('owner_contact',public.inventory_contact(actor,prop),
  'can_edit',case when prop.owner_agent_id is null then actor.role='admin' else actor.role='agent' and prop.owner_agent_id=actor.id end);
end $$;
create or replace function public.inventory_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role='agent' then
  return jsonb_build_object('role','agent','mine',public.inventory_counts('agent',actor.id),'company',public.inventory_counts('company',null));
 end if;
 return jsonb_build_object('role','admin','company',public.inventory_counts('company',null),
  'agents',public.inventory_counts('agents',null),'all',public.inventory_counts('all',null),
  'agents_with_properties',(select count(distinct owner_agent_id) from public.properties where owner_agent_id is not null));
end $$;
create or replace function public.inventory_agents(p_actor uuid,p_search text,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);term text=lower(nullif(btrim(p_search),''));total bigint;items jsonb;
begin
 if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Choose a valid page' using errcode='HA400';end if;
 select count(*) into total from public.inventory_agent_rows() a
  where term is null or position(term in lower(concat_ws(' ',a.name,a.email,a.uid)))>0;
 select coalesce(jsonb_agg(to_jsonb(a)||public.inventory_counts('agent',a.id) order by a.name,a.id),'[]'::jsonb) into items
 from (select * from public.inventory_agent_rows() a
  where term is null or position(term in lower(concat_ws(' ',a.name,a.email,a.uid)))>0
  order by a.name,a.id limit p_limit offset (p_page-1)*p_limit) a;
 return jsonb_build_object('data',items,'count',total,'page',p_page,'limit',p_limit);
end $$;

-- --------------------------------------------------------------- writes
-- p_property null creates. The owner is the signed-in agent, or the company
-- for an administrator. Updates change only the fields sent; a sent
-- expected_updated_at refuses to overwrite someone else's newer save.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;
 fields jsonb;contact jsonb;plot boolean;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities',
  'owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 fields=p_data-array['owner_contact','expected_updated_at'];
 if p_property is null then
  merged=jsonb_populate_record(null::public.properties,
   jsonb_build_object('description','','availability','available','price_negotiable',false,'amenities','[]'::jsonb)||fields);
 else
  prop=public.inventory_property_for(actor,p_property,true);
  if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from prop.updated_at then
   raise exception 'Someone else changed this property. Close it, open it again and repeat your change.' using errcode='HA409';end if;
  merged=jsonb_populate_record(prop,fields);
 end if;
 if (merged.availability='sold' and merged.purpose='rent') or (merged.availability='rented' and merged.purpose='sale') then
  raise exception 'Use Sold for sale listings and Rented for rent listings' using errcode='HA400';end if;
 -- Plots and land have no rooms, furnishing, construction or age.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
   furnishing,construction_status,property_age,amenities,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
   case when not plot then merged.construction_status end,case when not plot then merged.property_age end,merged.amenities,
   case when actor.role='agent' then actor.id end,actor.id,actor.id)
  returning * into prop;
 else
  update public.properties set title=merged.title,description=merged.description,location=merged.location,price=merged.price,
   type=merged.type,area=merged.area,area_unit=merged.area_unit,availability=merged.availability,purpose=merged.purpose,
   province=merged.province,city=merged.city,area_society=merged.area_society,block_sector=merged.block_sector,street=merged.street,
   plot_number=merged.plot_number,address=merged.address,map_url=merged.map_url,price_negotiable=merged.price_negotiable,
   price_notes=merged.price_notes,bedrooms=case when not plot then merged.bedrooms end,bathrooms=case when not plot then merged.bathrooms end,
   kitchens=case when not plot then merged.kitchens end,floors=case when not plot then merged.floors end,
   parking_spaces=case when not plot then merged.parking_spaces end,furnishing=case when not plot then merged.furnishing end,
   construction_status=case when not plot then merged.construction_status end,property_age=case when not plot then merged.property_age end,
   amenities=merged.amenities,updated_by=actor.id
  where id=prop.id returning * into prop;
 end if;
 if p_data?'owner_contact' then
  contact=p_data->'owner_contact';
  if jsonb_typeof(contact) not in ('object','null') or (jsonb_typeof(contact)='object'
   and (contact-array['owner_name','owner_phone','owner_alt_phone','owner_notes','share_with_agents'])<>'{}'::jsonb) then
   raise exception 'Unsupported owner contact details' using errcode='HA400';end if;
  if jsonb_typeof(contact)='null' or not exists(select 1 from jsonb_each_text(contact) e
   where e.key<>'share_with_agents' and nullif(btrim(e.value),'') is not null) then
   delete from public.property_owner_contacts where property_id=prop.id;
  else
   insert into public.property_owner_contacts as c(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
   values(prop.id,nullif(btrim(contact->>'owner_name'),''),nullif(btrim(contact->>'owner_phone'),''),
    nullif(btrim(contact->>'owner_alt_phone'),''),nullif(btrim(contact->>'owner_notes'),''),
    prop.owner_agent_id is null and coalesce((contact->>'share_with_agents')::boolean,false))
   on conflict(property_id) do update set owner_name=excluded.owner_name,owner_phone=excluded.owner_phone,
    owner_alt_phone=excluded.owner_alt_phone,owner_notes=excluded.owner_notes,share_with_agents=excluded.share_with_agents,updated_at=now();
  end if;
 end if;
 -- Field names only: never prices, addresses or owner contact values.
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case when p_property is null then 'create' else 'update' end,'properties',prop.id::text,p_request,
  jsonb_build_object('fields',to_jsonb(array(select k from jsonb_object_keys(p_data-'expected_updated_at') k order by k)),
   'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end));
 return public.inventory_property(p_actor,prop.id);
end $$;

-- Replaces the administrator-only version from 013 with the same checks for
-- linked records, the photo cleanup queue and the audit entry: administrators
-- delete company properties, agents delete their own.
create or replace function public.delete_property(p_property uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prop public.properties;photo_count integer;
begin
 select * into actor from public.profiles where id=p_actor for share;
 if not found or not actor.active or actor.deleted_at is not null or actor.role not in ('admin','agent') then
  raise exception 'Your account is not active' using errcode='42501';
 end if;
 -- This lock also prevents concurrent new foreign-key references or photos
 -- from being attached between the checks and deletion.
 select * into prop from public.properties where id=p_property for update;
 if not found or (actor.role='agent' and prop.owner_agent_id<>actor.id) then
  raise exception 'Property not found' using errcode='P0002';end if;
 if prop.owner_agent_id is null and actor.role<>'admin' then
  raise exception 'The company inventory is read-only for agents' using errcode='42501';end if;
 if prop.owner_agent_id is not null and actor.role<>'agent' then
  raise exception 'Agent inventories are read-only for administrators' using errcode='42501';end if;
 if exists(select 1 from public.leads where property_id=p_property)
  or exists(select 1 from public.visits where property_id=p_property)
  or exists(select 1 from public.deals where property_id=p_property) then
  raise exception 'Property has linked CRM records' using errcode='23503';
 end if;
 insert into public.property_photo_cleanup(property_id,storage_path)
  select property_id,storage_path from public.property_photos where property_id=p_property;
 get diagnostics photo_count = row_count;
 delete from public.property_photos where property_id=p_property;
 -- Owner contact details are removed with the property (on delete cascade).
 delete from public.properties where id=p_property;
 insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
  values(p_actor,'delete','properties',p_property::text,jsonb_build_object('photo_count',photo_count),p_request);
end $$;

-- --------------------------------------------------------------- photos
-- Checked before a file is uploaded to Storage; inventory_photo_add rechecks.
create or replace function public.inventory_access(p_actor uuid,p_property uuid,p_write boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,p_write);
begin
 return jsonb_build_object('id',prop.id,'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end,
  'photo_count',(select count(*) from public.property_photos where property_id=prop.id));
end $$;
create or replace function public.inventory_photos(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'storage_path',x.storage_path) order by x.position,x.created_at,x.id),'[]'::jsonb)
  from public.property_photos x where x.property_id=prop.id);
end $$;
create or replace function public.inventory_photo_add(p_actor uuid,p_property uuid,p_path text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);photo uuid;
begin
 if p_path is null or p_path !~ ('^'||prop.id::text||'/[0-9a-f-]{36}$') then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 if (select count(*) from public.property_photos where property_id=prop.id)>=20 then
  raise exception 'A property can have up to 20 pictures' using errcode='HA409';end if;
 insert into public.property_photos(property_id,storage_path,position)
  values(prop.id,p_path,coalesce((select max(position)+1 from public.property_photos where property_id=prop.id),0))
  returning id into photo;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'upload_photo','properties',prop.id::text,p_request,'{}'::jsonb);
 return jsonb_build_object('id',photo);
end $$;
-- The file is queued for Storage removal in the same transaction (013 queue).
create or replace function public.inventory_photo_remove(p_actor uuid,p_property uuid,p_photo uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);removed text;
begin
 delete from public.property_photos where id=p_photo and property_id=prop.id returning storage_path into removed;
 if removed is null then raise exception 'Picture not found' using errcode='HA404';end if;
 insert into public.property_photo_cleanup(property_id,storage_path) values(prop.id,removed) on conflict(storage_path) do nothing;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'delete_photo','properties',prop.id::text,p_request,'{}'::jsonb);
end $$;
-- p_photos lists every picture of the property once, cover first.
create or replace function public.inventory_photo_order(p_actor uuid,p_property uuid,p_photos uuid[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
begin
 if p_photos is null or cardinality(p_photos)<>(select count(*) from public.property_photos where property_id=prop.id)
  or cardinality(p_photos)<>(select count(distinct x) from unnest(p_photos) x)
  or exists(select 1 from unnest(p_photos) x where not exists(select 1 from public.property_photos f where f.id=x and f.property_id=prop.id)) then
  raise exception 'The pictures changed. Close the property, open it again and retry.' using errcode='HA409';end if;
 update public.property_photos f set position=o.n-1 from unnest(p_photos) with ordinality o(id,n) where f.id=o.id and f.property_id=prop.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'reorder_photos','properties',prop.id::text,p_request,'{}'::jsonb);
 return public.inventory_photos(p_actor,p_property);
end $$;

-- ---------------------------------------------------------------- grants
-- Supabase's default privileges grant new sequences to browser roles.
do $$ begin
 execute format('revoke all on sequence %s from public,anon,authenticated',pg_get_serial_sequence('public.properties','property_no'));
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('guard_property_owner','guard_property_link','inventory_member','inventory_property_for',
  'inventory_json','inventory_contact','inventory_rows','inventory_counts','inventory_agent_rows','inventory_page','inventory_property',
  'inventory_summary','inventory_agents','inventory_save','delete_property','inventory_access','inventory_photos','inventory_photo_add',
  'inventory_photo_remove','inventory_photo_order') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  -- Helpers and triggers run only inside these functions.
  if f.proname in ('inventory_page','inventory_property','inventory_summary','inventory_agents','inventory_save','delete_property',
   'inventory_access','inventory_photos','inventory_photo_add','inventory_photo_remove','inventory_photo_order') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 042_attendance_admin_entries.sql

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



-- Migration: 043_audit_history.sql

-- Apply after 042. Safe to rerun. Readable audit history (update 043).
-- Adds two read-only functions for the administrator's Audit history page:
-- * audit_page: one filtered, paginated page of audit entries, with the
--   people and records each entry refers to resolved in the same query: who
--   did it, the employee affected, an assigned agent, and the lead, property,
--   document or import file involved. Searching matches the name or UID of
--   the person who acted or the employee affected.
-- * audit_actors: everyone who has a recorded action, for the "Performed by"
--   filter.
-- Audit entries are not changed: no table, column, row, trigger or
-- permission of audit_log is added or altered, and it stays append-only.
-- The API turns these rows into plain-English descriptions and removes
-- anything secret from the metadata before it reaches the browser.

do $$ begin
 if to_regprocedure('public.accounts_admin(uuid)') is null or to_regprocedure('public.format_lead_no(bigint)') is null then
  raise exception 'Apply CRM updates up to 042 before update 043.';
 end if;
end $$;

-- p_filters: {search, from, to (Pakistan dates), actor, sort: newest|oldest,
-- match: [{action, prefix, entity}]}. An entry matches the list when it fits
-- any item; each item's keys are optional and all of them must fit.
create or replace function public.audit_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare f jsonb=coalesce(p_filters,'{}'::jsonb);term text=nullif(btrim(coalesce(f->>'search','')),'');
 oldest boolean=coalesce(f->>'sort','newest')='oldest';since date;until date;acted_by uuid;matches jsonb=f->'match';
 uuid_re text='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
  or length(coalesce(term,''))>100 or coalesce(f->>'sort','newest') not in ('newest','oldest')
  or (matches is not null and jsonb_typeof(matches)<>'array')
  or (f->>'actor' is not null and f->>'actor'!~uuid_re) then
  raise exception 'Invalid audit filter' using errcode='22023';end if;
 since=(f->>'from')::date;until=(f->>'to')::date;acted_by=(f->>'actor')::uuid;
 with people as (
  select p.id from public.profiles p where term is not null and (p.name ilike '%'||term||'%' or p.uid::text=term)
 ), base as (
  select a.*,case when a.metadata->>'user_id' ~ uuid_re then (a.metadata->>'user_id')::uuid
    when a.entity='profiles' and a.entity_id ~ uuid_re then a.entity_id::uuid end affected_id
  from public.audit_log a
  where (since is null or a.created_at>=(since::timestamp at time zone 'Asia/Karachi'))
   and (until is null or a.created_at<((until+1)::timestamp at time zone 'Asia/Karachi'))
   and (acted_by is null or a.actor_id=acted_by)
   and (matches is null or exists(select 1 from jsonb_array_elements(matches) m
    where (m->>'action' is null or a.action=m->>'action') and (m->>'prefix' is null or a.action like m->>'prefix'||'%')
     and (m->>'entity' is null or a.entity=m->>'entity')))
 ), filtered as (
  select b.* from base b where term is null or b.actor_id in (select id from people) or b.affected_id in (select id from people)
 ), page as (
  select * from filtered order by case when oldest then id end,case when not oldest then id end desc
  limit p_limit offset (p_page-1)*p_limit
 )
 select jsonb_build_object('page',p_page,'limit',p_limit,'count',(select count(*) from filtered),
  'data',coalesce(jsonb_agg(jsonb_build_object(
   'id',pg.id,'created_at',pg.created_at,'action',pg.action,'entity',pg.entity,'entity_id',pg.entity_id,
   'actor_id',pg.actor_id,'request_id',pg.request_id,'metadata',pg.metadata,
   'actor',case when ac.id is not null then jsonb_build_object('id',ac.id,'name',ac.name,'role',ac.role,'uid',ac.uid,
    'active',ac.active,'deleted',ac.deleted_at is not null) end,
   'affected',case when af.id is not null then jsonb_build_object('id',af.id,'name',af.name,'role',af.role,'uid',af.uid,
    'active',af.active,'deleted',af.deleted_at is not null) end,
   'agent',case when ag.id is not null then jsonb_build_object('id',ag.id,'name',ag.name,'role',ag.role,'uid',ag.uid,
    'deleted',ag.deleted_at is not null) end,
   'lead',case when l.id is not null then jsonb_build_object('number',public.format_lead_no(l.lead_no),'deleted',l.deleted_at is not null) end,
   'property',case when pr.id is not null then jsonb_build_object('title',pr.title,'number',pr.property_no) end,
   'document',case when d.id is not null then jsonb_build_object('title',d.title) end,
   'import',case when li.id is not null then jsonb_build_object('file_name',li.file_name,'deleted',li.deleted_at is not null) end)
   order by case when oldest then pg.id end,case when not oldest then pg.id end desc),'[]'::jsonb))
 into result
 from page pg
 left join public.profiles ac on ac.id=pg.actor_id
 left join public.profiles af on af.id=pg.affected_id
 left join public.profiles ag on ag.id=case when pg.metadata->>'agent_id' ~ uuid_re then (pg.metadata->>'agent_id')::uuid end
 left join public.calls c on c.id=case when pg.entity='calls' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.leads l on l.id=case when pg.entity='leads' and pg.entity_id ~ uuid_re then pg.entity_id::uuid
   when pg.metadata->>'lead_id' ~ uuid_re then (pg.metadata->>'lead_id')::uuid else c.lead_id end
 left join public.properties pr on pr.id=case when pg.entity='properties' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.knowledge_documents d on d.id=case when pg.entity='knowledge_documents' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.lead_imports li on li.id=case when pg.entity='lead_imports' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end;
 return result;
end $$;

create or replace function public.audit_actors(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'uid',p.uid,
   'active',p.active,'deleted',p.deleted_at is not null) order by p.name,p.id),'[]'::jsonb)
  from public.profiles p where p.id in (select distinct a.actor_id from public.audit_log a where a.actor_id is not null));
end $$;

-- Browser roles get nothing; the API calls these for a signed-in admin.
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('audit_page','audit_actors') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 044_admin_property_promotion.sql

-- Apply after 043. Safe to rerun. Admin property promotion (update 044).
-- An administrator can add an agent's listing to Admin Properties as an
-- independent copy: a new company property with its own reference number,
-- its own pictures (copied in Storage) and the seller's contact for
-- administrators only. The agent's original is not changed and stays theirs.
-- property_promotions links the two permanently, so the copy shows who
-- originally listed it, the overall count counts the pair once, and
-- administrators are told in the CRM when the agent changes or deletes the
-- original. Nothing is synchronized between the two records.
-- Existing properties, pictures, owners and permissions are unchanged. The
-- picture clean-up queue gains not_before (existing rows stay due at once):
-- pictures being copied are reserved there and removed later if their
-- promotion never finishes.
-- Runs as one transaction in a few seconds; properties and notifications
-- are locked briefly. If a lock is not available within 5 seconds everything
-- rolls back unchanged: run it again later.

set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.inventory_save(uuid,uuid,jsonb,text)') is null or to_regprocedure('public.push_notification(uuid,text,text,text,text,text,uuid,text,text,text)') is null
  or to_regprocedure('public.audit_page(uuid,jsonb,integer,integer)') is null then
  raise exception 'Apply CRM updates up to 043 before update 044.';
 end if;
end $$;

-- ----------------------------------------------------------- promotions
-- One row per promotion. Deleting either property clears its id here and
-- keeps the reference numbers and the agent, so the history stays readable.
-- The agent's name and UID are also kept as they were, as a fallback.
create table if not exists public.property_promotions(
 id uuid primary key default gen_random_uuid(),
 source_id uuid references public.properties(id) on delete set null,
 copy_id uuid unique references public.properties(id) on delete set null,
 source_property_no bigint not null,
 copy_property_no bigint not null,
 source_agent_id uuid not null references public.profiles(id),
 source_agent_uid integer,
 source_agent_name text not null check(length(source_agent_name) between 1 and 200),
 promoted_by uuid not null references public.profiles(id),
 promoted_at timestamptz not null default now(),
 source_deleted_at timestamptz,
 copy_deleted_at timestamptz,
 check(source_id is distinct from copy_id)
);
-- At most one copy in Admin Properties per agent listing at a time.
create unique index if not exists property_promotions_live_source on public.property_promotions(source_id)
 where source_id is not null and copy_id is not null;
create index if not exists property_promotions_source on public.property_promotions(source_id);
alter table public.property_promotions enable row level security;
revoke all on public.property_promotions from public,anon,authenticated;
grant all on public.property_promotions to service_role;

-- A queued file is removed only once not_before has passed.
alter table public.property_photo_cleanup add column if not exists not_before timestamptz not null default now();
create index if not exists property_photo_cleanup_due on public.property_photo_cleanup(not_before);

-- Notification types for promoted listings.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary',
 'property_source_updated','property_source_removed'));

-- ------------------------------------------------------- shared helpers
-- What the viewer may know about a property's promotion. Everyone sees who
-- originally listed a copy (name and UID only); administrators also see the
-- original's reference, and on an agent's listing whether it can be added
-- or which copy it has.
create or replace function public.inventory_promotion(p_actor public.profiles,p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(case
  when p_property.owner_agent_id is null then (
   select jsonb_build_object('promoted_from',jsonb_build_object('agent_name',coalesce(a.name,pp.source_agent_name),
     'agent_uid',coalesce(a.uid,pp.source_agent_uid),
     'agent_status',case when a.id is null or a.deleted_at is not null then 'deleted' when a.active then 'active' else 'inactive' end,
     'promoted_at',pp.promoted_at)
    ||case when p_actor.role='admin' then jsonb_build_object('source_id',pp.source_id,'source_property_no',pp.source_property_no,
     'source_removed',pp.source_id is null,'promoted_by_name',(select name from public.profiles where id=pp.promoted_by)) else '{}'::jsonb end)
   from public.property_promotions pp left join public.profiles a on a.id=pp.source_agent_id where pp.copy_id=p_property.id)
  when p_actor.role='admin' then jsonb_build_object(
   'admin_copy',(select jsonb_build_object('id',pp.copy_id,'property_no',pp.copy_property_no) from public.property_promotions pp
    where pp.source_id=p_property.id and pp.copy_id is not null),
   'can_promote',p_property.availability in ('available','reserved')
    and not exists(select 1 from public.property_promotions pp where pp.source_id=p_property.id and pp.copy_id is not null))
  end,'{}'::jsonb)
$$;
-- The agent listing an administrator wants to add, checked (and locked when
-- p_lock) so a second promotion of it waits, then finds the first.
create or replace function public.promotion_source(p_property uuid,p_lock boolean) returns public.properties language plpgsql security definer set search_path='' as $$
declare prop public.properties;copy_no bigint;
begin
 if p_lock then select * into prop from public.properties where id=p_property for update;
 else select * into prop from public.properties where id=p_property;end if;
 if not found then raise exception 'Property not found' using errcode='HA404';end if;
 if prop.owner_agent_id is null then raise exception 'This property is already in Admin Properties' using errcode='HA400';end if;
 select copy_property_no into copy_no from public.property_promotions where source_id=prop.id and copy_id is not null;
 if found then
  raise exception 'This property is already in the Admin list as PR-%',lpad(copy_no::text,6,'0') using errcode='HA409';end if;
 if prop.availability not in ('available','reserved') then
  raise exception 'Only available or reserved listings can be added to the Admin list' using errcode='HA400';end if;
 return prop;
end $$;
-- What an agent changed, in words. Prices, status, purpose, title and size
-- are shown before and after; other fields are named only.
create or replace function public.promotion_change_text(p_old public.properties,p_new public.properties,p_keys text[]) returns text language sql stable set search_path='' as $$
 with labels(k,label,n) as (values ('title','Title',1),('price','Price',2),('availability','Status',3),('purpose','Purpose',4),
   ('size','Size',5),('type','Property type',6),('description','Description',7),('price_negotiable','Negotiable price',8),
   ('price_notes','Price notes',9),('province','Province',10),('city','City',11),('area_society','Area or society',12),
   ('block_sector','Block or sector',13),('street','Street',14),('plot_number','Plot or house number',15),('address','Full address',16),
   ('map_url','Map location',17),('bedrooms','Bedrooms',18),('bathrooms','Bathrooms',19),('kitchens','Kitchens',20),('floors','Floors',21),
   ('parking_spaces','Parking spaces',22),('furnishing','Furnishing',23),('construction_status','Construction',24),
   ('property_age','Property age',25),('amenities','Utilities and features',26),('owner_contact','Owner contact',27)),
  status(v,l) as (values ('available','Available'),('reserved','Reserved'),('sold','Sold'),('rented','Rented'),('archived','Inactive')),
  keys as (select case when k in ('area','area_unit') then 'size' else k end k from unnest(p_keys) k),
  items as (select l.label,l.n,case l.k
    when 'price' then 'PKR '||to_char(p_old.price,'FM999,999,999,999,990')||' → PKR '||to_char(p_new.price,'FM999,999,999,999,990')
    when 'availability' then coalesce((select s.l from status s where s.v=p_old.availability),p_old.availability)
     ||' → '||coalesce((select s.l from status s where s.v=p_new.availability),p_new.availability)
    when 'purpose' then case p_old.purpose when 'rent' then 'For rent' else 'For sale' end||' → '||case p_new.purpose when 'rent' then 'For rent' else 'For sale' end
    when 'title' then '“'||left(p_old.title,60)||'” → “'||left(p_new.title,60)||'”'
    when 'size' then trim_scale(p_old.area)::text||' '||p_old.area_unit||' → '||trim_scale(p_new.area)::text||' '||p_new.area_unit end detail
   from labels l where l.k in (select k from keys))
 select concat_ws(' ',(select string_agg(label||': '||detail||'.',' ' order by n) from items where detail is not null),
  (select case when exists(select 1 from items where detail is not null) then 'Also changed: ' else 'Changed: ' end
    ||string_agg(label,', ' order by n)||'.' from items where detail is null having count(*)>0))
$$;
-- Tells every active administrator, in the CRM only (no email or push),
-- that an agent changed or deleted a listing whose copy is in Admin
-- Properties. p_change: details (p_detail says what changed), photos
-- (p_detail: what was done), removed.
create or replace function public.notify_promotion_source(p_actor public.profiles,p_source public.properties,p_change text,p_detail text) returns void language plpgsql security definer set search_path='' as $$
declare link public.property_promotions;who text;src text;dup text;admin_id uuid;
begin
 select * into link from public.property_promotions where source_id=p_source.id and copy_id is not null;
 if not found then return;end if;
 who=p_actor.name||coalesce(' (UID '||p_actor.uid||')','');
 src='PR-'||lpad(p_source.property_no::text,6,'0');dup='PR-'||lpad(link.copy_property_no::text,6,'0');
 for admin_id in select id from public.profiles where role='admin' and active and deleted_at is null loop
  if p_change='removed' then
   perform public.push_notification(admin_id,'property_source_removed','property-removed:'||link.id,
    'Original listing removed: '||src,
    who||' deleted '||src||'. Admin copy '||dup||' is unchanged and stays in Admin Properties.',
    '/inventory?tab=company&property='||link.copy_id,null);
  elsif p_change='photos' then
   -- One notice per listing per day, counting the picture changes.
   perform public.push_notification(admin_id,'property_source_updated',
    'property-photos:'||link.id||':'||(now() at time zone 'Asia/Karachi')::date,
    'Original property pictures changed: '||src,
    who||' '||p_detail||' '||src||'. Admin copy '||dup||' keeps its own pictures.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id,null,
    '%s picture changes on original property '||src,
    who||' changed the pictures of '||src||' several times today. Admin copy '||dup||' keeps its own pictures.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id);
  else
   -- One notice per save.
   perform public.push_notification(admin_id,'property_source_updated','property-update:'||link.id||':'||gen_random_uuid(),
    'Original property updated: '||src,
    who||' updated '||src||'. '||coalesce(p_detail||' ','')||'Admin copy '||dup||' has not been changed.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id,null);
  end if;
 end loop;
end $$;

-- ---------------------------------------------------------------- reads
-- As in 041, plus promotion details for each listing.
create or replace function public.inventory_page(p_actor uuid,p_scope text,p_agent uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);owner_id uuid;f jsonb=coalesce(p_filters,'{}'::jsonb);
 term text=lower(btrim(coalesce(f->>'search','')));sort_key text=coalesce(f->>'sort','newest');num bigint;total bigint;items jsonb;header jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Choose a valid page' using errcode='HA400';end if;
 if p_scope='mine' then
  if actor.role<>'agent' then raise exception 'Administrators manage the company inventory' using errcode='HA400';end if;
  owner_id=actor.id;
 elsif p_scope='agent' then
  if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
  select to_jsonb(a) into header from public.inventory_agent_rows() a where a.id=p_agent;
  if header is null then raise exception 'Agent not found' using errcode='HA404';end if;
  owner_id=p_agent;
 elsif p_scope is distinct from 'company' then
  raise exception 'Choose an inventory' using errcode='HA400';
 end if;
 -- A reference such as PR-000012 (or 12) also finds that property.
 if term ~ '^(pr-?)?[0-9]{1,15}$' then num=regexp_replace(term,'^pr-?','')::bigint;end if;
 select count(*) into total from public.inventory_rows(p_scope,owner_id,f,num);
 select coalesce(jsonb_agg(public.inventory_json(p.prop)||public.inventory_promotion(actor,p.prop)
   ||jsonb_build_object('photo_count',coalesce(ph.n,0),'cover_photo_id',ph.id,'cover_path',ph.storage_path)
   order by p.k1,p.k2 desc,p.k3,p.k4 desc,p.k5,p.created_at desc,p.id desc),'[]'::jsonb) into items
 from (select r prop,r.id,r.created_at,case sort_key when 'price_low' then r.price end k1,
   case sort_key when 'price_high' then r.price end k2,case sort_key when 'title' then lower(r.title) end k3,
   case sort_key when 'updated' then r.updated_at end k4,case sort_key when 'oldest' then r.created_at end k5
  from public.inventory_rows(p_scope,owner_id,f,num) r
  order by k1,k2 desc,k3,k4 desc,k5,r.created_at desc,r.id desc
  limit p_limit offset (p_page-1)*p_limit) p
 left join lateral (select x.id,x.storage_path,count(*) over() n from public.property_photos x
  where x.property_id=p.id order by x.position,x.created_at,x.id limit 1) ph on true;
 return jsonb_build_object('data',items,'count',total,'page',p_page,'limit',p_limit)
  ||case when header is null then '{}'::jsonb else jsonb_build_object('agent',header) end;
end $$;
create or replace function public.inventory_property(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return public.inventory_json(prop)||public.inventory_promotion(actor,prop)||jsonb_build_object('owner_contact',public.inventory_contact(actor,prop),
  'can_edit',case when prop.owner_agent_id is null then actor.role='admin' else actor.role='agent' and prop.owner_agent_id=actor.id end);
end $$;
-- p_scope: company, agent (one agent: p_owner), agents (all agents), all
-- (every record) or unique (every listing once: a copy in Admin Properties
-- whose agent original still exists is the same listing and is left out).
create or replace function public.inventory_counts(p_scope text,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('total',count(*),'available',count(*) filter(where p.availability='available'),
  'reserved',count(*) filter(where p.availability='reserved'),'sold',count(*) filter(where p.availability='sold'),
  'rented',count(*) filter(where p.availability='rented'),'inactive',count(*) filter(where p.availability='archived'),
  'last_updated',max(p.updated_at))
 from public.properties p
 where case p_scope when 'company' then p.owner_agent_id is null when 'agent' then p.owner_agent_id=p_owner
  when 'agents' then p.owner_agent_id is not null
  when 'unique' then not exists(select 1 from public.property_promotions pp where pp.copy_id=p.id and pp.source_id is not null)
  else true end
$$;
create or replace function public.inventory_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role='agent' then
  return jsonb_build_object('role','agent','mine',public.inventory_counts('agent',actor.id),'company',public.inventory_counts('company',null));
 end if;
 return jsonb_build_object('role','admin','company',public.inventory_counts('company',null),
  'agents',public.inventory_counts('agents',null),'all',public.inventory_counts('all',null),
  'unique',public.inventory_counts('unique',null),
  'promoted',(select count(*) from public.property_promotions where copy_id is not null),
  'agents_with_properties',(select count(distinct owner_agent_id) from public.properties where owner_agent_id is not null));
end $$;

-- --------------------------------------------------------------- writes
-- As in 041. When an agent changes a listing that has a copy in Admin
-- Properties, administrators are told what changed; a save that changes
-- nothing tells nobody.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;before public.properties;
 fields jsonb;contact jsonb;plot boolean;old_contact jsonb;changes text[];
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities',
  'owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 fields=p_data-array['owner_contact','expected_updated_at'];
 if p_property is null then
  merged=jsonb_populate_record(null::public.properties,
   jsonb_build_object('description','','availability','available','price_negotiable',false,'amenities','[]'::jsonb)||fields);
 else
  prop=public.inventory_property_for(actor,p_property,true);
  if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from prop.updated_at then
   raise exception 'Someone else changed this property. Close it, open it again and repeat your change.' using errcode='HA409';end if;
  merged=jsonb_populate_record(prop,fields);
  before=prop;
  select to_jsonb(c)-array['property_id','updated_at'] into old_contact from public.property_owner_contacts c where c.property_id=prop.id;
 end if;
 if (merged.availability='sold' and merged.purpose='rent') or (merged.availability='rented' and merged.purpose='sale') then
  raise exception 'Use Sold for sale listings and Rented for rent listings' using errcode='HA400';end if;
 -- Plots and land have no rooms, furnishing, construction or age.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
   furnishing,construction_status,property_age,amenities,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
   case when not plot then merged.construction_status end,case when not plot then merged.property_age end,merged.amenities,
   case when actor.role='agent' then actor.id end,actor.id,actor.id)
  returning * into prop;
 else
  update public.properties set title=merged.title,description=merged.description,location=merged.location,price=merged.price,
   type=merged.type,area=merged.area,area_unit=merged.area_unit,availability=merged.availability,purpose=merged.purpose,
   province=merged.province,city=merged.city,area_society=merged.area_society,block_sector=merged.block_sector,street=merged.street,
   plot_number=merged.plot_number,address=merged.address,map_url=merged.map_url,price_negotiable=merged.price_negotiable,
   price_notes=merged.price_notes,bedrooms=case when not plot then merged.bedrooms end,bathrooms=case when not plot then merged.bathrooms end,
   kitchens=case when not plot then merged.kitchens end,floors=case when not plot then merged.floors end,
   parking_spaces=case when not plot then merged.parking_spaces end,furnishing=case when not plot then merged.furnishing end,
   construction_status=case when not plot then merged.construction_status end,property_age=case when not plot then merged.property_age end,
   amenities=merged.amenities,updated_by=actor.id
  where id=prop.id returning * into prop;
 end if;
 if p_data?'owner_contact' then
  contact=p_data->'owner_contact';
  if jsonb_typeof(contact) not in ('object','null') or (jsonb_typeof(contact)='object'
   and (contact-array['owner_name','owner_phone','owner_alt_phone','owner_notes','share_with_agents'])<>'{}'::jsonb) then
   raise exception 'Unsupported owner contact details' using errcode='HA400';end if;
  if jsonb_typeof(contact)='null' or not exists(select 1 from jsonb_each_text(contact) e
   where e.key<>'share_with_agents' and nullif(btrim(e.value),'') is not null) then
   delete from public.property_owner_contacts where property_id=prop.id;
  else
   insert into public.property_owner_contacts as c(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
   values(prop.id,nullif(btrim(contact->>'owner_name'),''),nullif(btrim(contact->>'owner_phone'),''),
    nullif(btrim(contact->>'owner_alt_phone'),''),nullif(btrim(contact->>'owner_notes'),''),
    prop.owner_agent_id is null and coalesce((contact->>'share_with_agents')::boolean,false))
   on conflict(property_id) do update set owner_name=excluded.owner_name,owner_phone=excluded.owner_phone,
    owner_alt_phone=excluded.owner_alt_phone,owner_notes=excluded.owner_notes,share_with_agents=excluded.share_with_agents,updated_at=now();
  end if;
 end if;
 -- Field names only: never prices, addresses or owner contact values.
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case when p_property is null then 'create' else 'update' end,'properties',prop.id::text,p_request,
  jsonb_build_object('fields',to_jsonb(array(select k from jsonb_object_keys(p_data-'expected_updated_at') k order by k)),
   'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end));
 if p_property is not null and actor.role='agent'
  and exists(select 1 from public.property_promotions where source_id=prop.id and copy_id is not null) then
  changes=array(select k from unnest(array['title','description','type','purpose','availability','price','price_negotiable','price_notes',
   'area','area_unit','province','city','area_society','block_sector','street','plot_number','address','map_url','bedrooms','bathrooms',
   'kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities']) k
   where to_jsonb(before)->k is distinct from to_jsonb(prop)->k);
  if old_contact is distinct from (select to_jsonb(c)-array['property_id','updated_at'] from public.property_owner_contacts c where c.property_id=prop.id) then
   changes=changes||'owner_contact'::text;end if;
  if cardinality(changes)>0 then
   perform public.notify_promotion_source(actor,prop,'details',public.promotion_change_text(before,prop,changes));end if;
 end if;
 return public.inventory_property(p_actor,prop.id);
end $$;

-- As in 041. Deleting an agent listing that has a copy in Admin Properties
-- keeps the copy and tells administrators; deleting a copy keeps the
-- agent's listing. Either way the link keeps both reference numbers.
create or replace function public.delete_property(p_property uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prop public.properties;photo_count integer;kept bigint;
begin
 select * into actor from public.profiles where id=p_actor for share;
 if not found or not actor.active or actor.deleted_at is not null or actor.role not in ('admin','agent') then
  raise exception 'Your account is not active' using errcode='42501';
 end if;
 -- This lock also prevents concurrent new foreign-key references or photos
 -- from being attached between the checks and deletion.
 select * into prop from public.properties where id=p_property for update;
 if not found or (actor.role='agent' and prop.owner_agent_id<>actor.id) then
  raise exception 'Property not found' using errcode='P0002';end if;
 if prop.owner_agent_id is null and actor.role<>'admin' then
  raise exception 'The company inventory is read-only for agents' using errcode='42501';end if;
 if prop.owner_agent_id is not null and actor.role<>'agent' then
  raise exception 'Agent inventories are read-only for administrators' using errcode='42501';end if;
 if exists(select 1 from public.leads where property_id=p_property)
  or exists(select 1 from public.visits where property_id=p_property)
  or exists(select 1 from public.deals where property_id=p_property) then
  raise exception 'Property has linked CRM records' using errcode='23503';
 end if;
 if prop.owner_agent_id is not null then
  select copy_property_no into kept from public.property_promotions where source_id=prop.id and copy_id is not null;
  if kept is not null then perform public.notify_promotion_source(actor,prop,'removed',null);end if;
  update public.property_promotions set source_deleted_at=now() where source_id=prop.id;
 else
  update public.property_promotions set copy_deleted_at=now() where copy_id=prop.id;
 end if;
 insert into public.property_photo_cleanup(property_id,storage_path)
  select property_id,storage_path from public.property_photos where property_id=p_property;
 get diagnostics photo_count = row_count;
 delete from public.property_photos where property_id=p_property;
 -- Owner contact details are removed with the property (on delete cascade);
 -- the promotion link keeps its reference numbers (on delete set null).
 delete from public.properties where id=p_property;
 insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
  values(p_actor,'delete','properties',p_property::text,jsonb_build_object('photo_count',photo_count)
   ||case when kept is not null then jsonb_build_object('admin_copy_property_no',kept) else '{}'::jsonb end,p_request);
end $$;

-- --------------------------------------------------------------- photos
-- As in 041, and administrators hear when an agent changes the pictures of
-- a listing that has a copy in Admin Properties.
create or replace function public.inventory_photo_add(p_actor uuid,p_property uuid,p_path text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);photo uuid;
begin
 if p_path is null or p_path !~ ('^'||prop.id::text||'/[0-9a-f-]{36}$') then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 if (select count(*) from public.property_photos where property_id=prop.id)>=20 then
  raise exception 'A property can have up to 20 pictures' using errcode='HA409';end if;
 insert into public.property_photos(property_id,storage_path,position)
  values(prop.id,p_path,coalesce((select max(position)+1 from public.property_photos where property_id=prop.id),0))
  returning id into photo;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'upload_photo','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','added a picture to');end if;
 return jsonb_build_object('id',photo);
end $$;
-- The file is queued for Storage removal in the same transaction (013 queue).
create or replace function public.inventory_photo_remove(p_actor uuid,p_property uuid,p_photo uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);removed text;
begin
 delete from public.property_photos where id=p_photo and property_id=prop.id returning storage_path into removed;
 if removed is null then raise exception 'Picture not found' using errcode='HA404';end if;
 insert into public.property_photo_cleanup(property_id,storage_path) values(prop.id,removed) on conflict(storage_path) do nothing;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'delete_photo','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','removed a picture from');end if;
end $$;
-- p_photos lists every picture of the property once, cover first.
create or replace function public.inventory_photo_order(p_actor uuid,p_property uuid,p_photos uuid[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
begin
 if p_photos is null or cardinality(p_photos)<>(select count(*) from public.property_photos where property_id=prop.id)
  or cardinality(p_photos)<>(select count(distinct x) from unnest(p_photos) x)
  or exists(select 1 from unnest(p_photos) x where not exists(select 1 from public.property_photos f where f.id=x and f.property_id=prop.id)) then
  raise exception 'The pictures changed. Close the property, open it again and retry.' using errcode='HA409';end if;
 update public.property_photos f set position=o.n-1 from unnest(p_photos) with ordinality o(id,n) where f.id=o.id and f.property_id=prop.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'reorder_photos','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','reordered the pictures of');end if;
 return public.inventory_photos(p_actor,p_property);
end $$;

-- ------------------------------------------------------------ promotion
-- Adding an agent listing to Admin Properties takes three calls from the
-- API, so pictures can be copied in Storage between them:
-- 1. inventory_promote_prepare checks the request and reserves a new path
--    for each picture under the new property's id (p_copy, chosen by the
--    API). Reservations are queued for removal in an hour.
-- 2. The API copies each picture to its new path.
-- 3. inventory_promote creates the copy in one transaction and keeps the
--    reserved pictures that were copied; or, if anything failed,
--    inventory_promote_release makes the reservations due at once.
create or replace function public.inventory_promote_prepare(p_actor uuid,p_property uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;photos jsonb;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,false);
 if p_copy is null or exists(select 1 from public.properties where id=p_copy)
  or exists(select 1 from public.property_photo_cleanup where property_id=p_copy) then
  raise exception 'Invalid request' using errcode='HA400';end if;
 select coalesce(jsonb_agg(jsonb_build_object('from',x.storage_path,'to',p_copy::text||'/'||gen_random_uuid()::text)
   order by x.position,x.created_at,x.id),'[]'::jsonb) into photos
 from public.property_photos x where x.property_id=prop.id;
 insert into public.property_photo_cleanup(property_id,storage_path,not_before)
  select p_copy,e->>'to',now()+interval '1 hour' from jsonb_array_elements(photos) e;
 return jsonb_build_object('photos',photos);
end $$;
-- p_paths: the reserved pictures that were copied, in the original's order.
create or replace function public.inventory_promote(p_actor uuid,p_property uuid,p_copy uuid,p_paths text[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;made public.properties;agent public.profiles;
 planned integer;kept integer;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,true);
 p_paths=coalesce(p_paths,'{}'::text[]);
 if p_copy is null or cardinality(p_paths)>20 or cardinality(p_paths)<>(select count(distinct x) from unnest(p_paths) x)
  or exists(select 1 from unnest(p_paths) x where x is null or x !~ ('^'||p_copy::text||'/[0-9a-f-]{36}$')) then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 select count(*) into planned from public.property_photo_cleanup where property_id=p_copy and not_before>now();
 -- Every copied picture must still be reserved. A reservation that was
 -- released or already processed may mean its file is gone.
 delete from public.property_photo_cleanup where property_id=p_copy and storage_path=any(p_paths) and not_before>now();
 get diagnostics kept=row_count;
 if kept<>cardinality(p_paths) then
  raise exception 'The pictures changed while they were being copied. Please try again.' using errcode='HA409';end if;
 -- Pictures that could not be copied were never written; let the queue
 -- clear their reservations.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy;
 select * into agent from public.profiles where id=prop.owner_agent_id;
 insert into public.properties(id,title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
  block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
  furnishing,construction_status,property_age,amenities,owner_agent_id,created_by,updated_by)
 values(p_copy,prop.title,prop.description,prop.location,prop.price,prop.type,prop.area,prop.area_unit,prop.availability,prop.purpose,
  prop.province,prop.city,prop.area_society,prop.block_sector,prop.street,prop.plot_number,prop.address,prop.map_url,prop.price_negotiable,
  prop.price_notes,prop.bedrooms,prop.bathrooms,prop.kitchens,prop.floors,prop.parking_spaces,prop.furnishing,prop.construction_status,
  prop.property_age,prop.amenities,null,actor.id,actor.id)
 returning * into made;
 -- The seller's contact is kept for administrators only, as on the
 -- agent's listing; it is not shared with agents unless an administrator
 -- later chooses to.
 insert into public.property_owner_contacts(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
  select made.id,c.owner_name,c.owner_phone,c.owner_alt_phone,c.owner_notes,false from public.property_owner_contacts c where c.property_id=prop.id;
 insert into public.property_photos(property_id,storage_path,position)
  select made.id,u.x,(u.n-1)::integer from unnest(p_paths) with ordinality u(x,n);
 insert into public.property_promotions(source_id,copy_id,source_property_no,copy_property_no,source_agent_id,source_agent_uid,source_agent_name,promoted_by)
  values(prop.id,made.id,prop.property_no,made.property_no,agent.id,agent.uid,left(coalesce(nullif(btrim(agent.name),''),'Agent'),200),actor.id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'promote','properties',made.id::text,p_request,jsonb_build_object('agent_id',agent.id,'source_id',prop.id,
   'source_property_no',prop.property_no,'copy_property_no',made.property_no,'photo_count',kept,'photos_missing',greatest(planned-kept,0)));
 return public.inventory_property(p_actor,made.id);
end $$;
-- After a failed promotion: if the copy was not created, its reservations
-- become due so the clean-up removes any copied pictures.
create or replace function public.inventory_promote_release(p_actor uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 -- Release first: this waits for a promotion still saving, so the check
 -- below then sees whether it finished.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy and not_before>now();
 return jsonb_build_object('committed',exists(select 1 from public.properties where id=p_copy));
end $$;

-- ---------------------------------------------------------------- grants
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('inventory_promotion','promotion_source','promotion_change_text','notify_promotion_source',
  'inventory_page','inventory_property','inventory_counts','inventory_summary','inventory_save','delete_property','inventory_photo_add',
  'inventory_photo_remove','inventory_photo_order','inventory_promote_prepare','inventory_promote','inventory_promote_release') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  -- Helpers run only inside these functions.
  if f.proname not in ('inventory_promotion','promotion_source','promotion_change_text','notify_promotion_source','inventory_counts') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 045_daily_task_management.sql

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



-- Migration: 046_building_property_categories.sql

-- Apply after 045. Safe to rerun. Building categories (update 046).
-- A property or building can offer several kinds of units or spaces at
-- once: residential and hotel apartments with 1, 2 or 3 bedrooms, commercial
-- outlets and workspaces. properties.building_categories keeps every kind
-- ticked, in one standard order, each once; older properties have none.
-- The categories describe what the building offers; bedrooms still describes
-- the listed unit. Like the other building details, plots and land have none.
-- * The column's type (a domain) accepts only the listed categories, in the
--   standard order, without repeats. The check sits on the type rather than
--   the table, so updates 041 and 044 can still be applied again.
-- * Saves (inventory_save) accept, check and order the selection, and record
--   in the audit which fields actually changed and the categories before and
--   after. Administrators are told about category changes on a promoted
--   agent listing, as for its other details.
-- * Adding a listing to Admin Properties (inventory_promote) copies its
--   categories; afterwards the two records change independently.
-- Existing properties, owners, pictures, promotions and permissions are
-- unchanged. If 041 or 044 is ever applied again, apply this update after it.
-- Runs as one transaction in a few seconds. properties is rewritten once to
-- add the column (it is small) and is locked meanwhile; if a lock is not
-- available within 5 seconds everything rolls back unchanged: run it again.

set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.inventory_promote(uuid,uuid,uuid,text[],text)') is null
  or to_regprocedure('public.promotion_change_text(public.properties,public.properties,text[])') is null
  or to_regclass('public.task_daily_reports') is null then
  raise exception 'Apply CRM updates up to 045 before update 046.';
 end if;
end $$;

-- ------------------------------------------------------------ categories
-- Identifiers, order and labels match the API (server/src/utils/validators.js)
-- and the screens (client/src/lib/inventory.js); a test keeps them equal.
create or replace function public.property_category_list() returns text[] language sql immutable parallel safe set search_path='' as $$
 select array['residential_1_bed','residential_2_bed','residential_3_bed','hotel_apartment_1_bed','hotel_apartment_2_bed',
  'hotel_apartment_3_bed','commercial_outlet','workspace']::text[]
$$;
-- The listed categories in p, in the standard order, each once.
create or replace function public.property_categories_sorted(p text[]) returns text[] language sql immutable parallel safe set search_path='' as $$
 select array(select c from unnest(public.property_category_list()) with ordinality a(c,n) where c=any(p) order by n)
$$;
create or replace function public.property_category_label(p text) returns text language sql immutable parallel safe set search_path='' as $$
 select case p when 'residential_1_bed' then 'Residential — 1 Bedroom' when 'residential_2_bed' then 'Residential — 2 Bedrooms'
  when 'residential_3_bed' then 'Residential — 3 Bedrooms' when 'hotel_apartment_1_bed' then 'Hotel Apartments — 1 Bedroom'
  when 'hotel_apartment_2_bed' then 'Hotel Apartments — 2 Bedrooms' when 'hotel_apartment_3_bed' then 'Hotel Apartments — 3 Bedrooms'
  when 'commercial_outlet' then 'Commercial Outlets / Retail Shops' when 'workspace' then 'Office Spaces / Workspaces' end
$$;
-- A list equal to its own standard ordering has only listed categories and
-- no repeats. Not null is on the column, so older save functions that do not
-- name it still get the empty default.
do $$ begin
 if to_regtype('public.property_building_categories') is null then
  create domain public.property_building_categories as text[] check(value=public.property_categories_sorted(value));
 end if;
end $$;
alter table public.properties add column if not exists building_categories public.property_building_categories not null default '{}';

-- ---------------------------------------------------------- notifications
-- As in 044, plus building categories: what was added and removed.
create or replace function public.promotion_change_text(p_old public.properties,p_new public.properties,p_keys text[]) returns text language sql stable set search_path='' as $$
 with labels(k,label,n) as (values ('title','Title',1),('price','Price',2),('availability','Status',3),('purpose','Purpose',4),
   ('size','Size',5),('type','Property type',6),('description','Description',7),('price_negotiable','Negotiable price',8),
   ('price_notes','Price notes',9),('province','Province',10),('city','City',11),('area_society','Area or society',12),
   ('block_sector','Block or sector',13),('street','Street',14),('plot_number','Plot or house number',15),('address','Full address',16),
   ('map_url','Map location',17),('bedrooms','Bedrooms',18),('bathrooms','Bathrooms',19),('kitchens','Kitchens',20),('floors','Floors',21),
   ('parking_spaces','Parking spaces',22),('furnishing','Furnishing',23),('construction_status','Construction',24),
   ('property_age','Property age',25),('building_categories','Building categories',26),('amenities','Utilities and features',27),
   ('owner_contact','Owner contact',28)),
  status(v,l) as (values ('available','Available'),('reserved','Reserved'),('sold','Sold'),('rented','Rented'),('archived','Inactive')),
  keys as (select case when k in ('area','area_unit') then 'size' else k end k from unnest(p_keys) k),
  cats as (select c,n,c=any(p_old.building_categories) was,c=any(p_new.building_categories) now
   from unnest(public.property_category_list()) with ordinality a(c,n)),
  cat_change as (select (select count(*) from cats where now and not was) added,(select count(*) from cats where was and not now) removed,
   concat_ws('; ','added '||(select string_agg(public.property_category_label(c),', ' order by n) from cats where now and not was),
    'removed '||(select string_agg(public.property_category_label(c),', ' order by n) from cats where was and not now)) words),
  items as (select l.label,l.n,case l.k
    when 'price' then 'PKR '||to_char(p_old.price,'FM999,999,999,999,990')||' → PKR '||to_char(p_new.price,'FM999,999,999,999,990')
    when 'availability' then coalesce((select s.l from status s where s.v=p_old.availability),p_old.availability)
     ||' → '||coalesce((select s.l from status s where s.v=p_new.availability),p_new.availability)
    when 'purpose' then case p_old.purpose when 'rent' then 'For rent' else 'For sale' end||' → '||case p_new.purpose when 'rent' then 'For rent' else 'For sale' end
    when 'title' then '“'||left(p_old.title,60)||'” → “'||left(p_new.title,60)||'”'
    when 'size' then trim_scale(p_old.area)::text||' '||p_old.area_unit||' → '||trim_scale(p_new.area)::text||' '||p_new.area_unit
    -- Short enough to leave room for the rest of the notice (500 characters).
    when 'building_categories' then (select case when length(words)<=220 then words
     else concat_ws(', ','added '||nullif(added,0),'removed '||nullif(removed,0)) end from cat_change) end detail
   from labels l where l.k in (select k from keys))
 select concat_ws(' ',(select string_agg(label||': '||detail||'.',' ' order by n) from items where detail is not null),
  (select case when exists(select 1 from items where detail is not null) then 'Also changed: ' else 'Changed: ' end
    ||string_agg(label,', ' order by n)||'.' from items where detail is null having count(*)>0))
$$;

-- --------------------------------------------------------------- writes
-- As in 044, plus building categories: checked, put in the standard order
-- and cleared for plots and land like the other building details. The audit
-- also records which fields actually changed (names only) and, when they
-- changed, the categories before and after.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;before public.properties;
 fields jsonb;contact jsonb;plot boolean;old_contact jsonb;changes text[];cats_before text[];meta jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities',
  'building_categories','owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 if p_data?'building_categories' then
  if jsonb_typeof(p_data->'building_categories') is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_data->'building_categories') e
   where jsonb_typeof(e)<>'string' or not (e#>>'{}')=any(public.property_category_list())) then
   raise exception 'Choose building categories from the list' using errcode='HA400';end if;
  if (select count(*)<>count(distinct e) from jsonb_array_elements(p_data->'building_categories') e) then
   raise exception 'Choose each building category once' using errcode='HA400';end if;
 end if;
 fields=p_data-array['owner_contact','expected_updated_at'];
 if fields?'building_categories' then
  fields=fields||jsonb_build_object('building_categories',to_jsonb(public.property_categories_sorted(
   array(select jsonb_array_elements_text(fields->'building_categories')))));
 end if;
 if p_property is null then
  merged=jsonb_populate_record(null::public.properties,
   jsonb_build_object('description','','availability','available','price_negotiable',false,'amenities','[]'::jsonb,
    'building_categories','[]'::jsonb)||fields);
  cats_before='{}';
 else
  prop=public.inventory_property_for(actor,p_property,true);
  if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from prop.updated_at then
   raise exception 'Someone else changed this property. Close it, open it again and repeat your change.' using errcode='HA409';end if;
  merged=jsonb_populate_record(prop,fields);
  before=prop;cats_before=prop.building_categories;
  select to_jsonb(c)-array['property_id','updated_at'] into old_contact from public.property_owner_contacts c where c.property_id=prop.id;
 end if;
 if (merged.availability='sold' and merged.purpose='rent') or (merged.availability='rented' and merged.purpose='sale') then
  raise exception 'Use Sold for sale listings and Rented for rent listings' using errcode='HA400';end if;
 -- Plots and land have no rooms, furnishing, construction, age or building
 -- categories.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
   furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
   case when not plot then merged.construction_status end,case when not plot then merged.property_age end,merged.amenities,
   case when not plot then merged.building_categories else '{}' end,
   case when actor.role='agent' then actor.id end,actor.id,actor.id)
  returning * into prop;
 else
  update public.properties set title=merged.title,description=merged.description,location=merged.location,price=merged.price,
   type=merged.type,area=merged.area,area_unit=merged.area_unit,availability=merged.availability,purpose=merged.purpose,
   province=merged.province,city=merged.city,area_society=merged.area_society,block_sector=merged.block_sector,street=merged.street,
   plot_number=merged.plot_number,address=merged.address,map_url=merged.map_url,price_negotiable=merged.price_negotiable,
   price_notes=merged.price_notes,bedrooms=case when not plot then merged.bedrooms end,bathrooms=case when not plot then merged.bathrooms end,
   kitchens=case when not plot then merged.kitchens end,floors=case when not plot then merged.floors end,
   parking_spaces=case when not plot then merged.parking_spaces end,furnishing=case when not plot then merged.furnishing end,
   construction_status=case when not plot then merged.construction_status end,property_age=case when not plot then merged.property_age end,
   amenities=merged.amenities,building_categories=case when not plot then merged.building_categories else '{}' end,updated_by=actor.id
  where id=prop.id returning * into prop;
 end if;
 if p_data?'owner_contact' then
  contact=p_data->'owner_contact';
  if jsonb_typeof(contact) not in ('object','null') or (jsonb_typeof(contact)='object'
   and (contact-array['owner_name','owner_phone','owner_alt_phone','owner_notes','share_with_agents'])<>'{}'::jsonb) then
   raise exception 'Unsupported owner contact details' using errcode='HA400';end if;
  if jsonb_typeof(contact)='null' or not exists(select 1 from jsonb_each_text(contact) e
   where e.key<>'share_with_agents' and nullif(btrim(e.value),'') is not null) then
   delete from public.property_owner_contacts where property_id=prop.id;
  else
   insert into public.property_owner_contacts as c(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
   values(prop.id,nullif(btrim(contact->>'owner_name'),''),nullif(btrim(contact->>'owner_phone'),''),
    nullif(btrim(contact->>'owner_alt_phone'),''),nullif(btrim(contact->>'owner_notes'),''),
    prop.owner_agent_id is null and coalesce((contact->>'share_with_agents')::boolean,false))
   on conflict(property_id) do update set owner_name=excluded.owner_name,owner_phone=excluded.owner_phone,
    owner_alt_phone=excluded.owner_alt_phone,owner_notes=excluded.owner_notes,share_with_agents=excluded.share_with_agents,updated_at=now();
  end if;
 end if;
 -- What actually changed, by field name.
 if p_property is not null then
  changes=array(select k from unnest(array['title','description','type','purpose','availability','price','price_negotiable','price_notes',
   'area','area_unit','province','city','area_society','block_sector','street','plot_number','address','map_url','bedrooms','bathrooms',
   'kitchens','floors','parking_spaces','furnishing','construction_status','property_age','building_categories','amenities']) k
   where to_jsonb(before)->k is distinct from to_jsonb(prop)->k);
  if old_contact is distinct from (select to_jsonb(c)-array['property_id','updated_at'] from public.property_owner_contacts c where c.property_id=prop.id) then
   changes=changes||'owner_contact'::text;end if;
 end if;
 -- Field names only: never prices, addresses or owner contact values. The
 -- building categories are not private and are kept before and after.
 meta=jsonb_build_object('fields',to_jsonb(array(select k from jsonb_object_keys(p_data-'expected_updated_at') k order by k)),
  'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end)
  ||case when p_property is not null then jsonb_build_object('changed',to_jsonb(changes)) else '{}'::jsonb end
  ||case when prop.building_categories is distinct from cats_before then jsonb_build_object('building_categories',
   jsonb_build_object('before',to_jsonb(cats_before),'after',to_jsonb(prop.building_categories))) else '{}'::jsonb end;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case when p_property is null then 'create' else 'update' end,'properties',prop.id::text,p_request,meta);
 if p_property is not null and actor.role='agent' and cardinality(changes)>0
  and exists(select 1 from public.property_promotions where source_id=prop.id and copy_id is not null) then
  perform public.notify_promotion_source(actor,prop,'details',public.promotion_change_text(before,prop,changes));
 end if;
 return public.inventory_property(p_actor,prop.id);
end $$;

-- ------------------------------------------------------------ promotion
-- As in 044, and the copy starts with the original's building categories.
create or replace function public.inventory_promote(p_actor uuid,p_property uuid,p_copy uuid,p_paths text[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;made public.properties;agent public.profiles;
 planned integer;kept integer;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,true);
 p_paths=coalesce(p_paths,'{}'::text[]);
 if p_copy is null or cardinality(p_paths)>20 or cardinality(p_paths)<>(select count(distinct x) from unnest(p_paths) x)
  or exists(select 1 from unnest(p_paths) x where x is null or x !~ ('^'||p_copy::text||'/[0-9a-f-]{36}$')) then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 select count(*) into planned from public.property_photo_cleanup where property_id=p_copy and not_before>now();
 -- Every copied picture must still be reserved. A reservation that was
 -- released or already processed may mean its file is gone.
 delete from public.property_photo_cleanup where property_id=p_copy and storage_path=any(p_paths) and not_before>now();
 get diagnostics kept=row_count;
 if kept<>cardinality(p_paths) then
  raise exception 'The pictures changed while they were being copied. Please try again.' using errcode='HA409';end if;
 -- Pictures that could not be copied were never written; let the queue
 -- clear their reservations.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy;
 select * into agent from public.profiles where id=prop.owner_agent_id;
 insert into public.properties(id,title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
  block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
  furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
 values(p_copy,prop.title,prop.description,prop.location,prop.price,prop.type,prop.area,prop.area_unit,prop.availability,prop.purpose,
  prop.province,prop.city,prop.area_society,prop.block_sector,prop.street,prop.plot_number,prop.address,prop.map_url,prop.price_negotiable,
  prop.price_notes,prop.bedrooms,prop.bathrooms,prop.kitchens,prop.floors,prop.parking_spaces,prop.furnishing,prop.construction_status,
  prop.property_age,prop.amenities,prop.building_categories,null,actor.id,actor.id)
 returning * into made;
 -- The seller's contact is kept for administrators only, as on the
 -- agent's listing; it is not shared with agents unless an administrator
 -- later chooses to.
 insert into public.property_owner_contacts(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
  select made.id,c.owner_name,c.owner_phone,c.owner_alt_phone,c.owner_notes,false from public.property_owner_contacts c where c.property_id=prop.id;
 insert into public.property_photos(property_id,storage_path,position)
  select made.id,u.x,(u.n-1)::integer from unnest(p_paths) with ordinality u(x,n);
 insert into public.property_promotions(source_id,copy_id,source_property_no,copy_property_no,source_agent_id,source_agent_uid,source_agent_name,promoted_by)
  values(prop.id,made.id,prop.property_no,made.property_no,agent.id,agent.uid,left(coalesce(nullif(btrim(agent.name),''),'Agent'),200),actor.id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'promote','properties',made.id::text,p_request,jsonb_build_object('agent_id',agent.id,'source_id',prop.id,
   'source_property_no',prop.property_no,'copy_property_no',made.property_no,'photo_count',kept,'photos_missing',greatest(planned-kept,0)));
 return public.inventory_property(p_actor,made.id);
end $$;

-- ---------------------------------------------------------------- grants
-- The browser gets nothing. The category helpers stay callable by the API
-- role because the column's type uses them to check every write.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('property_category_list','property_categories_sorted','property_category_label',
  'promotion_change_text','inventory_save','inventory_promote') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname<>'promotion_change_text' then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';



-- Migration: 047_staff_management.sql

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



-- Migration: 048_flexible_employee_shifts.sql

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


COMMIT;
SELECT 'HD Marketing database setup completed' AS status;
