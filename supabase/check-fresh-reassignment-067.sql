-- Read-only check for update 067 (a lead given to a different agent starts
-- fresh for that agent). Run it in the CRM's Supabase SQL Editor before 067
-- and right after it. It is one SELECT: it changes nothing and returns flags
-- and counts only, no customer details.
-- Before 067: release_stage = 'at 066, ready for 067' and
-- transactions_open_over_1_min = 0. Note the counts; right after 067 they
-- must be the same (apart from new activity): 067 changes no record, it
-- only changes what happens at the next reassignment.
-- After 067: release_stage = 'at 067', and earlier_results_shown_to_new_agents = 0.
select
 case
  when position('followup.reassignment_cancelled' in
   pg_get_functiondef(to_regprocedure('public.handover_lead(uuid,uuid,uuid,text)')))>0 then 'at 067'
  when position('workspace_since(l.id)' in
   pg_get_functiondef(to_regprocedure('public.admin_lead_list(uuid,jsonb)')))>0 then 'at 066, ready for 067'
  else 'NOT READY: apply update 066 first'
 end as release_stage,
 -- Existing records, compared before and after 067: nothing is changed.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from public.followups where status='pending') as pending_followups,
 (select count(*) from public.visits where status='scheduled') as scheduled_visits,
 (select count(*) from public.deals where stage in ('discussion','negotiation')) as open_deals,
 (select count(*) from public.assignments) as existing_assignments,
 -- Leads reassigned before 067 whose new agent still sees the earlier
 -- agent's commitments (dates only): they stay until done, as before.
 (select count(*) from public.followups f join public.leads l on l.id=f.lead_id
  where l.deleted_at is null and f.status='pending' and public.workspace_since(l.id) is not null
   and f.created_at<public.workspace_since(l.id)) as earlier_pending_followups_with_new_agents,
 (select count(*) from public.visits v join public.leads l on l.id=v.lead_id
  where l.deleted_at is null and v.status='scheduled' and public.workspace_since(l.id) is not null
   and v.created_at<public.workspace_since(l.id)) as earlier_scheduled_visits_with_new_agents,
 -- Open deals from an earlier assignment, untouched since: after 067 the
 -- new agent no longer sees them; administrators see them as before.
 (select count(*) from public.deals d join public.leads l on l.id=d.lead_id
  where l.deleted_at is null and d.stage in ('discussion','negotiation') and public.workspace_since(l.id) is not null
   and d.created_at<public.workspace_since(l.id) and d.updated_at<=public.workspace_since(l.id)) as earlier_open_deals_hidden_after_067,
 -- Reassigned leads that show "Previously not interested" to their agent:
 -- 0 after 067.
 (select count(*) from public.leads l where l.deleted_at is null and public.workspace_since(l.id) is not null
  and public.lead_workspace(l.id)->>'previous_result' is not null) as earlier_results_shown_to_new_agents,
 -- Commitments cancelled by reassignments since 067.
 (select count(*) from public.audit_log
  where action in ('followup.reassignment_cancelled','visit.reassignment_cancelled')) as cancelled_by_reassignment,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
