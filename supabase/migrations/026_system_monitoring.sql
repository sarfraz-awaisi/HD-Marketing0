-- P6: apply once after 025. Operational metadata only; no native MFA policy change.
begin;
do $$ begin
 if to_regclass('crm_private.mfa_resets') is null or to_regprocedure('public.meta_cleanup()') is null then
  raise exception 'Apply missing CRM migrations through 025 before update 026.';
 end if;
end $$;
create table public.crm_schema_versions(version integer primary key,installed_at timestamptz not null default now());
insert into public.crm_schema_versions(version) values(26);
create table public.job_heartbeats(
 job text primary key check(job in('deleteOldRecordings','reportInactiveLeadOwners','reassignStaleLeads','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads')),
 last_success_at timestamptz,last_error_at timestamptz,last_error text check(last_error is null or last_error='job_failed'),
 last_run_at timestamptz not null,last_status text not null check(last_status in('success','failed'))
);
create table public.backups(
 id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),
 filename text not null check(filename ~ '^hd-crm-[A-Za-z0-9_-]+\.dump\.age$'),
 status text not null check(status in('success','failed')),bytes bigint not null check(bytes>=0),
 sha256 text check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
 error_code text check(error_code is null or error_code='backup_failed'),
 check(status<>'success' or (bytes>0 and sha256 is not null))
);
create index backups_recent on public.backups(created_at desc);
alter table public.crm_schema_versions enable row level security;
alter table public.job_heartbeats enable row level security;
alter table public.backups enable row level security;
revoke all on public.crm_schema_versions,public.job_heartbeats,public.backups from public,anon,authenticated;
grant all on public.crm_schema_versions,public.job_heartbeats,public.backups to service_role;
create function public.record_job_heartbeat(p_job text,p_success boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_success is null then raise exception 'Invalid heartbeat' using errcode='22023';end if;
 insert into public.job_heartbeats(job,last_success_at,last_error_at,last_error,last_run_at,last_status)
 values(p_job,case when p_success then now() end,case when not p_success then now() end,case when not p_success then 'job_failed' end,now(),case when p_success then 'success' else 'failed' end)
 on conflict(job) do update set last_success_at=case when p_success then now() else job_heartbeats.last_success_at end,
 last_error_at=case when not p_success then now() else job_heartbeats.last_error_at end,
 last_error=case when not p_success then 'job_failed' end,last_run_at=now(),last_status=case when p_success then 'success' else 'failed' end;
end $$;
create function public.record_backup(p_filename text,p_success boolean,p_bytes bigint,p_sha256 text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_success is null then raise exception 'Invalid backup' using errcode='22023';end if;
 insert into public.backups(filename,status,bytes,sha256,error_code) values(p_filename,case when p_success then 'success' else 'failed' end,p_bytes,p_sha256,case when not p_success then 'backup_failed' end);
end $$;
create function public.system_status(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;fresh boolean;version integer;backup jsonb;last_run timestamptz;
begin
 perform id from public.profiles where id=p_actor and active and role='admin' for share;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 select max(v.version) into version from public.crm_schema_versions v;
 select jsonb_agg(jsonb_build_object('job',expected.job,'status',case when h.job is null then 'not_started' when h.last_run_at<=now()-interval '5 minutes' then 'stale' else h.last_status end,'last_success_at',h.last_success_at,'last_error_at',h.last_error_at,'last_run_at',h.last_run_at)),
 bool_and(h.job is not null and h.last_status='success' and h.last_run_at>now()-interval '5 minutes'),case when count(h.job)=8 then min(h.last_run_at) end
 into rows,fresh,last_run
 from unnest(array['deleteOldRecordings','reportInactiveLeadOwners','reassignStaleLeads','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles','processMetaLeads']) expected(job)
 left join public.job_heartbeats h on h.job=expected.job;
 select jsonb_build_object('last_success_at',(select max(created_at) from public.backups where status='success'),
 'last_run_at',(select max(created_at) from public.backups),
 'status',coalesce((select status from public.backups order by created_at desc,id desc limit 1),'not_started')) into backup;
 return jsonb_build_object('ready',version=26 and coalesce(fresh,false),'migration',case when version=26 then 'current' else 'update_required' end,
 'installed_version',version,'jobs',rows,'last_job_at',last_run,'backup',backup);
end $$;
revoke all on function public.record_job_heartbeat(text,boolean),public.record_backup(text,boolean,bigint,text),public.system_status(uuid) from public,anon,authenticated;
grant execute on function public.record_job_heartbeat(text,boolean),public.record_backup(text,boolean,bigint,text),public.system_status(uuid) to service_role;
notify pgrst,'reload schema';
commit;
