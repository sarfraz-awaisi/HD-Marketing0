-- Apply once after 021. Preserve customer records, activity history and private storage.
begin;

-- Core prerequisites are checked before any upgrade writes.
do $$ declare missing text; begin
  select string_agg(t.name,', ' order by t.name) into missing from
    (values ('public.profiles'),('public.leads'),('public.followups'),('public.visits'),('public.reminders'),
      ('public.audit_log'),('public.account_security'),('public.account_unlocks'),
      ('public.knowledge_documents'),('public.knowledge_files'),('crm_private.lead_phones')) t(name)
    where to_regclass(t.name) is null;
  if missing is not null then raise exception 'CRM core prerequisites missing: %',missing; end if;
end $$;

-- Ensure the original P2 schema/helpers for partially applied hosted upgrades.
-- Existing rows and the historical reveal/quota behavior are retained.
create table if not exists crm_private.phone_reveals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  revealed_at timestamptz not null default now()
);
create index if not exists phone_reveals_user_time on crm_private.phone_reveals(user_id,revealed_at) include (lead_id);
alter table crm_private.phone_reveals enable row level security;
revoke all on crm_private.phone_reveals from public,anon,authenticated;
grant all on crm_private.phone_reveals to service_role;

create table if not exists public.security_alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  user_id uuid not null references public.profiles(id),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  check ((reviewed_at is null) = (reviewed_by is null))
);
create index if not exists security_alerts_created on public.security_alerts(created_at desc);
create index if not exists security_alerts_unreviewed on public.security_alerts(created_at desc) where reviewed_at is null;
-- One warning and one limit alert per agent/Pakistan day, including after review.
create unique index if not exists phone_alerts_user_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date))
  where type in ('phone_reveal_warning','phone_reveal_limit');
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from public,anon,authenticated;
grant all on public.security_alerts to service_role;

create or replace function public.phone_reveal_window(p_at timestamptz)
returns table(day date,starts_at timestamptz,resets_at timestamptz)
language sql immutable security definer set search_path='' as $$
  select (p_at at time zone 'Asia/Karachi')::date,
    date_trunc('day',p_at at time zone 'Asia/Karachi') at time zone 'Asia/Karachi',
    (date_trunc('day',p_at at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi'
$$;

create or replace function public.phone_reveal_status(p_actor uuid,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer into shown from crm_private.phone_reveals
    where user_id=p_actor and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  return jsonb_build_object('shown_today',shown,'limit',p_limit,'unlimited',actor.role='admin',
    'remaining',case when actor.role='admin' then null else greatest(0,p_limit-shown) end,
    'day',day_window.day,'reset_at',day_window.resets_at);
end $$;

create or replace function public.reveal_phone(p_lead uuid,p_actor uuid,p_request text,p_limit integer default 80)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; day_window record; shown integer; seen boolean;
  number text; alert_id uuid; alert_type text; alert_severity text; alert_message text;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'Invalid daily number limit' using errcode='22023';
  end if;
  -- Serialize quota decisions for the same actor, including across API instances.
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,190901));
  perform 1 from public.leads where id=p_lead and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  select phone into number from crm_private.lead_phones where lead_id=p_lead;
  if number is null then raise exception 'Phone unavailable' using errcode='P0002'; end if;
  select * into day_window from public.phone_reveal_window(now());
  select count(distinct lead_id)::integer,bool_or(lead_id=p_lead) into shown,seen
    from crm_private.phone_reveals where user_id=p_actor
      and revealed_at>=day_window.starts_at and revealed_at<day_window.resets_at;
  if actor.role='agent' and not coalesce(seen,false) and shown>=p_limit then
    alert_type='phone_reveal_limit'; alert_severity='critical';
    alert_message='Daily customer number limit reached.';
  else
    insert into crm_private.phone_reveals(user_id,lead_id) values(p_actor,p_lead);
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'lead.phone_revealed','leads',p_lead::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at')));
    if not coalesce(seen,false) then shown=shown+1; end if;
    if actor.role='agent' and shown>=ceil(p_limit*0.8) then
      alert_type='phone_reveal_warning'; alert_severity='warning';
      alert_message='Agent has reached at least 80% of the daily customer number limit.';
    end if;
  end if;
  if alert_type is not null then
    insert into public.security_alerts(type,severity,user_id,message,metadata)
      values(alert_type,alert_severity,p_actor,alert_message,jsonb_build_object('shown_today',shown,'limit',p_limit))
      on conflict do nothing returning id into alert_id;
    if alert_id is not null then
      insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
        values(p_actor,'security.alert_created','security_alerts',alert_id::text,p_request,
          jsonb_build_object('user_id',p_actor,'fields',jsonb_build_array('type','severity','user_id','created_at')));
    end if;
  end if;
  -- Do not raise on quota refusal: an exception would roll its critical alert back.
  if alert_type='phone_reveal_limit' then
    return public.phone_reveal_status(p_actor,p_limit)||jsonb_build_object('allowed',false);
  end if;
  return public.phone_reveal_status(p_actor,p_limit)||
    jsonb_build_object('allowed',true,'phone',number,'expires_in_seconds',120);
end $$;

create or replace function public.security_alerts_summary(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  return (select jsonb_build_object('count',count(*),'critical',count(*) filter(where severity='critical'),
    'warning',count(*) filter(where severity='warning')) from public.security_alerts where reviewed_at is null);
end $$;

create or replace function public.security_alerts_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,
  p_view text default 'unreviewed',p_severity text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or
    p_view is null or p_view not in ('unreviewed','reviewed','all') or
    (p_severity is not null and p_severity not in ('info','warning','critical')) then
    raise exception 'Invalid alert filters' using errcode='22023';
  end if;
  with filtered as (
    select a.*,p.name as user_name from public.security_alerts a join public.profiles p on p.id=a.user_id
    where (p_view='all' or (p_view='unreviewed' and a.reviewed_at is null) or (p_view='reviewed' and a.reviewed_at is not null))
      and (p_severity is null or a.severity=p_severity)
  ), page as (select * from filtered order by created_at desc,id desc limit p_limit offset (p_page-1)*p_limit)
  select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),
    'count',(select count(*) from filtered),'page',p_page,'limit',p_limit) into result;
  return result;
end $$;

create or replace function public.review_security_alert(p_alert uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare alert public.security_alerts;
begin
  perform 1 from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into alert from public.security_alerts where id=p_alert for update;
  if not found then raise exception 'Alert not found' using errcode='P0002'; end if;
  if alert.reviewed_at is null then
    update public.security_alerts set reviewed_at=now(),reviewed_by=p_actor where id=p_alert returning * into alert;
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,'security.alert_reviewed','security_alerts',alert.id::text,p_request,
        jsonb_build_object('fields',jsonb_build_array('reviewed_at','reviewed_by')));
  end if;
  return to_jsonb(alert);
end $$;

revoke all on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.phone_reveal_window(timestamptz),public.phone_reveal_status(uuid,integer),
  public.reveal_phone(uuid,uuid,text,integer),public.security_alerts_summary(uuid),
  public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text)
  to service_role;


-- Shared assignment write: pending work follows ownership; completed history stays put.
create function public.handover_lead(p_lead uuid,p_actor uuid,p_owner uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare recipient uuid; f integer; v integer; r integer;
begin
  perform pg_advisory_xact_lock(873420);
  perform id from public.profiles where id=p_actor and active and role='admin' for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_owner is not null then
    perform id from public.profiles where id=p_owner and active and role='agent' for share;
    if not found then raise exception 'Choose an active agent' using errcode='22023'; end if;
  end if;
  perform id from public.leads where id=p_lead for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  recipient=coalesce(p_owner,p_actor);
  update public.leads set assigned_agent=p_owner,updated_at=now(),last_activity_at=now() where id=p_lead;
  insert into public.assignments(lead_id,agent_id,actor_id) values(p_lead,p_owner,p_actor);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'assign','leads',p_lead::text,p_request,jsonb_build_object('agent_id',p_owner));
  update public.followups set agent_id=recipient where lead_id=p_lead and status='pending' and agent_id is distinct from recipient;
  get diagnostics f=row_count;
  update public.visits set agent_id=recipient where lead_id=p_lead and status='scheduled' and agent_id is distinct from recipient;
  get diagnostics v=row_count;
  update public.reminders m set agent_id=recipient from public.followups x
    where m.followup_id=x.id and x.lead_id=p_lead and x.status='pending'
      and m.read_at is null and m.due_at>now() and m.agent_id is distinct from recipient;
  get diagnostics r=row_count;
  return jsonb_build_object('followups',f,'visits',v,'reminders',r);
end $$;

-- Keep the general round-robin algorithm and existing four-argument signature.
create or replace function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare chosen uuid;
begin
  perform pg_advisory_xact_lock(873420);
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501'; end if;
  chosen=p_agent;
  if chosen is null then
    select p.id into chosen from public.profiles p left join public.assignments a on a.agent_id=p.id
      where p.active and p.role='agent' group by p.id order by max(a.created_at) nulls first,p.id limit 1;
  end if;
  if chosen is null then raise exception 'No active agent' using errcode='22023'; end if;
  perform public.handover_lead(p_lead,p_actor,chosen,p_request);
  return chosen;
end $$;

create function public.offboard_preview(p_actor uuid,p_session text,p_unlock text,p_agent uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  perform id from public.profiles where id=p_agent and role='agent' for share;
  if not found then raise exception 'Agent account not found' using errcode='P0002'; end if;
  return jsonb_build_object(
    'leads',(select count(*) from public.leads where assigned_agent=p_agent),
    'followups',(select count(*) from public.followups f join public.leads l on l.id=f.lead_id where l.assigned_agent=p_agent and f.status='pending'),
    'visits',(select count(*) from public.visits v join public.leads l on l.id=v.lead_id where l.assigned_agent=p_agent and v.status='scheduled'),
    'reminders',(select count(*) from public.reminders m join public.followups f on f.id=m.followup_id join public.leads l on l.id=f.lead_id
      where l.assigned_agent=p_agent and f.status='pending' and m.read_at is null and m.due_at>now()));
end $$;

create function public.offboard_agent(p_actor uuid,p_session text,p_unlock text,p_agent uuid,p_mode text,p_target uuid,p_request text,p_changes jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source public.profiles; item record; chosen uuid; workload bigint; loads jsonb; counts jsonb; transferred jsonb;
  n integer=0; f integer=0; v integer=0; r integer=0;
begin
  perform pg_advisory_xact_lock(873420);
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_mode is null or p_mode not in ('equal','single','admin')
    or (p_mode='single' and (p_target is null or p_target=p_agent))
    or (p_mode<>'single' and p_target is not null)
    or jsonb_typeof(p_changes) is distinct from 'object' or (p_changes-array['name','role'])<>'{}'::jsonb then
    raise exception 'Invalid handover settings' using errcode='22023'; end if;
  select * into source from public.profiles where id=p_agent for update;
  if not found or source.role<>'agent' then raise exception 'Agent account not found' using errcode='P0002'; end if;
  perform id from public.profiles where active and role='agent' and id<>p_agent order by id for share;
  if p_mode='single' and not exists(select 1 from public.profiles where id=p_target and active and role='agent') then
    raise exception 'Choose an active agent' using errcode='22023'; end if;
  perform id from public.leads where assigned_agent=p_agent order by id for update;
  if p_mode='equal' then
    select coalesce(jsonb_object_agg(p.id::text,(select count(*) from public.leads l where l.assigned_agent=p.id and l.status not in ('won','lost'))),'{}'::jsonb)
      into loads from public.profiles p where p.active and p.role='agent' and p.id<>p_agent;
    if loads='{}'::jsonb and exists(select 1 from public.leads where assigned_agent=p_agent) then
      raise exception 'No other active agents. Choose Keep with admin.' using errcode='22023'; end if;
  end if;
  update public.profiles set active=false where id=p_agent;
  delete from public.account_unlocks where admin_id=p_agent;
  for item in select id from public.leads where assigned_agent=p_agent order by id loop
    chosen=p_target;
    if p_mode='equal' then
      select key::uuid,value::bigint into chosen,workload from jsonb_each_text(loads) order by value::bigint,key limit 1;
      loads=jsonb_set(loads,array[chosen::text],to_jsonb(workload+1));
    end if;
    if p_mode='admin' then
      transferred=public.handover_lead(item.id,p_actor,null,p_request);
    else
      -- Use the unchanged assignment history/audit path, then count transferred work.
      select jsonb_build_object(
        'followups',(select count(*) from public.followups where lead_id=item.id and status='pending' and agent_id is distinct from chosen),
        'visits',(select count(*) from public.visits where lead_id=item.id and status='scheduled' and agent_id is distinct from chosen),
        'reminders',(select count(*) from public.reminders m join public.followups x on x.id=m.followup_id where x.lead_id=item.id and x.status='pending' and m.read_at is null and m.due_at>now() and m.agent_id is distinct from chosen)) into transferred;
      perform public.assign_lead(item.id,p_actor,chosen,p_request);
    end if;
    n=n+1; f=f+(transferred->>'followups')::integer; v=v+(transferred->>'visits')::integer; r=r+(transferred->>'reminders')::integer;
  end loop;
  if p_changes<>'{}'::jsonb then
    perform public.update_account(p_actor,p_session,p_unlock,p_agent,p_changes,p_request);
  end if;
  counts=jsonb_build_object('leads',n,'followups',f,'visits',v,'reminders',r,'mode',p_mode,'target',p_target);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'offboard_agent','profiles',p_agent::text,p_request,counts);
  return counts||jsonb_build_object('id',p_agent,'active',false);
end $$;

-- Client KYC belongs to its document so all its attachments inherit one live rule.
alter table public.knowledge_documents add column lead_id uuid references public.leads(id);
create index knowledge_documents_lead on public.knowledge_documents(lead_id) where lead_id is not null;
create function public.require_kyc_client() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.category='client_kyc' and new.lead_id is null then
    if tg_op='INSERT' then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
    if old.category<>'client_kyc' or old.lead_id is not null then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
  end if;
  return new;
end $$;
create trigger require_kyc_client before insert or update on public.knowledge_documents for each row execute function public.require_kyc_client();

create function public.knowledge_document_access(p_id uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; doc public.knowledge_documents; client public.leads;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  select * into doc from public.knowledge_documents where id=p_id for share;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if doc.category='client_kyc' then
    select * into client from public.leads where id=doc.lead_id for share;
    if actor.role<>'admin' and (client.id is null or client.assigned_agent is distinct from p_actor) then
      raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  return to_jsonb(doc)||jsonb_build_object('lead_name',client.name);
end $$;

create function public.read_knowledge_document(p_id uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare doc jsonb; files jsonb;
begin
  doc=public.knowledge_document_access(p_id,p_actor);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'file_name',file_name,'mime_type',mime_type,'size_bytes',size_bytes,'created_at',created_at) order by created_at,id),'[]'::jsonb)
    into files from public.knowledge_files where document_id=p_id;
  return doc||jsonb_build_object('files',files);
end $$;

create function public.read_knowledge_file(p_document uuid,p_file uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare file public.knowledge_files;
begin
  perform public.knowledge_document_access(p_document,p_actor);
  select * into file from public.knowledge_files where document_id=p_document and id=p_file for share;
  if not found then raise exception 'File not found' using errcode='P0002'; end if;
  return to_jsonb(file);
end $$;
create function public.authorize_knowledge_download(p_document uuid,p_file uuid,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare file jsonb;
begin
  file=public.read_knowledge_file(p_document,p_file,p_actor);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'download_file','knowledge_documents',p_document::text,p_request,jsonb_build_object('file_id',p_file));
  return file;
end $$;

create function public.knowledge_documents_page(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text,p_lead uuid default null,p_unlinked boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; rows jsonb; total bigint;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Active team access required' using errcode='42501'; end if;
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or p_search is null or length(p_search)>100 or p_category is null or p_unlinked is null
    or p_category not in ('','documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements') then
    raise exception 'Invalid document filters' using errcode='22023'; end if;
  if p_unlinked and actor.role<>'admin' then raise exception 'Entry not found' using errcode='P0002'; end if;
  if p_lead is not null then
    perform id from public.leads where id=p_lead and (actor.role='admin' or assigned_agent=p_actor) for share;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  with eligible as (
    select d.id,d.title,d.category,d.property_name,d.keywords,d.created_at,d.updated_at,d.lead_id,
      case when d.category='client_kyc' then l.name end as lead_name,
      (select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'file_name',f.file_name,'mime_type',f.mime_type,'size_bytes',f.size_bytes,'created_at',f.created_at) order by f.created_at,f.id),'[]'::jsonb) from public.knowledge_files f where f.document_id=d.id) files
    from public.knowledge_documents d left join public.leads l on l.id=d.lead_id
    where (d.category<>'client_kyc' or actor.role='admin' or l.assigned_agent=p_actor)
      and (p_category='' or d.category=p_category)
      and (p_lead is null or (d.category='client_kyc' and d.lead_id=p_lead))
      and (not p_unlinked or (d.category='client_kyc' and d.lead_id is null))
      and (p_search='' or position(lower(p_search) in lower(d.title||' '||d.property_name||' '||d.keywords||' '||d.content))>0)
  ), page_rows as (select * from eligible order by updated_at desc,id offset (p_page-1)*p_limit limit p_limit)
  select coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id) from page_rows r),'[]'::jsonb),(select count(*) from eligible) into rows,total;
  return jsonb_build_object('data',rows,'count',total,'page',p_page,'limit',p_limit);
end $$;
create or replace function public.list_knowledge_documents(p_actor uuid,p_page integer,p_limit integer,p_search text,p_category text)
returns jsonb language sql security definer set search_path='' as $$
  select public.knowledge_documents_page(p_actor,p_page,p_limit,p_search,p_category,null,false)
$$;

create function public.search_kyc_clients(p_actor uuid,p_search text,p_limit integer,p_selected uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
  perform public.accounts_admin(p_actor);
  if p_search is null or length(p_search)>100 or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Invalid client search' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
    select id,name,masked_phone from public.leads where
      (p_selected is not null and id=p_selected) or (p_selected is null and (p_search='' or position(lower(p_search) in lower(name))>0))
      order by name,id limit p_limit
  ) x;
  return rows;
end $$;

-- Alert on work stranded by a direct profile edit; never hand it over automatically.
create unique index inactive_owner_alert_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date)) where type='inactive_agent_leads';
create function public.report_inactive_lead_owners()
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner record; alert_id uuid; actor uuid; n integer=0;
begin
  if not pg_try_advisory_xact_lock(hashtext('hd_job_inactive_owners')) then return '{"skipped":true}'::jsonb; end if;
  perform pg_advisory_xact_lock(873420);
  select id into actor from public.profiles where active and role='admin' order by id limit 1;
  for owner in select p.id,count(*)::integer leads from public.profiles p join public.leads l on l.assigned_agent=p.id where not p.active group by p.id order by p.id loop
    insert into public.security_alerts(type,severity,user_id,message,metadata)
      values('inactive_agent_leads','critical',owner.id,'Inactive account still owns customer work. An administrator must hand it over.',jsonb_build_object('leads',owner.leads))
      on conflict do nothing returning id into alert_id;
    if alert_id is not null then
      n=n+1;
      insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
        values(actor,'inactive_agent_work_found','profiles',owner.id::text,'job:inactive-lead-owners',jsonb_build_object('leads',owner.leads,'alert_id',alert_id));
    end if;
  end loop;
  return jsonb_build_object('affected',n);
end $$;

-- Remaining overrides and grants follow below.

create or replace function public.update_account(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.profiles; result public.profiles;
begin
  -- Serialize account-role/access edits before locking administrator rows.
  perform pg_advisory_xact_lock(873420);
  perform pg_advisory_xact_lock(873436);
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}'::jsonb or (p_data-array['name','role','active'])<>'{}'::jsonb
    or (p_data?'name' and (jsonb_typeof(p_data->'name')<>'string' or length(btrim(p_data->>'name')) not between 1 and 200))
    or (p_data?'role' and coalesce(p_data->>'role','') not in ('admin','agent'))
    or (p_data?'active' and jsonb_typeof(p_data->'active') is distinct from 'boolean') then raise exception 'Invalid account fields' using errcode='22023'; end if;
  select * into target from public.profiles where id=p_target for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if target.role='agent' and p_data?'active' and not (p_data->>'active')::boolean
    and exists(select 1 from public.leads where assigned_agent=p_target) then
    raise exception 'Use the agent handover dialog before disabling an agent with leads' using errcode='22023'; end if;
  if p_target=p_actor and ((p_data?'role' and p_data->>'role'<>'admin') or (p_data?'active' and not (p_data->>'active')::boolean)) then raise exception 'You cannot disable or demote your own administrator account' using errcode='22023'; end if;
  if target.active and target.role='admin' and (coalesce(p_data->>'role',target.role)<>'admin' or not coalesce((p_data->>'active')::boolean,target.active))
    and (select count(*) from public.profiles where role='admin' and active)<=1 then raise exception 'Keep at least one active administrator' using errcode='22023'; end if;
  update public.profiles set name=case when p_data?'name' then btrim(p_data->>'name') else name end,
    role=coalesce(p_data->>'role',role),active=coalesce((p_data->>'active')::boolean,active) where id=p_target returning * into result;
  if not result.active or result.role<>'admin' then delete from public.account_unlocks where admin_id=p_target; end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'manage_account','profiles',p_target::text,p_request,jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
  return to_jsonb(result);
end $$;

create or replace function public.save_knowledge_document(p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_documents; fields jsonb; linked uuid; previous public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or (p_data - array['title','category','content','property_name','keywords','lead_id']) <> '{}'::jsonb
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'content') is distinct from 'string'
    or length(btrim(p_data->>'title')) not between 1 and 200
    or length(btrim(p_data->>'content')) not between 1 and 50000
    or coalesce(p_data->>'category','') not in ('documentation','policy','property_deeds','legal_noc','client_kyc','tenancy_agreements')
    or (p_data?'property_name' and (jsonb_typeof(p_data->'property_name') is distinct from 'string' or length(btrim(p_data->>'property_name'))>200))
    or (p_data?'keywords' and (jsonb_typeof(p_data->'keywords') is distinct from 'string' or length(btrim(p_data->>'keywords'))>500)) then
    raise exception 'Invalid documentation or policy' using errcode='22023';
  end if;
  if p_id is not null then
    select * into previous from public.knowledge_documents where id=p_id for update;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  if p_data?'lead_id' and p_data->'lead_id'<>'null'::jsonb and jsonb_typeof(p_data->'lead_id') is distinct from 'string' then
    raise exception 'Invalid client' using errcode='22023'; end if;
  begin
    linked=case when p_data?'lead_id' then nullif(p_data->>'lead_id','')::uuid else previous.lead_id end;
  exception when invalid_text_representation then raise exception 'Choose an existing client' using errcode='22023'; end;
  if p_data->>'category'='client_kyc' then
    if linked is null then raise exception 'Choose a client for Client KYC' using errcode='22023'; end if;
    perform id from public.leads where id=linked for share;
    if not found then raise exception 'Choose an existing client' using errcode='22023'; end if;
  else linked=null; end if;
  if p_id is null then
    insert into public.knowledge_documents(title,category,content,property_name,keywords,lead_id,created_by,updated_by)
      values(btrim(p_data->>'title'),p_data->>'category',btrim(p_data->>'content'),coalesce(btrim(p_data->>'property_name'),''),coalesce(btrim(p_data->>'keywords'),''),linked,p_actor,p_actor)
      returning * into result;
  else
    update public.knowledge_documents set title=btrim(p_data->>'title'),category=p_data->>'category',
      content=btrim(p_data->>'content'),
      property_name=case when p_data?'property_name' then btrim(p_data->>'property_name') else property_name end,
      keywords=case when p_data?'keywords' then btrim(p_data->>'keywords') else keywords end,
      lead_id=linked,updated_by=p_actor,updated_at=now() where id=p_id returning * into result;
    if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  end if;
  fields=jsonb_build_array('title','category','content');
  if p_data?'property_name' then fields=fields||jsonb_build_array('property_name'); end if;
  if p_data?'keywords' then fields=fields||jsonb_build_array('keywords'); end if;
  if p_data?'lead_id' then fields=fields||jsonb_build_array('lead_id'); end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,case when p_id is null then 'create' else 'update' end,'knowledge_documents',result.id::text,p_request,jsonb_build_object('fields',fields));
  return to_jsonb(result);
end $$;

create or replace function public.attach_knowledge_file(p_document uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result public.knowledge_files; doc public.knowledge_documents;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or not actor.active or actor.role<>'admin' then raise exception 'Administrator access required' using errcode='42501'; end if;
  select * into doc from public.knowledge_documents where id=p_document for update;
  if not found then raise exception 'Entry not found' using errcode='P0002'; end if;
  if doc.category='client_kyc' and doc.lead_id is null then raise exception 'Link Client KYC to a client before attaching files' using errcode='22023'; end if;
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

create or replace function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n int; stale_lead record; admin_id uuid; begin
if not pg_try_advisory_xact_lock(hashtext('hd_job_'||p_job)) then return '{"skipped":true}'::jsonb; end if;
if p_job='followups' then
insert into public.reminders(agent_id,followup_id,due_at) select coalesce(l.assigned_agent,f.agent_id),f.id,f.due_at from public.followups f join public.leads l on l.id=f.lead_id join public.profiles p on p.id=coalesce(l.assigned_agent,f.agent_id) where p.active and f.status='pending' and f.due_at<=now()+interval '1 day' on conflict(followup_id,due_at) do nothing; get diagnostics n=row_count;
elsif p_job='outcomes' then update public.calls set missing_outcome=true where status='completed' and outcome_submitted_at is null and not missing_outcome and ended_at<now()-make_interval(mins=>coalesce((p_settings->>'grace_minutes')::int,30));get diagnostics n=row_count;
elsif p_job='stale' then
perform pg_advisory_xact_lock(873420);
select id into admin_id from public.profiles where role='admin' and active order by id limit 1;n=0;
if admin_id is not null then for stale_lead in select id from public.leads l where (l.assigned_agent is null or exists(select 1 from public.profiles p where p.id=l.assigned_agent and p.active)) and status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('handover_lead','assign_lead','offboard_preview','offboard_agent','update_account',
     'require_kyc_client','knowledge_document_access','read_knowledge_document','read_knowledge_file',
     'authorize_knowledge_download','knowledge_documents_page','list_knowledge_documents','search_kyc_clients',
     'save_knowledge_document','attach_knowledge_file','report_inactive_lead_owners','run_crm_job') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
