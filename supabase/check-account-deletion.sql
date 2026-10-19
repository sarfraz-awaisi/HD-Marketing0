-- Read-only check for the exact prerequisites required by update 028.
-- Run in the same Supabase project where 028 reported its error.
-- Returns schema flags only; no customer or account data.
select
  to_regprocedure('public.handover_lead(uuid,uuid,uuid,text)') is not null as update_022_handover,
  to_regclass('public.account_invitations') is not null as update_023_invitations,
  to_regprocedure('public.dashboard_snapshot(uuid,timestamptz,timestamptz)') is not null as update_027_performance;
