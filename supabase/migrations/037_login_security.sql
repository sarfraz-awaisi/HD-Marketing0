-- Apply after 036. Safe to rerun. Server-side sign-in with per-account lockout
-- (F21) and login history with lockout/after-hours security alerts (F24).
begin;
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
commit;
