-- Update 089: Attendance Management never shows deleted accounts. A
-- disabled account (an employee who has left, kept until their final salary
-- is settled) stays, with its full attendance history, apart from the active
-- employees; once the account is deleted it no longer appears anywhere in
-- Attendance Management: the employee list and one employee's attendance,
-- Daily, Weekly and Monthly (and their exports), the Overview counts, and
-- the leave and correction lists. Employee management and shift management
-- already leave deleted accounts out. Apply after 088. Safe to rerun. No
-- table, row or trigger changes: no attendance record is deleted or changed;
-- seven functions are edited.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.admin_lead_list(uuid,jsonb)') is null
  or position('Update 088' in pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))=0
  or to_regprocedure('public.attendance_leave_page(uuid,boolean,text,uuid,integer,integer,uuid)') is null
  or to_regprocedure('public.attendance_correction_page(uuid,boolean,text,uuid,integer,integer)') is null
  or to_regprocedure('public.attendance_employees(uuid)') is null
  or to_regprocedure('public.attendance_employee(uuid,uuid,date,date)') is null
  or to_regprocedure('public.attendance_daily(uuid,date,text,text,text,text,text,integer,integer)') is null
  or to_regprocedure('public.attendance_period(uuid,date,date,text,text,text)') is null
  or to_regprocedure('public.attendance_overview(uuid)') is null then
  raise exception 'Apply CRM updates up to 088 before update 089.';
 end if;
end $$;
-- Checked edits, as in updates 061 to 088: each text must appear exactly
-- once in its function, or the update stops and changes nothing. On a rerun
-- the edited text is found and left alone.
do $patch$
declare item record;body text;n integer;
begin
 for item in select * from (values
  ('public.attendance_employees(uuid)',
   $t$  from public.profiles p where p.role in ('admin','agent','staff')$t$,
   $t$  from public.profiles p where p.role in ('admin','agent','staff')
   -- Update 089: never a deleted account; a disabled one stays.
   and p.deleted_at is null$t$),
  ('public.attendance_employee(uuid,uuid,date,date)',
   $t$ select * into person from public.profiles where id=p_user and role in ('admin','agent','staff');$t$,
   $t$ -- Update 089: never a deleted account; a disabled one stays.
 select * into person from public.profiles where id=p_user and role in ('admin','agent','staff') and deleted_at is null;$t$),
  ('public.attendance_daily(uuid,date,text,text,text,text,text,integer,integer)',
   $t$  where (d.eligible or d.record_id is not null)$t$,
   $t$  where (d.eligible or d.record_id is not null)
   -- Update 089: never a deleted account.
   and p.deleted_at is null$t$),
  ('public.attendance_period(uuid,date,date,text,text,text)',
   $t$  where p.role in ('admin','agent','staff') and (term is null or p.name ilike '%'||term||'%' or p.uid::text=term)$t$,
   $t$  where p.role in ('admin','agent','staff') and (term is null or p.name ilike '%'||term||'%' or p.uid::text=term)
   -- Update 089: never a deleted account.
   and p.deleted_at is null$t$),
  ('public.attendance_overview(uuid)',
   $t$ with d as (select * from public.attendance_days(today,today,null,now()) where eligible or record_id is not null)$t$,
   $t$ -- Update 089: never a deleted account, today or in the counts below.
 with d as (select a.* from public.attendance_days(today,today,null,now()) a join public.profiles p on p.id=a.user_id
  where (a.eligible or a.record_id is not null) and p.deleted_at is null)$t$),
  ('public.attendance_overview(uuid)',
   $t$  'incomplete_30_days',(select count(*) from public.attendance_records where attendance_date between today-30 and today-1 and state in ('checked_in','incomplete')),
  'pending_leave',(select count(*) from public.attendance_leave_requests where status='pending'),
  'pending_corrections',(select count(*) from public.attendance_corrections where status='pending'),$t$,
   $t$  'incomplete_30_days',(select count(*) from public.attendance_records x join public.profiles p on p.id=x.user_id
   where x.attendance_date between today-30 and today-1 and x.state in ('checked_in','incomplete') and p.deleted_at is null),
  'pending_leave',(select count(*) from public.attendance_leave_requests x join public.profiles p on p.id=x.user_id
   where x.status='pending' and p.deleted_at is null),
  'pending_corrections',(select count(*) from public.attendance_corrections x join public.profiles p on p.id=x.user_id
   where x.status='pending' and p.deleted_at is null),$t$),
  ('public.attendance_leave_page(uuid,boolean,text,uuid,integer,integer,uuid)',
   $t$  from public.attendance_leave_requests l join public.profiles p on p.id=l.user_id left join public.profiles r on r.id=l.reviewer_id$t$,
   $t$  -- Update 089: never a deleted account's requests.
  from public.attendance_leave_requests l join public.profiles p on p.id=l.user_id and p.deleted_at is null
  left join public.profiles r on r.id=l.reviewer_id$t$),
  ('public.attendance_correction_page(uuid,boolean,text,uuid,integer,integer)',
   $t$  from public.attendance_corrections c join public.profiles p on p.id=c.user_id left join public.profiles r on r.id=c.reviewer_id$t$,
   $t$  -- Update 089: never a deleted account's requests.
  from public.attendance_corrections c join public.profiles p on p.id=c.user_id and p.deleted_at is null
  left join public.profiles r on r.id=c.reviewer_id$t$)
 ) v(fn,old_text,new_text) loop
  body=pg_get_functiondef(item.fn::regprocedure);
  if position(item.new_text in body)>0 then continue;end if;
  n=(length(body)-length(replace(body,item.old_text,'')))/length(item.old_text);
  if n<>1 then
   raise exception 'Update 089 found an unexpected version of %: apply CRM updates up to 088 exactly.',item.fn;
  end if;
  execute replace(body,item.old_text,item.new_text);
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
