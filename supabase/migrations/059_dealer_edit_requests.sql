-- Update 059: agents edit their own dealers; changes to an approved dealer
-- wait for an administrator. Apply after 058. Safe to rerun.
--
-- An agent's Edit on their own dealer (dealer_submit_changes):
--  * pending (not yet reviewed): the submitted dealer itself changes and
--    stays pending, so the administrator reviews the latest version;
--  * rejected: the corrected dealer is submitted again, pending once more
--    (the rejection stays in its history);
--  * approved: the approved details do not change. The changes wait in
--    dealer_change_requests, one pending request per dealer, which the agent
--    can revise (or withdraw, by changing everything back) until an
--    administrator approves them, which applies them, or rejects them with a
--    reason the agent sees, after which the agent can correct and propose
--    again.
-- Administrators still change any dealer directly (dealer_update, 049) and
-- never propose changes; nobody reviews their own. Every step names the
-- version it was made from: an edit, revision or decision made from an
-- older view is refused, so nothing silently overwrites a newer submission
-- or decision. Approving a new dealer (dealer_review) now names the version
-- reviewed too. Each step is written to the dealer's audit history.
-- Agents still never see or change other agents' dealers. Contact numbers
-- stay out of the audit log, as in 049. No existing row changes.
begin;
set local lock_timeout='5s';
do $$ begin
 -- 058's All leads filters name a call's outcome.
 if to_regprocedure('public.dealer_update(uuid,uuid,jsonb,timestamptz,text)') is null
  or not coalesce((select pg_get_functiondef(p.oid) like '%v_outcome%' from pg_proc p
   where p.oid=to_regprocedure('public.admin_lead_list(uuid,jsonb)')),false) then
  raise exception 'Apply CRM updates up to 058 before update 059.';
 end if;
end $$;

-- ------------------------------------------------- proposed changes
create table if not exists public.dealer_change_requests(
 id uuid primary key default gen_random_uuid(),
 dealer_id uuid not null references public.dealers(id),
 submitted_by uuid not null references public.profiles(id),
 status text not null default 'pending' check(status in ('pending','approved','rejected','withdrawn')),
 -- The proposed values of the details that differ, and the approved values
 -- they replace as they were when proposed.
 changes jsonb not null check(jsonb_typeof(changes)='object' and changes<>'{}'::jsonb),
 base jsonb not null check(jsonb_typeof(base)='object'),
 revisions integer not null default 0 check(revisions>=0),
 rejection_reason text check(length(rejection_reason)<=500),
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 -- The version (updated_at) the decision was made from, so the same
 -- decision sent again is recognised.
 reviewed_version timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint dealer_change_review_consistent check((status in ('pending','withdrawn'))=(reviewed_at is null) and (reviewed_at is null)=(reviewed_by is null)),
 constraint dealer_change_reason_only_rejected check(rejection_reason is null or status='rejected'));
create unique index if not exists dealer_change_one_pending on public.dealer_change_requests(dealer_id) where status='pending';
create index if not exists dealer_change_dealer on public.dealer_change_requests(dealer_id,created_at desc);
drop trigger if exists dealer_change_touch_updated on public.dealer_change_requests;
create trigger dealer_change_touch_updated before update on public.dealer_change_requests for each row execute function public.touch_updated();
alter table public.dealer_change_requests enable row level security;
revoke all on public.dealer_change_requests from public,anon,authenticated;
grant all on public.dealer_change_requests to service_role;

-- ------------------------------------------------- helpers
-- A dealer's details, as dealer_clean names them.
create or replace function public.dealer_values(d public.dealers) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('name',d.name,'phone',d.phone,'address',d.address,'company_name',d.company_name,'city',d.city,'area',d.area,'notes',d.notes)
$$;
-- A change request as the API returns it: each detail's approved value now
-- (before) and the proposed one (after); base_changed when an approved value
-- changed after the agent proposed. Administrators also get who proposed and
-- who decided.
create or replace function public.dealer_change_json(r public.dealer_change_requests,d public.dealers,p_admin boolean) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'status',r.status,
  'changes',(select jsonb_object_agg(k,jsonb_build_object('before',public.dealer_values(d)->>k,'after',r.changes->>k)) from jsonb_object_keys(r.changes) k),
  'base_changed',exists(select 1 from jsonb_object_keys(r.changes) k where public.dealer_values(d)->>k is distinct from r.base->>k),
  'submitted_at',r.created_at,'updated_at',r.updated_at,'revisions',r.revisions,'rejection_reason',r.rejection_reason,'reviewed_at',r.reviewed_at)
 ||case when p_admin then jsonb_build_object(
  'submitted_by',(select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid) from public.profiles p where p.id=r.submitted_by),
  'reviewed_by',(select jsonb_build_object('id',p.id,'name',p.name) from public.profiles p where p.id=r.reviewed_by))
 else '{}'::jsonb end
$$;

create or replace function public.dealer_json(d public.dealers,p_admin boolean) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',d.id,'number',d.dealer_no,'reference',public.dealer_ref(d.dealer_no),'owner_id',d.submitted_by,'name',d.name,'phone',d.phone,
  'address',d.address,'company_name',d.company_name,'city',d.city,'area',d.area,'notes',d.notes,'status',d.status,
  'rejection_reason',d.rejection_reason,'created_at',d.created_at,'updated_at',d.updated_at,'reviewed_at',d.reviewed_at,
  -- Update 059: changes waiting for review, and the latest decided ones.
  'pending_change',(select public.dealer_change_json(r,d,p_admin) from public.dealer_change_requests r where r.dealer_id=d.id and r.status='pending'),
  'last_change',(select public.dealer_change_json(r,d,p_admin) from public.dealer_change_requests r where r.dealer_id=d.id and r.status in ('approved','rejected')
   order by r.reviewed_at desc,r.id limit 1))
 ||case when p_admin then jsonb_build_object(
  'submitted_by',(select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'role',p.role,'active',p.active and p.deleted_at is null)
    from public.profiles p where p.id=d.submitted_by),
  'reviewed_by',(select jsonb_build_object('id',p.id,'name',p.name) from public.profiles p where p.id=d.reviewed_by),
  'updated_by',(select jsonb_build_object('id',p.id,'name',p.name) from public.profiles p where p.id=d.updated_by),
  'deleted_at',d.deleted_at,'delete_reason',d.delete_reason,
  'deleted_by',(select jsonb_build_object('id',p.id,'name',p.name) from public.profiles p where p.id=d.deleted_by),
  'duplicates',(select count(*) from public.dealers o where o.phone=d.phone and o.id<>d.id and o.deleted_at is null))
 else '{}'::jsonb end
$$;

-- The list, as in 049, with changes=true (dealers with changes waiting) and
-- their count.
create or replace function public.dealers_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);admin boolean=actor.role='admin';f jsonb=coalesce(p_filters,'{}'::jsonb);
 term text=nullif(lower(btrim(f->>'search')),'');digits text;sort text=coalesce(f->>'sort','newest');owner uuid;
 deleted boolean;dups boolean;changes boolean;result jsonb;
begin
 if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
  or coalesce(f->>'status','pending') not in ('pending','approved','rejected')
  or coalesce(f->>'view','active') not in ('active','deleted')
  or sort not in ('newest','oldest','name','updated') or length(coalesce(term,''))>100
  or coalesce(f->>'duplicates','false') not in ('true','false')
  or coalesce(f->>'changes','false') not in ('true','false')
  or (f->>'agent' is not null and f->>'agent' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
  raise exception 'Choose valid dealer filters' using errcode='HA400';end if;
 deleted=coalesce(f->>'view','active')='deleted';dups=coalesce(f->>'duplicates','false')='true';
 changes=coalesce(f->>'changes','false')='true';
 if not admin and (deleted or dups or f->>'agent' is not null) then
  raise exception 'Administrator access required' using errcode='HA403';end if;
 owner=case when admin then (f->>'agent')::uuid else actor.id end;
 -- A number typed as 0300 1234567 matches the stored +923001234567.
 digits=regexp_replace(coalesce(term,''),'[^0-9]','','g');
 if digits like '0%' then digits='92'||substr(digits,2);end if;
 -- live: the summary cards (dealers not deleted); scope: the list's view.
 with live as (
  select d.* from public.dealers d where (owner is null or d.submitted_by=owner) and d.deleted_at is null
 ), scope as (
  select d.* from public.dealers d
  where (owner is null or d.submitted_by=owner) and (d.deleted_at is not null)=deleted
 ), base as (
  select s.* from scope s
  where (term is null or position(term in lower(concat_ws(' ',s.name,s.company_name,s.city,s.area,s.address)))>0
    or (length(digits)>=4 and position(digits in s.phone)>0))
   and (not dups or exists(select 1 from public.dealers o where o.phone=s.phone and o.id<>s.id and o.deleted_at is null))
   -- Update 059: approved dealers with changes waiting for review.
   and (not changes or exists(select 1 from public.dealer_change_requests r where r.dealer_id=s.id and r.status='pending'))
 ), matched as (
  select b.id,row_number() over(order by
    case when sort='name' then lower(b.name) end,
    case when sort='oldest' then b.created_at end,
    case when sort='updated' then b.updated_at end desc,
    b.created_at desc,b.id) rn
  from base b where f->>'status' is null or b.status=f->>'status'
 ), page as (select * from matched order by rn limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('count',(select count(*) from matched),'page',p_page,'limit',p_limit,
  'summary',jsonb_build_object('total',(select count(*) from live),'pending',(select count(*) from live where status='pending'),
   'approved',(select count(*) from live where status='approved'),'rejected',(select count(*) from live where status='rejected'),
   'changes',(select count(*) from live l where exists(select 1 from public.dealer_change_requests r where r.dealer_id=l.id and r.status='pending')))
   ||case when admin then jsonb_build_object(
    'deleted',(select count(*) from public.dealers d where d.deleted_at is not null and (owner is null or d.submitted_by=owner)),
    'duplicates',(select count(*) from live s
      where exists(select 1 from public.dealers o where o.phone=s.phone and o.id<>s.id and o.deleted_at is null)))
   else '{}'::jsonb end,
  'data',coalesce((select jsonb_agg(public.dealer_json(d,admin) order by p.rn) from page p join public.dealers d on d.id=p.id),'[]'::jsonb))
 into result;
 return result;
end $$;

-- ------------------------------------------------- the agent's Edit
-- p_data: every detail, as the form now shows it (name, phone and address
-- required). p_expected: the version the agent edited, which is the pending
-- change request's updated_at if there is one, else the dealer's.
create or replace function public.dealer_submit_changes(p_actor uuid,p_id uuid,p_data jsonb,p_expected timestamptz,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);d public.dealers;r public.dealer_change_requests;held public.dealers;
 v jsonb;live jsonb;diff jsonb='{}'::jsonb;v_base jsonb='{}'::jsonb;v_changes jsonb='{}'::jsonb;fields jsonb='[]'::jsonb;k text;resubmit boolean;
begin
 if actor.role<>'agent' then
  raise exception 'Administrators change dealers directly with Edit details' using errcode='HA403';end if;
 if p_expected is null then raise exception 'Refresh the dealer and try again' using errcode='HA400';end if;
 v=public.dealer_clean(p_data,false);
 select * into d from public.dealers where id=p_id for update;
 -- Another agent's dealer is "not found", exactly like one that does not exist.
 if not found or d.submitted_by<>actor.id or d.deleted_at is not null then
  raise exception 'Dealer not found' using errcode='HA404';end if;
 select * into r from public.dealer_change_requests where dealer_id=d.id and status='pending' for update;
 if coalesce(r.updated_at,d.updated_at)<>p_expected then
  raise exception 'This dealer changed after you opened it (it may have been reviewed). Refresh to see the latest details, then edit again.' using errcode='HA409';end if;
 live=public.dealer_values(d);
 for k in select jsonb_object_keys(v) order by 1 loop
  if live->>k is distinct from v->>k then
   diff=diff||jsonb_build_object(k,v->k);v_base=v_base||jsonb_build_object(k,live->k);fields=fields||to_jsonb(k);
   -- Contact numbers are not copied into the audit log.
   if k<>'phone' then v_changes=v_changes||jsonb_build_object(k,jsonb_build_object('before',left(live->>k,200),'after',left(v->>k,200)));end if;
  end if;
 end loop;
 if d.status<>'approved' then
  -- Not yet approved: the submission itself changes. A rejected dealer is
  -- submitted again, corrected or as it was.
  resubmit=d.status='rejected';
  if diff='{}'::jsonb and not resubmit then return public.dealer_json(d,false)||jsonb_build_object('unchanged',true);end if;
  if diff ? 'phone' or resubmit then
   held=public.dealer_held(actor.id,coalesce(diff->>'phone',d.phone),d.id);
   if held.id is not null then
    raise exception 'You already have dealer % (%) with this contact number',public.dealer_ref(held.dealer_no),held.status using errcode='HA409';end if;
  end if;
  begin
   update public.dealers set
    name=coalesce(diff->>'name',name),phone=coalesce(diff->>'phone',phone),address=coalesce(diff->>'address',address),
    company_name=case when diff ? 'company_name' then diff->>'company_name' else company_name end,
    city=case when diff ? 'city' then diff->>'city' else city end,
    area=case when diff ? 'area' then diff->>'area' else area end,
    notes=case when diff ? 'notes' then diff->>'notes' else notes end,
    status='pending',reviewed_by=case when resubmit then null else reviewed_by end,
    reviewed_at=case when resubmit then null else reviewed_at end,rejection_reason=null,updated_by=actor.id
   where id=d.id returning * into d;
  exception when unique_violation then
   raise exception 'You already have another dealer with this contact number' using errcode='HA409';
  end;
  perform public.dealer_audit(actor.id,case when resubmit then 'dealer.resubmit' else 'dealer.revise' end,d,p_request,
   jsonb_build_object('fields',fields,'changes',v_changes));
  return public.dealer_json(d,false);
 end if;
 -- Approved: the approved details stay until an administrator approves.
 if diff='{}'::jsonb then
  if r.id is null then return public.dealer_json(d,false)||jsonb_build_object('unchanged',true);end if;
  -- Everything changed back: the waiting changes are withdrawn.
  update public.dealer_change_requests set status='withdrawn' where id=r.id;
  perform public.dealer_audit(actor.id,'dealer.change_withdraw',d,p_request,jsonb_build_object('change_id',r.id));
  return public.dealer_json(d,false)||jsonb_build_object('withdrawn',true);
 end if;
 if diff ? 'phone' then
  held=public.dealer_held(actor.id,diff->>'phone',d.id);
  if held.id is not null then
   raise exception 'You already have dealer % (%) with this contact number',public.dealer_ref(held.dealer_no),held.status using errcode='HA409';end if;
 end if;
 if r.id is null then
  begin
   insert into public.dealer_change_requests(dealer_id,submitted_by,changes,base) values(d.id,actor.id,diff,v_base) returning * into r;
  exception when unique_violation then
   raise exception 'Your changes were just sent from another window. Refresh to see them.' using errcode='HA409';
  end;
  perform public.dealer_audit(actor.id,'dealer.change_request',d,p_request,
   jsonb_build_object('change_id',r.id,'fields',fields,'changes',v_changes));
 else
  update public.dealer_change_requests set changes=diff,base=v_base,revisions=revisions+1 where id=r.id returning * into r;
  perform public.dealer_audit(actor.id,'dealer.change_revise',d,p_request,
   jsonb_build_object('change_id',r.id,'fields',fields,'changes',v_changes));
 end if;
 return public.dealer_json(d,false);
end $$;

-- ------------------------------------------------- administrators' decisions
-- A new dealer's review, as in 049, made from the version reviewed: if the
-- agent changed the dealer since, the decision is refused.
create or replace function public.dealer_review(p_actor uuid,p_id uuid,p_decision text,p_reason text,p_expected timestamptz,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.dealers;
begin
 perform public.dealer_admin(p_actor);
 select * into d from public.dealers where id=p_id for update;
 if found and d.deleted_at is null and d.status='pending' and d.updated_at is distinct from p_expected then
  raise exception 'The agent changed this dealer after you opened it. Review the latest details first.' using errcode='HA409';end if;
 return public.dealer_review(p_actor,p_id,p_decision,p_reason,p_request);
end $$;

-- An approved dealer's waiting changes. p_expected: the change request's
-- updated_at the administrator reviewed; p_expected_dealer: the dealer's.
-- Approving applies the proposed details; rejecting keeps the approved ones
-- and tells the agent the reason. Repeating a decision changes nothing.
create or replace function public.dealer_change_review(p_actor uuid,p_id uuid,p_decision text,p_reason text,p_expected timestamptz,
 p_expected_dealer timestamptz,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_admin(p_actor);d public.dealers;r public.dealer_change_requests;held public.dealers;
 reason text=nullif(btrim(p_reason,E' \t\r\n'),'');live jsonb;v_changes jsonb='{}'::jsonb;fields jsonb='[]'::jsonb;k text;
begin
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject' using errcode='HA400';end if;
 if p_decision='approved' then reason=null;end if;
 if length(reason)>500 then raise exception 'The reason must be at most 500 characters' using errcode='HA400';end if;
 if p_expected is null or p_expected_dealer is null then raise exception 'Refresh the dealer and try again' using errcode='HA400';end if;
 select * into d from public.dealers where id=p_id for update;
 if not found then raise exception 'Dealer not found' using errcode='HA404';end if;
 select * into r from public.dealer_change_requests where dealer_id=d.id and status='pending' for update;
 if r.id is null then
  select * into r from public.dealer_change_requests where dealer_id=d.id and reviewed_version=p_expected and status in ('approved','rejected')
   order by created_at desc limit 1;
  if r.status=p_decision then return public.dealer_json(d,true)||jsonb_build_object('unchanged',true);end if;
  raise exception 'There are no changes waiting for review on this dealer. Refresh to see the latest.' using errcode='HA409';
 end if;
 if r.submitted_by=actor.id then raise exception 'You cannot review your own changes' using errcode='HA403';end if;
 if r.updated_at<>p_expected then
  raise exception 'The agent revised these changes after you opened them. Review the latest version.' using errcode='HA409';end if;
 if d.updated_at<>p_expected_dealer then
  raise exception 'This dealer changed after you opened it. Refresh to compare the changes with the current details.' using errcode='HA409';end if;
 if d.deleted_at is not null then raise exception 'Restore this dealer before reviewing its changes' using errcode='HA409';end if;
 live=public.dealer_values(d);
 for k in select jsonb_object_keys(r.changes) order by 1 loop
  fields=fields||to_jsonb(k);
  if k<>'phone' then v_changes=v_changes||jsonb_build_object(k,jsonb_build_object('before',left(live->>k,200),'after',left(r.changes->>k,200)));end if;
 end loop;
 if p_decision='approved' then
  if r.changes ? 'phone' and r.changes->>'phone' is distinct from d.phone then
   held=public.dealer_held(d.submitted_by,r.changes->>'phone',d.id);
   if held.id is not null then
    raise exception 'The agent already has dealer % with that contact number. Reject these changes with a reason.',public.dealer_ref(held.dealer_no) using errcode='HA409';end if;
  end if;
  begin
   update public.dealers set
    name=coalesce(r.changes->>'name',name),phone=coalesce(r.changes->>'phone',phone),address=coalesce(r.changes->>'address',address),
    company_name=case when r.changes ? 'company_name' then r.changes->>'company_name' else company_name end,
    city=case when r.changes ? 'city' then r.changes->>'city' else city end,
    area=case when r.changes ? 'area' then r.changes->>'area' else area end,
    notes=case when r.changes ? 'notes' then r.changes->>'notes' else notes end,
    updated_by=actor.id
   where id=d.id returning * into d;
  exception when unique_violation then
   raise exception 'The agent already has another dealer with that contact number' using errcode='HA409';
  end;
 end if;
 update public.dealer_change_requests set status=p_decision,rejection_reason=reason,reviewed_by=actor.id,reviewed_at=now(),reviewed_version=r.updated_at
  where id=r.id;
 perform public.dealer_audit(actor.id,case when p_decision='approved' then 'dealer.change_approve' else 'dealer.change_reject' end,d,p_request,
  jsonb_build_object('change_id',r.id,'fields',fields,'changes',v_changes,'proposed_by',r.submitted_by)
  ||case when reason is not null then jsonb_build_object('reason',reason) else '{}'::jsonb end);
 return public.dealer_json(d,true);
end $$;

-- ------------------------------------------------- grants
-- As in 049: browsers get nothing; the API calls the functions it needs; the
-- helpers are for the functions above only.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('dealer_values','dealer_change_json','dealer_json','dealers_page','dealer_submit_changes',
   'dealer_review','dealer_change_review') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('dealers_page','dealer_submit_changes','dealer_review','dealer_change_review') then
   execute format('grant execute on function %s to service_role',f.signature);
  else
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
