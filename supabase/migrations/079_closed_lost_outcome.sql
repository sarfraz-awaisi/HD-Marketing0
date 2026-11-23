-- Update 079: the call outcome "Closed lost": the customer answered and the
-- sales opportunity is over. Apply after 078. Safe to rerun. No row changes.
--
-- * calls accept the outcome (calls_outcome_check). As an answered outcome it
--   needs a connected call, like Interested or Not interested.
-- * The call-outcome filters of All leads, the agents' lead lists and the
--   administrators' agent pipeline accept it, with their existing meaning
--   (the lead's latest call). File exports accept it too.
-- * It does not move the lead's stage (call_outcome_stage has no mapping):
--   marking a lead Lost still needs a lost reason through the existing
--   stage change. It creates and closes no follow-up.
begin;
set local lock_timeout='5s';
do $$
declare current text=(select pg_get_constraintdef(oid) from pg_constraint
  where conrelid='public.calls'::regclass and conname='calls_outcome_check');
begin
 if to_regprocedure('public.call_outcome_stage(text)') is null then
  raise exception 'Apply CRM updates up to 078 before update 079.';
 end if;
 if current is distinct from $c$CHECK ((outcome = ANY (ARRAY['No answer'::text, 'Busy'::text, 'Wrong number'::text, 'Number off'::text, 'Interested'::text, 'Not interested'::text, 'Follow-up required'::text, 'Site visit scheduled'::text, 'Deal discussion'::text])))$c$
  and position('''Closed lost''' in coalesce(current,''))=0 then
  raise exception 'Update 079 found an unexpected calls_outcome_check: apply CRM updates up to 078 exactly.';
 end if;
end $$;
alter table public.calls drop constraint calls_outcome_check;
alter table public.calls add constraint calls_outcome_check check(outcome=any(array['No answer','Busy','Wrong number',
 'Number off','Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion','Closed lost']));

-- Checked edits, as in update 061: each text must appear exactly once, or
-- the update stops and changes nothing; edited text is left alone.
do $patch$
declare item record; body text; n int;
 old_text constant text=$t$'Site visit scheduled','Deal discussion'$t$;
 new_text constant text=$t$'Site visit scheduled','Deal discussion','Closed lost'$t$;
begin
 for item in select unnest(array['public.admin_lead_list(uuid,jsonb)','public.agent_lead_list(uuid,jsonb)',
   'public.admin_agent_pipeline(uuid,uuid,jsonb)','public.lead_export_match(jsonb)','public.lead_file_export_match(jsonb)']) signature loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,old_text,'')))/length(old_text);
  if n<>1 then
   raise exception 'Update 079 found an unexpected version of %: apply CRM updates up to 078 exactly.',item.signature;
  end if;
  execute replace(body,old_text,new_text);
 end loop;
end $patch$;
commit;
