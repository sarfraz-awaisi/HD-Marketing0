-- Update 091: automatic lead distribution. Administrators set a batch size,
-- the agents and each agent's percentage; whenever that many eligible
-- unassigned leads are waiting, one complete batch is shared among them.
-- Apply after 090. Safe to rerun. No lead, call or assignment is changed by
-- the update itself; it adds three private tables and the functions below,
-- and lets the worker report the new job. Automatic assignment starts OFF.
--
-- * Eligible (auto_assign_pool): no agent, not in Deleted leads, never
--   assigned to any agent before (so turning it off and on, or a lead
--   losing its agent, never shares a lead again), not an incoming social
--   lead waiting for an administrator's choice (as assign_lead refuses for
--   jobs), not Won or Lost, and its latest saved call outcome is not one an
--   agent is working on (as Never Worked, update 088). "New leads only"
--   counts leads added since automatic assignment was last switched on.
-- * auto_assign_run: one complete batch, oldest leads first, never a part
--   batch. Under the assignment lock and the settings row lock it selects
--   the leads, locks them, checks them again (if any changed, nothing is
--   assigned and the next run tries again) and gives each to its agent
--   through assign_lead, with the usual assignment history, audit entry and
--   first-call deadline. The whole batch is assigned or none of it. The
--   worker (job autoAssignLeads, named in JOBS_ENABLED) or an
--   administrator's Run now calls it; automatic batches act as the
--   administrator who saved the settings, as Google Sheets acts as its
--   creator (update 056).
-- * Shares: each batch's counts are the largest remainders of the batch
--   size times each percentage plus each agent's carried balance, so small
--   batches add up to the percentages over time; ties go to the agent listed
--   first. Within a batch the leads are spread among the agents in turn.
--   Saving the settings starts the balance again; pausing keeps it.
-- * A setting that no longer works (an agent or the administrator no longer
--   active) stops it (Error) until an administrator saves or resumes it;
--   three failed batches in a row also stop it.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.assign_lead(uuid,uuid,uuid,text)') is null
  or to_regprocedure('public.worker_lease(uuid,integer,text[])') is null
  or to_regprocedure('public.record_job_heartbeat(text,boolean)') is null
  or to_regprocedure('public.admin_distribute_agent_uncalled(uuid,uuid[],uuid[],boolean,text,text)') is null then
  raise exception 'Apply CRM updates up to 090 before update 091.';
 end if;
end $$;

create table if not exists crm_private.auto_assign_settings(
 id boolean primary key default true check(id),
 version integer not null default 0 check(version>=0),
 state text not null default 'off' check(state in ('off','on','paused','error')),
 batch_size integer not null default 20 check(batch_size between 1 and 500),
 scope text not null default 'new' check(scope in ('new','backlog')),
 active_since timestamptz,
 updated_by uuid references public.profiles(id),
 updated_at timestamptz not null default now(),
 last_batch_at timestamptz,
 last_error text check(last_error is null or length(last_error)<=300),
 last_error_at timestamptz,
 failures integer not null default 0 check(failures>=0)
);
insert into crm_private.auto_assign_settings(id) values(true) on conflict do nothing;
create table if not exists crm_private.auto_assign_rules(
 agent_id uuid primary key references public.profiles(id),
 percent numeric(5,2) not null check(percent>0 and percent<=100),
 position smallint not null check(position between 1 and 50),
 balance numeric not null default 0
);
create table if not exists crm_private.auto_assign_batches(
 id uuid primary key,
 created_at timestamptz not null default now(),
 trigger text not null check(trigger in ('automatic','manual')),
 actor_id uuid references public.profiles(id),
 config_version integer not null,
 batch_size integer not null,
 assigned integer not null default 0,
 allocation jsonb not null default '[]',
 lead_ids uuid[] not null default '{}',
 status text not null check(status in ('assigned','failed','skipped')),
 reason text check(reason is null or length(reason)<=300)
);
create index if not exists auto_assign_batches_created on crm_private.auto_assign_batches(created_at desc);
alter table crm_private.auto_assign_settings enable row level security;
alter table crm_private.auto_assign_rules enable row level security;
alter table crm_private.auto_assign_batches enable row level security;
revoke all on crm_private.auto_assign_settings,crm_private.auto_assign_rules,crm_private.auto_assign_batches
 from public,anon,authenticated;

-- The worker may report the new job (update 026's list, plus this one).
alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check,
 add constraint job_heartbeats_job_check check(job=any(array['deleteOldRecordings','reportInactiveLeadOwners',
  'leadResponseCheck','followUpReminders','missingOutcomeCheck','cleanupPropertyPhotos','cleanupKnowledgeFiles',
  'processMetaLeads','attendanceReconciliation','autoAssignLeads']));

-- The leads automatic assignment may take, from p_since (null: any time).
create or replace function public.auto_assign_pool(p_since timestamptz) returns table(id uuid,created_at timestamptz)
language sql stable security definer set search_path='' as $$
 select l.id,l.created_at from public.leads l
 where l.deleted_at is null and l.assigned_agent is null and not l.meta_pending_assignment
  and l.status not in ('won','lost')
  and (p_since is null or l.created_at>=p_since)
  and not exists(select 1 from public.assignments a where a.lead_id=l.id and a.agent_id is not null)
  and coalesce((select c.outcome from public.calls c where c.lead_id=l.id and c.outcome is not null
    order by c.started_at desc,c.created_at desc,c.id desc limit 1),'-')
   not in ('Interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost')
$$;

-- One batch's shares. p_rules: [{agent_id, percent, balance}] in the
-- settings' order. Counts: each unit to the agent with the largest
-- balance + count × percent left (ties: listed first), so the counts are
-- the largest remainders, never below zero, and add up to p_count. Then the
-- units are spread in turn (each agent as often as its count). Returns the
-- counts, the new balances and the agent for each unit.
create or replace function public.auto_assign_plan(p_count integer,p_rules jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k integer=jsonb_array_length(p_rules);v_ids uuid[];v_left numeric[];v_n integer[];v_turn numeric[];
 v_seq uuid[]='{}';best integer;i integer;u integer;
begin
 if p_count is null or p_count<0 or k<1 then raise exception 'Choose valid shares' using errcode='22023';end if;
 select array_agg((r->>'agent_id')::uuid order by o),
  array_agg(coalesce((r->>'balance')::numeric,0)+p_count*(r->>'percent')::numeric/100 order by o),
  array_agg(0 order by o)
  into v_ids,v_left,v_n from jsonb_array_elements(p_rules) with ordinality x(r,o);
 for u in 1..p_count loop
  best=1;
  for i in 2..k loop if v_left[i]>v_left[best] then best=i;end if;end loop;
  v_n[best]=v_n[best]+1;v_left[best]=v_left[best]-1;
 end loop;
 v_turn=array_fill(0::numeric,array[k]);
 for u in 1..p_count loop
  best=0;
  for i in 1..k loop
   if v_n[i]>0 then
    v_turn[i]=v_turn[i]+v_n[i];
    if best=0 or v_turn[i]>v_turn[best] then best=i;end if;
   end if;
  end loop;
  v_turn[best]=v_turn[best]-p_count;v_seq=v_seq||v_ids[best];
 end loop;
 return jsonb_build_object('sequence',to_jsonb(v_seq),
  'agents',(select jsonb_agg(jsonb_build_object('agent_id',v_ids[g.n],'count',v_n[g.n],'balance',v_left[g.n]) order by g.n)
   from generate_series(1,k) g(n)));
end $$;

-- What makes a setting unusable now, or null. p_rules as in the plan.
create or replace function public.auto_assign_problem(p_batch integer,p_rules jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare v_bad text;
begin
 if p_batch is null or p_batch not between 1 and 500 then return 'Choose a batch of 1 to 500 leads';end if;
 if p_rules is null or jsonb_typeof(p_rules)<>'array' or jsonb_array_length(p_rules) not between 1 and 50 then
  return 'Choose 1 to 50 agents';end if;
 if exists(select 1 from jsonb_array_elements(p_rules) r where jsonb_typeof(r->'percent')<>'number'
   or (r->>'percent')::numeric<=0 or (r->>'percent')::numeric>100 or (r->>'percent')::numeric<>round((r->>'percent')::numeric,2)) then
  return 'Give each agent a percentage above 0 and up to 100, with at most two decimals';end if;
 if (select count(distinct r->>'agent_id') from jsonb_array_elements(p_rules) r)<>jsonb_array_length(p_rules) then
  return 'Choose each agent once';end if;
 if (select sum((r->>'percent')::numeric) from jsonb_array_elements(p_rules) r)<>100 then
  return 'The percentages must add up to exactly 100';end if;
 select string_agg(coalesce(p.name,'an unknown account'),', ' order by p.name) into v_bad
  from jsonb_array_elements(p_rules) r left join public.profiles p on p.id::text=r->>'agent_id'
  where p.id is null or not p.active or p.role<>'agent' or p.deleted_at is not null;
 if v_bad is not null then return 'Not an active agent: '||v_bad;end if;
 return null;
end $$;

-- How many leads wait, for the status and the preview.
create or replace function public.auto_assign_counts(p_scope text,p_since timestamptz,p_batch integer) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('eligible',e.n,'new',w.n,'backlog',e.n-w.n,
  'waiting',case when p_scope='backlog' then e.n else w.n end,
  'batches',(case when p_scope='backlog' then e.n else w.n end)/greatest(p_batch,1),
  'leftover',(case when p_scope='backlog' then e.n else w.n end)%greatest(p_batch,1))
 from (select count(*)::integer n from public.auto_assign_pool(null)) e,
  (select case when p_since is null then 0 else (select count(*)::integer from public.auto_assign_pool(p_since)) end n) w
$$;

-- The settings as saved, how many leads wait, the next batch's shares, the
-- worker and recent batches (no customer details).
create or replace function public.auto_assign_status(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s record;v_rules jsonb;
begin
 perform public.accounts_admin(p_actor);
 select * into s from crm_private.auto_assign_settings where id;
 select coalesce(jsonb_agg(jsonb_build_object('agent_id',r.agent_id,'name',p.name,'percent',r.percent,'balance',r.balance,
   'active',coalesce(p.active and p.role='agent' and p.deleted_at is null,false)) order by r.position),'[]'::jsonb)
  into v_rules from crm_private.auto_assign_rules r left join public.profiles p on p.id=r.agent_id;
 return jsonb_build_object('version',s.version,'state',s.state,'batch_size',s.batch_size,'scope',s.scope,
  'active_since',s.active_since,'updated_at',s.updated_at,'updated_by',s.updated_by,
  'updated_by_name',(select name from public.profiles where id=s.updated_by),
  'last_batch_at',s.last_batch_at,'last_error',s.last_error,'last_error_at',s.last_error_at,'failures',s.failures,
  'rules',v_rules,'problem',case when jsonb_array_length(v_rules)>0 then public.auto_assign_problem(s.batch_size,v_rules) end,
  'counts',public.auto_assign_counts(s.scope,case when s.state='off' then null else s.active_since end,s.batch_size),
  'next',case when jsonb_array_length(v_rules)>0 then public.auto_assign_plan(s.batch_size,v_rules)->'agents' end,
  'today',(select coalesce(sum(b.assigned),0) from crm_private.auto_assign_batches b where b.status='assigned'
    and (b.created_at at time zone 'Asia/Karachi')::date=(now() at time zone 'Asia/Karachi')::date),
  'worker',(select jsonb_build_object('running',coalesce(bool_or(w.expires_at>now()),false),
     'has_job',coalesce(bool_or(w.expires_at>now() and 'autoAssignLeads'=any(w.jobs)),false),
     'last_run_at',(select h.last_run_at from public.job_heartbeats h where h.job='autoAssignLeads'),
     'last_status',(select h.last_status from public.job_heartbeats h where h.job='autoAssignLeads'))
    from crm_private.worker_lease w),
  'batches',(select coalesce(jsonb_agg(x.b order by x.created_at desc),'[]'::jsonb) from (
    select b.created_at,jsonb_build_object('id',b.id,'created_at',b.created_at,'trigger',b.trigger,
     'actor_name',(select name from public.profiles where id=b.actor_id),'config_version',b.config_version,
     'batch_size',b.batch_size,'assigned',b.assigned,'status',b.status,'reason',b.reason,
     'allocation',(select coalesce(jsonb_agg(a.v||jsonb_build_object('name',p.name) order by a.o),'[]'::jsonb)
      from jsonb_array_elements(b.allocation) with ordinality a(v,o) left join public.profiles p on p.id::text=a.v->>'agent_id')) b
    from crm_private.auto_assign_batches b order by b.created_at desc limit 10) x));
end $$;

-- A setting before saving: one batch's shares (from a fresh balance) and how
-- many leads would wait, for the scope chosen.
create or replace function public.auto_assign_preview(p_actor uuid,p_batch integer,p_rules jsonb,p_scope text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_problem text;s record;
begin
 perform public.accounts_admin(p_actor);
 if p_scope is null or p_scope not in ('new','backlog') then raise exception 'Choose which leads to include' using errcode='22023';end if;
 v_problem=public.auto_assign_problem(p_batch,p_rules);
 if v_problem is not null then raise exception 'Choose valid settings: %',v_problem using errcode='22023';end if;
 select * into s from crm_private.auto_assign_settings where id;
 return jsonb_build_object('agents',public.auto_assign_plan(p_batch,
   (select jsonb_agg(r-'balance' order by o) from jsonb_array_elements(p_rules) with ordinality x(r,o)))->'agents',
  'counts',public.auto_assign_counts(p_scope,case when s.state='off' then null else s.active_since end,p_batch));
end $$;

-- Save the settings (version: the one the administrator started from).
-- Switching it on from Off starts "new leads" from now. Saving starts the
-- balance again. A batch being assigned finishes first (the row lock).
create or replace function public.auto_assign_save(p_actor uuid,p_version integer,p_state text,p_batch integer,
 p_scope text,p_rules jsonb,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s record;v_problem text;
begin
 perform public.accounts_admin(p_actor);
 if p_state is null or p_state not in ('on','off','paused') or p_scope is null or p_scope not in ('new','backlog') then
  raise exception 'Choose valid settings' using errcode='22023';end if;
 v_problem=public.auto_assign_problem(p_batch,p_rules);
 if v_problem is not null then raise exception 'Choose valid settings: %',v_problem using errcode='22023';end if;
 select * into s from crm_private.auto_assign_settings where id for update;
 if p_version is distinct from s.version then
  raise exception 'Another administrator changed these settings after you opened them. Check them and save again.' using errcode='HA409';end if;
 delete from crm_private.auto_assign_rules;
 insert into crm_private.auto_assign_rules(agent_id,percent,position,balance)
  select (r->>'agent_id')::uuid,(r->>'percent')::numeric,o,0 from jsonb_array_elements(p_rules) with ordinality x(r,o);
 update crm_private.auto_assign_settings set version=s.version+1,state=p_state,batch_size=p_batch,scope=p_scope,
  active_since=case when p_state='on' and (s.state='off' or s.active_since is null) then now() else s.active_since end,
  updated_by=p_actor,updated_at=now(),failures=case when p_state='on' then 0 else failures end,
  last_error=case when p_state='on' then null else last_error end where id;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
 values(p_actor,'lead.auto_assign_settings','leads',p_request,jsonb_build_object('version',s.version+1,'state',p_state,
  'batch_size',p_batch,'scope',p_scope,'agents',(select jsonb_agg(jsonb_build_object('agent_id',r->>'agent_id','percent',r->'percent'))
   from jsonb_array_elements(p_rules) r)));
 return public.auto_assign_status(p_actor);
end $$;

-- Pause (at once, nothing new starts), Resume (only a setting that still
-- works; the administrator resuming acts for it from now) or Off.
create or replace function public.auto_assign_state(p_actor uuid,p_state text,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s record;v_rules jsonb;v_problem text;
begin
 perform public.accounts_admin(p_actor);
 if p_state is null or p_state not in ('on','off','paused') then raise exception 'Choose valid settings' using errcode='22023';end if;
 select * into s from crm_private.auto_assign_settings where id for update;
 if p_state='paused' and s.state not in ('on','error') then
  raise exception 'Choose a setting that is switched on to pause it' using errcode='22023';end if;
 if p_state='on' then
  if s.state not in ('paused','error') then raise exception 'Choose a paused setting to resume it' using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('agent_id',agent_id,'percent',percent) order by position) into v_rules from crm_private.auto_assign_rules;
  v_problem=public.auto_assign_problem(s.batch_size,v_rules);
  if v_problem is not null then raise exception 'Choose valid settings: %',v_problem using errcode='22023';end if;
 end if;
 update crm_private.auto_assign_settings set version=s.version+1,state=p_state,updated_by=p_actor,updated_at=now(),
  failures=case when p_state='on' then 0 else failures end,last_error=case when p_state='on' then null else last_error end where id;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
 values(p_actor,'lead.auto_assign_state','leads',p_request,jsonb_build_object('version',s.version+1,'from',s.state,'state',p_state));
 return public.auto_assign_status(p_actor);
end $$;

-- One complete batch, if one is due. p_actor: the administrator pressing
-- Run now, or null for the worker (the administrator who saved the
-- settings acts). Returns status assigned, waiting, skipped (leads changed
-- while it was prepared), failed, or the setting's state (off, paused,
-- error); more: another complete batch is waiting.
create or replace function public.auto_assign_run(p_actor uuid,p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s record;v_actor uuid;v_since timestamptz;v_waiting integer;v_ids uuid[];v_rules jsonb;v_plan jsonb;
 v_batch uuid=gen_random_uuid();v_trigger text=case when p_actor is null then 'automatic' else 'manual' end;
 v_problem text;v_reason text;v_alloc jsonb;i integer;
begin
 perform pg_advisory_xact_lock(873420);
 if p_actor is not null then perform public.accounts_admin(p_actor);end if;
 select * into s from crm_private.auto_assign_settings where id for update;
 if s.state<>'on' then return jsonb_build_object('status',s.state,'more',false);end if;
 v_actor=coalesce(p_actor,s.updated_by);
 select jsonb_agg(jsonb_build_object('agent_id',agent_id,'percent',percent,'balance',balance) order by position)
  into v_rules from crm_private.auto_assign_rules;
 v_problem=public.auto_assign_problem(s.batch_size,v_rules);
 if v_problem is null and not exists(select 1 from public.profiles where id=v_actor and active and role='admin' and deleted_at is null) then
  v_problem='The administrator who saved the settings is no longer active: an administrator must review and save them';end if;
 -- A setting that no longer works stops until an administrator fixes it.
 if v_problem is not null then
  update crm_private.auto_assign_settings set state='error',failures=failures+1,last_error=left(v_problem,300),last_error_at=now() where id;
  insert into crm_private.auto_assign_batches(id,trigger,actor_id,config_version,batch_size,status,reason)
  values(v_batch,v_trigger,p_actor,s.version,s.batch_size,'failed',left(v_problem,300));
  return jsonb_build_object('status','failed','reason',v_problem,'more',false);
 end if;
 v_since=case when s.scope='new' then s.active_since end;
 select count(*) into v_waiting from public.auto_assign_pool(v_since);
 if v_waiting<s.batch_size then return jsonb_build_object('status','waiting','waiting',v_waiting,'more',false);end if;
 -- The oldest leads, locked, then checked again: none taken in between.
 select array_agg(x.id order by x.created_at,x.id) into v_ids from (select p.id,p.created_at from public.auto_assign_pool(v_since) p
  order by p.created_at,p.id limit s.batch_size) x;
 perform 1 from public.leads where id=any(v_ids) order by id for update;
 if (select count(*) from public.auto_assign_pool(v_since) p where p.id=any(v_ids))<>s.batch_size then
  insert into crm_private.auto_assign_batches(id,trigger,actor_id,config_version,batch_size,status,reason)
  values(v_batch,v_trigger,p_actor,s.version,s.batch_size,'skipped','Leads changed while the batch was prepared; it is tried again next time');
  return jsonb_build_object('status','skipped','more',false);
 end if;
 v_plan=public.auto_assign_plan(s.batch_size,v_rules);
 select jsonb_agg(jsonb_build_object('agent_id',a->>'agent_id','count',(a->>'count')::integer,'percent',r->'percent') order by o)
  into v_alloc from jsonb_array_elements(v_plan->'agents') with ordinality x(a,o) join jsonb_array_elements(v_rules) r on r->>'agent_id'=a->>'agent_id';
 -- All of the batch or none of it.
 begin
  for i in 1..s.batch_size loop
   perform public.assign_lead(v_ids[i],v_actor,(v_plan->'sequence'->>(i-1))::uuid,'job:auto-assign:'||v_batch);
  end loop;
  update crm_private.auto_assign_rules r set balance=(a->>'balance')::numeric
   from jsonb_array_elements(v_plan->'agents') a where r.agent_id=(a->>'agent_id')::uuid;
  insert into crm_private.auto_assign_batches(id,trigger,actor_id,config_version,batch_size,assigned,allocation,lead_ids,status)
  values(v_batch,v_trigger,p_actor,s.version,s.batch_size,s.batch_size,v_alloc,v_ids,'assigned');
  update crm_private.auto_assign_settings set last_batch_at=now(),failures=0,last_error=null,last_error_at=null where id;
  insert into public.audit_log(actor_id,action,entity,request_id,metadata)
  values(v_actor,'lead.auto_assigned','leads','job:auto-assign:'||v_batch,jsonb_build_object('batch_id',v_batch,
   'trigger',v_trigger,'request',p_request,'config_version',s.version,'batch_size',s.batch_size,'allocation',v_alloc));
 exception when others then
  v_reason=case sqlstate when '42501' then 'The administrator who saved the settings may no longer assign leads'
   when 'P0002' then 'A lead changed while the batch was being assigned'
   else 'The CRM could not assign the batch (code '||sqlstate||')' end;
  update crm_private.auto_assign_settings set failures=failures+1,last_error=v_reason,last_error_at=now(),
   state=case when failures+1>=3 then 'error' else state end where id;
  insert into crm_private.auto_assign_batches(id,trigger,actor_id,config_version,batch_size,status,reason)
  values(v_batch,v_trigger,p_actor,s.version,s.batch_size,'failed',v_reason);
  return jsonb_build_object('status','failed','reason',v_reason,'more',false);
 end;
 return jsonb_build_object('status','assigned','batch_id',v_batch,'assigned',s.batch_size,'allocation',v_alloc,
  'more',v_waiting-s.batch_size>=s.batch_size);
end $$;

-- Browsers reach none of this: the server's service role calls it, and
-- checks the administrator first. The functions the server calls are
-- volatile, as PostgREST runs stable ones read-only (update 048).
revoke all on function public.auto_assign_pool(timestamptz),public.auto_assign_problem(integer,jsonb),
 public.auto_assign_counts(text,timestamptz,integer),public.auto_assign_plan(integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.auto_assign_status(uuid),
 public.auto_assign_preview(uuid,integer,jsonb,text),public.auto_assign_save(uuid,integer,text,integer,text,jsonb,text),
 public.auto_assign_state(uuid,text,text),public.auto_assign_run(uuid,text) from public,anon,authenticated;
grant execute on function public.auto_assign_status(uuid),
 public.auto_assign_preview(uuid,integer,jsonb,text),public.auto_assign_save(uuid,integer,text,integer,text,jsonb,text),
 public.auto_assign_state(uuid,text,text),public.auto_assign_run(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
