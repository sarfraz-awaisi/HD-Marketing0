-- Update 068: each lead keeps the name of the advertisement it came from,
-- shown with the lead in every lead list. Apply after 067. Safe to rerun.
--
-- Until now the advertisement's name was kept only with a Google Sheet
-- inquiry (update 056), shown on the lead's page, and a CSV or Excel file's
-- ad name column could only be skipped. Now the lead has its own ad_name:
--
-- * A CSV or Excel file's ad name column fills it (the server matches the
--   column, as it does name and phone).
-- * A Google Sheet fills it when it creates the lead, and fills a lead that
--   has none yet when the customer inquires again. A lead keeps the first
--   advertisement it is given; later inquiries from other advertisements
--   show on the lead's page, as before.
-- * Leads already imported from a Google Sheet take their first inquiry's
--   advertisement once, below. Nothing else changes for them.
--
-- The lists send it: agents' Assigned leads and Lead pipeline
-- (agent_lead_list), administrators' All leads (admin_lead_list) and an
-- agent's pipeline (admin_agent_pipeline). It is something the customer
-- answered, like the budget, so a lead's new agent sees it too (update 067).
-- Only the CRM's server reads or changes the leads table; no one can edit
-- the advertisement afterwards. Checked edits: create_lead_031,
-- sheet_sync_import and the three lists.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.create_lead_031(jsonb,text,uuid,text)') is null
  or to_regprocedure('public.sheet_sync_import(text,uuid,jsonb,text)') is null
  or to_regprocedure('public.agent_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.admin_agent_pipeline(uuid,uuid,jsonb)') is null
  or position('followup.reassignment_cancelled' in pg_get_functiondef('public.handover_lead(uuid,uuid,uuid,text)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 067 before update 068.';
 end if;
end $$;

-- Empty is stored as none. No default, so the column is added without
-- rewriting the table.
alter table public.leads add column if not exists ad_name text check(length(ad_name) between 1 and 500);

-- Small, checked edits, as in updates 061 to 067: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- A new lead takes the advertisement it was given, trimmed; blank is none.
  ('public.create_lead_031(jsonb,text,uuid,text)',
   $t$budget_max,preferred_location) values($t$,
   $t$budget_max,preferred_location,ad_name) values($t$),
  ('public.create_lead_031(jsonb,text,uuid,text)',
   $t$,p_data->>'preferred_location') returning * into result;$t$,
   $t$,p_data->>'preferred_location',nullif(btrim(left(p_data->>'ad_name',500)),'')) returning * into result;$t$),
  -- A Google Sheet gives a new lead the inquiry's advertisement...
  ('public.sheet_sync_import(text,uuid,jsonb,text)',
   $t$'source','Meta'),r->>'phone',v_owner,$t$,
   $t$'source','Meta','ad_name',r#>>'{inquiry,ad_name}'),r->>'phone',v_owner,$t$),
  -- ...and a lead it already had, when that lead has none yet.
  ('public.sheet_sync_import(text,uuid,jsonb,text)',
   $t$       v_status='existing';
$t$,
   $t$       v_status='existing';
       -- Update 068: the first advertisement a lead is given stays.
       update public.leads set ad_name=nullif(btrim(left(r#>>'{inquiry,ad_name}',500)),'')
        where id=v_lead and ad_name is null and nullif(btrim(left(r#>>'{inquiry,ad_name}',500)),'') is not null;
$t$),
  -- The lists.
  ('public.agent_lead_list(uuid,jsonb)',
   $t$'status',o.ws_status,'source',o.source,$t$,
   $t$'status',o.ws_status,'source',o.source,'ad_name',o.ad_name,$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$'status',s.status,'source',s.source,$t$,
   $t$'status',s.status,'source',s.source,'ad_name',s.ad_name,$t$),
  ('public.admin_agent_pipeline(uuid,uuid,jsonb)',
   $t$l.status,l.source,l.created_at,$t$,
   $t$l.status,l.source,l.ad_name,l.created_at,$t$),
  ('public.admin_agent_pipeline(uuid,uuid,jsonb)',
   $t$'status',o.status,'source',o.source,$t$,
   $t$'status',o.status,'source',o.source,'ad_name',o.ad_name,$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 068 found an unexpected version of %: apply CRM updates up to 067 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- Leads already imported from a Google Sheet: their first inquiry that
-- names an advertisement. Only leads without one; a rerun finds none.
update public.leads l set ad_name=x.ad_name
from (select distinct on (i.lead_id) i.lead_id,nullif(btrim(left(i.ad_name,500)),'') ad_name
  from crm_private.sheet_lead_inquiries i
  join crm_private.sheet_lead_receipts r on r.source_id=i.source_id and r.meta_lead_id=i.meta_lead_id
  where nullif(btrim(left(i.ad_name,500)),'') is not null
  order by i.lead_id,i.submitted_at nulls last,r.imported_at,i.meta_lead_id) x
where x.lead_id=l.id and l.ad_name is null;
commit;
