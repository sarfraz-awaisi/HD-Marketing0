-- Apply once after migration 015. Existing accounts and CRM records are retained.
BEGIN;
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
COMMIT;
