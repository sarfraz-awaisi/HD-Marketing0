-- Apply once after 026. Add indexes/aggregate readers; keep all existing data/grants.
begin;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
do $$ declare ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
 execute format('create index leads_name_substring on public.leads using gin(name %I.gin_trgm_ops)',ns);
 execute format('create index properties_title_substring on public.properties using gin(title %I.gin_trgm_ops)',ns);
 execute format('create index lead_imports_filename_substring on public.lead_imports using gin(file_name %I.gin_trgm_ops)',ns);
end $$;
create index leads_owner_created on public.leads(assigned_agent,created_at desc,id);
create index leads_file_owner_created on public.leads(import_id,assigned_agent,created_at desc,id);
create index calls_lead_created on public.calls(lead_id,created_at desc,id);
create index calls_completed_ended on public.calls(ended_at,agent_id) where status='completed';
create index calls_agent_completed_ended on public.calls(agent_id,ended_at) where status='completed';
create index notes_lead_created on public.notes(lead_id,created_at desc,id);
create index assignments_lead_created on public.assignments(lead_id,created_at desc,id);
create index followups_lead_created on public.followups(lead_id,created_at desc,id);
create index followups_pending_due on public.followups(due_at,lead_id) where status='pending';
create index visits_lead_created on public.visits(lead_id,created_at desc,id);
create index visits_status_scheduled on public.visits(status,scheduled_at,agent_id);
create index reminders_unread_owner on public.reminders(agent_id,created_at desc) where read_at is null;
create index property_photos_property_created on public.property_photos(property_id,created_at,id);
create or replace function public.crm_leaderboard(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 with calls as(select agent_id,count(*) n from public.calls where status='completed' and ended_at>=p_from and ended_at<p_to group by agent_id),
 deals as(select agent_id,count(*) n from public.deals where stage='won' and close_date>=(p_from at time zone 'Asia/Karachi')::date and close_date<(p_to at time zone 'Asia/Karachi')::date group by agent_id)
 select coalesce(jsonb_agg(jsonb_build_object('name',p.name,'won_deals',coalesce(d.n,0),'completed_calls',coalesce(c.n,0))),'[]') into result
 from public.profiles p left join calls c on c.agent_id=p.id left join deals d on d.agent_id=p.id where p.active and p.role='agent';
 return result;
end $$;
create function public.dashboard_snapshot(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;followups jsonb;visits jsonb;targets jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'Invalid range' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(f)),'[]') into followups from
  (select f.* from public.followups f join public.leads l on l.id=f.lead_id where f.status='pending' and f.due_at<=now()+interval '1 day' and (actor.role='admin' or l.assigned_agent=p_actor) order by f.created_at desc,f.id limit 5) f;
 select coalesce(jsonb_agg(to_jsonb(v)),'[]') into visits from
  (select v.* from public.visits v join public.leads l on l.id=v.lead_id where v.status='scheduled' and (actor.role='admin' or l.assigned_agent=p_actor) order by v.created_at desc,v.id limit 5) v;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into targets from
  (select t.* from public.targets t where actor.role='agent' and t.agent_id=p_actor order by t.created_at desc,t.id limit 100) t;
 return jsonb_build_object('metrics',public.crm_metrics(p_actor,p_from,p_to,null,null),'leaders',public.crm_leaderboard(p_actor,p_from,p_to),'followups',followups,'visits',visits,'targets',targets);
end $$;
revoke all on function public.dashboard_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.dashboard_snapshot(uuid,timestamptz,timestamptz) to service_role;
create function public.property_cover_photos(p_actor uuid,p_properties uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;result jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if coalesce(cardinality(p_properties),0)>100 then raise exception 'Too many properties' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(photo)),'[]') into result from
 (select distinct on (property_id) property_id,id,storage_path,count(*) over(partition by property_id) photo_count
  from public.property_photos where property_id=any(p_properties) order by property_id,created_at,id) photo;
 return result;
end $$;
revoke all on function public.property_cover_photos(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.property_cover_photos(uuid,uuid[]) to service_role;
-- 26 is the monitoring schema contract. Readiness still checks that contract;
-- this optional performance upgrade adds no monitoring prerequisite or MFA policy.
notify pgrst,'reload schema';
commit;
