# Update 071: Team performance in eight columns, and Select all in Deleted leads

**Team performance** (Reports, administrators) becomes one compact table:
Agent, Leads received, New, From another agent, Moved away, Total calls,
Follow-ups and Time.

**Deleted leads** can select every matching lead and delete many at once,
after a review of what would go.

## Team performance

| Column             | What it counts                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent              | Every active agent, and an inactive one with work in the period ("(inactive)").                                                                                                                                                                                       |
| Leads received     | Different leads given to the agent in the period. A lead given to them more than once counts once; a lead given again to the agent who already had it is not received again.                                                                                          |
| New                | Leads received that no other agent had before. Formerly "First time".                                                                                                                                                                                                 |
| From another agent | Leads received that another agent had before. New and From another agent add up to Leads received.                                                                                                                                                                    |
| Moved away         | Different leads moved from the agent to another agent in the period. A lead moved back to the administrators, or deleted, is not counted. Formerly every move was counted, the move back to the administrators included.                                              |
| Total calls        | Every call the agent saved themselves, each one, by when it started. An administrator's call on their lead is never the agent's.                                                                                                                                      |
| Follow-ups         | Leads, not calls: each lead whose latest call in the agent's assignment ended Follow-up required. A later call with another outcome, from the agent or an administrator, ends it. The number opens exactly those leads.                                               |
| Time               | Worked time from attendance, as "7h 45m": check-in to check-out of each checked-out day, as Attendance totals add it up. A day still open or never checked out adds nothing and shows as "1 day without checkout". "—" means attendance is not tracked for the agent. |

- **Periods:** Today, Yesterday, Last 7 days (today and the six days before
  it), This month, or any From/Through dates. All in Pakistan days.
- **Follow-ups at the end of the period:**
  - A period still running (Today, Last 7 days, This month) reads each
    lead's agent now.
  - A period that has ended reads the agent who had the lead at its end,
    from the assignment history, and the calls saved by then.
  - A lead moved to another agent starts fresh for them (update 061), so
    it is never in two agents' Follow-ups.
- **Sorting** by Leads received, Total calls or Follow-ups. A name search and
  an agent filter narrow the rows; the total adds up the rows shown.
- **Export CSV** gives the table as filtered (period, agent and search).
- **Clicking** a name shows that agent with their day by day. Clicking a
  number shows its records.
- The other numbers (answered calls, first calls, notes and so on) are no
  longer in this table. They are still counted, in the Dashboard and the
  other reports.

## Deleted leads

**Selecting**

- Tick leads one by one, use **Select this page**, or use **Select all N
  matching deleted leads**. The last selects every lead the search matches,
  on every page, up to 2,000.
- The bar says exactly what is selected, for example "All 734 matching
  deleted leads selected".
- Changing the search clears the selection.

**Delete instantly**

1. The database reviews the selection first:
   - how many leads can be deleted;
   - how many cannot, and why (a won deal, restored since, or already gone);
   - their calls, recordings, notes, follow-ups, site visits, deals and KYC
     documents;
   - how many came from Google Sheets (the Sheet rows stay marked as
     imported, so they are not imported again);
   - whether the day's security alert will be raised.
2. Type **DELETE**. More than 50 leads also asks for the number of leads.
3. The leads are deleted 250 at a time. Each lead is checked again by the
   database, under the leads lock.
   - If a request fails, or a lead can no longer be deleted (restored, or
     given a won deal, meanwhile), the rest are not attempted.
   - The dialog then shows what was deleted, kept, failed and left.
   - After a request whose answer was lost (network, or a server error), the
     CRM checks which of its leads are gone, and which files still wait,
     instead of guessing. A refused request (too many requests, access) is
     known to have deleted nothing.
   - Restoring many leads works 500 at a time.
4. **Files in storage are reported apart from the leads.** The leads'
   database records go at once. Their call recordings and KYC files go into
   the clean-up queues in the same step, and each request then removes up to
   2,000 of each. The dialog says:
   - how many leads were deleted from the CRM database;
   - how many files were removed from storage now;
   - how many still wait to be removed. Counts only, never a file or
     customer, and "100 or more" past 100. The count includes any left from
     earlier deletions, because the queues are shared;
   - whether storage reported an error, or the files could not be confirmed.

   It closes by itself only when every lead was deleted and no file is
   left. Waiting files are removed the next time Delete instantly is used,
   or by the background clean-up job when it runs. **While that job is off
   in production, they stay in storage until then, or until an approved
   clean-up is run.** `GET /leads/erase/storage` (administrators) gives the
   waiting counts.

   Sensitive actions allow 30 requests a minute for each administrator, so
   two very large runs back to back can be refused part way. Nothing is
   lost: the dialog says which leads were not deleted, and they stay in
   Deleted leads.

**What stays the same:**

- administrators only, checked by the server and the database;
- won deals are protected;
- the more-than-50-a-day alert;
- the audit (lead numbers only, never names or phone numbers);
- the Sheet receipts;
- the Storage clean-up queues: a recording or document that cannot be
  removed now stays queued and goes on the next run.

## Deleted leads in reports

Deleted leads already counted nowhere. 071 checks this again and keeps it:

- **While a lead is deleted,** every report, dashboard, list and Team
  performance number is as if it never existed. Its records stay for the
  14 days.
- **Restored,** its calls, notes, follow-ups, visits and deals count again,
  once.
  - It returns with no agent (update 032), so it is in no agent's lists or
    current Follow-ups.
  - The pending follow-ups and scheduled visits that deleting cancelled stay
    cancelled.
- **Attendance and Daily KPI answers never change** when a lead is deleted
  or restored.

## Release

| Item            | Value                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/071_team_performance_v2.sql`: three new functions (two only read) and nine checked edits of the team report. No table, row, trigger, policy or index changes. Safe to rerun.                                                 |
| Read-only check | `supabase/check-team-performance-071.sql`                                                                                                                                                                                                         |
| Requires        | Update 070 in production (071 refuses to run before it, or on a team report function it does not expect)                                                                                                                                          |
| Code            | Team performance table, export route, Deleted leads selection and review routes. Before 071, the table says "Follow-ups and Time need CRM database update 071", and Select all matching and the review fail with "needs CRM database update 071". |

1. Back up the database and test the restore.
2. Run the check. It should read `at 070, ready for 071`, with
   `edits_ready = 9`, `edits_unexpected = 0` and
   `transactions_open_over_1_min = 0`.
   - Note `same_agent_reassignments` (no longer counted as received) and
     `moves_to_administrators` (no longer counted as moved away).
3. Apply 071 and run the check again. It should read `at 071` with
   `edits_applied = 9`.
4. Deploy the code.

**Rollback:**

- The code before 071 ignores the new functions and numbers.
- To undo the counting changes themselves, restore the three team report
  functions from the backup taken in step 1. No data changes either way.

**Known limit:** deleting a lead keeps no per-lead record of when it was
deleted. So if a lead is deleted and restored, and never given to an agent
again, an earlier period's Follow-ups still count it for the agent who had
it at that period's end, even between the deletion and the restore.
