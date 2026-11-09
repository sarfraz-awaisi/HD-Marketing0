-- Update 056: automatic lead import from Google Sheets. Meta Lead Ads write
-- each advertisement's submissions to a Sheet; a Google Apps Script sends the
-- rows to the CRM with a dedicated integration key. Apply after 055. Safe to
-- rerun. It adds tables and functions and one more lead-file type ("sheets");
-- no existing row or function changes.
--
-- * sheet_sources: the Sheets administrators configure, one tab of one
--   spreadsheet each. A Sheet keeps one CRM lead file (lead_imports) for good:
--   the file is created on the Sheet's first import and never replaced
--   automatically, whatever the Sheet, tab or campaign is called later.
-- * crm_private.sheet_lead_receipts: every Meta lead ID imported from a Sheet,
--   unique per Sheet. It is how the CRM knows a row is imported, so a retry,
--   an overlapping run or a reordered Sheet never imports it twice. It holds
--   no customer details and outlives the lead, so a lead deleted for good is
--   never imported again.
-- * crm_private.sheet_lead_inquiries: what the customer submitted (the
--   advertisement, campaign, interest, budget and every column except the
--   phone number), shown on the lead. Erased with the lead.
-- * crm_private.sheet_row_rejections: rows that could not be imported, with a
--   reason and no customer details, until the row is fixed or removed.
-- * crm_private.sheet_sync_keys: the integration key as a SHA-256 hash, one
--   active key at a time. Leads are created as the administrator who created
--   the key; a request can never choose who it acts as.
--
-- A number that already belongs to a lead is not a new lead: the submission
-- is kept as a repeat inquiry on that lead, as Meta Lead Ads does, and the
-- lead (name, agent, calls, notes, follow-ups, status) is not changed; its
-- agent gets one notification (ad_inquiry) per lead and day. A number in
-- Deleted leads is rejected until the lead is restored. Nothing is assigned
-- automatically, and every Sheet starts turned off. Rows submitted before a
-- Sheet was added (its historical import) are imported only after an
-- administrator confirms it when turning the Sheet on.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.agent_pipeline_attribution(uuid,uuid[])') is null or to_regprocedure('public.create_lead(jsonb,text,uuid,text)') is null
  or to_regprocedure('public.accounts_admin(uuid)') is null or to_regclass('crm_private.lead_file_rows') is null then
  raise exception 'Apply CRM updates up to 055 before update 056.';
 end if;
end $$;

-- ------------------------------------------------------------ tables
-- Lead files may now come from a Google Sheet.
alter table public.lead_imports drop constraint if exists lead_imports_file_format_check,
 add constraint lead_imports_file_format_check check(file_format in ('csv','xlsx','xls','legacy','sheets'));

-- An agent is told when a customer of theirs sends another advertisement
-- inquiry (the list as in update 048, plus ad_inquiry).
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in ('lead_assigned','lead_moved_away','lead_kept','first_call_missed',
 'missed_calls_review','calls_due_soon','daily_call_summary','followup_due','visit_tomorrow',
 'attendance_request','attendance_review','attendance_incomplete','attendance_summary',
 'property_source_updated','property_source_removed',
 'task_assigned','task_updated','task_cancelled','task_report','task_report_reviewed','checkout_request','checkout_decision',
 'shift_changed','ad_inquiry'));

create table if not exists public.sheet_sources(
 id uuid primary key default gen_random_uuid(),
 name text not null check(name=btrim(name) and length(name) between 1 and 200),
 spreadsheet_id text not null check(spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
 worksheet text not null check(worksheet=btrim(worksheet) and length(worksheet) between 1 and 100),
 -- Rows submitted before this are left out; empty imports every row.
 import_from timestamptz,
 enabled boolean not null default false,
 import_id uuid unique references public.lead_imports(id),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_by uuid references public.profiles(id),
 updated_at timestamptz not null default now(),
 -- The historical import (rows submitted before the Sheet was added) needs an
 -- administrator's confirmation, which covers this start date or a later
 -- one (history_confirmed_from null: every row).
 history_confirmed_at timestamptz,
 history_confirmed_by uuid references public.profiles(id),
 history_confirmed_from timestamptz,
 -- Reported by the CRM and the script: the last complete pass over the Sheet,
 -- the last check, the last new lead or repeat inquiry, and the latest error.
 last_sync_at timestamptz,
 last_check_at timestamptz,
 last_import_at timestamptz,
 last_error_code text check(last_error_code in ('spreadsheet_unavailable','worksheet_missing','headers_missing','read_failed','rows_failed','too_many_rows','file_deleted')),
 last_error_at timestamptz,
 sheet_rows integer check(sheet_rows>=0),
 check((history_confirmed_at is null)=(history_confirmed_by is null)));
create unique index if not exists sheet_sources_tab on public.sheet_sources(spreadsheet_id,lower(worksheet));

create table if not exists crm_private.sheet_lead_receipts(
 source_id uuid not null references public.sheet_sources(id),
 meta_lead_id text not null check(meta_lead_id ~ '^[0-9]{1,40}$'),
 -- created: a new lead in the Sheet's file; existing: a repeat inquiry on a
 -- lead the number already belonged to.
 outcome text not null check(outcome in ('created','existing')),
 lead_id uuid references public.leads(id) on delete set null,
 import_id uuid references public.lead_imports(id),
 sheet_row integer not null check(sheet_row>1),
 imported_at timestamptz not null default now(),
 primary key(source_id,meta_lead_id));
create index if not exists sheet_lead_receipts_lead on crm_private.sheet_lead_receipts(lead_id);
create index if not exists sheet_lead_receipts_file on crm_private.sheet_lead_receipts(import_id,outcome);

create table if not exists crm_private.sheet_lead_inquiries(
 source_id uuid not null,
 meta_lead_id text not null,
 lead_id uuid not null references public.leads(id) on delete cascade,
 submitted_at timestamptz,
 platform text check(platform in ('facebook','instagram','messenger','audience_network','other')),
 is_organic boolean,
 ad_id text check(length(ad_id)<=100),
 ad_name text check(length(ad_name)<=500),
 adset_id text check(length(adset_id)<=100),
 adset_name text check(length(adset_name)<=500),
 campaign_id text check(length(campaign_id)<=100),
 campaign_name text check(length(campaign_name)<=500),
 form_id text check(length(form_id)<=100),
 form_name text check(length(form_name)<=500),
 full_name text check(length(full_name)<=200),
 email text check(length(email)<=320),
 city text check(length(city)<=500),
 interest text check(length(interest)<=1000),
 budget text check(length(budget)<=1000),
 meta_lead_status text check(length(meta_lead_status)<=100),
 -- Every column as the Sheet had it, except the phone number (kept only as
 -- the lead's protected number); extra: the columns the CRM does not map.
 answers jsonb not null default '{}' check(jsonb_typeof(answers)='object' and length(answers::text)<=100000),
 extra jsonb not null default '{}' check(jsonb_typeof(extra)='object'),
 primary key(source_id,meta_lead_id),
 foreign key(source_id,meta_lead_id) references crm_private.sheet_lead_receipts(source_id,meta_lead_id));
create index if not exists sheet_lead_inquiries_lead on crm_private.sheet_lead_inquiries(lead_id,submitted_at desc);

create table if not exists crm_private.sheet_row_rejections(
 source_id uuid not null references public.sheet_sources(id),
 sheet_row integer not null check(sheet_row>1),
 meta_lead_id text check(meta_lead_id ~ '^[0-9]{1,40}$'),
 reason text not null check(reason in ('id_invalid','phone_invalid','name_missing','name_too_long','date_missing','lead_deleted','value_too_long')),
 lead_no bigint,
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 primary key(source_id,sheet_row));
create index if not exists sheet_row_rejections_lead_id on crm_private.sheet_row_rejections(source_id,meta_lead_id);

create table if not exists crm_private.sheet_sync_keys(
 id uuid primary key default gen_random_uuid(),
 key_hash text not null unique check(key_hash ~ '^[a-f0-9]{64}$'),
 hint text not null check(hint ~ '^[A-Za-z0-9_-]{4}$'),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),
 last_used_at timestamptz,
 revoked_at timestamptz,
 revoked_by uuid references public.profiles(id));
create unique index if not exists sheet_sync_keys_one_active on crm_private.sheet_sync_keys((true)) where revoked_at is null;

alter table public.sheet_sources enable row level security;
alter table crm_private.sheet_lead_receipts enable row level security;
alter table crm_private.sheet_lead_inquiries enable row level security;
alter table crm_private.sheet_row_rejections enable row level security;
alter table crm_private.sheet_sync_keys enable row level security;
revoke all on public.sheet_sources,crm_private.sheet_lead_receipts,crm_private.sheet_lead_inquiries,
 crm_private.sheet_row_rejections,crm_private.sheet_sync_keys from public,anon,authenticated;
grant all on public.sheet_sources to service_role;

-- ------------------------------------------------------------ helpers
-- The administrator an integration key acts as. HS401: no such active key;
-- HS403: the administrator who created it is no longer an active admin.
create or replace function public.sheet_sync_owner(p_key_hash text) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid;
begin
 select k.created_by into v_owner from crm_private.sheet_sync_keys k where k.key_hash=p_key_hash and k.revoked_at is null;
 if v_owner is null then raise exception 'Invalid integration key' using errcode='HS401';end if;
 perform 1 from public.profiles p where p.id=v_owner and p.role='admin' and p.active for share;
 if not found then raise exception 'The administrator who created the integration key is no longer active' using errcode='HS403';end if;
 return v_owner;
end $$;

-- Whether a Sheet would import rows submitted before it was added (no start
-- date, or one before the Sheet was added) without a confirmation covering
-- that start date.
create or replace function public.sheet_history_pending(p_from timestamptz,p_added timestamptz,p_confirmed_at timestamptz,p_confirmed_from timestamptz)
returns boolean language sql immutable set search_path='' as $$
 select (p_from is null or p_from<p_added)
  and not (p_confirmed_at is not null and (p_confirmed_from is null or (p_from is not null and p_from>=p_confirmed_from)))
$$;

-- A lead file's counts: the leads the Sheet created in it and the rows that
-- could not be imported now (repeat inquiries belong to other leads' files).
create or replace function public.sheet_file_counts(p_source uuid,p_import uuid) returns void language plpgsql volatile security definer set search_path='' as $$
declare v_imported integer;v_rejected integer;
begin
 if p_import is null then return;end if;
 select count(*)::integer into v_imported from crm_private.sheet_lead_receipts r where r.import_id=p_import and r.outcome='created';
 select count(*)::integer into v_rejected from crm_private.sheet_row_rejections j where j.source_id=p_source;
 update public.lead_imports set imported_count=v_imported,rejected_count=v_rejected,total_rows=v_imported+v_rejected
  where id=p_import and deleted_at is null and file_format='sheets';
end $$;

-- ------------------------------------------------------------ the script's calls
-- Every call names the key's hash; the server has already checked the key's
-- format and its rate limits.
create or replace function public.sheet_sync_auth(p_key_hash text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_key uuid;
begin
 perform public.sheet_sync_owner(p_key_hash);
 update crm_private.sheet_sync_keys set last_used_at=now() where key_hash=p_key_hash and revoked_at is null
  and (last_used_at is null or last_used_at<now()-interval '1 minute');
 select id into v_key from crm_private.sheet_sync_keys where key_hash=p_key_hash and revoked_at is null;
 return jsonb_build_object('key',v_key);
end $$;

-- The Sheets turned on, for the script to read, and the CRM's clock (a pass
-- over a Sheet starts then).
create or replace function public.sheet_sync_sources(p_key_hash text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.sheet_sync_owner(p_key_hash);
 return jsonb_build_object('now',now(),'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,
  'spreadsheet_id',s.spreadsheet_id,'worksheet',s.worksheet,'import_from',s.import_from) order by s.created_at,s.id)
  from public.sheet_sources s where s.enabled
   and not public.sheet_history_pending(s.import_from,s.created_at,s.history_confirmed_at,s.history_confirmed_from)),'[]'));
end $$;

-- Which of a Sheet's Meta lead IDs the CRM has not imported (their positions
-- in p_ids, from 1). An ID the server could not read is null and always
-- pending, so its row is sent and rejected with a reason.
create or replace function public.sheet_sync_pending(p_key_hash text,p_source uuid,p_ids text[]) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.sheet_sync_owner(p_key_hash);
 if p_ids is null or cardinality(p_ids)>10000 then raise exception 'Send up to 10,000 lead IDs' using errcode='22023';end if;
 perform 1 from public.sheet_sources s where s.id=p_source and s.enabled
  and not public.sheet_history_pending(s.import_from,s.created_at,s.history_confirmed_at,s.history_confirmed_from);
 if not found then raise exception 'This Sheet is turned off or not configured in the CRM' using errcode='HS409';end if;
 return jsonb_build_object('pending',coalesce((select jsonb_agg(u.n order by u.n) from unnest(p_ids) with ordinality u(i,n)
  where u.i is null or u.i!~'^[0-9]{1,40}$'
   or not exists(select 1 from crm_private.sheet_lead_receipts r where r.source_id=p_source and r.meta_lead_id=u.i)),'[]'));
end $$;

-- Imports up to 100 rows the server has read and checked, in one transaction:
-- the CRM has the rows it reports as imported once this returns, and none of
-- them otherwise. Each row is one of
--  inserted   a new lead in the Sheet's file
--  existing   the number already belongs to a lead: a repeat inquiry on it
--  duplicate  already imported from this Sheet (the same Meta lead ID)
--  skipped    submitted before the Sheet's start date
--  rejected   cannot be imported as it is (reason); sent again on later
--             runs, so fixing the row in the Sheet imports it
--  failed     an unexpected error; nothing was saved for it, sent again
create or replace function public.sheet_sync_import(p_key_hash text,p_source uuid,p_rows jsonb,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_owner uuid;s public.sheet_sources;f public.lead_imports;r jsonb;v_row integer;v_meta text;v_status text;v_reason text;v_no bigint;
 v_submitted timestamptz;v_lead uuid;v_lead_no bigint;v_deleted timestamptz;v_agent uuid;v_lead_name text;v_created public.leads;v_new_file boolean=false;
 v_results jsonb='[]';v_counts jsonb;v_inserted integer=0;v_existing integer=0;v_duplicate integer=0;v_skipped integer=0;v_rejected integer=0;v_failed integer=0;
begin
 -- The CRM's lead lock first, as create_lead and the file functions take it.
 perform pg_advisory_xact_lock(873420);
 v_owner=public.sheet_sync_owner(p_key_hash);
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 100
  or p_request is null or length(p_request) not between 1 and 100 then
  raise exception 'Send 1 to 100 rows' using errcode='22023';
 end if;
 if (select count(distinct x->>'row') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'Each row may be sent once' using errcode='22023';
 end if;
 select * into s from public.sheet_sources where id=p_source for update;
 if not found or not s.enabled or public.sheet_history_pending(s.import_from,s.created_at,s.history_confirmed_at,s.history_confirmed_from) then
  raise exception 'This Sheet is turned off or not configured in the CRM' using errcode='HS409';
 end if;
 if s.import_id is not null then
  select * into f from public.lead_imports where id=s.import_id for update;
  -- Never a second file on its own: an administrator chooses Start a new
  -- lead file (sheet_source_new_file) or restores this one.
  if f.deleted_at is not null then
   update public.sheet_sources set last_error_code='file_deleted',last_error_at=now() where id=p_source;
   return jsonb_build_object('blocked','file_deleted');
  end if;
 else
  insert into public.lead_imports(file_name,file_format,worksheet,total_rows,created_by)
   values(s.name,'sheets',s.worksheet,0,v_owner) returning * into f;
  update public.sheet_sources set import_id=f.id where id=p_source;
  v_new_file=true;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(v_owner,'sheets.file_created','lead_imports',f.id::text,p_request,jsonb_build_object('source_id',p_source,'source_name',s.name));
 end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(r) is distinct from 'object' or coalesce(r->>'row','')!~'^[0-9]{1,7}$' or (r->>'row')::integer<2
   or (r ? 'meta_lead_id' and jsonb_typeof(r->'meta_lead_id')<>'null' and coalesce(r->>'meta_lead_id','')!~'^[0-9]{1,40}$') then
   raise exception 'Invalid row' using errcode='22023';
  end if;
  v_row=(r->>'row')::integer;v_meta=r->>'meta_lead_id';v_status=null;v_reason=null;v_no=null;
  if r ? 'error' then
   if r->>'error' not in ('id_invalid','phone_invalid','name_missing','name_too_long','date_missing','value_too_long') then
    raise exception 'Invalid rejection reason' using errcode='22023';
   end if;
   v_status='rejected';v_reason=r->>'error';
  elsif v_meta is null or jsonb_typeof(r->'lead') is distinct from 'object' or jsonb_typeof(r->'inquiry') is distinct from 'object'
   or coalesce(r->>'phone','')!~'^\+[1-9][0-9]{9,14}$' or length(btrim(coalesce(r#>>'{lead,name}',''))) not between 1 and 200 then
   raise exception 'Invalid row' using errcode='22023';
  elsif exists(select 1 from crm_private.sheet_lead_receipts x where x.source_id=p_source and x.meta_lead_id=v_meta) then
   v_status='duplicate';
  else
   v_submitted=nullif(r#>>'{inquiry,submitted_at}','')::timestamptz;
   if s.import_from is not null and v_submitted is null then v_status='rejected';v_reason='date_missing';
   elsif s.import_from is not null and v_submitted<s.import_from then v_status='skipped';
   else
    begin
     v_lead=null;v_lead_no=null;v_deleted=null;v_agent=null;v_lead_name=null;
     select l.id,l.lead_no,l.deleted_at,l.assigned_agent,l.name into v_lead,v_lead_no,v_deleted,v_agent,v_lead_name
      from crm_private.lead_phones p join public.leads l on l.id=p.lead_id where p.phone=r->>'phone';
     if v_lead is not null and v_deleted is not null then
      v_status='rejected';v_reason='lead_deleted';v_no=v_lead_no;
     else
      if v_lead is null then
       v_created=public.create_lead(jsonb_build_object('name',btrim(r#>>'{lead,name}'),'email',nullif(r#>>'{lead,email}',''),
        'preferred_location',nullif(r#>>'{lead,preferred_location}',''),'source','Meta'),r->>'phone',v_owner,'sheets:'||v_meta);
       update public.leads set import_id=f.id where id=v_created.id;
       v_lead=v_created.id;v_status='inserted';
      else
       v_status='existing';
      end if;
      insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,import_id,sheet_row)
       values(p_source,v_meta,case v_status when 'inserted' then 'created' else 'existing' end,v_lead,f.id,v_row);
      insert into crm_private.sheet_lead_inquiries(source_id,meta_lead_id,lead_id,submitted_at,platform,is_organic,ad_id,ad_name,adset_id,adset_name,
        campaign_id,campaign_name,form_id,form_name,full_name,email,city,interest,budget,meta_lead_status,answers,extra)
       select p_source,v_meta,v_lead,v_submitted,i.platform,i.is_organic,i.ad_id,i.ad_name,i.adset_id,i.adset_name,i.campaign_id,i.campaign_name,
        i.form_id,i.form_name,i.full_name,i.email,i.city,i.interest,i.budget,i.meta_lead_status,coalesce(i.answers,'{}'),coalesce(i.extra,'{}')
       from jsonb_to_record(r->'inquiry') as i(platform text,is_organic boolean,ad_id text,ad_name text,adset_id text,adset_name text,campaign_id text,
        campaign_name text,form_id text,form_name text,full_name text,email text,city text,interest text,budget text,meta_lead_status text,answers jsonb,extra jsonb);
      -- A repeat inquiry tells the lead's current agent, once per lead and
      -- day (a later one that day is counted in the same notice). Only a new
      -- import record gets here, so a retried row never notifies again.
      if v_status='existing' and exists(select 1 from public.profiles p where p.id=v_agent and p.active) then
       insert into public.notifications as n(user_id,type,group_key,title,body,link,lead_id)
        values(v_agent,'ad_inquiry','inquiry:'||v_lead||':'||to_char(now() at time zone 'Asia/Karachi','YYYY-MM-DD'),
         'New advertisement inquiry: '||public.format_lead_no(v_lead_no),
         left(v_lead_name||' · '||coalesce(nullif(r#>>'{inquiry,ad_name}',''),s.name),500),'/leads/'||v_lead,v_lead)
        on conflict(user_id,type,group_key) do update set item_count=n.item_count+1,
         title=n.item_count+1||' new advertisement inquiries: '||public.format_lead_no(v_lead_no),body=excluded.body,updated_at=now(),read_at=null;
      end if;
     end if;
    exception when others then
     -- Rolled back to the start of this row: nothing saved, sent again.
     v_status='failed';v_reason=null;v_no=null;
    end;
   end if;
  end if;
  if v_status='rejected' then
   insert into crm_private.sheet_row_rejections(source_id,sheet_row,meta_lead_id,reason,lead_no)
    values(p_source,v_row,v_meta,v_reason,v_no)
    on conflict(source_id,sheet_row) do update set meta_lead_id=excluded.meta_lead_id,lead_no=excluded.lead_no,last_seen_at=now(),
     reason=excluded.reason,first_seen_at=case when crm_private.sheet_row_rejections.reason=excluded.reason then crm_private.sheet_row_rejections.first_seen_at else now() end;
   v_rejected=v_rejected+1;
  elsif v_status<>'failed' then
   delete from crm_private.sheet_row_rejections j where j.source_id=p_source and (j.sheet_row=v_row or (v_meta is not null and j.meta_lead_id=v_meta));
   case v_status when 'inserted' then v_inserted=v_inserted+1;when 'existing' then v_existing=v_existing+1;
    when 'duplicate' then v_duplicate=v_duplicate+1;else v_skipped=v_skipped+1;end case;
  else v_failed=v_failed+1;
  end if;
  v_results=v_results||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('row',v_row,'status',v_status,'reason',v_reason,
   'lead_no',case when v_no is not null then public.format_lead_no(v_no) end)));
 end loop;
 perform public.sheet_file_counts(p_source,f.id);
 update public.sheet_sources set
  last_import_at=case when v_inserted+v_existing>0 then now() else last_import_at end,
  last_error_code=case when v_failed>0 then 'rows_failed' when last_error_code='file_deleted' then null else last_error_code end,
  last_error_at=case when v_failed>0 then now() when last_error_code='file_deleted' then null else last_error_at end
 where id=p_source;
 v_counts=jsonb_build_object('inserted',v_inserted,'existing',v_existing,'duplicate',v_duplicate,'skipped',v_skipped,'rejected',v_rejected,'failed',v_failed);
 if v_inserted+v_existing>0 then
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(v_owner,'sheets.rows_imported','lead_imports',f.id::text,p_request,v_counts||jsonb_build_object('source_id',p_source,'source_name',s.name));
 end if;
 return jsonb_build_object('import_id',f.id,'file_created',v_new_file,'summary',v_counts,'rows',v_results);
end $$;

-- The script's account of a pass over a Sheet. ok with complete: every row
-- was read and every pending row sent and answered, so rejections not seen
-- again since the pass began (p_report.since, the CRM's clock from
-- sheet_sync_sources) are rows that were fixed or removed. Not ok: the
-- script could not read the Sheet, or rows failed (error says which).
create or replace function public.sheet_sync_report(p_key_hash text,p_source uuid,p_report jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s public.sheet_sources;v_since timestamptz;v_rows integer;
begin
 perform public.sheet_sync_owner(p_key_hash);
 if jsonb_typeof(p_report) is distinct from 'object' or jsonb_typeof(p_report->'ok') is distinct from 'boolean'
  or (p_report-array['ok','complete','error','rows','since'])<>'{}'
  or (p_report ? 'complete' and jsonb_typeof(p_report->'complete')<>'boolean')
  or (p_report ? 'rows' and coalesce(p_report->>'rows','')!~'^[0-9]{1,7}$')
  or ((p_report->>'ok')::boolean and p_report ? 'error')
  or (not (p_report->>'ok')::boolean and coalesce(p_report->>'error','') not in ('spreadsheet_unavailable','worksheet_missing','headers_missing','read_failed','rows_failed','too_many_rows')) then
  raise exception 'Invalid report' using errcode='22023';
 end if;
 v_rows=(p_report->>'rows')::integer;
 if p_report ? 'since' then
  v_since=(p_report->>'since')::timestamptz;
  if v_since<now()-interval '2 hours' or v_since>now() then raise exception 'Invalid report' using errcode='22023';end if;
 end if;
 select * into s from public.sheet_sources where id=p_source for update;
 if not found then raise exception 'This Sheet is turned off or not configured in the CRM' using errcode='HS409';end if;
 if (p_report->>'ok')::boolean then
  update public.sheet_sources set last_check_at=now(),sheet_rows=coalesce(v_rows,sheet_rows) where id=p_source;
  if coalesce((p_report->>'complete')::boolean,false) then
   if v_since is not null then
    delete from crm_private.sheet_row_rejections where source_id=p_source and last_seen_at<v_since;
    perform public.sheet_file_counts(p_source,s.import_id);
   end if;
   update public.sheet_sources set last_sync_at=now(),
    last_error_code=case when last_error_code='file_deleted' then last_error_code end,
    last_error_at=case when last_error_code='file_deleted' then last_error_at end
   where id=p_source;
  end if;
 else
  update public.sheet_sources set last_error_code=p_report->>'error',last_error_at=now(),sheet_rows=coalesce(v_rows,sheet_rows) where id=p_source;
 end if;
 return jsonb_build_object('ok',true);
end $$;

-- ------------------------------------------------------------ administrators
create or replace function public.sheet_sources_overview(p_actor uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return jsonb_build_object(
  'key',(select jsonb_build_object('hint',k.hint,'created_at',k.created_at,'created_by',p.name,'last_used_at',k.last_used_at,
    'owner_active',p.active and p.role='admin') from crm_private.sheet_sync_keys k join public.profiles p on p.id=k.created_by where k.revoked_at is null),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'spreadsheet_id',s.spreadsheet_id,'worksheet',s.worksheet,
    'import_from',s.import_from,'enabled',s.enabled,'created_at',s.created_at,'import_id',s.import_id,'file_name',f.file_name,
    'file_deleted',f.deleted_at is not null,'new_leads',(select count(*) from crm_private.sheet_lead_receipts r where r.source_id=s.id and r.outcome='created'),
    'repeat_inquiries',(select count(*) from crm_private.sheet_lead_receipts r where r.source_id=s.id and r.outcome='existing'),
    'rejected',(select count(*) from crm_private.sheet_row_rejections j where j.source_id=s.id),
    'unassigned',(select count(*) from public.leads l where l.import_id=s.import_id and l.deleted_at is null and l.assigned_agent is null),
    'last_sync_at',s.last_sync_at,'last_check_at',s.last_check_at,'last_import_at',s.last_import_at,
    'last_error_code',s.last_error_code,'last_error_at',s.last_error_at,'sheet_rows',s.sheet_rows,
    'history_pending',public.sheet_history_pending(s.import_from,s.created_at,s.history_confirmed_at,s.history_confirmed_from),
    'history_confirmed_at',s.history_confirmed_at,'history_confirmed_by',c.name,'history_confirmed_from',s.history_confirmed_from) order by s.created_at,s.id)
   from public.sheet_sources s left join public.lead_imports f on f.id=s.import_id left join public.profiles c on c.id=s.history_confirmed_by),'[]'));
end $$;

-- A Sheet's rejected rows: row number, reason and Meta lead ID only.
create or replace function public.sheet_source_rejections(p_actor uuid,p_source uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 perform 1 from public.sheet_sources where id=p_source;
 if not found then raise exception 'Sheet not found' using errcode='P0002';end if;
 return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('row',j.sheet_row,'reason',j.reason,'meta_lead_id',j.meta_lead_id,
   'lead_no',case when j.lead_no is not null then public.format_lead_no(j.lead_no) end,'first_seen_at',j.first_seen_at,'last_seen_at',j.last_seen_at)) order by j.sheet_row)
  from (select * from crm_private.sheet_row_rejections where source_id=p_source order by sheet_row limit 500) j),'[]');
end $$;

-- For sheet_source_save: a Sheet that is on and would import rows submitted
-- before it was added needs confirm_history; the confirmation is recorded for
-- its start date. True when confirmed now.
create or replace function public.sheet_confirm_history(s public.sheet_sources,p_actor uuid,p_data jsonb) returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if not s.enabled or not public.sheet_history_pending(s.import_from,s.created_at,s.history_confirmed_at,s.history_confirmed_from) then return false;end if;
 if coalesce((p_data->>'confirm_history')::boolean,false) is not true then
  raise exception 'Confirm the historical import: turning this Sheet on imports rows submitted before it was added.' using errcode='HS428';
 end if;
 update public.sheet_sources set history_confirmed_at=now(),history_confirmed_by=p_actor,history_confirmed_from=s.import_from where id=s.id;
 return true;
end $$;

-- Adds a Sheet (p_source null) or changes one. The spreadsheet stays the same
-- for good; the name (also the lead file's name), tab, start date and on/off
-- can change. Turning on a Sheet whose historical import is not confirmed
-- needs confirm_history (HS428 otherwise); the confirmation is recorded for
-- its start date and audited.
create or replace function public.sheet_source_save(p_actor uuid,p_source uuid,p_data jsonb,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s public.sheet_sources;v_name text;v_tab text;v_from timestamptz;v_on boolean;v_changes text[]='{}';v_confirmed boolean=false;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 if jsonb_typeof(p_data) is distinct from 'object' or (p_data-array['name','spreadsheet_id','worksheet','import_from','enabled','confirm_history'])<>'{}'
  or (p_data ? 'enabled' and jsonb_typeof(p_data->'enabled')<>'boolean')
  or (p_data ? 'confirm_history' and jsonb_typeof(p_data->'confirm_history')<>'boolean') then
  raise exception 'Check the Sheet details' using errcode='22023';
 end if;
 v_name=btrim(p_data->>'name');v_tab=btrim(p_data->>'worksheet');
 v_from=nullif(p_data->>'import_from','')::timestamptz;v_on=(p_data->>'enabled')::boolean;
 if (p_data ? 'name' and length(coalesce(v_name,'')) not between 1 and 200) or (p_data ? 'worksheet' and length(coalesce(v_tab,'')) not between 1 and 100)
  or (v_from is not null and (v_from<'2010-01-01' or v_from>now()+interval '1 year')) then
  raise exception 'Check the Sheet details' using errcode='22023';
 end if;
 if p_source is null then
  if v_name is null or v_tab is null or coalesce(p_data->>'spreadsheet_id','')!~'^[A-Za-z0-9_-]{20,100}$' then
   raise exception 'Check the Sheet details' using errcode='22023';
  end if;
  insert into public.sheet_sources(name,spreadsheet_id,worksheet,import_from,enabled,created_by,updated_by)
   values(v_name,p_data->>'spreadsheet_id',v_tab,v_from,coalesce(v_on,false),p_actor,p_actor) returning * into s;
  v_confirmed=public.sheet_confirm_history(s,p_actor,p_data);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'sheets.source_created','sheet_sources',s.id::text,p_request,jsonb_build_object('name',s.name,'worksheet',s.worksheet,'enabled',s.enabled,
    'import_from',s.import_from,'history_confirmed',v_confirmed));
 else
  select * into s from public.sheet_sources where id=p_source for update;
  if not found then raise exception 'Sheet not found' using errcode='P0002';end if;
  if p_data ? 'spreadsheet_id' and p_data->>'spreadsheet_id' is distinct from s.spreadsheet_id then
   raise exception 'A Sheet''s spreadsheet cannot change. Add the other spreadsheet as a new Sheet.' using errcode='22023';
  end if;
  if p_data ? 'name' and v_name<>s.name then v_changes=v_changes||'name'::text;end if;
  if p_data ? 'worksheet' and v_tab<>s.worksheet then v_changes=v_changes||'worksheet'::text;end if;
  if p_data ? 'import_from' and v_from is distinct from s.import_from then v_changes=v_changes||'import_from'::text;end if;
  if p_data ? 'enabled' and v_on<>s.enabled then v_changes=v_changes||'enabled'::text;end if;
  if cardinality(v_changes)=0 then return jsonb_build_object('id',s.id,'changed',false);end if;
  update public.sheet_sources set name=case when 'name'=any(v_changes) then v_name else name end,
   worksheet=case when 'worksheet'=any(v_changes) then v_tab else worksheet end,
   import_from=case when 'import_from'=any(v_changes) then v_from else import_from end,
   enabled=case when 'enabled'=any(v_changes) then v_on else enabled end,
   updated_by=p_actor,updated_at=now() where id=p_source returning * into s;
  v_confirmed=public.sheet_confirm_history(s,p_actor,p_data);
  -- The file follows the Sheet's name and tab; it stays the same file.
  update public.lead_imports set file_name=s.name,worksheet=s.worksheet where id=s.import_id and deleted_at is null and ('name'=any(v_changes) or 'worksheet'=any(v_changes));
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
   values(p_actor,'sheets.source_updated','sheet_sources',s.id::text,p_request,jsonb_build_object('name',s.name,'changes',to_jsonb(v_changes),
    'enabled',s.enabled,'worksheet',s.worksheet,'import_from',s.import_from,'history_confirmed',v_confirmed));
 end if;
 return jsonb_build_object('id',s.id,'changed',true);
exception when unique_violation then
 raise exception 'This tab of this spreadsheet is already a Sheet in the CRM' using errcode='23505';
end $$;

-- After a Sheet's lead file was deleted, the next import starts a new file.
-- Rows already imported are not imported again.
create or replace function public.sheet_source_new_file(p_actor uuid,p_source uuid,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s public.sheet_sources;
begin
 perform pg_advisory_xact_lock(873420);
 perform public.accounts_admin(p_actor);
 select * into s from public.sheet_sources where id=p_source for update;
 if not found then raise exception 'Sheet not found' using errcode='P0002';end if;
 if s.import_id is null or not exists(select 1 from public.lead_imports where id=s.import_id and deleted_at is not null) then
  raise exception 'Only a Sheet whose lead file was deleted can start a new file' using errcode='22023';
 end if;
 update public.sheet_sources set import_id=null,updated_by=p_actor,updated_at=now(),
  last_error_code=case when last_error_code='file_deleted' then null else last_error_code end,
  last_error_at=case when last_error_code='file_deleted' then null else last_error_at end where id=p_source;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
  values(p_actor,'sheets.new_file_requested','sheet_sources',p_source::text,p_request,jsonb_build_object('name',s.name,'previous_import_id',s.import_id));
 return jsonb_build_object('id',p_source);
end $$;

-- A new integration key (its hash and last four characters) replaces any
-- active one at once.
create or replace function public.sheet_sync_key_create(p_actor uuid,p_hash text,p_hint text,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_replaced boolean;v_at timestamptz;
begin
 perform public.accounts_admin(p_actor);
 if coalesce(p_hash,'')!~'^[a-f0-9]{64}$' or coalesce(p_hint,'')!~'^[A-Za-z0-9_-]{4}$' then raise exception 'Invalid key' using errcode='22023';end if;
 update crm_private.sheet_sync_keys set revoked_at=now(),revoked_by=p_actor where revoked_at is null;
 v_replaced=found;
 insert into crm_private.sheet_sync_keys(key_hash,hint,created_by) values(p_hash,p_hint,p_actor) returning created_at into v_at;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata)
  values(p_actor,'sheets.key_created','sheet_sync_keys',p_request,jsonb_build_object('replaced',v_replaced));
 return jsonb_build_object('hint',p_hint,'created_at',v_at,'replaced',v_replaced);
end $$;

create or replace function public.sheet_sync_key_revoke(p_actor uuid,p_request text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 update crm_private.sheet_sync_keys set revoked_at=now(),revoked_by=p_actor where revoked_at is null;
 if not found then raise exception 'There is no active key' using errcode='P0002';end if;
 insert into public.audit_log(actor_id,action,entity,request_id) values(p_actor,'sheets.key_revoked','sheet_sync_keys',p_request);
 return jsonb_build_object('revoked',true);
end $$;

-- ------------------------------------------------------------ the lead page
-- A lead's advertisement inquiries, newest first, for administrators and the
-- lead's agent.
create or replace function public.lead_ad_inquiries(p_actor uuid,p_lead uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_role text;
begin
 select role into v_role from public.profiles where id=p_actor and active for share;
 if v_role is null or v_role not in ('admin','agent') then raise exception 'Forbidden' using errcode='42501';end if;
 perform 1 from public.leads where id=p_lead and deleted_at is null and (v_role='admin' or assigned_agent=p_actor);
 if not found then raise exception 'Record not found' using errcode='P0002';end if;
 return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('source',s.name,'repeat',r.outcome='existing','submitted_at',i.submitted_at,
   'imported_at',r.imported_at,'platform',i.platform,'is_organic',i.is_organic,'ad_name',i.ad_name,'adset_name',i.adset_name,
   'campaign_name',i.campaign_name,'form_name',i.form_name,'full_name',i.full_name,'email',i.email,'city',i.city,
   'interest',i.interest,'budget',i.budget,'extra',nullif(i.extra,'{}'::jsonb))) order by i.submitted_at desc nulls last,r.imported_at desc)
  from crm_private.sheet_lead_inquiries i join crm_private.sheet_lead_receipts r on r.source_id=i.source_id and r.meta_lead_id=i.meta_lead_id
  join public.sheet_sources s on s.id=i.source_id where i.lead_id=p_lead),'[]');
end $$;

-- ------------------------------------------------------------ access
-- Only the server's API role, and only the functions above it calls; the four
-- helpers are reached through them alone. Browsers have neither.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature,p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
  ('sheet_sync_owner','sheet_file_counts','sheet_history_pending','sheet_confirm_history','sheet_sync_auth','sheet_sync_sources','sheet_sync_pending','sheet_sync_import','sheet_sync_report',
   'sheet_sources_overview','sheet_source_rejections','sheet_source_save','sheet_source_new_file','sheet_sync_key_create','sheet_sync_key_revoke','lead_ad_inquiries') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('sheet_sync_owner','sheet_file_counts','sheet_history_pending','sheet_confirm_history') then
   execute format('revoke all on function %s from service_role',f.signature);
  else
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
commit;
