-- Update 061: a fresh workspace for a lead reassigned to another agent.
-- Apply after 060. Safe to rerun.
--
-- * A lead's assignment period starts at leads.assigned_at, which every
--   owner change already sets (update 038). When the lead had another agent
--   before, its agent's workspace holds only what was recorded since then:
--   notes, calls (outcomes, comments and tags), status changes, follow-ups,
--   visits and deals. A lead's first agent sees its whole history, as before.
-- * Carried over: pending follow-ups and scheduled visits that moved with the
--   lead (update 022), and an open deal. The agent sees their dates, times
--   and property, never the earlier comments, and may complete, reschedule
--   or cancel them but not rewrite them.
-- * Indicators: Reassigned for the whole assignment; New until the agent's
--   first call; "previously not interested" until then too, only when the
--   previous assignment ended Not interested (its latest call, or the lead
--   marked Lost for that reason). A lead moved back to an earlier agent
--   (A, B, then A) starts a fresh period as well.
-- * The stage an agent sees follows their own work, as a new lead's does:
--   New, Contacted after an answered call, a visit or deal stage, or the
--   stage they set. The lead's own status is never changed by this.
-- * A Lost lead reassigned to another agent joins that agent's first-call
--   workflow (Waiting for first call, the deadline and missed-call alerts)
--   while it stays Lost until someone changes it.
-- * Only the agent's own call is their first call on such a lead; an
--   administrator's call there does not end New or the first-call deadline.
-- * Agents cannot change records from an earlier assignment.
--
-- Administrators keep the full history, and reports keep their numbers: no
-- table and no row changes. One index; new helpers; agent_lead_list,
-- agent_pipeline_attribution, visit_calendar, first_call_queue, crm_mutate,
-- record_first_call and the lead_review_queue view replaced; and checked
-- edits: six functions take the first-call rule for reassigned Lost leads,
-- log_manual_call records who logs a call, report_drilldown and
-- dashboard_snapshot scope what agents see, and the administrators' agent
-- pipeline pages follow the agent's own (agent_pipeline_numbers and
-- admin_agent_pipeline). Each edit is checked before it is made.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_assign_leads(uuid[],uuid,uuid,text)') is null
  or to_regprocedure('public.crm_mutate_031(text,uuid,jsonb,uuid,text)') is null
  or to_regprocedure('public.crm_metrics_038(uuid,timestamptz,timestamptz,uuid,text)') is null
  or to_regprocedure('public.report_today_records(text,uuid)') is null then
  raise exception 'Apply CRM updates up to 060 before update 061.';
 end if;
end $$;

-- Status saves on a lead, found by lead (the stage an agent sees).
create index if not exists audit_log_lead_records on public.audit_log(entity_id,created_at) where entity='leads';

-- ------------------------------------------------------- the period
-- When the current agent's workspace began: the lead's assignment time, if
-- another agent had the lead before. Null: the whole history is theirs.
create or replace function public.workspace_since(p_lead uuid) returns timestamptz
language sql stable security definer set search_path='' as $$
 select l.assigned_at from public.leads l
 where l.id=p_lead and l.assigned_agent is not null and l.assigned_at is not null
  and exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id is not null
   and a.agent_id<>l.assigned_agent and a.created_at<l.assigned_at)
$$;

-- Where a record stands for the lead's current agent: 'current' (recorded
-- in this period, or the lead was never anyone else's), 'carried' (a
-- commitment that moved with the lead, shown without earlier comments) or
-- 'hidden' (an earlier assignment's work: administrators only). Moved
-- follow-ups and visits are filed under the new agent (update 022); one
-- completed or cancelled before the move stays with whoever had it.
create or replace function public.workspace_item(p_kind text,p_lead uuid,p_created timestamptz,p_agent uuid,
 p_status text,p_updated timestamptz,p_completed timestamptz) returns text
language sql stable security definer set search_path='' as $$
 select case when w.since is null or p_created>=w.since then 'current'
  when p_kind='followups' and p_agent=w.owner
   and (p_status='pending' or p_completed>=w.since or (p_status='cancelled' and p_updated>w.since)) then 'carried'
  when p_kind='visits' and p_agent=w.owner and (p_status='scheduled' or p_updated>w.since) then 'carried'
  when p_kind='deals' and (p_status in ('discussion','negotiation') or p_updated>w.since) then 'carried'
  else 'hidden' end
 from (select public.workspace_since(p_lead) since,(select l.assigned_agent from public.leads l where l.id=p_lead) owner) w
$$;

-- The same for one record. The API selects and filters these like columns
-- (workspace_state) for agents.
create or replace function public.workspace_state(public.notes) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('notes',$1.lead_id,$1.created_at,$1.agent_id,null,null,null) $$;
create or replace function public.workspace_state(public.calls) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('calls',$1.lead_id,$1.created_at,$1.agent_id,$1.status,null,null) $$;
create or replace function public.workspace_state(public.followups) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('followups',$1.lead_id,$1.created_at,$1.agent_id,$1.status,$1.updated_at,$1.completed_at) $$;
create or replace function public.workspace_state(public.visits) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('visits',$1.lead_id,$1.created_at,$1.agent_id,$1.status,$1.updated_at,null) $$;
create or replace function public.workspace_state(public.deals) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('deals',$1.lead_id,$1.created_at,$1.agent_id,$1.stage,$1.updated_at,null) $$;
create or replace function public.workspace_state(public.lead_status_history) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('lead_status_history',$1.lead_id,$1.created_at,null,null,null,null) $$;
create or replace function public.workspace_state(public.assignments) returns text language sql stable security definer set search_path='' as $$
 select public.workspace_item('assignments',$1.lead_id,$1.created_at,$1.agent_id,null,null,null) $$;

-- A Lost lead that came to its agent from another agent, lost before this
-- assignment: it waits for the new agent's first call like a new lead.
create or replace function public.lead_first_call_reopened(p_lead uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select l.status='lost' and l.lost_at<public.workspace_since(l.id) from public.leads l where l.id=p_lead),false)
$$;

-- What the lead's agent sees of it: whether it was reassigned and since
-- when, the stage of this assignment, and the previous assignment's result
-- until the agent's first call.
create or replace function public.lead_workspace(p_lead uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when w.since is null then jsonb_build_object('reassigned',false,'since',null,'status',l.status,
   'previous_result',null,'first_call_reopened',false)
  else jsonb_build_object('reassigned',true,'since',w.since,
   'status',case
    -- A stage set or saved again in this assignment (a status change, or the
    -- same stage chosen once more): the lead's own status.
    when exists(select 1 from public.audit_log a where a.entity='leads' and a.entity_id=l.id::text and a.created_at>=w.since
     and (a.action='status_change' or (a.action='update' and coalesce(a.metadata->'fields','[]'::jsonb) ? 'status'))) then l.status
    -- Otherwise the furthest this assignment's own activity has gone.
    else coalesce((select (array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'])[max(x.n)] from (
      select 2 n from public.calls c where c.lead_id=l.id and c.status='completed' and c.created_at>=w.since
      union all
      select case v.status when 'scheduled' then 4 when 'completed' then 5 end from public.visits v where v.lead_id=l.id
       and (v.created_at>=w.since or (v.status='completed' and v.updated_at>w.since and v.agent_id=l.assigned_agent))
      union all
      select case d.stage when 'won' then 7 when 'lost' then 8 else 6 end from public.deals d where d.lead_id=l.id
       and (d.created_at>=w.since or d.updated_at>w.since)) x),'new') end,
   'previous_result',case when l.first_call_at is null and (
     (l.status='lost' and l.lost_reason='not_interested' and l.lost_at<w.since)
     or (select c.outcome from public.calls c where c.lead_id=l.id and c.created_at<w.since
      and c.created_at>=(select max(a.created_at) from public.assignments a
       where a.lead_id=l.id and a.agent_id is not null and a.created_at<w.since)
      order by c.started_at desc,c.created_at desc,c.id desc limit 1)='Not interested') then 'not_interested' end,
   'first_call_reopened',l.status='lost' and l.lost_at<w.since)
  end
 from public.leads l cross join lateral (select public.workspace_since(l.id) since) w where l.id=p_lead
$$;

-- For the server: the workspace of each given lead assigned to this agent
-- now (others are left out).
create or replace function public.agent_workspaces(p_actor uuid,p_leads uuid[]) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if p_leads is null or cardinality(p_leads)>500 then raise exception 'Choose valid leads' using errcode='22023';end if;
 select coalesce(jsonb_object_agg(l.id::text,public.lead_workspace(l.id)),'{}'::jsonb) into result
 from public.leads l where l.id=any(p_leads) and l.assigned_agent=p_actor and l.deleted_at is null;
 return result;
end $$;

-- ------------------------------------------------------- saving
-- As in update 032, plus: an agent never changes an earlier assignment's
-- records, and changes a carried-over commitment's time, status, property
-- or deal terms only, never its earlier comments.
create or replace function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid;v_role text;v_state text;begin
 select role into v_role from public.profiles where id=p_actor and active;
 if not found then raise exception 'Forbidden' using errcode='42501';end if;
 if p_table='leads' then target=p_id;
 elsif p_table in ('notes','calls','followups','visits','deals') then
  if p_id is null then target=(p_data->>'lead_id')::uuid;
  else execute format('select lead_id from public.%I where id=$1',p_table) into target using p_id;end if;
 end if;
 if target is not null then
  perform id from public.active_leads where id=target for update;
  if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 end if;
 if p_id is not null and v_role<>'admin' and p_table in ('notes','calls','followups','visits','deals') then
  execute format('select public.workspace_state(t) from public.%I t where id=$1',p_table) into v_state using p_id;
  if v_state='hidden' or (v_state='carried' and exists(select 1 from jsonb_object_keys(coalesce(p_data,'{}'::jsonb)) k
    -- lead_id and agent_id never change on an update (crm_mutate_031).
    where k<>all(array['lead_id','agent_id']||case p_table when 'followups' then array['due_at','status']
     when 'visits' then array['scheduled_at','status','property_id']
     else array['stage','expected_value','close_date','property_id','lost_reason','lost_note'] end))) then
   raise exception 'Records from an earlier assignment cannot be changed' using errcode='42501';
  end if;
 end if;
 return public.crm_mutate_031(p_table,p_id,p_data,p_actor,p_request);
end $$;

-- ------------------------------------------------------- agents' lists
-- As in update 053, for the current assignment: the latest call, the
-- latest answered call (what puts a lead in the pipeline), the temperature
-- and the agent's own latest note come from this period only, the stage is
-- the workspace's, and a reassigned Lost lead waits for a first call. Each
-- row also says whether the lead was reassigned and, until the first call,
-- the previous result. New filter: assignment 'reassigned'.
create or replace function public.agent_lead_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_view text;v_import uuid;v_search text;v_status text;v_temperature text;
 v_source text;v_call text;v_outcome text;v_assignment text;v_sort text;v_page integer;v_limit constant integer=20;
 v_digits text;v_phone text;v_like text;result jsonb;
begin
 -- Agents only, and only the leads assigned to them now.
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if jsonb_typeof(q)<>'object' then raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(q) e
   where e.key not in ('view','import','search','status','temperature','source','call','outcome','assignment','sort','page')
    or jsonb_typeof(e.value) not in ('string','number')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_view=coalesce(q->>'view','assigned');v_search=nullif(btrim(coalesce(q->>'search','')),'');
 v_status=q->>'status';v_temperature=q->>'temperature';v_source=q->>'source';v_call=q->>'call';v_outcome=q->>'outcome';
 v_assignment=q->>'assignment';
 v_sort=coalesce(q->>'sort',case when v_view='pipeline' then 'contact' when v_call is not null then 'call_due'
  when q ? 'import' then 'file' else 'activity' end);
 begin
  v_page=coalesce((q->>'page')::integer,1);
  if q ? 'import' and q->>'import' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   v_import=(q->>'import')::uuid;end if;
 exception when others then raise exception 'Choose valid lead filters' using errcode='22023';
 end;
 -- Each view keeps to its own filters and sorts.
 if v_view not in ('assigned','pipeline') or v_page not between 1 and 100000 or length(coalesce(v_search,''))>100
  or (q ? 'import' and v_import is null)
  or (v_status is not null and v_status not in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'))
  or (v_temperature is not null and v_temperature not in ('hot','warm','cold','none'))
  or (v_source is not null and v_source not in ('manual','CSV','Meta','WhatsApp','other'))
  or (v_call is not null and v_call not in ('uncalled','missed'))
  or (v_assignment is not null and v_assignment<>'reassigned')
  or (v_outcome is not null and v_outcome not in ('No answer','Busy','Wrong number','Number off','Interested',
   'Not interested','Follow-up required','Site visit scheduled','Deal discussion'))
  or (v_view='pipeline' and (q ? 'import' or v_source is not null or v_call is not null
   or v_sort not in ('contact','followup','activity','temperature')))
  or (v_view='assigned' and (v_status is not null or v_temperature is not null
   or v_sort not in ('file','activity','added','call_due'))) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if v_search is not null then
  v_digits=regexp_replace(v_search,'[^0-9]','','g');
  if v_search ~ '^[0-9 ()+.-]+$' and length(v_digits) between 4 and 15 then
   -- Contact numbers are stored as +92…. The digits match as typed (the
   -- last digits of a number, say), or written as stored when they start
   -- like a number: 0092… and 03… become 92…, and a ten-digit mobile number
   -- without its 0 gets 92 in front.
   v_phone=case when v_digits like '00%' and length(v_digits)>=12 then substr(v_digits,3)
    when v_digits like '03%' then '92'||substr(v_digits,2)
    when v_digits ~ '^3[0-9]{9}$' then '92'||v_digits else v_digits end;
  else
   v_digits=null;v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  end if;
 end if;
 with mine as (
  select l.*,r.file_row,i.file_name,i.created_at file_added,
   (w.ws->>'since')::timestamptz ws_since,w.ws->>'status' ws_status,w.ws->>'previous_result' previous_result,
   (w.ws->>'first_call_reopened')::boolean first_call_reopened,
   lc.started_at contact_at,lc.outcome contact_outcome,
   la.started_at last_call_at,la.outcome last_call_outcome,la.status='completed' last_call_connected,
   case tp.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end temperature,
   tp.started_at temperature_at,
   (select min(f.due_at) from public.followups f where f.lead_id=l.id and f.status='pending') next_followup_at
  from public.leads l
  cross join lateral (select public.lead_workspace(l.id) ws) w
  left join crm_private.lead_file_rows r on r.lead_id=l.id and r.import_id=l.import_id
  left join public.lead_imports i on i.id=l.import_id
  -- The latest answered call: what puts a lead in the pipeline.
  left join lateral (select c.started_at,c.outcome from public.calls c where c.lead_id=l.id and c.status='completed'
   and c.created_at>=coalesce((w.ws->>'since')::timestamptz,'-infinity')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  -- The latest call of any kind, and its outcome.
  left join lateral (select c.started_at,c.outcome,c.status from public.calls c where c.lead_id=l.id
   and c.created_at>=coalesce((w.ws->>'since')::timestamptz,'-infinity')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) la on true
  -- The latest temperature saved with a call, chosen as in update 050.
  left join lateral (select t.tag,c.started_at from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')
    and c.created_at>=coalesce((w.ws->>'since')::timestamptz,'-infinity')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) tp on true
  where l.assigned_agent=p_actor and l.deleted_at is null and (v_import is null or l.import_id=v_import)
 ), matched as (
  select m.* from mine m
  where (v_view='assigned' or m.contact_at is not null)
   and (v_search is null
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=m.id
     and (p.phone like '%'||v_digits||'%' or p.phone like '%'||v_phone||'%')))
    or (v_like is not null and m.name ilike v_like))
   and (v_status is null or m.ws_status=v_status)
   and (v_source is null or m.source=v_source)
   and (v_outcome is null or m.last_call_outcome=v_outcome)
   and (v_assignment is null or m.ws_since is not null)
   and (v_call is null or (m.first_call_at is null and m.call_due_at is not null
    and (m.status not in ('won','lost') or m.first_call_reopened)
    and case when v_call='missed' then m.call_due_at<now() else m.call_due_at>=now() end))
 ), hits as (
  select m.* from matched m where v_temperature is null or coalesce(m.temperature,'none')=v_temperature
 ), ordered as (
  select h.*,row_number() over(order by
    case when v_sort='file' then h.file_added end desc nulls last,
    case when v_sort='file' then h.file_row end,
    case when v_sort='activity' then h.last_activity_at end desc nulls last,
    case when v_sort='added' then h.created_at end desc nulls last,
    case when v_sort='call_due' then h.call_due_at end nulls last,
    case when v_sort='followup' then h.next_followup_at end nulls last,
    case when v_sort='temperature' then case h.temperature when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 else 4 end end,
    case when v_sort in ('contact','followup','temperature') then h.contact_at end desc nulls last,
    h.lead_no desc) rn
  from hits h
 )
 select jsonb_build_object('view',v_view,'sort',v_sort,'page',v_page,'limit',v_limit,
  'count',(select count(*) from hits),
  -- Pipeline leads by temperature, for the current search and outcome.
  'temperatures',case when v_view='pipeline' then (select jsonb_build_object(
    'hot',count(*) filter (where temperature='hot'),'warm',count(*) filter (where temperature='warm'),
    'cold',count(*) filter (where temperature='cold'),'none',count(*) filter (where temperature is null)) from matched) end,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'lead_no',o.lead_no,'name',o.name,'email',o.email,
     'masked_phone',o.masked_phone,'assigned_agent',o.assigned_agent,'status',o.ws_status,'source',o.source,
     'preferred_location',o.preferred_location,'budget_min',o.budget_min,'budget_max',o.budget_max,
     'lost_reason',case when not o.first_call_reopened then o.lost_reason end,
     'created_at',o.created_at,'last_activity_at',o.last_activity_at,
     'assigned_at',o.assigned_at,'call_due_at',o.call_due_at,'first_call_at',o.first_call_at,'missed_at',o.missed_at,
     'import_id',o.import_id,'file_row',o.file_row,'file_name',o.file_name,
     'reassigned',o.ws_since is not null,'reassigned_at',o.ws_since,'previous_result',o.previous_result,
     'first_call_reopened',o.first_call_reopened,
     'contact',case when o.contact_at is not null then 'contacted' when o.last_call_at is not null then 'attempted' else 'none' end,
     'last_contact_at',o.contact_at,'last_contact_outcome',o.contact_outcome,
     'last_call_at',o.last_call_at,'last_call_outcome',o.last_call_outcome,'last_call_connected',o.last_call_connected,
     'temperature',o.temperature,'temperature_at',o.temperature_at,'next_followup_at',o.next_followup_at)
     -- The agent's own latest note on the lead in this assignment: a lead
     -- note or a call's notes, whichever was written last, by this agent
     -- according to the audit log. Worked out for this page only.
     ||coalesce((select jsonb_build_object('note',x.body,'note_at',x.at) from (
       select n.body,n.created_at at from public.notes n where n.lead_id=o.id and btrim(n.body)<>''
        and n.created_at>=coalesce(o.ws_since,'-infinity')
        and exists(select 1 from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text
         and a.action='create' and a.actor_id=p_actor)
       union all
       select c.notes,c.created_at from public.calls c where c.lead_id=o.id and btrim(coalesce(c.notes,''))<>''
        and c.created_at>=coalesce(o.ws_since,'-infinity')
        and exists(select 1 from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
         and a.action in ('create','call.manual_logged') and a.actor_id=p_actor)
      ) x order by x.at desc limit 1),jsonb_build_object('note',null,'note_at',null))
     order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- An agent's own Lead pipeline counts (update 055), for the current
-- assignment, so they match the list: My pipeline (the agent's leads with
-- an answered call) and Personally contacted (an answered call the agent
-- recorded themself); and, for the leads on the page, who recorded the
-- latest answered call when it was not the agent. Administrators' pipeline
-- pages (agent_pipeline_numbers) are unchanged.
create or replace function public.agent_pipeline_attribution(p_actor uuid,p_leads uuid[]) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if p_leads is null or cardinality(p_leads)>100 then raise exception 'Choose valid leads' using errcode='22023';end if;
 with mine as (
  select l.id,lc.id call_id,lc.recorder,
   exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed' and c.agent_id=p_actor
    and c.created_at>=coalesce(w.since,'-infinity')
    and (select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
     and a.action in ('create','call.manual_logged') order by a.id limit 1)=p_actor) own
  from public.leads l
  cross join lateral (select public.workspace_since(l.id) since) w
  left join lateral (select c.id,(select a.actor_id from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
     and a.action in ('create','call.manual_logged') order by a.id limit 1) recorder
   from public.calls c where c.lead_id=l.id and c.status='completed' and c.created_at>=coalesce(w.since,'-infinity')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  where l.assigned_agent=p_actor and l.deleted_at is null
 )
 select jsonb_build_object('pipeline',count(*) filter (where m.call_id is not null),
  'personally_contacted',count(*) filter (where m.own),
  'answered_by',coalesce(jsonb_object_agg(m.id::text,case when m.recorder is null then 'unknown' when r.role='admin' then 'admin' else 'agent' end)
   filter (where m.id=any(p_leads) and m.call_id is not null and m.recorder is distinct from p_actor),'{}'::jsonb))
 into result
 from mine m left join public.profiles r on r.id=m.recorder;
 return result;
end $$;

-- As in update 039; an agent's calendar holds the visits of their current
-- workspace, carried-over visits without earlier comments.
create or replace function public.visit_calendar(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;v_agent boolean;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 if p_to-p_from>interval '62 days' then raise exception 'Choose at most 62 days' using errcode='22023';end if;
 v_agent=exists(select 1 from public.profiles where id=p_actor and role='agent');
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lead_id',l.id,'lead_no',l.lead_no,'lead_name',l.name,'property_id',v.property_id,
   'property_title',p.title,'property_location',p.location,'agent_id',v.agent_id,'agent_name',a.name,'scheduled_at',v.scheduled_at,
   'status',v.status,'notes',case when s.state='carried' then null else v.notes end,'carried_over',s.state='carried')
   order by v.scheduled_at,v.id),'[]'::jsonb) into result
 from public.visits v join public.active_leads l on l.id=v.lead_id join public.properties p on p.id=v.property_id
  left join public.profiles a on a.id=v.agent_id
  cross join lateral (select case when v_agent then public.workspace_state(v) else 'current' end state) s
 where v.scheduled_at>=p_from and v.scheduled_at<p_to
  and (case when v_agent then l.assigned_agent=p_actor and s.state<>'hidden' else scope is null or v.agent_id=scope end);
 return result;
end $$;

-- ------------------------------------------------------- first calls
-- As in update 038, plus: on a lead that came from another agent, only the
-- agent's own call is their first call. An administrator's call on it is
-- kept and shown, but the agent's deadline, New and the previous result
-- stay until the agent calls. Who logs a call is set by crm_mutate and, from
-- 061, by log_manual_call (below).
create or replace function public.record_first_call() returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz;actor uuid=nullif(current_setting('hd.actor_id',true),'')::uuid;
begin
 if actor is distinct from new.agent_id and public.workspace_since(new.lead_id) is not null
  and exists(select 1 from public.profiles p where p.id=actor and p.role='admin') then return null;end if;
 update public.leads l set first_call_at=greatest(new.started_at,l.assigned_at)
  where l.id=new.lead_id and l.assigned_agent=new.agent_id and l.first_call_at is null and l.assigned_at is not null
  returning l.first_call_at into stamp;
 if stamp is not null then
  update public.assignments a set first_call_at=stamp
   where a.id=(select x.id from public.assignments x where x.lead_id=new.lead_id order by x.created_at desc,x.id desc limit 1)
    and a.agent_id=new.agent_id and a.first_call_at is null;
 end if;
 return null;
end $$;

-- As in update 038, with reassigned Lost leads, and the stage the agent
-- sees.
create or replace function public.first_call_queue(p_actor uuid,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023';end if;
 with queue as (
  select l.id,l.lead_no,l.name,public.lead_workspace(l.id)->>'status' status,l.assigned_agent,l.call_due_at,l.first_call_at,
   l.call_due_at<now() missed,public.workspace_since(l.id) is not null reassigned,public.lead_first_call_reopened(l.id) first_call_reopened
  from public.active_leads l
  where l.assigned_agent=p_actor and l.first_call_at is null and l.call_due_at is not null
   and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))
 ), page as (select * from queue order by call_due_at,lead_no limit p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by call_due_at,lead_no) from page),'[]'::jsonb),
  'waiting',(select count(*) from queue where not missed),'missed',(select count(*) from queue where missed)) into result;
 return result;
end $$;

-- As in update 038: missed first calls (now with reassigned Lost leads)
-- and, for open leads only, idle ones.
create or replace view public.lead_review_queue as
select l.id,l.assigned_agent,
 case when l.first_call_at is null and l.call_due_at<now() then 'missed' else 'idle' end as kind,
 case when l.first_call_at is null and l.call_due_at<now() then l.call_due_at else l.last_activity_at end as since
from public.active_leads l cross join public.crm_settings s
where s.id and l.assigned_agent is not null and (l.status not in ('won','lost') or public.lead_first_call_reopened(l.id)) and (
 (l.first_call_at is null and l.call_due_at<now())
 or (l.status not in ('won','lost') and l.last_activity_at<now()-make_interval(days=>s.idle_days)
  and (l.idle_kept_until is null or l.idle_kept_until<now())
  and not exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at>now())));

-- ------------------------------------------------------- reports
-- An agent's own drill-down row (update 051) on a lead reassigned to them:
-- the lead's status and lost reason stay (they are what the number counts),
-- but its calls, temperature, visit, deal, stage changes, lost note and a
-- carried-over follow-up's comments come from the current assignment only.
create or replace function public.report_drill_row_workspace(p_lead uuid,p_kind text,p_record uuid,p_at timestamptz,
 p_amount numeric,p_reason text,p_stage integer) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when w.since is null then r.drill else r.drill||jsonb_build_object(
  'lead',(r.drill->'lead')||case when public.lead_first_call_reopened(p_lead) then jsonb_build_object('lost_note',null) else '{}'::jsonb end,
  'last_call',(select public.report_call_json(c) from public.calls c where c.lead_id=p_lead and c.created_at>=w.since
   order by c.started_at desc,c.created_at desc,c.id desc limit 1),
  'calls',(select count(*) from public.calls c where c.lead_id=p_lead and c.created_at>=w.since),
  'temperature',(select t.tag from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=p_lead and c.created_at>=w.since and t.tag in ('Hot lead','Warm lead','Cold lead')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1),
  'latest_visit',(select jsonb_build_object('id',v.id,'scheduled_at',v.scheduled_at,'status',v.status,'property',pr.title)
   from public.visits v left join public.properties pr on pr.id=v.property_id
   where v.lead_id=p_lead and public.workspace_state(v)<>'hidden' order by v.scheduled_at desc,v.id desc limit 1),
  'deal',(select jsonb_build_object('id',d.id,'stage',d.stage,'expected_value',d.expected_value,'close_date',d.close_date)
   from public.deals d where d.lead_id=p_lead and public.workspace_state(d)<>'hidden' order by d.created_at desc limit 1),
  'lost_change',case when r.drill->>'lost_change' is not null then
   (select jsonb_build_object('at',h.created_at,'by',public.report_person(h.actor_id)) from public.lead_status_history h
    where h.lead_id=p_lead and h.to_status='lost' and h.created_at>=w.since order by h.created_at desc,h.id desc limit 1) end,
  'stage_change',case when p_stage>1 then (select jsonb_build_object('at',h.created_at,'to',h.to_status,'by',public.report_person(h.actor_id))
   from public.lead_status_history h where h.lead_id=p_lead and h.created_at>=w.since
    and array_position(array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'],h.to_status)>=p_stage
   order by h.created_at,h.id limit 1) end,
  'record',case when p_kind='followup' and (select public.workspace_state(f) from public.followups f where f.id=p_record)='carried'
   then (r.drill->'record')||jsonb_build_object('notes',null) else r.drill->'record' end) end
 from (select public.report_drill_row(p_lead,p_kind,p_record,p_at,p_amount,p_reason,p_stage) drill) r,
  (select public.workspace_since(p_lead) since) w
$$;

-- Small, checked edits to existing functions: each text must appear exactly
-- as many times as expected, or the update stops and changes nothing. On a
-- rerun the edited text is found and left as it is.
do $patch$
declare item record;body text;n integer;
 open_text constant text=$t$l.status not in ('won','lost')$t$;
 reopened_text constant text=$t$(l.status not in ('won','lost') or public.lead_first_call_reopened(l.id))$t$;
begin
 for item in select * from (values
  -- Missed first calls and the afternoon "calls due" reminder.
  ('public.lead_response_job()',open_text,reopened_text,2),
  -- The dashboard's uncalled and missed first calls.
  ('public.crm_metrics_038(uuid,timestamptz,timestamptz,uuid,text)',open_text,reopened_text,1),
  -- Today's calling: waiting for a first call.
  ('public.call_activity(uuid)',open_text,reopened_text,1),
  -- The records behind those numbers (updates 050 and 051).
  ('public.report_records(text,text,text,timestamptz,timestamptz,uuid,text)',open_text,reopened_text,1),
  ('public.report_today_records(text,uuid)',open_text,reopened_text,1),
  -- All leads' first-call filter, and a flag for its First call column.
  ('public.admin_lead_list(uuid,jsonb)',open_text,reopened_text,1),
  ('public.admin_lead_list(uuid,jsonb)',$t$'missed_at',s.missed_at,$t$,
   $t$'missed_at',s.missed_at,'first_call_reopened',public.lead_first_call_reopened(s.id),$t$,1),
  -- An agent's dashboard: pending follow-ups and scheduled visits, those
  -- carried over without earlier comments.
  ('public.dashboard_snapshot(uuid,timestamptz,timestamptz)',
   $t$(select f.*,l.lead_no,l.name as lead_name from public.followups f$t$,
   $t$(select f.*,l.lead_no,l.name as lead_name,case when actor.role<>'admin' then public.workspace_state(f) end workspace_state from public.followups f$t$,1),
  ('public.dashboard_snapshot(uuid,timestamptz,timestamptz)',$t$jsonb_agg(to_jsonb(f))$t$,
   $t$jsonb_agg(to_jsonb(f)||case when f.workspace_state='carried' then jsonb_build_object('notes',null,'carried_over',true) else '{}'::jsonb end)$t$,1),
  ('public.dashboard_snapshot(uuid,timestamptz,timestamptz)',
   $t$(select v.*,l.lead_no,l.name as lead_name from public.visits v$t$,
   $t$(select v.*,l.lead_no,l.name as lead_name,case when actor.role<>'admin' then public.workspace_state(v) end workspace_state from public.visits v$t$,1),
  ('public.dashboard_snapshot(uuid,timestamptz,timestamptz)',$t$jsonb_agg(to_jsonb(v))$t$,
   $t$jsonb_agg(to_jsonb(v)||case when v.workspace_state='carried' then jsonb_build_object('notes',null,'carried_over',true) else '{}'::jsonb end)$t$,1),
  -- The administrators' agent pipeline pages mirror the agent's own Lead
  -- pipeline (update 055): leads answered by someone else, and the
  -- temperature, for the current assignment. Who spoke to whom is as before.
  ('public.agent_pipeline_numbers(uuid)',
   $t$from public.calls c where c.lead_id=l.id and c.status='completed'$t$,
   $t$from public.calls c where c.lead_id=l.id and c.status='completed' and c.created_at>=coalesce(public.workspace_since(l.id),'-infinity')$t$,1),
  ('public.agent_pipeline_numbers(uuid)',
   $t$where c.lead_id=s.lead_id and t.tag in ('Hot lead','Warm lead','Cold lead')$t$,
   $t$where c.lead_id=s.lead_id and t.tag in ('Hot lead','Warm lead','Cold lead') and c.created_at>=coalesce(public.workspace_since(s.lead_id),'-infinity')$t$,1),
  ('public.admin_agent_pipeline(uuid,uuid,jsonb)',
   $t$where v_view='current' and c.lead_id=sp.id and t.tag in ('Hot lead','Warm lead','Cold lead')$t$,
   $t$where v_view='current' and c.lead_id=sp.id and t.tag in ('Hot lead','Warm lead','Cold lead') and c.created_at>=coalesce(public.workspace_since(sp.id),'-infinity')$t$,1),
  -- A manual call says who logs it before it is saved, so the first-call
  -- check above knows an administrator's call.
  ('public.log_manual_call(uuid,uuid,jsonb,text)',
   $t$  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,$t$,
   $t$  perform set_config('hd.actor_id',p_actor::text,true);
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,$t$,1),
  -- Agents' own drill-down rows.
  ('public.report_drilldown(uuid,jsonb)',
   $t$else public.report_drill_row(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,v_stage) end$t$,
   $t$when v_own then public.report_drill_row_workspace(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,v_stage)
     else public.report_drill_row(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,v_stage) end$t$,1)
 ) v(signature,old_text,new_text,expected) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>item.expected then
   raise exception 'Update 061 found an unexpected version of %: apply CRM updates up to 060 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- ------------------------------------------------------- access
-- Browsers reach none of this. The server's service role calls
-- agent_workspaces and reads workspace_state with records; the first-call
-- check is also read through the review queue view. The rest are helpers.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('workspace_since','workspace_item','workspace_state','lead_first_call_reopened','lead_workspace','agent_workspaces',
   'report_drill_row_workspace') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('agent_workspaces','workspace_state','lead_first_call_reopened') then
   execute format('grant execute on function %s to service_role',f.signature);
  else execute format('revoke all on function %s from service_role',f.signature);end if;
 end loop;
end $$;
revoke all on function public.agent_lead_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.agent_lead_list(uuid,jsonb) to service_role;
revoke all on function public.agent_pipeline_attribution(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.agent_pipeline_attribution(uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
