-- Read-only check for release v1.1.0 (updates 042–048). Run it in the CRM's
-- Supabase SQL Editor before the updates, after each one, and after the
-- release. It is one SELECT: it changes nothing and returns schema flags,
-- row counts and worker activity only, no customer or account details.
-- Before 042: release_stage = 'at 041, ready for 042', every
-- *_must_be_0 column 0, and the counts noted for comparison.
-- Expected values are in docs/RELEASE_V1.1.0.md.
select
 current_setting('server_version') as postgres_version,
 -- Which updates are installed (each later one requires the one before).
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='owner_agent_id') as update_041_installed,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='attendance_periods' and column_name='recorded_by') as update_042_installed,
 to_regprocedure('public.audit_page(uuid,jsonb,integer,integer)') is not null as update_043_installed,
 to_regclass('public.property_promotions') is not null as update_044_installed,
 to_regclass('public.tasks') is not null as update_045_installed,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='building_categories') as update_046_installed,
 to_regclass('public.departments') is not null as update_047_installed,
 to_regclass('public.shift_schedules') is not null as update_048_installed,
 case
  when to_regclass('public.shift_schedules') is not null then 'at 048, release database ready'
  when to_regclass('public.departments') is not null then 'at 047, apply 048 next'
  when exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='building_categories') then 'at 046, apply 047 next'
  when to_regclass('public.tasks') is not null then 'at 045, apply 046 next'
  when to_regclass('public.property_promotions') is not null then 'at 044, apply 045 next'
  when to_regprocedure('public.audit_page(uuid,jsonb,integer,integer)') is not null then 'at 043, apply 044 next'
  when exists(select 1 from information_schema.columns where table_schema='public' and table_name='attendance_periods' and column_name='recorded_by') then 'at 042, apply 043 next'
  when exists(select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='owner_agent_id') then 'at 041, ready for 042'
  else 'STOP: update 041 is not installed'
 end as release_stage,
 -- Existing rows the updates' new rules must accept. Any non-zero value
 -- would make an update stop and roll back; report it before continuing.
 (select count(*) from public.notifications where type not in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
   'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow','attendance_request','attendance_review',
   'attendance_incomplete','attendance_summary','property_source_updated','property_source_removed','task_assigned','task_updated',
   'task_cancelled','task_report','task_report_reviewed','checkout_request','checkout_decision','shift_changed')) as unknown_notification_types_must_be_0,
 (select count(*) from public.profiles where role not in ('admin','agent','staff')) as unknown_roles_must_be_0,
 (select count(*) from public.login_events where portal not in ('admin','agent','staff')) as unknown_login_portals_must_be_0,
 -- Counts to compare with the backup and after every update: they must not change.
 (select count(*) from auth.users) as auth_users,
 (select count(*) from public.profiles) as profiles,
 (select count(*) from public.profiles where role='admin' and active and deleted_at is null) as active_admins,
 (select count(*) from public.profiles where role='agent' and active and deleted_at is null) as active_agents,
 (select count(*) from public.profiles where role='staff') as staff_accounts,
 (select count(*) from public.profiles where role='staff' and active) as active_staff_must_be_0_before_rollback,
 (select count(*) from public.leads) as leads,
 (select count(*) from public.properties) as properties,
 (select count(*) from public.property_photos) as property_photos,
 (select count(*) from public.visits) as visits,
 (select count(*) from public.deals) as deals,
 (select count(*) from public.attendance_records) as attendance_records,
 (select count(*) from public.attendance_leave_requests) as leave_requests,
 (select count(*) from public.attendance_periods) as attendance_periods,
 (select count(*) from public.attendance_policies) as attendance_policies,
 (select count(*) from public.notifications) as notifications,
 (select count(*) from public.audit_log) as audit_entries,
 case when to_regclass('storage.objects') is not null
  then (xpath('/row/n/text()',query_to_xml('select count(*) n from storage.objects',false,true,'')))[1]::text::bigint end as stored_files,
 (select count(*) from public.property_photo_cleanup) as photo_cleanup_queue,
 -- Background worker: seconds since any job last ran. Before starting the
 -- VPS worker this must stay above 120 (no other worker is running).
 (select extract(epoch from now()-max(last_run_at))::integer from public.job_heartbeats) as seconds_since_last_job_run,
 (select string_agg(job||' '||to_char(last_run_at at time zone 'Asia/Karachi','DD Mon HH24:MI:SS'),', ' order by last_run_at desc)
   from public.job_heartbeats) as last_job_runs_pkt,
 -- Other sessions that could hold a migration's locks (lock timeout is 5 s).
 (select count(*) from pg_stat_activity where pid<>pg_backend_pid() and xact_start<now()-interval '1 minute') as transactions_open_over_1_min,
 -- After 045: checkout rules must stay off until the owner turns them on.
 case when exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_settings' and column_name='task_rules_from')
  then (select (to_jsonb(s)->>'task_rules_from') is null from public.crm_settings s limit 1) end as checkout_rules_off,
 -- After 048: browsers can run none of the new staff, task or shift functions.
 (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace
   and (p.proname like 'shift%' or p.proname like 'employee%' or p.proname like 'task%' or p.proname like 'department%' or p.proname like 'attendance_admin%')
   and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) as browser_executable_new_functions_must_be_0;
