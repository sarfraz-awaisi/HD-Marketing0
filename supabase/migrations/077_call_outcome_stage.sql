-- Update 077: a call's outcome moves its lead along the pipeline. Apply
-- after 076. Safe to rerun.
--
-- * An answered call already moved a new lead to Contacted. Its outcome now
--   moves the lead forward too: Interested -> Interested, Site visit
--   scheduled -> Site visit scheduled, Deal discussion -> Negotiation. As
--   with every automatic change, a lead never moves backwards and a won or
--   lost lead is not reopened (advance_lead_status).
-- * Existing leads move once to the furthest stage their earlier calls
--   show. Each move is recorded in the lead's stage history at the time of
--   the call that showed it, by that call's agent, and in the audit log,
--   both with request "update-077". Won, lost and deleted leads, and every
--   call, visit, deal and follow-up, stay as they are.
begin;
set local lock_timeout='5s';
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='kpi_versions' and column_name='expect_yes') then
  raise exception 'Apply CRM updates up to 076 before update 077.';
 end if;
end $$;

-- The stage a call outcome shows, or null for outcomes that show none.
create or replace function public.call_outcome_stage(p_outcome text) returns text
language sql immutable set search_path='' as $$
 select case p_outcome when 'Interested' then 'interested'
  when 'Site visit scheduled' then 'visit_scheduled'
  when 'Deal discussion' then 'negotiation' end $$;
revoke all on function public.call_outcome_stage(text) from public,anon,authenticated,service_role;

-- A checked edit, as in update 061: the text must appear exactly once, or
-- the update stops and changes nothing. On a rerun the edited text is found
-- and left alone.
do $patch$
declare body text; n int;
 old_text text=$t$  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;$t$;
 new_text text=$t$  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
    -- Update 077: the outcome moves the lead forward.
    if public.call_outcome_stage(p_data->>'outcome') is not null then
      perform public.advance_lead_status(customer.id,public.call_outcome_stage(p_data->>'outcome'),p_actor,p_request);
    end if;
  end if;$t$;
begin
 body=pg_get_functiondef('public.log_manual_call(uuid,uuid,jsonb,text)'::regprocedure);
 if position(new_text in body)=0 then
  n=(length(body)-length(replace(body,old_text,'')))/length(old_text);
  if n<>1 then
   raise exception 'Update 077 found an unexpected version of public.log_manual_call: apply CRM updates up to 076 exactly.';
  end if;
  execute replace(body,old_text,new_text);
 end if;
end $patch$;

-- Existing leads: the furthest stage any of their answered calls shows,
-- dated by the first call that showed it. Only a lead still at the stage
-- read here is moved.
do $backfill$
declare r record;
 stages text[]=array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'];
begin
 for r in
  select l.id,l.status,x.stage,x.started_at,x.agent_id from public.active_leads l
  cross join lateral (
   select public.call_outcome_stage(c.outcome) stage,c.started_at,c.agent_id from public.calls c
   where c.lead_id=l.id and c.answered and public.call_outcome_stage(c.outcome) is not null
   order by array_position(stages,public.call_outcome_stage(c.outcome)) desc,c.started_at limit 1) x
  where l.status not in ('won','lost') and array_position(stages,x.stage)>array_position(stages,l.status)
  order by l.id
 loop
  perform set_config('hd.actor_id',coalesce(r.agent_id::text,''),true);
  perform set_config('hd.request_id','update-077',true);
  perform set_config('hd.changed_fields','["status"]',true);
  update public.leads set status=r.stage where id=r.id and status=r.status;
  update public.lead_status_history set created_at=r.started_at
   where lead_id=r.id and request_id='update-077' and to_status=r.stage and created_at>r.started_at;
 end loop;
 perform set_config('hd.actor_id','',true);
 perform set_config('hd.request_id','',true);
end $backfill$;
commit;
