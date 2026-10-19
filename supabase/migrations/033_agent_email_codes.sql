-- Apply once after 032. Agent email codes are entered by a PIN-unlocked admin.
begin;
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
commit;
