-- Update 067: a lead an administrator gives to a different agent starts
-- fresh for that agent. Apply after 066. Safe to rerun.
--
-- Since update 061 the receiving agent's workspace already leaves out the
-- earlier assignment's notes, calls (outcomes, comments and tags), status
-- changes and temperature (update 066). Three things still reached them:
--
-- * The earlier agent's pending follow-ups and scheduled visits, which moved
--   to the new agent with the lead (update 022) and showed with their dates.
--   Now they are cancelled, and their unread reminders removed, the moment
--   the lead reaches a different agent, as when a lead is deleted. Each one
--   is recorded in the audit log (followup.reassignment_cancelled,
--   visit.reassignment_cancelled). Administrators keep them, cancelled and
--   still filed under the earlier agent, in the lead's history.
-- * The earlier assignment's open deal, shown with its stage and value. It
--   now shows to the new agent only once it changes during their
--   assignment; administrators see it as before.
-- * "Previously not interested", shown until the new agent's first call.
--   The earlier result is no longer given to the new agent at all.
--
-- What stays as before: a lead's first agent, and a lead left with no agent
-- (its commitments go to the administrator); reassigning a lead to its own
-- agent changes nothing. Every way a lead changes hands goes through
-- handover_lead (one or many leads, distribution, lead review, editing a
-- lead, files, Meta, offboarding and account deletion), so the rule is the
-- same everywhere. Reports keep their numbers: nothing is deleted and no
-- table changes. Checked edits: handover_lead, workspace_item,
-- lead_workspace.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.handover_lead(uuid,uuid,uuid,text)') is null
  or to_regprocedure('public.workspace_since(uuid)') is null
  or to_regprocedure('public.lead_workspace(uuid)') is null
  or to_regprocedure('public.workspace_item(text,uuid,timestamptz,uuid,text,timestamptz,timestamptz)') is null
  or position('workspace_since(l.id)' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 066 before update 067.';
 end if;
end $$;

-- Small, checked edits, as in updates 061 to 066: each text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  -- The lead's agent before the change.
  ('public.handover_lead(uuid,uuid,uuid,text)',
   $t$declare recipient uuid; f integer; v integer; r integer;$t$,
   $t$declare recipient uuid; previous uuid; f integer; v integer; r integer;$t$),
  ('public.handover_lead(uuid,uuid,uuid,text)',
   $t$  recipient=coalesce(p_owner,p_actor);
$t$,
   $t$  recipient=coalesce(p_owner,p_actor);
  select assigned_agent into previous from public.leads where id=p_lead;
$t$),
  -- A different agent starts fresh: the earlier assignment's commitments
  -- are cancelled instead of moved.
  ('public.handover_lead(uuid,uuid,uuid,text)',
   $t$  update public.followups set agent_id=recipient where lead_id=p_lead and status='pending' and agent_id is distinct from recipient;
$t$,
   $t$  -- Update 067: a lead given to a different agent starts fresh for them.
  -- The earlier assignment's pending follow-ups and scheduled visits are
  -- cancelled and their unread reminders removed, as when a lead is
  -- deleted; administrators keep them, cancelled, in the lead's history.
  -- A lead's first agent, and a lead left with no agent, keep them.
  if p_owner is not null and previous is distinct from p_owner and public.workspace_since(p_lead) is not null then
    -- Each cancellation names the lead, the new agent (agent_id), whose
    -- commitment it was (user_id) and its day, for Audit history.
    with gone as (update public.followups set status='cancelled' where lead_id=p_lead and status='pending'
      returning id,agent_id,due_at)
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      select p_actor,'followup.reassignment_cancelled','followups',gone.id::text,p_request,
        jsonb_build_object('lead_id',p_lead,'agent_id',p_owner,'user_id',gone.agent_id,'previous_agent_id',previous,
          'due_on',to_char(gone.due_at at time zone 'Asia/Karachi','YYYY-MM-DD')) from gone;
    get diagnostics f=row_count;
    with gone as (update public.visits set status='cancelled' where lead_id=p_lead and status='scheduled'
      returning id,agent_id,scheduled_at)
    insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
      select p_actor,'visit.reassignment_cancelled','visits',gone.id::text,p_request,
        jsonb_build_object('lead_id',p_lead,'agent_id',p_owner,'user_id',gone.agent_id,'previous_agent_id',previous,
          'visit_on',to_char(gone.scheduled_at at time zone 'Asia/Karachi','YYYY-MM-DD')) from gone;
    get diagnostics v=row_count;
    delete from public.reminders m using public.followups x
      where m.followup_id=x.id and x.lead_id=p_lead and x.status='cancelled' and m.read_at is null;
    get diagnostics r=row_count;
    return jsonb_build_object('followups',0,'visits',0,'reminders',0,
      'cancelled_followups',f,'cancelled_visits',v,'removed_reminders',r);
  end if;
  update public.followups set agent_id=recipient where lead_id=p_lead and status='pending' and agent_id is distinct from recipient;
$t$),
  -- An earlier assignment's deal shows to the new agent only once it changes
  -- during their assignment.
  ('public.workspace_item(text,uuid,timestamp with time zone,uuid,text,timestamp with time zone,timestamp with time zone)',
   $t$  when p_kind='deals' and (p_status in ('discussion','negotiation') or p_updated>w.since) then 'carried'
$t$,
   $t$  when p_kind='deals' and p_updated>w.since then 'carried'
$t$),
  -- The earlier assignment's result is no longer given to the new agent.
  ('public.lead_workspace(uuid)',
   $t$   'previous_result',case when l.first_call_at is null and (
     (l.status='lost' and l.lost_reason='not_interested' and l.lost_at<w.since)
     or (select c.outcome from public.calls c where c.lead_id=l.id and c.created_at<w.since
      and c.created_at>=(select max(a.created_at) from public.assignments a
       where a.lead_id=l.id and a.agent_id is not null and a.created_at<w.since)
      order by c.started_at desc,c.created_at desc,c.id desc limit 1)='Not interested') then 'not_interested' end,
$t$,
   $t$   'previous_result',null,
$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 067 found an unexpected version of %: apply CRM updates up to 066 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
commit;
