-- Read-only check for update 087 (select any number of leads). Changes
-- nothing and shows counts only, no customer details. Before:
-- release_stage = 'at 086, ready for 087' and edits_fit true. After:
-- 'at 087'. active_leads is how many Select all can now take at most.
with s as (select pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure) body)
select
 case when position('Update 087' in body)>0 then 'at 087'
  when position('v_first' in body)>0 then 'at 086, ready for 087'
  else 'NOT READY: apply CRM updates up to 086 exactly' end release_stage,
 -- Each text update 087 edits appears exactly once (before 087 only).
 case when position('Update 087' in body)=0 then (select bool_and((length(body)-length(replace(body,v.t,'')))/length(v.t)=1) from (values
  ($t$ if v_first is not null and (not v_ids or v_first not between 1 and case when v_never is null then 500 else 2000 end) then$t$),
  ($t$ -- Update 086: Never assigned selects up to 2,000 leads; the first
 -- leads are taken however many match.
 if v_ids and v_first is null and v_never is not null and (result->>'count')::bigint>2000 then
  raise exception 'Choose filters that match 2,000 leads or fewer to select them all.' using errcode='22023';
 end if;
 if v_ids and v_first is null and v_never is null and (result->>'count')::bigint>500 then
  raise exception 'Choose filters that match 500 leads or fewer to select them all.' using errcode='22023';
 end if;$t$)) v(t)) end edits_fit,
 (select count(*) from public.active_leads) active_leads,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
