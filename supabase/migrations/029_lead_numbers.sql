-- Apply once after 028. Permanent identity numbers and consistent lead counts.
begin;
lock table public.leads in access exclusive mode;
alter table public.leads add column lead_no bigint;
alter table public.leads disable trigger touch_updated;
with numbered as(select id,row_number() over(order by created_at,id) n from public.leads)
update public.leads l set lead_no=n.n from numbered n where n.id=l.id;
alter table public.leads enable trigger touch_updated;
alter table public.leads alter column lead_no set not null;
alter table public.leads alter column lead_no add generated always as identity;
select setval(pg_get_serial_sequence('public.leads','lead_no'),coalesce(max(lead_no),1),count(*)>0) from public.leads;
alter table public.leads add constraint leads_lead_no_key unique(lead_no);
create function public.guard_lead_number() returns trigger language plpgsql set search_path='' as $$
begin
 if new.lead_no is distinct from old.lead_no then raise exception 'Lead number cannot be changed' using errcode='22023';end if;
 return new;
end $$;
create trigger guard_lead_number before update of lead_no on public.leads for each row execute function public.guard_lead_number();
alter function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text) rename to crm_metrics_028;
create function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 result=public.crm_metrics_028(p_actor,p_from,p_to,p_agent,p_source);
 return result||jsonb_build_object('total_leads',(select count(*) from public.leads l where
  (exists(select 1 from public.profiles where id=p_actor and active and role='admin') or l.assigned_agent=p_actor)
  and (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)));
end $$;
create or replace function public.lead_import_summary(p_import uuid,p_actor uuid)
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
    'lead_count',visible,'assigned_count',case when actor.role='admin' then assigned else visible end,'unassigned_count',case when actor.role='admin' then n-assigned else 0 end,'assigned_agent',owner_id,'assigned_name',owner_name,
    'mixed_assignment',actor.role='admin' and assigned>0 and owner_id is null);
end $$;
create or replace function public.dashboard_snapshot(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;followups jsonb;visits jsonb;targets jsonb;begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'Invalid range' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(f)),'[]') into followups from
  (select f.*,l.lead_no,l.name as lead_name from public.followups f join public.leads l on l.id=f.lead_id where f.status='pending' and f.due_at<=now()+interval '1 day' and (actor.role='admin' or l.assigned_agent=p_actor) order by f.created_at desc,f.id limit 5) f;
 select coalesce(jsonb_agg(to_jsonb(v)),'[]') into visits from
  (select v.*,l.lead_no,l.name as lead_name from public.visits v join public.leads l on l.id=v.lead_id where v.status='scheduled' and (actor.role='admin' or l.assigned_agent=p_actor) order by v.created_at desc,v.id limit 5) v;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into targets from
  (select t.* from public.targets t where actor.role='agent' and t.agent_id=p_actor order by t.created_at desc,t.id limit 100) t;
 return jsonb_build_object('metrics',public.crm_metrics(p_actor,p_from,p_to,null,null),'leaders',public.crm_leaderboard(p_actor,p_from,p_to),'followups',followups,'visits',visits,'targets',targets);
end $$;
revoke all on function public.guard_lead_number(),public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text),public.crm_metrics_028(uuid,timestamptz,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text),public.crm_metrics_028(uuid,timestamptz,timestamptz,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
