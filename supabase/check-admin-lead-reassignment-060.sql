-- Read-only check for update 060 (All leads: move selected leads to one
-- agent). Run it in the CRM's Supabase SQL Editor before 060 and right after
-- it. It is one SELECT: it changes nothing and returns flags and counts
-- only, no customer or account details.
-- Before 060: release_stage = 'at 059, ready for 060' and
-- transactions_open_over_1_min = 0. Note the counts; after 060 they must be
-- the same (apart from new activity).
-- After 060: release_stage = 'at 060', browser_function_access_must_be_0 = 0
-- and server_functions = 3.
select
 case
  when to_regprocedure('public.admin_assign_leads(uuid[],uuid,uuid,text)') is not null then 'at 060'
  when to_regclass('public.dealer_change_requests') is not null
   and to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is not null then 'at 059, ready for 060'
  else 'NOT READY: apply update 059 first'
 end as release_stage,
 -- Existing records, compared before and after 060.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is not null) as assigned_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Only the server may call these; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads','admin_assign_leads')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_lead_list','assign_unassigned_leads','admin_assign_leads')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
