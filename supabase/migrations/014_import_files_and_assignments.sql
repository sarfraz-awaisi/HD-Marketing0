-- Run once on an existing project. Keeps existing leads and phone records.
BEGIN;
create table public.lead_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check(length(file_name) between 1 and 200),
  file_format text not null check(file_format in ('csv','xlsx','xls','legacy')),
  worksheet text,
  total_rows integer not null check(total_rows>=0),
  imported_count integer not null default 0 check(imported_count>=0),
  rejected_count integer not null default 0 check(rejected_count>=0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  assigned_agent uuid references public.profiles(id),
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz,
  legacy boolean not null default false,
  check(imported_count+rejected_count=total_rows)
);
alter table public.leads add column import_id uuid references public.lead_imports(id);
create index leads_import_assignment on public.leads(import_id,assigned_agent);
create index lead_imports_created on public.lead_imports(created_at desc,id);
alter table public.lead_imports enable row level security;
revoke all on public.lead_imports from public,anon,authenticated;
grant all on public.lead_imports to service_role;

-- Old imports did not retain filenames. Recover their groups from create-request
-- IDs, without guessing filenames, changing ownership, or touching phone values.
alter table public.leads disable trigger touch_updated;
do $$ declare g record; batch uuid; begin
  for g in
    select coalesce(a.request_id,'legacy:'||l.id::text) as request_key,
      array_agg(l.id) as ids,min(l.created_at) as created_at,
      min(a.actor_id::text)::uuid as actor_id,count(*)::integer as n
    from public.leads l
    left join lateral (
      select request_id,actor_id from public.audit_log
      where entity='leads' and entity_id=l.id::text and action='create'
      order by created_at,id limit 1
    ) a on true
    where l.source='CSV' and l.import_id is null
    group by coalesce(a.request_id,'legacy:'||l.id::text)
  loop
    insert into public.lead_imports(file_name,file_format,total_rows,imported_count,created_by,created_at,legacy)
      values('Earlier import ('||to_char(g.created_at at time zone 'Asia/Karachi','YYYY-MM-DD HH24:MI')||')',
        'legacy',g.n,g.n,g.actor_id,g.created_at,true) returning id into batch;
    update public.leads set import_id=batch where id=any(g.ids);
  end loop;
end $$;
alter table public.leads enable trigger touch_updated;

create function public.import_leads(p_file_name text,p_format text,p_worksheet text,p_rows jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch uuid; r jsonb; created public.leads; results jsonb='[]'; item jsonb; accepted integer=0; rejected integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if p_file_name is null or length(p_file_name) not between 1 and 200
    or p_format is null or p_format not in ('csv','xlsx','xls')
    or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Invalid import' using errcode='22023';
  end if;
  -- Counts are finalized after all row subtransactions have completed.
  insert into public.lead_imports(file_name,file_format,worksheet,total_rows,created_by)
    values(p_file_name,p_format,left(p_worksheet,200),0,p_actor) returning id into batch;
  for r in select value from jsonb_array_elements(p_rows) loop
    if r ? 'error' then
      item=jsonb_build_object('row',r->'row','success',false,'error',r->>'error');
      rejected=rejected+1;
    else
      begin
        if jsonb_typeof(r->'data') is distinct from 'object'
          or coalesce(r->>'phone','') !~ '^\+[1-9][0-9]{9,14}$' then
          raise exception 'Invalid row' using errcode='22023';
        end if;
        created=public.create_lead(r->'data',r->>'phone',p_actor,p_request);
        update public.leads set import_id=batch where id=created.id;
        item=jsonb_build_object('row',r->'row','success',true,'id',created.id);
        if jsonb_typeof(r->'warnings')='array' and jsonb_array_length(r->'warnings')>0 then
          item=item||jsonb_build_object('warnings',r->'warnings');
        end if;
        accepted=accepted+1;
      exception
        when unique_violation then
          item=jsonb_build_object('row',r->'row','success',false,'error','Duplicate phone');
          rejected=rejected+1;
        when others then
          item=jsonb_build_object('row',r->'row','success',false,'error','Row rejected');
          rejected=rejected+1;
      end;
    end if;
    results=results||jsonb_build_array(item);
  end loop;
  update public.lead_imports set total_rows=accepted+rejected,imported_count=accepted,rejected_count=rejected where id=batch;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'import','lead_imports',batch::text,p_request,
      jsonb_build_object('imported_count',accepted,'rejected_count',rejected));
  return jsonb_build_object('import_id',batch,'rows',results);
end $$;

create function public.lead_import_summary(p_import uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; batch public.lead_imports; visible integer; n integer; assigned integer; owners integer; owner_id uuid; owner_name text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  select * into batch from public.lead_imports where id=p_import;
  if not found then return null; end if;
  select count(*)::integer into visible from public.leads
    where import_id=p_import and (actor.role='admin' or assigned_agent=p_actor);
  if actor.role<>'admin' and visible=0 then return null; end if;
  select count(*)::integer,count(assigned_agent)::integer,count(distinct assigned_agent)::integer,min(assigned_agent::text)::uuid
    into n,assigned,owners,owner_id from public.leads where import_id=p_import;
  if owners<>1 or assigned<>n then owner_id=null; end if;
  if actor.role<>'admin' then owner_id=actor.id; end if;
  select name into owner_name from public.profiles where id=owner_id;
  return jsonb_build_object('id',batch.id,'file_name',batch.file_name,'file_format',batch.file_format,
    'worksheet',batch.worksheet,'created_at',batch.created_at,'legacy',batch.legacy,
    'total_rows',batch.total_rows,'imported_count',batch.imported_count,'rejected_count',batch.rejected_count,
    'lead_count',visible,'assigned_agent',owner_id,'assigned_name',owner_name,
    'mixed_assignment',actor.role='admin' and assigned>0 and owner_id is null);
end $$;

create function public.lead_imports_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,p_search text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; results jsonb; n bigint;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  if p_page not between 1 and 100000 or p_limit not between 1 and 100 or length(coalesce(p_search,''))>100 then
    raise exception 'Invalid page' using errcode='22023';
  end if;
  select count(*) into n from public.lead_imports i
    where (actor.role='admin' or exists(select 1 from public.leads l where l.import_id=i.id and l.assigned_agent=p_actor))
      and position(lower(coalesce(p_search,'')) in lower(i.file_name))>0;
  select coalesce(jsonb_agg(public.lead_import_summary(i.id,p_actor) order by i.created_at desc,i.id),'[]') into results
    from (select * from public.lead_imports b
      where (actor.role='admin' or exists(select 1 from public.leads l where l.import_id=b.id and l.assigned_agent=p_actor))
        and position(lower(coalesce(p_search,'')) in lower(b.file_name))>0
      order by b.created_at desc,b.id limit p_limit offset (p_page-1)*p_limit) i;
  return jsonb_build_object('data',results,'count',n,'page',p_page,'limit',p_limit);
end $$;

create function public.assign_lead_import(p_import uuid,p_agent uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch public.lead_imports; lead public.leads; changed integer=0; n integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  perform id from public.profiles where id=p_agent and role='agent' and active for share;
  if not found then raise exception 'Choose an active agent' using errcode='22023'; end if;
  select * into batch from public.lead_imports where id=p_import for update;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  for lead in select * from public.leads where import_id=p_import order by id for update loop
    n=n+1;
    if lead.assigned_agent is distinct from p_agent then
      perform public.assign_lead(lead.id,p_actor,p_agent,p_request);
      changed=changed+1;
    end if;
  end loop;
  if n=0 then raise exception 'File has no accepted leads' using errcode='22023'; end if;
  update public.lead_imports set assigned_agent=p_agent,assigned_by=p_actor,assigned_at=now() where id=p_import;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'assign_file','lead_imports',p_import::text,p_request,
      jsonb_build_object('agent_id',p_agent,'lead_count',n,'assigned_count',changed));
  return jsonb_build_object('id',p_import,'agent_id',p_agent,'lead_count',n,'assigned_count',changed);
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc
    where pronamespace='public'::regnamespace and proname in
      ('import_leads','lead_import_summary','lead_imports_page','assign_lead_import') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
COMMIT;
