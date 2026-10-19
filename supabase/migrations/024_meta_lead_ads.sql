-- Apply once after 023. No external connection or customer data is seeded.
begin;
alter table public.leads add column meta_pending_assignment boolean not null default false;
create index leads_meta_pending on public.leads(created_at desc) where meta_pending_assignment;
create table public.meta_connections(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.profiles(id),provider_user_id text not null unique,
 status text not null default 'connected' check(status in ('connected','attention','disconnected')),
 scopes jsonb not null default '[]',expires_at timestamptz,last_success_at timestamptz,error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table crm_private.meta_credentials(connection_id uuid primary key references public.meta_connections(id),ciphertext text not null);
create table public.meta_pages(
 id text primary key check(id~'^[0-9]{1,40}$'),connection_id uuid not null references public.meta_connections(id),name text not null,
 instagram_id text,instagram_name text,enabled boolean not null default false,subscribed boolean not null default false,
 last_checked_at timestamptz,error_code text);
create table crm_private.meta_page_credentials(page_id text primary key references public.meta_pages(id),ciphertext text not null);
create table public.meta_forms(
 id text primary key check(id~'^[0-9]{1,40}$'),page_id text not null references public.meta_pages(id),name text not null,
 enabled boolean not null default false,questions jsonb not null default '[]',mapping jsonb not null default '{}',last_sync_at timestamptz);
create table crm_private.meta_oauth_states(
 state_hash text primary key,cookie_hash text not null,actor_id uuid not null references public.profiles(id),expires_at timestamptz not null,
 used_at timestamptz,created_at timestamptz not null default now());
create table public.meta_submissions(
 id uuid primary key default gen_random_uuid(),provider_lead_id text not null unique check(provider_lead_id~'^[0-9]{1,40}$'),
 page_id text not null references public.meta_pages(id),form_id text not null references public.meta_forms(id),
 platform text not null default 'meta' check(platform in ('facebook','instagram','meta')),
 ad_id text,ad_name text,adset_id text,adset_name text,campaign_id text,campaign_name text,
 submitted_at timestamptz,received_at timestamptz not null default now(),processed_at timestamptz,
 status text not null default 'queued' check(status in ('queued','processing','retry','created','duplicate','review','failed')),
 lead_id uuid references public.leads(id),attempts integer not null default 0 check(attempts between 0 and 10),
 next_attempt_at timestamptz not null default now(),lease_id uuid,lease_until timestamptz,error_code text,
 warning text,first_assigned_at timestamptz);
create index meta_submissions_queue on public.meta_submissions(next_attempt_at) where status in ('queued','retry','processing');
create index meta_submissions_lead on public.meta_submissions(lead_id);
create table crm_private.meta_answers(submission_id uuid primary key references public.meta_submissions(id),answers jsonb not null default '[]',normalized jsonb not null default '{}',expires_at timestamptz not null);
create table public.meta_notice_reads(actor_id uuid not null references public.profiles(id),submission_id uuid not null references public.meta_submissions(id),read_at timestamptz not null default now(),primary key(actor_id,submission_id));
-- Browser roles never read integrations, raw answers or credentials directly.
do $$ declare t text; begin
 foreach t in array array['public.meta_connections','public.meta_pages','public.meta_forms','public.meta_submissions','public.meta_notice_reads','crm_private.meta_credentials','crm_private.meta_page_credentials','crm_private.meta_oauth_states','crm_private.meta_answers'] loop
 execute format('alter table %s enable row level security',t);execute format('revoke all on %s from public,anon,authenticated',t);execute format('grant all on %s to service_role',t);end loop;
end $$;

create function public.meta_oauth_start(p_actor uuid,p_state text,p_cookie text,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 delete from crm_private.meta_oauth_states where expires_at<now()-interval '1 day';
 insert into crm_private.meta_oauth_states(state_hash,cookie_hash,actor_id,expires_at) values(p_state,p_cookie,p_actor,now()+interval '10 minutes');
 insert into public.audit_log(actor_id,action,entity,request_id) values(p_actor,'meta.connect_requested','meta_connections',p_request);
end $$;
create function public.meta_oauth_consume(p_state text,p_cookie text) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
 update crm_private.meta_oauth_states set used_at=now() where state_hash=p_state and cookie_hash=p_cookie and used_at is null and expires_at>now() returning actor_id into actor;
 if actor is null then raise exception 'Invalid connection session' using errcode='42501';end if;
 perform public.accounts_admin(actor);return actor;
end $$;
create function public.meta_save_connection(p_actor uuid,p_data jsonb,p_request text) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; page jsonb;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 insert into public.meta_connections(owner_id,provider_user_id,scopes,expires_at) values(p_actor,p_data->>'user_id',p_data->'scopes',nullif(p_data->>'expires_at','')::timestamptz)
 on conflict(provider_user_id) do update set owner_id=p_actor,status='connected',scopes=excluded.scopes,expires_at=excluded.expires_at,error_code=null,updated_at=now() returning id into result;
 insert into crm_private.meta_credentials values(result,p_data->>'ciphertext') on conflict(connection_id) do update set ciphertext=excluded.ciphertext;
 -- A reconnect must not keep synchronizing Pages no longer granted by Meta.
 update public.meta_pages set enabled=false,subscribed=false,error_code='reselect_page' where connection_id=result;
 for page in select value from jsonb_array_elements(p_data->'pages') loop
  if exists(select 1 from public.meta_pages where id=page->>'id' and connection_id<>result) then raise exception 'Page already belongs to another connection' using errcode='23505';end if;
  insert into public.meta_pages(id,connection_id,name,instagram_id,instagram_name) values(page->>'id',result,page->>'name',page->>'instagram_id',page->>'instagram_name')
   on conflict(id) do update set name=excluded.name,instagram_id=excluded.instagram_id,instagram_name=excluded.instagram_name,error_code=null;
  insert into crm_private.meta_page_credentials values(page->>'id',page->>'ciphertext') on conflict(page_id) do update set ciphertext=excluded.ciphertext;
 end loop;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.connected','meta_connections',result::text,p_request);return result;
end $$;
create function public.meta_settings(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return jsonb_build_object(
 'connections',(select coalesce(jsonb_agg(to_jsonb(c) order by created_at),'[]') from public.meta_connections c),
 'pages',(select coalesce(jsonb_agg(to_jsonb(p) order by name,id),'[]') from public.meta_pages p),
 'forms',(select coalesce(jsonb_agg(to_jsonb(f) order by name,id),'[]') from public.meta_forms f));end $$;
create function public.meta_page_secret(p_actor uuid,p_page text) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return (select to_jsonb(p)||jsonb_build_object('ciphertext',v.ciphertext) from public.meta_pages p join crm_private.meta_page_credentials v on v.page_id=p.id join public.meta_connections c on c.id=p.connection_id where p.id=p_page and c.status<>'disconnected');end $$;
create function public.meta_save_forms(p_actor uuid,p_page text,p_forms jsonb,p_request text) returns void language plpgsql security definer set search_path='' as $$
declare f jsonb;
begin perform public.accounts_admin(p_actor);
 if not exists(select 1 from public.meta_pages where id=p_page) then raise exception 'Page not found' using errcode='P0002';end if;
 for f in select value from jsonb_array_elements(p_forms) loop
  if exists(select 1 from public.meta_forms where id=f->>'id' and page_id<>p_page) then raise exception 'Invalid form' using errcode='22023';end if;
  insert into public.meta_forms(id,page_id,name,questions) values(f->>'id',p_page,f->>'name',coalesce(f->'questions','[]')) on conflict(id) do update set name=excluded.name,questions=excluded.questions;
 end loop;
 update public.meta_pages set last_checked_at=now() where id=p_page;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.forms_refreshed','meta_pages',p_page,p_request);
end $$;
create function public.meta_configure(p_actor uuid,p_kind text,p_id text,p_enabled boolean,p_mapping jsonb,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_kind='page' then update public.meta_pages set enabled=p_enabled,subscribed=p_enabled,last_checked_at=now(),error_code=null where id=p_id;
 elsif p_kind='form' then
  if jsonb_typeof(p_mapping) is distinct from 'object' or length(p_mapping::text)>8000 or exists(select 1 from jsonb_each_text(p_mapping) where value not in ('name','first_name','last_name','phone','email','preferred_location','budget_min','budget_max','interested_property','property_type','contact_time','message')) then raise exception 'Invalid field mapping' using errcode='22023';end if;
  update public.meta_forms set enabled=p_enabled,mapping=p_mapping where id=p_id;
 else raise exception 'Invalid configuration' using errcode='22023';end if;
 if not found then raise exception 'Page or form not found' using errcode='P0002';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'meta.configuration_changed','meta_'||p_kind,p_id,p_request,jsonb_build_object('enabled',p_enabled));
end $$;
create function public.meta_disconnect(p_actor uuid,p_id uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 update public.meta_connections set status='disconnected',updated_at=now() where id=p_id;
 if not found then raise exception 'Connection not found' using errcode='P0002';end if;
 update public.meta_pages set enabled=false,subscribed=false where connection_id=p_id;
 delete from crm_private.meta_page_credentials where page_id in(select id from public.meta_pages where connection_id=p_id);
 delete from crm_private.meta_credentials where connection_id=p_id;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.disconnected','meta_connections',p_id::text,p_request);
end $$;

create function public.meta_enqueue(p_events jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e jsonb;n integer=0;inserted uuid;
begin
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>1000 then raise exception 'Invalid events' using errcode='22023';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if not exists(select 1 from public.meta_forms f join public.meta_pages p on p.id=f.page_id join public.meta_connections c on c.id=p.connection_id where f.id=e->>'form_id' and p.id=e->>'page_id' and f.enabled and p.enabled and p.subscribed and c.status='connected') then continue;end if;
  insert into public.meta_submissions(provider_lead_id,page_id,form_id,ad_id,submitted_at) values(e->>'lead_id',e->>'page_id',e->>'form_id',e->>'ad_id',nullif(e->>'submitted_at','')::timestamptz) on conflict(provider_lead_id) do nothing returning id into inserted;
  if inserted is not null then n=n+1;insert into public.integration_events(provider,event_id) values('meta',e->>'lead_id') on conflict do nothing;end if;
 end loop;return jsonb_build_object('queued',n);
end $$;
create function public.meta_claim(p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if p_limit not between 1 and 20 then raise exception 'Invalid batch' using errcode='22023';end if;
 with chosen as(select s.id from public.meta_submissions s join public.meta_forms f on f.id=s.form_id join public.meta_pages p on p.id=s.page_id join public.meta_connections c on c.id=p.connection_id
 where f.enabled and p.enabled and c.status='connected' and s.attempts<10 and ((s.status in ('queued','retry') and s.next_attempt_at<=now()) or (s.status='processing' and s.lease_until<now())) order by s.received_at for update of s skip locked limit p_limit),
 claimed as(update public.meta_submissions s set status='processing',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' from chosen where s.id=chosen.id returning s.*)
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('mapping',f.mapping,'ciphertext',v.ciphertext)),'[]') into rows from claimed s join public.meta_forms f on f.id=s.form_id join crm_private.meta_page_credentials v on v.page_id=s.page_id;
 return rows;
end $$;
create function public.meta_finish(p_id uuid,p_lease uuid,p_data jsonb,p_answers jsonb,p_attribution jsonb,p_reason text,p_retention integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions; customer uuid; actor uuid;data jsonb;
begin
 perform pg_advisory_xact_lock(873420);
 select * into s from public.meta_submissions where id=p_id for update;
 if s.id is null or s.status<>'processing' or s.lease_id is distinct from p_lease or s.lease_until<=now() then raise exception 'Stale processing lease' using errcode='40001';end if;
 if not exists(select 1 from public.meta_pages p join public.meta_forms f on f.page_id=p.id join public.meta_connections c on c.id=p.connection_id where p.id=s.page_id and f.id=s.form_id and f.enabled and p.enabled and c.status='connected') then raise exception 'Synchronization disabled' using errcode='40001';end if;
 select id into actor from public.profiles where active and role='admin' order by id limit 1 for share;
 if actor is null then raise exception 'No active administrator' using errcode='42501';end if;
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['name','phone','email','preferred_location','budget_min','budget_max','interested_property','property_type','contact_time','message'])<>'{}' then raise exception 'Invalid normalized data' using errcode='22023';end if;
 if p_retention not between 1 and 90 or p_retention is null or length(p_answers::text)>100000 then raise exception 'Invalid retention or answers' using errcode='22023';end if;
 insert into crm_private.meta_answers values(p_id,p_answers,p_data,now()+make_interval(days=>p_retention)) on conflict(submission_id) do update set answers=excluded.answers,normalized=excluded.normalized,expires_at=excluded.expires_at;
 update public.meta_submissions set platform=case when p_attribution->>'platform' in ('facebook','instagram') then p_attribution->>'platform' else 'meta' end,
 ad_id=coalesce(p_attribution->>'ad_id',ad_id),ad_name=p_attribution->>'ad_name',adset_id=p_attribution->>'adset_id',adset_name=p_attribution->>'adset_name',campaign_id=p_attribution->>'campaign_id',campaign_name=p_attribution->>'campaign_name',
 submitted_at=coalesce(nullif(p_attribution->>'submitted_at','')::timestamptz,submitted_at),warning=p_attribution->>'warning' where id=p_id;
 if p_reason is not null or coalesce(p_data->>'phone','')!~'^\+[0-9]{10,15}$' or length(btrim(coalesce(p_data->>'name',''))) not between 1 and 200 then
  update public.meta_submissions set status='review',error_code=coalesce(p_reason,'invalid_customer'),processed_at=now(),lease_id=null,lease_until=null where id=p_id;
 else
  select lead_id into customer from crm_private.lead_phones where phone=p_data->>'phone';
  if customer is null then
   data=(p_data-array['phone','interested_property','property_type','contact_time','message'])||jsonb_build_object('source','Meta');
   begin
    customer=(public.create_lead(data,p_data->>'phone',actor,'meta:'||s.provider_lead_id)).id;
    update public.leads set meta_pending_assignment=true where id=customer;
    update public.meta_submissions set status='created' where id=p_id;
   exception when unique_violation then
    select lead_id into customer from crm_private.lead_phones where phone=p_data->>'phone';
    if customer is null then raise;end if;
    update public.meta_submissions set status='duplicate' where id=p_id;
   end;
  else update public.meta_submissions set status='duplicate' where id=p_id;end if;
  update public.meta_submissions set lead_id=customer,processed_at=now(),error_code=null,lease_id=null,lease_until=null where id=p_id;
 end if;
 update public.meta_forms set last_sync_at=now() where id=s.form_id;
 update public.meta_connections set last_success_at=now(),error_code=null where id=(select connection_id from public.meta_pages where id=s.page_id);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(actor,'meta.submission_processed','meta_submissions',p_id::text,'meta:'||s.provider_lead_id,jsonb_build_object('status',(select status from public.meta_submissions where id=p_id),'lead_id',customer));
 return jsonb_build_object('id',p_id,'lead_id',customer,'status',(select status from public.meta_submissions where id=p_id));
end $$;
create function public.meta_fail(p_id uuid,p_lease uuid,p_code text,p_retry boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions;
begin
 select * into s from public.meta_submissions where id=p_id for update;
 if not found or s.lease_id is distinct from p_lease or s.status<>'processing' then return;end if;
 update public.meta_submissions set status=case when p_retry and attempts<10 then 'retry' else 'failed' end,error_code=left(p_code,80),next_attempt_at=now()+make_interval(secs=>least(21600,30*power(2,least(attempts,9)))::integer),lease_id=null,lease_until=null where id=p_id;
 if p_code in ('authorization_expired','permission_denied') then update public.meta_connections set status='attention',error_code=p_code,updated_at=now() where id=(select connection_id from public.meta_pages where id=s.page_id);end if;
 insert into public.audit_log(action,entity,entity_id,metadata) values('meta.processing_failed','meta_submissions',p_id::text,jsonb_build_object('code',left(p_code,80),'attempt',s.attempts));
end $$;
create function public.meta_retry(p_actor uuid,p_id uuid,p_request text) returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);update public.meta_submissions set status='queued',attempts=0,next_attempt_at=now(),error_code=null,lease_id=null,lease_until=null where id=p_id and status in ('failed','review','retry');if not found then raise exception 'Submission is not retryable' using errcode='22023';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.retry_requested','meta_submissions',p_id::text,p_request);end $$;
create function public.meta_resolve(p_actor uuid,p_id uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare lease uuid;answers jsonb;previous jsonb;attr jsonb;result jsonb;
begin perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select to_jsonb(s) into attr from public.meta_submissions s where id=p_id and status='review' for update;
 if attr is null then raise exception 'Review item not found' using errcode='P0002';end if;
 select a.answers,a.normalized into answers,previous from crm_private.meta_answers a where submission_id=p_id and expires_at>now();
 if answers is null then raise exception 'Answers expired; retry retrieval first' using errcode='22023';end if;
 lease=gen_random_uuid();update public.meta_submissions set status='processing',lease_id=lease,lease_until=now()+interval '1 minute' where id=p_id;
 result=public.meta_finish(p_id,lease,previous||p_data,answers,attr,null,30);
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.review_resolved','meta_submissions',p_id::text,p_request);return result;
end $$;

-- First assignment is explicit, active-admin controlled. Scheduled round-robin cannot unlock it.
create function public.meta_first_assignment_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.meta_pending_assignment and (new.assigned_agent is distinct from old.assigned_agent or not new.meta_pending_assignment)
   and current_setting('hd.meta_explicit_assignment',true) is distinct from old.id::text then
  raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
 return new;
end $$;
create trigger meta_first_assignment_guard before update on public.leads for each row execute function public.meta_first_assignment_guard();
alter function public.assign_lead(uuid,uuid,uuid,text) rename to assign_lead_023;
create function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare pending boolean;chosen uuid;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select meta_pending_assignment into pending from public.leads where id=p_lead for update;
 if pending then
  if p_agent is null or coalesce(p_request,'') like 'job:%' then raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
  perform set_config('hd.meta_explicit_assignment',p_lead::text,true);
 end if;
 chosen=public.assign_lead_023(p_lead,p_actor,p_agent,p_request);
 if pending then
  update public.leads set meta_pending_assignment=false where id=p_lead;
  update public.meta_submissions set first_assigned_at=now() where lead_id=p_lead and status='created' and first_assigned_at is null;
  perform set_config('hd.meta_explicit_assignment','',true);
 end if;return chosen;
end $$;
create function public.meta_assign(p_actor uuid,p_leads uuid[],p_agent uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target_lead uuid;n integer;
begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_agent is null or not exists(select 1 from public.profiles where id=p_agent and active and role='agent') or cardinality(p_leads) not between 1 and 100 or (select count(distinct x) from unnest(p_leads)x)<>cardinality(p_leads) then raise exception 'Select leads and an active agent' using errcode='22023';end if;
 perform 1 from public.leads where id=any(p_leads) and assigned_agent is null and meta_pending_assignment order by id for update;get diagnostics n=row_count;
 if n<>cardinality(p_leads) then raise exception 'Some leads were already assigned. Refresh and select again.' using errcode='40001';end if;
 for target_lead in select l.id from public.leads l where l.id=any(p_leads) order by l.id loop perform public.assign_lead(target_lead,p_actor,p_agent,p_request);end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'meta.bulk_assigned','leads',p_request,jsonb_build_object('count',n,'agent_id',p_agent));
 return jsonb_build_object('assigned',n);
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
if admin_id is not null then for stale_lead in select id from public.leads l where not l.meta_pending_assignment and (l.assigned_agent is null or exists(select 1 from public.profiles p where p.id=l.assigned_agent and p.active)) and status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;

create function public.meta_inbox(p_actor uuid,p_filters jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare records jsonb;total integer;ids uuid[];phones jsonb;result jsonb;lim integer;page integer;
begin
 perform public.accounts_admin(p_actor);lim=coalesce((p_filters->>'limit')::int,20);page=coalesce((p_filters->>'page')::int,1);
 if lim not between 1 and 100 or page not between 1 and 100000 then raise exception 'Invalid page' using errcode='22023';end if;
 with eligible as(
 select s.*,l.name,l.email,l.preferred_location,l.budget_min,l.budget_max,l.status lead_status,l.assigned_agent,l.meta_pending_assignment,p.name agent_name,f.name form_name,
   a.normalized->>'interested_property' interested_property,coalesce(l.name,a.normalized->>'name') customer_name
 from public.meta_submissions s left join public.leads l on l.id=s.lead_id left join public.profiles p on p.id=l.assigned_agent join public.meta_forms f on f.id=s.form_id left join crm_private.meta_answers a on a.submission_id=s.id and a.expires_at>now()
 where (coalesce(p_filters->>'platform','')='' or s.platform=p_filters->>'platform')
 and (coalesce(p_filters->>'status','')='' or s.status=p_filters->>'status')
 and (coalesce(p_filters->>'campaign','')='' or s.campaign_id=p_filters->>'campaign')
 and (coalesce(p_filters->>'form','')='' or s.form_id=p_filters->>'form')
 and (coalesce(p_filters->>'assignment','')='' or (p_filters->>'assignment'='unassigned' and l.meta_pending_assignment and l.assigned_agent is null) or(p_filters->>'assignment'='assigned' and l.assigned_agent is not null))
 and (nullif(p_filters->>'from','') is null or s.received_at>= (p_filters->>'from')::timestamptz)
 and (nullif(p_filters->>'to','') is null or s.received_at< (p_filters->>'to')::timestamptz)
 and (coalesce(p_filters->>'search','')='' or position(lower(p_filters->>'search') in lower(coalesce(l.name,a.normalized->>'name','')||' '||coalesce(l.email,a.normalized->>'email','')||' '||coalesce(s.campaign_name,'')||' '||f.name))>0)
 ),paged as(select * from eligible order by case when p_filters->>'sort'='oldest' then received_at end asc,case when coalesce(p_filters->>'sort','newest')='newest' then received_at end desc,id offset (page-1)*lim limit lim)
 select coalesce((select jsonb_agg(to_jsonb(x)) from paged x),'[]'),(select count(*) from eligible),array(select distinct lead_id from paged where lead_id is not null) into records,total,ids;
 if cardinality(ids)>0 then phones=public.lead_contact_phones(p_actor,ids,p_request)->'phones';else phones='{}';end if;
 select coalesce(jsonb_agg(x||jsonb_build_object('phone',phones->>(x->>'lead_id'))),'[]') into result from jsonb_array_elements(records)x;
 return jsonb_build_object('data',result,'count',total);
end $$;
create function public.meta_submission(p_actor uuid,p_id uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.meta_submissions;answers jsonb;normalized jsonb;phone jsonb;
begin perform public.accounts_admin(p_actor);select * into s from public.meta_submissions where id=p_id;
 if not found then raise exception 'Submission not found' using errcode='P0002';end if;
 select a.answers,a.normalized into answers,normalized from crm_private.meta_answers a where submission_id=p_id and expires_at>now();
 if s.lead_id is not null then phone=public.lead_contact_phones(p_actor,array[s.lead_id],p_request)->'phones';end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'meta.submission_viewed','meta_submissions',p_id::text,p_request);
 return to_jsonb(s)||jsonb_build_object('answers',answers,'normalized',normalized,'phone',phone->>s.lead_id::text,
 'lead',(select to_jsonb(l) from public.leads l where id=s.lead_id),'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by created_at desc),'[]') from public.assignments a where lead_id=s.lead_id));
end $$;
create function public.meta_summary(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);return (select jsonb_build_object('total',count(*),'facebook',count(*) filter(where platform='facebook'),'instagram',count(*) filter(where platform='instagram'),'meta',count(*) filter(where platform='meta'),'review',count(*) filter(where status='review'),'duplicates',count(*) filter(where status='duplicate'),'failures',count(*) filter(where status='failed'),'processing',count(*) filter(where status in('queued','processing','retry')),
 'unassigned',(select count(*) from public.leads where meta_pending_assignment and assigned_agent is null),
 'assigned_today',count(*) filter(where first_assigned_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi')),
 'notifications',(select coalesce(jsonb_agg(to_jsonb(n)),'[]') from (select s.id,s.platform,coalesce(l.name,a.normalized->>'name','Submission needs review') name,s.status from public.meta_submissions s left join public.leads l on l.id=s.lead_id left join crm_private.meta_answers a on a.submission_id=s.id and a.expires_at>now() where s.status in('created','duplicate','review','failed') and not exists(select 1 from public.meta_notice_reads r where r.actor_id=p_actor and r.submission_id=s.id) order by s.received_at desc limit 10)n)) from public.meta_submissions);end $$;
create function public.meta_read_notice(p_actor uuid,p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform public.accounts_admin(p_actor);insert into public.meta_notice_reads values(p_actor,p_id,now()) on conflict do nothing;end $$;
create function public.meta_report(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin perform public.accounts_admin(p_actor);
 if p_to<=p_from or p_to-p_from>interval '366 days' then raise exception 'Use a reporting range of at most one year' using errcode='22023';end if;
 with s as(select * from public.meta_submissions where received_at>=p_from and received_at<p_to),
 first_inquiry as(select distinct on(lead_id) * from public.meta_submissions where lead_id is not null order by lead_id,received_at,id),
 customers as(select l.*,i.platform,i.campaign_id,i.campaign_name,i.form_id from public.leads l join first_inquiry i on i.lead_id=l.id where i.received_at>=p_from and i.received_at<p_to),
 groups as(select platform,coalesce(campaign_id,'') campaign_id,max(campaign_name) campaign_name,form_id,count(*) submissions,count(distinct lead_id) customer_references from s group by platform,campaign_id,form_id)
 select jsonb_build_object('submissions',(select count(*) from s),'unique_customers',(select count(*) from customers),
 'groups',coalesce((select jsonb_agg(to_jsonb(g)) from groups g),'[]'),
 'assigned',(select count(*) from customers where assigned_agent is not null),'unassigned',(select count(*) from customers where assigned_agent is null),
 'stages',(select coalesce(jsonb_object_agg(status,n),'{}') from(select status,count(*) n from customers group by status)x),
 'completed_visits',(select count(*) from public.visits v where v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to and exists(select 1 from customers c where c.id=v.lead_id)),
 'won_deals',(select count(*) from public.deals d where d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date and exists(select 1 from customers c where c.id=d.lead_id)),
 'revenue',(select coalesce(sum(d.expected_value),0) from public.deals d where d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date and exists(select 1 from customers c where c.id=d.lead_id))) into result;return result;
end $$;
create function public.meta_cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 delete from crm_private.meta_answers where expires_at<=now();
 delete from crm_private.meta_oauth_states where expires_at<now()-interval '1 day';
 -- A worker crashing on its final permitted attempt must still leave a visible failure.
 update public.meta_submissions set status='failed',error_code='attempt_limit',lease_id=null,lease_until=null where status='processing' and lease_until<now() and attempts>=10;
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'meta_%' or proname in('assign_lead','assign_lead_023','run_crm_job')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;
end $$;
notify pgrst,'reload schema';
commit;
