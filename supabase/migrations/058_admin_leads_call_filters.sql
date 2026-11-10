-- Update 058: two more filters for administrators' All leads. Apply after
-- 057. Safe to rerun.
--
-- admin_lead_list (update 057) also filters by:
-- * outcome: the outcome of the lead's latest call of any kind, Number off
--   included, as agents' Lead pipeline filters it (update 053);
-- * temperature: hot, warm or cold from the latest temperature saved with a
--   call, or none, as the Lead pipeline reads it (update 052).
-- Both apply in the database, with the search and the other filters, before
-- counting and paging. Every other filter, the counts, order, pages and rows
-- are as in 057; a lead with no call matches no outcome and has no
-- temperature.
--
-- Only admin_lead_list is replaced. No table, data or other function
-- changes.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.assign_unassigned_leads(uuid[],uuid,text,uuid,text)') is null then
  raise exception 'Apply CRM updates up to 057 before update 058.';
 end if;
end $$;

create or replace function public.admin_lead_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_search text;v_assignment text;v_agent uuid;v_call text;v_status text;v_lost text;
 v_temperature text;v_outcome text;
 v_source text;v_import uuid;v_page integer;v_ids boolean;v_limit constant integer=20;
 v_digits text;v_phone text;v_like text;v_no bigint;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e
   where e.key not in ('search','assignment','agent','call','status','lost_reason','temperature','outcome','source','import','page','ids')
    or jsonb_typeof(e.value) not in ('string','number','boolean')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_search=nullif(btrim(coalesce(q->>'search','')),'');v_assignment=q->>'assignment';v_call=q->>'call';
 v_status=q->>'status';v_lost=q->>'lost_reason';v_source=q->>'source';v_temperature=q->>'temperature';v_outcome=q->>'outcome';
 begin
  v_page=coalesce((q->>'page')::integer,1);v_ids=coalesce((q->>'ids')::boolean,false);
  v_agent=(q->>'agent')::uuid;v_import=(q->>'import')::uuid;
 exception when others then raise exception 'Choose valid lead filters' using errcode='22023';
 end;
 if v_page not between 1 and 100000 or length(coalesce(v_search,''))>100
  or (v_assignment is not null and v_assignment not in ('assigned','unassigned'))
  or (v_agent is not null and v_assignment='unassigned')
  or (v_call is not null and v_call not in ('uncalled','missed'))
  or (v_status is not null and v_status not in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'))
  or (v_lost is not null and v_lost not in ('price','location','budget','not_interested','no_response','bought_elsewhere','wrong_number','other'))
  or (v_source is not null and v_source not in ('manual','CSV','Meta','WhatsApp','other'))
  or (v_temperature is not null and v_temperature not in ('hot','warm','cold','none'))
  or (v_outcome is not null and v_outcome not in ('No answer','Busy','Wrong number','Number off','Interested',
   'Not interested','Follow-up required','Site visit scheduled','Deal discussion')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if v_search is not null then
  v_digits=regexp_replace(v_search,'[^0-9]','','g');
  if v_search ~* '^hd-?[0-9]{1,18}$' then
   v_no=v_digits::bigint;
  elsif v_search ~ '^[0-9 ()+.-]+$' and length(v_digits) between 4 and 15 then
   -- As agent_lead_list (update 053): numbers are stored as +92…; the
   -- digits match as typed (part of a number), or written as stored when
   -- they start like a number: 0092… and 03… become 92…, and a ten-digit
   -- mobile number without its 0 gets 92 in front.
   v_phone=case when v_digits like '00%' and length(v_digits)>=12 then substr(v_digits,3)
    when v_digits like '03%' then '92'||substr(v_digits,2)
    when v_digits ~ '^3[0-9]{9}$' then '92'||v_digits else v_digits end;
  else
   v_digits=null;v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  end if;
 end if;
 with base as (
  -- Every filter but assignment; matches: the assignment filter too.
  select l.id,l.assigned_agent,l.created_at,l.call_due_at,
   (v_assignment is null or (v_assignment='assigned')=(l.assigned_agent is not null))
    and (v_agent is null or l.assigned_agent=v_agent) matches
  from public.leads l
  where l.deleted_at is null
   and (v_search is null
    or (v_no is not null and l.lead_no=v_no)
    or (v_phone is not null and l.id in (select p.lead_id from crm_private.lead_phones p
     where p.phone like '%'||v_digits||'%' or p.phone like '%'||v_phone||'%'))
    or (v_like is not null and l.name ilike v_like))
   -- Open leads still waiting for their owner's first call (update 038).
   and (v_call is null or (l.first_call_at is null and l.call_due_at is not null and l.assigned_agent is not null
    and l.status not in ('won','lost') and case when v_call='missed' then l.call_due_at<now() else l.call_due_at>=now() end))
   and (v_status is null or l.status=v_status)
   and (v_lost is null or l.lost_reason=v_lost)
   and (v_source is null or l.source=v_source)
   and (v_import is null or l.import_id=v_import)
   -- The outcome of the lead's latest call of any kind, and the latest
   -- temperature saved with a call, read as agent_lead_list reads them
   -- (updates 052 and 053); worked out only when filtered by.
   and (v_outcome is null or (select c.outcome from public.calls c where c.lead_id=l.id
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) is not distinct from v_outcome)
   and (v_temperature is null or coalesce((select case t.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end
    from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
    where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')
    order by c.started_at desc,c.created_at desc,c.id desc limit 1),'none')=v_temperature)
 ), ordered as (
  select b.id,row_number() over(order by
    case when v_call is not null then b.call_due_at end nulls last,
    b.created_at desc,b.id desc) rn
  from base b where b.matches
 ), shown as (
  select o.rn,l.*,p.name assigned_name,p.active assigned_active,la.started_at last_call_at,la.outcome last_call_outcome,
   la.status='completed' last_call_connected
  from ordered o join public.leads l on l.id=o.id
  left join public.profiles p on p.id=l.assigned_agent
  -- The latest call of any kind, as agents' Assigned leads show it.
  left join lateral (select c.started_at,c.outcome,c.status from public.calls c where c.lead_id=l.id
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) la on true
  where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit
 )
 select case when v_ids then jsonb_build_object('count',(select count(*) from base where matches),
   'ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from base where matches))
  else jsonb_build_object('page',v_page,'limit',v_limit,'count',(select count(*) from base where matches),
  'totals',(select jsonb_build_object('total',count(*),'assigned',count(assigned_agent),'unassigned',count(*)-count(assigned_agent)) from base),
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'lead_no',s.lead_no,'name',s.name,'email',s.email,
     'masked_phone',s.masked_phone,'status',s.status,'source',s.source,'import_id',s.import_id,
     'assigned_agent',s.assigned_agent,'assigned_name',s.assigned_name,'assigned_active',s.assigned_active,
     'meta_pending_assignment',s.meta_pending_assignment,'created_at',s.created_at,'assigned_at',s.assigned_at,
     'call_due_at',s.call_due_at,'first_call_at',s.first_call_at,'missed_at',s.missed_at,
     'last_call_at',s.last_call_at,'last_call_outcome',s.last_call_outcome,'last_call_connected',s.last_call_connected)
    order by s.rn) from shown s),'[]'::jsonb)) end
 into result;
 if v_ids and (result->>'count')::bigint>500 then
  raise exception 'Choose filters that match 500 leads or fewer to select them all.' using errcode='22023';
 end if;
 return result;
end $$;

-- As before: only the server's API role calls it; browsers never.
revoke all on function public.admin_lead_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_lead_list(uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
