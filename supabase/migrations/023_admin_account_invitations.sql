-- Apply once after 022. Existing verified accounts, role/PIN protections and history are retained.
begin;
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
commit;
