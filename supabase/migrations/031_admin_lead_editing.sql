-- Apply once after 030. Edit metadata, private phone and ownership atomically.
begin;
create function public.normalize_lead_phone(p_phone text) returns text language plpgsql immutable set search_path='' as $$
declare number text;begin
 number=regexp_replace(p_phone,'[[:space:]()+.-]','','g');
 if left(number,2)='00' then number=substr(number,3);end if;
 if left(number,1)='0' then number='92'||substr(number,2);end if;
 if number is null or number !~ '^[1-9][0-9]{9,14}$' then raise exception 'Use a valid international phone number' using errcode='22023';end if;
 return '+'||number;
end $$;
create function public.update_lead_phone(p_lead uuid,p_phone text,p_actor uuid,p_request text) returns void
language plpgsql security definer set search_path='' as $$
declare number text;other_no bigint;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 perform id from public.leads where id=p_lead for update;
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 number=public.normalize_lead_phone(p_phone);
 select l.lead_no into other_no from crm_private.lead_phones p join public.leads l on l.id=p.lead_id where p.phone=number and p.lead_id<>p_lead;
 if found then raise exception 'This number already belongs to HD-%',lpad(other_no::text,greatest(6,length(other_no::text)),'0') using errcode='23505';end if;
 if exists(select 1 from crm_private.lead_phones where lead_id=p_lead and phone=number) then return;end if;
 insert into crm_private.lead_phones(lead_id,phone) values(p_lead,number) on conflict(lead_id) do update set phone=excluded.phone;
 update public.leads set masked_phone=left(number,3)||'******'||right(number,3),updated_at=now() where id=p_lead;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.phone_changed','leads',p_lead::text,p_request,'{}');
end $$;
create function public.edit_lead(p_lead uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;fields jsonb;owner uuid;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 perform id from public.leads where id=p_lead for update;
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 if jsonb_typeof(p_data) is distinct from 'object' or p_data='{}' or (p_data-array['name','email','source','budget_min','budget_max','preferred_location','property_id','phone','assigned_agent','status','lost_reason','lost_note'])<>'{}' then raise exception 'Invalid lead fields' using errcode='22023';end if;
 fields=p_data-'phone'-'assigned_agent';
 if fields<>'{}' then perform public.crm_mutate('leads',p_lead,fields,p_actor,p_request);end if;
 if p_data?'phone' then perform public.update_lead_phone(p_lead,p_data->>'phone',p_actor,p_request);end if;
 if p_data?'assigned_agent' then
  owner=nullif(p_data->>'assigned_agent','')::uuid;
  if owner is not null and not exists(select 1 from public.profiles where id=owner and active and role='agent') then raise exception 'Choose an active agent' using errcode='22023';end if;
  if (select assigned_agent from public.leads where id=p_lead) is distinct from owner then
   if owner is null then perform public.handover_lead(p_lead,p_actor,null,p_request);else perform public.assign_lead(p_lead,p_actor,owner,p_request);end if;
  end if;
 end if;
 select to_jsonb(l) into result from public.leads l where id=p_lead;return result;
end $$;
revoke all on function public.normalize_lead_phone(text),public.update_lead_phone(uuid,text,uuid,text),public.edit_lead(uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.normalize_lead_phone(text),public.update_lead_phone(uuid,text,uuid,text),public.edit_lead(uuid,jsonb,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
