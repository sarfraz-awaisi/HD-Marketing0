-- Apply after 040. Safe to rerun. Property inventory (update 041).
-- Every agent keeps a private inventory. Administrators keep the company
-- inventory: every agent can read it and none can change it. Administrators
-- can read every agent's inventory but cannot change it. Existing properties
-- become company inventory unchanged; no property, photo, lead, visit or deal
-- is deleted, moved or re-linked by this update.
-- The browser still has no table grants (009). These functions run for the
-- API's service role and check the signed-in actor (p_actor) themselves, so
-- ownership never comes from the request body.
-- Errors raised here use SQLSTATE HA<http status> (HA400, HA403, HA404,
-- HA409) with messages that are safe to show to the signed-in user.
-- Runs as one transaction in a few seconds. Leads, visits and deals stay
-- readable throughout; properties and property photos are locked briefly.
-- If a lock is not available within 5 seconds (for example while a backup or
-- large export is running) everything rolls back unchanged: run it again later.
-- Check first with supabase/check-property-inventory.sql (read-only).
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.attendance_member(uuid)') is null or to_regclass('public.property_photo_cleanup') is null then
  raise exception 'Apply CRM updates 013 and 040 before inventory update 041.';
 end if;
 if current_setting('server_version_num')::integer<140000 then
  raise exception 'Update 041 needs PostgreSQL 14 or newer.';
 end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='deleted_at')
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='uid')
  or not exists(select 1 from pg_trigger where tgrelid='public.properties'::regclass and tgname='touch_updated') then
  raise exception 'Apply CRM updates 010, 028 and 036 before inventory update 041.';
 end if;
 -- Only the checks from 004 (and this update, on a rerun) are expected. Any
 -- other check on properties needs review before its rules are widened.
 if exists(select 1 from pg_constraint where conrelid='public.properties'::regclass and contype='c'
  and conname not in ('properties_price_check','properties_area_check','properties_area_unit_check','properties_availability_check',
   'properties_purpose_status','properties_location_fields','properties_detail_fields')) then
  raise exception 'The properties table has unexpected check constraints. Run supabase/check-property-inventory.sql and review before update 041.';
 end if;
end $$;

-- ------------------------------------------------------------ properties
-- owner_agent_id null = company inventory; otherwise the agent whose private
-- inventory holds the property. Ownership never changes after creation.
alter table public.properties
 add column if not exists owner_agent_id uuid references public.profiles(id),
 add column if not exists property_no bigint generated always as identity,
 add column if not exists purpose text not null default 'sale',
 add column if not exists country text not null default 'Pakistan',
 add column if not exists province text,
 add column if not exists city text,
 add column if not exists area_society text,
 add column if not exists block_sector text,
 add column if not exists street text,
 add column if not exists plot_number text,
 add column if not exists address text,
 add column if not exists map_url text,
 add column if not exists currency text not null default 'PKR',
 add column if not exists price_negotiable boolean not null default false,
 add column if not exists price_notes text,
 add column if not exists bedrooms smallint,
 add column if not exists bathrooms smallint,
 add column if not exists kitchens smallint,
 add column if not exists floors smallint,
 add column if not exists parking_spaces smallint,
 add column if not exists furnishing text,
 add column if not exists construction_status text,
 add column if not exists property_age smallint,
 add column if not exists amenities text[] not null default '{}',
 add column if not exists created_by uuid references public.profiles(id),
 add column if not exists updated_by uuid references public.profiles(id);
-- Derived from the type so the two can never disagree. Older free-text types
-- (for example 'Plot') keep working and count as 'other'.
alter table public.properties add column if not exists category text generated always as (
 case when type in ('House','Apartment','Residential Plot','Portion','Farmhouse') then 'residential'
  when type in ('Shop','Office','Commercial Plot','Warehouse','Building','Commercial') then 'commercial'
  else 'other' end) stored;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='properties_property_no_key') then
  alter table public.properties add constraint properties_property_no_key unique(property_no);
 end if;
end $$;
-- Widened from 004: rentals and more Pakistani size units. 'archived' is
-- shown as Inactive. Areas are stored as entered and never converted.
alter table public.properties drop constraint if exists properties_availability_check;
alter table public.properties add constraint properties_availability_check check(availability in ('available','reserved','sold','rented','archived'));
alter table public.properties drop constraint if exists properties_area_unit_check;
alter table public.properties add constraint properties_area_unit_check check(area_unit in ('sq ft','sq yd','marla','kanal','acre'));
alter table public.properties drop constraint if exists properties_purpose_status;
alter table public.properties add constraint properties_purpose_status check(purpose in ('sale','rent')
 and (availability<>'sold' or purpose='sale') and (availability<>'rented' or purpose='rent')
 -- Other countries and currencies are not supported yet.
 and country='Pakistan' and currency='PKR' and coalesce(length(price_notes),0)<=300);
alter table public.properties drop constraint if exists properties_location_fields;
alter table public.properties add constraint properties_location_fields check(
 (province is null or province in ('Punjab','Sindh','Khyber Pakhtunkhwa','Balochistan','Islamabad Capital Territory','Gilgit-Baltistan','Azad Jammu and Kashmir'))
 and (city is null or length(city) between 1 and 80)
 and coalesce(length(area_society),0)<=120 and coalesce(length(block_sector),0)<=60
 and coalesce(length(street),0)<=120 and coalesce(length(plot_number),0)<=40 and coalesce(length(address),0)<=300
 and (map_url is null or (length(map_url)<=500 and map_url ~ '^https://[^[:space:]]+$')));
alter table public.properties drop constraint if exists properties_detail_fields;
alter table public.properties add constraint properties_detail_fields check(
 (bedrooms is null or bedrooms between 0 and 50) and (bathrooms is null or bathrooms between 0 and 50)
 and (kitchens is null or kitchens between 0 and 20) and (floors is null or floors between 0 and 200)
 and (parking_spaces is null or parking_spaces between 0 and 100) and (property_age is null or property_age between 0 and 200)
 and (furnishing is null or furnishing in ('unfurnished','semi_furnished','furnished'))
 and (construction_status is null or construction_status in ('new','ready','needs_renovation','under_construction','grey_structure'))
 and cardinality(amenities)<=20
 and amenities<@array['electricity','gas','water','sewerage','internet','boundary_wall','security','corner','park_facing',
  'main_road','lift','backup_power','solar','servant_quarter','basement','lawn','drawing_room','store_room']::text[]);
create index if not exists properties_owner_created on public.properties(owner_agent_id,created_at desc,id);
create index if not exists properties_owner_status on public.properties(owner_agent_id,availability,purpose);
create index if not exists properties_city on public.properties(lower(city));

-- Ownership and creator are fixed; only agents keep a private inventory.
create or replace function public.guard_property_owner() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.owner_agent_id is distinct from old.owner_agent_id or new.created_by is distinct from old.created_by) then
  raise exception 'Property ownership cannot be changed' using errcode='HA403';
 end if;
 if tg_op='INSERT' and new.owner_agent_id is not null
  and not exists(select 1 from public.profiles where id=new.owner_agent_id and role='agent') then
  raise exception 'Only agents keep a private inventory' using errcode='HA400';
 end if;
 return new;
end $$;
create or replace trigger guard_property_owner before insert or update on public.properties for each row execute function public.guard_property_owner();

-- Leads, visits and deals link only company inventory. A private property
-- linked to a lead would show its title to whoever owns the lead next.
create or replace function public.guard_property_link() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.property_id is not null and exists(select 1 from public.properties p where p.id=new.property_id and p.owner_agent_id is not null) then
  raise exception 'Only company inventory can be linked to leads, visits or deals' using errcode='22023';
 end if;
 return new;
end $$;
-- create or replace (not drop + create) blocks only writes, never reads.
do $$ declare t text; begin
 foreach t in array array['leads','visits','deals'] loop
  execute format('create or replace trigger guard_property_link before insert or update of property_id on public.%I for each row execute function public.guard_property_link()',t);
 end loop;
end $$;

-- ------------------------------------------------------- owner contacts
-- Kept apart from properties so no property listing can include them.
-- Shared with agents only for company properties an administrator marks.
create table if not exists public.property_owner_contacts(
 property_id uuid primary key references public.properties(id) on delete cascade,
 owner_name text check(length(owner_name) between 1 and 120),
 owner_phone text check(owner_phone ~ '^\+[0-9]{10,15}$'),
 owner_alt_phone text check(owner_alt_phone ~ '^\+[0-9]{10,15}$'),
 owner_notes text check(length(owner_notes) between 1 and 1000),
 share_with_agents boolean not null default false,
 updated_at timestamptz not null default now()
);
alter table public.property_owner_contacts enable row level security;
revoke all on public.property_owner_contacts from public,anon,authenticated;
grant all on public.property_owner_contacts to service_role;

-- --------------------------------------------------------------- photos
-- The first picture by position is the cover.
alter table public.property_photos add column if not exists position integer not null default 0;
create index if not exists property_photos_order on public.property_photos(property_id,position,created_at,id);

-- ------------------------------------------------------- shared helpers
create or replace function public.inventory_member(p_actor uuid) returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent') for share;
 if not found then raise exception 'Your account is not active' using errcode='HA403';end if;
 return actor;
end $$;
-- Agents read the company inventory and their own; administrators read all.
-- Administrators change only the company inventory; agents only their own.
-- Another agent's property is reported as missing, never as forbidden.
create or replace function public.inventory_property_for(p_actor public.profiles,p_property uuid,p_write boolean) returns public.properties language plpgsql security definer set search_path='' as $$
declare prop public.properties;
begin
 if p_write then select * into prop from public.properties where id=p_property for update;
 else select * into prop from public.properties where id=p_property;end if;
 if not found or (p_actor.role='agent' and prop.owner_agent_id<>p_actor.id) then
  raise exception 'Property not found' using errcode='HA404';end if;
 if p_write and prop.owner_agent_id is null and p_actor.role<>'admin' then
  raise exception 'The company inventory is read-only for agents' using errcode='HA403';end if;
 if p_write and prop.owner_agent_id is not null and (p_actor.role<>'agent' or prop.owner_agent_id<>p_actor.id) then
  raise exception 'Agent inventories are read-only for administrators' using errcode='HA403';end if;
 return prop;
end $$;
create or replace function public.inventory_json(p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p_property)||jsonb_build_object(
  'ownership',case when p_property.owner_agent_id is null then 'company' else 'agent' end,
  'owner_agent_name',(select name from public.profiles where id=p_property.owner_agent_id),
  'created_by_name',(select name from public.profiles where id=p_property.created_by),
  'updated_by_name',(select name from public.profiles where id=p_property.updated_by))
$$;
-- Administrators and the owning agent see everything; agents see the name and
-- numbers of a company property only when an administrator shared them.
create or replace function public.inventory_contact(p_actor public.profiles,p_property public.properties) returns jsonb language sql stable security definer set search_path='' as $$
 select case
  when p_actor.role='admin' or p_property.owner_agent_id=p_actor.id then to_jsonb(c)-'property_id'
  when p_property.owner_agent_id is null and c.share_with_agents then
   jsonb_build_object('owner_name',c.owner_name,'owner_phone',c.owner_phone,'owner_alt_phone',c.owner_alt_phone,'share_with_agents',true)
  end
 from public.property_owner_contacts c where c.property_id=p_property.id
$$;
-- One inventory, filtered. Callers have already checked the scope and owner.
create or replace function public.inventory_rows(p_scope text,p_owner uuid,p_filters jsonb,p_number bigint) returns setof public.properties language sql stable set search_path='' as $$
 select p.* from public.properties p
 where (case when p_scope='company' then p.owner_agent_id is null else p.owner_agent_id=p_owner end)
  and (nullif(btrim(p_filters->>'search'),'') is null or p.property_no=p_number
   or position(lower(btrim(p_filters->>'search')) in lower(concat_ws(' ',p.title,p.location,p.city,p.area_society,p.block_sector,p.type)))>0)
  and (p_filters->>'type' is null or p.type=p_filters->>'type')
  and (p_filters->>'purpose' is null or p.purpose=p_filters->>'purpose')
  and (p_filters->>'status' is null or p.availability=p_filters->>'status')
  and (nullif(btrim(p_filters->>'city'),'') is null
   or position(lower(btrim(p_filters->>'city')) in lower(concat_ws(' ',p.city,p.area_society,p.location)))>0)
  and (p_filters->>'min_price' is null or p.price>=(p_filters->>'min_price')::numeric)
  and (p_filters->>'max_price' is null or p.price<=(p_filters->>'max_price')::numeric)
$$;
-- p_scope: company, agent (one agent: p_owner), agents (all agents), all.
create or replace function public.inventory_counts(p_scope text,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('total',count(*),'available',count(*) filter(where availability='available'),
  'reserved',count(*) filter(where availability='reserved'),'sold',count(*) filter(where availability='sold'),
  'rented',count(*) filter(where availability='rented'),'inactive',count(*) filter(where availability='archived'),
  'last_updated',max(updated_at))
 from public.properties
 where case p_scope when 'company' then owner_agent_id is null when 'agent' then owner_agent_id=p_owner
  when 'agents' then owner_agent_id is not null else true end
$$;
-- Current agents, plus any account (deleted, disabled or promoted to admin)
-- that still has a private inventory, so no inventory is ever hidden.
create or replace function public.inventory_agent_rows() returns table(id uuid,uid integer,name text,email text,role text,status text) language sql stable set search_path='' as $$
 select p.id,p.uid,p.name,(select to_jsonb(u)->>'email' from auth.users u where u.id=p.id),p.role,
  case when p.deleted_at is not null then 'deleted' when p.active then 'active' else 'inactive' end
 from public.profiles p
 where (p.role='agent' and p.deleted_at is null) or exists(select 1 from public.properties x where x.owner_agent_id=p.id)
$$;

-- ---------------------------------------------------------------- reads
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
 select coalesce(jsonb_agg(public.inventory_json(p.prop)||jsonb_build_object('photo_count',coalesce(ph.n,0),
   'cover_photo_id',ph.id,'cover_path',ph.storage_path)
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
 return public.inventory_json(prop)||jsonb_build_object('owner_contact',public.inventory_contact(actor,prop),
  'can_edit',case when prop.owner_agent_id is null then actor.role='admin' else actor.role='agent' and prop.owner_agent_id=actor.id end);
end $$;
create or replace function public.inventory_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role='agent' then
  return jsonb_build_object('role','agent','mine',public.inventory_counts('agent',actor.id),'company',public.inventory_counts('company',null));
 end if;
 return jsonb_build_object('role','admin','company',public.inventory_counts('company',null),
  'agents',public.inventory_counts('agents',null),'all',public.inventory_counts('all',null),
  'agents_with_properties',(select count(distinct owner_agent_id) from public.properties where owner_agent_id is not null));
end $$;
create or replace function public.inventory_agents(p_actor uuid,p_search text,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);term text=lower(nullif(btrim(p_search),''));total bigint;items jsonb;
begin
 if actor.role<>'admin' then raise exception 'Administrator access required' using errcode='HA403';end if;
 if p_page is null or p_page<1 or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'Choose a valid page' using errcode='HA400';end if;
 select count(*) into total from public.inventory_agent_rows() a
  where term is null or position(term in lower(concat_ws(' ',a.name,a.email,a.uid)))>0;
 select coalesce(jsonb_agg(to_jsonb(a)||public.inventory_counts('agent',a.id) order by a.name,a.id),'[]'::jsonb) into items
 from (select * from public.inventory_agent_rows() a
  where term is null or position(term in lower(concat_ws(' ',a.name,a.email,a.uid)))>0
  order by a.name,a.id limit p_limit offset (p_page-1)*p_limit) a;
 return jsonb_build_object('data',items,'count',total,'page',p_page,'limit',p_limit);
end $$;

-- --------------------------------------------------------------- writes
-- p_property null creates. The owner is the signed-in agent, or the company
-- for an administrator. Updates change only the fields sent; a sent
-- expected_updated_at refuses to overwrite someone else's newer save.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;
 fields jsonb;contact jsonb;plot boolean;
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
 return public.inventory_property(p_actor,prop.id);
end $$;

-- Replaces the administrator-only version from 013 with the same checks for
-- linked records, the photo cleanup queue and the audit entry: administrators
-- delete company properties, agents delete their own.
create or replace function public.delete_property(p_property uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prop public.properties;photo_count integer;
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
 insert into public.property_photo_cleanup(property_id,storage_path)
  select property_id,storage_path from public.property_photos where property_id=p_property;
 get diagnostics photo_count = row_count;
 delete from public.property_photos where property_id=p_property;
 -- Owner contact details are removed with the property (on delete cascade).
 delete from public.properties where id=p_property;
 insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
  values(p_actor,'delete','properties',p_property::text,jsonb_build_object('photo_count',photo_count),p_request);
end $$;

-- --------------------------------------------------------------- photos
-- Checked before a file is uploaded to Storage; inventory_photo_add rechecks.
create or replace function public.inventory_access(p_actor uuid,p_property uuid,p_write boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,p_write);
begin
 return jsonb_build_object('id',prop.id,'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end,
  'photo_count',(select count(*) from public.property_photos where property_id=prop.id));
end $$;
create or replace function public.inventory_photos(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'storage_path',x.storage_path) order by x.position,x.created_at,x.id),'[]'::jsonb)
  from public.property_photos x where x.property_id=prop.id);
end $$;
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
 return public.inventory_photos(p_actor,p_property);
end $$;

-- ---------------------------------------------------------------- grants
-- Supabase's default privileges grant new sequences to browser roles.
do $$ begin
 execute format('revoke all on sequence %s from public,anon,authenticated',pg_get_serial_sequence('public.properties','property_no'));
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('guard_property_owner','guard_property_link','inventory_member','inventory_property_for',
  'inventory_json','inventory_contact','inventory_rows','inventory_counts','inventory_agent_rows','inventory_page','inventory_property',
  'inventory_summary','inventory_agents','inventory_save','delete_property','inventory_access','inventory_photos','inventory_photo_add',
  'inventory_photo_remove','inventory_photo_order') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  -- Helpers and triggers run only inside these functions.
  if f.proname in ('inventory_page','inventory_property','inventory_summary','inventory_agents','inventory_save','delete_property',
   'inventory_access','inventory_photos','inventory_photo_add','inventory_photo_remove','inventory_photo_order') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
