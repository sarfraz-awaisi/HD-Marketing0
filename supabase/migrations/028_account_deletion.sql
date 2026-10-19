-- Apply once after 027. Delete sign-in access while retaining business history.
begin;
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
commit;
