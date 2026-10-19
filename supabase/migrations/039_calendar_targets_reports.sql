-- Apply after 038. Safe to rerun. Site visit calendar (F8), daily/weekly/
-- monthly targets with contact and follow-up goals (F10) and source, agent,
-- funnel and lost-lead reports (F12).
begin;
do $$ begin
 if to_regclass('public.crm_settings') is null or to_regprocedure('public.first_call_queue(uuid,integer)') is null then
  raise exception 'Apply CRM update 038 before calendar, targets and reports update 039.';
 end if;
end $$;

-- Shared scope check: active user; agents only ever see their own work.
create or replace function public.report_scope(p_actor uuid,p_agent uuid,p_from timestamptz,p_to timestamptz) returns uuid language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '3700 days' then
  raise exception 'Invalid date range' using errcode='22023';end if;
 return case when actor.role='agent' then p_actor else p_agent end;
end $$;

-- F8: visits in a date range (at most 62 days) with names, never phone numbers.
create index if not exists visits_scheduled_at on public.visits(scheduled_at);
create or replace function public.visit_calendar(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 if p_to-p_from>interval '62 days' then raise exception 'Choose at most 62 days' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lead_id',l.id,'lead_no',l.lead_no,'lead_name',l.name,'property_id',v.property_id,
   'property_title',p.title,'property_location',p.location,'agent_id',v.agent_id,'agent_name',a.name,'scheduled_at',v.scheduled_at,
   'status',v.status,'notes',v.notes) order by v.scheduled_at,v.id),'[]'::jsonb) into result
 from public.visits v join public.active_leads l on l.id=v.lead_id join public.properties p on p.id=v.property_id
  left join public.profiles a on a.id=v.agent_id
 where v.scheduled_at>=p_from and v.scheduled_at<p_to
  and (case when exists(select 1 from public.profiles where id=p_actor and role='agent') then l.assigned_agent=p_actor else scope is null or v.agent_id=scope end);
 return result;
end $$;
-- Other scheduled visits of the same agent within 60 minutes of a time.
create or replace function public.visit_conflicts(p_actor uuid,p_lead uuid,p_at timestamptz,p_exclude uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;owner uuid;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if p_at is null then raise exception 'Choose a visit time' using errcode='22023';end if;
 select coalesce(l.assigned_agent,p_actor) into owner from public.active_leads l
  where l.id=p_lead and (actor.role='admin' or l.assigned_agent=p_actor);
 if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'lead_no',l.lead_no,'lead_name',l.name,'property_title',p.title,'scheduled_at',v.scheduled_at,
   'agent_name',a.name) order by v.scheduled_at),'[]'::jsonb) into result
 from public.visits v join public.active_leads l on l.id=v.lead_id join public.properties p on p.id=v.property_id left join public.profiles a on a.id=v.agent_id
 where v.agent_id=owner and v.status='scheduled' and v.id is distinct from p_exclude
  and v.scheduled_at>p_at-interval '60 minutes' and v.scheduled_at<p_at+interval '60 minutes';
 return jsonb_build_object('agent_id',owner,'conflicts',result);
end $$;

-- F10: targets per day, week (starting Monday) or month. The legacy month
-- column stays as the month containing the period, for older readers.
alter table public.targets
 add column if not exists period text not null default 'month' check(period in ('day','week','month')),
 add column if not exists period_start date,
 add column if not exists leads_contacted integer not null default 0 check(leads_contacted>=0),
 add column if not exists followups_completed integer not null default 0 check(followups_completed>=0),
 add column if not exists updated_at timestamptz not null default now();
update public.targets set period_start=month where period_start is null;
alter table public.targets alter column period_start set not null;
alter table public.targets drop constraint if exists targets_agent_id_month_key;
alter table public.targets drop constraint if exists targets_period_start_check;
alter table public.targets add constraint targets_period_start_check
 check((period<>'month' or extract(day from period_start)=1) and (period<>'week' or extract(isodow from period_start)=1));
create unique index if not exists targets_agent_period on public.targets(agent_id,period,period_start);
create index if not exists targets_period_start on public.targets(period,period_start);
create or replace function public.prepare_target() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.period=coalesce(new.period,'month');
 -- Older writers change only the month column of a monthly target.
 if tg_op='UPDATE' and new.month is distinct from old.month and new.period_start is not distinct from old.period_start and new.period='month' then
  new.period_start=new.month;
 end if;
 new.period_start=coalesce(new.period_start,new.month);
 new.month=date_trunc('month',new.period_start)::date;
 new.updated_at=now();
 return new;
end $$;
drop trigger if exists prepare_target on public.targets;
create trigger prepare_target before insert or update on public.targets for each row execute function public.prepare_target();
-- Follow-ups record when they were completed, for the follow-up goal.
alter table public.followups add column if not exists completed_at timestamptz;
update public.followups set completed_at=updated_at where status='completed' and completed_at is null;
create index if not exists followups_completed on public.followups(agent_id,completed_at) where status='completed';
create or replace function public.stamp_followup_completion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='completed' then new.completed_at=case when tg_op='UPDATE' and old.status='completed' then old.completed_at else now() end;
 else new.completed_at=null;end if;
 return new;
end $$;
drop trigger if exists stamp_followup_completion on public.followups;
create trigger stamp_followup_completion before insert or update of status on public.followups for each row execute function public.stamp_followup_completion();
create or replace function public.target_period_end(p_period text,p_start date) returns date language sql immutable set search_path='' as $$
 select case p_period when 'day' then p_start+1 when 'week' then p_start+7 else (p_start+interval '1 month')::date end
$$;
create or replace function public.targets_page(p_actor uuid,p_period text,p_start date,p_current boolean,p_page integer,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;today date=(now() at time zone 'Asia/Karachi')::date;result jsonb;
begin
 select * into actor from public.profiles where id=p_actor and active;
 if actor.id is null then raise exception 'Forbidden' using errcode='42501';end if;
 if (p_period is not null and p_period not in ('day','week','month')) or p_page not between 1 and 100000 or p_limit not between 1 and 100 then
  raise exception 'Invalid target filter' using errcode='22023';end if;
 with visible as (
  select t.*,a.name agent_name,a.uid agent_uid,public.target_period_end(t.period,t.period_start) period_end
  from public.targets t join public.profiles a on a.id=t.agent_id
  where (actor.role='admin' or t.agent_id=p_actor) and a.deleted_at is null
   and (p_period is null or t.period=p_period) and (p_start is null or t.period_start=p_start)
   and (not coalesce(p_current,false) or (t.period_start<=today and public.target_period_end(t.period,t.period_start)>today))
 ), page as (select * from visible order by period_start desc,case period when 'day' then 1 when 'week' then 2 else 3 end,agent_name,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(page) order by period_start desc,case period when 'day' then 1 when 'week' then 2 else 3 end,agent_name,id) from page),'[]'::jsonb),
  'count',(select count(*) from visible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;
create or replace function public.save_target(p_actor uuid,p_id uuid,p_data jsonb,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text;result public.targets;existing public.targets;
begin
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid target' using errcode='22023';end if;
 for k in select jsonb_object_keys(p_data) loop
  if k not in ('agent_id','period','period_start','calls','visits','deals','revenue','leads_contacted','followups_completed') then
   raise exception 'Invalid target field' using errcode='22023';end if;
 end loop;
 if p_data ? 'agent_id' and not exists(select 1 from public.profiles where id=(p_data->>'agent_id')::uuid and active and role='agent') then
  raise exception 'Choose an active agent' using errcode='22023';end if;
 if p_id is null then
  insert into public.targets(agent_id,period,period_start,month,calls,visits,deals,revenue,leads_contacted,followups_completed)
  values((p_data->>'agent_id')::uuid,coalesce(p_data->>'period','month'),(p_data->>'period_start')::date,(p_data->>'period_start')::date,
   coalesce((p_data->>'calls')::integer,0),coalesce((p_data->>'visits')::integer,0),coalesce((p_data->>'deals')::integer,0),
   coalesce((p_data->>'revenue')::numeric,0),coalesce((p_data->>'leads_contacted')::integer,0),coalesce((p_data->>'followups_completed')::integer,0))
  returning * into result;
 else
  select * into existing from public.targets where id=p_id for update;
  if not found then raise exception 'Target not found' using errcode='P0002';end if;
  update public.targets set agent_id=coalesce((p_data->>'agent_id')::uuid,agent_id),period=coalesce(p_data->>'period',period),
   period_start=coalesce((p_data->>'period_start')::date,period_start),calls=coalesce((p_data->>'calls')::integer,calls),
   visits=coalesce((p_data->>'visits')::integer,visits),deals=coalesce((p_data->>'deals')::integer,deals),revenue=coalesce((p_data->>'revenue')::numeric,revenue),
   leads_contacted=coalesce((p_data->>'leads_contacted')::integer,leads_contacted),followups_completed=coalesce((p_data->>'followups_completed')::integer,followups_completed)
  where id=p_id returning * into result;
 end if;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,case when p_id is null then 'create' else 'update' end,'targets',result.id::text,p_request,
   jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data))),'period',result.period));
 return to_jsonb(result);
end $$;
-- Copy each active agent's targets from the previous period into this one.
create or replace function public.copy_targets(p_actor uuid,p_period text,p_start date,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare previous date;copied integer;available integer;
begin
 perform public.accounts_admin(p_actor);
 if p_period is null or p_period not in ('day','week','month') or p_start is null
  or (p_period='week' and extract(isodow from p_start)<>1) or (p_period='month' and extract(day from p_start)<>1) then
  raise exception 'Choose a valid period' using errcode='22023';end if;
 previous=case p_period when 'day' then p_start-1 when 'week' then p_start-7 else (p_start-interval '1 month')::date end;
 select count(*) into available from public.targets t join public.profiles a on a.id=t.agent_id and a.active and a.role='agent'
  where t.period=p_period and t.period_start=previous;
 insert into public.targets(agent_id,period,period_start,month,calls,visits,deals,revenue,leads_contacted,followups_completed)
 select t.agent_id,p_period,p_start,p_start,t.calls,t.visits,t.deals,t.revenue,t.leads_contacted,t.followups_completed
 from public.targets t join public.profiles a on a.id=t.agent_id and a.active and a.role='agent'
 where t.period=p_period and t.period_start=previous
 on conflict(agent_id,period,period_start) do nothing;
 get diagnostics copied=row_count;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
  values(p_actor,'targets.copied','targets',p_request,jsonb_build_object('period',p_period,'from',previous,'to',p_start,'copied',copied));
 return jsonb_build_object('copied',copied,'skipped',available-copied,'from',previous);
end $$;

-- Metrics gain the two new goals for the same range and filters.
do $$ begin
 if to_regprocedure('public.crm_metrics_038(uuid,timestamptz,timestamptz,uuid,text)') is null then
  alter function public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text) rename to crm_metrics_038;
 end if;
end $$;
create or replace function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;scope uuid=p_agent;
begin
 result=public.crm_metrics_038(p_actor,p_from,p_to,p_agent,p_source);
 if exists(select 1 from public.profiles where id=p_actor and role='agent') then scope=p_actor;end if;
 return result||jsonb_build_object(
  'leads_contacted',(select count(distinct c.lead_id) from public.calls c join public.active_leads l on l.id=c.lead_id
   where c.started_at>=p_from and c.started_at<p_to and (scope is null or c.agent_id=scope) and (p_source is null or l.source=p_source)),
  'followups_completed',(select count(*) from public.followups f join public.active_leads l on l.id=f.lead_id
   where f.status='completed' and f.completed_at>=p_from and f.completed_at<p_to and (scope is null or f.agent_id=scope) and (p_source is null or l.source=p_source)));
end $$;

-- F12 reports. Agents only ever receive their own figures.
-- Sources: leads created in the range, and how far that group has got.
create or replace function public.report_sources(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.leads desc,x.source),'[]'::jsonb) into result from (
  select l.source,count(*) leads,
   count(*) filter(where exists(select 1 from public.calls c where c.lead_id=l.id)) contacted,
   count(*) filter(where exists(select 1 from public.visits v where v.lead_id=l.id and v.status='completed')) visited,
   count(*) filter(where l.status='won') won,
   count(*) filter(where l.status='lost') lost,
   coalesce(sum((select d.expected_value from public.deals d where d.lead_id=l.id and d.stage='won')),0) revenue
  from public.active_leads l
  where l.created_at>=p_from and l.created_at<p_to and (scope is null or l.assigned_agent=scope)
  group by l.source) x;
 return result;
end $$;
-- Agents: assignment, first-call speed, calling, visits and sales in the range.
create or replace function public.report_agents(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,null,p_from,p_to);
 select coalesce(jsonb_agg(x.data order by x.name,x.id),'[]'::jsonb) into result from (
  select p.id,p.name,jsonb_build_object('agent_id',p.id,'name',p.name,'uid',p.uid,'active',p.active,
   'assigned',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.created_at>=p_from and a.created_at<p_to),
   'first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to),
   'on_time_first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to and a.first_call_at<=a.call_due_at),
   'first_calls_with_deadline',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to and a.call_due_at is not null),
   'avg_first_call_minutes',(select round(avg(public.working_minutes(a.created_at,a.first_call_at))) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.first_call_at>=p_from and a.first_call_at<p_to),
   'missed_first_calls',(select count(*) from public.assignments a join public.active_leads l on l.id=a.lead_id where a.agent_id=p.id and a.missed_at>=p_from and a.missed_at<p_to),
   'calls',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.started_at>=p_from and c.started_at<p_to),
   'connected_calls',(select count(*) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
   'talk_minutes',(select round(coalesce(sum(c.duration_seconds),0)/60.0) from public.calls c join public.active_leads l on l.id=c.lead_id where c.agent_id=p.id and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
   'visits_completed',(select count(*) from public.visits v join public.active_leads l on l.id=v.lead_id where v.agent_id=p.id and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to),
   'won_deals',(select count(*) from public.deals d join public.active_leads l on l.id=d.lead_id where d.agent_id=p.id and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date),
   'revenue',(select coalesce(sum(d.expected_value),0) from public.deals d join public.active_leads l on l.id=d.lead_id where d.agent_id=p.id and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date),
   'lost',(select count(*) from public.active_leads l where l.assigned_agent=p.id and l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to)) data
  from public.profiles p where p.role='agent' and p.deleted_at is null and (scope is null or p.id=scope)
   and (p.active or exists(select 1 from public.assignments a where a.agent_id=p.id and a.created_at>=p_from and a.created_at<p_to))) x;
 return result;
end $$;
-- Funnel: leads created in the range and the furthest stage each reached.
create or replace function public.report_funnel(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won'];result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 with cohort as (
  select l.id,l.status from public.active_leads l
  where l.created_at>=p_from and l.created_at<p_to and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source)
 ), reach as (
  select c.id,c.status,greatest(coalesce(array_position(stages,c.status),1),
   coalesce((select max(array_position(stages,h.to_status)) from public.lead_status_history h where h.lead_id=c.id),1)) reached
  from cohort c
 )
 select jsonb_build_object('total',(select count(*) from reach),'lost',(select count(*) from reach where status='lost'),
  'stages',(select jsonb_agg(jsonb_build_object('stage',stages[i],'reached',(select count(*) from reach where reached>=i)) order by i) from generate_subscripts(stages,1) i))
 into result;
 return result;
end $$;
-- Lost leads in the range by reason, source and current agent.
create or replace function public.report_lost(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope uuid;result jsonb;
begin
 scope=public.report_scope(p_actor,p_agent,p_from,p_to);
 with lost as (
  select l.lost_reason,l.source,l.assigned_agent from public.active_leads l
  where l.status='lost' and l.lost_at>=p_from and l.lost_at<p_to and (scope is null or l.assigned_agent=scope) and (p_source is null or l.source=p_source)
 )
 select jsonb_build_object('total',(select count(*) from lost),
  'by_reason',(select coalesce(jsonb_agg(jsonb_build_object('reason',lost_reason,'count',n) order by n desc,lost_reason),'[]'::jsonb) from (select lost_reason,count(*) n from lost group by lost_reason) r),
  'by_source',(select coalesce(jsonb_agg(jsonb_build_object('source',source,'count',n) order by n desc,source),'[]'::jsonb) from (select source,count(*) n from lost group by source) r),
  'by_agent',(select coalesce(jsonb_agg(jsonb_build_object('agent_id',assigned_agent,'name',coalesce(p.name,'Unassigned'),'count',n) order by n desc,p.name),'[]'::jsonb)
   from (select assigned_agent,count(*) n from lost group by assigned_agent) r left join public.profiles p on p.id=r.assigned_agent))
 into result;
 return result;
end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('report_scope','visit_calendar','visit_conflicts','prepare_target','stamp_followup_completion','target_period_end','targets_page','save_target',
  'copy_targets','crm_metrics','crm_metrics_038','report_sources','report_agents','report_funnel','report_lost') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
