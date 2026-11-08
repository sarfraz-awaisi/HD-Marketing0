-- Read-only check for update 055 (administrators' Lead pipeline, agent by
-- agent). Run it in the CRM's Supabase SQL Editor before 055 and right after
-- it. It is one SELECT: it changes nothing and returns flags and counts
-- only, no customer or account details.
-- Before 055: release_stage = 'at 053 or 054, ready for 055' and
-- transactions_open_over_1_min = 0. Note the existing_* counts; after 055
-- they must be the same (apart from new activity).
-- After 055: release_stage = 'at 055', every *_must_be_0 column 0 and
-- server_functions = 3.
select
 to_regclass('public.audit_log_note_records') is not null as update_053_installed,
 case
  when to_regprocedure('public.admin_pipeline_agents(uuid,jsonb)') is not null
   and to_regprocedure('public.admin_agent_pipeline(uuid,uuid,jsonb)') is not null
   and to_regprocedure('public.agent_spoken_leads(uuid)') is not null
   and to_regprocedure('public.agent_pipeline_numbers(uuid)') is not null
   and to_regprocedure('public.agent_pipeline_attribution(uuid,uuid[])') is not null
   then 'at 055'
  when to_regclass('public.audit_log_note_records') is not null
   and to_regprocedure('public.agent_lead_list(uuid,jsonb)') is not null then 'at 053 or 054, ready for 055'
  else 'NOT READY: apply update 053 first'
 end as release_stage,
 -- Existing records, compared before and after 055.
 (select count(*) from public.leads) as existing_leads,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.notes) as existing_notes,
 (select count(*) from public.followups) as existing_followups,
 (select count(*) from public.audit_log) as existing_audit_entries,
 (select count(*) from public.profiles where role='agent' and deleted_at is null) as agents,
 -- Answered calls the audit log names no recorder for (older calls): they
 -- count for no agent, and an agent's page says how many of their leads
 -- have only such calls. Shown for information, not a failure.
 (select count(*) from public.calls c where c.status='completed' and not exists(select 1 from public.audit_log a
   where a.entity='calls' and a.entity_id=c.id::text and a.action in ('create','call.manual_logged'))) as answered_calls_without_recorder,
 -- Agents' own Lead pipelines (leads of theirs with any answered call)
 -- against the leads their agent spoke to, as the administrators' page
 -- counts them; the rest named by who recorded the latest answered call.
 -- Totals for information; they work before 055 too.
 (with own as (
   select l.id,l.assigned_agent,
    exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed' and c.agent_id=l.assigned_agent
     and (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
      and a.action in ('create','call.manual_logged') order by a.id limit 1)=l.assigned_agent) spoken,
    (select (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
      and a.action in ('create','call.manual_logged') order by a.id limit 1)
     from public.calls c where c.lead_id=l.id and c.status='completed'
     order by c.started_at desc,c.created_at desc,c.id desc limit 1) recorder
   from public.leads l join public.profiles g on g.id=l.assigned_agent and g.role='agent'
   where l.deleted_at is null and exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed'))
  select jsonb_build_object('in_agents_own_pipelines',count(*),'spoken_to_by_their_agent',count(*) filter (where spoken),
   'last_answered_by_admin',count(*) filter (where not spoken and r.role='admin'),
   'last_answered_by_another_agent',count(*) filter (where not spoken and o.recorder is not null and r.role is distinct from 'admin'),
   'last_answered_with_no_recorded_caller',count(*) filter (where not spoken and o.recorder is null))
  from own o left join public.profiles r on r.id=o.recorder) as pipeline_difference,
 -- Only the server may call the new functions; browsers never.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('agent_spoken_leads','agent_pipeline_numbers','admin_pipeline_agents','admin_agent_pipeline','agent_pipeline_attribution')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute'))) as browser_function_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('agent_spoken_leads','agent_pipeline_numbers')
  and has_function_privilege('service_role',f.oid,'execute')) as server_helper_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('admin_pipeline_agents','admin_agent_pipeline','agent_pipeline_attribution')
  and has_function_privilege('service_role',f.oid,'execute')) as server_functions,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
