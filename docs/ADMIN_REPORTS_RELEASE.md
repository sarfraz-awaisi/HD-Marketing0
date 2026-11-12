# Update 063: team reports that count from the records

The administrator's dashboard and reports showed numbers that were easy to misread. Calls were filed under the lead's agent even when an administrator made them, "missed first call" depended on a background job that had stopped, and the dashboard pipeline showed only leads created this month. After 063 every number is counted from the records themselves, and each one opens the records behind it.

## Counting rules (owner decisions, 12 November 2026)

- **Calls count for whoever recorded them.** An administrator's calls on an agent's lead are shown apart ("+ 2 by an admin", Admin calls), never as the agent's own.
- **An administrator's call is never an agent's first call**, on new and reassigned leads alike. An answered administrator call still counts as a customer connection, so the lead is not "Not connected". (This replaces the 061 exception for a lead's first agent.)
- **Missed first-call deadlines are worked out from each assignment's deadline and the agent's own first call**, without the background job. Existing missed stamps, calls, notes, assignments, notifications and audit entries are kept as they are.
- **Leads received are different leads.** Every assignment event stays in the drill-down (Assignment history), so a lead moved twice is one lead received with two events.
- **Weeks run Sunday to Saturday, days midnight to midnight in Pakistan time.**
- **The dashboard Lead pipeline is every open lead now, by its current stage** (agents: their own).

## What administrators see

- **Reports → Team performance** (replaces the administrators' Agents tab): periods Today, Yesterday, This week, Last week, This month, Last month or custom dates. One row per agent and an All agents row, grouped as:
  - Leads received (different leads, first time, from another agent, moved away);
  - Calls the agent recorded (calls, answered, not answered, leads called, leads answered) and their outcomes;
  - First calls (first calls, on time, deadlines missed);
  - Follow-ups and notes; Admin calls on their leads; Now (waiting, missed, not connected, overdue follow-ups); talk time.
- Every number opens its records, 25 at a time. A name opens that agent: the same groups, Assignment history (from whom, to whom, how and by whom, the first-call deadline) and a day-by-day table for up to 62 days.
- **Dashboard:** Lead pipeline of all open leads; a **Not connected (overdue)** tile next to Missed first calls, opening All leads with that filter.
- **Today's calling:** Leads received today, Calls today with administrators' calls apart, Leads called and Not connected, each opening its records.
- **All leads:** the call filter gains **Not connected (overdue)** (deadline passed, no answered call in the current assignment, from anyone). A last call from an earlier assignment is marked "Earlier assignment".

Agents keep My activity; its calls now follow the same recorder rule.

| Item            | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| Migration       | `supabase/migrations/063_admin_reports.sql` (no table or row changes; safe to rerun) |
| Read-only check | `supabase/check-admin-reports-063.sql`                                               |
| Requires        | update 062 in production                                                             |

**What 063 changes in the database:** it adds `lead_not_connected`, `report_team_records` (one function that both counts and lists every metric, so a number and its list always agree), `report_team`, `report_team_days` and `report_team_drilldown`. It replaces `record_first_call`, `call_activity` and `crm_metrics` (adding `open_by_status`), and makes checked edits to `admin_lead_list`, `report_today_records`, `report_agents` and `report_records`. Each edit checks the function's exact text first; 063 stops and changes nothing if a function is not as expected, or if 062 is missing. Of the new functions, only the three report functions are open to the API server; none are open to browsers. Replaced functions keep their access.

**Release:**

1. Back up the database and test the restore.
2. Run the check: `at 062, ready for 063`, `transactions_open_over_1_min` = 0. Note the record counts.
3. Apply 063 and run the check again: `at 063`, `server_functions` = 3, `browser_function_access_must_be_0` = 0, the same record counts. (Done in production on 13 November 2026.)
4. Back up again and test the restore, retire the inactive slot, and deploy.
5. Smoke test, viewing only:
   - Dashboard: the pipeline total equals the open leads; Not connected (overdue) opens All leads with that filter;
   - Reports → Team performance → Yesterday: an agent's leads received, first time and from another agent match the reconciliation; a number opens its records;
   - as an agent: My activity, and no Team performance.

Apply 063 before the code. The live code keeps working with 063, but its screens already follow the new rules (calls by recorder; an administrator's call no longer sets an agent's first call). If the code goes out first, the new reports and the Not connected filter answer "needs CRM database update 063".

**Rollback:** roll back the application; the older code works with 063. 063 changes no data. Withdrawing its rules would take a new update that restores the earlier function versions.

**Known limits:**

- **Calls without an audit entry** (logged before audit records named the recorder) count for the call's agent, as before.
- **Background jobs.** Reports no longer depend on them, but missed-call notifications and reminders still do; the production worker must be restored separately.
