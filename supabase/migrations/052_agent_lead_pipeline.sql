-- Update 052: agents' Assigned leads, simplified, and a Lead pipeline of the
-- leads they have spoken to. Apply after 051. Safe to rerun.
--
-- * Every lead from an imported file keeps a fixed number (#) within that
--   file: its place in the file's import order, 1, 2, 3 and so on. Filters,
--   pages, reassignment and the deleted-leads purge never change it, so #15
--   always means the same lead of that file. A lead added without a file
--   (manually, Meta, WhatsApp) has no file number.
-- * agent_lead_list: one agent's own leads, all of them (Assigned leads) or
--   only those with an answered call (Lead pipeline). Search by name,
--   contact number or #, filters, sorting, counts and pages are all worked
--   out here, across every page.
-- * A lead's temperature is the latest Hot, Warm or Cold tag saved with one
--   of its calls, as in the report lists (update 050). Nothing new is
--   stored for it, and no call is changed.
--
-- No existing table, row or function changes: one new private table, a
-- trigger that numbers leads added to a file, and the list function.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.report_today_records(text,uuid)') is null
  or to_regclass('public.lead_imports') is null or to_regclass('crm_private.lead_phones') is null then
  raise exception 'Apply CRM updates up to 051 before update 052.';
 end if;
end $$;

-- ------------------------------------------------------- file numbers (#)
create table if not exists crm_private.lead_file_rows(
 lead_id uuid primary key references public.leads(id) on delete cascade,
 import_id uuid not null references public.lead_imports(id),
 file_row integer not null check(file_row>0),
 unique(import_id,file_row));
revoke all on crm_private.lead_file_rows from public,anon,authenticated;

-- Existing files: numbered in import order (lead numbers rise row by row).
-- On a rerun only leads without a number are added, after the file's last.
insert into crm_private.lead_file_rows(lead_id,import_id,file_row)
select l.id,l.import_id,coalesce((select max(r.file_row) from crm_private.lead_file_rows r where r.import_id=l.import_id),0)
  +row_number() over(partition by l.import_id order by l.lead_no)
from public.leads l
where l.import_id is not null and not exists(select 1 from crm_private.lead_file_rows r where r.lead_id=l.id);

-- New file leads: an import creates each lead, then sets its file, so the
-- next number is given when a lead joins a file. Locking the file row keeps
-- numbers unique even if two changes to one file ever overlapped.
create or replace function public.number_file_lead() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.import_id is null then return null;end if;
 if tg_op='UPDATE' then
  if old.import_id is not distinct from new.import_id then return null;end if;
 end if;
 perform 1 from public.lead_imports i where i.id=new.import_id for update;
 insert into crm_private.lead_file_rows(lead_id,import_id,file_row)
  values(new.id,new.import_id,coalesce((select max(r.file_row) from crm_private.lead_file_rows r where r.import_id=new.import_id),0)+1)
  on conflict(lead_id) do update set import_id=excluded.import_id,file_row=excluded.file_row
  where crm_private.lead_file_rows.import_id is distinct from excluded.import_id;
 return null;
end $$;
drop trigger if exists number_file_lead on public.leads;
create trigger number_file_lead after insert or update of import_id on public.leads
 for each row execute function public.number_file_lead();

-- ------------------------------------------------------- the list
-- p_query: view ('assigned' or 'pipeline'), search, page, sort, and the
-- view's own filters. Assigned leads: import (a file), source and call
-- (first call 'uncalled' or 'missed'). Lead pipeline: status and
-- temperature ('hot', 'warm', 'cold' or 'none' for not recorded yet).
-- Search: '#15' or up to four digits is a file number; 'HD-000145' a lead
-- number; five or more digits (any common format: 0300…, +92…, 0092…) part
-- of a contact number; anything else part of the customer's name.
create or replace function public.agent_lead_list(p_actor uuid,p_query jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q jsonb=coalesce(p_query,'{}'::jsonb);v_view text;v_import uuid;v_search text;v_status text;v_temperature text;
 v_source text;v_call text;v_sort text;v_page integer;v_limit constant integer=20;
 v_row integer;v_number bigint;v_digits text;v_phone text;v_like text;result jsonb;
begin
 -- Agents only, and only the leads assigned to them now.
 perform 1 from public.profiles p where p.id=p_actor and p.active and p.role='agent' and p.deleted_at is null for share;
 if not found then raise exception 'Agent access required' using errcode='42501';end if;
 if jsonb_typeof(q)<>'object' then raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(q) e
   where e.key not in ('view','import','search','status','temperature','source','call','sort','page')
    or jsonb_typeof(e.value) not in ('string','number')) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 v_view=coalesce(q->>'view','assigned');v_search=nullif(btrim(coalesce(q->>'search','')),'');
 v_status=q->>'status';v_temperature=q->>'temperature';v_source=q->>'source';v_call=q->>'call';
 v_sort=coalesce(q->>'sort',case when v_view='pipeline' then 'contact' when v_call is not null then 'call_due'
  when q ? 'import' then 'file' else 'activity' end);
 begin
  v_page=coalesce((q->>'page')::integer,1);
  if q ? 'import' and q->>'import' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   v_import=(q->>'import')::uuid;end if;
 exception when others then raise exception 'Choose valid lead filters' using errcode='22023';
 end;
 -- Each view keeps to its own filters and sorts.
 if v_view not in ('assigned','pipeline') or v_page not between 1 and 100000 or length(coalesce(v_search,''))>100
  or (q ? 'import' and v_import is null)
  or (v_status is not null and v_status not in ('new','contacted','interested','visit_scheduled','visit_done','negotiation','won','lost'))
  or (v_temperature is not null and v_temperature not in ('hot','warm','cold','none'))
  or (v_source is not null and v_source not in ('manual','CSV','Meta','WhatsApp','other'))
  or (v_call is not null and v_call not in ('uncalled','missed'))
  or (v_view='pipeline' and (q ? 'import' or v_source is not null or v_call is not null
   or v_sort not in ('contact','followup','activity','temperature')))
  or (v_view='assigned' and (v_status is not null or v_temperature is not null
   or v_sort not in ('file','activity','added','call_due'))) then
  raise exception 'Choose valid lead filters' using errcode='22023';end if;
 if v_search is not null then
  v_digits=regexp_replace(v_search,'[^0-9]','','g');
  if v_search ~ '^#\s*[0-9]{1,6}$' or v_search ~ '^[0-9]{1,4}$' then v_row=v_digits::integer;
  elsif v_search ~* '^HD-?\s*[0-9]{1,12}$' then v_number=v_digits::bigint;
  elsif v_search ~ '^[0-9 ()+.-]+$' and length(v_digits) between 5 and 15 then
   -- Contact numbers are stored as +92…: 0092… and 0… become 92…, and a
   -- ten-digit mobile number without its 0 gets 92 in front.
   v_phone=case when v_digits like '00%' then substr(v_digits,3)
    when v_digits like '0%' then '92'||substr(v_digits,2)
    when v_digits ~ '^3[0-9]{9}$' then '92'||v_digits else v_digits end;
  else
   v_like='%'||replace(replace(replace(v_search,'\','\\'),'%','\%'),'_','\_')||'%';
  end if;
 end if;
 with mine as (
  select l.*,r.file_row,i.file_name,i.created_at file_added,
   lc.started_at contact_at,lc.outcome contact_outcome,
   exists(select 1 from public.calls c where c.lead_id=l.id) attempted,
   case tp.tag when 'Hot lead' then 'hot' when 'Warm lead' then 'warm' when 'Cold lead' then 'cold' end temperature,
   tp.started_at temperature_at,
   (select min(f.due_at) from public.followups f where f.lead_id=l.id and f.status='pending') next_followup_at
  from public.leads l
  left join crm_private.lead_file_rows r on r.lead_id=l.id and r.import_id=l.import_id
  left join public.lead_imports i on i.id=l.import_id
  -- The latest answered call: what puts a lead in the pipeline.
  left join lateral (select c.started_at,c.outcome from public.calls c where c.lead_id=l.id and c.status='completed'
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) lc on true
  -- The latest temperature saved with a call, chosen as in update 050.
  left join lateral (select t.tag,c.started_at from public.calls c cross join lateral unnest(c.deal_tags) t(tag)
   where c.lead_id=l.id and t.tag in ('Hot lead','Warm lead','Cold lead')
   order by c.started_at desc,c.created_at desc,c.id desc limit 1) tp on true
  where l.assigned_agent=p_actor and l.deleted_at is null and (v_import is null or l.import_id=v_import)
 ), matched as (
  select m.* from mine m
  where (v_view='assigned' or m.contact_at is not null)
   and (v_search is null or (v_row is not null and m.file_row=v_row) or (v_number is not null and m.lead_no=v_number)
    or (v_phone is not null and exists(select 1 from crm_private.lead_phones p where p.lead_id=m.id and p.phone like '%'||v_phone||'%'))
    or (v_like is not null and m.name ilike v_like))
   and (v_status is null or m.status=v_status)
   and (v_source is null or m.source=v_source)
   and (v_call is null or (m.first_call_at is null and m.call_due_at is not null and m.status not in ('won','lost')
    and case when v_call='missed' then m.call_due_at<now() else m.call_due_at>=now() end))
 ), hits as (
  select m.* from matched m where v_temperature is null or coalesce(m.temperature,'none')=v_temperature
 ), ordered as (
  select h.*,row_number() over(order by
    case when v_sort='file' then h.file_added end desc nulls last,
    case when v_sort='file' then h.file_row end,
    case when v_sort='activity' then h.last_activity_at end desc nulls last,
    case when v_sort='added' then h.created_at end desc nulls last,
    case when v_sort='call_due' then h.call_due_at end nulls last,
    case when v_sort='followup' then h.next_followup_at end nulls last,
    case when v_sort='temperature' then case h.temperature when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 else 4 end end,
    case when v_sort in ('contact','followup','temperature') then h.contact_at end desc nulls last,
    h.lead_no desc) rn
  from hits h
 )
 select jsonb_build_object('view',v_view,'sort',v_sort,'page',v_page,'limit',v_limit,
  'count',(select count(*) from hits),
  -- Pipeline leads by temperature, for the current search and status.
  'temperatures',case when v_view='pipeline' then (select jsonb_build_object(
    'hot',count(*) filter (where temperature='hot'),'warm',count(*) filter (where temperature='warm'),
    'cold',count(*) filter (where temperature='cold'),'none',count(*) filter (where temperature is null)) from matched) end,
  'data',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'lead_no',o.lead_no,'name',o.name,'email',o.email,
     'masked_phone',o.masked_phone,'assigned_agent',o.assigned_agent,'status',o.status,'source',o.source,
     'preferred_location',o.preferred_location,'budget_min',o.budget_min,'budget_max',o.budget_max,
     'lost_reason',o.lost_reason,'created_at',o.created_at,'last_activity_at',o.last_activity_at,
     'assigned_at',o.assigned_at,'call_due_at',o.call_due_at,'first_call_at',o.first_call_at,'missed_at',o.missed_at,
     'import_id',o.import_id,'file_row',o.file_row,'file_name',o.file_name,
     'contact',case when o.contact_at is not null then 'contacted' when o.attempted then 'attempted' else 'none' end,
     'last_contact_at',o.contact_at,'last_contact_outcome',o.contact_outcome,
     'temperature',o.temperature,'temperature_at',o.temperature_at,'next_followup_at',o.next_followup_at) order by o.rn)
   from ordered o where o.rn>(v_page-1)*v_limit and o.rn<=v_page*v_limit),'[]'::jsonb))
 into result;
 return result;
end $$;

-- Only the server's service role calls the list; nobody calls the trigger.
revoke all on function public.agent_lead_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.agent_lead_list(uuid,jsonb) to service_role;
revoke all on function public.number_file_lead() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
