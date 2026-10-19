-- P1: apply once after migration 017 on an existing database.
begin;

alter table public.calls
  add column method text not null default 'provider'
    check (method in ('provider','mock','manual')),
  add column answered boolean;

with changed as (
  update public.calls set method='mock' where provider_call_id like 'mock-%'
    returning id
)
insert into public.audit_log(action,entity,entity_id,request_id,metadata)
  select 'call.method_backfilled','calls',id::text,'migration:018',
    jsonb_build_object('fields',jsonb_build_array('method')) from changed;

-- Existing server mutations do not accept a client-selected method. Classify
-- future mock intents as soon as the adapter attaches their mock reference.
create function public.prepare_call_method() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.method<>'manual' and new.provider_call_id like 'mock-%' then
    new.method='mock';
  end if;
  return new;
end $$;
create trigger prepare_call_method before insert or update of provider_call_id
  on public.calls for each row execute function public.prepare_call_method();

-- These invariants also apply to later outcome edits, not just initial logs.
alter table public.calls add constraint calls_manual_values_check check (
  method<>'manual' or (
    answered is not null and outcome is not null and
    duration_seconds between 0 and 7200 and
    ((answered and duration_seconds>=1 and status='completed') or
      (not answered and status='failed' and outcome in ('No answer','Busy','Wrong number'))) and
    ended_at is not null and ended_at=started_at+make_interval(secs=>duration_seconds) and
    provider_call_id is null and outcome_submitted_at is not null and not missing_outcome and
    coalesce(char_length(notes),0)<=4000 and cardinality(deal_tags)<=7 and
    deal_tags <@ array['Hot lead','Warm lead','Cold lead','Budget mismatch','Location mismatch','Ready to visit','Ready to close']::text[]
  )
);
create index calls_method_created on public.calls(method,created_at desc);

create function public.log_manual_call(p_lead uuid,p_actor uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; customer public.leads; result public.calls;
  started timestamptz; seconds integer; did_answer boolean; call_tags text[];
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into customer from public.leads where id=p_lead
    and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' then
    raise exception 'Invalid call fields' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_object_keys(p_data) as field
    where field not in ('answered','started_at','duration_seconds','outcome','notes','deal_tags')) then
    raise exception 'Field forbidden' using errcode='42501';
  end if;
  if jsonb_typeof(p_data->'answered') is distinct from 'boolean' or
    jsonb_typeof(p_data->'started_at') is distinct from 'string' or
    jsonb_typeof(p_data->'duration_seconds') is distinct from 'number' or
    jsonb_typeof(p_data->'outcome') is distinct from 'string' then
    raise exception 'Call start, answered, duration and outcome are required' using errcode='23514';
  end if;
  if (p_data->>'duration_seconds')::numeric not between 0 and 7200 or
    (p_data->>'duration_seconds')::numeric<>floor((p_data->>'duration_seconds')::numeric) then
    raise exception 'Duration must be 0 to 7200 whole seconds' using errcode='23514';
  end if;
  if p_data->>'started_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Use a call start with an explicit timezone' using errcode='23514';
  end if;
  started=(p_data->>'started_at')::timestamptz;
  if not isfinite(started) or started>now()+interval '2 minutes' or
    started<now()-(case when actor.role='admin' then interval '30 days' else interval '48 hours' end) then
    raise exception 'Call start is outside the permitted time window' using errcode='23514';
  end if;
  seconds=(p_data->>'duration_seconds')::integer;
  did_answer=(p_data->>'answered')::boolean;
  if (did_answer and seconds<1) or (not did_answer and
    p_data->>'outcome' not in ('No answer','Busy','Wrong number')) then
    raise exception 'Choose a valid duration and outcome for whether the call was answered' using errcode='23514';
  end if;
  if p_data ? 'notes' and (jsonb_typeof(p_data->'notes')<>'string' or
    char_length(p_data->>'notes')>4000) then
    raise exception 'Use notes of 4000 characters or fewer' using errcode='23514';
  end if;
  if p_data ? 'deal_tags' then
    if jsonb_typeof(p_data->'deal_tags')<>'array' then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
    if exists(select 1 from jsonb_array_elements(p_data->'deal_tags') as tag
      where jsonb_typeof(tag)<>'string') then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
  end if;
  call_tags=array(select jsonb_array_elements_text(coalesce(p_data->'deal_tags','[]'::jsonb)));
  if cardinality(call_tags)>7 or cardinality(call_tags)<>
    (select count(distinct tag) from unnest(call_tags) as tag) then
    raise exception 'Choose distinct supported tags' using errcode='23514';
  end if;
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,
    duration_seconds,outcome,notes,deal_tags,outcome_submitted_at,missing_outcome)
  values(customer.id,case when actor.role='admin' then coalesce(customer.assigned_agent,p_actor) else p_actor end,
    'manual',did_answer,case when did_answer then 'completed' else 'failed' end,
    started,started+make_interval(secs=>seconds),seconds,p_data->>'outcome',
    coalesce(p_data->>'notes',''),call_tags,now(),false) returning * into result;
  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;
  update public.leads set last_activity_at=now(),updated_at=now() where id=customer.id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'call.manual_logged','calls',result.id::text,p_request,
      jsonb_build_object('lead_id',customer.id,'agent_id',result.agent_id,
        'fields',jsonb_build_array('method','answered','started_at','ended_at',
          'duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome')));
  return to_jsonb(result);
end $$;

revoke all on function public.prepare_call_method(),public.log_manual_call(uuid,uuid,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.prepare_call_method(),public.log_manual_call(uuid,uuid,jsonb,text)
  to service_role;

commit;
