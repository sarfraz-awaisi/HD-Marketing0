-- Update 069: Delete instantly, and 14 days to restore. Apply after 068.
-- Safe to rerun.
--
-- Deleted leads (update 032) keep a deleted lead, with all its work, for 30
-- days so it can be restored; then the daily job erases it. Now:
--
-- * Delete instantly: an administrator erases the leads chosen in Deleted
--   leads, or a deleted file's leads, at once. They are erased exactly as
--   the daily job erases them: the lead, its number, calls and recordings,
--   notes, follow-ups and reminders, visits, deals, assignments, status
--   history, KYC documents, Meta and Google Sheet copies and notifications.
--   A Google Sheet row keeps its receipt (no lead), so the next sync does
--   not bring the lead back. Audit history keeps one entry naming who erased
--   how many, with their HD numbers only, as the daily job's entry does.
--   Only leads already in Deleted leads can be erased, never a lead with a
--   won deal. More than 50 erased in a Pakistan day raises a critical
--   security alert, as deleting does.
-- * Leads and files can be restored for 14 days instead of 30, and the daily
--   job erases them after 14 days (it accepts 14 to 3,650).
--
-- A deleted lead already counts nowhere: lists, numbers, reports, Team
-- performance and drill-downs leave it out (update 032). That is unchanged.
-- New: lead_imports.erased_at/erased_by, erase_lead (one lead, also used by
-- the daily job), erase_deleted_leads, erase_deleted_import. Checked edits:
-- purge_deleted_leads, deleted_leads_page, restore_leads,
-- deleted_imports_page, restore_lead_import.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.purge_deleted_leads(integer)') is null
  or to_regprocedure('public.restore_lead_import(uuid,uuid,text)') is null
  or not exists(select 1 from information_schema.columns
   where table_schema='public' and table_name='leads' and column_name='ad_name') then
  raise exception 'Apply CRM updates up to 068 before update 069.';
 end if;
end $$;

-- A deleted file whose leads were erased: kept as a record (name, who and
-- when), never listed or restored again.
alter table public.lead_imports
 add column if not exists erased_at timestamptz,
 add column if not exists erased_by uuid references public.profiles(id);

-- One deleted lead's erasure, as the daily job has done since update 032:
-- stored recordings and KYC files are queued for removal from Storage, then
-- every record of the lead is deleted. The caller checks the lead.
create or replace function public.erase_lead(p_lead uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into crm_private.lead_recording_cleanup(storage_path,provider_ref) select r.storage_path,r.provider_ref from crm_private.recordings r join public.calls c on c.id=r.call_id where c.lead_id=p_lead and r.deleted_at is null;
 insert into public.knowledge_file_cleanup(document_id,storage_path) select f.document_id,f.storage_path from public.knowledge_files f join public.knowledge_documents d on d.id=f.document_id where d.lead_id=p_lead on conflict(storage_path) do update set not_before=now();
 delete from public.knowledge_files where document_id in(select id from public.knowledge_documents where lead_id=p_lead);
 delete from public.knowledge_documents where lead_id=p_lead;
 delete from crm_private.recordings where call_id in(select id from public.calls where lead_id=p_lead);
 delete from public.reminders where followup_id in(select id from public.followups where lead_id=p_lead);
 delete from crm_private.phone_reveals where lead_id=p_lead;
 delete from public.notes where lead_id=p_lead;delete from public.calls where lead_id=p_lead;delete from public.followups where lead_id=p_lead;delete from public.visits where lead_id=p_lead;delete from public.deals where lead_id=p_lead;delete from public.assignments where lead_id=p_lead;delete from public.lead_status_history where lead_id=p_lead;
 -- Remove submission copies so normalized contacts and answers do not survive customer erasure.
 delete from crm_private.meta_answers where submission_id in(select id from public.meta_submissions where lead_id=p_lead);
 delete from public.meta_notice_reads where submission_id in(select id from public.meta_submissions where lead_id=p_lead);
 delete from public.meta_submissions where lead_id=p_lead;
 -- Its number, file rows, Google Sheet inquiries and notifications go with
 -- it (on delete cascade); a Sheet row's receipt stays, without the lead.
 delete from public.leads where id=p_lead;
end $$;

-- More than 50 leads erased in a Pakistan day: one critical alert that day.
create or replace function public.lead_erasure_alert(p_actor uuid) returns void language plpgsql security definer set search_path='' as $$
declare day_start timestamptz=date_trunc('day',now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';n int;
begin
 select coalesce(sum((metadata->>'erased')::int),0)::int into n from public.audit_log
  where action in ('lead.erased','lead.file_erased') and created_at>=day_start;
 if n>50 then
  insert into public.security_alerts(type,severity,user_id,message,metadata)
   select 'mass_lead_erasure','critical',p_actor,'More than 50 customer leads were permanently deleted today.',jsonb_build_object('count',n)
   where not exists(select 1 from public.security_alerts where type='mass_lead_erasure' and created_at>=day_start);
 end if;
end $$;

-- Delete instantly: the chosen leads in Deleted leads, now.
create or replace function public.erase_deleted_leads(p_lead_ids uuid[],p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item uuid;target public.leads;results jsonb='[]';n int=0;failed int=0;numbers bigint[]='{}';begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 if p_lead_ids is null or cardinality(p_lead_ids) not between 1 and 500 or (select count(distinct id) from unnest(p_lead_ids) id)<>cardinality(p_lead_ids) then raise exception 'Choose 1–500 distinct leads' using errcode='22023';end if;
 perform id from public.leads where id=any(p_lead_ids) order by id for update;
 foreach item in array (select array_agg(id order by id) from unnest(p_lead_ids) id) loop
  select * into target from public.leads where id=item and deleted_at is not null;
  if not found then failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Not in Deleted leads'));
  elsif exists(select 1 from public.deals where lead_id=item and stage='won') then
   failed=failed+1;results=results||jsonb_build_array(jsonb_build_object('id',item,'result','failed','reason','Has a won deal'));
  else
   perform public.erase_lead(item);
   n=n+1;numbers=numbers||target.lead_no;
   results=results||jsonb_build_array(jsonb_build_object('id',item,'lead_no',target.lead_no,'result','erased'));
  end if;
 end loop;
 insert into public.audit_log(actor_id,action,entity,request_id,metadata) values(p_actor,'lead.erased','leads',p_request,
  jsonb_build_object('erased',n,'failed',failed,'lead_nos',to_jsonb(numbers)));
 perform public.lead_erasure_alert(p_actor);
 return jsonb_build_object('erased',n,'failed',failed,'results',results);
end $$;

-- Delete instantly: a deleted file's leads, the ones its deletion moved to
-- Deleted leads and Restore file and leads would bring back. The file stays
-- deleted, marked erased.
create or replace function public.erase_deleted_import(p_import uuid,p_actor uuid,p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.lead_imports;item record;n int=0;kept int;numbers bigint[]='{}';begin
 perform pg_advisory_xact_lock(873420);perform public.accounts_admin(p_actor);
 select * into f from public.lead_imports where id=p_import and deleted_at is not null and delete_mode='file_and_leads' and erased_at is null for update;
 if not found then raise exception 'File not found in Deleted leads' using errcode='P0002';end if;
 perform id from public.leads where import_id=p_import and deleted_batch=f.deleted_batch and deleted_at is not null order by id for update;
 for item in select l.id,l.lead_no from public.leads l where l.import_id=p_import and l.deleted_batch=f.deleted_batch and l.deleted_at is not null
   and not exists(select 1 from public.deals d where d.lead_id=l.id and d.stage='won') order by l.id loop
  perform public.erase_lead(item.id);n=n+1;numbers=numbers||item.lead_no;
 end loop;
 select count(*)::int into kept from public.leads where import_id=p_import and deleted_batch=f.deleted_batch and deleted_at is not null;
 update public.lead_imports set erased_at=now(),erased_by=p_actor where id=p_import;
 insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata) values(p_actor,'lead.file_erased','lead_imports',p_import::text,p_request,
  jsonb_build_object('erased',n,'failed',kept,'lead_nos',to_jsonb(numbers)));
 perform public.lead_erasure_alert(p_actor);
 return jsonb_build_object('erased',n,'failed',kept);
end $$;

-- Small, checked edits, as in updates 061 to 068: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- The daily job: 14 days, and the same erasure as Delete instantly.
  ('public.purge_deleted_leads(integer)',
   $t$p_retention integer DEFAULT 30)$t$,
   $t$p_retention integer DEFAULT 14)$t$),
  ('public.purge_deleted_leads(integer)',
   $t$p_retention not between 30 and 3650 then raise exception 'Retention must be 30–3650 days'$t$,
   $t$p_retention not between 14 and 3650 then raise exception 'Retention must be 14–3650 days'$t$),
  ('public.purge_deleted_leads(integer)',
   $t$  insert into crm_private.lead_recording_cleanup(storage_path,provider_ref) select r.storage_path,r.provider_ref from crm_private.recordings r join public.calls c on c.id=r.call_id where c.lead_id=item and r.deleted_at is null;
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
$t$,
   $t$  -- Update 069: the same erasure as Delete instantly.
  perform public.erase_lead(item);n=n+1;
$t$),
  -- 14 days to restore.
  ('public.deleted_leads_page(uuid,integer,integer,text)',
   $t$l.deleted_at+interval '30 days'-now()$t$,
   $t$l.deleted_at+interval '14 days'-now()$t$),
  ('public.restore_leads(uuid[],uuid,text)',
   $t$where id=item and deleted_at>now()-interval '30 days';$t$,
   $t$where id=item and deleted_at>now()-interval '14 days';$t$),
  ('public.deleted_imports_page(uuid)',
   $t$where deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' order by$t$,
   $t$where deleted_at>now()-interval '14 days' and delete_mode='file_and_leads' and erased_at is null order by$t$),
  ('public.restore_lead_import(uuid,uuid,text)',
   $t$where id=p_import and deleted_at>now()-interval '30 days' and delete_mode='file_and_leads' for update;$t$,
   $t$where id=p_import and deleted_at>now()-interval '14 days' and delete_mode='file_and_leads' and erased_at is null for update;$t$),
  ('public.restore_lead_import(uuid,uuid,text)',
   $t$deleted_batch=batch and deleted_at>now()-interval '30 days' order by id$t$,
   $t$deleted_batch=batch and deleted_at>now()-interval '14 days' order by id$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 069 found an unexpected version of %: apply CRM updates up to 068 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;

-- Only the CRM's server calls the new functions; erase_lead and the alert
-- only from them.
do $grants$ declare fn record;begin
 for fn in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('erase_lead','lead_erasure_alert','erase_deleted_leads','erase_deleted_import') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.proname in ('erase_deleted_leads','erase_deleted_import') then
   execute format('grant execute on function %s to service_role',fn.signature);
  else
   execute format('revoke all on function %s from service_role',fn.signature);
  end if;
 end loop;
end $grants$;
notify pgrst,'reload schema';
commit;
