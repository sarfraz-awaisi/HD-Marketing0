-- Apply after 048. Safe to rerun. Dealer affiliate network (update 049).
-- Agents and administrators record property dealers they work with:
--  * an agent's dealer waits for an administrator (pending), who approves or
--    rejects it, optionally with a reason. Decisions are final: a rejected
--    dealer stays visible to its agent, who may submit the dealer again;
--  * an administrator's dealer is approved immediately, with the
--    administrator recorded as the person who added and approved it.
-- Agents see, search and count only the dealers they added themselves, and
-- cannot change or delete them after submitting. Administrators see every
-- dealer, edit details (the submission and approval stay as they were),
-- delete (soft: the row is kept) and restore.
-- Contact numbers are stored in one international form, so 03001234567,
-- +923001234567 and 923001234567 are the same number. Duplicates:
--  * the same person cannot hold two pending or approved dealers with the
--    same number (a unique index); they are told which dealer already has it;
--  * different people may record the same dealer. Agents are never told
--    about anyone else's dealers; administrators see the other records with
--    the same number on each dealer and can list them. Nothing is merged.
-- Browser roles get nothing: the API calls the functions below with the
-- signed-in account (p_actor), and each checks the role and ownership again.
-- Every change is written to the audit log. Existing data is unchanged.
-- Never apply an older update again after this one.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regclass('public.shift_schedules') is null
  or to_regprocedure('public.touch_updated()') is null then
  raise exception 'Apply CRM updates up to 048 before update 049.';
 end if;
end $$;

-- ---------------------------------------------------------------- dealers
create table if not exists public.dealers(
 id uuid primary key default gen_random_uuid(),
 dealer_no bigint generated always as identity unique,
 name text not null check(length(btrim(name)) between 2 and 120),
 phone text not null check(phone ~ '^\+[0-9]{10,15}$'),
 address text not null check(length(btrim(address)) between 3 and 300),
 company_name text check(length(company_name)<=120),
 city text check(length(city)<=80),
 area text check(length(area)<=120),
 notes text check(length(notes)<=1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 rejection_reason text check(length(rejection_reason)<=500),
 submitted_by uuid not null references public.profiles(id),
 client_key uuid not null,
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid references public.profiles(id),
 deleted_at timestamptz,
 deleted_by uuid references public.profiles(id),
 delete_reason text check(length(delete_reason)<=300),
 constraint dealers_review_consistent check((status='pending')=(reviewed_at is null) and (reviewed_at is null)=(reviewed_by is null)),
 constraint dealers_reason_only_rejected check(rejection_reason is null or status='rejected'),
 constraint dealers_deleted_consistent check((deleted_at is null)=(deleted_by is null) and (delete_reason is null or deleted_at is not null))
);
-- A repeated submission (the same form sent twice) returns the first dealer.
create unique index if not exists dealers_client_key on public.dealers(submitted_by,client_key);
-- One pending or approved dealer per person and number. Rejected and deleted
-- dealers do not count, so a rejected dealer can be submitted again.
create unique index if not exists dealers_owner_phone on public.dealers(submitted_by,phone) where deleted_at is null and status<>'rejected';
create index if not exists dealers_owner_created on public.dealers(submitted_by,created_at desc) where deleted_at is null;
create index if not exists dealers_status_created on public.dealers(status,created_at desc) where deleted_at is null;
create index if not exists dealers_phone on public.dealers(phone);
-- Each dealer's history, read from the audit log.
create index if not exists audit_log_dealers on public.audit_log(entity_id,id) where entity='dealers';
drop trigger if exists dealers_touch_updated on public.dealers;
create trigger dealers_touch_updated before update on public.dealers for each row execute function public.touch_updated();
alter table public.dealers enable row level security;
revoke all on public.dealers from public,anon,authenticated;
grant all on public.dealers to service_role;
-- Supabase's default privileges grant new sequences to browser roles.
do $$ begin
 execute format('revoke all on sequence %s from public,anon,authenticated',pg_get_serial_sequence('public.dealers','dealer_no'));
end $$;

-- ---------------------------------------------------------------- helpers
-- Active administrators and agents only; staff have no access.
create or replace function public.dealer_member(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent') for share;
 if not found then raise exception 'Dealers are available to administrators and agents only' using errcode='HA403';end if;
 return actor;
end $$;
create or replace function public.dealer_admin(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);
begin
 if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
 return actor;
end $$;
create or replace function public.dealer_ref(p_no bigint) returns text language sql immutable set search_path='' as $$
 select 'DL-'||lpad(p_no::text,6,'0')
$$;
-- The same rule as lead numbers (server/src/utils/phoneMask.js), plus a
-- Pakistani mobile number written without its leading 0 (3001234567).
create or replace function public.dealer_phone(p_phone text) returns text language plpgsql immutable set search_path='' as $$
declare n text=regexp_replace(coalesce(p_phone,''),'[\s()+.-]','','g');
begin
 if n like '00%' then n=substr(n,3);end if;
 if n like '0%' then n='92'||substr(n,2);
 elsif n ~ '^3[0-9]{9}$' then n='92'||n;
 end if;
 -- The example is not a real number: agents' responses mask anything that
 -- looks like one.
 if n !~ '^[0-9]{10,15}$' then
  raise exception 'Enter a valid contact number, for example 03XX XXXXXXX' using errcode='HA400';end if;
 return '+'||n;
end $$;
-- Trimmed, checked dealer details. p_partial: only the keys sent (an edit).
-- Optional details sent empty are cleared.
create or replace function public.dealer_clean(p_data jsonb,p_partial boolean) returns jsonb language plpgsql immutable set search_path='' as $$
declare d jsonb=coalesce(p_data,'{}'::jsonb);k text;v text;result jsonb='{}'::jsonb;
 labels constant jsonb='{"name":"Dealer name","phone":"Contact number","address":"Address","company_name":"Agency or company name",
  "city":"City","area":"Area or location","notes":"Additional notes"}';
 limits constant jsonb='{"name":120,"phone":30,"address":300,"company_name":120,"city":80,"area":120,"notes":1000}';
begin
 if jsonb_typeof(d)<>'object' then raise exception 'Send the dealer details' using errcode='HA400';end if;
 for k in select jsonb_object_keys(d) loop
  if not limits ? k then raise exception 'Unknown dealer detail: %',left(k,40) using errcode='HA400';end if;
  if jsonb_typeof(d->k) not in ('string','null') then raise exception '% must be text',labels->>k using errcode='HA400';end if;
  v=btrim(d->>k,E' \t\r\n');
  -- One-line details: runs of spaces become one space.
  if k<>'notes' and k<>'address' then v=regexp_replace(v,'\s+',' ','g');end if;
  v=nullif(v,'');
  if length(v)>(limits->>k)::integer then
   raise exception '% must be at most % characters',labels->>k,limits->>k using errcode='HA400';end if;
  if k='phone' and v is not null then v=public.dealer_phone(v);end if;
  result=result||jsonb_build_object(k,v);
 end loop;
 foreach k in array array['name','phone','address'] loop
  if (not p_partial or d ? k) and result->>k is null then raise exception '% is required',labels->>k using errcode='HA400';end if;
 end loop;
 if length(result->>'name')<2 then raise exception 'Dealer name must be at least 2 characters' using errcode='HA400';end if;
 if length(result->>'address')<3 then raise exception 'Address must be at least 3 characters' using errcode='HA400';end if;
 return result;
end $$;
-- A dealer as the API returns it. Agents get their own dealer's details,
-- status and rejection reason; administrators also get who added, reviewed,
-- changed and deleted it, and how many other records share its number.
-- owner_id lets the server show agents the full number of their own dealers
-- only (every other number in an agent's response stays masked).
create or replace function public.dealer_json(d public.dealers,p_admin boolean) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',d.id,'number',d.dealer_no,'reference',public.dealer_ref(d.dealer_no),'owner_id',d.submitted_by,'name',d.name,'phone',d.phone,
  'address',d.address,'company_name',d.company_name,'city',d.city,'area',d.area,'notes',d.notes,'status',d.status,
  'rejection_reason',d.rejection_reason,'created_at',d.created_at,'updated_at',d.updated_at,'reviewed_at',d.reviewed_at)
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
create or replace function public.dealer_audit(p_actor uuid,p_action text,d public.dealers,p_request text,p_extra jsonb) returns void language sql security definer set search_path='' as $$
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(p_actor,p_action,'dealers',d.id::text,p_request,jsonb_build_object('number',d.dealer_no,'name',d.name,'agent_id',d.submitted_by,'status',d.status)||coalesce(p_extra,'{}'::jsonb))
$$;
-- The dealer the same person already holds with this number, if any.
create or replace function public.dealer_held(p_owner uuid,p_phone text,p_except uuid) returns public.dealers language sql stable security definer set search_path='' as $$
 select * from public.dealers where submitted_by=p_owner and phone=p_phone and deleted_at is null and status<>'rejected'
  and id is distinct from p_except order by created_at limit 1
$$;

-- --------------------------------------------------------------- the API
-- p_data: name, phone, address (required); company_name, city, area, notes.
-- p_client_key identifies the form: sending it again returns the dealer it
-- created ("replayed") instead of a second dealer.
create or replace function public.dealer_create(p_actor uuid,p_data jsonb,p_client_key uuid,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);admin boolean=actor.role='admin';v jsonb;d public.dealers;held public.dealers;
begin
 if p_client_key is null then raise exception 'Refresh the page and try again' using errcode='HA400';end if;
 select * into d from public.dealers where submitted_by=actor.id and client_key=p_client_key;
 if found then return public.dealer_json(d,admin)||jsonb_build_object('replayed',true);end if;
 v=public.dealer_clean(p_data,false);
 held=public.dealer_held(actor.id,v->>'phone',null);
 if held.id is not null then
  raise exception 'You already added this contact number as dealer % (%). Open that dealer instead of adding it again.',
   public.dealer_ref(held.dealer_no),held.status using errcode='HA409';end if;
 begin
  insert into public.dealers(name,phone,address,company_name,city,area,notes,status,submitted_by,client_key,reviewed_by,reviewed_at)
  values(v->>'name',v->>'phone',v->>'address',v->>'company_name',v->>'city',v->>'area',v->>'notes',
   case when admin then 'approved' else 'pending' end,actor.id,p_client_key,
   case when admin then actor.id end,case when admin then now() end)
  returning * into d;
 exception when unique_violation then
  select * into d from public.dealers where submitted_by=actor.id and client_key=p_client_key;
  if found then return public.dealer_json(d,admin)||jsonb_build_object('replayed',true);end if;
  raise exception 'You already added this contact number. Refresh your dealers to see it.' using errcode='HA409';
 end;
 perform public.dealer_audit(actor.id,'dealer.create',d,p_request,jsonb_build_object('auto_approved',admin,
  'fields',(select jsonb_agg(k order by k) from jsonb_object_keys(jsonb_strip_nulls(v)) k)));
 return public.dealer_json(d,admin);
end $$;

-- p_filters: status (pending|approved|rejected), search, sort
-- (newest|oldest|name|updated); administrators also agent (who added it),
-- view (active|deleted) and duplicates (true: only numbers held by more than
-- one record). Agents always get their own dealers only, so every count,
-- page and search covers nothing else.
create or replace function public.dealers_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);admin boolean=actor.role='admin';f jsonb=coalesce(p_filters,'{}'::jsonb);
 term text=nullif(lower(btrim(f->>'search')),'');digits text;sort text=coalesce(f->>'sort','newest');owner uuid;
 deleted boolean;dups boolean;result jsonb;
begin
 if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
  or coalesce(f->>'status','pending') not in ('pending','approved','rejected')
  or coalesce(f->>'view','active') not in ('active','deleted')
  or sort not in ('newest','oldest','name','updated') or length(coalesce(term,''))>100
  or coalesce(f->>'duplicates','false') not in ('true','false')
  or (f->>'agent' is not null and f->>'agent' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
  raise exception 'Choose valid dealer filters' using errcode='HA400';end if;
 deleted=coalesce(f->>'view','active')='deleted';dups=coalesce(f->>'duplicates','false')='true';
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
   'approved',(select count(*) from live where status='approved'),'rejected',(select count(*) from live where status='rejected'))
   ||case when admin then jsonb_build_object(
    'deleted',(select count(*) from public.dealers d where d.deleted_at is not null and (owner is null or d.submitted_by=owner)),
    'duplicates',(select count(*) from live s
      where exists(select 1 from public.dealers o where o.phone=s.phone and o.id<>s.id and o.deleted_at is null)))
   else '{}'::jsonb end,
  'data',coalesce((select jsonb_agg(public.dealer_json(d,admin) order by p.rn) from page p join public.dealers d on d.id=p.id),'[]'::jsonb))
 into result;
 return result;
end $$;

-- Agents: their own dealer that is not deleted; anything else is "not found",
-- exactly like a dealer that does not exist. Administrators: any dealer, with
-- its history and the other records that share its number.
create or replace function public.dealer_detail(p_actor uuid,p_id uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);d public.dealers;
begin
 select * into d from public.dealers where id=p_id;
 if not found or (actor.role<>'admin' and (d.submitted_by<>actor.id or d.deleted_at is not null)) then
  raise exception 'Dealer not found' using errcode='HA404';end if;
 if actor.role<>'admin' then return public.dealer_json(d,false);end if;
 return public.dealer_json(d,true)||jsonb_build_object(
  'history',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'action',a.action,'at',a.created_at,
    'actor',(select jsonb_build_object('id',p.id,'name',p.name,'role',p.role) from public.profiles p where p.id=a.actor_id),
    'fields',a.metadata->'fields','changes',a.metadata->'changes','reason',a.metadata->>'reason') order by a.id),'[]'::jsonb)
   from public.audit_log a where a.entity='dealers' and a.entity_id=d.id::text),
  'possible_duplicates',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'number',o.dealer_no,'reference',public.dealer_ref(o.dealer_no),
    'name',o.name,'company_name',o.company_name,'status',o.status,'created_at',o.created_at,'deleted',o.deleted_at is not null,
    'submitted_by',(select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid) from public.profiles p where p.id=o.submitted_by))
    order by o.created_at,o.id),'[]'::jsonb)
   from public.dealers o where o.phone=d.phone and o.id<>d.id));
end $$;

-- Before saving: the dealers that already have this number. Agents see only
-- their own; administrators see everyone's, with who added each.
create or replace function public.dealer_check_phone(p_actor uuid,p_phone text,p_except uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_member(p_actor);admin boolean=actor.role='admin';n text=public.dealer_phone(p_phone);
begin
 return jsonb_build_object('phone',n,'matches',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.dealer_no,
   'reference',public.dealer_ref(d.dealer_no),'name',d.name,'company_name',d.company_name,'status',d.status,'created_at',d.created_at,
   'mine',d.submitted_by=actor.id)
   ||case when admin then jsonb_build_object('submitted_by',(select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid)
     from public.profiles p where p.id=d.submitted_by)) else '{}'::jsonb end
   order by d.created_at,d.id),'[]'::jsonb)
  from public.dealers d where d.phone=n and d.deleted_at is null and d.id is distinct from p_except
   and (admin or d.submitted_by=actor.id)));
end $$;

-- Administrators edit details only; the status, who added it and who
-- reviewed it stay as they were. p_expected is the updated_at the editor
-- saw: an edit made from an older view is refused.
create or replace function public.dealer_update(p_actor uuid,p_id uuid,p_data jsonb,p_expected timestamptz,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_admin(p_actor);v jsonb;d public.dealers;held public.dealers;k text;
 before_row jsonb;changes jsonb='{}'::jsonb;fields jsonb='[]'::jsonb;
begin
 if p_expected is null then raise exception 'Refresh the dealer and try again' using errcode='HA400';end if;
 v=public.dealer_clean(p_data,true);
 if v='{}'::jsonb then raise exception 'Change at least one detail' using errcode='HA400';end if;
 select * into d from public.dealers where id=p_id for update;
 if not found then raise exception 'Dealer not found' using errcode='HA404';end if;
 if d.deleted_at is not null then raise exception 'Restore this dealer before changing it' using errcode='HA409';end if;
 if d.updated_at<>p_expected then
  raise exception 'Someone changed this dealer after you opened it. Refresh to see the latest details.' using errcode='HA409';end if;
 before_row=to_jsonb(d);
 for k in select jsonb_object_keys(v) order by 1 loop
  if before_row->>k is distinct from v->>k then
   fields=fields||to_jsonb(k);
   -- Contact numbers are not copied into the audit log.
   if k<>'phone' then changes=changes||jsonb_build_object(k,jsonb_build_object('before',left(before_row->>k,200),'after',left(v->>k,200)));end if;
  end if;
 end loop;
 if jsonb_array_length(fields)=0 then return public.dealer_json(d,true)||jsonb_build_object('unchanged',true);end if;
 if v ? 'phone' and v->>'phone'<>d.phone and d.status<>'rejected' then
  held=public.dealer_held(d.submitted_by,v->>'phone',d.id);
  if held.id is not null then
   raise exception 'The person who added this dealer already has dealer % with that contact number',public.dealer_ref(held.dealer_no) using errcode='HA409';end if;
 end if;
 begin
  update public.dealers set
   name=case when v ? 'name' then v->>'name' else name end,
   phone=case when v ? 'phone' then v->>'phone' else phone end,
   address=case when v ? 'address' then v->>'address' else address end,
   company_name=case when v ? 'company_name' then v->>'company_name' else company_name end,
   city=case when v ? 'city' then v->>'city' else city end,
   area=case when v ? 'area' then v->>'area' else area end,
   notes=case when v ? 'notes' then v->>'notes' else notes end,
   updated_by=actor.id
  where id=d.id returning * into d;
 exception when unique_violation then
  raise exception 'The person who added this dealer already has another dealer with that contact number' using errcode='HA409';
 end;
 perform public.dealer_audit(actor.id,'dealer.update',d,p_request,jsonb_build_object('fields',fields,'changes',changes));
 return public.dealer_json(d,true);
end $$;

-- p_decision: approved|rejected. Only a pending dealer can be decided.
-- Repeating the same decision changes nothing (returned as "unchanged");
-- the opposite decision is refused.
create or replace function public.dealer_review(p_actor uuid,p_id uuid,p_decision text,p_reason text,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_admin(p_actor);d public.dealers;reason text=nullif(btrim(p_reason,E' \t\r\n'),'');who text;
begin
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject' using errcode='HA400';end if;
 if p_decision='approved' then reason=null;end if;
 if length(reason)>500 then raise exception 'The reason must be at most 500 characters' using errcode='HA400';end if;
 select * into d from public.dealers where id=p_id for update;
 if not found then raise exception 'Dealer not found' using errcode='HA404';end if;
 if d.deleted_at is not null then raise exception 'Restore this dealer before reviewing it' using errcode='HA409';end if;
 if d.status=p_decision then return public.dealer_json(d,true)||jsonb_build_object('unchanged',true);end if;
 if d.status<>'pending' then
  select name into who from public.profiles where id=d.reviewed_by;
  raise exception 'This dealer was already % by %',d.status,coalesce(who,'an administrator') using errcode='HA409';end if;
 update public.dealers set status=p_decision,reviewed_by=actor.id,reviewed_at=now(),rejection_reason=reason where id=d.id returning * into d;
 perform public.dealer_audit(actor.id,case when p_decision='approved' then 'dealer.approve' else 'dealer.reject' end,d,p_request,
  case when reason is not null then jsonb_build_object('reason',reason) else '{}'::jsonb end);
 return public.dealer_json(d,true);
end $$;

-- Soft delete: the dealer leaves every list (the agent's too) and can be
-- restored. Deleting again changes nothing.
create or replace function public.dealer_delete(p_actor uuid,p_id uuid,p_reason text,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_admin(p_actor);d public.dealers;reason text=nullif(btrim(p_reason,E' \t\r\n'),'');
begin
 if length(reason)>300 then raise exception 'The reason must be at most 300 characters' using errcode='HA400';end if;
 select * into d from public.dealers where id=p_id for update;
 if not found then raise exception 'Dealer not found' using errcode='HA404';end if;
 if d.deleted_at is not null then return public.dealer_json(d,true)||jsonb_build_object('unchanged',true);end if;
 update public.dealers set deleted_at=now(),deleted_by=actor.id,delete_reason=reason where id=d.id returning * into d;
 perform public.dealer_audit(actor.id,'dealer.delete',d,p_request,
  case when reason is not null then jsonb_build_object('reason',reason) else '{}'::jsonb end);
 return public.dealer_json(d,true);
end $$;
create or replace function public.dealer_restore(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles=public.dealer_admin(p_actor);d public.dealers;held public.dealers;
begin
 select * into d from public.dealers where id=p_id for update;
 if not found then raise exception 'Dealer not found' using errcode='HA404';end if;
 if d.deleted_at is null then return public.dealer_json(d,true)||jsonb_build_object('unchanged',true);end if;
 if d.status<>'rejected' then
  held=public.dealer_held(d.submitted_by,d.phone,d.id);
  if held.id is not null then
   raise exception 'Dealer % already has this contact number for the same person. Delete or change it first.',public.dealer_ref(held.dealer_no) using errcode='HA409';end if;
 end if;
 begin
  update public.dealers set deleted_at=null,deleted_by=null,delete_reason=null where id=d.id returning * into d;
 exception when unique_violation then
  raise exception 'Another dealer already has this contact number for the same person' using errcode='HA409';
 end;
 perform public.dealer_audit(actor.id,'dealer.restore',d,p_request,null);
 return public.dealer_json(d,true);
end $$;

-- ---------------------------------------------------------------- grants
-- Browser roles get nothing. The API calls the service-role functions; the
-- helpers are for the database owner and tests only.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'dealer%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('dealer_create','dealers_page','dealer_detail','dealer_check_phone','dealer_update','dealer_review','dealer_delete','dealer_restore') then
   execute format('grant execute on function %s to service_role',f.signature);
  else
   execute format('revoke all on function %s from service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
