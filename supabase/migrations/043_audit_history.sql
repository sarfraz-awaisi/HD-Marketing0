-- Apply after 042. Safe to rerun. Readable audit history (update 043).
-- Adds two read-only functions for the administrator's Audit history page:
-- * audit_page: one filtered, paginated page of audit entries, with the
--   people and records each entry refers to resolved in the same query: who
--   did it, the employee affected, an assigned agent, and the lead, property,
--   document or import file involved. Searching matches the name or UID of
--   the person who acted or the employee affected.
-- * audit_actors: everyone who has a recorded action, for the "Performed by"
--   filter.
-- Audit entries are not changed: no table, column, row, trigger or
-- permission of audit_log is added or altered, and it stays append-only.
-- The API turns these rows into plain-English descriptions and removes
-- anything secret from the metadata before it reaches the browser.
begin;
do $$ begin
 if to_regprocedure('public.accounts_admin(uuid)') is null or to_regprocedure('public.format_lead_no(bigint)') is null then
  raise exception 'Apply CRM updates up to 042 before update 043.';
 end if;
end $$;

-- p_filters: {search, from, to (Pakistan dates), actor, sort: newest|oldest,
-- match: [{action, prefix, entity}]}. An entry matches the list when it fits
-- any item; each item's keys are optional and all of them must fit.
create or replace function public.audit_page(p_actor uuid,p_filters jsonb,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare f jsonb=coalesce(p_filters,'{}'::jsonb);term text=nullif(btrim(coalesce(f->>'search','')),'');
 oldest boolean=coalesce(f->>'sort','newest')='oldest';since date;until date;acted_by uuid;matches jsonb=f->'match';
 uuid_re text='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
  or length(coalesce(term,''))>100 or coalesce(f->>'sort','newest') not in ('newest','oldest')
  or (matches is not null and jsonb_typeof(matches)<>'array')
  or (f->>'actor' is not null and f->>'actor'!~uuid_re) then
  raise exception 'Invalid audit filter' using errcode='22023';end if;
 since=(f->>'from')::date;until=(f->>'to')::date;acted_by=(f->>'actor')::uuid;
 with people as (
  select p.id from public.profiles p where term is not null and (p.name ilike '%'||term||'%' or p.uid::text=term)
 ), base as (
  select a.*,case when a.metadata->>'user_id' ~ uuid_re then (a.metadata->>'user_id')::uuid
    when a.entity='profiles' and a.entity_id ~ uuid_re then a.entity_id::uuid end affected_id
  from public.audit_log a
  where (since is null or a.created_at>=(since::timestamp at time zone 'Asia/Karachi'))
   and (until is null or a.created_at<((until+1)::timestamp at time zone 'Asia/Karachi'))
   and (acted_by is null or a.actor_id=acted_by)
   and (matches is null or exists(select 1 from jsonb_array_elements(matches) m
    where (m->>'action' is null or a.action=m->>'action') and (m->>'prefix' is null or a.action like m->>'prefix'||'%')
     and (m->>'entity' is null or a.entity=m->>'entity')))
 ), filtered as (
  select b.* from base b where term is null or b.actor_id in (select id from people) or b.affected_id in (select id from people)
 ), page as (
  select * from filtered order by case when oldest then id end,case when not oldest then id end desc
  limit p_limit offset (p_page-1)*p_limit
 )
 select jsonb_build_object('page',p_page,'limit',p_limit,'count',(select count(*) from filtered),
  'data',coalesce(jsonb_agg(jsonb_build_object(
   'id',pg.id,'created_at',pg.created_at,'action',pg.action,'entity',pg.entity,'entity_id',pg.entity_id,
   'actor_id',pg.actor_id,'request_id',pg.request_id,'metadata',pg.metadata,
   'actor',case when ac.id is not null then jsonb_build_object('id',ac.id,'name',ac.name,'role',ac.role,'uid',ac.uid,
    'active',ac.active,'deleted',ac.deleted_at is not null) end,
   'affected',case when af.id is not null then jsonb_build_object('id',af.id,'name',af.name,'role',af.role,'uid',af.uid,
    'active',af.active,'deleted',af.deleted_at is not null) end,
   'agent',case when ag.id is not null then jsonb_build_object('id',ag.id,'name',ag.name,'role',ag.role,'uid',ag.uid,
    'deleted',ag.deleted_at is not null) end,
   'lead',case when l.id is not null then jsonb_build_object('number',public.format_lead_no(l.lead_no),'deleted',l.deleted_at is not null) end,
   'property',case when pr.id is not null then jsonb_build_object('title',pr.title,'number',pr.property_no) end,
   'document',case when d.id is not null then jsonb_build_object('title',d.title) end,
   'import',case when li.id is not null then jsonb_build_object('file_name',li.file_name,'deleted',li.deleted_at is not null) end)
   order by case when oldest then pg.id end,case when not oldest then pg.id end desc),'[]'::jsonb))
 into result
 from page pg
 left join public.profiles ac on ac.id=pg.actor_id
 left join public.profiles af on af.id=pg.affected_id
 left join public.profiles ag on ag.id=case when pg.metadata->>'agent_id' ~ uuid_re then (pg.metadata->>'agent_id')::uuid end
 left join public.calls c on c.id=case when pg.entity='calls' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.leads l on l.id=case when pg.entity='leads' and pg.entity_id ~ uuid_re then pg.entity_id::uuid
   when pg.metadata->>'lead_id' ~ uuid_re then (pg.metadata->>'lead_id')::uuid else c.lead_id end
 left join public.properties pr on pr.id=case when pg.entity='properties' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.knowledge_documents d on d.id=case when pg.entity='knowledge_documents' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end
 left join public.lead_imports li on li.id=case when pg.entity='lead_imports' and pg.entity_id ~ uuid_re then pg.entity_id::uuid end;
 return result;
end $$;

create or replace function public.audit_actors(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'uid',p.uid,
   'active',p.active,'deleted',p.deleted_at is not null) order by p.name,p.id),'[]'::jsonb)
  from public.profiles p where p.id in (select distinct a.actor_id from public.audit_log a where a.actor_id is not null));
end $$;

-- Browser roles get nothing; the API calls these for a signed-in admin.
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('audit_page','audit_actors') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
