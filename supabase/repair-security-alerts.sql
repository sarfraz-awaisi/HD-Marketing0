-- HD Marketing CRM: repeatable security-alert repair for partial installations.
-- Run the ENTIRE file in the SQL Editor of the project used by this CRM.
-- Keeps customer contacts, assignments, alerts and audit history unchanged.
-- Does not reinstall phone quotas, hide contacts or change admin login policy.
begin;
do $$
declare missing_tables text;
begin
 select string_agg(required.name,', ' order by required.name) into missing_tables
 from (values ('public.profiles'),('public.audit_log')) required(name)
 where to_regclass(required.name) is null;
 if missing_tables is not null then
  raise exception 'Required CRM tables are missing: %',missing_tables
   using hint='Select the CRM Supabase project and apply its missing core migrations before this repair.';
 end if;
end $$;

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

-- Restore this later index only when 022's reporting function is installed.
-- Otherwise leave the numbered 022 migration free to create its own index.
do $$ begin
 if to_regprocedure('public.report_inactive_lead_owners()') is not null then
  create unique index if not exists inactive_owner_alert_day on public.security_alerts
   (user_id,type,((created_at at time zone 'Asia/Karachi')::date))
   where type='inactive_agent_leads';
 end if;
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

revoke all on function public.security_alerts_summary(uuid),public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.security_alerts_summary(uuid),public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;

select
 'Security alerts repaired; database API refresh requested' as status,
 to_regclass('public.security_alerts') is not null as security_alerts_ready,
 to_regprocedure('public.security_alerts_summary(uuid)') is not null as summary_ready,
 to_regprocedure('public.security_alerts_page(uuid,integer,integer,text,text)') is not null as list_ready,
 to_regprocedure('public.review_security_alert(uuid,uuid,text)') is not null as review_ready,
 has_function_privilege('service_role','public.security_alerts_summary(uuid)','execute')
 and has_function_privilege('service_role','public.security_alerts_page(uuid,integer,integer,text,text)','execute')
 and has_function_privilege('service_role','public.review_security_alert(uuid,uuid,text)','execute') as server_access_ready;
