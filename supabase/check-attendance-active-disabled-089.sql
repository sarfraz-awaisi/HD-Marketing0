-- Read-only check for update 089 (Attendance Management never shows deleted
-- accounts). Changes nothing and shows counts only, no names. Before:
-- release_stage = 'at 088, ready for 089' and edits_fit true. After:
-- 'at 089'. active_employees and disabled_employees are what the Employee
-- tabs show (accounts with attendance); deleted_hidden is how many deleted
-- accounts with attendance Attendance Management stops showing.
with f(fn,body) as (
 select x,pg_get_functiondef(x::regprocedure) from (values ('public.attendance_employees(uuid)'),
  ('public.attendance_employee(uuid,uuid,date,date)'),
  ('public.attendance_daily(uuid,date,text,text,text,text,text,integer,integer)'),
  ('public.attendance_period(uuid,date,date,text,text,text)'),
  ('public.attendance_overview(uuid)'),
  ('public.attendance_leave_page(uuid,boolean,text,uuid,integer,integer,uuid)'),
  ('public.attendance_correction_page(uuid,boolean,text,uuid,integer,integer)')) v(x)
), s as (
 select count(*) filter (where position('Update 089' in body)>0) done,
  position('Update 088' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))>0 at088 from f
), people as (
 select p.active,p.deleted_at is not null deleted from public.profiles p where p.role in ('admin','agent','staff')
  and (exists(select 1 from public.attendance_periods e where e.user_id=p.id) or exists(select 1 from public.attendance_records r where r.user_id=p.id))
)
select
 case when s.done=7 then 'at 089'
  when s.done>0 then 'PARTLY at 089: run update 089 again'
  when s.at088 then 'at 088, ready for 089'
  else 'NOT READY: apply CRM updates up to 088 exactly' end release_stage,
 -- Each text update 089 edits appears exactly once (before 089 only).
 case when s.done<7 then (select bool_and((length(f.body)-length(replace(f.body,v.t,'')))/length(v.t)=1)
  from (values
  ('public.attendance_employees(uuid)',$t$  from public.profiles p where p.role in ('admin','agent','staff')$t$),
  ('public.attendance_employee(uuid,uuid,date,date)',$t$ select * into person from public.profiles where id=p_user and role in ('admin','agent','staff');$t$),
  ('public.attendance_daily(uuid,date,text,text,text,text,text,integer,integer)',$t$  where (d.eligible or d.record_id is not null)$t$),
  ('public.attendance_period(uuid,date,date,text,text,text)',$t$  where p.role in ('admin','agent','staff') and (term is null or p.name ilike '%'||term||'%' or p.uid::text=term)$t$),
  ('public.attendance_overview(uuid)',$t$ with d as (select * from public.attendance_days(today,today,null,now()) where eligible or record_id is not null)$t$),
  ('public.attendance_overview(uuid)',$t$  'incomplete_30_days',(select count(*) from public.attendance_records where attendance_date between today-30 and today-1 and state in ('checked_in','incomplete')),
  'pending_leave',(select count(*) from public.attendance_leave_requests where status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where status='pending'),$t$),
  ('public.attendance_leave_page(uuid,boolean,text,uuid,integer,integer,uuid)',$t$  from public.attendance_leave_requests l join public.profiles p on p.id=l.user_id left join public.profiles r on r.id=l.reviewer_id$t$),
  ('public.attendance_correction_page(uuid,boolean,text,uuid,integer,integer)',$t$  from public.attendance_corrections c join public.profiles p on p.id=c.user_id left join public.profiles r on r.id=c.reviewer_id$t$)
  ) v(fn,t) join f on f.fn=v.fn where position('Update 089' in f.body)=0) end edits_fit,
 (select count(*) from people where active and not deleted) active_employees,
 (select count(*) from people where not active and not deleted) disabled_employees,
 (select count(*) from people where deleted) deleted_hidden,
 (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and xact_start<now()-interval '1 minute') transactions_open_over_1_min
from s;
