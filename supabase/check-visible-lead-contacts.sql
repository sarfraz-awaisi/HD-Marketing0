-- Read-only prerequisite check. Run in the Supabase project used by the CRM.
-- Returns schema presence only; no customer records, passwords or keys.
select
  to_regclass('public.profiles') is not null as profiles,
  to_regclass('public.leads') is not null as leads,
  to_regclass('public.audit_log') is not null as audit_log,
  to_regclass('crm_private.lead_phones') is not null as lead_phones,
  to_regclass('crm_private.phone_reveals') is not null as phone_reveals;
