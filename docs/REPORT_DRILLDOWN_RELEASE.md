# Report drill-down: update 050 release plan

Update 050 lets administrators select any report number and see the records behind it. It also shows who actually made each call.

**Where production stands:** v1.1.0 code, with its database at 049. Update 049 (dealers) is applied and verified; the dealer code is not deployed yet.

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/050_report_drilldown.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-report-drilldown-050.sql`: one SELECT, flags and counts only    |
| Requires        | update 048 (production is at 049, so it is ready); it does not depend on 049    |
| Separate from   | the dealer release: deploy dealers first, then this release (see step 3)        |

## Why a database update is needed

- **The numbers are worked out inside the database**, by the existing report functions: `crm_metrics`, `report_sources`, `report_agents`, `report_funnel` and `report_lost`.
  - The list behind a number must use exactly the same conditions, so it is built in the same place.
  - `report_records` repeats each report's conditions, branch by branch.
- **The existing functions are not changed**, so the reports keep their numbers and their speed.
- **One index is needed.** Who recorded a call, visit, deal or follow-up is only in the audit log (about 49,000 entries in production).
  - Without an index, each lookup reads the whole audit log: measured at about 10 ms per call, or 0.5 s for a page of 50.
  - With the index, a page takes 1–2 ms for this.

## What 050 changes

- **Seven new functions.** Only `report_drilldown` can be called, and only by the server's service role. The six helpers are callable only by the database owner.
- **One partial index**, `audit_log_activity_records`, on `audit_log(entity, entity_id, id)`. It covers only call, visit, deal and follow-up entries.
- **No table, row, existing function or permission changes.** A test checks every row, every existing function and every report's output before and after 050.

## How a list matches its number

- **Same conditions.** Each list uses its report's own conditions and the report's own filters (dates in Pakistan time, agent, source).
  - Lists keep the report's meaning. The funnel uses the furthest stage a lead has ever reached. Event numbers (calls, visits, deals, follow-ups, assignments) list those events, not leads.
- **Self-check.** Page 1 also works out the report's own number in the same request.
  - If the list and the report ever disagree, the page shows a warning.
  - If the report changed after it loaded (for example a new lead arrived), the page says so.
- **Verified locally.** Every number of every report was compared with its list:
  - 400+ checks in the automated tests, with and without filters;
  - 466 checks on PostgreSQL 17 with synthetic data, rolled back afterwards;
  - 0 differences.

## Who can use it and what it shows

- **Administrators only.** The server route is admin-only, and the database checks again. Agents and staff get 403, and browsers cannot call the functions.
- **Contact numbers stay masked in the lists** (the stored masked number, such as +92\*\*\*\*\*\*567).
  - The full number is on the lead's own page. Opening a lead reveals and audits that one number, as it does today.
  - Browsing reports (opening lists, paging, searching, sorting, refreshing) writes nothing to the audit log and reveals no numbers.
- **"Called by"** is the person the audit log records for the call.
  - A call's stored agent is the lead's agent even when an administrator logged it, so the stored agent is shown separately ("filed under").
  - Calls with no audit entry show "Caller not recorded". The read-only check counts these as `calls_without_recorded_caller`.
- **Searching:** lead number, name, or a full contact number in any common form. Lists can also be narrowed by current status and assigned agent, and sorted by creation, last activity or latest call. Paging happens on the server.

## 1. Before the release

1. **Review and merge** the PR into `main`, with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up** with a fresh encrypted backup, and check that it restores (v1.1.0 runbook step 4).
3. **Run the read-only check** in the Supabase SQL Editor and save the result. Required:
   - `release_stage` = `at 048 or 049, ready for 050`;
   - `transactions_open_over_1_min` = 0;
   - note every `existing_*` count and `activity_audit_entries`.

## 2. Apply 050 (Supabase SQL Editor; database first)

1. Choose a quiet time (evening PKT).
2. Open a new query, paste the **whole** file, and run it. The file sets its own `lock_timeout` of 5 s.
3. Run the check again. Required:
   - `release_stage` = `at 050`;
   - `activity_index` = 1;
   - `server_functions` = 1;
   - every `*_must_be_0` = 0;
   - the `existing_*` counts equal step 1, apart from normal use.

**Locks.** Building the index takes a SHARE lock on `audit_log` for its duration: under a second for the current size.

- While it holds, CRM saves that write an audit entry wait.
- If the lock is not granted within 5 s, the whole update rolls back and nothing is applied. Run it again later.
- The new functions take no locks on existing data.

**The live v1.1.0 code is unaffected by 050**: it never calls the new functions.

## 3. Deploy the code

**Keep the two releases separate.**

- **Dealers first.** The dealer release deploys `4101c372bcc1d3ebed97a3c9d4d05cfb0c7e5d55`, the `main` commit before this feature. The Production workflow deploys the exact SHA it is given, so merging this PR does not change the dealer release.
- **Then this release.** `<SHA>` contains the dealer code as well, so deploy it only after the dealer release is live and smoke-tested. It then adds nothing but the drill-down.

1. Deploy `<SHA>` with the Production workflow, as in v1.1.0 runbook step 6: stop the worker, run the workflow, approve it, then restart exactly one worker. The drill-down adds no background jobs.
2. If the code goes live before 050, report numbers still work. Opening a list shows "This feature needs CRM database update 050 after 048."

## 4. Smoke test (read-only, about 10 minutes)

1. `curl -sI https://hdmarketing.tech | grep -i x-release-sha` shows `<SHA>`.
2. **Admin**, Reports → Sales funnel:
   - select Contacted;
   - the list's total equals the number, with no warning;
   - open a lead, then go back: the same list returns.
3. **Summary:** select "leads contacted"; the totals match.
4. **Agents:** select an agent's Calls; each call shows "Called by".
5. **Lost reasons:** select a reason; its leads are listed.
6. **Agent account:** Reports is not in the menu.

Browsing the lists writes no audit entries; only opening a lead's page reveals (and audits) its number.

## 5. Rollback (application only)

- **The database stays at 050.** v1.1.0 never calls the new functions, and the index only speeds up reads.
- **To roll back the code:** follow v1.1.0 runbook step 8.2–8.4.
- **Removing the index** is not needed. If it must go, `drop index if exists public.audit_log_activity_records;` is a separately approved step; it changes no data.
- **Never restore a backup** to undo this release.

## Limits and notes

- **Some numbers depend on the current time:** today's calls, due and overdue follow-ups, upcoming visits, and leads waiting for or past their first call. They can change between loading the report and opening its list; the list then says the report changed.
- **The Agents report's "Calls"** counts calls filed under the agent, as before. The list shows who actually called; numbers were not changed.
- **Contacted, interested and follow-up counts per agent** are not Agents-report numbers. Use the Summary tab with the agent filter; its lists follow that filter.
- **Two Summary numbers have no lead list:** "active agents" and "deleted today". Selecting them explains this and links to Employee management and the deleted leads bin.
