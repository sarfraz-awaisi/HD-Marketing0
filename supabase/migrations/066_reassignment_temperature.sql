-- Update 066: a lead's Hot, Warm or Cold starts again when an administrator
-- gives it to a different agent, everywhere it is read. Apply after 065.
-- Safe to rerun.
--
-- The classification is not a field of the lead: it is the latest Hot lead,
-- Warm lead or Cold lead tag on the lead's calls. Since update 061 the
-- receiving agent's lists, their pipeline and its counts, and
-- administrators' view of an agent's pipeline read it only from calls of
-- the current assignment (workspace_since: when the lead reached its
-- current agent from another agent), so the earlier agent's classification
-- no longer shows there. Two places still read the lead's whole history:
-- All leads' temperature filter (update 058) and the rows of
-- administrators' report drill-downs (update 050). They now read the
-- current assignment the same way.
--
-- Nothing is deleted or changed: earlier calls keep their tags in the call
-- history and the audit log. The reset is the reassignment itself
-- (leads.assigned_at, set by the existing track_lead_owner trigger in the
-- same statement), so it is atomic and the same for every way a lead is
-- reassigned; reassigning a lead to its own agent changes nothing.
--
-- No table and no row changes. Checked edits: admin_lead_list,
-- report_drill_row.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.phone_country(text)') is null
  or to_regprocedure('public.workspace_since(uuid)') is null
  or to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or to_regprocedure('public.report_drill_row(uuid,text,uuid,timestamptz,numeric,text,integer)') is null then
  raise exception 'Apply CRM updates up to 065 before update 066.';
 end if;
end $$;

-- Small, checked edits, as in updates 061 to 065: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('public.admin_lead_list(uuid,jsonb)',
   $t$where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')$t$,
   $t$where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead') and c.created_at>=coalesce(public.workspace_since(l.id),'-infinity')$t$),
  ('public.report_drill_row(uuid,text,uuid,timestamp with time zone,numeric,text,integer)',
   $t$where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')$t$,
   $t$where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead') and c.created_at>=coalesce(public.workspace_since(l.id),'-infinity')$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 066 found an unexpected version of %: apply CRM updates up to 065 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
commit;
