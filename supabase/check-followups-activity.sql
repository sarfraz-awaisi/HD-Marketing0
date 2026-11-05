-- Read-only check of follow-ups and lead activity (fix/lead-followups-activity).
-- Run it in the CRM's Supabase SQL Editor: paste the whole file and run it
-- with nothing selected. It is one SELECT, changes nothing, and returns counts,
-- employee names and HD lead numbers only: no customer names, phone numbers,
-- emails or notes. Each row is (section, metric, detail, value).
with
fu as (
 select f.*, l.lead_no, l.assigned_agent, l.deleted_at lead_deleted, l.status lead_status,
  p.active agent_active, p.deleted_at agent_deleted
 from public.followups f
 join public.leads l on l.id=f.lead_id
 left join public.profiles p on p.id=f.agent_id
),
latest_call as (
 select distinct on (c.lead_id) c.lead_id, c.outcome, c.created_at
 from public.calls c order by c.lead_id, c.created_at desc, c.id desc
),
waiting as (
 -- Latest call says Follow-up required, and no follow-up is pending or was
 -- created since that call: the follow-up the agent meant was never saved.
 select lc.lead_id, l.lead_no, l.assigned_agent, lc.created_at called_at
 from latest_call lc join public.leads l on l.id=lc.lead_id
 where lc.outcome='Follow-up required' and l.deleted_at is null and l.status not in ('won','lost')
  and not exists(select 1 from public.followups f where f.lead_id=lc.lead_id
   and (f.status='pending' or f.created_at>=lc.created_at))
),
name as (select id, name||' (UID '||coalesce(uid::text,'-')||')' label from public.profiles)
select * from (
 -- 1. Follow-up records and how they are stored.
 select 1 o,'followups' section,'total' metric,'' detail,count(*)::bigint value from fu
 union all select 2,'followups','by status',status,count(*) from fu group by status
 union all select 3,'followups','pending',case when due_at<now() then 'overdue' when due_at<=now()+interval '1 day' then 'due within 24 hours' else 'upcoming' end,count(*)
  from fu where status='pending' group by 3,4
 union all select 4,'followups','pending by current lead owner (what each agent sees)',coalesce(n.label,'(unassigned lead: administrators only)'),count(*)
  from fu left join name n on n.id=fu.assigned_agent where fu.status='pending' and fu.lead_deleted is null group by 4
 union all select 5,'followups','by stored responsible agent',coalesce(n.label,'(none)'),count(*)
  from fu left join name n on n.id=fu.agent_id group by 4
 -- 2. Records hidden from someone or inconsistent.
 union all select 6,'followups hidden or inconsistent','on deleted leads (hidden from every list)','',count(*) from fu where lead_deleted is not null
 union all select 7,'followups hidden or inconsistent','on unassigned leads (only administrators see them)','',count(*) from fu where assigned_agent is null and lead_deleted is null
 union all select 8,'followups hidden or inconsistent','lead moved to another agent (listed for the new owner)','',count(*) from fu where assigned_agent is distinct from agent_id and assigned_agent is not null
 union all select 9,'followups hidden or inconsistent','responsible agent disabled or deleted','',count(*) from fu where agent_active is not true or agent_deleted is not null
 union all select 10,'followups hidden or inconsistent','due more than a day before it was created','',count(*) from fu where due_at<created_at-interval '1 day'
 union all select 11,'followups hidden or inconsistent','due more than two years ahead','',count(*) from fu where due_at>now()+interval '2 years'
 union all select 12,'followups hidden or inconsistent','completed without a completion time','',count(*) from fu where status='completed' and completed_at is null
 union all select 13,'followups hidden or inconsistent','duplicate pending (same lead and time), extra rows','',coalesce(sum(n-1),0)::bigint
  from (select count(*) n from fu where status='pending' group by lead_id,due_at having count(*)>1) d
 -- 3. Calls: where agents recorded that a follow-up was needed.
 union all select 14,'calls','total','',count(*) from public.calls
 union all select 15,'calls','by outcome',coalesce(outcome,'(no outcome yet)'),count(*) from public.calls group by 4
 union all select 16,'calls','with lead tag',t,count(*) from public.calls, unnest(deal_tags) t group by 4
 union all select 17,'calls','leads waiting for a follow-up date (latest call: Follow-up required)','',count(*) from waiting
 union all select 18,'calls','leads waiting for a follow-up date, by current owner',coalesce(n.label,'(unassigned)'),count(*)
  from waiting w left join name n on n.id=w.assigned_agent group by 4
 union all select 19,'calls','lead waiting for a follow-up date',
  public.format_lead_no(w.lead_no)||' · '||coalesce(n.label,'(unassigned)')||' · call '||to_char(w.called_at at time zone 'Asia/Karachi','DD Mon YYYY HH24:MI'),1
  from waiting w left join name n on n.id=w.assigned_agent
 -- 4. Daily tasks are separate: they have no lead, so none can become a follow-up.
 union all select 20,'daily tasks','follow-up category or wording',coalesce(a.status,'(no assignment)'),count(*)
  from public.tasks t left join public.task_assignments a on a.task_id=t.id
  where t.category='follow_ups' or t.title ilike '%follow%' or t.description ilike '%follow%' group by 4
 -- 5. Activity history available to the lead timeline.
 union all select 21,'activity','notes','',count(*) from public.notes
 union all select 22,'activity','notes written by someone other than the lead''s agent (now shown with the writer)','',count(*)
  from public.notes x join public.audit_log a on a.entity='notes' and a.entity_id=x.id::text and a.action='create' where a.actor_id is distinct from x.agent_id
 union all select 23,'activity','stage changes','',count(*) from public.lead_status_history
 union all select 24,'activity','assignments','',count(*) from public.assignments
 union all select 25,'activity','audit entries for notes, calls and follow-ups',a.entity||' '||a.action,count(*)
  from public.audit_log a where a.entity in ('notes','calls','followups') group by 4
 union all select 26,'activity','follow-ups without an audit entry (creator unknown)','',count(*)
  from public.followups f where not exists(select 1 from public.audit_log a where a.entity='followups' and a.entity_id=f.id::text and a.action='create')
) r order by o, detail;
