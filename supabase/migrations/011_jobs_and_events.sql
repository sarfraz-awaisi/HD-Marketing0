alter table public.targets add column created_at timestamptz not null default now();
create function public.apply_call_event(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.calls; begin
select * into c from public.calls where provider_call_id=p_event->>'provider_call_id' for update;
if c.id is null then raise exception 'Unknown call'; end if;
insert into public.integration_events(provider,event_id) values('mock',p_event->>'event_id') on conflict do nothing;
if not found then return '{"duplicate":true}'::jsonb; end if;
if c.status not in ('completed','failed') then update public.calls set status=p_event->>'status',ended_at=case when p_event->>'status' in ('completed','failed') then coalesce((p_event->>'ended_at')::timestamptz,now()) else ended_at end,duration_seconds=coalesce((p_event->>'duration_seconds')::int,duration_seconds) where id=c.id; end if;
insert into public.audit_log(action,entity,entity_id,metadata) values('webhook','calls',c.id::text,jsonb_build_object('event_id',p_event->>'event_id'));
return '{"accepted":true}'::jsonb; end $$;
create function public.recording_access(p_call uuid) returns jsonb language sql security definer set search_path='' as $$ select jsonb_build_object('storage_path',storage_path) from crm_private.recordings where call_id=p_call and deleted_at is null and created_at>now()-interval '7 days' $$;
create function public.recording_batch(p_days int default 7) returns jsonb language sql security definer set search_path='' as $$ select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select * from crm_private.recordings where deleted_at is null and created_at<=now()-make_interval(days=>least(7,greatest(1,p_days))) order by created_at limit 100) r $$;
create function public.recording_deleted(p_call uuid,p_error text default null) returns void language plpgsql security definer set search_path='' as $$ begin
update crm_private.recordings set deletion_attempts=deletion_attempts+1,last_error=p_error,deleted_at=case when p_error is null then now() else null end where call_id=p_call and deleted_at is null;
if found then insert into public.audit_log(action,entity,entity_id,metadata) values(case when p_error is null then 'recording_deleted' else 'recording_delete_failed' end,'calls',p_call::text,jsonb_build_object('retry_required',p_error is not null)); end if; end $$;
create function public.run_crm_job(p_job text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n int; stale_lead record; admin_id uuid; begin
if not pg_try_advisory_xact_lock(hashtext('hd_job_'||p_job)) then return '{"skipped":true}'::jsonb; end if;
if p_job='followups' then
insert into public.reminders(agent_id,followup_id,due_at) select l.assigned_agent,f.id,f.due_at from public.followups f join public.leads l on l.id=f.lead_id join public.profiles p on p.id=l.assigned_agent where p.active and f.status='pending' and f.due_at<=now()+interval '1 day' on conflict(followup_id,due_at) do nothing; get diagnostics n=row_count;
elsif p_job='outcomes' then update public.calls set missing_outcome=true where status='completed' and outcome_submitted_at is null and not missing_outcome and ended_at<now()-make_interval(mins=>coalesce((p_settings->>'grace_minutes')::int,30));get diagnostics n=row_count;
elsif p_job='stale' then
perform pg_advisory_xact_lock(873420);
select id into admin_id from public.profiles where role='admin' and active order by id limit 1;n=0;
if admin_id is not null then for stale_lead in select id from public.leads l where status not in ('won','lost') and last_activity_at<now()-make_interval(days=>coalesce((p_settings->>'stale_days')::int,7)) and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now()) order by last_activity_at for update skip locked limit 100 loop
if exists(select 1 from public.profiles where active and role='agent') then perform public.assign_lead(stale_lead.id,admin_id,null,'job:stale');n=n+1; end if;end loop;end if;
else raise exception 'Unknown job'; end if;
return jsonb_build_object('affected',n);end $$;
do $$ declare f record; begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('apply_call_event','recording_access','recording_batch','recording_deleted','run_crm_job') loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); execute format('grant execute on function %s to service_role',f.signature);end loop;end $$;
