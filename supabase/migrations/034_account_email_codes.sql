-- Apply once after 033. Both new Agent and Admin accounts use native email OTP.
-- Delivery still requires a configured sender; this cannot bypass hosted quotas.
begin;
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
commit;
