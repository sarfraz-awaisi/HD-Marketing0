-- Read-only review before update 069. Run it in the CRM's Supabase SQL
-- Editor. It is one SELECT: it changes nothing and returns dates, counts and
-- HD numbers only: no customer names, phone numbers, emails or delete
-- reasons. Times are Pakistan time.
with pk as (select 'YYYY-MM-DD HH24:MI'::text f),
bin as (
 select l.*,
  (select count(*) from public.leads o where o.deleted_batch=l.deleted_batch) batch_size,
  extract(epoch from now()-l.deleted_at)/86400 age_days
 from public.leads l where l.deleted_at is not null
)
-- 1. Background jobs: when each last ran. The daily erasure has its own ledger.
select 1 n,'1 jobs' section,j.job item,
 'last run '||to_char(j.last_run_at at time zone 'Asia/Karachi',(select f from pk))||', '||j.last_status||
 coalesce(', last success '||to_char(j.last_success_at at time zone 'Asia/Karachi',(select f from pk)),'') detail
from public.job_heartbeats j
union all
select 1,'1 jobs','daily erasure (purge_deleted_leads)',
 coalesce('last run '||to_char(max(last_run_at) at time zone 'Asia/Karachi',(select f from pk)),'never') from crm_private.lead_purge_runs
union all
select 1,'1 jobs','erasures recorded (lead.purged)',
 count(*)||' entries, '||coalesce(sum((metadata->>'purged')::int),0)||' leads, last '||
 coalesce(to_char(max(created_at) at time zone 'Asia/Karachi',(select f from pk)),'never')
from public.audit_log where action='lead.purged'
-- 2. Deleted leads 14 to 30 days old: restorable now (30 days), not after 069.
union all
select 2,'2 leads 14-30 days',public.format_lead_no(b.lead_no),
 'deleted '||to_char(b.deleted_at at time zone 'Asia/Karachi',(select f from pk))||' ('||floor(b.age_days)||' days ago) by '||coalesce(p.name,'unknown')||
 '; restore possible until '||to_char((b.deleted_at+interval '30 days') at time zone 'Asia/Karachi',(select f from pk))||' today, ends when 069 is applied'||
 '; source '||b.source||'; deleted '||case when b.import_id is not null and exists(select 1 from public.lead_imports i where i.id=b.import_id and i.deleted_batch=b.deleted_batch) then 'with its file' when b.batch_size>1 then 'with '||(b.batch_size-1)||' other leads' else 'on its own' end||
 '; calls '||(select count(*) from public.calls c where c.lead_id=b.id)||', notes '||(select count(*) from public.notes x where x.lead_id=b.id)||
 ', follow-ups '||(select count(*) from public.followups x where x.lead_id=b.id)||', visits '||(select count(*) from public.visits x where x.lead_id=b.id)||
 ', deals '||(select count(*) from public.deals x where x.lead_id=b.id)||' (won '||(select count(*) from public.deals x where x.lead_id=b.id and x.stage='won')||')'||
 ', KYC documents '||(select count(*) from public.knowledge_documents x where x.lead_id=b.id)||
 ', Sheet inquiries '||(select count(*) from crm_private.sheet_lead_inquiries x where x.lead_id=b.id)
from bin b left join public.profiles p on p.id=b.deleted_by
where b.deleted_at<=now()-interval '14 days' and b.deleted_at>now()-interval '30 days'
-- 3. Every deleted lead by the day it was deleted: when Restore ends now
-- (30 days) and after 069 (14 days).
union all
select 3,'3 bin by day',to_char(b.deleted_at at time zone 'Asia/Karachi','YYYY-MM-DD'),
 count(*)||' leads ('||count(*) filter (where b.batch_size>1)||' in batches, '||count(*) filter (where b.import_id is not null)||' from files)'||
 '; Restore ends '||to_char((min(b.deleted_at)+interval '30 days') at time zone 'Asia/Karachi','YYYY-MM-DD')||' now, '||
 to_char((min(b.deleted_at)+interval '14 days') at time zone 'Asia/Karachi','YYYY-MM-DD')||' after 069'
from bin b group by 3
-- 4. Deleted files with leads.
union all
select 4,'4 deleted files','file '||left(i.id::text,8),
 'deleted '||to_char(i.deleted_at at time zone 'Asia/Karachi',(select f from pk))||' ('||floor(extract(epoch from now()-i.deleted_at)/86400)||' days ago), mode '||i.delete_mode||
 '; its leads still in Deleted leads '||(select count(*) from public.leads l where l.import_id=i.id and l.deleted_batch=i.deleted_batch and l.deleted_at is not null)||
 '; listed with Restore file now: '||case when i.deleted_at>now()-interval '30 days' then 'yes' else 'no' end||
 ', after 069: '||case when i.deleted_at>now()-interval '14 days' then 'yes' else 'no' end
from public.lead_imports i where i.deleted_at is not null and i.delete_mode='file_and_leads'
-- 5. Deletions and alerts in the last 30 days, by day.
union all
select 5,'5 deletions',to_char(a.created_at at time zone 'Asia/Karachi','YYYY-MM-DD')||' '||a.action,
 count(*)||' actions, '||coalesce(sum((a.metadata->>'deleted')::int),0)||' leads, by '||string_agg(distinct coalesce(p.name,'unknown'),', ')
from public.audit_log a left join public.profiles p on p.id=a.actor_id
where a.action in ('lead.bulk_deleted','lead.file_deleted','lead.bulk_restored','lead.file_restored') and a.created_at>now()-interval '30 days'
group by 3,a.action
union all
select 5,'5 deletions','security alerts: mass deletion',
 count(*)||' in the last 30 days'||coalesce(', last '||to_char(max(created_at) at time zone 'Asia/Karachi',(select f from pk)),'')
from public.security_alerts where type='mass_lead_deletion' and created_at>now()-interval '30 days'
-- 6. Database backups recorded by the backup job (the last 5).
union all
select 6,'6 backups',to_char(x.created_at at time zone 'Asia/Karachi',(select f from pk)),
 x.status||', '||round(x.bytes/1048576.0,1)||' MB, sha256 '||coalesce(left(x.sha256,16),'none')
from (select * from public.backups order by created_at desc limit 5) x
order by 1,2,3;
