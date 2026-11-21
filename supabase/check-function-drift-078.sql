-- Read-only check for update 078 (two functions catch up with the
-- repository). Changes nothing. Run before and after applying 078.
--
-- release_stage: "at 078", "at 077, ready for 078", or NOT READY.
-- records_call_actor / accepts_email_confirmation: each fix in place.
-- functions_secure: both SECURITY DEFINER with an empty search_path,
--   owned by postgres, and not executable by anon or authenticated.
-- admin_logged_first_calls: assignments whose first-call time came from a
--   call an administrator logged (the first call saved for the lead's agent
--   after the assignment), so the agent was credited with it. 078 does not
--   change these; it stops new ones.
with fn as (
 select pg_get_functiondef('public.log_manual_call(uuid,uuid,jsonb,text)'::regprocedure) calls,
        pg_get_functiondef('public.account_action_034(uuid,text,text,uuid,text,text)'::regprocedure) accounts),
fixed as (
 select position($t$  perform set_config('hd.actor_id',p_actor::text,true);
  insert into public.calls($t$ in calls)>0 actor,
        position($t$'email_confirmation_requested','email_confirmation_sent','email_confirmation_failed') then raise exception 'Invalid account action'$t$ in accounts)>0 email
 from fn),
credited as (
 select a.id, a.created_at, c.started_at
 from public.assignments a
 cross join lateral (
  select c.id, c.started_at from public.calls c
  where c.lead_id=a.lead_id and c.agent_id=a.agent_id and c.created_at>=a.created_at
  order by c.created_at, c.id limit 1) c
 join public.audit_log l on l.entity='calls' and l.entity_id=c.id::text and l.action='call.manual_logged'
 join public.profiles p on p.id=l.actor_id and p.role='admin'
 where a.agent_id is not null and l.actor_id<>a.agent_id
  -- The first-call time came from that call: record_first_call stamps the
  -- later of the call's start and the assignment (same transaction time as
  -- the lead's assigned_at), not a later call by the agent.
  and a.first_call_at=greatest(c.started_at,a.created_at))
select
 case
  when (select actor and email from fixed) then 'at 078'
  when to_regprocedure('public.call_outcome_stage(text)') is not null then 'at 077, ready for 078'
  else 'NOT READY: apply CRM updates up to 077 first' end release_stage,
 (select actor from fixed) records_call_actor,
 (select email from fixed) accepts_email_confirmation,
 (select bool_and(p.prosecdef and p.proconfig=array['search_path=""'] and pg_get_userbyid(p.proowner)='postgres'
   and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute'))
  from pg_proc p where p.oid in ('public.log_manual_call(uuid,uuid,jsonb,text)'::regprocedure,
   'public.account_action_034(uuid,text,text,uuid,text,text)'::regprocedure)) functions_secure,
 (select count(*) from credited) admin_logged_first_calls,
 (select coalesce(to_char(min(started_at) at time zone 'Asia/Karachi','YYYY-MM-DD')||' to '||to_char(max(started_at) at time zone 'Asia/Karachi','YYYY-MM-DD'),'none') from credited) admin_logged_first_call_dates,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min;
