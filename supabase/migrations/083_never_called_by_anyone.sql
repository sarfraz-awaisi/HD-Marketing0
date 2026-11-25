-- Update 083: Never called on All leads means never called by anyone: an
-- assigned lead (not in Deleted leads) with no saved call outcome at all,
-- from any agent or administrator, in any assignment. Apply after 082. Safe
-- to rerun. No call, lead, assignment or audit entry is changed.
--
-- * lead_never_called (update 082) counted only the current agent's calls
--   since receiving the lead; now any saved outcome on the lead, ever,
--   makes it called (No answer, Busy and Number off too). A call with no
--   outcome saved still does not. Won and Lost leads stay out unless Lost
--   before reaching their current agent, as in New and Missed first call.
-- * admin_distribute_never_called keeps with their agent the leads called
--   (by anyone) or marked Won or Lost since the list loaded; its checks,
--   locks and moves are as in update 082.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.lead_never_called(uuid)') is null
  or to_regprocedure('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)') is null then
  raise exception 'Apply CRM updates up to 082 before update 083.';
 end if;
end $$;

create or replace function public.lead_never_called(p_lead uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select l.assigned_agent is not null
   and not exists(select 1 from public.calls c where c.lead_id=l.id and c.outcome is not null)
   and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))
  from public.active_leads l where l.id=p_lead),false)
$$;

create or replace function public.admin_distribute_never_called(p_actor uuid,p_lead_ids uuid[],p_agents uuid[],
 p_apply boolean,p_token text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_kept jsonb;v_called uuid[];v_rest uuid[];result jsonb;
begin
 if p_apply then perform pg_advisory_xact_lock(873420);end if;
 perform public.accounts_admin(p_actor);
 if p_apply is null or p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or p_agents is null or cardinality(p_agents) not between 1 and 50 then
  raise exception 'Choose 1–500 distinct leads and 1–50 distinct agents' using errcode='22023';end if;
 -- A call being logged on one of these leads (log_manual_call locks the
 -- lead) finishes first and is seen, or waits until the move is done.
 if p_apply then
  perform 1 from public.profiles where id=any(p_agents) order by id for share;
  perform 1 from public.leads where id=any(p_lead_ids) order by id for update;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'result','kept',
   'reason',case when l.status in ('won','lost') and not public.lead_first_call_reopened(l.id)
    then 'Marked '||initcap(l.status)||': stays with '||coalesce(p.name,'its agent')
    else 'Called meanwhile: stays with '||coalesce(p.name,'its agent') end)
   order by l.lead_no,l.id),'[]'::jsonb),coalesce(array_agg(l.id),'{}')
  into v_kept,v_called
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and l.assigned_agent is not null and not public.lead_never_called(l.id);
 v_rest=array(select x from unnest(p_lead_ids) x where x<>all(v_called));
 if cardinality(v_rest)=0 then
  raise exception 'Choose other leads: every selected lead has been called by its agent since receiving it, so nothing moves.' using errcode='22023';
 end if;
 result=public.admin_distribute_leads(p_actor,v_rest,p_agents,p_apply,p_token,p_request);
 return result||jsonb_build_object('kept',jsonb_array_length(v_kept),'results',(result->'results')||v_kept);
end $$;

revoke all on function public.lead_never_called(uuid) from public,anon,authenticated,service_role;
revoke all on function public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text) from public,anon,authenticated;
grant execute on function public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
