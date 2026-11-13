-- Read-only check for update 066 (Hot, Warm and Cold start again when a
-- lead is given to a different agent). Run it in the CRM's Supabase SQL
-- Editor before 066 and right after it. It is one SELECT: it changes
-- nothing and returns flags and counts only, no customer details.
-- Before 066: release_stage = 'at 065, ready for 066' and
-- transactions_open_over_1_min = 0. Note the counts; after 066 they must be
-- the same (apart from new activity).
-- After 066: release_stage = 'at 066'.
select
 case
  when position('Cold lead'') and c.created_at>=coalesce(public.workspace_since(l.id)' in
   pg_get_functiondef(to_regprocedure('public.admin_lead_list(uuid,jsonb)')))>0 then 'at 066'
  when to_regprocedure('public.phone_country(text)') is not null then 'at 065, ready for 066'
  else 'NOT READY: apply update 065 first'
 end as release_stage,
 -- Existing records, compared before and after 066: nothing is changed.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.calls where deal_tags && array['Hot lead','Warm lead','Cold lead']) as calls_with_hot_warm_cold,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- Leads now with a different agent whose latest Hot, Warm or Cold came
 -- from an earlier agent: after 066 All leads and report drill-downs show
 -- them unclassified, as their agents already see them.
 (select count(*) from public.leads l where l.deleted_at is null
  and public.workspace_since(l.id) is not null
  and exists(select 1 from public.calls c where c.lead_id=l.id
   and c.deal_tags && array['Hot lead','Warm lead','Cold lead'] and c.created_at<public.workspace_since(l.id))
  and not exists(select 1 from public.calls c where c.lead_id=l.id
   and c.deal_tags && array['Hot lead','Warm lead','Cold lead'] and c.created_at>=public.workspace_since(l.id)))
  as reassigned_leads_classified_by_earlier_agent,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
