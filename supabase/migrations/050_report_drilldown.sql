-- Update 050: report drill-down. Apply after 048 (it does not need 049).
-- Safe to rerun. Administrators can open any report number and see the
-- records behind it.
--
-- No table is added and no existing function changes: each report keeps its
-- own calculation. report_records lists the records one report number
-- counted, repeating that report's conditions branch by branch (each branch
-- names the report it follows). report_drilldown checks the request, narrows,
-- sorts and pages those records, and adds the lead's details. On page 1 it
-- also runs the original report, so a number and its records can never
-- silently disagree; tests compare every branch with its report.
--
-- Who did what comes only from recorded facts:
-- * Calls: calls.agent_id is the lead's agent even when an administrator
--   logged the call, so the caller is the audit log's actor for the call
--   ("create" or "call.manual_logged"). Without such an entry the caller is
--   unknown, never guessed.
-- * Visits, deals and follow-ups: added by the audit log's actor.
-- * Assignments and stage changes: their own actor_id columns.
-- One partial audit_log index makes those lookups direct.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regclass('public.shift_schedules') is null or to_regclass('crm_private.lead_phones') is null
  or to_regprocedure('public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text)') is null
  or to_regprocedure('public.report_sources(uuid,timestamptz,timestamptz,uuid)') is null
  or to_regprocedure('public.report_agents(uuid,timestamptz,timestamptz)') is null
  or to_regprocedure('public.report_funnel(uuid,timestamptz,timestamptz,uuid,text)') is null
  or to_regprocedure('public.report_lost(uuid,timestamptz,timestamptz,uuid,text)') is null then
  raise exception 'Apply CRM updates up to 048 before update 050.';
 end if;
end $$;

create index if not exists audit_log_activity_records on public.audit_log(entity,entity_id,id)
 where entity in ('calls','visits','deals','followups');

-- -------------------------------------------------------------- helpers
create or replace function public.report_person(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'former',not p.active or p.deleted_at is not null)
 from public.profiles p where p.id=p_id
$$;
-- Who recorded a call, visit, deal or follow-up, from the audit log. Each
-- branch names its entity literally, so the partial index above applies.
create or replace function public.report_recorded_by(p_entity text,p_id uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid;
begin
 if p_entity='calls' then
  select a.actor_id into v_actor from public.audit_log a where a.entity='calls' and a.entity_id=p_id::text
   and a.action in ('create','call.manual_logged') order by a.id limit 1;
 elsif p_entity='visits' then
  select a.actor_id into v_actor from public.audit_log a where a.entity='visits' and a.entity_id=p_id::text and a.action='create' order by a.id limit 1;
 elsif p_entity='deals' then
  select a.actor_id into v_actor from public.audit_log a where a.entity='deals' and a.entity_id=p_id::text and a.action='create' order by a.id limit 1;
 elsif p_entity='followups' then
  select a.actor_id into v_actor from public.audit_log a where a.entity='followups' and a.entity_id=p_id::text and a.action='create' order by a.id limit 1;
 end if;
 return v_actor;
end $$;
create or replace function public.report_call_json(c public.calls) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',c.id,'started_at',c.started_at,'ended_at',c.ended_at,'status',c.status,'outcome',c.outcome,
  'method',c.method,'answered',c.answered,'duration_seconds',c.duration_seconds,'tags',to_jsonb(c.deal_tags),
  'recorded_agent',public.report_person(c.agent_id),'caller',public.report_person(public.report_recorded_by('calls',c.id)))
$$;

-- The records behind one report number. o_at is the time the report used,
-- o_amount what it added up (deal value, call seconds, working minutes),
-- o_reason a detail it grouped by (furthest stage, lost reason, on time).
create or replace function public.report_records(p_report text,p_metric text,p_key text,p_from timestamptz,p_to timestamptz,p_agent uuid,p_source text)
returns table(o_lead uuid,o_kind text,o_record uuid,o_at timestamptz,o_amount numeric,o_reason text)
language plpgsql stable security definer set search_path='' as $$
declare v_stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'];
 v_today timestamptz=date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';
 v_from_day date=(p_from at time zone 'Asia/Karachi')::date;v_to_day date=(p_to at time zone 'Asia/Karachi')::date;
 v_stage integer;v_who uuid;
begin
 if p_report='summary' then
  -- crm_metrics (updates 028, 037, 038 and 039). "Eligible" leads match the
  -- agent and source filters whenever they were created.
  if p_metric in ('total_leads','assigned_leads','leads','by_status') then
   return query select l.id,'lead'::text,null::uuid,l.created_at,null::numeric,null::text from public.active_leads l
    where (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
     and (p_metric in ('total_leads','assigned_leads') or (l.created_at>=p_from and l.created_at<p_to))
     and (p_metric<>'by_status' or l.status is not distinct from p_key);
  elsif p_metric in ('today_completed_calls','completed_calls') then
   return query select c.lead_id,'call'::text,c.id,c.ended_at,c.duration_seconds::numeric,null::text
    from public.calls c join public.active_leads l on l.id=c.lead_id
    where (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
     and (p_agent is null or c.agent_id=p_agent) and c.status='completed'
     and case when p_metric='completed_calls' then c.ended_at>=p_from and c.ended_at<p_to
      else (c.ended_at at time zone 'Asia/Karachi')::date=(now() at time zone 'Asia/Karachi')::date end;
  elsif p_metric in ('completed_visits','scheduled_visits') then
   return query select v.lead_id,'visit'::text,v.id,v.scheduled_at,null::numeric,null::text
    from public.visits v join public.active_leads l on l.id=v.lead_id
    where (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
     and case when p_metric='completed_visits'
      then (p_agent is null or v.agent_id=p_agent) and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to
      else v.status='scheduled' and v.scheduled_at>=now() end;
  elsif p_metric in ('won_deals','revenue') then
   return query select d.lead_id,'deal'::text,d.id,d.close_date::timestamp at time zone 'Asia/Karachi',d.expected_value,null::text
    from public.deals d join public.active_leads l on l.id=d.lead_id
    where (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
     and (p_agent is null or d.agent_id=p_agent) and d.stage='won' and d.close_date>=v_from_day and d.close_date<v_to_day;
  elsif p_metric in ('due_followups','overdue_followups') then
   return query select f.lead_id,'followup'::text,f.id,f.due_at,null::numeric,null::text
    from public.followups f join public.active_leads l on l.id=f.lead_id
    where (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source) and f.status='pending'
     and case when p_metric='due_followups' then f.due_at>=v_today and f.due_at<=now()+interval '1 day' else f.due_at<now() end;
  elsif p_metric in ('first_calls','on_time_first_calls','first_calls_with_deadline','avg_first_call_minutes') then
   return query select a.lead_id,'assignment'::text,a.id,a.first_call_at,public.working_minutes(a.created_at,a.first_call_at)::numeric,
     case when a.call_due_at is null then 'no_deadline' when a.first_call_at<=a.call_due_at then 'on_time' else 'late' end
    from public.assignments a join public.active_leads l on l.id=a.lead_id
    where a.agent_id is not null and a.first_call_at>=p_from and a.first_call_at<p_to
     and (p_agent is null or a.agent_id=p_agent) and (p_source is null or l.source=p_source)
     and (p_metric not in ('on_time_first_calls','first_calls_with_deadline') or a.call_due_at is not null)
     and (p_metric<>'on_time_first_calls' or a.first_call_at<=a.call_due_at);
  elsif p_metric='missed_in_period' then
   return query select a.lead_id,'assignment'::text,a.id,a.missed_at,null::numeric,null::text
    from public.assignments a join public.active_leads l on l.id=a.lead_id
    where a.missed_at>=p_from and a.missed_at<p_to and (p_agent is null or a.agent_id=p_agent) and (p_source is null or l.source=p_source);
  elsif p_metric in ('uncalled_leads','missed_first_calls') then
   return query select l.id,'lead'::text,null::uuid,l.call_due_at,null::numeric,null::text from public.active_leads l
    where l.assigned_agent is not null and l.first_call_at is null and l.call_due_at is not null and l.status not in ('won','lost')
     and (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
     and case when p_metric='uncalled_leads' then l.call_due_at>=now() else l.call_due_at<now() end;
  elsif p_metric='leads_contacted' then
   -- One row per lead; o_at is its latest call in the range, o_amount how
   -- many calls it had in the range.
   return query select l.id,'lead'::text,null::uuid,max(c.started_at),count(*)::numeric,null::text
    from public.calls c join public.active_leads l on l.id=c.lead_id
    where c.started_at>=p_from and c.started_at<p_to and (p_agent is null or c.agent_id=p_agent) and (p_source is null or l.source=p_source)
    group by l.id;
  elsif p_metric='followups_completed' then
   return query select f.lead_id,'followup'::text,f.id,f.completed_at,null::numeric,null::text
    from public.followups f join public.active_leads l on l.id=f.lead_id
    where f.status='completed' and f.completed_at>=p_from and f.completed_at<p_to
     and (p_agent is null or f.agent_id=p_agent) and (p_source is null or l.source=p_source);
  end if;
 elsif p_report='sources' then
  -- report_sources (039): leads from one source created in the range, and
  -- how far they have got, at any time.
  return query select l.id,'lead'::text,null::uuid,l.created_at,
    case when p_metric='revenue' then (select d.expected_value from public.deals d where d.lead_id=l.id and d.stage='won') end,null::text
   from public.active_leads l
   where l.created_at>=p_from and l.created_at<p_to and (p_agent is null or l.assigned_agent=p_agent) and l.source is not distinct from p_key
    and case p_metric when 'leads' then true
     when 'contacted' then exists(select 1 from public.calls c where c.lead_id=l.id)
     when 'visited' then exists(select 1 from public.visits v where v.lead_id=l.id and v.status='completed')
     when 'won' then l.status='won' when 'lost' then l.status='lost'
     when 'revenue' then exists(select 1 from public.deals d where d.lead_id=l.id and d.stage='won')
     else false end;
 elsif p_report='agents' then
  -- report_agents (039): one agent's records in the range, by agent_id.
  v_who=p_key::uuid;
  if p_metric in ('assigned','first_calls','on_time_first_calls','first_calls_with_deadline','avg_first_call_minutes','missed_first_calls') then
   return query select a.lead_id,'assignment'::text,a.id,
     case p_metric when 'assigned' then a.created_at when 'missed_first_calls' then a.missed_at else a.first_call_at end,
     case when p_metric in ('first_calls','on_time_first_calls','first_calls_with_deadline','avg_first_call_minutes')
      then public.working_minutes(a.created_at,a.first_call_at)::numeric end,
     case when a.first_call_at is null then null when a.call_due_at is null then 'no_deadline'
      when a.first_call_at<=a.call_due_at then 'on_time' else 'late' end
    from public.assignments a join public.active_leads l on l.id=a.lead_id
    where a.agent_id=v_who and case p_metric
     when 'assigned' then a.created_at>=p_from and a.created_at<p_to
     when 'missed_first_calls' then a.missed_at>=p_from and a.missed_at<p_to
     when 'first_calls_with_deadline' then a.first_call_at>=p_from and a.first_call_at<p_to and a.call_due_at is not null
     when 'on_time_first_calls' then a.first_call_at>=p_from and a.first_call_at<p_to and a.first_call_at<=a.call_due_at
     else a.first_call_at>=p_from and a.first_call_at<p_to end;
  elsif p_metric in ('calls','connected_calls','talk_minutes') then
   return query select c.lead_id,'call'::text,c.id,case when p_metric='calls' then c.started_at else c.ended_at end,
     c.duration_seconds::numeric,null::text
    from public.calls c join public.active_leads l on l.id=c.lead_id
    where c.agent_id=v_who and case when p_metric='calls' then c.started_at>=p_from and c.started_at<p_to
     else c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to end;
  elsif p_metric='visits_completed' then
   return query select v.lead_id,'visit'::text,v.id,v.scheduled_at,null::numeric,null::text
    from public.visits v join public.active_leads l on l.id=v.lead_id
    where v.agent_id=v_who and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to;
  elsif p_metric in ('won_deals','revenue') then
   return query select d.lead_id,'deal'::text,d.id,d.close_date::timestamp at time zone 'Asia/Karachi',d.expected_value,null::text
    from public.deals d join public.active_leads l on l.id=d.lead_id
    where d.agent_id=v_who and d.stage='won' and d.close_date>=v_from_day and d.close_date<v_to_day;
  elsif p_metric='lost' then
   return query select l.id,'lead'::text,null::uuid,l.lost_at,null::numeric,l.lost_reason from public.active_leads l
    where l.assigned_agent=v_who and l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to;
  end if;
 elsif p_report='funnel' then
  -- report_funnel (039): leads created in the range and the furthest stage
  -- each has reached (its current stage or any earlier one in its history).
  if p_metric='stage' then v_stage=array_position(v_stages,p_key);end if;
  return query with cohort as (
    select l.id,l.status,l.created_at,greatest(coalesce(array_position(v_stages,l.status),1),
     coalesce((select max(array_position(v_stages,h.to_status)) from public.lead_status_history h where h.lead_id=l.id),1)) reached
    from public.active_leads l
    where l.created_at>=p_from and l.created_at<p_to and (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source))
   select c.id,'lead'::text,null::uuid,c.created_at,null::numeric,v_stages[c.reached] from cohort c
   where case p_metric when 'total' then true when 'lost' then c.status='lost' when 'stage' then c.reached>=v_stage else false end;
 elsif p_report='lost' then
  -- report_lost (039): leads marked lost in the range, by reason, source and
  -- current agent.
  if p_metric='agent' and p_key is not null then v_who=p_key::uuid;end if;
  return query select l.id,'lead'::text,null::uuid,l.lost_at,null::numeric,l.lost_reason from public.active_leads l
   where l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to
    and (p_agent is null or l.assigned_agent=p_agent) and (p_source is null or l.source=p_source)
    and case p_metric when 'total' then true when 'reason' then l.lost_reason is not distinct from p_key
     when 'source' then l.source is not distinct from p_key when 'agent' then l.assigned_agent is not distinct from v_who else false end;
 end if;
end $$;

-- The number the original report shows for the same request.
create or replace function public.report_metric_value(p_actor uuid,p_report text,p_metric text,p_key text,p_from timestamptz,p_to timestamptz,p_agent uuid,p_source text)
returns numeric language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 if p_report='summary' then
  r=public.crm_metrics(p_actor,p_from,p_to,p_agent,p_source);
  return case when p_metric='by_status' then coalesce((r->'by_status'->>p_key)::numeric,0) else (r->>p_metric)::numeric end;
 elsif p_report='sources' then
  return coalesce((select (e->>p_metric)::numeric from jsonb_array_elements(public.report_sources(p_actor,p_from,p_to,p_agent)) e
   where e->>'source' is not distinct from p_key),0);
 elsif p_report='agents' then
  return (select (e->>p_metric)::numeric from jsonb_array_elements(public.report_agents(p_actor,p_from,p_to)) e where e->>'agent_id'=p_key);
 elsif p_report='funnel' then
  r=public.report_funnel(p_actor,p_from,p_to,p_agent,p_source);
  return case p_metric when 'total' then (r->>'total')::numeric when 'lost' then (r->>'lost')::numeric
   else (select (e->>'reached')::numeric from jsonb_array_elements(r->'stages') e where e->>'stage'=p_key) end;
 elsif p_report='lost' then
  r=public.report_lost(p_actor,p_from,p_to,p_agent,p_source);
  if p_metric='total' then return (r->>'total')::numeric;end if;
  return coalesce((select (e->>'count')::numeric
   from jsonb_array_elements(r->case p_metric when 'reason' then 'by_reason' when 'source' then 'by_source' else 'by_agent' end) e
   where e->>case p_metric when 'reason' then 'reason' when 'source' then 'source' else 'agent_id' end is not distinct from p_key),0);
 end if;
 return null;
end $$;

-- One drill-down row: the record, its lead, and what happened to the lead.
create or replace function public.report_drill_row(p_lead uuid,p_kind text,p_record uuid,p_at timestamptz,p_amount numeric,p_reason text,p_stage integer)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',coalesce(p_record,p_lead),'kind',p_kind,'at',p_at,'amount',p_amount,'reason',p_reason,
  'lead',jsonb_build_object('id',l.id,'number',public.format_lead_no(l.lead_no),'name',l.name,'masked_phone',l.masked_phone,
   'source',l.source,'status',l.status,'created_at',l.created_at,'last_activity_at',l.last_activity_at,
   'lost_reason',l.lost_reason,'lost_note',l.lost_note,'lost_at',l.lost_at,'assigned_agent',public.report_person(l.assigned_agent)),
  'last_call',(select public.report_call_json(c) from public.calls c where c.lead_id=l.id order by c.started_at desc,c.created_at desc,c.id desc limit 1),
  'calls',(select count(*) from public.calls c where c.lead_id=l.id),
  'temperature',(select t.tag from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead') order by c.started_at desc,c.created_at desc,c.id desc limit 1),
  'next_followup',(select jsonb_build_object('id',f.id,'due_at',f.due_at,'overdue',f.due_at<now())
   from public.followups f where f.lead_id=l.id and f.status='pending' order by f.due_at,f.id limit 1),
  'pending_followups',(select count(*) from public.followups f where f.lead_id=l.id and f.status='pending'),
  'latest_visit',(select jsonb_build_object('id',v.id,'scheduled_at',v.scheduled_at,'status',v.status,'property',pr.title)
   from public.visits v left join public.properties pr on pr.id=v.property_id where v.lead_id=l.id order by v.scheduled_at desc,v.id desc limit 1),
  'deal',(select jsonb_build_object('id',d.id,'stage',d.stage,'expected_value',d.expected_value,'close_date',d.close_date)
   from public.deals d where d.lead_id=l.id order by d.created_at desc limit 1),
  'lost_change',case when l.status='lost' then (select jsonb_build_object('at',h.created_at,'by',public.report_person(h.actor_id))
   from public.lead_status_history h where h.lead_id=l.id and h.to_status='lost' order by h.created_at desc,h.id desc limit 1) end,
  'stage_change',case when p_stage>1 then (select jsonb_build_object('at',h.created_at,'to',h.to_status,'by',public.report_person(h.actor_id))
   from public.lead_status_history h where h.lead_id=l.id
    and array_position(array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'],h.to_status)>=p_stage
   order by h.created_at,h.id limit 1) end,
  'record',case p_kind
   when 'call' then (select public.report_call_json(c) from public.calls c where c.id=p_record)
   when 'visit' then (select jsonb_build_object('id',v.id,'scheduled_at',v.scheduled_at,'status',v.status,'property',pr.title,
     'agent',public.report_person(v.agent_id),'added_by',public.report_person(public.report_recorded_by('visits',v.id)))
    from public.visits v left join public.properties pr on pr.id=v.property_id where v.id=p_record)
   when 'deal' then (select jsonb_build_object('id',d.id,'stage',d.stage,'expected_value',d.expected_value,'close_date',d.close_date,
     'property',pr.title,'agent',public.report_person(d.agent_id),'added_by',public.report_person(public.report_recorded_by('deals',d.id)))
    from public.deals d left join public.properties pr on pr.id=d.property_id where d.id=p_record)
   when 'followup' then (select jsonb_build_object('id',f.id,'due_at',f.due_at,'status',f.status,'completed_at',f.completed_at,
     'notes',left(f.notes,300),'agent',public.report_person(f.agent_id),'added_by',public.report_person(public.report_recorded_by('followups',f.id)))
    from public.followups f where f.id=p_record)
   when 'assignment' then (select jsonb_build_object('id',a.id,'assigned_at',a.created_at,'agent',public.report_person(a.agent_id),
     'assigned_by',public.report_person(a.actor_id),'call_due_at',a.call_due_at,'first_call_at',a.first_call_at,'missed_at',a.missed_at,'reason',a.reason)
    from public.assignments a where a.id=p_record)
  end)
 from public.leads l where l.id=p_lead
$$;

-- --------------------------------------------------------------- the API
-- p_query: report, metric and key (which number); from, to, agent and source
-- (the report's own filters, only those that report uses); search (lead
-- number, name or full contact number), status (current), owner (assigned
-- agent id or "none"), sort (recent|created|activity|call), page, limit.
create or replace function public.report_drilldown(p_actor uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_report text=q->>'report';v_metric text=q->>'metric';v_key text=q->>'key';
 v_kind text;v_measure text;v_keyed boolean;v_from timestamptz;v_to timestamptz;v_agent uuid;v_source text;
 v_search text=nullif(btrim(coalesce(q->>'search','')),'');v_like text;v_number bigint;v_phone text;v_digits text;
 v_status text=q->>'status';v_owner text=q->>'owner';v_sort text=coalesce(q->>'sort','recent');
 v_page integer;v_limit integer;v_stage integer;
 v_stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'];
 v_uuid text='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';result jsonb;
begin
 perform public.accounts_admin(p_actor);
 -- What each number is: the record it counts, whether it needs a key (a
 -- source, agent, stage, status or lost reason) and how it adds up.
 select m.kind,m.keyed,m.measure into v_kind,v_keyed,v_measure from (values
  ('summary','total_leads','lead',false,'count'),('summary','assigned_leads','lead',false,'count'),('summary','leads','lead',false,'count'),
  ('summary','by_status','lead',true,'count'),('summary','today_completed_calls','call',false,'count'),('summary','completed_calls','call',false,'count'),
  ('summary','completed_visits','visit',false,'count'),('summary','scheduled_visits','visit',false,'count'),('summary','won_deals','deal',false,'count'),
  ('summary','revenue','deal',false,'sum'),('summary','due_followups','followup',false,'count'),('summary','overdue_followups','followup',false,'count'),
  ('summary','first_calls','assignment',false,'count'),('summary','on_time_first_calls','assignment',false,'count'),
  ('summary','first_calls_with_deadline','assignment',false,'count'),('summary','avg_first_call_minutes','assignment',false,'avg'),
  ('summary','missed_in_period','assignment',false,'count'),('summary','uncalled_leads','lead',false,'count'),
  ('summary','missed_first_calls','lead',false,'count'),('summary','leads_contacted','lead',false,'count'),
  ('summary','followups_completed','followup',false,'count'),
  ('sources','leads','lead',true,'count'),('sources','contacted','lead',true,'count'),('sources','visited','lead',true,'count'),
  ('sources','won','lead',true,'count'),('sources','lost','lead',true,'count'),('sources','revenue','lead',true,'sum'),
  ('agents','assigned','assignment',true,'count'),('agents','first_calls','assignment',true,'count'),
  ('agents','on_time_first_calls','assignment',true,'count'),('agents','first_calls_with_deadline','assignment',true,'count'),
  ('agents','avg_first_call_minutes','assignment',true,'avg'),('agents','missed_first_calls','assignment',true,'count'),
  ('agents','calls','call',true,'count'),('agents','connected_calls','call',true,'count'),('agents','talk_minutes','call',true,'minutes'),
  ('agents','visits_completed','visit',true,'count'),('agents','won_deals','deal',true,'count'),('agents','revenue','deal',true,'sum'),
  ('agents','lost','lead',true,'count'),
  ('funnel','total','lead',false,'count'),('funnel','stage','lead',true,'count'),('funnel','lost','lead',false,'count'),
  ('lost','total','lead',false,'count'),('lost','reason','lead',true,'count'),('lost','source','lead',true,'count'),('lost','agent','lead',true,'count')
 ) m(report,metric,kind,keyed,measure) where m.report=v_report and m.metric=v_metric;
 if v_kind is null or v_keyed<>(q ? 'key') or (q ? 'key' and jsonb_typeof(q->'key') not in ('string','null')) then
  raise exception 'Choose a report number to open' using errcode='22023';end if;
 -- Checked step by step: the agent id is cast only once its form is valid.
 if v_keyed and not coalesce(case
   when v_report='summary' then v_key=any(v_stages||'lost'::text)
   when v_report='funnel' then v_key=any(v_stages)
   when v_report='agents' then v_key ~ v_uuid
   when v_report='sources' or v_metric='source' then v_key is null or v_key in ('manual','CSV','Meta','WhatsApp','other')
   when v_metric='agent' then v_key is null or v_key ~ v_uuid
   else v_key is null or v_key ~ '^[a-z_]{1,40}$' end,false) then
  raise exception 'Choose a report number to open' using errcode='22023';end if;
 if v_report='agents' then
  if not exists(select 1 from public.profiles p where p.id=v_key::uuid and p.role='agent' and p.deleted_at is null) then
   raise exception 'Choose a report number to open' using errcode='22023';end if;
 end if;
 -- Only the filters the report itself uses.
 if (q ? 'agent' and v_report='agents') or (q ? 'source' and v_report in ('sources','agents'))
  or (q ? 'agent' and coalesce(q->>'agent','') !~ v_uuid)
  or (q ? 'source' and coalesce(q->>'source','') not in ('manual','CSV','Meta','WhatsApp','other')) then
  raise exception 'Choose filters this report uses' using errcode='22023';end if;
 begin
  v_from=(q->>'from')::timestamptz;v_to=(q->>'to')::timestamptz;
  v_page=coalesce((q->>'page')::integer,1);v_limit=coalesce((q->>'limit')::integer,25);
 exception when others then raise exception 'Choose a valid date range and page' using errcode='22023';
 end;
 v_agent=(q->>'agent')::uuid;v_source=q->>'source';
 perform public.report_scope(p_actor,v_agent,v_from,v_to);
 if v_page not between 1 and 100000 or v_limit not in (25,50) or length(coalesce(v_search,''))>100
  or (v_status is not null and v_status<>all(v_stages||'lost'::text))
  or (v_owner is not null and v_owner<>'none' and v_owner !~ v_uuid)
  or v_sort not in ('recent','created','activity','call') then
  raise exception 'Choose valid drill-down filters' using errcode='22023';end if;
 if v_report='funnel' and v_metric='stage' then v_stage=array_position(v_stages,v_key);end if;
 -- Search: a lead number (HD-000145 or 145), a full contact number, or part
 -- of a name.
 if v_search is not null then
  v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  if v_search ~* '^(HD-?)?[0-9]{1,12}$' then v_number=regexp_replace(v_search,'[^0-9]','','g')::bigint;end if;
  v_digits=regexp_replace(v_search,'[^0-9]','','g');
  if v_search ~ '^[0-9 ()+.-]+$' and length(v_digits) between 10 and 15 then
   if v_digits like '00%' then v_digits=substr(v_digits,3);end if;
   if v_digits like '0%' then v_digits='92'||substr(v_digits,2);end if;
   if v_digits ~ '^3[0-9]{9}$' then v_digits='92'||v_digits;end if;
   v_phone='+'||v_digits;
  end if;
 end if;
 with recs as (
  select * from public.report_records(v_report,v_metric,v_key,v_from,v_to,v_agent,v_source)
 ), hits as (
  select r.*,l.lead_no,l.created_at lead_created,l.last_activity_at from recs r join public.active_leads l on l.id=r.o_lead
  where (v_search is null or l.name ilike v_like or l.lead_no=v_number
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=l.id and p.phone=v_phone)))
   and (v_status is null or l.status=v_status)
   and (v_owner is null or (v_owner='none' and l.assigned_agent is null) or l.assigned_agent::text=lower(v_owner))
 ), ordered as (
  select h.*,row_number() over(order by
    case when v_sort='recent' then h.o_at end desc nulls last,
    case when v_sort='created' then h.lead_created end desc,
    case when v_sort='activity' then h.last_activity_at end desc nulls last,
    case when v_sort='call' then (select max(c.started_at) from public.calls c where c.lead_id=h.o_lead) end desc nulls last,
    h.lead_no desc,h.o_record) rn
  from hits h
 )
 select jsonb_build_object('report',v_report,'metric',v_metric,'key',v_key,'kind',v_kind,'measure',v_measure,
  'count',(select count(*) from hits),'leads',(select count(distinct o_lead) from hits),'records',(select count(*) from recs),
  'value',(select case v_measure when 'sum' then coalesce(sum(o_amount),0) when 'avg' then round(avg(o_amount))
    when 'minutes' then round(coalesce(sum(o_amount),0)/60.0) else count(*) end from recs),
  'page',v_page,'limit',v_limit,
  'data',coalesce((select jsonb_agg(public.report_drill_row(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,v_stage) order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 -- Page 1 also carries the original report's number, worked out now.
 if v_page=1 then
  result=result||jsonb_build_object('report_value',
   public.report_metric_value(p_actor,v_report,v_metric,v_key,v_from,v_to,v_agent,v_source));
 end if;
 return result;
end $$;

-- Browsers reach none of this; the server's service role calls only
-- report_drilldown. The helpers are for the database owner and tests.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row','report_drilldown') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname='report_drilldown' then execute format('grant execute on function %s to service_role',f.signature);
  else execute format('revoke all on function %s from service_role',f.signature);end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
