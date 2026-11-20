-- Read-only check for update 077 (call outcomes move the lead's stage).
-- Changes nothing. Run before and after applying 077.
--
-- release_stage: "at 077", "at 076, ready for 077", or NOT READY.
-- leads_to_move: open leads whose answered calls show a later stage than
--   the lead has (what 077 moves; "none" once applied).
-- open_by_stage: open leads (not won, lost or deleted) by current stage.
with stages(s) as (select array['new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost']),
fn as (select pg_get_functiondef('public.log_manual_call(uuid,uuid,jsonb,text)'::regprocedure) body),
shown as (
 select l.id,l.status,max(array_position((select s from stages),case c.outcome when 'Interested' then 'interested'
   when 'Site visit scheduled' then 'visit_scheduled' when 'Deal discussion' then 'negotiation' end)) best
 from public.active_leads l join public.calls c on c.lead_id=l.id and c.answered
 where l.status not in ('won','lost') group by l.id,l.status)
select
 case
  when (select body from fn) like '%call_outcome_stage(p_data->>''outcome'')%' then 'at 077'
  when exists(select 1 from information_schema.columns where table_schema='public' and table_name='kpi_versions' and column_name='expect_yes')
   and (select (length(body)-length(replace(body,$t$  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;$t$,'')))/length($t$  if did_answer then
    perform public.advance_lead_status(customer.id,'contacted',p_actor,p_request);
  end if;$t$) from fn)=1 then 'at 076, ready for 077'
  else 'NOT READY: log_manual_call differs or 076 is missing' end release_stage,
 (select count(*) from public.active_leads) active_leads,
 coalesce((select string_agg(t||' '||n,' | ' order by p) from (
   select (select s from stages)[best] t,best p,count(*) n from shown
   where best>array_position((select s from stages),status) group by best) x),'none') leads_to_move,
 coalesce((select string_agg(status||' '||n,' | ' order by array_position((select s from stages),status)) from (
   select status,count(*) n from public.active_leads where status not in ('won','lost') group by status) x),'none') open_by_stage,
 (select count(*) from public.lead_status_history where request_id='update-077') history_rows_077,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min;
