-- Update 086: Select all on administrators' Never assigned page selects up
-- to 2,000 matching leads instead of 500, so the leads never assigned to the
-- chosen agents can all be assigned at once; and administrators can select
-- just the first leads of a list, as many as they type. Apply after 085.
-- Safe to rerun. No table, row or trigger changes: one list is edited.
--
-- admin_lead_list, when asked for IDs (Select all):
-- * returns up to 2,000 when never_assigned is given (Never assigned with
--   agents chosen); every other list keeps 500;
-- * takes first: that many leads from the top of the list, in the order the
--   list shows them (#1, #2, …), even when more leads match than Select all
--   takes; at most 2,000 with never_assigned, 500 otherwise.
-- Assign to agents still works on at most 500 leads per call (update 084's
-- function is unchanged): the server works through a larger selection 500
-- at a time, each part with its own preview check, so every call stays well
-- inside the database's time limit.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)') is null
  or position('never_assigned' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0
  or to_regprocedure('public.kpi_measures(date,date,uuid,timestamp with time zone)') is null
  or position('today_calls' in pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 085 before update 086.';
 end if;
end $$;
-- Checked edits, as in updates 061 to 085: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone. Update 084's edited texts stay whole.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ($t$v_ids boolean;v_limit constant integer=20;$t$,
   $t$v_ids boolean;v_first integer;v_limit constant integer=20;$t$),
  ($t$where e.key not in ('search',$t$,
   $t$where e.key not in ('first','search',$t$),
  ($t$v_ids=coalesce((q->>'ids')::boolean,false);$t$,
   $t$v_ids=coalesce((q->>'ids')::boolean,false);v_first=(q->>'first')::integer;$t$),
  ($t$ if v_search is not null then
  v_digits=regexp_replace($t$,
   $t$ -- Update 086: the first leads, only when asking for IDs.
 if v_first is not null and (not v_ids or v_first not between 1 and case when v_never is null then 500 else 2000 end) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if v_search is not null then
  v_digits=regexp_replace($t$),
  ($t$'ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from kept where matches))$t$,
   $t$'ids',case when v_first is null then (select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from kept where matches)
   -- Update 086: the first leads in the list's order, as many as asked.
   else (select coalesce(jsonb_agg(o.id order by o.rn),'[]'::jsonb) from ordered o where o.rn<=v_first) end)$t$),
  ($t$ if v_ids and (result->>'count')::bigint>500 then$t$,
   $t$ -- Update 086: Never assigned selects up to 2,000 leads; the first
 -- leads are taken however many match.
 if v_ids and v_first is null and v_never is not null and (result->>'count')::bigint>2000 then
  raise exception 'Choose filters that match 2,000 leads or fewer to select them all.' using errcode='22023';
 end if;
 if v_ids and v_first is null and v_never is null and (result->>'count')::bigint>500 then$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 086 found an unexpected version of admin_lead_list: apply CRM updates up to 085 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
