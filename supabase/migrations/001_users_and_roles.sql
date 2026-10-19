create extension if not exists pgcrypto;
create table public.profiles (id uuid primary key references auth.users(id), name text not null, role text not null default 'agent' check(role in ('admin','agent')), active boolean not null default true, created_at timestamptz not null default now());
create schema if not exists crm_private;
revoke all on schema crm_private from public, anon, authenticated;
grant usage on schema crm_private to service_role;
create function public.create_profile() returns trigger language plpgsql security definer set search_path = '' as $$ begin insert into public.profiles(id,name) values(new.id,coalesce(new.raw_user_meta_data->>'name', 'Team member')); return new; end $$;
create trigger auth_profile after insert on auth.users for each row execute function public.create_profile();
revoke all on function public.create_profile() from public,anon,authenticated;
create function public.touch_updated() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;
