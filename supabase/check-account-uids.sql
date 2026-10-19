-- Read-only check for account UID update 036. Run in the Supabase project used
-- by the CRM, before and after installing 036. Returns flags only; no names,
-- emails, passwords or keys. Before 036: update_035_installed must be true.
-- After 036: every column should be true.
select
  to_regclass('public.account_creation_requests') is not null as update_035_installed,
  exists(select 1 from information_schema.columns
   where table_schema='public' and table_name='profiles' and column_name='uid') as uid_column,
  exists(select 1 from information_schema.columns
   where table_schema='public' and table_name='profiles' and column_name='uid' and is_nullable='NO') as uid_required,
  exists(select 1 from pg_constraint
   where conrelid='public.profiles'::regclass and conname='profiles_uid_key') as uid_unique,
  exists(select 1 from pg_constraint
   where conrelid='public.profiles'::regclass and conname='profiles_uid_range') as uid_six_digits,
  to_regprocedure('public.begin_account_provisioning(uuid,text,text,uuid,text,text,text,boolean,integer,text)') is not null as direct_creation_ready;
