-- Apply once after migration 019. No Auth user is automatically confirmed.
begin;

create or replace function public.account_action(p_actor uuid,p_session text,p_unlock text,p_target uuid,p_action text,p_request text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.accounts_gate(p_actor,p_session,p_unlock);
  if p_action not in ('create_account_requested','set_password_requested','set_password_completed','set_password_failed','email_confirmation_requested','email_confirmation_sent','email_confirmation_failed') then raise exception 'Invalid account action' using errcode='22023'; end if;
  if p_action<>'create_account_requested' then
    perform id from public.profiles where id=p_target for share;
    if not found then raise exception 'Account not found' using errcode='P0002'; end if;
    if p_target=p_actor then raise exception 'Use your own password recovery flow to change your login password' using errcode='22023'; end if;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id) values(p_actor,p_action,'profiles',p_target::text,p_request);
end $$;

revoke all on function public.account_action(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.account_action(uuid,text,text,uuid,text,text) to service_role;

commit;
