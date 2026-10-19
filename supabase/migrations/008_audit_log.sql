create table public.audit_log(id bigint generated always as identity primary key,actor_id uuid references public.profiles(id),action text not null,entity text not null,entity_id text,request_id text,metadata jsonb not null default '{}',created_at timestamptz not null default now());
create table public.integration_events(provider text not null,event_id text not null,created_at timestamptz not null default now(),primary key(provider,event_id));
create function public.block_audit_changes() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Audit records are append-only'; end $$;
create trigger audit_immutable before update or delete on public.audit_log for each row execute function public.block_audit_changes();
