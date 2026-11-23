-- Update 080: one background worker at a time, and the Meta connection's
-- health for administrators. Apply after 079. Safe to rerun. No row of
-- existing data is changed.
--
-- * worker_lease: a worker runs jobs only while it holds the single lease.
--   A second worker (an old copy, a restart overlap) waits; a crashed
--   worker's lease expires and another may take over. Which jobs run is
--   chosen by the worker's JOBS_ENABLED setting (none by default).
-- * meta_health: counts and times only (no tokens, answers or customer
--   details): connection status and token expiry, last webhook, last
--   successful retrieval, queued/failed/review counts, recent error codes,
--   Pages and forms, and the Meta job's heartbeat.
begin;
set local lock_timeout='5s';
do $$ begin
 if position('''Closed lost''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.calls'::regclass and conname='calls_outcome_check'),''))=0
  or to_regprocedure('public.meta_summary(uuid)') is null then
  raise exception 'Apply CRM updates up to 079 before update 080.';
 end if;
 -- Only this update's own definitions may already exist (a rerun).
 if to_regclass('crm_private.worker_lease') is not null and (select string_agg(attname||' '||format_type(atttypid,atttypmod),',' order by attnum)
   from pg_attribute where attrelid=to_regclass('crm_private.worker_lease') and attnum>0 and not attisdropped)
   is distinct from 'id boolean,holder uuid,acquired_at timestamp with time zone,renewed_at timestamp with time zone,expires_at timestamp with time zone,jobs text[]'
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in ('worker_lease','worker_lease_release','meta_health')
   and oid not in (coalesce(to_regprocedure('public.worker_lease(uuid,integer,text[])')::oid,0),
    coalesce(to_regprocedure('public.worker_lease_release(uuid)')::oid,0),coalesce(to_regprocedure('public.meta_health(uuid)')::oid,0))) then
  raise exception 'Update 080 found an unexpected worker lease or health definition: stop and ask for help.';
 end if;
end $$;

create table if not exists crm_private.worker_lease(
 id boolean primary key default true check(id),
 holder uuid not null,
 acquired_at timestamptz not null,
 renewed_at timestamptz not null,
 expires_at timestamptz not null,
 jobs text[] not null default '{}'
);
revoke all on crm_private.worker_lease from public,anon,authenticated;

-- Takes or renews the lease. True while this holder has it.
create or replace function public.worker_lease(p_holder uuid,p_seconds integer,p_jobs text[])
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n integer;
begin
 if p_holder is null or p_seconds is null or p_seconds not between 30 and 3600
  or coalesce(cardinality(p_jobs),0)>20 then
  raise exception 'Invalid worker lease' using errcode='22023';
 end if;
 insert into crm_private.worker_lease as w(id,holder,acquired_at,renewed_at,expires_at,jobs)
 values(true,p_holder,now(),now(),now()+make_interval(secs=>p_seconds),coalesce(p_jobs,'{}'))
 on conflict(id) do update set holder=excluded.holder,
  acquired_at=case when w.holder=excluded.holder then w.acquired_at else now() end,
  renewed_at=now(),expires_at=excluded.expires_at,jobs=excluded.jobs
 where w.holder=excluded.holder or w.expires_at<now();
 get diagnostics n=row_count;
 return n=1;
end $$;

-- Gives the lease up at shutdown, so a restart does not wait for expiry.
create or replace function public.worker_lease_release(p_holder uuid)
returns void language sql volatile security definer set search_path='' as $$
 delete from crm_private.worker_lease where holder=p_holder;
$$;

create or replace function public.meta_health(p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return jsonb_build_object(
  'connections',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'expires_at',c.expires_at,
    'error_code',c.error_code,'last_success_at',c.last_success_at,
    'reconnect',c.status<>'connected' or (c.expires_at is not null and c.expires_at<now()+interval '7 days'),
    'pages',(select count(*) from public.meta_pages p where p.connection_id=c.id),
    'pages_on',(select count(*) from public.meta_pages p where p.connection_id=c.id and p.enabled and p.subscribed))
    order by c.created_at),'[]') from public.meta_connections c where c.status<>'disconnected'),
  'forms',(select count(*) from public.meta_forms),
  'forms_on',(select count(*) from public.meta_forms f join public.meta_pages p on p.id=f.page_id where f.enabled and p.enabled),
  'last_webhook_at',(select max(received_at) from public.meta_submissions),
  'last_retrieval_at',(select max(processed_at) from public.meta_submissions where status in ('created','duplicate','review')),
  'queued',(select count(*) from public.meta_submissions where status in ('queued','retry','processing')),
  'failed',(select count(*) from public.meta_submissions where status='failed'),
  'review',(select count(*) from public.meta_submissions where status='review'),
  'errors',(select coalesce(jsonb_agg(jsonb_build_object('code',error_code,'count',n) order by n desc),'[]') from
    (select error_code,count(*) n from public.meta_submissions where error_code is not null
      and received_at>now()-interval '7 days' group by error_code order by count(*) desc limit 5) e),
  'job',(select jsonb_build_object('last_run_at',last_run_at,'last_success_at',last_success_at,'last_status',last_status)
    from public.job_heartbeats where job='processMetaLeads'),
  'worker',(select jsonb_build_object('running',expires_at>now(),'jobs',jobs,'renewed_at',renewed_at)
    from crm_private.worker_lease));
end $$;

revoke all on function public.worker_lease(uuid,integer,text[]) from public,anon,authenticated;
revoke all on function public.worker_lease_release(uuid) from public,anon,authenticated;
revoke all on function public.meta_health(uuid) from public,anon,authenticated;
grant execute on function public.worker_lease(uuid,integer,text[]) to service_role;
grant execute on function public.worker_lease_release(uuid) to service_role;
grant execute on function public.meta_health(uuid) to service_role;
commit;
