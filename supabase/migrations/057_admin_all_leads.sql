-- Update 057: administrators' All leads. Apply after 056. Safe to rerun.
--
-- * admin_lead_list: every lead not in Deleted leads, for administrators,
--   worked out in the database across every page.
--   - Search: the customer's name, or their contact number in any common
--     Pakistani format or any part of it (as agents search since update
--     053), or an HD number written with HD.
--   - Filters: assignment (assigned, unassigned, or one agent), first call
--     (update 038), status and lost reason, source and lead file. They all
--     apply together.
--   - Total, Assigned and Unassigned count the leads matching everything but
--     the assignment filter, so they say how many of the matching leads each
--     choice holds.
--   - Newest first, 20 a page; leads waiting for a first call, longest
--     waiting first. With ids: the IDs of up to 500 matching leads, for
--     Select all matching.
-- * assign_unassigned_leads: bulk assignment that never takes a lead from
--   an agent. The leads are locked; one that has an agent is skipped and
--   named; the rest go through assign_leads_bulk (update 030), to one agent
--   or round-robin, with its rules, per-lead results and audit entries.
--
-- No table, data or existing function changes. Phone numbers stay in
-- crm_private.lead_phones; the list returns none (the server adds the
-- numbers administrators may see, as for every lead list).
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.assign_leads_bulk(uuid[],uuid,text,uuid,text)') is null or to_regclass('public.active_leads') is null
  or to_regprocedure('public.lead_ad_inquiries(uuid,uuid)') is null or to_regprocedure('public.accounts_admin(uuid)') is null then
  raise exception 'Apply CRM updates up to 056 before update 057.';
 end if;
end $$;

create or replace function public.admin_lead_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_search text;v_assignment text;v_agent uuid;v_call text;v_status text;v_lost text;
 v_source text;v_import uuid;v_page integer;v_ids boolean;v_limit constant integer=20;
 v_digits text;v_phone text;v_like text;v_no bigint;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e
   where e.key not in ('search','assignment','agent','call','status','lost_reason','source','import','page','ids')
    or jsonb_typeof(e.value) not in ('string','number','boolean')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_search=nullif(btrim(coalesce(q->>'search','')),'');v_assignment=q->>'assignment';v_call=q->>'call';
 v_status=q->>'status';v_lost=q->>'lost_reason';v_source=q->>'source';
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
  or (v_source is not null and v_source not in ('manual','CSV','Meta','WhatsApp','other')) then
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

create or replace function public.assign_unassigned_leads(p_lead_ids uuid[],p_actor uuid,p_mode text,p_agent uuid,p_request text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_free uuid[];v_done jsonb;v_kept jsonb;v_missing jsonb;v_results jsonb;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or p_mode is null or p_mode not in ('agent','round_robin')
  or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids)
  or (p_mode='agent' and p_agent is null) or (p_mode<>'agent' and p_agent is not null) then
  raise exception 'Choose 1–500 distinct leads and an agent or round-robin' using errcode='22023';end if;
 -- Locked first, so no lead gains an agent between this check and its
 -- assignment.
 perform 1 from public.leads where id=any(p_lead_ids) order by id for update;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'result','skipped','reason','Already assigned to '||coalesce(p.name,'an agent')) order by l.id),'[]'::jsonb)
  into v_kept from public.active_leads l left join public.profiles p on p.id=l.assigned_agent
  where l.id=any(p_lead_ids) and l.assigned_agent is not null;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'result','failed','reason','Lead not found or in Deleted leads') order by x.id),'[]'::jsonb)
  into v_missing from unnest(p_lead_ids) x(id) where not exists(select 1 from public.active_leads l where l.id=x.id);
 select array_agg(l.id order by l.id) into v_free from public.active_leads l where l.id=any(p_lead_ids) and l.assigned_agent is null;
 v_done=case when v_free is null then '{"assigned":0,"skipped":0,"failed":0,"results":[]}'::jsonb
  else public.assign_leads_bulk(v_free,p_actor,p_mode,p_agent,p_request) end;
 -- Each result with the customer's name, for the administrator's report.
 select coalesce(jsonb_agg(r.value||jsonb_build_object('name',l.name) order by r.value->>'result',l.name,r.value->>'id'),'[]'::jsonb)
  into v_results from jsonb_array_elements((v_done->'results')||v_kept||v_missing) r left join public.leads l on l.id=(r.value->>'id')::uuid;
 return jsonb_build_object('assigned',(v_done->>'assigned')::integer,
  'skipped',(v_done->>'skipped')::integer+jsonb_array_length(v_kept),
  'failed',(v_done->>'failed')::integer+jsonb_array_length(v_missing),'results',v_results);
end $$;

-- Only the server's API role calls these; browsers never.
revoke all on function public.admin_lead_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_lead_list(uuid,jsonb) to service_role;
revoke all on function public.assign_unassigned_leads(uuid[],uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.assign_unassigned_leads(uuid[],uuid,text,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
