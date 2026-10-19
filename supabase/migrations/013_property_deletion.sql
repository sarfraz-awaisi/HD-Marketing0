-- Apply once after migration 012. Existing property records are not deleted.
BEGIN;

-- Storage removal happens outside PostgreSQL. Keep a durable retry queue so a
-- temporary Storage failure cannot leave a deleted property's files forgotten.
create table public.property_photo_cleanup (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index property_photo_cleanup_created on public.property_photo_cleanup(created_at);
alter table public.property_photo_cleanup enable row level security;
revoke all on public.property_photo_cleanup from public, anon, authenticated;
grant all on public.property_photo_cleanup to service_role;

create function public.delete_property(p_property uuid, p_actor uuid, p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles; photo_count integer;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  -- This lock also prevents concurrent new foreign-key references or photos
  -- from being attached between the checks and deletion.
  perform id from public.properties where id=p_property for update;
  if not found then raise exception 'Property not found' using errcode='P0002'; end if;
  if exists(select 1 from public.leads where property_id=p_property)
    or exists(select 1 from public.visits where property_id=p_property)
    or exists(select 1 from public.deals where property_id=p_property) then
    raise exception 'Property has linked CRM records' using errcode='23503';
  end if;
  insert into public.property_photo_cleanup(property_id,storage_path)
    select property_id,storage_path from public.property_photos where property_id=p_property;
  get diagnostics photo_count = row_count;
  delete from public.property_photos where property_id=p_property;
  delete from public.properties where id=p_property;
  insert into public.audit_log(actor_id,action,entity,entity_id,metadata,request_id)
    values(p_actor,'delete','properties',p_property::text,
      jsonb_build_object('photo_count',photo_count),p_request);
end $$;
revoke all on function public.delete_property(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.delete_property(uuid,uuid,text) to service_role;

COMMIT;
