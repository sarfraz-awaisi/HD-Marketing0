-- Apply once after 034. Independent OTP challenges precede Auth provisioning.
begin;
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
commit;
