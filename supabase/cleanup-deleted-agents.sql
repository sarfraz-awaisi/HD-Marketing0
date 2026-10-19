-- PERMANENT CLEANUP. Run preview-deleted-agent-cleanup.sql first. Cannot be undone.
-- Removes deleted Agent accounts that have no work history: profile, login and
-- account bookkeeping. Runs as one transaction: any error changes nothing.
-- Checks only Agent accounts already deleted in the CRM (sign-in removed).
-- Active agents and every admin are never touched. Any link to work history
-- (leads, calls, notes, follow-ups, visits, deals, targets, audit actions,
-- security records, ...) keeps the account. Only account bookkeeping is
-- removed together with it.
create or replace function pg_temp.cleanup_deleted_agents(p_apply boolean)
returns table(agent_uid integer, result text, details text) language plpgsql as $$
declare agent record;link record;linked bigint;history text;checked integer=0;
begin
 for agent in
  select p.id,p.uid from public.profiles p
  where p.role='agent' and p.deleted_at is not null
   and not exists(select 1 from auth.users u where u.id=p.id and nullif(to_jsonb(u)->>'deleted_at','') is null)
  order by p.uid
 loop
  checked=checked+1;history=null;
  for link in
   select format('%I.%I',n.nspname,t.relname) tbl,a.attname col
   from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
   join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
   where c.contype='f' and cardinality(c.conkey)=1
    and (c.confrelid='public.profiles'::regclass
     or (c.confrelid='auth.users'::regclass and n.nspname<>'auth' and t.oid<>'public.profiles'::regclass))
    and format('%I.%I.%I',n.nspname,t.relname,a.attname) not in
     ('crm_private.account_deletions.user_id','crm_private.account_uid_review.profile_id','public.account_invitations.user_id')
  loop
   execute format('select count(*) from %s where %I=$1',link.tbl,link.col) into linked using agent.id;
   if linked>0 then history=concat_ws(', ',history,format('%s.%s: %s',link.tbl,link.col,linked));end if;
  end loop;
  agent_uid=agent.uid;
  if history is not null then
   result='kept (has work history)';details=history;
  elsif not p_apply then
   result='will be removed';details='Deleted in the CRM and has no work history';
  else
   delete from crm_private.account_deletions where user_id=agent.id;
   delete from crm_private.account_uid_review where profile_id=agent.id;
   delete from public.account_invitations where user_id=agent.id;
   delete from public.account_provisioning where id=agent.id;
   delete from public.account_creation_events where request_id=agent.id;
   delete from public.account_creation_requests where id=agent.id;
   delete from public.profiles where id=agent.id;
   delete from auth.users where id=agent.id;
   insert into public.audit_log(action,entity,entity_id,request_id,metadata)
    values('account.purged','profiles',agent.id::text,'cleanup-deleted-agents',jsonb_build_object('uid',agent.uid,'role','agent'));
   result='removed permanently';details='Profile and login removed; this UID can be reused';
  end if;
  return next;
 end loop;
 if checked=0 then
  agent_uid=null;result='nothing to remove';details='No deleted Agent accounts were found';return next;
 end if;
end $$;
select * from pg_temp.cleanup_deleted_agents(true);
