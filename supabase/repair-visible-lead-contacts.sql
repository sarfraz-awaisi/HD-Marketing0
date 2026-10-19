-- HD Marketing CRM: repeatable repair for automatically visible lead contacts.
-- Run the ENTIRE file in the SQL Editor of the Supabase project used by the CRM.
-- Customer records, assignments and existing audit history are not changed.
begin;

do $$
declare missing_tables text;
begin
  select string_agg(required.name,', ' order by required.name) into missing_tables
  from (values ('public.profiles'),('public.leads'),('public.audit_log'),
    ('crm_private.lead_phones')) required(name)
  where to_regclass(required.name) is null;
  if missing_tables is not null then
    raise exception 'Required CRM tables are missing: %',missing_tables
      using hint='Run check-visible-lead-contacts.sql. Check the selected project and its earlier CRM migrations before applying this repair.';
  end if;
end $$;

-- Restore only the missing migration-019 history table. Existing rows are kept.
create table if not exists crm_private.phone_reveals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  revealed_at timestamptz not null default now()
);
create index if not exists phone_reveals_user_time
  on crm_private.phone_reveals(user_id,revealed_at) include (lead_id);
alter table crm_private.phone_reveals enable row level security;
revoke all on crm_private.phone_reveals from public,anon,authenticated;
grant all on crm_private.phone_reveals to service_role;

create or replace function public.lead_contact_phones(p_actor uuid,p_leads uuid[],p_request text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; locked integer; result jsonb;
begin
  select * into actor from public.profiles where id=p_actor and active for share;
  if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_leads is null or cardinality(p_leads) not between 1 and 100 or
    (select count(distinct id) from unnest(p_leads) id)<>cardinality(p_leads) then
    raise exception 'Invalid contact selection' using errcode='22023';
  end if;
  perform 1 from public.leads where id=any(p_leads)
    and (actor.role='admin' or assigned_agent=p_actor) order by id for share;
  get diagnostics locked=row_count;
  if locked<>cardinality(p_leads) then raise exception 'Lead not found' using errcode='P0002'; end if;
  insert into crm_private.phone_reveals(user_id,lead_id)
    select p_actor,l.id from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  insert into public.audit_log(actor_id,action,entity,entity_id,request_id,metadata)
    select p_actor,'lead.phone_revealed','leads',l.id::text,p_request,
      jsonb_build_object('fields',jsonb_build_array('user_id','lead_id','revealed_at'))
    from public.leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  select jsonb_build_object('phones',coalesce(jsonb_object_agg(l.id::text,p.phone),'{}'::jsonb))
    into result from public.leads l left join crm_private.lead_phones p on p.lead_id=l.id where l.id=any(p_leads);
  return result;
end $$;
revoke all on function public.lead_contact_phones(uuid,uuid[],text) from public,anon,authenticated;
grant execute on function public.lead_contact_phones(uuid,uuid[],text) to service_role;

-- PostgreSQL delivers this notification when the transaction commits.
-- Preserve the newer deleted-lead visibility rule if this compatibility repair
-- is used after 032. The vault and read ledger remain unchanged.
do $repair$ declare body text;begin
 if to_regclass('public.active_leads') is not null then
  body=pg_get_functiondef('public.lead_contact_phones(uuid,uuid[],text)'::regprocedure);
  body=replace(body,'from public.leads','from public.active_leads');execute body;
 end if;
end $repair$;
notify pgrst, 'reload schema';
commit;

select
  'Visible lead contacts repaired; database API refresh requested' as status,
  to_regclass('crm_private.phone_reveals') is not null as phone_history_ready,
  to_regprocedure('public.lead_contact_phones(uuid,uuid[],text)') is not null as phone_function_installed,
  has_function_privilege('service_role','public.lead_contact_phones(uuid,uuid[],text)','execute') as server_access_ready;
