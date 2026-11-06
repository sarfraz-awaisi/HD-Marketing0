-- Update 051: everyone can open the work behind their numbers. Apply after
-- 050. Safe to rerun.
--
-- * Agents open their own report and dashboard numbers. The database sets
--   the agent to the signed-in agent, as every report already does for
--   agents, so an agent never sees anyone else's numbers or records.
-- * The dashboard's "Today's calling" numbers (call_activity, update 038)
--   open too: administrators any agent's, agents their own.
-- * An agent's own work on a lead that is now someone else's (a call made
--   before the lead was reassigned, for example) still counts, as in the
--   reports, but shows only the lead number and that record: never the
--   lead's name, contact number, status or later activity.
--
-- No table, no data and no report calculation changes. Two new helpers and a
-- new version of report_drilldown; re-running 050 restores the previous one.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.report_drilldown(uuid,jsonb)') is null
  or to_regprocedure('public.report_records(text,text,text,timestamptz,timestamptz,uuid,text)') is null
  or to_regprocedure('public.call_activity(uuid)') is null or to_regclass('public.lead_review_queue') is null then
  raise exception 'Apply CRM updates up to 050 before update 051.';
 end if;
end $$;

-- The records behind one agent's "Today's calling" number, with
-- call_activity's own conditions. Today is the Pakistan day.
create or replace function public.report_today_records(p_metric text,p_agent uuid)
returns table(o_lead uuid,o_kind text,o_record uuid,o_at timestamptz,o_amount numeric,o_reason text)
language plpgsql stable security definer set search_path='' as $$
declare v_start timestamptz=(now() at time zone 'Asia/Karachi')::date::timestamp at time zone 'Asia/Karachi';
begin
 if p_metric in ('calls_today','connected_today') then
  return query select c.lead_id,'call'::text,c.id,c.started_at,c.duration_seconds::numeric,null::text
   from public.calls c join public.active_leads l on l.id=c.lead_id
   where c.agent_id=p_agent and c.started_at>=v_start and (p_metric='calls_today' or c.status='completed');
 elsif p_metric='first_calls_today' then
  return query select l.id,'lead'::text,null::uuid,l.first_call_at,null::numeric,null::text from public.active_leads l
   where l.assigned_agent=p_agent and l.first_call_at>=v_start;
 elsif p_metric='waiting' then
  return query select l.id,'lead'::text,null::uuid,l.call_due_at,null::numeric,null::text from public.active_leads l
   where l.assigned_agent=p_agent and l.first_call_at is null and l.call_due_at>=now() and l.status not in ('won','lost');
 elsif p_metric in ('missed','idle') then
  return query select q.id,'lead'::text,null::uuid,q.since,null::numeric,null::text from public.lead_review_queue q
   where q.assigned_agent=p_agent and q.kind=p_metric;
 elsif p_metric='followups_overdue' then
  return query select f.lead_id,'followup'::text,f.id,f.due_at,null::numeric,null::text
   from public.followups f join public.active_leads l on l.id=f.lead_id
   where l.assigned_agent=p_agent and f.status='pending' and f.due_at<now();
 end if;
end $$;
-- The number call_activity shows for the same agent. It locks the actor's
-- profile, so this is not stable either.
create or replace function public.report_today_value(p_actor uuid,p_metric text,p_agent uuid)
returns numeric language sql volatile security definer set search_path='' as $$
 select (e->>p_metric)::numeric from jsonb_array_elements(public.call_activity(p_actor)->'agents') e
 where e->>'agent_id'=p_agent::text
$$;

-- --------------------------------------------------------------- the API
-- As in 050, plus: agents (their own numbers only, without the agent and
-- assigned-agent filters) and the "today" report (key: the agent).
create or replace function public.report_drilldown(p_actor uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_report text=q->>'report';v_metric text=q->>'metric';v_key text=q->>'key';
 v_kind text;v_measure text;v_keyed boolean;v_from timestamptz;v_to timestamptz;v_agent uuid;v_source text;v_who uuid;
 v_search text=nullif(btrim(coalesce(q->>'search','')),'');v_like text;v_number bigint;v_phone text;v_digits text;
 v_status text=q->>'status';v_owner text=q->>'owner';v_sort text=coalesce(q->>'sort','recent');
 v_page integer;v_limit integer;v_stage integer;v_role text;v_own boolean;
 v_stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'];
 v_uuid text='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';result jsonb;
begin
 -- Administrators see everyone's numbers, agents only their own; staff and
 -- anyone else are refused.
 select p.role into v_role from public.profiles p where p.id=p_actor and p.active for share;
 v_own=v_role is not distinct from 'agent';
 if not v_own then perform public.accounts_admin(p_actor);end if;
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
  ('lost','total','lead',false,'count'),('lost','reason','lead',true,'count'),('lost','source','lead',true,'count'),('lost','agent','lead',true,'count'),
  ('today','calls_today','call',true,'count'),('today','connected_today','call',true,'count'),('today','first_calls_today','lead',true,'count'),
  ('today','waiting','lead',true,'count'),('today','missed','lead',true,'count'),('today','idle','lead',true,'count'),
  ('today','followups_overdue','followup',true,'count')
 ) m(report,metric,kind,keyed,measure) where m.report=v_report and m.metric=v_metric;
 if v_kind is null or v_keyed<>(q ? 'key') or (q ? 'key' and jsonb_typeof(q->'key') not in ('string','null')) then
  raise exception 'Choose a report number to open' using errcode='22023';end if;
 -- Checked step by step: the agent id is cast only once its form is valid.
 if v_keyed and not coalesce(case
   when v_report='summary' then v_key=any(v_stages||'lost'::text)
   when v_report='funnel' then v_key=any(v_stages)
   when v_report in ('agents','today') then v_key ~ v_uuid
   when v_report='sources' or v_metric='source' then v_key is null or v_key in ('manual','CSV','Meta','WhatsApp','other')
   when v_metric='agent' then v_key is null or v_key ~ v_uuid
   else v_key is null or v_key ~ '^[a-z_]{1,40}$' end,false) then
  raise exception 'Choose a report number to open' using errcode='22023';end if;
 if v_report in ('agents','today') then
  v_who=v_key::uuid;
  -- An agent opens only their own row; "today" lists active agents only.
  if (v_own and v_who<>p_actor) or not exists(select 1 from public.profiles p where p.id=v_who and p.role='agent'
    and p.deleted_at is null and (v_report='agents' or p.active)) then
   raise exception 'Choose a report number to open' using errcode='22023';end if;
 end if;
 -- Only the filters the report itself uses. Agents' numbers are always
 -- their own, so they choose neither an agent nor an assigned agent.
 if (q ? 'agent' and v_report in ('agents','today')) or (q ? 'source' and v_report in ('sources','agents','today'))
  or (v_own and (q ? 'agent' or q ? 'owner'))
  or (q ? 'agent' and coalesce(q->>'agent','') !~ v_uuid)
  or (q ? 'source' and coalesce(q->>'source','') not in ('manual','CSV','Meta','WhatsApp','other')) then
  raise exception 'Choose filters this report uses' using errcode='22023';end if;
 begin
  v_from=(q->>'from')::timestamptz;v_to=(q->>'to')::timestamptz;
  v_page=coalesce((q->>'page')::integer,1);v_limit=coalesce((q->>'limit')::integer,25);
 exception when others then raise exception 'Choose a valid date range and page' using errcode='22023';
 end;
 v_agent=case when v_own then p_actor else (q->>'agent')::uuid end;v_source=q->>'source';
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
  select * from public.report_records(v_report,v_metric,v_key,v_from,v_to,v_agent,v_source) where v_report<>'today'
  union all
  select * from public.report_today_records(v_metric,v_who) where v_report='today'
 ), hits as (
  -- hidden: an agent's own record on a lead that is now someone else's.
  -- Such a lead is found only by its number, and its status is not shown.
  select r.*,l.lead_no,l.created_at lead_created,l.last_activity_at,
   v_own and l.assigned_agent is distinct from p_actor hidden
  from recs r join public.active_leads l on l.id=r.o_lead
  where (v_search is null or l.lead_no=v_number or ((not v_own or l.assigned_agent=p_actor) and (l.name ilike v_like
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=l.id and p.phone=v_phone)))))
   and (v_status is null or (l.status=v_status and (not v_own or l.assigned_agent=p_actor)))
   and (v_owner is null or (v_owner='none' and l.assigned_agent is null) or l.assigned_agent::text=lower(v_owner))
 ), ordered as (
  select h.*,row_number() over(order by
    case when v_sort='recent' then h.o_at end desc nulls last,
    case when v_sort='created' then case when not h.hidden then h.lead_created end end desc nulls last,
    case when v_sort='activity' then case when not h.hidden then h.last_activity_at end end desc nulls last,
    case when v_sort='call' then case when not h.hidden then
     (select max(c.started_at) from public.calls c where c.lead_id=h.o_lead) end end desc nulls last,
    h.lead_no desc,h.o_record) rn
  from hits h
 )
 select jsonb_build_object('report',v_report,'metric',v_metric,'key',v_key,'kind',v_kind,'measure',v_measure,
  'scope',case when v_own then 'own' else 'all' end,
  'count',(select count(*) from hits),'leads',(select count(distinct o_lead) from hits),'records',(select count(*) from recs),
  'value',(select case v_measure when 'sum' then coalesce(sum(o_amount),0) when 'avg' then round(avg(o_amount))
    when 'minutes' then round(coalesce(sum(o_amount),0)/60.0) else count(*) end from recs),
  'page',v_page,'limit',v_limit,
  'data',coalesce((select jsonb_agg(case when o.hidden
     then jsonb_build_object('id',coalesce(o.o_record,o.o_lead),'kind',o.o_kind,'at',o.o_at,'amount',o.o_amount,'hidden',true,
      'lead',jsonb_build_object('number',public.format_lead_no(o.lead_no)),
      'record',public.report_drill_row(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,null)->'record')
     else public.report_drill_row(o.o_lead,o.o_kind,o.o_record,o.o_at,o.o_amount,o.o_reason,v_stage) end order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 -- Page 1 also carries the original number, worked out now.
 if v_page=1 then
  result=result||jsonb_build_object('report_value',case when v_report='today'
   then public.report_today_value(p_actor,v_metric,v_who)
   else public.report_metric_value(p_actor,v_report,v_metric,v_key,v_from,v_to,v_agent,v_source) end);
 end if;
 return result;
end $$;

-- As in 050: the server's service role calls only report_drilldown.
do $$ declare f record;begin
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
  ('report_today_records','report_today_value','report_drilldown') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname='report_drilldown' then execute format('grant execute on function %s to service_role',f.signature);
  else execute format('revoke all on function %s from service_role',f.signature);end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
