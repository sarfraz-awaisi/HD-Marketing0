-- Apply once after 031. Soft deletion, 30-day restore, audited bulk actions and durable cleanup.
begin;
alter table public.leads add column deleted_at timestamptz,add column deleted_by uuid references public.profiles(id),add column delete_reason text,add column deleted_batch uuid;
alter table public.leads add constraint leads_deletion_state check((deleted_at is null and deleted_by is null and delete_reason is null and deleted_batch is null) or (deleted_at is not null and deleted_by is not null and length(btrim(delete_reason)) between 3 and 300 and deleted_batch is not null));
alter table public.lead_imports add column deleted_at timestamptz,add column deleted_by uuid references public.profiles(id),add column delete_reason text,add column deleted_batch uuid,add column delete_mode text check(delete_mode in ('file_only','file_and_leads'));
create index leads_deleted_recent on public.leads(deleted_at desc,id) where deleted_at is not null;
create index leads_active_created on public.leads(created_at desc,id) where deleted_at is null;
create view public.active_leads as select * from public.leads where deleted_at is null;
revoke all on public.active_leads from public,anon,authenticated;
grant select on public.active_leads to service_role;
create function public.format_lead_no(p_no bigint) returns text language sql immutable set search_path='' as $$select 'HD-'||lpad(p_no::text,greatest(6,length(p_no::text)),'0')$$;

-- Rewrite only read references in known CRM functions. Row types, writes and grants stay.
-- All definitions were installed by 001–031; this transaction rolls back on any mismatch.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in
 ('crm_metrics_028','crm_metrics','dashboard_snapshot','lead_contact_phones','reveal_phone','lead_import_summary','lead_imports_page','assign_lead_import',
 'handover_lead','assign_lead_023','assign_lead','assign_leads_bulk','offboard_preview','offboard_agent','update_account_022','prepare_account_deletion','accounts_page','account_detail_023',
 'advance_lead_status','log_manual_call','edit_lead','update_lead_phone','search_kyc_clients','knowledge_documents_page','knowledge_document_access','save_knowledge_document','report_inactive_lead_owners','run_crm_job','meta_assign','meta_report') loop
  body=pg_get_functiondef(fn.oid);
  body=replace(replace(body,'from public.leads','from public.active_leads'),'join public.leads','join public.active_leads');
  if fn.proname='lead_import_summary' then body=replace(body,'where id=p_import;','where id=p_import and deleted_at is null;');end if;
  if fn.proname='lead_imports_page' then body=replace(body,'where (actor.role=', 'where i.deleted_at is null and (actor.role=');body=replace(body,'where i.deleted_at is null and (actor.role=', 'where i.deleted_at is null and (actor.role=');
   -- The paged inner query uses alias b rather than i.
   body=replace(body,'from public.lead_imports b'||chr(10)||'      where i.deleted_at','from public.lead_imports b'||chr(10)||'      where b.deleted_at');end if;
  if fn.proname='assign_lead_import' then body=replace(body,'where id=p_import for update','where id=p_import and deleted_at is null for update');end if;
  if fn.proname='knowledge_document_access' then body=replace(body,'if doc.category=''client_kyc'' then', 'if doc.lead_id is not null and not exists(select 1 from public.active_leads where id=doc.lead_id) then raise exception ''Entry not found'' using errcode=''P0002'';end if;'||chr(10)||'  if doc.category=''client_kyc'' then');end if;
  if fn.proname='knowledge_documents_page' then body=replace(body,'where (d.category<>''client_kyc''', 'where (d.lead_id is null or l.id is not null) and (d.category<>''client_kyc''');end if;
  execute body;
 end loop;
end $upgrade$;
-- Unscoped leaderboard aggregates must explicitly join eligible customers.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_leaderboard(uuid,timestamptz,timestamptz)'::regprocedure);
 body=replace(body,'from public.calls where status=', 'from public.calls where exists(select 1 from public.active_leads l where l.id=lead_id) and status=');
 body=replace(body,'from public.deals where stage=', 'from public.deals where exists(select 1 from public.active_leads l where l.id=lead_id) and stage=');execute body;
end $upgrade$;

-- SQL writes must reject deleted customers before the older mutation implementation.
alter function public.crm_mutate(text,uuid,jsonb,uuid,text) rename to crm_mutate_031;
create function public.crm_mutate(p_table text,p_id uuid,p_data jsonb,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid;begin
 if not exists(select 1 from public.profiles where id=p_actor and active) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_table='leads' then target=p_id;
 elsif p_table in ('notes','calls','followups','visits','deals') then
  if p_id is null then target=(p_data->>'lead_id')::uuid;
  else execute format('select lead_id from public.%I where id=$1',p_table) into target using p_id;end if;
 end if;
 if target is not null then
  perform id from public.active_leads where id=target for update;
  if not found then raise exception 'Lead not found' using errcode='P0002';end if;
 end if;
 return public.crm_mutate_031(p_table,p_id,p_data,p_actor,p_request);
end $$;
-- Guard the renamed implementation too; all normal mutation lookups use the view.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_mutate_031(text,uuid,jsonb,uuid,text)'::regprocedure);
 body=replace(body,'from public.leads','from public.active_leads');execute body;
end $upgrade$;
create or replace function public.private_phone(p_lead uuid) returns text language sql security definer set search_path='' as $$
 select p.phone from crm_private.lead_phones p join public.active_leads l on l.id=p.lead_id where l.id=p_lead
$$;
create or replace function public.recording_access(p_call uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('storage_path',r.storage_path) from crm_private.recordings r join public.calls c on c.id=r.call_id join public.active_leads l on l.id=c.lead_id where r.call_id=p_call and r.deleted_at is null and r.created_at>now()-interval '7 days'
$$;
-- Reserve phone identity while a lead is recoverable. Both imports and manual creation share this boundary.
alter function public.create_lead(jsonb,text,uuid,text) rename to create_lead_031;
create function public.create_lead(p_data jsonb,p_phone text,p_actor uuid,p_request text) returns public.leads language plpgsql security definer set search_path='' as $$
declare number text;existing public.leads;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);number=public.normalize_lead_phone(p_phone);
 select l.* into existing from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where p.phone=number;
 if existing.deleted_at is not null then raise exception 'This number is in Deleted leads (%). Restore it instead.',public.format_lead_no(existing.lead_no) using errcode='23505';end if;
 return public.create_lead_031(p_data,number,p_actor,p_request);
end $$;
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.import_leads(text,text,text,jsonb,uuid,text)'::regprocedure);
 body=replace(body,'''error'',''Duplicate phone''', '''error'',case when sqlerrm like ''This number is in Deleted leads (HD-%'' then sqlerrm else ''Duplicate phone'' end');execute body;
end $upgrade$;

-- Count delete events over the Pakistan day, including leads later restored.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.crm_metrics(uuid,timestamptz,timestamptz,uuid,text)'::regprocedure);
 body=replace(body, 'jsonb_build_object(''total_leads'',', 'jsonb_build_object(''deleted_today'',case when exists(select 1 from public.profiles where id=p_actor and active and role=''admin'') then (select coalesce(sum((metadata->>''deleted'')::int),0) from public.audit_log where action=''lead.bulk_deleted'' and created_at>=(date_trunc(''day'',now() at time zone ''Asia/Karachi'') at time zone ''Asia/Karachi'')) else 0 end,''total_leads'',');execute body;
end $upgrade$;

-- Duplicate phone checks include recoverable leads and return only their stable number.
do $upgrade$ declare body text;begin
 body=pg_get_functiondef('public.update_lead_phone(uuid,text,uuid,text)'::regprocedure);
 body=replace(body,'other_no bigint;', 'other_no bigint;other_deleted timestamptz;');
 body=replace(body,'select l.lead_no into other_no from crm_private.lead_phones p join public.active_leads l', 'select l.lead_no,l.deleted_at into other_no,other_deleted from crm_private.lead_phones p join public.leads l');
 body=replace(body,'if found then raise exception ''This number already belongs', 'if other_deleted is not null then raise exception ''This number is in Deleted leads (%). Restore it instead.'',public.format_lead_no(other_no) using errcode=''23505'';end if;'||chr(10)||' if found then raise exception ''This number already belongs');execute body;
end $upgrade$;

-- Linked KYC attachments and deletion endpoints use the same current lead check.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in ('attach_knowledge_file','delete_knowledge_file','delete_knowledge_document') loop
  body=pg_get_functiondef(fn.oid);
  if fn.proname='delete_knowledge_document' then body=replace(body,'perform id from public.knowledge_documents', 'perform public.knowledge_document_access(p_id,p_actor);'||chr(10)||'  perform id from public.knowledge_documents');
  else body=replace(body,'begin', 'begin'||chr(10)||'  perform public.knowledge_document_access(p_document,p_actor);');end if;
  execute body;
 end loop;
end $upgrade$;
-- Deleted social customers cannot reappear via submission copies or cohort reports.
do $upgrade$ declare fn record;body text;begin
 for fn in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in ('meta_inbox','meta_summary','meta_submission','meta_report','meta_finish') loop
  body=pg_get_functiondef(fn.oid);
  body=replace(replace(body,'from public.leads','from public.active_leads'),'join public.leads','join public.active_leads');
  if fn.proname='meta_inbox' then
   body=replace(body,'select s.*,l.name,','select s.*,l.lead_no,l.name,');
   body=replace(body,'where (coalesce(p_filters->>''platform''', 'where (s.lead_id is null or l.id is not null) and (coalesce(p_filters->>''platform''');
  elsif fn.proname='meta_submission' then
   body=replace(body,'if not found then raise exception ''Submission not found''', 'if not found or (s.lead_id is not null and not exists(select 1 from public.active_leads where id=s.lead_id)) then raise exception ''Submission not found''');
  elsif fn.proname in ('meta_summary','meta_report') then
   body=replace(body,'from public.meta_submissions where', 'from public.meta_submissions where (lead_id is null or exists(select 1 from public.active_leads l where l.id=lead_id)) and');
   body=replace(body,'from public.meta_submissions);', 'from public.meta_submissions where lead_id is null or exists(select 1 from public.active_leads l where l.id=lead_id));');
   body=replace(body,'where s.status in(''created''', 'where (s.lead_id is null or l.id is not null) and s.status in(''created''');
  elsif fn.proname='meta_finish' then
   body=replace(body,'select lead_id into customer from crm_private.lead_phones where phone=p_data->>''phone'';', 'select p.lead_id into customer from crm_private.lead_phones p join public.active_leads l on l.id=p.lead_id where p.phone=p_data->>''phone'';');
   body=replace(body,'if customer is null then raise;end if;', 'if customer is null then update public.meta_submissions set status=''review'',error_code=''lead_in_deleted_bin'',processed_at=now(),lease_id=null,lease_until=null where id=p_id;return jsonb_build_object(''id'',p_id,''status'',''review'');end if;');
  end if;
  execute body;
 end loop;
end $upgrade$;

create function public.delete_leads(p_lead_ids uuid[],p_actor uuid,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;target public.leads;results jsonb='[]';n int=0;failed int=0;batch uuid=gen_random_uuid();day_count int;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–500 distinct leads' using errcode='22023';end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then raise exception 'Delete reason must contain 3–300 characters' using errcode='22023';end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  select * into target from public.leads where id=item and deleted_at is null;
  if not found then failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Lead not found'));
  elsif exists(select 1 from public.deals where lead_id=item and stage='won') then
   failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Has a won deal'));
  else
   update public.followups set status='cancelled' where lead_id=item and status='pending';
   update public.visits set status='cancelled' where lead_id=item and status='scheduled';
   delete from public.reminders where read_at is null and followup_id in(select id from public.followups where lead_id=item);
   update public.leads set deleted_at=now(),deleted_by=p_actor,delete_reason=btrim(p_reason),deleted_batch=batch,assigned_agent=null where id=item;
   n=n+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','deleted'));
  end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_deleted','leads',p_request,jsonb_build_object('deleted',n,'failed',failed));
 select coalesce(sum((metadata->>'deleted')::int),0)::int into day_count from public.audit_log where action='lead.bulk_deleted' and created_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi');
 if day_count>50 then
  insert into public.security_alerts(type,severity,user_id,message,metadata)
   select 'mass_lead_deletion','critical',p_actor,'More than 50 customer leads were deleted today.',jsonb_build_object('count',day_count)
   where not exists(select 1 from public.security_alerts where type='mass_lead_deletion' and created_at>=(date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi'));
 end if;
 return jsonb_build_object('deleted',n,'failed',failed,'results',results,'batch',batch);
end $$;
create function public.restore_leads(p_lead_ids uuid[],p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;results jsonb='[]';n int=0;failed int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–500 distinct leads' using errcode='22023';end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  update public.leads set import_id=case when exists(select 1 from public.lead_imports i where i.id=import_id and i.deleted_at is not null) then null else import_id end,deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,assigned_agent=null where id=item and deleted_at>now()-interval '30 days';
  if found then n=n+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','restored'));
  else failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Lead not found or restore period expired'));end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.bulk_restored','leads',p_request,jsonb_build_object('restored',n,'failed',failed));
 return jsonb_build_object('restored',n,'failed',failed,'results',results);
end $$;
create function public.deleted_leads_page(p_actor uuid,p_page int,p_limit int,p_search text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 perform public.accounts_admin(p_actor);
 if p_page not between 1 and 100000 or p_limit not between 1 and 100 or p_search is null or length(p_search)>100 then raise exception 'Invalid bin filters' using errcode='22023';end if;
 with eligible as(select l.id,l.lead_no,l.name,l.deleted_at,l.deleted_batch,l.delete_reason,p.name deleted_by_name,greatest(0,ceil(extract(epoch from (l.deleted_at+interval '30 days'-now()))/86400))::int days_left from public.leads l join public.profiles p on p.id=l.deleted_by where l.deleted_at is not null and (p_search='' or position(lower(p_search) in lower(l.name))>0 or public.format_lead_no(l.lead_no) ilike '%'||p_search||'%' or l.lead_no::text=ltrim(p_search,'0'))),
 page_rows as(select * from eligible order by deleted_at desc,id limit p_limit offset (p_page-1)*p_limit)
 select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(r)) from page_rows r),'[]'),'count',(select count(*) from eligible),'page',p_page,'limit',p_limit) into result;
 return result;
end $$;
create function public.lead_delete_preview(p_actor uuid,p_leads uuid[] default null,p_import uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 if (p_leads is null)=(p_import is null) or (p_leads is not null and cardinality(p_leads) not between 1 and 500) then raise exception 'Choose leads or one file' using errcode='22023';end if;
 return (with eligible as(select id from public.active_leads where (p_leads is not null and id=any(p_leads)) or (p_import is not null and import_id=p_import)) select jsonb_build_object('leads',(select count(*) from eligible),'followups',(select count(*) from public.followups where lead_id in(select id from eligible) and status='pending'),'visits',(select count(*) from public.visits where lead_id in(select id from eligible) and status='scheduled'),'won',(select count(*) from public.deals where lead_id in(select id from eligible) and stage='won')));
end $$;
create function public.delete_lead_import(p_import uuid,p_actor uuid,p_mode text,p_reason text,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[];batch uuid=gen_random_uuid();result jsonb;n int=0;failed int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_mode is null or p_mode not in ('file_only','file_and_leads') or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then raise exception 'Delete reason and valid file mode required' using errcode='22023';end if;
 perform id from public.lead_imports where id=p_import and deleted_at is null for update;
 if not found then raise exception 'File not found' using errcode='P0002';end if;
 if p_mode='file_only' then update public.leads set import_id=null where import_id=p_import;
 else
  loop
   select array_agg(id) into ids from (select l.id from public.active_leads l where l.import_id=p_import and not exists(select 1 from public.deals where lead_id=l.id and stage='won') order by id limit 500) q;
   exit when ids is null;
   result=public.delete_leads(ids,p_actor,p_reason,p_request);n=n+(result->>'deleted')::int;
   update public.leads set deleted_batch=batch where id=any(ids) and deleted_at is not null;
  end loop;
  select count(*)::int into failed from public.active_leads where import_id=p_import;
 end if;
 -- Won-deal leads kept by the file operation remain usable as ordinary leads.
 update public.leads set import_id=null where import_id=p_import and deleted_at is null;
 update public.lead_imports set deleted_at=now(),deleted_by=p_actor,delete_reason=btrim(p_reason),deleted_batch=batch,delete_mode=p_mode,assigned_agent=null where id=p_import;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.file_deleted','lead_imports',p_import::text,p_request,jsonb_build_object('deleted',n,'failed',failed,'kept_leads',p_mode='file_only'));
 return jsonb_build_object('deleted',n,'failed',failed,'batch',batch);
end $$;
create function public.deleted_imports_page(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.accounts_admin(p_actor);
 return (select coalesce(jsonb_agg(to_jsonb(i)),'[]') from (select id,file_name,deleted_at,delete_reason,deleted_batch from public.lead_imports where deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' order by deleted_at desc limit 100) i);
end $$;
create function public.restore_lead_import(p_import uuid,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare batch uuid;ids uuid[];result jsonb;n int=0;begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select deleted_batch into batch from public.lead_imports where id=p_import and deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' for update;
 if not found then raise exception 'Restore period expired or file not found' using errcode='P0002';end if;
 -- Restore the container first within this transaction so restored members keep it.
 update public.lead_imports set deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,delete_mode=null,assigned_agent=null where id=p_import;
 loop
  select array_agg(id) into ids from(select id from public.leads where import_id=p_import and deleted_batch=batch and deleted_at>now()-interval '30 days' order by id limit 500) q;
  exit when ids is null;result=public.restore_leads(ids,p_actor,p_request);n=n+(result->>'restored')::int;
 end loop;
 update public.lead_imports set deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null,delete_mode=null,assigned_agent=null where id=p_import;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.file_restored','lead_imports',p_import::text,p_request,jsonb_build_object('restored',n));
 return jsonb_build_object('restored',n);
end $$;

-- Durable orphan-recording cleanup is independent of soon-to-be-purged call foreign keys.
create table crm_private.lead_recording_cleanup(id uuid primary key default gen_random_uuid(),storage_path text,provider_ref text,created_at timestamptz not null default now());
create table crm_private.lead_purge_runs(id boolean primary key default true check(id),last_run_at timestamptz not null);
alter table crm_private.lead_recording_cleanup enable row level security;
alter table crm_private.lead_purge_runs enable row level security;
revoke all on crm_private.lead_recording_cleanup,crm_private.lead_purge_runs from public,anon,authenticated;
grant all on crm_private.lead_recording_cleanup,crm_private.lead_purge_runs to service_role;
create function public.purge_deleted_leads(p_retention int default 30) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;ids uuid[];n int=0;begin
 if p_retention is null or p_retention not between 30 and 3650 then raise exception 'Retention must be 30–3650 days' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(320032) then return '{"skipped":true}';end if;
 perform pg_advisory_xact_lock(873420);
 if exists(select 1 from crm_private.lead_purge_runs where last_run_at>now()-interval '1 day') then return '{"skipped":true}';end if;
 select array_agg(id) into ids from (select id from public.leads where deleted_at<now()-make_interval(days=>p_retention) order by deleted_at,id limit 200 for update skip locked) q;
 foreach item in array coalesce(ids,'{}'::uuid[]) loop
  -- Won deals are additionally protected if a trusted import changed history after deletion.
  if exists(select 1 from public.deals where lead_id=item and stage='won') then continue;end if;
  insert into crm_private.lead_recording_cleanup(storage_path,provider_ref) select r.storage_path,r.provider_ref from crm_private.recordings r join public.calls c on c.id=r.call_id where c.lead_id=item and r.deleted_at is null;
  insert into public.knowledge_file_cleanup(document_id,storage_path) select f.document_id,f.storage_path from public.knowledge_files f join public.knowledge_documents d on d.id=f.document_id where d.lead_id=item on conflict(storage_path) do update set not_before=now();
  delete from public.knowledge_files where document_id in(select id from public.knowledge_documents where lead_id=item);
  delete from public.knowledge_documents where lead_id=item;
  delete from crm_private.recordings where call_id in(select id from public.calls where lead_id=item);
  delete from public.reminders where followup_id in(select id from public.followups where lead_id=item);
  delete from crm_private.phone_reveals where lead_id=item;
  delete from public.notes where lead_id=item;delete from public.calls where lead_id=item;delete from public.followups where lead_id=item;delete from public.visits where lead_id=item;delete from public.deals where lead_id=item;delete from public.assignments where lead_id=item;delete from public.lead_status_history where lead_id=item;
  -- Remove submission copies so normalized contacts and answers do not survive customer erasure.
  delete from crm_private.meta_answers where submission_id in(select id from public.meta_submissions where lead_id=item);
  delete from public.meta_notice_reads where submission_id in(select id from public.meta_submissions where lead_id=item);
  delete from public.meta_submissions where lead_id=item;
  delete from public.leads where id=item;n=n+1;
 end loop;
 insert into crm_private.lead_purge_runs(id,last_run_at) values(true,now()) on conflict(id) do update set last_run_at=excluded.last_run_at;
 if n>0 then insert into public.audit_log(action,entity,request_id,metadata) values('lead.purged','leads','job:purge-deleted-leads',jsonb_build_object('purged',n));end if;
 return jsonb_build_object('purged',n);
end $$;
create function public.lead_recording_cleanup_batch() returns jsonb language sql security definer set search_path='' as $$select coalesce(jsonb_agg(to_jsonb(r)),'[]') from(select * from crm_private.lead_recording_cleanup order by created_at,id limit 100)r$$;
create function public.lead_recording_cleanup_done(p_id uuid) returns void language sql security definer set search_path='' as $$delete from crm_private.lead_recording_cleanup where id=p_id$$;

-- All new functions and renamed implementations remain service-only.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('format_lead_no','crm_mutate','crm_mutate_031','create_lead','create_lead_031','private_phone','recording_access','delete_leads','restore_leads','deleted_leads_page','lead_delete_preview','delete_lead_import','deleted_imports_page','restore_lead_import','purge_deleted_leads','lead_recording_cleanup_batch','lead_recording_cleanup_done') loop
 execute format('revoke all on function %s from public,anon,authenticated',fn.signature);execute format('grant execute on function %s to service_role',fn.signature);end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
