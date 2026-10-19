-- P5: apply once after 024. Authenticator secrets stay in Supabase Auth.
begin;
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
commit;
