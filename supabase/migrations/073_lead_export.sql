-- Update 073: administrators export leads file by file, with their whole CRM
-- history (calls, notes, assignments) and the advertisement each came from.
-- Apply after 072. Safe to rerun. Read-only functions only: no table, row
-- or existing function changes.
--
-- A lead's file is the one it was created in (leads.import_id): a CSV or
-- Excel file (lead_imports, each lead's row in crm_private.lead_file_rows),
-- or a Google Sheet, which keeps one lead file for good (update 056; the
-- Sheet is told apart by its spreadsheet ID and tab, never by its name). A
-- Sheet row whose number already belonged to a lead is a repeat inquiry on
-- that lead: counted in the Sheet's figures, never exported as one of its
-- leads. Leads with no file (added by hand, from Meta Lead Ads directly,
-- WhatsApp) can be exported as "No file".
--
-- The advertisement is the one that created the lead, as recorded: the
-- Sheet row's campaign, ad set, ad and form (crm_private.sheet_lead_
-- inquiries), or the Meta Lead Ads submission that created it
-- (meta_submissions, status created). A CSV or Excel file only gives an ad
-- name (leads.ad_name, update 068). Nothing is inferred for a lead with
-- none.
--
-- Only leads not in Deleted leads (deleted_at null) are ever matched or read;
-- a lead erased for good no longer exists anywhere to be exported.
--
-- Filters (p_query keys), all optional and combined:
-- * lead now: files (lead file IDs) and no_file, agent or assignment,
--   source, status, temperature (the latest Hot, Warm or Cold saved with a
--   call since the lead came to its agent, as All leads reads it), outcome
--   (the latest call's, as All leads), contacted (yes: at least one answered
--   call, as Reports count answered calls; no: none), followup (pending,
--   overdue, completed, none), visit (scheduled, completed, cancelled,
--   none), deal (discussion, negotiation, won, lost, none);
-- * history: created_from and created_to (Pakistan days the lead was
--   created), calls_from and calls_to (Pakistan days with at least one call
--   on it), had_outcome (at least one call with that outcome, in that call
--   period when one is chosen).
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regclass('public.kpi_evidence') is null or to_regclass('crm_private.sheet_lead_inquiries') is null
  or to_regclass('crm_private.lead_file_rows') is null or to_regprocedure('public.workspace_since(uuid)') is null
  or to_regprocedure('public.report_recorded_by(text,uuid)') is null then
  raise exception 'Apply CRM updates up to 072 before update 073.';
 end if;
end $$;

-- ------------------------------------------------------------------ helpers
-- The lead's temperature now: the latest Hot, Warm or Cold saved with a call
-- since the lead came to its current agent (admin_lead_list's rule).
create or replace function public.lead_export_temperature(p_lead uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('value',case t.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' else 'cold' end,'at',c.started_at)
 from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
 where c.lead_id=p_lead and t.tag in ('Hot lead','Warm lead','Cold lead') and c.created_at>=coalesce(public.workspace_since(p_lead),'-infinity')
 order by c.started_at desc,c.created_at desc,c.id desc limit 1
$$;
-- Who wrote a record: the audit log's creator (update 050 for activities,
-- update 053 for notes), else the agent it is filed under.
create or replace function public.lead_export_author(p_entity text,p_id uuid,p_filed uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'role',p.role) from public.profiles p
 where p.id=coalesce(case when p_entity='notes' then (select a.actor_id from public.audit_log a where a.entity='notes'
   and a.entity_id=p_id::text and a.action='create' order by a.id limit 1) else public.report_recorded_by(p_entity,p_id) end,p_filed)
$$;
create or replace function public.lead_export_person(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'uid',p.uid,'role',p.role,'active',p.active) from public.profiles p where p.id=p_id
$$;

-- The leads matching the filters, with what orders them: their file (oldest
-- file first), their row in it, then when they were created.
create or replace function public.lead_export_match(p_query jsonb) returns table(lead_id uuid,import_id uuid,created_at timestamptz,file_created timestamptz,file_row integer)
language plpgsql stable security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}');v_files uuid[];v_no_file boolean;v_agent uuid;
 v_created_from timestamptz;v_created_to timestamptz;v_calls_from timestamptz;v_calls_to timestamptz;
 outcomes constant text[]=array['No answer','Busy','Wrong number','Number off','Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion'];
begin
 if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_each(q) e where e.key not in ('files','no_file','agent','assignment','source','status',
   'temperature','outcome','contacted','followup','visit','deal','created_from','created_to','calls_from','calls_to','had_outcome')
   or (e.key<>'files' and jsonb_typeof(e.value) not in ('string','boolean')))
  or (q ? 'files' and (jsonb_typeof(q->'files')<>'array' or jsonb_array_length(q->'files') not between 1 and 200))
  or (q->>'assignment' is not null and q->>'assignment' not in ('assigned','unassigned'))
  or (q->>'assignment'='unassigned' and q ? 'agent')
  or (q->>'source' is not null and q->>'source' not in ('manual','CSV','Meta','WhatsApp','other'))
  or (q->>'status' is not null and q->>'status' not in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'))
  or (q->>'temperature' is not null and q->>'temperature' not in ('hot','warm','cold','none'))
  or (q->>'outcome' is not null and not (q->>'outcome')=any(outcomes))
  or (q->>'had_outcome' is not null and not (q->>'had_outcome')=any(outcomes))
  or (q->>'contacted' is not null and q->>'contacted' not in ('yes','no'))
  or (q->>'followup' is not null and q->>'followup' not in ('pending','overdue','completed','none'))
  or (q->>'visit' is not null and q->>'visit' not in ('scheduled','completed','cancelled','none'))
  or (q->>'deal' is not null and q->>'deal' not in ('discussion','negotiation','won','lost','none')) then
  raise exception 'Choose valid export filters' using errcode='22023';
 end if;
 begin
  if q ? 'files' then select array_agg(distinct x::uuid) into v_files from jsonb_array_elements_text(q->'files') x;end if;
  v_no_file=coalesce((q->>'no_file')::boolean,false);
  v_agent=(q->>'agent')::uuid;
  v_created_from=((q->>'created_from')::date)::timestamp at time zone 'Asia/Karachi';
  v_created_to=((q->>'created_to')::date+1)::timestamp at time zone 'Asia/Karachi';
  v_calls_from=((q->>'calls_from')::date)::timestamp at time zone 'Asia/Karachi';
  v_calls_to=((q->>'calls_to')::date+1)::timestamp at time zone 'Asia/Karachi';
 exception when others then raise exception 'Choose valid export filters' using errcode='22023';
 end;
 if v_created_from>=v_created_to or v_calls_from>=v_calls_to then
  raise exception 'Choose a start on or before the end' using errcode='22023';end if;
 return query
 select l.id,l.import_id,l.created_at,f.created_at,fr.file_row from public.leads l
 left join public.lead_imports f on f.id=l.import_id
 left join crm_private.lead_file_rows fr on fr.lead_id=l.id and fr.import_id=l.import_id
 where l.deleted_at is null and ((v_files is null and not v_no_file) or l.import_id=any(v_files) or (v_no_file and l.import_id is null))
  and (q->>'assignment' is null or (q->>'assignment'='assigned')=(l.assigned_agent is not null))
  and (v_agent is null or l.assigned_agent=v_agent)
  and (q->>'source' is null or l.source=q->>'source')
  and (q->>'status' is null or l.status=q->>'status')
  and (v_created_from is null or l.created_at>=v_created_from) and (v_created_to is null or l.created_at<v_created_to)
  and (q->>'temperature' is null or coalesce(public.lead_export_temperature(l.id)->>'value','none')=q->>'temperature')
  and (q->>'outcome' is null or (select c.outcome from public.calls c where c.lead_id=l.id
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) is not distinct from q->>'outcome')
  and (q->>'contacted' is null or exists(select 1 from public.calls c where c.lead_id=l.id and c.status='completed')=(q->>'contacted'='yes'))
  and ((v_calls_from is null and v_calls_to is null and q->>'had_outcome' is null) or exists(select 1 from public.calls c where c.lead_id=l.id
   and (v_calls_from is null or c.started_at>=v_calls_from) and (v_calls_to is null or c.started_at<v_calls_to)
   and (q->>'had_outcome' is null or c.outcome=q->>'had_outcome')))
  and (q->>'followup' is null or case q->>'followup'
   when 'none' then not exists(select 1 from public.followups f where f.lead_id=l.id)
   when 'overdue' then exists(select 1 from public.followups f where f.lead_id=l.id and f.status='pending' and f.due_at<now())
   else exists(select 1 from public.followups f where f.lead_id=l.id and f.status=q->>'followup') end)
  and (q->>'visit' is null or case q->>'visit'
   when 'none' then not exists(select 1 from public.visits v where v.lead_id=l.id)
   when 'cancelled' then exists(select 1 from public.visits v where v.lead_id=l.id and v.status in ('cancelled','no-show'))
   else exists(select 1 from public.visits v where v.lead_id=l.id and v.status=q->>'visit') end)
  and (q->>'deal' is null or case q->>'deal'
   when 'none' then not exists(select 1 from public.deals d where d.lead_id=l.id)
   else exists(select 1 from public.deals d where d.lead_id=l.id and d.stage=q->>'deal') end);
end $$;

-- ------------------------------------------------------- what can be chosen
-- Every lead file, Sheets with their spreadsheet and tab, and the figures
-- that can be checked: rows the source had, new leads it created, repeat
-- inquiries (Sheets), rows rejected, its leads now in the CRM, in Deleted
-- leads, and no longer in the CRM (erased). Then leads with no file, by
-- source. Counts only.
create or replace function public.lead_export_sources(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return jsonb_build_object(
  'files',coalesce((select jsonb_agg(x.f order by x.created_at desc,x.id) from (
   select i.id,i.created_at,jsonb_build_object('id',i.id,'name',coalesce(s.name,i.file_name),'file_name',i.file_name,
    'format',i.file_format,'worksheet',i.worksheet,'legacy',i.legacy,'created_at',i.created_at,'file_deleted',i.deleted_at is not null,
    'sheet',case when s.id is null then null else jsonb_build_object('id',s.id,'name',s.name,'spreadsheet_id',s.spreadsheet_id,
     'worksheet',s.worksheet,'enabled',s.enabled,'rows',s.sheet_rows,'import_from',s.import_from,'last_sync_at',s.last_sync_at) end,
    'rows',case when s.id is null then i.total_rows else s.sheet_rows end,
    'created',case when s.id is null then i.imported_count else
     (select count(*) from crm_private.sheet_lead_receipts r where r.source_id=s.id and r.outcome='created') end,
    'repeat',case when s.id is null then null else
     (select count(*) from crm_private.sheet_lead_receipts r where r.source_id=s.id and r.outcome='existing') end,
    'rejected',case when s.id is null then i.rejected_count else
     (select count(*) from crm_private.sheet_row_rejections j where j.source_id=s.id) end,
    'in_crm',(select count(*) from public.active_leads l where l.import_id=i.id),
    'deleted',(select count(*) from public.leads l where l.import_id=i.id and l.deleted_at is not null)) f
   from public.lead_imports i left join public.sheet_sources s on s.import_id=i.id) x),'[]'::jsonb),
  'no_file',coalesce((select jsonb_object_agg(x.source,x.n) from (select l.source,count(*) n from public.active_leads l
   where l.import_id is null group by 1) x),'{}'::jsonb));
end $$;

-- The matching leads: how many, in which files, and how many calls, notes
-- and assignments they have (the call period, when chosen, limits the
-- calls). With p_ids, their IDs in export order (lead_export_match's), up
-- to 50,000.
create or replace function public.lead_export_ids(p_actor uuid,p_query jsonb,p_ids boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}');v_from timestamptz;v_to timestamptz;result jsonb;
begin
 perform public.accounts_admin(p_actor);
 begin
  v_from=((q->>'calls_from')::date)::timestamp at time zone 'Asia/Karachi';
  v_to=((q->>'calls_to')::date+1)::timestamp at time zone 'Asia/Karachi';
 exception when others then raise exception 'Choose valid export filters' using errcode='22023';
 end;
 with m as (select * from public.lead_export_match(p_query))
 select jsonb_build_object('count',(select count(*) from m),
  'files',coalesce((select jsonb_object_agg(coalesce(x.import_id::text,'none'),x.n) from (select m.import_id,count(*) n from m group by 1) x),'{}'::jsonb),
  'calls',(select count(*) from public.calls c where c.lead_id in (select lead_id from m)
   and (v_from is null or c.started_at>=v_from) and (v_to is null or c.started_at<v_to)),
  'notes',(select count(*) from public.notes n where n.lead_id in (select lead_id from m))
   +(select count(*) from public.followups f where f.lead_id in (select lead_id from m) and length(btrim(coalesce(f.notes,'')))>0)
   +(select count(*) from public.visits v where v.lead_id in (select lead_id from m) and length(btrim(coalesce(v.notes,'')))>0)
   +(select count(*) from public.deals d where d.lead_id in (select lead_id from m) and length(btrim(coalesce(d.notes,'')))>0),
  'assignments',(select count(*) from public.assignments a where a.lead_id in (select lead_id from m)),
  'ids',case when p_ids then coalesce((select jsonb_agg(m.lead_id order by m.file_created nulls last,m.import_id,m.file_row nulls last,m.created_at,m.lead_id) from m),'[]'::jsonb) end)
 into result;
 if p_ids and (result->>'count')::integer>50000 then
  raise exception 'More than 50,000 leads match. Choose fewer files or narrower filters.' using errcode='22023';end if;
 return result;
end $$;

-- ------------------------------------------------------------- the records
-- Up to 500 leads (export order kept), each with what the Lead summary
-- shows. Never the phone number: the server adds it as every lead list
-- does, recorded as viewed. A lead now in Deleted leads is left out, so the
-- server can tell the leads changed meanwhile.
create or replace function public.lead_export_rows(p_actor uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if p_ids is null or cardinality(p_ids) not between 1 and 500 then raise exception 'Choose up to 500 leads' using errcode='22023';end if;
 return coalesce((select jsonb_agg(r.item order by r.ord) from (
  select x.ord,jsonb_build_object('id',l.id,'lead_no',l.lead_no,'name',l.name,'email',l.email,'source',l.source,'status',l.status,
   'lost_reason',l.lost_reason,'created_at',l.created_at,'assigned_at',l.assigned_at,'first_call_at',l.first_call_at,
   'call_due_at',l.call_due_at,'last_activity_at',l.last_activity_at,'ad_name',l.ad_name,
   'agent',public.lead_export_person(l.assigned_agent),
   'file',case when f.id is null then null else jsonb_build_object('id',f.id,'name',coalesce(s.name,f.file_name),'file_name',f.file_name,
    'format',f.file_format,'worksheet',f.worksheet,'legacy',f.legacy,'created_at',f.created_at,
    'spreadsheet_id',s.spreadsheet_id,'sheet_tab',s.worksheet,'row',fr.file_row,'sheet_row',sr.sheet_row) end,
   'ad',case when si.source_id is not null then jsonb_build_object('origin','sheet','platform',si.platform,'organic',si.is_organic,
     'campaign_id',si.campaign_id,'campaign_name',si.campaign_name,'adset_id',si.adset_id,'adset_name',si.adset_name,
     'ad_id',si.ad_id,'ad_name',si.ad_name,'form_id',si.form_id,'form_name',si.form_name,'submitted_at',si.submitted_at)
    when ms.id is not null then jsonb_build_object('origin','meta','platform',ms.platform,
     'campaign_id',ms.campaign_id,'campaign_name',ms.campaign_name,'adset_id',ms.adset_id,'adset_name',ms.adset_name,
     'ad_id',ms.ad_id,'ad_name',ms.ad_name,'form_id',ms.form_id,'form_name',ms.form_name,'submitted_at',ms.submitted_at)
    when l.ad_name is not null then jsonb_build_object('origin','file','ad_name',l.ad_name) end,
   'calls',jsonb_build_object('attempts',cs.attempts,'answered',cs.answered,'interested',coalesce(cs.interested,false),
    'latest_at',lc.started_at,'latest_outcome',lc.outcome,'latest_answered',lc.status='completed'),
   'temperature',public.lead_export_temperature(l.id),
   'comment',cm.c,
   'followup',fu.f,'followups',fu.n,
   'visit',vi.v,'visits',vi.n,
   'deal',dl.d,'deals',dl.n,'won_deals',dl.won) as item
  from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null
  left join public.lead_imports f on f.id=l.import_id
  left join public.sheet_sources s on s.import_id=l.import_id
  left join crm_private.lead_file_rows fr on fr.lead_id=l.id and fr.import_id=l.import_id
  left join lateral (select r.source_id,r.meta_lead_id,r.sheet_row from crm_private.sheet_lead_receipts r
   where r.lead_id=l.id and r.outcome='created' order by r.imported_at,r.source_id limit 1) sr on true
  left join crm_private.sheet_lead_inquiries si on si.source_id=sr.source_id and si.meta_lead_id=sr.meta_lead_id
  left join lateral (select m.*,fm.name form_name from public.meta_submissions m left join public.meta_forms fm on fm.id=m.form_id
   where m.lead_id=l.id and m.status='created' order by m.received_at,m.id limit 1) ms on true
  left join lateral (select count(*) attempts,count(*) filter(where c.status='completed') answered,
   bool_or(c.outcome in ('Interested','Site visit scheduled','Deal discussion')) interested from public.calls c where c.lead_id=l.id) cs on true
  left join lateral (select c.started_at,c.outcome,c.status from public.calls c where c.lead_id=l.id
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  -- The latest comment: a lead note or a call's notes.
  left join lateral (select jsonb_build_object('text',y.body,'at',y.noted_at,'by',public.lead_export_author(y.entity,y.id,y.filed)) c from (
    select 'notes' as entity,n.id,n.body,n.created_at as noted_at,n.agent_id as filed from public.notes n where n.lead_id=l.id
    union all
    select 'calls',c.id,c.notes,c.started_at,c.agent_id from public.calls c where c.lead_id=l.id and length(btrim(coalesce(c.notes,'')))>0
   ) y order by y.noted_at desc,y.id desc limit 1) cm on true
  -- The next pending follow-up, else the latest one.
  left join lateral (select (select jsonb_build_object('status',f.status,'due_at',f.due_at,'completed_at',f.completed_at)
    from public.followups f where f.lead_id=l.id order by (f.status='pending') desc,case when f.status='pending' then f.due_at end,f.updated_at desc,f.id limit 1) f,
   (select count(*) from public.followups f where f.lead_id=l.id) n) fu on true
  left join lateral (select (select jsonb_build_object('status',v.status,'scheduled_at',v.scheduled_at) from public.visits v
    where v.lead_id=l.id order by v.scheduled_at desc,v.id desc limit 1) v,
   (select count(*) from public.visits v where v.lead_id=l.id and v.status in ('scheduled','completed')) n) vi on true
  left join lateral (select (select jsonb_build_object('stage',d.stage,'value',d.expected_value,'close_date',d.close_date) from public.deals d
    where d.lead_id=l.id order by d.updated_at desc,d.id desc limit 1) d,
   (select count(*) from public.deals d where d.lead_id=l.id) n,(select count(*) from public.deals d where d.lead_id=l.id and d.stage='won') won) dl on true
 ) r),'[]'::jsonb);
end $$;

-- Every call on up to 500 leads (in the call period, when chosen), oldest
-- first: who recorded it, whose lead it was filed under, whether it was
-- answered, as recorded.
create or replace function public.lead_export_calls(p_actor uuid,p_ids uuid[],p_from date default null,p_to date default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_from timestamptz=p_from::timestamp at time zone 'Asia/Karachi';v_to timestamptz=(p_to+1)::timestamp at time zone 'Asia/Karachi';
begin
 perform public.accounts_admin(p_actor);
 if p_ids is null or cardinality(p_ids) not between 1 and 500 then raise exception 'Choose up to 500 leads' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('lead_id',l.id,'lead_no',l.lead_no,'started_at',c.started_at,'ended_at',c.ended_at,
   'status',c.status,'answered',c.status='completed','method',c.method,'duration_seconds',c.duration_seconds,'outcome',c.outcome,
   'missing_outcome',c.missing_outcome,'notes',c.notes,
   'temperature',(select case t.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' else 'cold' end from unnest(c.deal_tags) t(tag)
    where t.tag in ('Hot lead','Warm lead','Cold lead') limit 1),
   'tags',to_jsonb(c.deal_tags),'by',public.lead_export_author('calls',c.id,c.agent_id),'filed_under',public.lead_export_person(c.agent_id))
   order by x.ord,c.started_at,c.created_at,c.id)
  from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.calls c on c.lead_id=l.id
  where (v_from is null or c.started_at>=v_from) and (v_to is null or c.started_at<v_to)),'[]'::jsonb);
end $$;

-- Every note and comment on up to 500 leads, oldest first: lead notes, and
-- the notes of follow-ups, site visits and deals (calls' notes are with the
-- calls).
create or replace function public.lead_export_notes(p_actor uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if p_ids is null or cardinality(p_ids) not between 1 and 500 then raise exception 'Choose up to 500 leads' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('lead_id',y.lead_id,'lead_no',y.lead_no,'kind',y.kind,'at',y.noted_at,'text',y.body,
   'about',y.about,'by',public.lead_export_author(y.entity,y.id,y.filed)) order by y.ord,y.noted_at,y.id) from (
  select x.ord,l.id as lead_id,l.lead_no,'note' as kind,'notes' as entity,n.id,n.created_at as noted_at,n.body,null::jsonb as about,n.agent_id as filed
   from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.notes n on n.lead_id=l.id
  union all
  select x.ord,l.id,l.lead_no,'followup','followups',f.id,f.created_at,f.notes,jsonb_build_object('status',f.status,'due_at',f.due_at),f.agent_id
   from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.followups f on f.lead_id=l.id
   where length(btrim(coalesce(f.notes,'')))>0
  union all
  select x.ord,l.id,l.lead_no,'visit','visits',v.id,v.created_at,v.notes,jsonb_build_object('status',v.status,'scheduled_at',v.scheduled_at),v.agent_id
   from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.visits v on v.lead_id=l.id
   where length(btrim(coalesce(v.notes,'')))>0
  union all
  select x.ord,l.id,l.lead_no,'deal','deals',d.id,d.created_at,d.notes,jsonb_build_object('stage',d.stage),d.agent_id
   from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.deals d on d.lead_id=l.id
   where length(btrim(coalesce(d.notes,'')))>0) y),'[]'::jsonb);
end $$;

-- Every assignment of up to 500 leads, oldest first: from whom (the agent
-- of the assignment before), to whom (none: back with the administrators),
-- by whom, and its first-call deadline and first call.
create or replace function public.lead_export_assignments(p_actor uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if p_ids is null or cardinality(p_ids) not between 1 and 500 then raise exception 'Choose up to 500 leads' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('lead_id',y.lead_id,'lead_no',y.lead_no,'at',y.created_at,
   'from',public.lead_export_person(y.before_agent),'to',public.lead_export_person(y.agent_id),'by',public.lead_export_person(y.actor_id),
   'reason',y.reason,'call_due_at',y.call_due_at,'first_call_at',y.first_call_at,'missed_at',y.missed_at) order by y.ord,y.created_at,y.id) from (
  select x.ord,l.id as lead_id,l.lead_no,a.id,a.agent_id,a.actor_id,a.created_at,a.reason,a.call_due_at,a.first_call_at,a.missed_at,
   lag(a.agent_id) over(partition by a.lead_id order by a.created_at,a.id) as before_agent
  from unnest(p_ids) with ordinality x(id,ord) join public.leads l on l.id=x.id and l.deleted_at is null join public.assignments a on a.lead_id=l.id) y),'[]'::jsonb);
end $$;

-- Only the CRM's server calls the export functions; the helpers only from
-- them. The export functions are volatile (the default): the database API
-- runs stable functions read-only, and accounts_admin locks the
-- administrator's row.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('lead_export_temperature','lead_export_author','lead_export_person','lead_export_match','lead_export_sources',
   'lead_export_ids','lead_export_rows','lead_export_calls','lead_export_notes','lead_export_assignments') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname in ('lead_export_sources','lead_export_ids','lead_export_rows','lead_export_calls','lead_export_notes','lead_export_assignments') then
   execute format('grant execute on function %s to service_role',fn.signature);
  else
   execute format('revoke all on function %s from service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
