-- Update 078: production catches up with the repository in two functions.
-- Schema-only restores of the 17 and 21 November production backups showed
-- every other function, column and trigger matching. Apply after 077. Safe
-- to rerun. No row is changed: earlier calls, first-call times, reports and
-- audit entries stay as they are.
--
-- * log_manual_call says who logs a call before saving it (update 061), so
--   record_first_call knows an administrator's call. Without it, a call an
--   administrator logs on an agent's lead counts as the agent's first call:
--   it clears New and the deadline and credits the agent. Agents' own calls
--   are unchanged.
-- * account_action_034 accepts the email confirmation actions (update 020;
--   update 035 renamed the function). Without them "Send verification
--   email" fails with "Invalid account action". The Accounts gate (an
--   administrator with an unlocked PIN session) is unchanged.
--
-- Each edit is checked: the text must appear exactly once, or the update
-- stops and changes nothing. Text already edited is left alone, so on a
-- database that already matches the repository this changes nothing.
-- Ownership, SECURITY DEFINER, search_path and grants are kept by
-- CREATE OR REPLACE.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.call_outcome_stage(text)') is null then
  raise exception 'Apply CRM updates up to 077 before update 078.';
 end if;
end $$;

do $patch$
declare item record; body text; n int;
begin
 for item in select * from (values
  ('public.log_manual_call(uuid,uuid,jsonb,text)',
   $t$    raise exception 'Choose distinct supported tags' using errcode='23514';
  end if;
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,$t$,
   $t$    raise exception 'Choose distinct supported tags' using errcode='23514';
  end if;
  perform set_config('hd.actor_id',p_actor::text,true);
  insert into public.calls(lead_id,agent_id,method,answered,status,started_at,ended_at,$t$),
  ('public.account_action_034(uuid,text,text,uuid,text,text)',
   $t$'set_password_failed') then raise exception 'Invalid account action'$t$,
   $t$'set_password_failed','email_confirmation_requested','email_confirmation_sent','email_confirmation_failed') then raise exception 'Invalid account action'$t$)
 ) v(signature,old_text,new_text) loop
  body=pg_get_functiondef(item.signature::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 078 found an unexpected version of %: apply CRM updates up to 077 exactly.',item.signature;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
commit;
