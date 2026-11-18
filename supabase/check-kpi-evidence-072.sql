-- Read-only check for update 072 (Daily KPIs filled in by the CRM, KPI
-- evidence and listing verification). Run it in the CRM's Supabase SQL
-- Editor before 072 and right after it. It is one SELECT: it changes
-- nothing, reads function definitions and returns flags and counts only,
-- never a customer's or an owner's details.
-- Before 072: release_stage = 'at 071, ready for 072', edits_ready = 7,
-- edits_unexpected = 0, kpis_found = 5 and transactions_open_over_1_min = 0.
-- kpis_found below 5 means an administrator reworded one of the first five
-- KPIs: 072 leaves that one self-reported. answers_this_period says which
-- KPIs switch at once (none answered under their current rules) and which
-- from tomorrow or next Monday.
-- After 072: release_stage = 'at 072', edits_applied = 7, kpis_measured =
-- kpis_found, kpi_evidence = 0, evidence_bucket_private = true, and
-- measured_from lists when each KPI's CRM rules start.
-- agent_listings is what Daily KPIs -> Reviews -> Inventory starts with:
-- every agent's listing, none verified yet.
with edits(signature,old_text,new_text) as (values
  -- Rules as the pages read them, with how the KPI is measured.
  ('public.kpi_version_json(kpi_versions)',
   $t$'answer_type',v.answer_type,'target',v.target,'active',v.active,'agent_ids',to_jsonb(v.agent_ids))$t$,
   $t$'answer_type',v.answer_type,'target',v.target,'active',v.active,'agent_ids',to_jsonb(v.agent_ids),'measure',v.measure)$t$),
  -- New rules keep how the KPI is measured; a KPI the CRM fills in keeps
  -- its frequency and answer type.
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids) then$t$,
   $t$ -- Update 072: how a KPI is measured is part of its rules, and a KPI the
 -- CRM fills in keeps its frequency and answer type.
 if latest.measure<>'self' and (nxt.frequency,nxt.answer_type) is distinct from (latest.frequency,latest.answer_type) then
  raise exception 'This KPI is filled in by the CRM: its frequency and answer type stay as they are' using errcode='22023';end if;
 if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (cur.frequency,cur.answer_type,cur.target,cur.active,cur.agent_ids,cur.measure) then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids) and latest.effective_from>p_today then$t$,
   $t$ if (nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,nxt.measure) is not distinct from
    (latest.frequency,latest.answer_type,latest.target,latest.active,latest.agent_ids,latest.measure) and latest.effective_from>p_today then$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$  update public.kpi_versions set answer_type=nxt.answer_type,target=nxt.target,active=nxt.active,agent_ids=nxt.agent_ids,$t$,
   $t$  update public.kpi_versions set answer_type=nxt.answer_type,target=nxt.target,active=nxt.active,agent_ids=nxt.agent_ids,measure=nxt.measure,$t$),
  ('public.kpi_apply_rules(uuid,jsonb,uuid,date)',
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor);$t$,
   $t$ insert into public.kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,active,agent_ids,created_by,measure)
  values(p_kpi,(select max(version)+1 from public.kpi_versions where kpi_id=p_kpi),start,
   nxt.frequency,nxt.answer_type,nxt.target,nxt.active,nxt.agent_ids,p_actor,nxt.measure);$t$),
  -- A KPI the CRM fills in is not answered by the agent.
  ('public.kpi_submit(uuid,date,jsonb,text,timestamp with time zone)',
   $t$  if v.frequency='day' and p_day<>today then
   raise exception 'Daily KPIs can only be answered on the day' using errcode='22023';end if;$t$,
   $t$  if v.frequency='day' and p_day<>today then
   raise exception 'Daily KPIs can only be answered on the day' using errcode='22023';end if;
  -- Update 072: the CRM fills these in.
  if v.measure<>'self' then
   raise exception '% is filled in by the CRM, not answered',k.title using errcode='22023';end if;$t$),
  -- The facts include what the CRM measures.
  ('public.kpi_facts(uuid,date,date,uuid,timestamp with time zone)',
   $t$   'answers',coalesce((select jsonb_agg(jsonb_build_object('kpi_id',s.kpi_id,'agent_id',s.agent_id,'day',s.activity_date,'version',s.version,$t$,
   $t$   -- Update 072: what the CRM measures, per agent and day.
   'measures',public.kpi_measures(span_from,span_to,p_agent,p_now),
   'answers',coalesce((select jsonb_agg(jsonb_build_object('kpi_id',s.kpi_id,'agent_id',s.agent_id,'day',s.activity_date,'version',s.version,$t$)
), defs as (
 select e.*,case when to_regprocedure(e.signature) is null then null else pg_get_functiondef(to_regprocedure(e.signature)) end body from edits e
), states as (
 select case when body is null then 'missing'
  when position(new_text in body)>0 then 'applied'
  when (length(body)-length(replace(body,old_text,'')))/length(old_text)=1 then 'ready'
  else 'unexpected' end state from defs
), first_five(old_question,new_question,weekly) as (values
 ('Did you answer your assigned calls today?','Did you answer your assigned calls today?',false),
 ('Did you complete your social media activity today?','Did you complete your social media activity today?',false),
 ('How many project visits did you complete today?','How many project visits did you complete?',true),
 ('How many verified property inventories with owner details did you complete today?','How many verified property inventories with owner details did you complete today?',false),
 ('How many videos did you complete for the HD Marketing page today?','How many videos did you complete for the HD Marketing page?',true)
), found as (
 select k.id,k.title,f.weekly from public.kpis k join first_five f on k.question in (f.old_question,f.new_question) where k.archived_at is null
), measured as (
 -- Read through query_to_xml, so the check also runs before 072.
 select (xpath('/row/v/text()',query_to_xml(case when exists(select 1 from information_schema.columns
   where table_schema='public' and table_name='kpi_versions' and column_name='measure')
  then 'select count(distinct kpi_id)||''|''||coalesce(string_agg(measure||'' from ''||effective_from,'', '' order by measure),'''') v from public.kpi_versions where measure<>''self'''
  else 'select ''0|'' v' end,false,true,'')))[1]::text v
)
select
 case
  when to_regclass('public.kpi_evidence') is not null
   and (select count(*) from states where state='applied')=(select count(*) from edits) then 'at 072'
  when to_regprocedure('public.erase_deleted_leads_preview(uuid,uuid[])') is not null
   and (select count(*) from states where state='ready')=(select count(*) from edits) then 'at 071, ready for 072'
  else 'NOT READY: see edits_unexpected; apply CRM updates up to 071 exactly'
 end as release_stage,
 (select count(*) from states where state='ready') as edits_ready,
 (select count(*) from states where state='applied') as edits_applied,
 (select count(*) from states where state in ('unexpected','missing')) as edits_unexpected,
 (select count(*) from found) as kpis_found,
 split_part((select v from measured),'|',1)::int as kpis_measured,
 nullif(split_part((select v from measured),'|',2),'') as measured_from,
 (select coalesce(string_agg(f.title||': '||(select count(*) from public.kpi_submissions s where s.kpi_id=f.id
   and s.activity_date>=case when f.weekly then date_trunc('week',(now() at time zone 'Asia/Karachi')::date)::date
    else (now() at time zone 'Asia/Karachi')::date end),', ' order by f.title),'') from found f) as answers_this_period,
 (select count(*) from public.properties where owner_agent_id is not null) as agent_listings,
 (select count(*) from public.properties p where p.owner_agent_id is not null and exists(select 1 from public.property_owner_contacts c
   where c.property_id=p.id and length(btrim(coalesce(c.owner_name,'')))>0 and length(btrim(coalesce(c.owner_phone,'')))>0)) as agent_listings_with_owner_details,
 (xpath('/row/n/text()',query_to_xml(case when to_regclass('public.kpi_evidence') is null then 'select 0 n'
   else 'select count(*) n from public.kpi_evidence' end,false,true,'')))[1]::text::int as kpi_evidence,
 (select not public from storage.buckets where id='kpi-evidence') as evidence_bucket_private,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
