-- Read-only check for update 065 (each number's country: flags and the
-- Country filter). Run it in the CRM's Supabase SQL Editor before 065 and
-- right after it. It is one SELECT: it changes nothing and returns flags and
-- counts only, no customer or account details.
-- Before 065: release_stage = 'at 064, ready for 065' and
-- transactions_open_over_1_min = 0. Note the counts; after 065 they must be
-- the same (apart from new activity).
-- After 065: release_stage = 'at 065', country_rules = 245,
-- browser_access_must_be_0 = 0 and helper_access_must_be_0 = 0;
-- numbers_by_country shows how many lead numbers each country has.
select
 case
  when to_regprocedure('public.phone_country(text)') is not null then 'at 065'
  when exists(select 1 from pg_constraint where conname='sheet_row_rejections_reason_check'
   and pg_get_constraintdef(oid) like '%phone_needs_country%') then 'at 064, ready for 065'
  else 'NOT READY: apply update 064 first'
 end as release_stage,
 -- Existing records, compared before and after 065.
 (select count(*) from public.leads where deleted_at is null) as leads_not_deleted,
 (select count(*) from crm_private.lead_phones) as lead_numbers,
 (select count(*) from public.calls) as existing_calls,
 (select count(*) from public.assignments) as existing_assignments,
 (select count(*) from public.audit_log) as existing_audit_entries,
 -- The rules (reference data, 245 for libphonenumber-js 1.13.15).
 case when to_regclass('crm_private.phone_country_rules') is not null then
  (xpath('/row/n/text()',query_to_xml('select count(*) n from crm_private.phone_country_rules',false,true,'')))[1]::text::integer
 end as country_rules,
 -- Lead numbers per country (unknown: no one country), counts only.
 case when to_regprocedure('public.phone_country(text)') is not null then
  (xpath('/row/v/text()',query_to_xml('select coalesce(jsonb_object_agg(c,n order by n desc,c),''{}'')::text v from (select coalesce(public.phone_country(phone),''unknown'') c,count(*) n from crm_private.lead_phones group by 1) x',false,true,'')))[1]::text
 end as numbers_by_country,
 -- Browsers reach neither the rules nor the helpers; the list functions
 -- use the helpers, the API server does not call them directly.
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('phone_country','lead_phone_country','admin_lead_list','agent_lead_list','admin_agent_pipeline')
  and (has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute')))
 + case when to_regclass('crm_private.phone_country_rules') is not null
    and (has_table_privilege('anon','crm_private.phone_country_rules','select')
     or has_table_privilege('authenticated','crm_private.phone_country_rules','select')) then 1 else 0 end
  as browser_access_must_be_0,
 (select count(*) from pg_proc f where f.pronamespace='public'::regnamespace
  and f.proname in ('phone_country','lead_phone_country')
  and has_function_privilege('service_role',f.oid,'execute')) as helper_access_must_be_0,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') as transactions_open_over_1_min;
