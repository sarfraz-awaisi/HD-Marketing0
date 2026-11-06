# Agents' own work and dashboard numbers: update 051 release plan

Update 051 makes the numbers people look at every day open the records behind them:

- **Agents get My performance** (menu: My work → My performance). It shows the same reports as the administrators' Reports page, with only the agent's own leads and work. Every number opens its list.
- **Dashboard numbers open their lists**, for administrators and agents:
  - Completed calls;
  - on-time first calls and the average time to a first call;
  - every Today's calling number (calls, answered calls, first calls, waiting, missed, no recent activity, overdue follow-ups).
- **Administrators see everyone's records; agents only their own.** The database enforces this, not just the screen.

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/051_agent_work_drilldown.sql` (one transaction, safe to rerun)    |
| Read-only check | `supabase/check-agent-work-051.sql`: one SELECT, flags and counts only                 |
| Requires        | update 050 (confirmed in production by `check-agent-work-051.sql` on 6 November 2026)  |
| Code            | this branch, built on `main` `b180320`, so it also contains the 050 drill-down screens |

## Where production stands (6 November 2026)

- **Code:** `4101c372bcc1d3ebed97a3c9d4d05cfb0c7e5d55` (dealers), deployed by Production run 42118258270 to the blue slot.
  - The report drill-down code (`b180320`) is **not** deployed yet, so report numbers do not open lists in production.
- **Database:** 049 verified. The 051 check, run by the owner on 6 November 2026, said `at 050, ready for 051`, with every safety column passing.
  - Counts then: 1106 leads, 669 calls, 9 follow-ups, 1162 assignments, 50439 audit entries, 8 active agents.
- **The green slot still runs the previous release** (`9661980`, v1.1.0). The next deploy refuses to start while it runs ("Inactive slot is retained"). Retire it first: server guide section 10, after the 24-hour rollback window, which ends 7 November 2026 03:12 PKT.

## What 051 changes

- **One function replaced:** `report_drilldown`.
  - Administrators get exactly what they got before, plus a `scope` field.
  - Agents may now call it. The database sets the agent to the signed-in agent, refuses another agent's row, and refuses the agent and assigned-agent filters.
  - Staff and inactive accounts are refused as before.
- **Two new helpers**, callable only by the database owner:
  - `report_today_records` lists the records behind one Today's calling number, with `call_activity`'s own conditions;
  - `report_today_value` reads the number `call_activity` shows.
- **No table, row, permission or report calculation changes.** A test checks every row, every other function and every report's output, for an administrator and an agent, before and after 051.

**Work on a lead that is now someone else's.** A call an agent made before the lead was reassigned still counts in the agent's numbers, exactly as in the reports. In the agent's list it shows:

- only the lead number, "Now handled by another agent" and the agent's own record;
- never the lead's name, contact number, status or later activity;
- no link to open.

Searching finds such a lead by its number only, and a status filter leaves it out.

## How it was verified (locally only)

- **Every number matches its list.**
  - Automated sweeps compare every report number with its list: for administrators (400+ checks) and for two agents (250+ checks, including every Today's calling number).
  - Lists for leads now with someone else show the number only.
- **Migration test.** On a database at 050, 051 changes no row, report output or other function, and administrators' lists are identical.
  - Applying 051 twice changes nothing.
  - Re-running 050 restores the previous `report_drilldown` exactly.
  - 051 refuses to run before 050.
- **Real browser, throwaway local stack** (`hd-crm-work`, PostgreSQL 17): 27 of 27 checks passed.
  - Administrator: Today's calling lists, switching between numbers, back from a lead, the Completed calls tile.
  - Agents: dashboard lists, My performance, the handed-over lead hidden.
  - API refusals for agents and staff; zero audit writes while browsing; no overflow at 390 px.
  - Afterwards the main local database was identical.
- **Full suites:** server 1085 passed, client 478 passed; build and `check.py` pass.

## 1. Before the release

1. **Review and merge** the PR into `main`, with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up** with a fresh encrypted backup, and check that it restores (v1.1.0 runbook step 4).
3. **Run** `supabase/check-agent-work-051.sql` and save the result. Required:
   - `release_stage` = `at 050, ready for 051` (this also proves 050 is installed);
   - `transactions_open_over_1_min` = 0;
   - note the `existing_*` counts.

## 2. Apply 051 (Supabase SQL Editor; database first)

1. Open a new query, paste the **whole** file, and run it. The file sets its own `lock_timeout` of 5 s. It takes no locks on data.
2. Run `check-agent-work-051.sql` again. Required:
   - `release_stage` = `at 051`;
   - `server_functions` = 1;
   - every `*_must_be_0` = 0;
   - the `existing_*` counts equal step 1, apart from normal use.

**The live code is unaffected by 051.** `4101c37` never calls `report_drilldown`, and `b180320` would ignore the new `scope` field.

## 3. Deploy the code

1. **Retire the green slot** (server guide section 10), as the owner, after the rollback window.
2. **Deploy `<SHA>`** with the Production workflow, as in v1.1.0 runbook step 6: stop the worker, run the workflow, approve it, then restart exactly one worker. Nothing here adds background jobs.

This one release brings both the administrators' report drill-down (050) and this update (051).

**Order matters: the database first.** Code deployed before 051 would refuse agents' lists ("Administrator access required") and administrators' Today's calling lists.

## 4. Smoke test (read-only, about 10 minutes)

1. `curl -sI https://hdmarketing.tech | grep -i x-release-sha` shows `<SHA>`.
2. **Administrator dashboard.** In Today's calling, select an agent's calls:
   - the list's total equals the number;
   - each call shows "Called by";
   - switch to Overdue follow-ups;
   - open a lead, then go back: the same list returns.
3. **Administrator, Reports → Sales funnel:** select a stage. The total equals the number, with no warning.
4. **Agent, dashboard:** select "Calls today" under My calls today.
   - The list says "Only your own work is listed".
   - It has no assigned-agent filter, and its total equals the number.
5. **Agent, My performance:**
   - no agent filter and no Export;
   - select "leads contacted" and the My activity calls; the totals match.
6. **Staff account:** My performance is not in the menu.

Browsing the lists writes no audit entries. Only opening a lead's page reveals (and audits) its number.

## 5. Rollback

- **Code:** roll back the application first (v1.1.0 runbook step 8.2–8.4).
- **Database:** only after the code is rolled back, and as a separately approved step, re-run `050_report_drilldown.sql` in the SQL Editor.
  - This restores the administrator-only `report_drilldown`; the check then says `at 050, ready for 051`.
  - The two 051 helpers stay, unused.
  - No data changes either way.
- **Never restore a backup** to undo this release.

## Limits and notes

- **Today's calling numbers depend on the current time** (today's calls, deadlines, overdue follow-ups). If one changes between loading the dashboard and opening its list, the list says so.
- **"Calls today" counts calls filed under the agent**, as the dashboard always has. "Called by" shows who actually made each call; an administrator who logs a call for an agent's lead is shown as the caller.
- **Agents' summaries leave out** "active agents" and "deleted today", which are not about their own work.
