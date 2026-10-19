-- Apply after 035. Safe to rerun: existing valid UIDs are never changed.
-- Every Admin/Agent profile receives a permanent six-digit business UID
-- (100000-999999). Supabase Auth UUIDs remain the identity and primary key.
-- New accounts are created directly by a PIN-unlocked admin (no email code).
begin;
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
commit;
