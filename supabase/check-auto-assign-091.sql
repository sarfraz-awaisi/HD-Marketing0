-- Read-only check for update 091 (automatic lead distribution). Changes
-- nothing and shows counts only, no customer details. Before:
-- release_stage = 'at 090, ready for 091'. After: 'at 091' (automatic
-- assignment starts Off). eligible_now is how many unassigned leads it
-- could take today if switched on with the existing leads included.
select
 case when to_regclass('crm_private.auto_assign_settings') is not null
   and to_regprocedure('public.auto_assign_run(uuid,text)') is not null then 'at 091'
  when to_regclass('crm_private.auto_assign_settings') is not null
   or to_regprocedure('public.auto_assign_run(uuid,text)') is not null then 'PARTLY at 091: run update 091 again'
  when to_regprocedure('public.admin_distribute_agent_uncalled(uuid,uuid[],uuid[],boolean,text,text)') is not null
   then 'at 090, ready for 091'
  else 'NOT READY: apply CRM updates up to 090 exactly' end release_stage,
 (select count(*) from public.leads where deleted_at is null and assigned_agent is null) unassigned_leads,
 (select count(*) from public.leads l where l.deleted_at is null and l.assigned_agent is null and not l.meta_pending_assignment
   and l.status not in ('won','lost')
   and not exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id is not null)
   and coalesce((select c.outcome from public.calls c where c.lead_id=l.id and c.outcome is not null
     order by c.started_at desc,c.created_at desc,c.id desc limit 1),'-')
    not in ('Interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost')) eligible_now,
 (select count(*) from public.leads where deleted_at is null and meta_pending_assignment) incoming_social_waiting,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min;
