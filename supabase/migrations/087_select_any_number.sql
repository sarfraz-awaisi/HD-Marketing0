-- Update 087: administrators select any number of leads. Select all takes
-- every matching lead, however many, and "first" takes as many leads from
-- the top of the list as asked (update 086 allowed 500, or 2,000 on Never
-- assigned). Apply after 086. Safe to rerun. No table, row or trigger
-- changes: one list is edited.
--
-- What is done with the selected leads still goes to the database at most
-- 500 leads per call, as before (Assign to agents, Round-robin unassigned,
-- Delete and its preview): the server works through a larger selection 500
-- at a time, so every call stays well inside the database's time limit.
-- After this update, rerunning update 086 stops with its own message and
-- changes nothing, as earlier list updates do once later ones are applied.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or position('v_first' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0 then
  raise exception 'Apply CRM updates up to 086 before update 087.';
 end if;
end $$;
-- Checked edits, as in updates 061 to 086: each text must appear exactly
-- once, or the update stops and changes nothing. On a rerun the edited text
-- is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ($t$ if v_first is not null and (not v_ids or v_first not between 1 and case when v_never is null then 500 else 2000 end) then$t$,
   $t$ -- Update 087: as many as asked.
 if v_first is not null and (not v_ids or v_first<1) then$t$),
  ($t$ -- Update 086: Never assigned selects up to 2,000 leads; the first
 -- leads are taken however many match.
 if v_ids and v_first is null and v_never is not null and (result->>'count')::bigint>2000 then
  raise exception 'Choose filters that match 2,000 leads or fewer to select them all.' using errcode='22023';
 end if;
 if v_ids and v_first is null and v_never is null and (result->>'count')::bigint>500 then
  raise exception 'Choose filters that match 500 leads or fewer to select them all.' using errcode='22023';
 end if;$t$,
   $t$ -- Update 087: Select all takes every matching lead, however many.$t$)
 ) v(old_text,new_text) loop
  body=pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 087 found an unexpected version of admin_lead_list: apply CRM updates up to 086 exactly.';
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
