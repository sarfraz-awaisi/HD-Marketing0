-- Apply after 043. Safe to rerun. Admin property promotion (update 044).
-- An administrator can add an agent's listing to Admin Properties as an
-- independent copy: a new company property with its own reference number,
-- its own pictures (copied in Storage) and the seller's contact for
-- administrators only. The agent's original is not changed and stays theirs.
-- property_promotions links the two permanently, so the copy shows who
-- originally listed it, the overall count counts the pair once, and
-- administrators are told in the CRM when the agent changes or deletes the
-- original. Nothing is synchronized between the two records.
-- Existing properties, pictures, owners and permissions are unchanged. The
-- picture clean-up queue gains not_before (existing rows stay due at once):
-- pictures being copied are reserved there and removed later if their
-- promotion never finishes.
-- Runs as one transaction in a few seconds; properties and notifications
-- are locked briefly. If a lock is not available within 5 seconds everything
-- rolls back unchanged: run it again later.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.inventory_save(uuid,uuid,jsonb,text)') is null or to_regprocedure('public.push_notification(uuid,text,text,text,text,text,uuid,text,text,text)') is null
  or to_regprocedure('public.audit_page(uuid,jsonb,integer,integer)') is null then
  raise exception 'Apply CRM updates up to 043 before update 044.';
 end if;
end $$;

-- ----------------------------------------------------------- promotions
-- One row per promotion. Deleting either property clears its id here and
-- keeps the reference numbers and the agent, so the history stays readable.
-- The agent's name and UID are also kept as they were, as a fallback.
create table if not exists public.property_promotions(
 id uuid primary key default gen_random_uuid(),
 source_id uuid references public.properties(id) on delete set null,
 copy_id uuid unique references public.properties(id) on delete set null,
 source_property_no bigint not null,
 copy_property_no bigint not null,
 source_agent_id uuid not null references public.profiles(id),
 source_agent_uid integer,
 source_agent_name text not null check(length(source_agent_name) between 1 and 200),
 promoted_by uuid not null references public.profiles(id),
 promoted_at timestamptz not null default now(),
 source_deleted_at timestamptz,
 copy_deleted_at timestamptz,
 check(source_id is distinct from copy_id)
);
-- At most one copy in Admin Properties per agent listing at a time.
create unique index if not exists property_promotions_live_source on public.property_promotions(source_id)
 where source_id is not null and copy_id is not null;
create index if not exists property_promotions_source on public.property_promotions(source_id);
alter table public.property_promotions enable row level security;
revoke all on public.property_promotions from public,anon,authenticated;
grant all on public.property_promotions to service_role;

-- A queued file is removed only once not_before has passed.
alter table public.property_photo_cleanup add column if not exists not_before timestamptz not null default now();
create index if not exists property_photo_cleanup_due on public.property_photo_cleanup(not_before);

-- Notification types for promoted listings.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary',
 'property_source_updated','property_source_removed'));

-- ------------------------------------------------------- shared helpers
-- What the viewer may know about a property's promotion. Everyone sees who
-- originally listed a copy (name and UID only); administrators also see the
-- original's reference, and on an agent's listing whether it can be added
-- or which copy it has.
create or replace function public.inventory_promotion(p_actor public.profiles,p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(case
  when p_property.owner_agent_id is null then (
   select jsonb_build_object('promoted_from',jsonb_build_object('agent_name',coalesce(a.name,pp.source_agent_name),
     'agent_uid',coalesce(a.uid,pp.source_agent_uid),
     'agent_status',case when a.id is null or a.deleted_at is not null then 'deleted' when a.active then 'active' else 'inactive' end,
     'promoted_at',pp.promoted_at)
    ||case when p_actor.role='admin' then jsonb_build_object('source_id',pp.source_id,'source_property_no',pp.source_property_no,
     'source_removed',pp.source_id is null,'promoted_by_name',(select name from public.profiles where id=pp.promoted_by)) else '{}'::jsonb end)
   from public.property_promotions pp left join public.profiles a on a.id=pp.source_agent_id where pp.copy_id=p_property.id)
  when p_actor.role='admin' then jsonb_build_object(
   'admin_copy',(select jsonb_build_object('id',pp.copy_id,'property_no',pp.copy_property_no) from public.property_promotions pp
    where pp.source_id=p_property.id and pp.copy_id is not null),
   'can_promote',p_property.availability in ('available','reserved')
    and not exists(select 1 from public.property_promotions pp where pp.source_id=p_property.id and pp.copy_id is not null))
  end,'{}'::jsonb)
$$;
-- The agent listing an administrator wants to add, checked (and locked when
-- p_lock) so a second promotion of it waits, then finds the first.
create or replace function public.promotion_source(p_property uuid,p_lock boolean) returns public.properties language plpgsql security definer set search_path='' as $$
declare prop public.properties;copy_no bigint;
begin
 if p_lock then select * into prop from public.properties where id=p_property for update;
 else select * into prop from public.properties where id=p_property;end if;
 if not found then raise exception 'Property not found' using errcode='HA404';end if;
 if prop.owner_agent_id is null then raise exception 'This property is already in Admin Properties' using errcode='HA400';end if;
 select copy_property_no into copy_no from public.property_promotions where source_id=prop.id and copy_id is not null;
 if found then
  raise exception 'This property is already in the Admin list as PR-%',lpad(copy_no::text,6,'0') using errcode='HA409';end if;
 if prop.availability not in ('available','reserved') then
  raise exception 'Only available or reserved listings can be added to the Admin list' using errcode='HA400';end if;
 return prop;
end $$;
-- What an agent changed, in words. Prices, status, purpose, title and size
-- are shown before and after; other fields are named only.
create or replace function public.promotion_change_text(p_old public.properties,p_new public.properties,p_keys text[]) returns text language sql stable set search_path='' as $$
 with labels(k,label,n) as (values ('title','Title',1),('price','Price',2),('availability','Status',3),('purpose','Purpose',4),
   ('size','Size',5),('type','Property type',6),('description','Description',7),('price_negotiable','Negotiable price',8),
   ('price_notes','Price notes',9),('province','Province',10),('city','City',11),('area_society','Area or society',12),
   ('block_sector','Block or sector',13),('street','Street',14),('plot_number','Plot or house number',15),('address','Full address',16),
   ('map_url','Map location',17),('bedrooms','Bedrooms',18),('bathrooms','Bathrooms',19),('kitchens','Kitchens',20),('floors','Floors',21),
   ('parking_spaces','Parking spaces',22),('furnishing','Furnishing',23),('construction_status','Construction',24),
   ('property_age','Property age',25),('amenities','Utilities and features',26),('owner_contact','Owner contact',27)),
  status(v,l) as (values ('available','Available'),('reserved','Reserved'),('sold','Sold'),('rented','Rented'),('archived','Inactive')),
  keys as (select case when k in ('area','area_unit') then 'size' else k end k from unnest(p_keys) k),
  items as (select l.label,l.n,case l.k
    when 'price' then 'PKR '||to_char(p_old.price,'FM999,999,999,999,990')||' → PKR '||to_char(p_new.price,'FM999,999,999,999,990')
    when 'availability' then coalesce((select s.l from status s where s.v=p_old.availability),p_old.availability)
     ||' → '||coalesce((select s.l from status s where s.v=p_new.availability),p_new.availability)
    when 'purpose' then case p_old.purpose when 'rent' then 'For rent' else 'For sale' end||' → '||case p_new.purpose when 'rent' then 'For rent' else 'For sale' end
    when 'title' then '“'||left(p_old.title,60)||'” → “'||left(p_new.title,60)||'”'
    when 'size' then trim_scale(p_old.area)::text||' '||p_old.area_unit||' → '||trim_scale(p_new.area)::text||' '||p_new.area_unit end detail
   from labels l where l.k in (select k from keys))
 select concat_ws(' ',(select string_agg(label||': '||detail||'.',' ' order by n) from items where detail is not null),
  (select case when exists(select 1 from items where detail is not null) then 'Also changed: ' else 'Changed: ' end
    ||string_agg(label,', ' order by n)||'.' from items where detail is null having count(*)>0))
$$;
-- Tells every active administrator, in the CRM only (no email or push),
-- that an agent changed or deleted a listing whose copy is in Admin
-- Properties. p_change: details (p_detail says what changed), photos
-- (p_detail: what was done), removed.
create or replace function public.notify_promotion_source(p_actor public.profiles,p_source public.properties,p_change text,p_detail text) returns void language plpgsql security definer set search_path='' as $$
declare link public.property_promotions;who text;src text;dup text;admin_id uuid;
begin
 select * into link from public.property_promotions where source_id=p_source.id and copy_id is not null;
 if not found then return;end if;
 who=p_actor.name||coalesce(' (UID '||p_actor.uid||')','');
 src='PR-'||lpad(p_source.property_no::text,6,'0');dup='PR-'||lpad(link.copy_property_no::text,6,'0');
 for admin_id in select id from public.profiles where role='admin' and active and deleted_at is null loop
  if p_change='removed' then
   perform public.push_notification(admin_id,'property_source_removed','property-removed:'||link.id,
    'Original listing removed: '||src,
    who||' deleted '||src||'. Admin copy '||dup||' is unchanged and stays in Admin Properties.',
    '/inventory?tab=company&property='||link.copy_id,null);
  elsif p_change='photos' then
   -- One notice per listing per day, counting the picture changes.
   perform public.push_notification(admin_id,'property_source_updated',
    'property-photos:'||link.id||':'||(now() at time zone 'Asia/Karachi')::date,
    'Original property pictures changed: '||src,
    who||' '||p_detail||' '||src||'. Admin copy '||dup||' keeps its own pictures.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id,null,
    '%s picture changes on original property '||src,
    who||' changed the pictures of '||src||' several times today. Admin copy '||dup||' keeps its own pictures.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id);
  else
   -- One notice per save.
   perform public.push_notification(admin_id,'property_source_updated','property-update:'||link.id||':'||gen_random_uuid(),
    'Original property updated: '||src,
    who||' updated '||src||'. '||coalesce(p_detail||' ','')||'Admin copy '||dup||' has not been changed.',
    '/inventory?tab=agents&agent='||p_source.owner_agent_id||'&property='||p_source.id,null);
  end if;
 end loop;
end $$;

-- ---------------------------------------------------------------- reads
-- As in 041, plus promotion details for each listing.
create or replace function public.inventory_page(p_actor uuid,p_scope text,p_agent uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);owner_id uuid;f jsonb=coalesce(p_filters,'{}'::jsonb);
 term text=lower(btrim(coalesce(f->>'search','')));sort_key text=coalesce(f->>'sort','newest');num bigint;total bigint;items jsonb;header jsonb;
begin
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Choose a valid page' using errcode='HA400';end if;
 if p_scope='mine' then
  if actor.role<>'agent' then raise exception 'Administrators manage the company inventory' using errcode='HA400';end if;
  owner_id=actor.id;
 elsif p_scope='agent' then
  if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
  select to_jsonb(a) into header from public.inventory_agent_rows() a where a.id=p_agent;
  if header is null then raise exception 'Agent not found' using errcode='HA404';end if;
  owner_id=p_agent;
 elsif p_scope is distinct from 'company' then
  raise exception 'Choose an inventory' using errcode='HA400';
 end if;
 -- A reference such as PR-000012 (or 12) also finds that property.
 if term ~ '^(pr-?)?[0-9]{1,15}$' then num=regexp_replace(term,'^pr-?','')::bigint;end if;
 select count(*) into total from public.inventory_rows(p_scope,owner_id,f,num);
 select coalesce(jsonb_agg(public.inventory_json(p.prop)||public.inventory_promotion(actor,p.prop)
   ||jsonb_build_object('photo_count',coalesce(ph.n,0),'cover_photo_id',ph.id,'cover_path',ph.storage_path)
   order by p.k1,p.k2 desc,p.k3,p.k4 desc,p.k5,p.created_at desc,p.id desc),'[]'::jsonb) into items
 from (select r prop,r.id,r.created_at,case sort_key when 'price_low' then r.price end k1,
   case sort_key when 'price_high' then r.price end k2,case sort_key when 'title' then lower(r.title) end k3,
   case sort_key when 'updated' then r.updated_at end k4,case sort_key when 'oldest' then r.created_at end k5
  from public.inventory_rows(p_scope,owner_id,f,num) r
  order by k1,k2 desc,k3,k4 desc,k5,r.created_at desc,r.id desc
  limit p_limit offset (p_page-1)*p_limit) p
 left join lateral (select x.id,x.storage_path,count(*) over() n from public.property_photos x
  where x.property_id=p.id order by x.position,x.created_at,x.id limit 1) ph on true;
 return jsonb_build_object('data',items,'count',total,'page',p_page,'limit',p_limit)
  ||case when header is null then '{}'::jsonb else jsonb_build_object('agent',header) end;
end $$;
create or replace function public.inventory_property(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return public.inventory_json(prop)||public.inventory_promotion(actor,prop)||jsonb_build_object('owner_contact',public.inventory_contact(actor,prop),
  'can_edit',case when prop.owner_agent_id is null then actor.role='admin' else actor.role='agent' and prop.owner_agent_id=actor.id end);
end $$;
-- p_scope: company, agent (one agent: p_owner), agents (all agents), all
-- (every record) or unique (every listing once: a copy in Admin Properties
-- whose agent original still exists is the same listing and is left out).
create or replace function public.inventory_counts(p_scope text,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('total',count(*),'available',count(*) filter(where p.availability='available'),
  'reserved',count(*) filter(where p.availability='reserved'),'sold',count(*) filter(where p.availability='sold'),
  'rented',count(*) filter(where p.availability='rented'),'inactive',count(*) filter(where p.availability='archived'),
  'last_updated',max(p.updated_at))
 from public.properties p
 where case p_scope when 'company' then p.owner_agent_id is null when 'agent' then p.owner_agent_id=p_owner
  when 'agents' then p.owner_agent_id is not null
  when 'unique' then not exists(select 1 from public.property_promotions pp where pp.copy_id=p.id and pp.source_id is not null)
  else true end
$$;
create or replace function public.inventory_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role='agent' then
  return jsonb_build_object('role','agent','mine',public.inventory_counts('agent',actor.id),'company',public.inventory_counts('company',null));
 end if;
 return jsonb_build_object('role','admin','company',public.inventory_counts('company',null),
  'agents',public.inventory_counts('agents',null),'all',public.inventory_counts('all',null),
  'unique',public.inventory_counts('unique',null),
  'promoted',(select count(*) from public.property_promotions where copy_id is not null),
  'agents_with_properties',(select count(distinct owner_agent_id) from public.properties where owner_agent_id is not null));
end $$;

-- --------------------------------------------------------------- writes
-- As in 041. When an agent changes a listing that has a copy in Admin
-- Properties, administrators are told what changed; a save that changes
-- nothing tells nobody.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;before public.properties;
 fields jsonb;contact jsonb;plot boolean;old_contact jsonb;changes text[];
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities',
  'owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 fields=p_data-array['owner_contact','expected_updated_at'];
 if p_property is null then
  merged=jsonb_populate_record(null::public.properties,
   jsonb_build_object('description','','availability','available','price_negotiable',false,'amenities','[]'::jsonb)||fields);
 else
  prop=public.inventory_property_for(actor,p_property,true);
  if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from prop.updated_at then
   raise exception 'Someone else changed this property. Close it, open it again and repeat your change.' using errcode='HA409';end if;
  merged=jsonb_populate_record(prop,fields);
  before=prop;
  select to_jsonb(c)-array['property_id','updated_at'] into old_contact from public.property_owner_contacts c where c.property_id=prop.id;
 end if;
 if (merged.availability='sold' and merged.purpose='rent') or (merged.availability='rented' and merged.purpose='sale') then
  raise exception 'Use Sold for sale listings and Rented for rent listings' using errcode='HA400';end if;
 -- Plots and land have no rooms, furnishing, construction or age.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
   furnishing,construction_status,property_age,amenities,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
   case when not plot then merged.construction_status end,case when not plot then merged.property_age end,merged.amenities,
   case when actor.role='agent' then actor.id end,actor.id,actor.id)
  returning * into prop;
 else
  update public.properties set title=merged.title,description=merged.description,location=merged.location,price=merged.price,
   type=merged.type,area=merged.area,area_unit=merged.area_unit,availability=merged.availability,purpose=merged.purpose,
   province=merged.province,city=merged.city,area_society=merged.area_society,block_sector=merged.block_sector,street=merged.street,
   plot_number=merged.plot_number,address=merged.address,map_url=merged.map_url,price_negotiable=merged.price_negotiable,
   price_notes=merged.price_notes,bedrooms=case when not plot then merged.bedrooms end,bathrooms=case when not plot then merged.bathrooms end,
   kitchens=case when not plot then merged.kitchens end,floors=case when not plot then merged.floors end,
   parking_spaces=case when not plot then merged.parking_spaces end,furnishing=case when not plot then merged.furnishing end,
   construction_status=case when not plot then merged.construction_status end,property_age=case when not plot then merged.property_age end,
   amenities=merged.amenities,updated_by=actor.id
  where id=prop.id returning * into prop;
 end if;
 if p_data?'owner_contact' then
  contact=p_data->'owner_contact';
  if jsonb_typeof(contact) not in ('object','null') or (jsonb_typeof(contact)='object'
   and (contact-array['owner_name','owner_phone','owner_alt_phone','owner_notes','share_with_agents'])<>'{}'::jsonb) then
   raise exception 'Unsupported owner contact details' using errcode='HA400';end if;
  if jsonb_typeof(contact)='null' or not exists(select 1 from jsonb_each_text(contact) e
   where e.key<>'share_with_agents' and nullif(btrim(e.value),'') is not null) then
   delete from public.property_owner_contacts where property_id=prop.id;
  else
   insert into public.property_owner_contacts as c(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
   values(prop.id,nullif(btrim(contact->>'owner_name'),''),nullif(btrim(contact->>'owner_phone'),''),
    nullif(btrim(contact->>'owner_alt_phone'),''),nullif(btrim(contact->>'owner_notes'),''),
    prop.owner_agent_id is null and coalesce((contact->>'share_with_agents')::boolean,false))
   on conflict(property_id) do update set owner_name=excluded.owner_name,owner_phone=excluded.owner_phone,
    owner_alt_phone=excluded.owner_alt_phone,owner_notes=excluded.owner_notes,share_with_agents=excluded.share_with_agents,updated_at=now();
  end if;
 end if;
 -- Field names only: never prices, addresses or owner contact values.
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case when p_property is null then 'create' else 'update' end,'properties',prop.id::text,p_request,
  jsonb_build_object('fields',to_jsonb(array(select k from jsonb_object_keys(p_data-'expected_updated_at') k order by k)),
   'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end));
 if p_property is not null and actor.role='agent'
  and exists(select 1 from public.property_promotions where source_id=prop.id and copy_id is not null) then
  changes=array(select k from unnest(array['title','description','type','purpose','availability','price','price_negotiable','price_notes',
   'area','area_unit','province','city','area_society','block_sector','street','plot_number','address','map_url','bedrooms','bathrooms',
   'kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities']) k
   where to_jsonb(before)->k is distinct from to_jsonb(prop)->k);
  if old_contact is distinct from (select to_jsonb(c)-array['property_id','updated_at'] from public.property_owner_contacts c where c.property_id=prop.id) then
   changes=changes||'owner_contact'::text;end if;
  if cardinality(changes)>0 then
   perform public.notify_promotion_source(actor,prop,'details',public.promotion_change_text(before,prop,changes));end if;
 end if;
 return public.inventory_property(p_actor,prop.id);
end $$;

-- As in 041. Deleting an agent listing that has a copy in Admin Properties
-- keeps the copy and tells administrators; deleting a copy keeps the
-- agent's listing. Either way the link keeps both reference numbers.
create or replace function public.delete_property(p_property uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prop public.properties;photo_count integer;kept bigint;
begin
 select * into actor from public.profiles where id=p_actor for share;
 if not found or not actor.active or actor.deleted_at is not null or actor.role not in ('admin','agent') then
  raise exception 'Your account is not active' using errcode='42501';
 end if;
 -- This lock also prevents concurrent new foreign-key references or photos
 -- from being attached between the checks and deletion.
 select * into prop from public.properties where id=p_property for update;
 if not found or (actor.role='agent' and prop.owner_agent_id<>actor.id) then
  raise exception 'Property not found' using errcode='P0002';end if;
 if prop.owner_agent_id is null and actor.role<>'admin' then
  raise exception 'The company inventory is read-only for agents' using errcode='42501';end if;
 if prop.owner_agent_id is not null and actor.role<>'agent' then
  raise exception 'Agent inventories are read-only for administrators' using errcode='42501';end if;
 if exists(select 1 from public.leads where property_id=p_property)
  or exists(select 1 from public.visits where property_id=p_property)
  or exists(select 1 from public.deals where property_id=p_property) then
  raise exception 'Property has linked CRM records' using errcode='23503';
 end if;
 if prop.owner_agent_id is not null then
  select copy_property_no into kept from public.property_promotions where source_id=prop.id and copy_id is not null;
  if kept is not null then perform public.notify_promotion_source(actor,prop,'removed',null);end if;
  update public.property_promotions set source_deleted_at=now() where source_id=prop.id;
 else
  update public.property_promotions set copy_deleted_at=now() where copy_id=prop.id;
 end if;
 insert into public.property_photo_cleanup(property_id,storage_path)
  select property_id,storage_path from public.property_photos where property_id=p_property;
 get diagnostics photo_count = row_count;
 delete from public.property_photos where property_id=p_property;
 -- Owner contact details are removed with the property (on delete cascade);
 -- the promotion link keeps its reference numbers (on delete set null).
 delete from public.properties where id=p_property;
 insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
  values(p_actor,'delete','properties',p_property::text,jsonb_build_object('photo_count',photo_count)
   ||case when kept is not null then jsonb_build_object('admin_copy_property_no',kept) else '{}'::jsonb end,p_request);
end $$;

-- --------------------------------------------------------------- photos
-- As in 041, and administrators hear when an agent changes the pictures of
-- a listing that has a copy in Admin Properties.
create or replace function public.inventory_photo_add(p_actor uuid,p_property uuid,p_path text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);photo uuid;
begin
 if p_path is null or p_path !~ ('^'||prop.id::text||'/[0-9a-f-]{36}$') then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 if (select count(*) from public.property_photos where property_id=prop.id)>=20 then
  raise exception 'A property can have up to 20 pictures' using errcode='HA409';end if;
 insert into public.property_photos(property_id,storage_path,position)
  values(prop.id,p_path,coalesce((select max(position)+1 from public.property_photos where property_id=prop.id),0))
  returning id into photo;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'upload_photo','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','added a picture to');end if;
 return jsonb_build_object('id',photo);
end $$;
-- The file is queued for Storage removal in the same transaction (013 queue).
create or replace function public.inventory_photo_remove(p_actor uuid,p_property uuid,p_photo uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);removed text;
begin
 delete from public.property_photos where id=p_photo and property_id=prop.id returning storage_path into removed;
 if removed is null then raise exception 'Picture not found' using errcode='HA404';end if;
 insert into public.property_photo_cleanup(property_id,storage_path) values(prop.id,removed) on conflict(storage_path) do nothing;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'delete_photo','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','removed a picture from');end if;
end $$;
-- p_photos lists every picture of the property once, cover first.
create or replace function public.inventory_photo_order(p_actor uuid,p_property uuid,p_photos uuid[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
begin
 if p_photos is null or cardinality(p_photos)<>(select count(*) from public.property_photos where property_id=prop.id)
  or cardinality(p_photos)<>(select count(distinct x) from unnest(p_photos) x)
  or exists(select 1 from unnest(p_photos) x where not exists(select 1 from public.property_photos f where f.id=x and f.property_id=prop.id)) then
  raise exception 'The pictures changed. Close the property, open it again and retry.' using errcode='HA409';end if;
 update public.property_photos f set position=o.n-1 from unnest(p_photos) with ordinality o(id,n) where f.id=o.id and f.property_id=prop.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'reorder_photos','properties',prop.id::text,p_request,'{}'::jsonb);
 if actor.role='agent' then perform public.notify_promotion_source(actor,prop,'photos','reordered the pictures of');end if;
 return public.inventory_photos(p_actor,p_property);
end $$;

-- ------------------------------------------------------------ promotion
-- Adding an agent listing to Admin Properties takes three calls from the
-- API, so pictures can be copied in Storage between them:
-- 1. inventory_promote_prepare checks the request and reserves a new path
--    for each picture under the new property's id (p_copy, chosen by the
--    API). Reservations are queued for removal in an hour.
-- 2. The API copies each picture to its new path.
-- 3. inventory_promote creates the copy in one transaction and keeps the
--    reserved pictures that were copied; or, if anything failed,
--    inventory_promote_release makes the reservations due at once.
create or replace function public.inventory_promote_prepare(p_actor uuid,p_property uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;photos jsonb;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,false);
 if p_copy is null or exists(select 1 from public.properties where id=p_copy)
  or exists(select 1 from public.property_photo_cleanup where property_id=p_copy) then
  raise exception 'Invalid request' using errcode='HA400';end if;
 select coalesce(jsonb_agg(jsonb_build_object('from',x.storage_path,'to',p_copy::text||'/'||gen_random_uuid()::text)
   order by x.position,x.created_at,x.id),'[]'::jsonb) into photos
 from public.property_photos x where x.property_id=prop.id;
 insert into public.property_photo_cleanup(property_id,storage_path,not_before)
  select p_copy,e->>'to',now()+interval '1 hour' from jsonb_array_elements(photos) e;
 return jsonb_build_object('photos',photos);
end $$;
-- p_paths: the reserved pictures that were copied, in the original's order.
create or replace function public.inventory_promote(p_actor uuid,p_property uuid,p_copy uuid,p_paths text[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;made public.properties;agent public.profiles;
 planned integer;kept integer;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,true);
 p_paths=coalesce(p_paths,'{}'::text[]);
 if p_copy is null or cardinality(p_paths)>20 or cardinality(p_paths)<>(select count(distinct x) from unnest(p_paths) x)
  or exists(select 1 from unnest(p_paths) x where x is null or x !~ ('^'||p_copy::text||'/[0-9a-f-]{36}$')) then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 select count(*) into planned from public.property_photo_cleanup where property_id=p_copy and not_before>now();
 -- Every copied picture must still be reserved. A reservation that was
 -- released or already processed may mean its file is gone.
 delete from public.property_photo_cleanup where property_id=p_copy and storage_path=any(p_paths) and not_before>now();
 get diagnostics kept=row_count;
 if kept<>cardinality(p_paths) then
  raise exception 'The pictures changed while they were being copied. Please try again.' using errcode='HA409';end if;
 -- Pictures that could not be copied were never written; let the queue
 -- clear their reservations.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy;
 select * into agent from public.profiles where id=prop.owner_agent_id;
 insert into public.properties(id,title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
  block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
  furnishing,construction_status,property_age,amenities,owner_agent_id,created_by,updated_by)
 values(p_copy,prop.title,prop.description,prop.location,prop.price,prop.type,prop.area,prop.area_unit,prop.availability,prop.purpose,
  prop.province,prop.city,prop.area_society,prop.block_sector,prop.street,prop.plot_number,prop.address,prop.map_url,prop.price_negotiable,
  prop.price_notes,prop.bedrooms,prop.bathrooms,prop.kitchens,prop.floors,prop.parking_spaces,prop.furnishing,prop.construction_status,
  prop.property_age,prop.amenities,null,actor.id,actor.id)
 returning * into made;
 -- The seller's contact is kept for administrators only, as on the
 -- agent's listing; it is not shared with agents unless an administrator
 -- later chooses to.
 insert into public.property_owner_contacts(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
  select made.id,c.owner_name,c.owner_phone,c.owner_alt_phone,c.owner_notes,false from public.property_owner_contacts c where c.property_id=prop.id;
 insert into public.property_photos(property_id,storage_path,position)
  select made.id,u.x,(u.n-1)::integer from unnest(p_paths) with ordinality u(x,n);
 insert into public.property_promotions(source_id,copy_id,source_property_no,copy_property_no,source_agent_id,source_agent_uid,source_agent_name,promoted_by)
  values(prop.id,made.id,prop.property_no,made.property_no,agent.id,agent.uid,left(coalesce(nullif(btrim(agent.name),''),'Agent'),200),actor.id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'promote','properties',made.id::text,p_request,jsonb_build_object('agent_id',agent.id,'source_id',prop.id,
   'source_property_no',prop.property_no,'copy_property_no',made.property_no,'photo_count',kept,'photos_missing',greatest(planned-kept,0)));
 return public.inventory_property(p_actor,made.id);
end $$;
-- After a failed promotion: if the copy was not created, its reservations
-- become due so the clean-up removes any copied pictures.
create or replace function public.inventory_promote_release(p_actor uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 -- Release first: this waits for a promotion still saving, so the check
 -- below then sees whether it finished.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy and not_before>now();
 return jsonb_build_object('committed',exists(select 1 from public.properties where id=p_copy));
end $$;

-- ---------------------------------------------------------------- grants
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('inventory_promotion','promotion_source','promotion_change_text','notify_promotion_source',
  'inventory_page','inventory_property','inventory_counts','inventory_summary','inventory_save','delete_property','inventory_photo_add',
  'inventory_photo_remove','inventory_photo_order','inventory_promote_prepare','inventory_promote','inventory_promote_release') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  -- Helpers run only inside these functions.
  if f.proname not in ('inventory_promotion','promotion_source','promotion_change_text','notify_promotion_source','inventory_counts') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
