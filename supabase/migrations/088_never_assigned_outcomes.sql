-- Update 088: administrators' Never assigned page leaves out the leads an
-- agent is working on, by the outcome of the lead's latest call with an
-- outcome saved: Interested, Follow-up required, Site visit scheduled, Deal
-- discussion or Closed lost. Leads with no outcome saved stay. The page can
-- also keep only some of the other outcomes (No answer, Busy, Wrong number,
-- Number off, Not interested), any of them. Apply after 087. Safe to rerun.
-- No table, row or trigger changes: two functions are edited.
--
-- admin_lead_list:
-- * reassignable (the Never assigned page, with or without agents chosen;
--   always with never_assigned or outcomes) leaves those leads out of the
--   rows, counts, pages and Select all;
-- * outcomes: one or more of the five others; a lead matches when its
--   latest saved outcome is any of them.
-- All leads and every other list are unchanged.
-- admin_distribute_never_assigned (Assign to agents from Never assigned)
-- keeps those leads where they are, checked again under the assignment lock
-- when confirmed, and a preview is out of date once a selected lead's
-- latest saved outcome changes. After this update, rerunning update 084
-- stops with its own message and changes nothing, as earlier list updates
-- do once later ones are applied.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or position('Update 087' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0
  or to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is null then
  raise exception 'Apply CRM updates up to 087 before update 088.';
 end if;
end $$;
-- Checked edits, as in updates 061 to 087: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('public.admin_lead_list(uuid,jsonb)',
   $t$v_agents uuid[];v_never uuid[];$t$,
   $t$v_agents uuid[];v_never uuid[];v_outcomes text[];v_open boolean;$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$'usage','agents','never_assigned')
    or (e.key not in ('agents','never_assigned') and jsonb_typeof(e.value) not in ('string','number','boolean'))
    or (e.key in ('agents','never_assigned') and jsonb_typeof(e.value)<>'array')) then$t$,
   $t$'usage','agents','never_assigned','reassignable','outcomes')
    or (e.key not in ('agents','never_assigned','outcomes') and jsonb_typeof(e.value) not in ('string','number','boolean'))
    or (e.key in ('agents','never_assigned','outcomes') and jsonb_typeof(e.value)<>'array')) then$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$v_never=case when q->'never_assigned' is not null then array(select x::uuid from jsonb_array_elements_text(q->'never_assigned') x) end;$t$,
   $t$v_never=case when q->'never_assigned' is not null then array(select x::uuid from jsonb_array_elements_text(q->'never_assigned') x) end;
  v_outcomes=case when q->'outcomes' is not null then array(select x from jsonb_array_elements_text(q->'outcomes') x) end;
  v_open=coalesce((q->>'reassignable')::boolean,false);$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$ -- Update 086: the first leads, only when asking for IDs.$t$,
   $t$ -- Update 088: Never assigned, by the latest saved call outcome; with
 -- agents or outcomes chosen, always. Outcomes: any of the five an agent is
 -- not working on, not with outcome.
 v_open=v_open or v_never is not null or v_outcomes is not null;
 if v_outcomes is not null and (v_outcome is not null or cardinality(v_outcomes) not between 1 and 5
  or (select count(distinct x) from unnest(v_outcomes) x)<>cardinality(v_outcomes)
  or exists(select 1 from unnest(v_outcomes) x where x is null
   or x not in ('No answer','Busy','Wrong number','Number off','Not interested'))) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 -- Update 086: the first leads, only when asking for IDs.$t$),
  ('public.admin_lead_list(uuid,jsonb)',
   $t$   and (v_outcome is null or (select c.outcome from public.calls c where c.lead_id=l.id
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) is not distinct from v_outcome)$t$,
   $t$   and (v_outcome is null or (select c.outcome from public.calls c where c.lead_id=l.id
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) is not distinct from v_outcome)
   -- Update 088: on Never assigned, the outcome of the latest call with one
   -- saved is never Interested, Follow-up required, Site visit scheduled,
   -- Deal discussion or Closed lost; with outcomes chosen, one of them.
   -- Leads with no outcome saved stay unless outcomes are chosen.
   and (not v_open or (select case when v_outcomes is null then o.outcome is null
     or o.outcome not in ('Interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost')
    else o.outcome=any(v_outcomes) end
    from (select (select c.outcome from public.calls c where c.lead_id=l.id and c.outcome is not null
     order by c.started_at desc,c.created_at desc,c.id desc limit 1) outcome) o))$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$   ||coalesce(l.status,'-')||':'||coalesce(public.lead_first_call_reopened(l.id)::text,'-')||':'$t$,
   $t$   ||coalesce(l.status,'-')||':'||coalesce(public.lead_first_call_reopened(l.id)::text,'-')||':'
   -- Update 088: and the outcome of its latest call with one saved.
   ||coalesce((select c.outcome from public.calls c where c.lead_id=x.id and c.outcome is not null
    order by c.started_at desc,c.created_at desc,c.id desc limit 1),'-')||':'$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$    union select l.assigned_agent where l.assigned_agent is not null) had
  from public.active_leads l$t$,
   $t$    union select l.assigned_agent where l.assigned_agent is not null) had,
   -- Update 088: the outcome of its latest call with one saved.
   (select c.outcome from public.calls c where c.lead_id=l.id and c.outcome is not null
    order by c.started_at desc,c.created_at desc,c.id desc limit 1) last_outcome
  from public.active_leads l$t$),
  ('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)',
   $t$  elsif item.status in ('won','lost') and not public.lead_first_call_reopened(item.id) then$t$,
   $t$  -- Update 088: never a lead an agent is working on, as the Never
  -- assigned page leaves out.
  elsif item.last_outcome in ('Interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost') then
   v_entry=jsonb_build_object('id',item.id,'name',item.name,'result','kept','reason','Latest call outcome is '||item.last_outcome||': '||v_stays);
  elsif item.status in ('won','lost') and not public.lead_first_call_reopened(item.id) then$t$)
 ) v(fn,old_text,new_text) loop
  body=pg_get_functiondef(item.fn::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 088 found an unexpected version of %: apply CRM updates up to 087 exactly.',item.fn;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
