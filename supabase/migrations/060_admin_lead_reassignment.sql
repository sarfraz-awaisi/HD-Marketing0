-- Update 060: administrators move selected leads to one agent from All
-- leads, whoever has them now. Apply after 059. Safe to rerun.
--
-- admin_assign_leads: the selected leads (1–500) go to the chosen active
-- agent, whatever their calls or call outcomes. The leads are locked and
-- each lead's agent is read in the same step, then each goes through
-- assign_leads_bulk (update 030), as the single-lead Reassign does: its
-- calls, notes, deals and history stay with the lead; its pending
-- follow-ups, scheduled visits and their reminders move to the new agent;
-- each move is audited and both agents are notified. Each lead is reported:
-- * assigned: it had no agent;
-- * reassigned: it moved from another agent, who is named;
-- * skipped: it is already the chosen agent's, and is not changed;
-- * failed: not found or in Deleted leads, or the move was refused.
--
-- assign_unassigned_leads (update 057) stays for Round-robin unassigned,
-- which never takes a lead from an agent. No table, data or existing
-- function changes.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is null
  or to_regprocedure('public.assign_leads_bulk(uuid[],uuid,text,uuid,text)') is null
  or to_regclass('public.dealer_change_requests') is null then
  raise exception 'Apply CRM updates up to 059 before update 060.';
 end if;
end $$;

create or replace function public.admin_assign_leads(p_lead_ids uuid[],p_actor uuid,p_agent uuid,p_request text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_agent text;v_before jsonb;v_live uuid[];v_done jsonb;v_missing jsonb;v_results jsonb;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or p_agent is null
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then
  raise exception 'Choose 1–500 distinct leads and an agent' using errcode='22023';end if;
 select name into v_agent from public.profiles where id=p_agent and active and role='agent' for share;
 if not found then raise exception 'Choose an active agent' using errcode='22023';end if;
 -- Locked first, so each lead's agent is the one it moves from.
 perform 1 from public.leads where id=any(p_lead_ids) order by id for update;
 select coalesce(jsonb_object_agg(l.id::text,coalesce(p.name,'an agent')),'{}'::jsonb) into v_before
  from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and l.assigned_agent is not null;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'result','failed','reason','Lead not found or in Deleted leads') order by x.id),'[]'::jsonb)
  into v_missing from unnest(p_lead_ids) x(id) where not exists(select 1 from public.active_leads l where l.id=x.id);
 select array_agg(l.id order by l.id) into v_live from public.active_leads l where l.id=any(p_lead_ids);
 v_done=case when v_live is null then '{"results":[]}'::jsonb
  else public.assign_leads_bulk(v_live,p_actor,'agent',p_agent,p_request) end;
 -- Each result with the customer's name, and who had the lead.
 select coalesce(jsonb_agg(x.r||jsonb_build_object('name',l.name) order by x.r->>'result',l.name,x.r->>'id'),'[]'::jsonb) into v_results
  from (select case
    when r.value->>'result'='assigned' and v_before ? (r.value->>'id')
     then r.value||jsonb_build_object('result','reassigned','reason','Moved from '||(v_before->>(r.value->>'id')))
    when r.value->>'result'='skipped' then r.value||jsonb_build_object('reason','Already assigned to '||v_agent)
    else r.value end r
   from jsonb_array_elements((v_done->'results')||v_missing) r) x
  left join public.leads l on l.id=(x.r->>'id')::uuid;
 return jsonb_build_object(
  'assigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='assigned'),
  'reassigned',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='reassigned'),
  'skipped',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='skipped'),
  'failed',(select count(*) from jsonb_array_elements(v_results) r where r->>'result'='failed'),
  'results',v_results);
end $$;

-- Only the server's API role calls it; browsers never.
revoke all on function public.admin_assign_leads(uuid[],uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_assign_leads(uuid[],uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
