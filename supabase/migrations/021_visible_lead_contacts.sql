-- Apply once after 020. Authorized lead pages display full contacts automatically.
begin;

create function public.lead_contact_phones(p_actor uuid,p_leads uuid[],p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; locked integer; result jsonb;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_leads is null or cardinality(p_leads) not between 1 and 100 or
    (select count(distinct id) from unnest(p_leads) id)<>cardinality(p_leads) then
    raise exception 'Invalid contact selection' using errcode='22023';
  end if;
  perform 1 from public.leads where id=any(p_leads)
    and (actor.role='admin' or assigned_agent=p_actor) order by id for share;
  get diagnostics locked=row_count;
  if locked<>cardinality(p_leads) then raise exception 'Lead not found' using errcode='P0002'; end if;
  insert into crm_private.phone_reveals(user_id,lead_id)
    select p_actor,l.id from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    select p_actor,'lead.phone_revealed','leads',l.id::text,p_request,
      jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at'))
    from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  select jsonb_build_object('phones',coalesce(jsonb_object_agg(l.id::text,p.phone),'{}'::jsonb))
    into result from public.leads l left join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  return result;
end $$;
revoke all on function public.lead_contact_phones(uuid,uuid[],text) from public,anon,authenticated;
grant execute on function public.lead_contact_phones(uuid,uuid[],text) to service_role;

commit;
