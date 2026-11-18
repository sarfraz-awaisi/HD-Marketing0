-- Update 072: Daily KPIs filled in by the CRM, and evidence that
-- administrators approve. Apply after 071. Safe to rerun.
--
-- Each KPI's rules (kpi_versions) gain how the KPI is measured:
-- * self: the agent answers, as before (update 070);
-- * calls: Yes when every lead whose first-call deadline fell on the day,
--   while the agent had it, got the agent's first call by that deadline,
--   whatever the outcome (No answer and Busy are calls too). A day with no
--   such lead has nothing due and is not missed;
-- * social: Yes once an administrator approves one of the day's links
--   (Facebook, Instagram, TikTok or YouTube; up to 5 a day);
-- * inventory: the agent's listings added that day that an administrator
--   verified, with the owner's name and phone filled in;
-- * visits: one photo is one visit (a project and a date); the week counts
--   distinct approved project-and-date pairs;
-- * video: approved links to finished videos, in the week they were added.
-- Rules still change from the next period (070): the five first KPIs switch
-- now if no one has answered under their current rules, otherwise from
-- tomorrow (daily) or next Monday (weekly). Earlier answers stay as given.
--
-- New tables, readable only by the CRM's server (row security, no grants):
-- * kpi_evidence: each link or photo an agent submits, with its review
--   (status, reviewer, time, reason); every action is in the audit log;
-- * property_verifications: an administrator's Verified or Rejected on an
--   agent's listing (no row: waiting). Separate from "Add to Admin List".
-- Photos go to the new private bucket kpi-evidence (JPEG, PNG or WebP up to
-- 5 MB). Nothing existing is deleted or rewritten.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.erase_deleted_leads_preview(uuid,uuid[])') is null
  or to_regprocedure('public.kpi_facts(uuid,date,date,uuid,timestamp with time zone)') is null
  or to_regclass('public.property_owner_contacts') is null then
  raise exception 'Apply CRM updates up to 071 before update 072.';
 end if;
end $$;

-- --------------------------------------------------------- how it is measured
alter table public.kpi_versions add column if not exists measure text not null default 'self';
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.kpi_versions'::regclass and conname='kpi_versions_measure') then
  alter table public.kpi_versions add constraint kpi_versions_measure check(
   measure='self'
   or (measure in ('calls','social') and frequency='day' and answer_type='yes_no')
   or (measure='inventory' and frequency='day' and answer_type='number')
   or (measure in ('visits','video') and frequency='week' and answer_type='number'));
 end if;
end $$;

-- ------------------------------------------------------------------ evidence
create table if not exists public.kpi_evidence(
 id uuid primary key default gen_random_uuid(),
 agent_id uuid not null references public.profiles(id),
 kind text not null check(kind in ('social','video','visit')),
 -- The Pakistan day it counts for: a link's day, or the visit's date.
 activity_date date not null,
 url text check(url is null or (length(url) between 12 and 600 and url ~* '^https://([a-z0-9-]+\.)*(facebook\.com|fb\.watch|instagram\.com|tiktok\.com|youtube\.com|youtu\.be)(/|$)')),
 url_key text check(url_key is null or length(url_key) between 3 and 600),
 platform text check(platform is null or platform in ('facebook','instagram','tiktok','youtube')),
 project_name text check(project_name is null or (project_name=btrim(project_name) and length(project_name) between 2 and 120)),
 storage_path text unique,
 file_hash text check(file_hash is null or file_hash ~ '^[0-9a-f]{64}$'),
 mime_type text check(mime_type is null or mime_type in ('image/jpeg','image/png','image/webp')),
 size_bytes integer check(size_bytes is null or size_bytes between 1 and 5242880),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 review_reason text check(review_reason is null or (review_reason=btrim(review_reason) and length(review_reason) between 1 and 300)),
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 submitted_at timestamptz not null default now(),
 check((kind in ('social','video') and url is not null and url_key is not null and platform is not null
   and project_name is null and storage_path is null and file_hash is null)
  or (kind='visit' and url is null and url_key is null and project_name is not null and storage_path is not null
   and file_hash is not null and mime_type is not null and size_bytes is not null)),
 check((status='pending')=(reviewed_at is null) and (reviewed_at is null)=(reviewed_by is null)));
-- The same link once a day (social), the same video once ever, the same
-- image file once ever, whoever sends it.
create unique index if not exists kpi_evidence_social_once on public.kpi_evidence(agent_id,activity_date,url_key) where kind='social';
create unique index if not exists kpi_evidence_video_once on public.kpi_evidence(url_key) where kind='video';
create unique index if not exists kpi_evidence_photo_once on public.kpi_evidence(file_hash) where kind='visit';
create index if not exists kpi_evidence_agent_day on public.kpi_evidence(agent_id,activity_date);
create index if not exists kpi_evidence_waiting on public.kpi_evidence(submitted_at) where status='pending';
alter table public.kpi_evidence enable row level security;
revoke all on public.kpi_evidence from public,anon,authenticated;
grant select,insert,update,delete on public.kpi_evidence to service_role;

create table if not exists public.property_verifications(
 property_id uuid primary key references public.properties(id) on delete cascade,
 status text not null check(status in ('verified','rejected')),
 reason text check(reason is null or (reason=btrim(reason) and length(reason) between 1 and 300)),
 reviewed_by uuid not null references public.profiles(id),
 reviewed_at timestamptz not null default now());
alter table public.property_verifications enable row level security;
revoke all on public.property_verifications from public,anon,authenticated;
grant select,insert,update,delete on public.property_verifications to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('kpi-evidence','kpi-evidence',false,5242880,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;

-- ------------------------------------------------------------------ helpers
create or replace function public.kpi_evidence_json(e public.kpi_evidence) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',e.id,'agent',(select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid) from public.profiles p where p.id=e.agent_id),
  'kind',e.kind,'day',e.activity_date,'week',public.kpi_week_start(e.activity_date),'url',e.url,'platform',e.platform,
  'project',e.project_name,'has_photo',e.storage_path is not null,'size_bytes',e.size_bytes,'status',e.status,'reason',e.review_reason,
  'reviewed_by',(select jsonb_build_object('id',p.id,'name',p.name) from public.profiles p where p.id=e.reviewed_by),
  'reviewed_at',e.reviewed_at,'submitted_at',e.submitted_at)
$$;
-- Owner details are present: a name and a phone (never returned here).
create or replace function public.inventory_owner_details(p_property uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.property_owner_contacts c where c.property_id=p_property
  and length(btrim(coalesce(c.owner_name,'')))>0 and length(btrim(coalesce(c.owner_phone,'')))>0)
$$;

-- ------------------------------------------------------------- agents: add
-- A link (social, video) or a visit photo already stored by the server
-- (visit). Links are for today (up to 5 social links a day, 20 videos a week);
-- visit photos are for a day of this week up to today. The server checks
-- and normalizes links (url_key) and the image (type, size, hash); this
-- checks again what it can.
create or replace function public.kpi_evidence_add(p_actor uuid,p_data jsonb,p_request text,p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path='' as $$
declare today date=public.kpi_today(p_now);v_kind text;v_day date;e public.kpi_evidence;
begin
 perform 1 from public.profiles where id=p_actor and active and role='agent' for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if jsonb_typeof(p_data) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_data) k
  where k not in ('kind','url','url_key','platform','project','visit_date','storage_path','file_hash','mime_type','size_bytes')) then
  raise exception 'Invalid evidence' using errcode='22023';end if;
 v_kind=p_data->>'kind';
 perform pg_advisory_xact_lock(hashtext('kpi_evidence:'||p_actor::text));
 if v_kind in ('social','video') then
  -- Links count for the day they are added.
  v_day=today;
  if v_kind='social' and (select count(*) from public.kpi_evidence x where x.agent_id=p_actor and x.kind='social' and x.activity_date=v_day)>=5 then
   raise exception 'You can add up to 5 social media links a day' using errcode='22023';end if;
  if v_kind='video' and (select count(*) from public.kpi_evidence x where x.agent_id=p_actor and x.kind='video'
   and x.activity_date>=public.kpi_week_start(today))>=20 then
   raise exception 'You can add up to 20 video links a week' using errcode='22023';end if;
  if (v_kind='social' and exists(select 1 from public.kpi_evidence x where x.kind='social' and x.agent_id=p_actor
    and x.activity_date=v_day and x.url_key=p_data->>'url_key'))
   or (v_kind='video' and exists(select 1 from public.kpi_evidence x where x.kind='video' and x.url_key=p_data->>'url_key')) then
   raise exception 'This link was already added' using errcode='23505';end if;
  insert into public.kpi_evidence(agent_id,kind,activity_date,url,url_key,platform,submitted_at)
   values(p_actor,v_kind,v_day,p_data->>'url',p_data->>'url_key',p_data->>'platform',p_now) returning * into e;
 elsif v_kind='visit' then
  begin v_day=(p_data->>'visit_date')::date;
  exception when others then raise exception 'Choose the visit date' using errcode='22023';end;
  if v_day is null or v_day>today or v_day<public.kpi_week_start(today) then
   raise exception 'Choose a visit date in this week, up to today' using errcode='22023';end if;
  if length(btrim(coalesce(p_data->>'project','')))<2 or length(btrim(p_data->>'project'))>120 then
   raise exception 'Name the project (2 to 120 characters)' using errcode='22023';end if;
  if coalesce(p_data->>'storage_path','') !~ ('^'||p_actor::text||'/[0-9a-f-]{36}$') then
   raise exception 'Invalid evidence' using errcode='22023';end if;
  if exists(select 1 from public.kpi_evidence x where x.kind='visit' and x.file_hash=p_data->>'file_hash') then
   raise exception 'This photo was already uploaded' using errcode='23505';end if;
  insert into public.kpi_evidence(agent_id,kind,activity_date,project_name,storage_path,file_hash,mime_type,size_bytes,submitted_at)
   values(p_actor,v_kind,v_day,regexp_replace(btrim(p_data->>'project'),'\s+',' ','g'),p_data->>'storage_path',p_data->>'file_hash',
    p_data->>'mime_type',(p_data->>'size_bytes')::integer,p_now)
   returning * into e;
 else
  raise exception 'Invalid evidence' using errcode='22023';
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'kpi.evidence_added','kpi_evidence',e.id::text,p_request,
   jsonb_build_object('kind',e.kind,'day',e.activity_date,'platform',e.platform,'project',e.project_name));
 return public.kpi_evidence_json(e);
end $$;

-- ---------------------------------------------------- administrators: review
-- Approve or reject (with an optional reason); a decision can be changed
-- later, and every decision is in the audit log with before and after.
create or replace function public.kpi_evidence_review(p_actor uuid,p_id uuid,p_status text,p_reason text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.kpi_evidence;before_status text;v_reason text=nullif(btrim(coalesce(p_reason,'')),'');
begin
 perform public.accounts_admin(p_actor);
 if p_status not in ('approved','rejected') then raise exception 'Choose approve or reject' using errcode='22023';end if;
 if length(v_reason)>300 then raise exception 'Use a reason of up to 300 characters' using errcode='22023';end if;
 select * into e from public.kpi_evidence where id=p_id for update;
 if not found then raise exception 'Evidence not found' using errcode='P0002';end if;
 if e.status=p_status and e.review_reason is not distinct from v_reason then return public.kpi_evidence_json(e);end if;
 before_status=e.status;
 update public.kpi_evidence set status=p_status,review_reason=v_reason,reviewed_by=p_actor,reviewed_at=now() where id=p_id returning * into e;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'kpi.evidence_'||p_status,'kpi_evidence',e.id::text,p_request,
   jsonb_build_object('agent_id',e.agent_id,'kind',e.kind,'day',e.activity_date,'before',before_status,'reason',v_reason));
 return public.kpi_evidence_json(e);
end $$;

-- Evidence, newest first: an agent's own, or (administrators) anyone's.
-- Query keys: agent, kind, status, from, to (Pakistan days), page, limit.
create or replace function public.kpi_evidence_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;q jsonb=coalesce(p_query,'{}');v_agent uuid;v_from date;v_to date;v_page integer;v_limit integer;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null or actor.role not in ('admin','agent') then raise exception 'Access denied' using errcode='42501';end if;
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_object_keys(q) k where k not in ('agent','kind','status','from','to','page','limit'))
  or (q ? 'kind' and q->>'kind' not in ('social','video','visit')) or (q ? 'status' and q->>'status' not in ('pending','approved','rejected')) then
  raise exception 'Invalid evidence filters' using errcode='22023';end if;
 begin
  v_agent=nullif(q->>'agent','')::uuid;v_from=(q->>'from')::date;v_to=(q->>'to')::date;
  v_page=coalesce((q->>'page')::integer,1);v_limit=coalesce((q->>'limit')::integer,25);
 exception when others then raise exception 'Invalid evidence filters' using errcode='22023';end;
 if v_page not between 1 and 100000 or v_limit not between 1 and 100 then raise exception 'Invalid evidence filters' using errcode='22023';end if;
 if actor.role='agent' then
  if v_agent is not null and v_agent<>p_actor then raise exception 'You can only see your own evidence' using errcode='42501';end if;
  v_agent=p_actor;
 end if;
 with hits as (
  select e.* from public.kpi_evidence e where (v_agent is null or e.agent_id=v_agent) and (q->>'kind' is null or e.kind=q->>'kind')
   and (q->>'status' is null or e.status=q->>'status') and (v_from is null or e.activity_date>=v_from) and (v_to is null or e.activity_date<=v_to))
 select jsonb_build_object('count',(select count(*) from hits),'page',v_page,'limit',v_limit,
  'data',coalesce((select jsonb_agg(public.kpi_evidence_json(h) order by h.submitted_at desc,h.id)
   from (select * from hits order by submitted_at desc,id limit v_limit offset (v_page-1)*v_limit) h),'[]'::jsonb))
 into result;
 return result;
end $$;

-- Where a visit photo is stored, for its owner or an administrator.
create or replace function public.kpi_evidence_photo(p_actor uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;e public.kpi_evidence;
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 select * into e from public.kpi_evidence where id=p_id;
 if actor.id is null or e.id is null or e.storage_path is null or not (actor.role='admin' or e.agent_id=p_actor) then
  raise exception 'Photo not found' using errcode='P0002';end if;
 return jsonb_build_object('storage_path',e.storage_path,'mime_type',e.mime_type);
end $$;

-- ------------------------------------------------- inventory verification
-- An administrator verifies or rejects an agent's listing, or clears the
-- decision (waiting again). Verified needs the owner's name and phone.
create or replace function public.kpi_inventory_review(p_actor uuid,p_property uuid,p_status text,p_reason text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prop public.properties;before public.property_verifications;v_reason text=nullif(btrim(coalesce(p_reason,'')),'');
begin
 perform public.accounts_admin(p_actor);
 if p_status not in ('verified','rejected','pending') then raise exception 'Choose verify, reject or clear' using errcode='22023';end if;
 if length(v_reason)>300 then raise exception 'Use a reason of up to 300 characters' using errcode='22023';end if;
 select * into prop from public.properties where id=p_property for update;
 if not found or prop.owner_agent_id is null then raise exception 'Choose an agent''s listing' using errcode='P0002';end if;
 if p_status='verified' and not public.inventory_owner_details(p_property) then
  raise exception 'Add the owner''s name and phone before verifying' using errcode='22023';end if;
 select * into before from public.property_verifications where property_id=p_property;
 if p_status='pending' then
  delete from public.property_verifications where property_id=p_property;
 else
  insert into public.property_verifications(property_id,status,reason,reviewed_by,reviewed_at) values(p_property,p_status,v_reason,p_actor,now())
   on conflict(property_id) do update set status=excluded.status,reason=excluded.reason,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at;
 end if;
 if before.status is distinct from (case when p_status='pending' then null else p_status end) or before.reason is distinct from v_reason then
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'inventory.'||case p_status when 'pending' then 'verification_cleared' else p_status end,'properties',p_property::text,p_request,
    jsonb_build_object('property_no',prop.property_no,'agent_id',prop.owner_agent_id,'before',before.status,'reason',v_reason,
     'owner_details',public.inventory_owner_details(p_property)));
 end if;
 return jsonb_build_object('property_id',p_property,'status',p_status,'reason',v_reason);
end $$;

-- Agents' listings with their verification, newest first; never the
-- owner's contact, only whether it is filled in. Agents see their own.
-- Query keys: agent, status (pending, verified, rejected), from, to, page, limit.
create or replace function public.kpi_inventory_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;q jsonb=coalesce(p_query,'{}');v_agent uuid;v_from date;v_to date;v_page integer;v_limit integer;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active for share;
 if actor.id is null or actor.role not in ('admin','agent') then raise exception 'Access denied' using errcode='42501';end if;
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_object_keys(q) k where k not in ('agent','status','from','to','page','limit'))
  or (q ? 'status' and q->>'status' not in ('pending','verified','rejected')) then
  raise exception 'Invalid inventory filters' using errcode='22023';end if;
 begin
  v_agent=nullif(q->>'agent','')::uuid;v_from=(q->>'from')::date;v_to=(q->>'to')::date;
  v_page=coalesce((q->>'page')::integer,1);v_limit=coalesce((q->>'limit')::integer,25);
 exception when others then raise exception 'Invalid inventory filters' using errcode='22023';end;
 if v_page not between 1 and 100000 or v_limit not between 1 and 100 then raise exception 'Invalid inventory filters' using errcode='22023';end if;
 if actor.role='agent' then
  if v_agent is not null and v_agent<>p_actor then raise exception 'You can only see your own inventory' using errcode='42501';end if;
  v_agent=p_actor;
 end if;
 with hits as (
  select p.id,p.property_no,p.title,p.city,p.area_society,p.purpose,p.created_at,p.owner_agent_id,
   (p.created_at at time zone 'Asia/Karachi')::date as day,coalesce(v.status,'pending') status,v.reason,v.reviewed_at,v.reviewed_by
  from public.properties p left join public.property_verifications v on v.property_id=p.id
  where p.owner_agent_id is not null and (v_agent is null or p.owner_agent_id=v_agent)
   and (v_from is null or (p.created_at at time zone 'Asia/Karachi')::date>=v_from) and (v_to is null or (p.created_at at time zone 'Asia/Karachi')::date<=v_to)
   and (q->>'status' is null or coalesce(v.status,'pending')=q->>'status'))
 select jsonb_build_object('count',(select count(*) from hits),'page',v_page,'limit',v_limit,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'property_no',h.property_no,'title',h.title,'city',h.city,'area',h.area_society,
    'purpose',h.purpose,'day',h.day,'created_at',h.created_at,'status',h.status,'reason',h.reason,'reviewed_at',h.reviewed_at,
    'reviewed_by',(select jsonb_build_object('id',r.id,'name',r.name) from public.profiles r where r.id=h.reviewed_by),
    'agent',(select jsonb_build_object('id',a.id,'name',a.name,'uid',a.uid) from public.profiles a where a.id=h.owner_agent_id),
    'owner_details',public.inventory_owner_details(h.id)) order by h.created_at desc,h.id)
   from (select * from hits order by created_at desc,id limit v_limit offset (v_page-1)*v_limit) h),'[]'::jsonb))
 into result;
 return result;
end $$;

-- ------------------------------------------------- what the CRM measures
-- Per agent and Pakistan day in p_from..p_to, the numbers behind the KPIs
-- measured by the CRM (only days with something to count):
-- calls: leads whose first-call deadline fell that day while the agent had
--   them (as Team performance's missed deadlines: not given to anyone else
--   by then, not won by then, nor lost by then unless the lead came from
--   another agent), each once; called on time, late or not yet (waiting:
--   the deadline is still ahead); attempts = the agent's calls on them
--   recorded after the assignment and made by the deadline (a call made
--   before the assignment counts from it, as the first call does);
--   answered = leads with an answered (connected) call among those, as
--   Reports count answered calls;
-- social and video: links by day and status; visits: photos by visit date
--   and status, and distinct approved projects that day;
-- inventory: the agent's listings added that day, verified (with the
--   owner's name and phone), rejected and waiting.
create or replace function public.kpi_measures(p_from date,p_to date,p_agent uuid,p_now timestamptz) returns jsonb
language sql stable security definer set search_path='' as $$
 with bounds as (
  select (p_from::timestamp at time zone 'Asia/Karachi') lo,((p_to+1)::timestamp at time zone 'Asia/Karachi') hi
 ), due as (
  select distinct on (a.agent_id,a.lead_id,(a.call_due_at at time zone 'Asia/Karachi')::date)
   a.agent_id,a.lead_id,a.created_at,a.call_due_at,a.first_call_at,(a.call_due_at at time zone 'Asia/Karachi')::date as day
  from public.assignments a join public.active_leads l on l.id=a.lead_id, bounds b
  where a.agent_id is not null and (p_agent is null or a.agent_id=p_agent) and a.call_due_at>=b.lo and a.call_due_at<b.hi
   and not exists(select 1 from public.assignments n where n.lead_id=a.lead_id and (n.created_at,n.id)>(a.created_at,a.id)
    and n.created_at<=a.call_due_at)
   and coalesce((select h.to_status from public.lead_status_history h where h.lead_id=a.lead_id and h.created_at<=a.call_due_at
     order by h.created_at desc,h.id desc limit 1),'new') not in ('won',
    case when exists(select 1 from public.assignments o where o.lead_id=a.lead_id and o.agent_id is not null
     and o.agent_id<>a.agent_id and (o.created_at,o.id)<(a.created_at,a.id)) then 'won' else 'lost' end)
  order by a.agent_id,a.lead_id,(a.call_due_at at time zone 'Asia/Karachi')::date,a.created_at,a.id
 ), calls as (
  select d.agent_id,d.day,jsonb_build_object('due',count(*),
   'on_time',count(*) filter(where d.first_call_at is not null and d.first_call_at<=d.call_due_at),
   'late',count(*) filter(where d.first_call_at>d.call_due_at),
   'not_called',count(*) filter(where d.first_call_at is null),
   'waiting',count(*) filter(where d.first_call_at is null and d.call_due_at>p_now),
   'answered',count(*) filter(where d.answered),'attempts',sum(d.attempts)) v
  from (select d.*,x.attempts,x.answered from due d cross join lateral (
    select count(*) attempts,coalesce(bool_or(c.status='completed'),false) answered from public.calls c
    where c.lead_id=d.lead_id and c.created_at>=d.created_at and greatest(c.started_at,d.created_at)<=d.call_due_at
     and coalesce(public.report_recorded_by('calls',c.id),c.agent_id)=d.agent_id) x) d group by 1,2
 ), ev as (
  select e.agent_id,e.activity_date as day,e.kind,jsonb_build_object('submitted',count(*),
   'pending',count(*) filter(where e.status='pending'),'approved',count(*) filter(where e.status='approved'),
   'rejected',count(*) filter(where e.status='rejected'),
   'visits',count(distinct lower(e.project_name)) filter(where e.kind='visit' and e.status='approved')) v
  from public.kpi_evidence e where (p_agent is null or e.agent_id=p_agent) and e.activity_date between p_from and p_to
  group by 1,2,3
 ), inv as (
  select p.owner_agent_id agent_id,(p.created_at at time zone 'Asia/Karachi')::date as day,jsonb_build_object('uploaded',count(*),
   'verified',count(*) filter(where v.status='verified' and public.inventory_owner_details(p.id)),
   'rejected',count(*) filter(where v.status='rejected'),
   'pending',count(*) filter(where v.status is null or (v.status='verified' and not public.inventory_owner_details(p.id)))) v
  from public.properties p left join public.property_verifications v on v.property_id=p.id, bounds b
  where p.owner_agent_id is not null and (p_agent is null or p.owner_agent_id=p_agent) and p.created_at>=b.lo and p.created_at<b.hi
  group by 1,2
 ), keys as (
  select agent_id,day from calls union select agent_id,day from ev union select agent_id,day from inv
 )
 select coalesce(jsonb_agg(jsonb_build_object('agent_id',k.agent_id,'day',k.day,
   'calls',(select c.v from calls c where c.agent_id=k.agent_id and c.day=k.day),
   'social',(select e.v from ev e where e.agent_id=k.agent_id and e.day=k.day and e.kind='social'),
   'video',(select e.v from ev e where e.agent_id=k.agent_id and e.day=k.day and e.kind='video'),
   'visits',(select e.v from ev e where e.agent_id=k.agent_id and e.day=k.day and e.kind='visit'),
   'inventory',(select i.v from inv i where i.agent_id=k.agent_id and i.day=k.day)) order by k.agent_id,k.day),'[]'::jsonb)
 from keys k
$$;

-- Small, checked edits of update 070's functions, as in updates 061 to 071:
-- each text must appear exactly once, or the update stops and changes
-- nothing. On a rerun the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- Rules as the pages read them, with how the KPI is measured.
  ('public.kpi_version_json(kpi_versions)',
   $t$'answer_type',v.answer_type,'target',v.target,'active',v.active,'agent_ids',to_jsonb(v.agent_ids))$t$,
   $t$'answer_type',v.answer_type,'target',v.target,'active',v.active,'agent_ids',to_jsonb(v.agent_ids),'measure',v.measure)$t$),
  -- New rules keep how the KPI is measured; a KPI the CRM fills in keeps
  -- its frequency and answer type.
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids) then$t$,
   $t$ -- Update 072: how a KPI is measured is part of its rules, and a KPI the
 -- CRM fills in keeps its frequency and answer type.
 if latest.measure<>'self' and (nxt.frequency,nxt.answer_type) is distinct from (latest.frequency,latest.answer_type) then
  raise exception 'This KPI is filled in by the CRM: its frequency and answer type stay as they are' using errcode='22023';end if;
 if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,cur.measure) then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids) and latest.effective_from>p_today then$t$,
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids,latest.measure) and latest.effective_from>p_today then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$  update public.kpi_versions set answer_type=nxt.answer_type,target=nxt.target,active=nxt.active,agent_ids=nxt.agent_ids,$t$,
   $t$  update public.kpi_versions set answer_type=nxt.answer_type,target=nxt.target,active=nxt.active,agent_ids=nxt.agent_ids,measure=nxt.measure,$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor);$t$,
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by,measure)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor,nxt.measure);$t$),
  -- A KPI the CRM fills in is not answered by the agent.
  ('public.kpi_submit(uuid,date,jsonb,text,timestamp with time zone)',
   $t$  if v.frequency='day' and p_day<>today then
   raise exception 'Daily KPIs can only be answered on the day' using errcode='22023';end if;$t$,
   $t$  if v.frequency='day' and p_day<>today then
   raise exception 'Daily KPIs can only be answered on the day' using errcode='22023';end if;
  -- Update 072: the CRM fills these in.
  if v.measure<>'self' then
   raise exception '% is filled in by the CRM, not answered',k.title using errcode='22023';end if;$t$),
  -- The facts include what the CRM measures.
  ('public.kpi_facts(uuid,date,date,uuid,timestamp with time zone)',
   $t$   'answers',coalesce((select jsonb_agg(jsonb_build_object('kpi_id',s.kpi_id,'agent_id',s.agent_id,'day',s.activity_date,'version',s.version,$t$,
   $t$   -- Update 072: what the CRM measures, per agent and day.
   'measures',public.kpi_measures(span_from,span_to,p_agent,p_now),
   'answers',coalesce((select jsonb_agg(jsonb_build_object('kpi_id',s.kpi_id,'agent_id',s.agent_id,'day',s.activity_date,'version',s.version,$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 072 found an unexpected version of %: apply CRM updates up to 071 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- ------------------------------------------- the first five KPIs switch over
-- Found by the questions update 070 gave them (or the ones given here, on a
-- rerun). A KPI whose rules started this period and that no one has
-- answered under switches now; otherwise from the next period. A change
-- already waiting for the next period keeps its rules and gains the
-- measure. Weekly questions lose "today"; descriptions say how each counts.
do $switch$
declare today date=public.kpi_today(now());item record;k public.kpis;cur public.kpi_versions;latest public.kpi_versions;start date;
begin
 for item in select * from (values
  ('Did you answer your assigned calls today?','Did you answer your assigned calls today?','calls','day','yes_no',
   'Filled in by the CRM: Yes when every lead whose first-call deadline fell on the day got your call by then, whatever the outcome.'),
  ('Did you complete your social media activity today?','Did you complete your social media activity today?','social','day','yes_no',
   'Add up to 5 links (Facebook, Instagram, TikTok or YouTube) for the day. Yes once an administrator approves one.'),
  ('How many project visits did you complete today?','How many project visits did you complete?','visits','week','number',
   'Upload one photo for each visit, with the project and the date. A visit counts once an administrator approves its photo. Target: 3 visits a week.'),
  ('How many verified property inventories with owner details did you complete today?','How many verified property inventories with owner details did you complete today?','inventory','day','number',
   'Counted from your inventory: listings added that day with the owner''s name and phone, once an administrator verifies them.'),
  ('How many videos did you complete for the HD Marketing page today?','How many videos did you complete for the HD Marketing page?','video','week','number',
   'Add the link to each finished video. A video counts once an administrator approves it. Target: 1 video a week.')
 ) s(old_question,new_question,measure,frequency,answer_type,description) loop
  select * into k from public.kpis where question in (item.old_question,item.new_question) and archived_at is null order by position,created_at limit 1;
  if k.id is null then raise notice 'KPI not found, left as it is: %',item.old_question;continue;end if;
  cur=public.kpi_version_on(k.id,today);
  select * into latest from public.kpi_versions where kpi_id=k.id order by effective_from desc limit 1;
  update public.kpis set question=item.new_question,description=item.description,updated_at=now()
   where id=k.id and (question,description) is distinct from (item.new_question,item.description);
  if latest.measure=item.measure then continue;end if;
  if cur.kpi_id is null or (latest.frequency,latest.answer_type) is distinct from (item.frequency,item.answer_type) then
   raise notice 'KPI % has other rules (frequency or answer type), left self-reported',k.title;continue;end if;
  if latest.effective_from>today then
   update public.kpi_versions set measure=item.measure where kpi_id=k.id and version=latest.version;
  elsif cur.effective_from=(case when cur.frequency='week' then public.kpi_week_start(today) else today end)
   and not exists(select 1 from public.kpi_submissions s where s.kpi_id=k.id and s.version=cur.version) then
   update public.kpi_versions set measure=item.measure where kpi_id=k.id and version=cur.version;
  else
   start=case when cur.frequency='week' then public.kpi_week_start(today)+7 else today+1 end;
   insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,measure)
    values(k.id,cur.version+1,start,cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,item.measure);
  end if;
  insert into public.audit_log(action,entity,entity_id,metadata)
   values('kpi.measured_by_crm','kpis',k.id::text,jsonb_build_object('title',k.title,'measure',item.measure));
 end loop;
end $switch$;

-- Only the CRM's server calls the new functions; the helpers only from them.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('kpi_evidence_json','inventory_owner_details','kpi_evidence_add','kpi_evidence_review','kpi_evidence_list',
   'kpi_evidence_photo','kpi_inventory_review','kpi_inventory_list','kpi_measures') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname in ('kpi_evidence_add','kpi_evidence_review','kpi_evidence_list','kpi_evidence_photo','kpi_inventory_review','kpi_inventory_list') then
   execute format('grant execute on function %s to service_role',fn.signature);
  else
   execute format('revoke all on function %s from service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
