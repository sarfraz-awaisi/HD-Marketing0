-- Apply once after migration 014. Existing CRM records are preserved.
BEGIN;
create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check(length(btrim(title)) between 1 and 200),
  category text not null check(category in ('documentation','policy')),
  content text not null check(length(btrim(content)) between 1 and 50000),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_documents_updated on public.knowledge_documents(updated_at desc,id);
alter table public.knowledge_documents enable row level security;
revoke all on public.knowledge_documents from public,anon,authenticated;
grant all on public.knowledge_documents to service_role;

create table public.knowledge_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id),
  file_name text not null check(length(file_name) between 1 and 200),
  mime_type text not null check(mime_type in ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes integer not null check(size_bytes between 1 and 10485760),
  storage_path text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index knowledge_files_document on public.knowledge_files(document_id,created_at);
-- Reservations are queued before Storage uploads. Failed or interrupted uploads
-- remain recoverable even if compensation cannot reach Storage immediately.
create table public.knowledge_file_cleanup (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  storage_path text not null unique,
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index knowledge_file_cleanup_due on public.knowledge_file_cleanup(not_before);
alter table public.knowledge_files enable row level security;
alter table public.knowledge_file_cleanup enable row level security;
revoke all on public.knowledge_files,public.knowledge_file_cleanup from public,anon,authenticated;
grant all on public.knowledge_files,public.knowledge_file_cleanup to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('knowledge-files','knowledge-files',false,10485760,array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

create function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy') then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),updated_by=p_actor,updated_at=now()
      where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,
      jsonb_build_object('fields',jsonb_build_array('title','category','content')));
  return to_jsonb(result);
end $$;

create function public.delete_knowledge_document(p_id uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  perform id from public.knowledge_documents where id=p_id for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  insert into public.knowledge_file_cleanup(document_id,storage_path)
    select document_id,storage_path from public.knowledge_files where document_id=p_id
    on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where document_id=p_id;
  delete from public.knowledge_documents where id=p_id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id)
    values(p_actor,'delete','knowledge_documents',p_id::text,p_request);
end $$;
create function public.attach_knowledge_file(p_document uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_files;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  perform id from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data-array['file_name','mime_type','size_bytes','storage_path'])<>'{}'::jsonb
    or coalesce(p_data->>'storage_path','') !~ ('^'||p_document::text||'/[0-9a-f-]{36}$')
    or not exists(select 1 from public.knowledge_file_cleanup where storage_path=p_data->>'storage_path' and document_id=p_document) then
    raise exception 'Invalid file metadata' using errcode='22023';
  end if;
  insert into public.knowledge_files(document_id,file_name,mime_type,size_bytes,storage_path,created_by)
    values(p_document,p_data->>'file_name',p_data->>'mime_type',(p_data->>'size_bytes')::integer,p_data->>'storage_path',p_actor)
    returning * into result;
  delete from public.knowledge_file_cleanup where storage_path=result.storage_path;
  update public.knowledge_documents set updated_at=now(),updated_by=p_actor where id=p_document;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'upload_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',result.id));
  return to_jsonb(result)-'storage_path';
end $$;
create function public.delete_knowledge_file(p_document uuid,p_file uuid,p_actor uuid,p_request text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles; attachment public.knowledge_files;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  perform id from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  select * into attachment from public.knowledge_files where id=p_file and document_id=p_document for update;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  insert into public.knowledge_file_cleanup(document_id,storage_path) values(p_document,attachment.storage_path)
    on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where id=p_file;
  update public.knowledge_documents set updated_at=now(),updated_by=p_actor where id=p_document;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'delete_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',p_file));
end $$;
revoke all on function public.save_knowledge_document(uuid,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.delete_knowledge_document(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_knowledge_document(uuid,jsonb,uuid,text) to service_role;
grant execute on function public.delete_knowledge_document(uuid,uuid,text) to service_role;
revoke all on function public.attach_knowledge_file(uuid,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.delete_knowledge_file(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.attach_knowledge_file(uuid,jsonb,uuid,text) to service_role;
grant execute on function public.delete_knowledge_file(uuid,uuid,uuid,text) to service_role;
COMMIT;
