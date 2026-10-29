-- Apply after 045. Safe to rerun. Building categories (update 046).
-- A property or building can offer several kinds of units or spaces at
-- once: residential and hotel apartments with 1, 2 or 3 bedrooms, commercial
-- outlets and workspaces. properties.building_categories keeps every kind
-- ticked, in one standard order, each once; older properties have none.
-- The categories describe what the building offers; bedrooms still describes
-- the listed unit. Like the other building details, plots and land have none.
-- * The column's type (a domain) accepts only the listed categories, in the
--   standard order, without repeats. The check sits on the type rather than
--   the table, so updates 041 and 044 can still be applied again.
-- * Saves (inventory_save) accept, check and order the selection, and record
--   in the audit which fields actually changed and the categories before and
--   after. Administrators are told about category changes on a promoted
--   agent listing, as for its other details.
-- * Adding a listing to Admin Properties (inventory_promote) copies its
--   categories; afterwards the two records change independently.
-- Existing properties, owners, pictures, promotions and permissions are
-- unchanged. If 041 or 044 is ever applied again, apply this update after it.
-- Runs as one transaction in a few seconds. properties is rewritten once to
-- add the column (it is small) and is locked meanwhile; if a lock is not
-- available within 5 seconds everything rolls back unchanged: run it again.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.inventory_promote(uuid,uuid,uuid,text[],text)') is null
  or to_regprocedure('public.promotion_change_text(public.properties,public.properties,text[])') is null
  or to_regclass('public.task_daily_reports') is null then
  raise exception 'Apply CRM updates up to 045 before update 046.';
 end if;
end $$;

-- ------------------------------------------------------------ categories
-- Identifiers, order and labels match the API (server/src/utils/validators.js)
-- and the screens (client/src/lib/inventory.js); a test keeps them equal.
create or replace function public.property_category_list() returns text[] language sql immutable parallel safe set search_path='' as $$
 select array['residential_1_bed','residential_2_bed','residential_3_bed','hotel_apartment_1_bed','hotel_apartment_2_bed',
  'hotel_apartment_3_bed','commercial_outlet','workspace']::text[]
$$;
-- The listed categories in p, in the standard order, each once.
create or replace function public.property_categories_sorted(p text[]) returns text[] language sql immutable parallel safe set search_path='' as $$
 select array(select c from unnest(public.property_category_list()) with ordinality a(c,n) where c=any(p) order by n)
$$;
create or replace function public.property_category_label(p text) returns text language sql immutable parallel safe set search_path='' as $$
 select case p when 'residential_1_bed' then 'Residential — 1 Bedroom' when 'residential_2_bed' then 'Residential — 2 Bedrooms'
  when 'residential_3_bed' then 'Residential — 3 Bedrooms' when 'hotel_apartment_1_bed' then 'Hotel Apartments — 1 Bedroom'
  when 'hotel_apartment_2_bed' then 'Hotel Apartments — 2 Bedrooms' when 'hotel_apartment_3_bed' then 'Hotel Apartments — 3 Bedrooms'
  when 'commercial_outlet' then 'Commercial Outlets / Retail Shops' when 'workspace' then 'Office Spaces / Workspaces' end
$$;
-- A list equal to its own standard ordering has only listed categories and
-- no repeats. Not null is on the column, so older save functions that do not
-- name it still get the empty default.
do $$ begin
 if to_regtype('public.property_building_categories') is null then
  create domain public.property_building_categories as text[] check(value=public.property_categories_sorted(value));
 end if;
end $$;
alter table public.properties add column if not exists building_categories public.property_building_categories not null default '{}';

-- ---------------------------------------------------------- notifications
-- As in 044, plus building categories: what was added and removed.
create or replace function public.promotion_change_text(p_old public.properties,p_new public.properties,p_keys text[]) returns text language sql stable set search_path='' as $$
 with labels(k,label,n) as (values ('title','Title',1),('price','Price',2),('availability','Status',3),('purpose','Purpose',4),
   ('size','Size',5),('type','Property type',6),('description','Description',7),('price_negotiable','Negotiable price',8),
   ('price_notes','Price notes',9),('province','Province',10),('city','City',11),('area_society','Area or society',12),
   ('block_sector','Block or sector',13),('street','Street',14),('plot_number','Plot or house number',15),('address','Full address',16),
   ('map_url','Map location',17),('bedrooms','Bedrooms',18),('bathrooms','Bathrooms',19),('kitchens','Kitchens',20),('floors','Floors',21),
   ('parking_spaces','Parking spaces',22),('furnishing','Furnishing',23),('construction_status','Construction',24),
   ('property_age','Property age',25),('building_categories','Building categories',26),('amenities','Utilities and features',27),
   ('owner_contact','Owner contact',28)),
  status(v,l) as (values ('available','Available'),('reserved','Reserved'),('sold','Sold'),('rented','Rented'),('archived','Inactive')),
  keys as (select case when k in ('area','area_unit') then 'size' else k end k from unnest(p_keys) k),
  cats as (select c,n,c=any(p_old.building_categories) was,c=any(p_new.building_categories) now
   from unnest(public.property_category_list()) with ordinality a(c,n)),
  cat_change as (select (select count(*) from cats where now and not was) added,(select count(*) from cats where was and not now) removed,
   concat_ws('; ','added '||(select string_agg(public.property_category_label(c),', ' order by n) from cats where now and not was),
    'removed '||(select string_agg(public.property_category_label(c),', ' order by n) from cats where was and not now)) words),
  items as (select l.label,l.n,case l.k
    when 'price' then 'PKR '||to_char(p_old.price,'FM999,999,999,999,990')||' → PKR '||to_char(p_new.price,'FM999,999,999,999,990')
    when 'availability' then coalesce((select s.l from status s where s.v=p_old.availability),p_old.availability)
     ||' → '||coalesce((select s.l from status s where s.v=p_new.availability),p_new.availability)
    when 'purpose' then case p_old.purpose when 'rent' then 'For rent' else 'For sale' end||' → '||case p_new.purpose when 'rent' then 'For rent' else 'For sale' end
    when 'title' then '“'||left(p_old.title,60)||'” → “'||left(p_new.title,60)||'”'
    when 'size' then trim_scale(p_old.area)::text||' '||p_old.area_unit||' → '||trim_scale(p_new.area)::text||' '||p_new.area_unit
    -- Short enough to leave room for the rest of the notice (500 characters).
    when 'building_categories' then (select case when length(words)<=220 then words
     else concat_ws(', ','added '||nullif(added,0),'removed '||nullif(removed,0)) end from cat_change) end detail
   from labels l where l.k in (select k from keys))
 select concat_ws(' ',(select string_agg(label||': '||detail||'.',' ' order by n) from items where detail is not null),
  (select case when exists(select 1 from items where detail is not null) then 'Also changed: ' else 'Changed: ' end
    ||string_agg(label,', ' order by n)||'.' from items where detail is null having count(*)>0))
$$;

-- --------------------------------------------------------------- writes
-- As in 044, plus building categories: checked, put in the standard order
-- and cleared for plots and land like the other building details. The audit
-- also records which fields actually changed (names only) and, when they
-- changed, the categories before and after.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;before public.properties;
 fields jsonb;contact jsonb;plot boolean;old_contact jsonb;changes text[];cats_before text[];meta jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','parking_spaces','furnishing','construction_status','property_age','amenities',
  'building_categories','owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 if p_data?'building_categories' then
  if jsonb_typeof(p_data->'building_categories') is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_data->'building_categories') e
   where jsonb_typeof(e)<>'string' or not (e#>>'{}')=any(public.property_category_list())) then
   raise exception 'Choose building categories from the list' using errcode='HA400';end if;
  if (select count(*)<>count(distinct e) from jsonb_array_elements(p_data->'building_categories') e) then
   raise exception 'Choose each building category once' using errcode='HA400';end if;
 end if;
 fields=p_data-array['owner_contact','expected_updated_at'];
 if fields?'building_categories' then
  fields=fields||jsonb_build_object('building_categories',to_jsonb(public.property_categories_sorted(
   array(select jsonb_array_elements_text(fields->'building_categories')))));
 end if;
 if p_property is null then
  merged=jsonb_populate_record(null::public.properties,
   jsonb_build_object('description','','availability','available','price_negotiable',false,'amenities','[]'::jsonb,
    'building_categories','[]'::jsonb)||fields);
  cats_before='{}';
 else
  prop=public.inventory_property_for(actor,p_property,true);
  if p_data?'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from prop.updated_at then
   raise exception 'Someone else changed this property. Close it, open it again and repeat your change.' using errcode='HA409';end if;
  merged=jsonb_populate_record(prop,fields);
  before=prop;cats_before=prop.building_categories;
  select to_jsonb(c)-array['property_id','updated_at'] into old_contact from public.property_owner_contacts c where c.property_id=prop.id;
 end if;
 if (merged.availability='sold' and merged.purpose='rent') or (merged.availability='rented' and merged.purpose='sale') then
  raise exception 'Use Sold for sale listings and Rented for rent listings' using errcode='HA400';end if;
 -- Plots and land have no rooms, furnishing, construction, age or building
 -- categories.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,parking_spaces,
   furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
   case when not plot then merged.construction_status end,case when not plot then merged.property_age end,merged.amenities,
   case when not plot then merged.building_categories else '{}' end,
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
   amenities=merged.amenities,building_categories=case when not plot then merged.building_categories else '{}' end,updated_by=actor.id
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
 -- What actually changed, by field name.
 if p_property is not null then
  changes=array(select k from unnest(array['title','description','type','purpose','availability','price','price_negotiable','price_notes',
   'area','area_unit','province','city','area_society','block_sector','street','plot_number','address','map_url','bedrooms','bathrooms',
   'kitchens','floors','parking_spaces','furnishing','construction_status','property_age','building_categories','amenities']) k
   where to_jsonb(before)->k is distinct from to_jsonb(prop)->k);
  if old_contact is distinct from (select to_jsonb(c)-array['property_id','updated_at'] from public.property_owner_contacts c where c.property_id=prop.id) then
   changes=changes||'owner_contact'::text;end if;
 end if;
 -- Field names only: never prices, addresses or owner contact values. The
 -- building categories are not private and are kept before and after.
 meta=jsonb_build_object('fields',to_jsonb(array(select k from jsonb_object_keys(p_data-'expected_updated_at') k order by k)),
  'ownership',case when prop.owner_agent_id is null then 'company' else 'agent' end)
  ||case when p_property is not null then jsonb_build_object('changed',to_jsonb(changes)) else '{}'::jsonb end
  ||case when prop.building_categories is distinct from cats_before then jsonb_build_object('building_categories',
   jsonb_build_object('before',to_jsonb(cats_before),'after',to_jsonb(prop.building_categories))) else '{}'::jsonb end;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
 values(actor.id,case when p_property is null then 'create' else 'update' end,'properties',prop.id::text,p_request,meta);
 if p_property is not null and actor.role='agent' and cardinality(changes)>0
  and exists(select 1 from public.property_promotions where source_id=prop.id and copy_id is not null) then
  perform public.notify_promotion_source(actor,prop,'details',public.promotion_change_text(before,prop,changes));
 end if;
 return public.inventory_property(p_actor,prop.id);
end $$;

-- ------------------------------------------------------------ promotion
-- As in 044, and the copy starts with the original's building categories.
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
  furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
 values(p_copy,prop.title,prop.description,prop.location,prop.price,prop.type,prop.area,prop.area_unit,prop.availability,prop.purpose,
  prop.province,prop.city,prop.area_society,prop.block_sector,prop.street,prop.plot_number,prop.address,prop.map_url,prop.price_negotiable,
  prop.price_notes,prop.bedrooms,prop.bathrooms,prop.kitchens,prop.floors,prop.parking_spaces,prop.furnishing,prop.construction_status,
  prop.property_age,prop.amenities,prop.building_categories,null,actor.id,actor.id)
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

-- ---------------------------------------------------------------- grants
-- The browser gets nothing. The category helpers stay callable by the API
-- role because the column's type uses them to check every write.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('property_category_list','property_categories_sorted','property_category_label',
  'promotion_change_text','inventory_save','inventory_promote') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname<>'promotion_change_text' then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
