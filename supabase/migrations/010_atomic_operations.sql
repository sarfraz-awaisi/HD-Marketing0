create function public.assign_lead(p_lead uuid,p_actor uuid,p_agent uuid default null,p_request text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare chosen uuid; begin
perform pg_advisory_xact_lock(873420);
if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then raise exception 'Forbidden' using errcode='42501'; end if;
perform 1 from public.leads where id=p_lead for update; if not found then raise exception 'Lead not found'; end if;
chosen=p_agent;
if chosen is null then select p.id into chosen from public.profiles p left join public.assignments a on a.agent_id=p.id where p.active and p.role='agent' group by p.id order by max(a.created_at) nulls first,p.id limit 1; end if;
if chosen is null or not exists(select 1 from public.profiles where id=chosen and active and role='agent') then raise exception 'No active agent'; end if;
update public.leads set assigned_agent=chosen,updated_at=now(),last_activity_at=now() where id=p_lead;
insert into public.assignments(lead_id,agent_id,actor_id) values(p_lead,chosen,p_actor);
insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'assign','leads',p_lead::text,p_request,jsonb_build_object('agent_id',chosen));
return chosen; end $$;

create function public.create_lead(p_data jsonb,p_phone text,p_actor uuid,p_request text) returns public.leads language plpgsql security definer set search_path='' as $$
declare result public.leads; begin
if not exists(select 1 from public.profiles where id=p_actor and role='admin' and active) then raise exception 'Forbidden' using errcode='42501'; end if;
insert into public.leads(name,masked_phone,email,source,property_id,budget_min,budget_max,preferred_location) values(p_data->>'name',left(p_phone,3)||'******'||right(p_phone,3),nullif(p_data->>'email',''),coalesce(p_data->>'source','manual'),nullif(p_data->>'property_id','')::uuid,coalesce((p_data->>'budget_min')::numeric,0),(p_data->>'budget_max')::numeric,p_data->>'preferred_location') returning * into result;
insert into crm_private.lead_phones(lead_id,phone) values(result.id,p_phone);
insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,'create','leads',result.id::text,p_request);
if p_data ? 'assigned_agent' and p_data->>'assigned_agent' is not null then perform public.assign_lead(result.id,p_actor,(p_data->>'assigned_agent')::uuid,p_request); select * into result from public.leads where id=result.id; end if;
return result; end $$;

create function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; lead uuid; existing jsonb; result jsonb; cols text; vals text; sets text; allowed text[]; k text; begin
select * into actor from public.profiles where id=p_actor and active;
if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
if p_table not in ('leads','notes','calls','followups','visits','deals','properties','targets','profiles') then raise exception 'Invalid entity'; end if;
if p_table in ('properties','targets','profiles') and actor.role<>'admin' then raise exception 'Forbidden' using errcode='42501'; end if;
if p_id is not null then execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_table) into existing using p_id; if existing is null then raise exception 'Not found' using errcode='P0002'; end if; end if;
if p_table='leads' then lead=p_id;
elsif p_table in ('notes','calls','followups','visits','deals') then lead=coalesce((existing->>'lead_id')::uuid,(p_data->>'lead_id')::uuid); end if;
if lead is not null then perform 1 from public.leads where id=lead and (actor.role='admin' or assigned_agent=p_actor) for update; if not found then raise exception 'Forbidden' using errcode='42501'; end if; end if;
allowed=case p_table when 'leads' then case when actor.role='admin' then array['name','email','status','source','property_id','budget_min','budget_max','preferred_location'] else array['status'] end when 'notes' then array['lead_id','agent_id','body'] when 'calls' then array['lead_id','agent_id','provider_call_id','status','ended_at','duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome'] when 'followups' then array['lead_id','agent_id','due_at','notes','status'] when 'visits' then array['lead_id','agent_id','property_id','scheduled_at','status','notes'] when 'deals' then array['lead_id','agent_id','property_id','stage','expected_value','close_date','notes'] when 'properties' then array['title','description','location','price','type','area','area_unit','availability'] when 'targets' then array['agent_id','month','calls','visits','deals','revenue'] when 'profiles' then array['name','active'] end;
if p_table in ('notes','calls','followups','visits','deals') then
 if p_id is null then p_data=p_data||jsonb_build_object('agent_id',coalesce((select assigned_agent from public.leads where id=lead),p_actor));
 else p_data=p_data-'lead_id'-'agent_id'; end if;
end if;
for k in select jsonb_object_keys(p_data) loop if not k=any(allowed) then raise exception 'Field forbidden' using errcode='42501'; end if; end loop;
select string_agg(format('%I',key),','),string_agg(format('r.%I',key),','),string_agg(format('%I=r.%I',key,key),',') into cols,vals,sets from jsonb_object_keys(p_data) key;
if cols is null then raise exception 'Empty change'; end if;
if p_id is null then execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_table,cols,vals,p_table,p_table) into result using p_data;
else execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t.*)',p_table,sets,p_table) into result using p_data,p_id; end if;
if lead is not null then update public.leads set last_activity_at=now(),updated_at=now() where id=lead; end if;
insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,case when p_id is null then 'create' else 'update' end,p_table,result->>'id',p_request,jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_data)))));
return result; end $$;

create function public.crm_metrics(p_actor uuid,p_from timestamptz,p_to timestamptz,p_agent uuid default null,p_source text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result jsonb; begin
select * into actor from public.profiles where id=p_actor and active;
if actor.id is null then raise exception 'Forbidden' using errcode='42501'; end if;
if actor.role='agent' then p_agent=p_actor; end if;
with eligible as (select * from public.leads where (p_agent is null or assigned_agent=p_agent) and (p_source is null or source=p_source)),
l as (select * from eligible where created_at>=p_from and created_at<p_to),
c as (select c.* from public.calls c join eligible l on l.id=c.lead_id where (p_agent is null or c.agent_id=p_agent) and c.status='completed' and c.ended_at>=p_from and c.ended_at<p_to),
v as (select v.* from public.visits v join eligible l on l.id=v.lead_id where (p_agent is null or v.agent_id=p_agent) and v.status='completed' and v.scheduled_at>=p_from and v.scheduled_at<p_to),
d as (select d.* from public.deals d join eligible l on l.id=d.lead_id where (p_agent is null or d.agent_id=p_agent) and d.stage='won' and d.close_date>=(p_from at time zone 'Asia/Karachi')::date and d.close_date<(p_to at time zone 'Asia/Karachi')::date)
select jsonb_build_object('assigned_leads',(select count(*) from eligible),'today_completed_calls',(select count(*) from public.calls c join eligible l on l.id=c.lead_id where c.status='completed' and (p_agent is null or c.agent_id=p_agent) and (c.ended_at at time zone 'Asia/Karachi')::date=(now() at time zone 'Asia/Karachi')::date),'leads',(select count(*) from l),'completed_calls',(select count(*) from c),'completed_visits',(select count(*) from v),'won_deals',(select count(*) from d),'revenue',(select coalesce(sum(expected_value),0) from d),'active_agents',(select count(*) from public.profiles where active and role='agent'),'due_followups',(select count(*) from public.followups f join eligible l on l.id=f.lead_id where f.status='pending' and f.due_at>=date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi' and f.due_at<=now()+interval '1 day'),'overdue_followups',(select count(*) from public.followups f join eligible l on l.id=f.lead_id where f.status='pending' and f.due_at<now()),'scheduled_visits',(select count(*) from public.visits v join eligible l on l.id=v.lead_id where v.status='scheduled' and v.scheduled_at>=now()),'by_status',(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from l group by status) s),'by_source',(select coalesce(jsonb_object_agg(source,n),'{}') from (select source,count(*) n from l group by source) s)) into result;
return result; end $$;

create function public.crm_leaderboard(p_actor uuid,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501'; end if;
select coalesce(jsonb_agg(jsonb_build_object('name',p.name,'won_deals',(select count(*) from public.deals d where d.agent_id=p.id and stage='won' and close_date>=(p_from at time zone 'Asia/Karachi')::date and close_date<(p_to at time zone 'Asia/Karachi')::date),'completed_calls',(select count(*) from public.calls c where c.agent_id=p.id and status='completed' and ended_at>=p_from and ended_at<p_to))),'[]') into result from public.profiles p where p.active and p.role='agent'; return result; end $$;

do $$ declare f record; begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('assign_lead','create_lead','crm_mutate','crm_metrics','crm_leaderboard') loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); execute format('grant execute on function %s to service_role',f.signature); end loop; end $$;

do $$ declare t text; begin foreach t in array array['leads','properties','followups','visits','deals'] loop execute format('create trigger touch_updated before update on public.%I for each row execute function public.touch_updated()',t); end loop; end $$;
