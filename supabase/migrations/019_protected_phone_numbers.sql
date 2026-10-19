-- P2: apply once after migration 018. Browser clients use only /api.
begin;

create table crm_private.phone_reveals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  revealed_at timestamptz not null default now()
);
create index phone_reveals_user_time on crm_private.phone_reveals(user_id,revealed_at) include (lead_id);
alter table crm_private.phone_reveals enable row level security;
revoke all on crm_private.phone_reveals from public,anon,authenticated;
grant all on crm_private.phone_reveals to service_role;

create table public.security_alerts (
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
create index security_alerts_created on public.security_alerts(created_at desc);
create index security_alerts_unreviewed on public.security_alerts(created_at desc) where reviewed_at is null;
-- One warning and one limit alert per agent/Pakistan day, including after review.
create unique index phone_alerts_user_day on public.security_alerts
  (user_id,type,((created_at at time zone 'Asia/Karachi')::date))
  where type in ('phone_reveal_warning','phone_reveal_limit');
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from public,anon,authenticated;
grant all on public.security_alerts to service_role;

create function public.phone_reveal_window(p_at timestamptz)
returns table(day date,starts_at timestamptz,resets_at timestamptz)
language sql immutable security definer set search_path='' as $$
  select (p_at at time zone 'Asia/Karachi')::date,
    date_trunc('day',p_at at time zone 'Asia/Karachi') at time zone 'Asia/Karachi',
    (date_trunc('day',p_at at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi'
$$;

create function public.phone_reveal_status(p_actor uuid,p_limit integer default 80)
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

create function public.reveal_phone(p_lead uuid,p_actor uuid,p_request text,p_limit integer default 80)
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

create function public.security_alerts_summary(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  return (select jsonb_build_object('count',count(*),'critical',count(*) filter(where severity='critical'),
    'warning',count(*) filter(where severity='warning')) from public.security_alerts where reviewed_at is null);
end $$;

create function public.security_alerts_page(p_actor uuid,p_page integer default 1,p_limit integer default 20,
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

create function public.review_security_alert(p_alert uuid,p_actor uuid,p_request text)
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

commit;
