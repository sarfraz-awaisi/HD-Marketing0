-- Apply once after 029. At most 500 distinct leads; existing ownership handover rules remain.
begin;
create function public.assign_leads_bulk(p_lead_ids uuid[],p_actor uuid,p_mode text,p_agent uuid,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;owner uuid;chosen uuid;pending boolean;recipients uuid[];rr_index int=0;rows jsonb='[]';n int=0;s int=0;f int=0;reason text;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if p_mode is null or p_mode not in ('agent','round_robin','unassign') or cardinality(p_lead_ids) not between 1 and 500 or p_lead_ids is null
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or (p_mode='agent' and p_agent is null) or (p_mode<>'agent' and p_agent is not null) then
  raise exception 'Choose 1–500 distinct leads and a valid assignment mode' using errcode='22023';end if;
 if p_mode='agent' then
  perform id from public.profiles where id=p_agent and active and role='agent' for share;
  if not found then raise exception 'Choose an active agent' using errcode='22023';end if;
 elsif p_mode='round_robin' then
  perform id from public.profiles where active and role='agent' order by id for share;
  -- now() is constant within a transaction. Capture the initial least-recent
  -- order once and rotate explicitly, rather than repeatedly comparing tied timestamps.
  select array_agg(id order by last_assigned nulls first,id) into recipients from(
   select p.id,max(a.created_at) last_assigned from public.profiles p left join public.assignments a on a.agent_id=p.id
   where p.active and p.role='agent' group by p.id
  ) eligible;
 end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  begin
   select assigned_agent,meta_pending_assignment into owner,pending from public.leads where id=item;
   if not found then raise exception 'Lead not found' using errcode='P0002';end if;
   chosen=p_agent;
   if p_mode='round_robin' then
    if pending then raise exception 'Choose an agent explicitly for an incoming social lead' using errcode='22023';end if;
    if coalesce(cardinality(recipients),0)=0 then raise exception 'No active agents' using errcode='22023';end if;
    chosen=recipients[1+(rr_index%cardinality(recipients))];rr_index=rr_index+1;
   end if;
   if owner is not distinct from chosen then
    s=s+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','skipped','reason','Already assigned to this owner'));
   else
    if p_mode='unassign' then perform public.handover_lead(item,p_actor,null,p_request);
    else perform public.assign_lead(item,p_actor,chosen,p_request);end if;
    n=n+1;rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','assigned'));
   end if;
  exception when sqlstate 'P0002' or sqlstate '22023' then
   f=f+1;reason=case when sqlstate='P0002' then 'Lead not found' else 'Assignment unavailable; check the lead and active agents' end;
   rows=rows||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason',reason));
  end;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_assigned','leads',p_request,jsonb_build_object('assigned',n,'skipped',s,'failed',f));
 return jsonb_build_object('assigned',n,'skipped',s,'failed',f,'results',rows);
end $$;
revoke all on function public.assign_leads_bulk(uuid[],uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.assign_leads_bulk(uuid[],uuid,text,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
