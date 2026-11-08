-- Update 054: agents correct customer names; property floors; property PDF
-- documents. Apply after 053. Safe to rerun.
--
-- * lead_rename: an agent corrects the name of a lead assigned to them now
--   (an administrator, of any lead), for example "Unknown" or "N/A" after
--   speaking to the customer. Only the name changes: the lead's number,
--   phone, agent, calls, notes and follow-ups stay as they are. The audit
--   records the name before and after.
-- * properties.floor_level: the floor an apartment, portion, shop or office
--   is on: -2 Basement, -1 Lower ground, 0 Ground, or 1 to 200. Saves
--   (inventory_save) check it is not above the building's total floors
--   (properties.floors) and clear it for other types, as they already clear
--   building details for plots and land. Adding a listing to Admin
--   Properties (inventory_promote) copies it. Existing properties have none.
-- * property_documents: PDF brochures, floor plans and payment plans, up to
--   ten per property, in the private Storage bucket property-documents.
--   Whoever can see a property can open its documents; whoever can change
--   it can add and remove them, exactly as for its pictures. Files are
--   reserved before they are uploaded and queued for removal when their
--   document or property is deleted, so nothing is left behind. Adding an
--   agent's listing to Admin Properties copies its documents with its
--   pictures (inventory_promote_prepare, inventory_promote and
--   inventory_promote_release), each copy a separate file and record.
--
-- No existing row changes. One column is added to properties (no rewrite),
-- two tables and a bucket are added, and inventory_save, the three
-- promotion functions and promotion_change_text are replaced with the same
-- arguments and results: the code already deployed keeps working unchanged
-- (it copies pictures only, as before).
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regclass('public.audit_log_note_records') is null
  or to_regprocedure('public.inventory_promote(uuid,uuid,uuid,text[],text)') is null
  or to_regprocedure('public.property_categories_sorted(text[])') is null then
  raise exception 'Apply CRM updates up to 053 before update 054.';
 end if;
end $$;

-- ------------------------------------------------------- customer names
-- Names are trimmed with single spaces, 1 to 100 characters, with no
-- control characters, and are not a placeholder such as Unknown or N/A.
-- Another agent's lead, or a deleted one, is reported as not found.
create or replace function public.lead_rename(p_lead uuid,p_actor uuid,p_name text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;lead public.leads;clean text;
begin
 select * into actor from public.profiles where id=p_actor and active and deleted_at is null and role in ('admin','agent') for share;
 if not found then raise exception 'Your account is not active' using errcode='HA403';end if;
 clean=btrim(regexp_replace(coalesce(p_name,''),'\s+',' ','g'));
 if clean='' then raise exception 'Enter the customer''s name' using errcode='HA400';end if;
 if length(clean)>100 then raise exception 'Use a name of up to 100 characters' using errcode='HA400';end if;
 if clean ~ '[[:cntrl:]]' then raise exception 'Use letters, spaces and ordinary punctuation only' using errcode='HA400';end if;
 if lower(clean) in ('unknown','n/a','na','n.a.','none','null','nil','no name','noname','-','--','.','?','customer','client') then
  raise exception 'Enter the customer''s real name' using errcode='HA400';end if;
 select * into lead from public.leads where id=p_lead and deleted_at is null for update;
 if not found or (actor.role='agent' and lead.assigned_agent is distinct from actor.id) then
  raise exception 'Lead not found' using errcode='HA404';end if;
 if lead.name=clean then
  return jsonb_build_object('id',lead.id,'lead_no',lead.lead_no,'name',lead.name,'changed',false);
 end if;
 -- Not last_activity_at: a corrected name is not contact with the customer.
 update public.leads set name=clean,updated_at=now() where id=lead.id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'lead.renamed','leads',lead.id::text,p_request,
   jsonb_build_object('before',lead.name,'after',clean,'agent_id',lead.assigned_agent));
 return jsonb_build_object('id',lead.id,'lead_no',lead.lead_no,'name',clean,'changed',true);
end $$;

-- --------------------------------------------------------------- floors
-- The range sits on the type rather than the table, as in update 046, so
-- updates 041 and 044 can still be applied again.
do $$ begin
 if to_regtype('public.property_floor_level') is null then
  create domain public.property_floor_level as smallint check(value between -2 and 200);
 end if;
end $$;
alter table public.properties add column if not exists floor_level public.property_floor_level;

-- As in 046, plus the floor (shown in "Also changed").
create or replace function public.promotion_change_text(p_old public.properties,p_new public.properties,p_keys text[]) returns text language sql stable set search_path='' as $$
 with labels(k,label,n) as (values ('title','Title',1),('price','Price',2),('availability','Status',3),('purpose','Purpose',4),
   ('size','Size',5),('type','Property type',6),('description','Description',7),('price_negotiable','Negotiable price',8),
   ('price_notes','Price notes',9),('province','Province',10),('city','City',11),('area_society','Area or society',12),
   ('block_sector','Block or sector',13),('street','Street',14),('plot_number','Plot or house number',15),('address','Full address',16),
   ('map_url','Map location',17),('bedrooms','Bedrooms',18),('bathrooms','Bathrooms',19),('kitchens','Kitchens',20),('floors','Floors',21),
   ('floor_level','Floor',22),('parking_spaces','Parking spaces',23),('furnishing','Furnishing',24),('construction_status','Construction',25),
   ('property_age','Property age',26),('building_categories','Building categories',27),('amenities','Utilities and features',28),
   ('owner_contact','Owner contact',29)),
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

-- As in 046, plus floor_level: accepted for apartments, portions, shops and
-- offices, never above the total floors, cleared for every other type.
create or replace function public.inventory_save(p_actor uuid,p_property uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;merged public.properties;before public.properties;
 fields jsonb;contact jsonb;plot boolean;floored boolean;old_contact jsonb;changes text[];cats_before text[];meta jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['title','description','type','purpose','availability','price',
  'price_negotiable','price_notes','area','area_unit','province','city','area_society','block_sector','street','plot_number','address',
  'map_url','bedrooms','bathrooms','kitchens','floors','floor_level','parking_spaces','furnishing','construction_status','property_age','amenities',
  'building_categories','owner_contact','expected_updated_at'])<>'{}'::jsonb then
  raise exception 'Unsupported property details' using errcode='HA400';end if;
 if p_data?'type' and coalesce(p_data->>'type','') not in ('House','Apartment','Residential Plot','Portion','Farmhouse','Shop','Office',
  'Commercial Plot','Warehouse','Building','Land','Other') then
  raise exception 'Choose a property type from the list' using errcode='HA400';end if;
 if exists(select 1 from unnest(array['title','type','purpose','price','area','area_unit','city']) k
  where (p_property is null or p_data?k) and nullif(btrim(coalesce(p_data->>k,'')),'') is null) then
  raise exception 'Enter the title, type, purpose, price, size and city' using errcode='HA400';end if;
 if p_data?'floor_level' and jsonb_typeof(p_data->'floor_level')<>'null' and (jsonb_typeof(p_data->'floor_level')<>'number'
  or (p_data->>'floor_level')::numeric not between -2 and 200
  or (p_data->>'floor_level')::numeric<>floor((p_data->>'floor_level')::numeric)) then
  raise exception 'Choose the floor: Basement, Lower ground, Ground or a floor number up to 200' using errcode='HA400';end if;
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
 -- categories. Only apartments, portions, shops and offices are on a floor.
 plot=merged.type in ('Residential Plot','Commercial Plot','Land');
 floored=merged.type in ('Apartment','Portion','Shop','Office');
 if floored and merged.floor_level>0 and merged.floors is not null and merged.floor_level>merged.floors then
  raise exception 'The floor cannot be above the building''s total floors' using errcode='HA400';end if;
 if merged.city is not null then
  merged.location=concat_ws(', ',nullif(btrim(merged.block_sector),''),nullif(btrim(merged.area_society),''),btrim(merged.city));
 end if;
 if p_property is null then
  insert into public.properties(title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
   block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,floor_level,parking_spaces,
   furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
  values(merged.title,merged.description,merged.location,merged.price,merged.type,merged.area,merged.area_unit,merged.availability,
   merged.purpose,merged.province,merged.city,merged.area_society,merged.block_sector,merged.street,merged.plot_number,merged.address,
   merged.map_url,merged.price_negotiable,merged.price_notes,
   case when not plot then merged.bedrooms end,case when not plot then merged.bathrooms end,case when not plot then merged.kitchens end,
   case when not plot then merged.floors end,case when floored then merged.floor_level end,
   case when not plot then merged.parking_spaces end,case when not plot then merged.furnishing end,
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
   floor_level=case when floored then merged.floor_level end,
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
   'kitchens','floors','floor_level','parking_spaces','furnishing','construction_status','property_age','building_categories','amenities']) k
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

-- ------------------------------------------------------------ documents
-- The browser has no table grants (009); the API reads and writes these
-- through the functions below, which check the signed-in account.
create table if not exists public.property_documents(
 id uuid primary key default gen_random_uuid(),
 property_id uuid not null references public.properties(id) on delete cascade,
 storage_path text not null unique,
 file_name text not null check(length(file_name) between 5 and 200 and lower(file_name) like '%.pdf'),
 size_bytes integer not null check(size_bytes between 1 and 26214400),
 uploaded_by uuid references public.profiles(id),
 created_at timestamptz not null default now());
create index if not exists property_documents_order on public.property_documents(property_id,created_at,id);
-- Files to remove from Storage. A row whose not_before is still ahead is a
-- reservation for an upload in progress; it expires after an hour, so a file
-- whose upload was interrupted is removed too. No foreign key: the queue
-- outlives a deleted property.
create table if not exists public.property_document_cleanup(
 id uuid primary key default gen_random_uuid(),
 property_id uuid not null,
 storage_path text not null unique,
 not_before timestamptz not null default now(),
 created_at timestamptz not null default now());
-- A reservation for a document copied to Admin Properties also carries the
-- record to create once the copy exists.
alter table public.property_document_cleanup
 add column if not exists file_name text,
 add column if not exists size_bytes integer,
 add column if not exists uploaded_by uuid;
create index if not exists property_document_cleanup_due on public.property_document_cleanup(not_before,created_at);
alter table public.property_documents enable row level security;
alter table public.property_document_cleanup enable row level security;
revoke all on public.property_documents,public.property_document_cleanup from public,anon,authenticated;
grant all on public.property_documents,public.property_document_cleanup to service_role;
-- Removing a document, or its property, queues its file in the same
-- transaction.
create or replace function public.queue_property_document_file() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.property_document_cleanup(property_id,storage_path) values(old.property_id,old.storage_path)
  on conflict(storage_path) do update set not_before=least(public.property_document_cleanup.not_before,now());
 return old;
end $$;
create or replace trigger queue_property_document_file after delete on public.property_documents
 for each row execute function public.queue_property_document_file();
-- Private: files are only ever read by the API for a signed-in user it has
-- checked. PDF only, at most 25 MB (the API's own limit can be lower).
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('property-documents','property-documents',false,26214400,array['application/pdf']) on conflict(id) do nothing;

create or replace function public.property_document_json(p_document public.property_documents) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p_document.id,'file_name',p_document.file_name,'size_bytes',p_document.size_bytes,
  'created_at',p_document.created_at,'uploaded_by_name',(select name from public.profiles where id=p_document.uploaded_by))
$$;
-- Whoever can see the property sees its documents.
create or replace function public.inventory_documents(p_actor uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
begin
 return (select coalesce(jsonb_agg(public.property_document_json(d) order by d.created_at,d.id),'[]'::jsonb)
  from public.property_documents d where d.property_id=prop.id);
end $$;
-- For opening or downloading one document; the API calls it again after
-- reading the file, so access removed meanwhile is respected.
create or replace function public.inventory_document_file(p_actor uuid,p_property uuid,p_document uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,false);
 doc public.property_documents;
begin
 select * into doc from public.property_documents where id=p_document and property_id=prop.id;
 if not found then raise exception 'Document not found' using errcode='HA404';end if;
 return public.property_document_json(doc)||jsonb_build_object('storage_path',doc.storage_path);
end $$;
-- Before an upload: checks the property can be changed and has room, and
-- reserves the file's path for an hour.
create or replace function public.inventory_document_reserve(p_actor uuid,p_property uuid,p_path text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
begin
 if p_path is null or p_path !~ ('^'||prop.id::text||'/[0-9a-f-]{36}$') then
  raise exception 'Invalid document' using errcode='HA400';end if;
 if (select count(*) from public.property_documents where property_id=prop.id)
  +(select count(*) from public.property_document_cleanup where property_id=prop.id and not_before>now())>=10 then
  raise exception 'A property can have up to 10 documents' using errcode='HA409';end if;
 insert into public.property_document_cleanup(property_id,storage_path,not_before) values(prop.id,p_path,now()+interval '1 hour');
 return jsonb_build_object('path',p_path);
end $$;
-- After the upload: the reservation becomes the document.
create or replace function public.inventory_document_add(p_actor uuid,p_property uuid,p_path text,p_name text,p_size integer,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
 doc public.property_documents;kept integer;
begin
 if p_path is null or p_path !~ ('^'||prop.id::text||'/[0-9a-f-]{36}$') then
  raise exception 'Invalid document' using errcode='HA400';end if;
 if p_name is null or length(p_name) not between 5 and 200 or lower(p_name) not like '%.pdf' or p_name ~ '[[:cntrl:]/\\]'
  or p_size is null or p_size not between 1 and 26214400 then
  raise exception 'Choose a PDF file' using errcode='HA400';end if;
 delete from public.property_document_cleanup where property_id=prop.id and storage_path=p_path and not_before>now();
 get diagnostics kept=row_count;
 if kept=0 then raise exception 'The upload took too long. Please try again.' using errcode='HA409';end if;
 if (select count(*) from public.property_documents where property_id=prop.id)>=10 then
  raise exception 'A property can have up to 10 documents' using errcode='HA409';end if;
 insert into public.property_documents(property_id,storage_path,file_name,size_bytes,uploaded_by)
  values(prop.id,p_path,p_name,p_size,actor.id) returning * into doc;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'upload_document','properties',prop.id::text,p_request,jsonb_build_object('file_name',p_name,'size_bytes',p_size));
 return public.property_document_json(doc);
end $$;
-- After a failed upload: the reserved path is removed at once.
create or replace function public.inventory_document_release(p_actor uuid,p_property uuid,p_path text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.inventory_member(p_actor);
 update public.property_document_cleanup set not_before=now() where property_id=p_property and storage_path=p_path and not_before>now();
end $$;
create or replace function public.inventory_document_remove(p_actor uuid,p_property uuid,p_document uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties=public.inventory_property_for(actor,p_property,true);
 removed text;
begin
 delete from public.property_documents where id=p_document and property_id=prop.id returning file_name into removed;
 if removed is null then raise exception 'Document not found' using errcode='HA404';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'delete_document','properties',prop.id::text,p_request,jsonb_build_object('file_name',removed));
end $$;

-- ------------------------------------------------------------ promotion
-- As in 044, and each document is reserved a copy too, with its name, size
-- and uploader. The result gains "documents" alongside "photos".
create or replace function public.inventory_promote_prepare(p_actor uuid,p_property uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;photos jsonb;documents jsonb;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,false);
 if p_copy is null or exists(select 1 from public.properties where id=p_copy)
  or exists(select 1 from public.property_photo_cleanup where property_id=p_copy)
  or exists(select 1 from public.property_document_cleanup where property_id=p_copy) then
  raise exception 'Invalid request' using errcode='HA400';end if;
 select coalesce(jsonb_agg(jsonb_build_object('from',x.storage_path,'to',p_copy::text||'/'||gen_random_uuid()::text)
   order by x.position,x.created_at,x.id),'[]'::jsonb) into photos
 from public.property_photos x where x.property_id=prop.id;
 insert into public.property_photo_cleanup(property_id,storage_path,not_before)
  select p_copy,e->>'to',now()+interval '1 hour' from jsonb_array_elements(photos) e;
 select coalesce(jsonb_agg(jsonb_build_object('from',d.storage_path,'to',p_copy::text||'/'||gen_random_uuid()::text,
   'file_name',d.file_name,'size_bytes',d.size_bytes,'uploaded_by',d.uploaded_by,'created_at',d.created_at) order by d.created_at,d.id),'[]'::jsonb) into documents
 from public.property_documents d where d.property_id=prop.id;
 -- created_at: the copies keep the originals' order and dates.
 insert into public.property_document_cleanup(property_id,storage_path,not_before,file_name,size_bytes,uploaded_by,created_at)
  select p_copy,e->>'to',now()+interval '1 hour',e->>'file_name',(e->>'size_bytes')::integer,(e->>'uploaded_by')::uuid,(e->>'created_at')::timestamptz
  from jsonb_array_elements(documents) e;
 return jsonb_build_object('photos',photos,'documents',(select coalesce(jsonb_agg(jsonb_build_object('from',e->'from','to',e->'to')),'[]'::jsonb)
  from jsonb_array_elements(documents) e));
end $$;
-- As in 046, with the floor, and with documents. p_paths lists every picture
-- and document file the API copied; each must still be reserved for this
-- copy. Whatever was not copied is released for removal; the copy's
-- pictures and document records are created in this same transaction, so
-- there is never a record without its file or a file without its record.
create or replace function public.inventory_promote(p_actor uuid,p_property uuid,p_copy uuid,p_paths text[],p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);prop public.properties;made public.properties;agent public.profiles;
 planned integer;kept integer;planned_docs integer;photo_paths text[];docs jsonb;
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 prop=public.promotion_source(p_property,true);
 p_paths=coalesce(p_paths,'{}'::text[]);
 if p_copy is null or cardinality(p_paths)>30 or cardinality(p_paths)<>(select count(distinct x) from unnest(p_paths) x)
  or exists(select 1 from unnest(p_paths) x where x is null or x !~ ('^'||p_copy::text||'/[0-9a-f-]{36}$')) then
  raise exception 'Invalid picture' using errcode='HA400';end if;
 select count(*) into planned from public.property_photo_cleanup where property_id=p_copy and not_before>now();
 select count(*) into planned_docs from public.property_document_cleanup where property_id=p_copy and not_before>now();
 -- Every copied file must still be reserved. A reservation that was
 -- released or already processed may mean its file is gone.
 with taken as (delete from public.property_photo_cleanup where property_id=p_copy and storage_path=any(p_paths) and not_before>now()
  returning storage_path) select coalesce(array_agg(storage_path),'{}') into photo_paths from taken;
 with taken as (delete from public.property_document_cleanup where property_id=p_copy and storage_path=any(p_paths) and not_before>now()
  returning storage_path,file_name,size_bytes,uploaded_by,created_at) select coalesce(jsonb_agg(to_jsonb(taken)),'[]'::jsonb) into docs from taken;
 kept=cardinality(photo_paths);
 if kept+jsonb_array_length(docs)<>cardinality(p_paths) then
  raise exception 'The pictures or documents changed while they were being copied. Please try again.' using errcode='HA409';end if;
 -- Files that could not be copied were never written; let the queues clear
 -- their reservations.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy;
 update public.property_document_cleanup set not_before=now() where property_id=p_copy;
 select * into agent from public.profiles where id=prop.owner_agent_id;
 insert into public.properties(id,title,description,location,price,type,area,area_unit,availability,purpose,province,city,area_society,
  block_sector,street,plot_number,address,map_url,price_negotiable,price_notes,bedrooms,bathrooms,kitchens,floors,floor_level,parking_spaces,
  furnishing,construction_status,property_age,amenities,building_categories,owner_agent_id,created_by,updated_by)
 values(p_copy,prop.title,prop.description,prop.location,prop.price,prop.type,prop.area,prop.area_unit,prop.availability,prop.purpose,
  prop.province,prop.city,prop.area_society,prop.block_sector,prop.street,prop.plot_number,prop.address,prop.map_url,prop.price_negotiable,
  prop.price_notes,prop.bedrooms,prop.bathrooms,prop.kitchens,prop.floors,prop.floor_level,prop.parking_spaces,prop.furnishing,prop.construction_status,
  prop.property_age,prop.amenities,prop.building_categories,null,actor.id,actor.id)
 returning * into made;
 -- The seller's contact is kept for administrators only, as on the
 -- agent's listing; it is not shared with agents unless an administrator
 -- later chooses to.
 insert into public.property_owner_contacts(property_id,owner_name,owner_phone,owner_alt_phone,owner_notes,share_with_agents)
  select made.id,c.owner_name,c.owner_phone,c.owner_alt_phone,c.owner_notes,false from public.property_owner_contacts c where c.property_id=prop.id;
 insert into public.property_photos(property_id,storage_path,position)
  select made.id,u.x,(row_number() over(order by u.n)-1)::integer from unnest(p_paths) with ordinality u(x,n) where u.x=any(photo_paths);
 insert into public.property_documents(property_id,storage_path,file_name,size_bytes,uploaded_by,created_at)
  select made.id,d->>'storage_path',d->>'file_name',(d->>'size_bytes')::integer,(d->>'uploaded_by')::uuid,(d->>'created_at')::timestamptz
  from jsonb_array_elements(docs) d;
 insert into public.property_promotions(source_id,copy_id,source_property_no,copy_property_no,source_agent_id,source_agent_uid,source_agent_name,promoted_by)
  values(prop.id,made.id,prop.property_no,made.property_no,agent.id,agent.uid,left(coalesce(nullif(btrim(agent.name),''),'Agent'),200),actor.id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(actor.id,'promote','properties',made.id::text,p_request,jsonb_build_object('agent_id',agent.id,'source_id',prop.id,
   'source_property_no',prop.property_no,'copy_property_no',made.property_no,'photo_count',kept,'photos_missing',greatest(planned-kept,0),
   'document_count',jsonb_array_length(docs),'documents_missing',greatest(planned_docs-jsonb_array_length(docs),0)));
 return public.inventory_property(p_actor,made.id);
end $$;
-- As in 044, and document reservations are released too.
create or replace function public.inventory_promote_release(p_actor uuid,p_copy uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles=public.inventory_member(p_actor);
begin
 if actor.role<>'admin' then raise exception 'Only administrators can add properties to the Admin list' using errcode='HA403';end if;
 -- Release first: this waits for a promotion still saving, so the check
 -- below then sees whether it finished.
 update public.property_photo_cleanup set not_before=now() where property_id=p_copy and not_before>now();
 update public.property_document_cleanup set not_before=now() where property_id=p_copy and not_before>now();
 return jsonb_build_object('committed',exists(select 1 from public.properties where id=p_copy));
end $$;

-- ---------------------------------------------------------------- grants
-- The browser gets nothing; the API's service role calls the API functions.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('lead_rename','promotion_change_text','inventory_save','inventory_promote',
  'inventory_promote_prepare','inventory_promote_release','queue_property_document_file','property_document_json','inventory_documents','inventory_document_file','inventory_document_reserve',
  'inventory_document_add','inventory_document_release','inventory_document_remove') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname not in ('promotion_change_text','queue_property_document_file','property_document_json') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
