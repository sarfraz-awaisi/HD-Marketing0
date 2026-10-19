-- Apply once after migration 016. Existing entries and attachments are retained.
BEGIN;
alter table public.knowledge_documents drop constraint knowledge_documents_category_check;
alter table public.knowledge_documents add constraint knowledge_documents_category_check
  check(category in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements'));
alter table public.knowledge_documents
  add column property_name text not null default '' check(length(property_name)<=200),
  add column keywords text not null default '' check(length(keywords)<=500);

create or replace function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents; fields jsonb;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content','property_name','keywords']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements')
    or (p_data?'property_name' and (jsonb_typeof(p_data->'property_name') is distinct from 'string' or length(btrim(p_data->>'property_name'))>200))
    or (p_data?'keywords' and (jsonb_typeof(p_data->'keywords') is distinct from 'string' or length(btrim(p_data->>'keywords'))>500)) then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,property_name,keywords,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),coalesce(btrim(p_data->>'property_name'),''),coalesce(btrim(p_data->>'keywords'),''),p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),
      property_name=case when p_data?'property_name' then btrim(p_data->>'property_name') else property_name end,
      keywords=case when p_data?'keywords' then btrim(p_data->>'keywords') else keywords end,
      updated_by=p_actor,updated_at=now() where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  fields=jsonb_build_array('title','category','content');
  if p_data?'property_name' then fields=fields||jsonb_build_array('property_name'); end if;
  if p_data?'keywords' then fields=fields||jsonb_build_array('keywords'); end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,jsonb_build_object('fields',fields));
  return to_jsonb(result);
end $$;

create function public.list_knowledge_documents(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb; total bigint;
begin
  perform id from public.profiles where id=p_actor and active and role in ('admin','agent') for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or p_search is null or length(p_search)>100 or p_category is null
    or p_category not in ('','documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements') then
    raise exception 'Invalid document filters' using errcode='22023';
  end if;
  with eligible as (
    select id,title,category,property_name,keywords,created_at,updated_at from public.knowledge_documents
    where (p_category='' or category=p_category)
      and (p_search='' or position(lower(p_search) in lower(title||' '||property_name||' '||keywords||' '||content))>0)
  ), page_rows as (
    select * from eligible order by updated_at desc,id offset (p_page-1)*p_limit limit p_limit
  )
  select coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id) from page_rows r),'[]'::jsonb),
    (select count(*) from eligible) into rows,total;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit);
end $$;
revoke all on function public.save_knowledge_document(uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.save_knowledge_document(uuid,jsonb,uuid,text) to service_role;
revoke all on function public.list_knowledge_documents(uuid,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.list_knowledge_documents(uuid,integer,integer,text,text) to service_role;
COMMIT;
