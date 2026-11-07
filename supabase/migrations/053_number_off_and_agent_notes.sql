-- Update 053: "Number off" as a call outcome, and agents' lead lists show
-- their own latest note. Apply after 052. Safe to rerun.
--
-- * Number off (the customer's phone is switched off) is a call that did
--   not connect, like No answer, Busy and Wrong number: it is never an
--   answered call, so it never puts a lead in the Lead pipeline, moves it to
--   Contacted or counts as connected.
-- * agent_lead_list: search by a customer's name or contact number only (no
--   more # or HD numbers); a filter on the outcome of the lead's latest
--   call; and, for each row, its latest call and the latest note the agent
--   wrote (a lead note or a call's notes). Only that agent's own notes: the
--   author is who the audit log says created the note or call, because a
--   note or call saved by anyone on an agent's lead is filed under that
--   agent.
--
-- No existing row changes. Two call rules now accept Number off,
-- log_manual_call and agent_lead_list are replaced, and one partial index
-- finds who wrote a note.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.agent_lead_list(uuid,jsonb)') is null or to_regclass('crm_private.lead_file_rows') is null then
  raise exception 'Apply CRM updates up to 052 before update 053.';
 end if;
end $$;

-- Who wrote a note, from the audit log, as update 050 does for calls.
create index if not exists audit_log_note_records on public.audit_log(entity_id,id) where entity='notes';

-- ------------------------------------------------------- call outcomes
alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls add constraint calls_outcome_check check(outcome in ('No answer','Busy','Wrong number','Number off',
 'Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion'));
-- As in update 018, plus Number off among the outcomes of a call that did
-- not connect, and never on an answered call.
alter table public.calls drop constraint if exists calls_manual_values_check;
alter table public.calls add constraint calls_manual_values_check check (
  method<>'manual' or (
    answered is not null and outcome is not null and
    duration_seconds between 0 and 7200 and
    ((answered and duration_seconds>=1 and status='completed' and outcome<>'Number off') or
      (not answered and status='failed' and outcome in ('No answer','Busy','Wrong number','Number off'))) and
    ended_at is not null and ended_at=started_at+make_interval(secs=>duration_seconds) and
    provider_call_id is null and outcome_submitted_at is not null and not missing_outcome and
    coalesce(char_length(notes),0)<=4000 and cardinality(deal_tags)<=7 and
    deal_tags <@ array['Hot lead','Warm lead','Cold lead','Budget mismatch','Location mismatch','Ready to visit','Ready to close']::text[]
  )
);

-- As in update 018; only the outcomes of a call that did not connect change.
create or replace function public.log_manual_call(p_lead uuid,p_actor uuid,p_data jsonb,p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; customer public.leads; result public.calls;
  started timestamptz; seconds integer; did_answer boolean; call_tags text[];
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into customer from public.leads where id=p_lead
    and (actor.role='admin' or assigned_agent=p_actor) for update;
  if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' then
    raise exception 'Invalid call fields' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_object_keys(p_data) as field
    where field not in ('answered','started_at','duration_seconds','outcome','notes','deal_tags')) then
    raise exception 'Field forbidden' using errcode='42501';
  end if;
  if jsonb_typeof(p_data->'answered') is distinct from 'boolean' or
    jsonb_typeof(p_data->'started_at') is distinct from 'string' or
    jsonb_typeof(p_data->'duration_seconds') is distinct from 'number' or
    jsonb_typeof(p_data->'outcome') is distinct from 'string' then
    raise exception 'Call start, answered, duration and outcome are required' using errcode='23514';
  end if;
  if (p_data->>'duration_seconds')::numeric not between 0 and 7200 or
    (p_data->>'duration_seconds')::numeric<>floor((p_data->>'duration_seconds')::numeric) then
    raise exception 'Duration must be 0 to 7200 whole seconds' using errcode='23514';
  end if;
  if p_data->>'started_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Use a call start with an explicit timezone' using errcode='23514';
  end if;
  started=(p_data->>'started_at')::timestamptz;
  if not isfinite(started) or started>now()+interval '2 minutes' or
    started<now()-(case when actor.role='admin' then interval '30 days' else interval '48 hours' end) then
    raise exception 'Call start is outside the permitted time window' using errcode='23514';
  end if;
  seconds=(p_data->>'duration_seconds')::integer;
  did_answer=(p_data->>'answered')::boolean;
  if (did_answer and (seconds<1 or p_data->>'outcome'='Number off')) or (not did_answer and
    p_data->>'outcome' not in ('No answer','Busy','Wrong number','Number off')) then
    raise exception 'Choose a valid duration and outcome for whether the call was answered' using errcode='23514';
  end if;
  if p_data ? 'notes' and (jsonb_typeof(p_data->'notes')<>'string' or
    char_length(p_data->>'notes')>4000) then
    raise exception 'Use notes of 4000 characters or fewer' using errcode='23514';
  end if;
  if p_data ? 'deal_tags' then
    if jsonb_typeof(p_data->'deal_tags')<>'array' then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
    if exists(select 1 from jsonb_array_elements(p_data->'deal_tags') as tag
      where jsonb_typeof(tag)<>'string') then
      raise exception 'Invalid deal tags' using errcode='23514';
    end if;
  end if;
  call_tags=array(select jsonb_array_elements_text(coalesce(p_data->'deal_tags','[]'::jsonb)));
  if cardinality(call_tags)>7 or cardinality(call_tags)<>
    (select count(distinct tag) from unnest(call_tags) as tag) then
    raise exception 'Choose distinct supported tags' using errcode='23514';
  end if;
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,
    duration_seconds,outcome,notes,deal_tags,outcome_submitted_at,missing_outcome)
  values(customer.id,case when actor.role='admin' then coalesce(customer.assigned_agent,p_actor) else p_actor end,
    'manual',did_answer,case when did_answer then 'completed' else 'failed' end,
    started,started+make_interval(secs=>seconds),seconds,p_data->>'outcome',
    coalesce(p_data->>'notes',''),call_tags,now(),false) returning * into result;
  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;
  update public.leads set last_activity_at=now(),updated_at=now() where id=customer.id;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    values(p_actor,'call.manual_logged','calls',result.id::text,p_request,
      jsonb_build_object('lead_id',customer.id,'agent_id',result.agent_id,
        'fields',jsonb_build_array('method','answered','started_at','ended_at',
          'duration_seconds','outcome','notes','deal_tags','outcome_submitted_at','missing_outcome')));
  return to_jsonb(result);
end $$;

-- ------------------------------------------------------- the list
-- As in update 052, with these changes. Search: four or more digits (any
-- common format: 0300…, +92…, 0092…) is part of a contact number, anything
-- else part of the customer's name. outcome: the outcome of the lead's
-- latest call, answered or not. Each row also carries that latest call and
-- the latest note the agent wrote on the lead. The 052 status filter and
-- sorts stay accepted, so a page still open from before keeps working.
create or replace function public.agent_lead_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_view text;v_import uuid;v_search text;v_status text;v_temperature text;
 v_source text;v_call text;v_outcome text;v_sort text;v_page integer;v_limit constant integer=20;
 v_digits text;v_phone text;v_like text;result jsonb;
begin
 -- Agents only, and only the leads assigned to them now.
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if jsonb_typeof(q)<>'object' then raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(q) e
   where e.key not in ('view','import','search','status','temperature','source','call','outcome','sort','page')
    or jsonb_typeof(e.value) not in ('string','number')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_view=coalesce(q->>'view','assigned');v_search=nullif(btrim(coalesce(q->>'search','')),'');
 v_status=q->>'status';v_temperature=q->>'temperature';v_source=q->>'source';v_call=q->>'call';v_outcome=q->>'outcome';
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
   lc.started_at contact_at,lc.outcome contact_outcome,
   la.started_at last_call_at,la.outcome last_call_outcome,la.status='completed' last_call_connected,
   case tp.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end temperature,
   tp.started_at temperature_at,
   (select min(f.due_at) from public.followups f where f.lead_id=l.id and f.status='pending') next_followup_at
  from public.leads l
  left join crm_private.lead_file_rows r on r.lead_id=l.id and r.import_id=l.import_id
  left join public.lead_imports i on i.id=l.import_id
  -- The latest answered call: what puts a lead in the pipeline.
  left join lateral (select c.started_at,c.outcome from public.calls c where c.lead_id=l.id and c.status='completed'
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  -- The latest call of any kind, and its outcome.
  left join lateral (select c.started_at,c.outcome,c.status from public.calls c where c.lead_id=l.id
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) la on true
  -- The latest temperature saved with a call, chosen as in update 050.
  left join lateral (select t.tag,c.started_at from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) tp on true
  where l.assigned_agent=p_actor and l.deleted_at is null and (v_import is null or l.import_id=v_import)
 ), matched as (
  select m.* from mine m
  where (v_view='assigned' or m.contact_at is not null)
   and (v_search is null
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=m.id
     and (p.phone like '%'||v_digits||'%' or p.phone like '%'||v_phone||'%')))
    or (v_like is not null and m.name ilike v_like))
   and (v_status is null or m.status=v_status)
   and (v_source is null or m.source=v_source)
   and (v_outcome is null or m.last_call_outcome=v_outcome)
   and (v_call is null or (m.first_call_at is null and m.call_due_at is not null and m.status not in ('won','lost')
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
     'masked_phone',o.masked_phone,'assigned_agent',o.assigned_agent,'status',o.status,'source',o.source,
     'preferred_location',o.preferred_location,'budget_min',o.budget_min,'budget_max',o.budget_max,
     'lost_reason',o.lost_reason,'created_at',o.created_at,'last_activity_at',o.last_activity_at,
     'assigned_at',o.assigned_at,'call_due_at',o.call_due_at,'first_call_at',o.first_call_at,'missed_at',o.missed_at,
     'import_id',o.import_id,'file_row',o.file_row,'file_name',o.file_name,
     'contact',case when o.contact_at is not null then 'contacted' when o.last_call_at is not null then 'attempted' else 'none' end,
     'last_contact_at',o.contact_at,'last_contact_outcome',o.contact_outcome,
     'last_call_at',o.last_call_at,'last_call_outcome',o.last_call_outcome,'last_call_connected',o.last_call_connected,
     'temperature',o.temperature,'temperature_at',o.temperature_at,'next_followup_at',o.next_followup_at)
     -- The agent's own latest note on the lead: a lead note or a call's
     -- notes, whichever was written last, by this agent according to the
     -- audit log. Worked out for this page only.
     ||coalesce((select jsonb_build_object('note',x.body,'note_at',x.at) from (
       select n.body,n.created_at at from public.notes n where n.lead_id=o.id and btrim(n.body)<>''
        and exists(select 1 from public.audit_log a where a.entity='notes' and a.entity_id=n.id::text
         and a.action='create' and a.actor_id=p_actor)
       union all
       select c.notes,c.created_at from public.calls c where c.lead_id=o.id and btrim(coalesce(c.notes,''))<>''
        and exists(select 1 from public.audit_log a where a.entity='calls' and a.entity_id=c.id::text
         and a.action in ('create','call.manual_logged') and a.actor_id=p_actor)
      ) x order by x.at desc limit 1),jsonb_build_object('note',null,'note_at',null))
     order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- As before: only the server's service role calls these.
revoke all on function public.log_manual_call(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.log_manual_call(uuid,uuid,jsonb,text) to service_role;
revoke all on function public.agent_lead_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.agent_lead_list(uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
