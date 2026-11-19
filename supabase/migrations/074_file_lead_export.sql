-- Update 074: the lead export lists one lead file's leads that are assigned
-- to an agent now, in exactly the Lead pipeline export's columns. Apply
-- after 073. Safe to rerun. Read-only functions only: no table, row or
-- existing function changes.
--
-- A lead file is a Google Sheet (told apart by its spreadsheet ID and tab;
-- it keeps one lead file, update 056), an imported CSV or Excel file, or "No
-- file" for leads added another way. The file is the one that created the
-- lead (leads.import_id), whatever happened to it since: a repeat inquiry
-- from a customer who was already a lead stays on that lead and its file.
-- Leads in Deleted leads are never matched; erased leads no longer exist.
--
-- Every assigned lead of the file is listed, called or not. Each is read as
-- the administrators' Lead pipeline reads a lead (admin_agent_pipeline and
-- agent_spoken_leads, updates 053 and 055), whether or not its agent has
-- reached the customer yet:
-- * the agent's own calls: filed under the agent and recorded by the agent
--   (the call's first audit entry), so an administrator's call is never the
--   agent's;
-- * last contact: the latest own answered call; last call: the latest own
--   call, answered or not;
-- * latest note: the newest lead note the agent wrote or call note the agent
--   recorded;
-- * temperature: the latest Hot, Warm or Cold saved with a call since the
--   lead came to its current agent (lead_export_temperature, update 073);
-- * next follow-up: the earliest pending one.
--
-- Filters (p_query keys): file (a lead file ID) or no_file (true), exactly
-- one; then, all optional: agent, temperature (hot, warm, cold, none),
-- status, outcome (of the agent's last call), contacted (yes: the agent has
-- reached the customer), worked (yes: the agent has called).
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.lead_export_temperature(uuid)') is null or to_regprocedure('public.lead_export_sources(uuid)') is null
  or to_regclass('crm_private.lead_file_rows') is null then
  raise exception 'Apply CRM updates up to 073 before update 074.';
 end if;
end $$;

-- ------------------------------------------------------------------ helpers
-- The agent's own work on a lead, by the Lead pipeline's rules (above).
create or replace function public.lead_file_export_work(p_lead uuid,p_agent uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with own as (
  select c.started_at,c.created_at,c.id,c.outcome,c.status='completed' connected from public.calls c
  where c.lead_id=p_lead and c.agent_id=p_agent
   and (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
    and a.action in ('create','call.manual_logged') order by a.id limit 1)=p_agent
 ), contact as (
  select o.started_at,o.outcome from own o where o.connected order by o.started_at desc,o.created_at desc,o.id desc limit 1
 ), latest as (
  select o.started_at,o.outcome from own o order by o.started_at desc,o.created_at desc,o.id desc limit 1
 ), note as (
  select x.body,x.at from (
   select n.body,n.created_at at from public.notes n where n.lead_id=p_lead and btrim(n.body)<>''
    and exists(select 1 from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text
     and a.action='create' and a.actor_id=p_agent)
   union all
   select c.notes,c.created_at from public.calls c where c.lead_id=p_lead and btrim(coalesce(c.notes,''))<>''
    and exists(select 1 from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
     and a.action in ('create','call.manual_logged') and a.actor_id=p_agent)
  ) x order by x.at desc limit 1
 )
 select jsonb_build_object('last_contact_at',(select started_at from contact),'last_contact_outcome',(select outcome from contact),
  'last_call_at',(select started_at from latest),'last_call_outcome',(select outcome from latest),
  'note',(select body from note),'note_at',(select at from note))
$$;

-- The file's assigned leads matching the filters, with what orders them:
-- their row in the file, then when they were created.
create or replace function public.lead_file_export_match(p_query jsonb) returns table(lead_id uuid,file_row integer,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}');v_file uuid;v_no_file boolean;v_agent uuid;v_work boolean;
 outcomes constant text[]=array['No answer','Busy','Wrong number','Number off','Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion'];
begin
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e where e.key not in ('file','no_file','agent','temperature','status',
   'outcome','contacted','worked') or jsonb_typeof(e.value) not in ('string','boolean'))
  or (q->>'temperature' is not null and q->>'temperature' not in ('hot','warm','cold','none'))
  or (q->>'status' is not null and q->>'status' not in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'))
  or (q->>'outcome' is not null and not (q->>'outcome')=any(outcomes))
  or (q->>'contacted' is not null and q->>'contacted' not in ('yes','no'))
  or (q->>'worked' is not null and q->>'worked' not in ('yes','no')) then
  raise exception 'Choose valid export filters' using errcode='22023';
 end if;
 begin
  v_file=(q->>'file')::uuid;
  v_no_file=coalesce((q->>'no_file')::boolean,false);
  v_agent=(q->>'agent')::uuid;
 exception when others then raise exception 'Choose valid export filters' using errcode='22023';
 end;
 if (v_file is not null)=v_no_file then raise exception 'Choose one lead file' using errcode='22023';end if;
 if v_file is not null and not exists(select 1 from public.lead_imports i where i.id=v_file and i.deleted_at is null) then
  raise exception 'Choose a lead file from the list' using errcode='P0002';
 end if;
 v_work=q ? 'outcome' or q ? 'contacted' or q ? 'worked';
 return query
 select l.id,fr.file_row,l.created_at from public.leads l
 left join crm_private.lead_file_rows fr on fr.lead_id=l.id and fr.import_id=l.import_id
 left join lateral (select public.lead_file_export_work(l.id,l.assigned_agent) w where v_work) w on true
 where l.deleted_at is null and l.assigned_agent is not null
  and (case when v_no_file then l.import_id is null else l.import_id=v_file end)
  and (v_agent is null or l.assigned_agent=v_agent)
  and (q->>'status' is null or l.status=q->>'status')
  and (q->>'temperature' is null or coalesce(public.lead_export_temperature(l.id)->>'value','none')=q->>'temperature')
  and (q->>'outcome' is null or w.w->>'last_call_outcome'=q->>'outcome')
  and (q->>'contacted' is null or (w.w->>'last_contact_at' is not null)=(q->>'contacted'='yes'))
  and (q->>'worked' is null or (w.w->>'last_call_at' is not null)=(q->>'worked'='yes'));
end $$;

-- ------------------------------------------------------------- the export
-- How many leads match, and the file's own figures: its leads in the CRM
-- (not in Deleted leads) and how many of them are assigned now. With p_ids,
-- the matching leads' IDs in export order, up to 50,000.
create or replace function public.lead_file_export_ids(p_actor uuid,p_query jsonb,p_ids boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_file uuid;v_no_file boolean;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 with m as (select * from public.lead_file_export_match(p_query))
 select jsonb_build_object('count',(select count(*) from m),
  'ids',case when p_ids then coalesce((select jsonb_agg(m.lead_id order by m.file_row nulls last,m.created_at,m.lead_id) from m),'[]'::jsonb) end)
 into result;
 -- The filters were checked above.
 v_file=(p_query->>'file')::uuid;v_no_file=coalesce((p_query->>'no_file')::boolean,false);
 select result||jsonb_build_object('in_file',count(*),'assigned',count(*) filter (where l.assigned_agent is not null))
 into result from public.leads l
 where l.deleted_at is null and (case when v_no_file then l.import_id is null else l.import_id=v_file end);
 result=result||jsonb_build_object('file',(select jsonb_build_object('id',i.id,'name',coalesce(s.name,i.file_name),'format',i.file_format)
  from public.lead_imports i left join public.sheet_sources s on s.import_id=i.id where i.id=v_file));
 if p_ids and (result->>'count')::integer>50000 then
  raise exception 'More than 50,000 leads match. Choose narrower filters.' using errcode='22023';end if;
 return result;
end $$;

-- Up to 500 leads (export order kept), each as admin_agent_pipeline lists a
-- lead, with its agent. Never the phone number: the server adds it as every
-- lead list does, recorded as viewed. A lead now in Deleted leads or with no
-- agent is left out, so the server can tell the leads changed meanwhile.
create or replace function public.lead_file_export_rows(p_actor uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if p_ids is null or cardinality(p_ids) not between 1 and 500 then raise exception 'Choose up to 500 leads' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'lead_no',l.lead_no,'name',l.name,'email',l.email,'status',l.status,
   'source',l.source,'ad_name',l.ad_name,'created_at',l.created_at,'last_activity_at',l.last_activity_at,'assigned_at',l.assigned_at,
   'temperature',t.t->>'value','temperature_at',t.t->'at',
   'next_followup_at',(select min(f.due_at) from public.followups f where f.lead_id=l.id and f.status='pending'),
   'agent',jsonb_build_object('id',p.id,'uid',p.uid,'name',p.name,'active',p.active))||w.w order by x.ord)
  from unnest(p_ids) with ordinality x(id,ord)
  join public.leads l on l.id=x.id and l.deleted_at is null and l.assigned_agent is not null
  join public.profiles p on p.id=l.assigned_agent
  cross join lateral (select public.lead_export_temperature(l.id) t) t
  cross join lateral (select public.lead_file_export_work(l.id,l.assigned_agent) w) w),'[]'::jsonb);
end $$;

-- Only the CRM's server calls the export functions; the helpers only from
-- them. The export functions are volatile (the default): the database API
-- runs stable functions read-only, and accounts_admin locks the
-- administrator's row.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('lead_file_export_work','lead_file_export_match','lead_file_export_ids','lead_file_export_rows') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname in ('lead_file_export_ids','lead_file_export_rows') then
   execute format('grant execute on function %s to service_role',fn.signature);
  else
   execute format('revoke all on function %s from service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
