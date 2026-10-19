-- F1. Apply once to the existing hosted project; do not rerun setup.sql.
begin;

alter table public.leads
  add column lost_reason text,
  add column lost_note text,
  add column lost_at timestamptz;
alter table public.deals
  add column lost_reason text,
  add column lost_note text;

create table public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id),
  lost_reason text,
  request_id text,
  created_at timestamptz not null default now()
);
create index lead_status_history_lead_created
  on public.lead_status_history(lead_id,created_at desc);
alter table public.lead_status_history enable row level security;
revoke all on public.lead_status_history from public,anon,authenticated;
grant all on public.lead_status_history to service_role;
create index leads_lost_reason on public.leads(lost_reason) where status='lost';

-- Preserve existing records without inventing a historical reason.
with changed as (
  update public.leads set lost_reason='other',
    lost_note='Reason not recorded before the pipeline upgrade; loss time uses the previous update time.',
    lost_at=updated_at where status='lost' returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'pipeline_backfill','leads',id::text,'migration:012',
    jsonb_build_object('fields',jsonb_build_array('lost_reason','lost_note','lost_at')) from changed;
with changed as (
  update public.deals set lost_reason='other',
    lost_note='Reason not recorded before the pipeline upgrade.' where stage='lost' returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'pipeline_backfill','deals',id::text,'migration:012',
    jsonb_build_object('fields',jsonb_build_array('lost_reason','lost_note')) from changed;

alter table public.leads drop constraint leads_status_check;
with previous as (
  select id,status as from_status,
    case status when 'follow_up' then 'contacted' when 'site_visit' then 'visit_scheduled' end as to_status
  from public.leads where status in ('follow_up','site_visit')
), changed as (
  update public.leads l set status=p.to_status from previous p where l.id=p.id
  returning l.id,p.from_status,p.to_status
)
insert into public.lead_status_history(lead_id,from_status,to_status,request_id)
  select id,from_status,to_status,'migration:012' from changed;
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'status_change','leads',lead_id::text,request_id,
    jsonb_build_object('from_status',from_status,'to_status',to_status,'fields',jsonb_build_array('status'))
  from public.lead_status_history where request_id='migration:012';

alter table public.leads
  add constraint leads_status_check check(status in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost')),
  add constraint leads_lost_reason_check check(lost_reason in ('price','location','budget','not_interested','no_response','bought_elsewhere','wrong_number','other')),
  add constraint leads_lost_note_check check(char_length(lost_note)<=500),
  add constraint leads_lost_requires_reason check(status<>'lost' or lost_reason is not null);
alter table public.deals
  add constraint deals_lost_reason_check check(lost_reason in ('price','location','budget','not_interested','no_response','bought_elsewhere','wrong_number','other')),
  add constraint deals_lost_note_check check(char_length(lost_note)<=500),
  add constraint deals_lost_requires_reason check(stage<>'lost' or lost_reason is not null);

create function public.prepare_lead_status() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status='lost' then
    if new.lost_reason is null then
      raise exception 'Lost leads require a reason' using errcode='23514';
    end if;
    if tg_op='INSERT' then new.lost_at=now();
    elsif old.status<>'lost' then new.lost_at=now();
    else new.lost_at=old.lost_at; end if;
  else
    new.lost_reason=null; new.lost_note=null; new.lost_at=null;
  end if;
  return new;
end $$;
create trigger prepare_lead_status before insert or update of status,lost_reason,lost_note
  on public.leads for each row execute function public.prepare_lead_status();

create function public.record_lead_status_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor uuid; request text; fields jsonb;
begin
  if old.status is not distinct from new.status then return new; end if;
  actor=nullif(current_setting('hd.actor_id',true),'')::uuid;
  request=nullif(current_setting('hd.request_id',true),'');
  fields=coalesce(nullif(current_setting('hd.changed_fields',true),'')::jsonb,'["status"]'::jsonb);
  insert into public.lead_status_history(lead_id,from_status,to_status,actor_id,lost_reason,request_id)
    values(new.id,old.status,new.status,actor,new.lost_reason,request);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(actor,'status_change','leads',new.id::text,request,
      jsonb_build_object('from_status',old.status,'to_status',new.status,'fields',fields));
  return new;
end $$;
create trigger record_lead_status_change after update of status on public.leads
  for each row execute function public.record_lead_status_change();

create function public.advance_lead_status(
  p_lead uuid,p_status text,p_actor uuid,p_request text,
  p_reason text default null,p_note text default null
) returns void language plpgsql security definer set search_path='' as $$
declare current_lead public.leads; stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'];
begin
  select * into current_lead from public.leads where id=p_lead for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  -- A null actor is reserved for the trusted, signed provider event boundary.
  if p_actor is not null and not exists(
    select 1 from public.profiles where id=p_actor and active
      and (role='admin' or current_lead.assigned_agent=p_actor)
  ) then raise exception 'Forbidden' using errcode='42501'; end if;
  if array_position(stages,p_status) is null then raise exception 'Invalid stage' using errcode='23514'; end if;
  if p_status='lost' and p_reason is null then raise exception 'Lost leads require a reason' using errcode='23514'; end if;
  -- Automated activity cannot reopen a terminal lead or move it backwards.
  if current_lead.status in ('won','lost') or
    array_position(stages,p_status)<=array_position(stages,current_lead.status) then return; end if;
  perform set_config('hd.actor_id',coalesce(p_actor::text,''),true);
  perform set_config('hd.request_id',coalesce(p_request,''),true);
  perform set_config('hd.changed_fields','["status"]',true);
  update public.leads set status=p_status,lost_reason=p_reason,lost_note=p_note,
    last_activity_at=now() where id=p_lead;
end $$;

create or replace function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; lead uuid; existing jsonb; result jsonb;
  cols text; vals text; sets text; allowed text[]; k text; stage text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_table not in ('leads','notes','calls','followups','visits','deals','properties','targets','profiles') then raise exception 'Invalid entity'; end if;
  if p_table in ('properties','targets','profiles') and actor.role<>'admin' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_table) into existing using p_id;
    if existing is null then raise exception 'Not found' using errcode='P0002'; end if;
  end if;
  if p_table='leads' then lead=p_id;
  elsif p_table in ('notes','calls','followups','visits','deals') then lead=coalesce((existing->>'lead_id')::uuid,(p_data->>'lead_id')::uuid); end if;
  if lead is not null then
    perform 1 from public.leads where id=lead and (actor.role='admin' or assigned_agent=p_actor) for update;
    if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  end if;
  allowed=case p_table
    when 'leads' then case when actor.role='admin' then array['name','email','status','source','property_id','budget_min','budget_max','preferred_location','lost_reason','lost_note'] else array['status','lost_reason','lost_note'] end
    when 'notes' then array['lead_id','agent_id','body']
    when 'calls' then array['lead_id','agent_id','provider_call_id','status','ended_at','duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome']
    when 'followups' then array['lead_id','agent_id','due_at','notes','status']
    when 'visits' then array['lead_id','agent_id','property_id','scheduled_at','status','notes']
    when 'deals' then array['lead_id','agent_id','property_id','stage','expected_value','close_date','notes','lost_reason','lost_note']
    when 'properties' then array['title','description','location','price','type','area','area_unit','availability']
    when 'targets' then array['agent_id','month','calls','visits','deals','revenue']
    when 'profiles' then array['name','active'] end;
  if p_table in ('notes','calls','followups','visits','deals') then
    if p_id is null then p_data=p_data||jsonb_build_object('agent_id',coalesce((select assigned_agent from public.leads where id=lead),p_actor));
    else p_data=p_data-'lead_id'-'agent_id'; end if;
  end if;
  for k in select jsonb_object_keys(p_data) loop
    if not k=any(allowed) then raise exception 'Field forbidden' using errcode='42501'; end if;
  end loop;
  if p_data='{}'::jsonb then raise exception 'Empty change'; end if;
  -- Clearing a lost deal must not retain an obsolete reason on the deal record.
  if p_table='deals' and coalesce(p_data->>'stage',existing->>'stage')<>'lost' then
    p_data=p_data||jsonb_build_object('lost_reason',null,'lost_note',null);
  end if;
  perform set_config('hd.actor_id',p_actor::text,true);
  perform set_config('hd.request_id',coalesce(p_request,''),true);
  perform set_config('hd.changed_fields',to_jsonb(array(select jsonb_object_keys(p_data)))::text,true);
  select string_agg(format('%I',key),','),string_agg(format('r.%I',key),','),string_agg(format('%I=r.%I',key,key),',')
    into cols,vals,sets from jsonb_object_keys(p_data) key;
  if cols is null then raise exception 'Empty change'; end if;
  if p_id is null then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_table,cols,vals,p_table,p_table) into result using p_data;
  else
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t.*)',p_table,sets,p_table) into result using p_data,p_id;
  end if;
  if p_table='calls' and result->>'status'='completed' and
    (p_id is null or existing->>'status' is distinct from 'completed') then stage='contacted';
  elsif p_table='visits' and (p_id is null or existing->>'status' is distinct from result->>'status') then
    stage=case result->>'status' when 'scheduled' then 'visit_scheduled' when 'completed' then 'visit_done' end;
  elsif p_table='deals' and (p_id is null or existing->>'stage' is distinct from result->>'stage') then
    stage=case result->>'stage' when 'won' then 'won' when 'lost' then 'lost' else 'negotiation' end;
  end if;
  if stage is not null then
    perform public.advance_lead_status(lead,stage,p_actor,p_request,result->>'lost_reason',result->>'lost_note');
  end if;
  if lead is not null then update public.leads set last_activity_at=now(),updated_at=now() where id=lead; end if;
  -- The status trigger already writes the one audit row for a lead stage change.
  if not (p_table='leads' and p_id is not null and existing->>'status' is distinct from result->>'status') then
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      values(p_actor,case when p_id is null then 'create' else 'update' end,p_table,result->>'id',p_request,
        jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
  end if;
  return result;
end $$;

-- Signed call events use the same forward-only helper as manual mock completion.
create or replace function public.apply_call_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.calls;
begin
  select * into c from public.calls where provider_call_id=p_event->>'provider_call_id' for update;
  if c.id is null then raise exception 'Unknown call'; end if;
  insert into public.integration_events(provider,event_id) values('mock',p_event->>'event_id') on conflict do nothing;
  if not found then return '{"duplicate":true}'::jsonb; end if;
  if c.status not in ('completed','failed') then
    update public.calls set status=p_event->>'status',
      ended_at=case when p_event->>'status' in ('completed','failed') then coalesce((p_event->>'ended_at')::timestamptz,now()) else ended_at end,
      duration_seconds=coalesce((p_event->>'duration_seconds')::int,duration_seconds) where id=c.id;
    if p_event->>'status'='completed' then
      perform public.advance_lead_status(c.lead_id,'contacted',null,'webhook:'||(p_event->>'event_id'));
    end if;
  end if;
  insert into public.audit_log(action,entity,entity_id,metadata)
    values('webhook','calls',c.id::text,jsonb_build_object('event_id',p_event->>'event_id'));
  return '{"accepted":true}'::jsonb;
end $$;

revoke all on function public.prepare_lead_status(),public.record_lead_status_change(),
  public.advance_lead_status(uuid,text,uuid,text,text,text),public.crm_mutate(text,uuid,jsonb,uuid,text),
  public.apply_call_event(jsonb) from public,anon,authenticated;
grant execute on function public.prepare_lead_status(),public.record_lead_status_change(),
  public.advance_lead_status(uuid,text,uuid,text,text,text),public.crm_mutate(text,uuid,jsonb,uuid,text),
  public.apply_call_event(jsonb) to service_role;

commit;
