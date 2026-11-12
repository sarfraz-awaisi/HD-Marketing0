# Administrators' All leads: update 057 release plan

Update 057 rebuilds **Sales › Leads › All leads** for administrators on the pattern of an agent's Assigned leads.

- **Table:** #, Customer name, Phone number, First call, Assigned to, Last contact and Actions.
  - HD numbers, emails, file names, status, source, location and dates stay on the lead's page, not in the table.
  - Nothing is removed from the database.
- **Search** covers every lead, server-side:
  - by name;
  - by contact number, in any common Pakistani format or any part of it (`0300 1234567`, `+92 300 1234567`, `3001234567`, the last digits…);
  - by an HD number written with HD.
- **Filters** work together and are kept in the address, so Back from a lead returns to the same list and page. **Reset filters** clears them all.
  - assignment: All leads, Assigned, Unassigned, or Assigned to one agent;
  - first call: waiting or missed;
  - status and lost reason (as before);
  - source;
  - lead file, with Google Sheets files marked.
- **Total, Assigned and Unassigned** are the database's counts. They count the leads matching the search and filters other than assignment, and the page says whether filters are applied. Clicking Assigned or Unassigned filters the list.
- **Assigning:**
  - **Assign** gives an unassigned lead to an agent, or round-robin. It never takes a lead that gained an agent in the meantime.
  - **Reassign** moves a lead to another agent, or removes its agent, after the administrator confirms. The current agent is named, and calls, notes and history stay with the lead.
  - **Bulk:** tick leads, or **Select all matching** (up to 500), then **Assign unassigned** to one agent or **Round-robin unassigned**, after a confirmation.
    - Leads that already have an agent are never changed. The results name each one: assigned, not changed (with its agent), or failed (with the reason).
    - Every assignment is in the audit history.
- **Unchanged:**
  - Import CSV / Excel, Add lead, and Delete for selected leads (with its dialog);
  - Edit is on the lead's page, which keeps customer details, the advertisement inquiry, notes, calls and audit history;
  - agents' Assigned leads and Lead pipeline.

**The owner approves every step that touches production.** Nothing in this plan has been run against production.

| Item            | Value                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/057_admin_all_leads.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-admin-all-leads-057.sql`: one SELECT, flags and counts only     |
| Requires        | update 056 in production (applied)                                              |

## Why a migration

Contact numbers are kept apart from leads (`crm_private.lead_phones`), where the API cannot filter lead lists, so searching by number across every lead must happen in the database. 057 adds two server-only functions and changes no table, data or existing function:

- **`admin_lead_list`:** search, filters, counts and pages for administrators (agents get 42501).
- **`assign_unassigned_leads`:** locks the chosen leads, skips any with an agent, and passes the rest to the existing `assign_leads_bulk` (update 030), with its rules, per-lead results and audit entries.

**The new code needs 057:** without it, All leads shows "This feature needs CRM database update 057 after 056." So apply 057 before deploying. The current code ignores the new functions.

## Release

1. **Merge** the PR with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up**, and check that the backup restores (v1.1.0 runbook step 4). Scheduled backups have been unreliable, so run one by hand.
3. **Run** `check-admin-all-leads-057.sql`. Required:
   - `release_stage` = `at 056, ready for 057`;
   - `transactions_open_over_1_min` = 0.

   Note the counts.
4. **Apply 057** in the SQL Editor: paste the whole file and run it.
5. **Run the check again.** Required:
   - `release_stage` = `at 057`;
   - `server_functions` = 2;
   - `browser_function_access_must_be_0` = 0;
   - the counts as before, apart from normal use.
6. **Retire the inactive slot** (server guide section 10), then **deploy `<SHA>`** with the Production workflow. Approving this deploy also releases the Google Sheets code (update 056), which is already in `main`; its import stays off until the owner turns it on.

## Smoke test (administrator)

1. **All leads:**
   - the three counts match the CRM's total;
   - the table has the seven columns and no HD numbers;
   - it shows 20 leads per page, numbered on from page to page.
2. **Search:** a customer by part of their name, then by their number written `03…`, `+92 …` and by its last digits.
3. **Filters:**
   - Unassigned, then one agent;
   - Missed first call;
   - source Meta, then a Google Sheets file.
   - The counts say they are filtered, and Reset filters restores everything.
4. **Back:** open a lead with filters on; Back returns to the same list and page.
5. **One lead:**
   - Assign an unassigned test lead;
   - Reassign it, after the confirmation;
   - use a lead the owner chooses, or one created for the test and deleted afterwards. Never a customer's lead without the owner's say.
6. **Bulk:** only if the owner wants it checked on live data. Select unassigned test leads and Assign unassigned; the results list each one.
7. **An agent** still sees their own files, Assigned leads and Lead pipeline, and never All leads.

## Rollback

- **Code:** roll back the application (v1.1.0 runbook steps 8.2–8.4). The older code works with 057.
- **Database:** nothing needs undoing. The two functions are unused by the older code; to remove them anyway, drop both.

## Known limits

- **Select all matching** takes at most 500 leads; narrow the filters first.
- **Removing an agent** is done one lead at a time, never in bulk. Since update 060, **Assign to agent** moves selected leads from their agents in bulk, after confirming.
- **The lead file filter** lists the latest 100 files. A file opened from Task assign or the Google Sheets page always works.
- **A search of three or fewer digits** is treated as a name.

## Update 058: Call outcome and Temperature filters

The All leads filter bar is now: search, assignment, **Temperature**, first call, **Call outcome**, source and lead file.

- **Status and lost reason** are no longer filters here. Leads keep their status and lost reason, the lead's page shows them, and nothing else changes. The server still accepts both filters.
- **First call:** the options are named **New** and **Not connected** (they were "Waiting for first call" and "Missed first call"). They match exactly the same leads.
- **Call outcome** (default "All call outcomes") uses the Call dialog's outcomes, Number off included. It matches the outcome of the lead's **latest call**, as the Lead pipeline does, so a lead with no call matches none of them and is listed under "All call outcomes".
- **Temperature** (Hot, Warm, Cold or Not recorded yet) uses the latest temperature saved with a call, as the Lead pipeline does.
- Both new filters work in the database, with search, assignment, the counts, pages and Select all matching. **Reset filters** clears them.

| Item            | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/058_admin_leads_call_filters.sql` (replaces `admin_lead_list` only; safe to rerun) |
| Read-only check | `supabase/check-admin-leads-call-filters-058.sql`                                     |
| Requires        | update 057 in production (applied)                                                    |

**Why a migration:** 057's `admin_lead_list` reads the latest call only for the rows of the page shown. Filtering every page by that call needs the database. 058 changes no table or data, and answers every earlier query exactly as 057 did (a test compares them).

**Release:**
1. Back up the database and test the restore.
2. Run the check (`at 057, ready for 058`), apply 058, then run the check again (`at 058`, `server_functions` = 2, `browser_function_access_must_be_0` = 0).
3. Retire the inactive slot (blue `ad108a4`) and deploy.

If the code goes out before 058, the page works but choosing Call outcome or Temperature says "This filter needs CRM database update 058 after 057." Applying 058 then fixes it.

**Rollback:** roll back the application; the older code works with 058.

## Update 060: move selected leads to another agent

Before 060, bulk assignment in All leads only assigned leads with no agent. Moving five of one agent's leads to another agent gave "0 leads assigned · 5 leads not changed", each "Already assigned to" their current agent. The chosen agent was sent correctly, but 057's `assign_unassigned_leads` skips every lead that has an agent by design. The single-lead **Reassign** already worked.

- **Assign to agent** (was "Assign unassigned") moves the selected leads to the chosen active agent, whoever has them and whatever their calls (No answer, Busy, Number off or answered). It uses the single-lead Reassign's rules:
  - calls, notes, deals and history stay with the lead;
  - pending follow-ups, scheduled visits and their reminders move to the new agent;
  - each move is in the audit history, and both agents are notified;
  - the new agent opens the lead, and the old agent no longer can.
- **A moved lead starts a fresh first-call deadline** for the new agent and shows as **New** under First call until they call, as with single Reassign. Its earlier calls stay in its history.
- **The confirmation** says that leads with another agent will move. **The results** read "N assigned · N reassigned · N not changed · N failed":
  - **reassigned** leads are listed with "Moved from …";
  - leads already with the chosen agent are **not changed** ("Already assigned to …").
- **Round-robin unassigned** is unchanged: it only assigns leads with no agent. The single-lead Assign and Reassign and agents' permissions are unchanged.

| Item            | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/060_admin_lead_reassignment.sql` (adds `admin_assign_leads` only; safe to rerun) |
| Read-only check | `supabase/check-admin-lead-reassignment-060.sql`                                          |
| Requires        | update 059 in production (applied)                                                        |

**Why a migration:** telling "assigned" from "reassigned" exactly needs each lead's agent read under the same lock as the move. 060 adds one function and changes no table, data or existing function (a test compares them).

**Release:**
1. Back up the database and test the restore.
2. Run the check (`at 059, ready for 060`), apply 060, then run the check again (`at 060`, `server_functions` = 3, `browser_function_access_must_be_0` = 0).
3. Retire the inactive slot (green `bd793be`) and deploy.

If the code goes out before 060, Assign to agent says "This feature needs CRM database update 060 after 059." Applying 060 then fixes it. Round-robin unassigned and single-lead Reassign keep working.

**Rollback:** roll back the application. The older code works with 060, and its bulk Assign again skips leads that have an agent.

## Update 062: share selected leads among agents

Before 062, bulk assignment gave the selected leads to one agent (060), or shared only leads with no agent among all active agents (Round-robin unassigned, 057). **Assign to agents** now opens one dialog for both, with a preview first.

- **The agent list** shows active agents only, searchable by name or UID.
- **One agent** gives every selected lead to that agent, as 060 did. **Share among agents in turn (round-robin)** shares them among the chosen agents, whoever has them now and whatever their calls (No answer, Busy, Number off, Interested or any other outcome):
  - each agent gets an even share; the shares differ by at most one lead;
  - a lead already with one of the chosen agents stays with them while their share allows, so no lead moves without need. The larger shares go first to the agents who already have the most of the selected leads;
  - the other leads go to the agents in turn, alphabetically, lowest lead number first. The same leads and agents always give the same plan, whatever order the agents were chosen in.
- **Preview.** Before anything changes, the dialog shows the plan:
  - how many leads are assigned, reassigned, not changed and failed;
  - for each agent, the leads they keep, get new, get moved in, and their total;
  - which agents the moved leads come from.

  The preview is marked as worked out at that moment. When it is confirmed, the database works the plan out again under its assignment lock. If anything changed since the preview (another administrator moved or deleted one of the leads, or an agent was deactivated), nothing moves and the updated plan is shown to confirm again.

- **Results** show the same counts and each agent's share, and list every lead that moved, did not change or failed, with the reason.
- **Each move is a normal assignment:**
  - calls, notes, deals and audit history stay with the lead;
  - pending follow-ups, scheduled visits and their reminders move with it;
  - both agents are notified;
  - a lead that came from another agent opens a fresh workspace for its new agent (update 061);
  - one entry in the audit history ("Shared leads among agents") records the action.
- **Refused or reported:**
  - an incoming social lead still waiting for its first agent is refused when shared among two or more agents, as round-robin always has; with one agent it is assigned;
  - deleted leads are reported as failed;
  - agents that are inactive, deleted, staff or administrators are refused, as are an empty choice, the same agent twice, and more than 500 leads.
- **Select all matching** works as before: it sends at most 500 lead ids, never lead details.
- **Unchanged:** Round-robin unassigned, the single-lead Assign and Reassign, and agents' permissions. The 060 endpoint stays for compatibility.

| Item            | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/062_admin_lead_distribution.sql` (adds `admin_distribute_leads` only; safe to rerun) |
| Read-only check | `supabase/check-admin-lead-distribution-062.sql`                                                          |
| Requires        | update 061 in production                                                                                  |

**Why a migration:** the plan must be worked out from each lead's agent under the same lock as the moves, and the preview must change nothing. 062 adds one function and changes no table, row or existing function (a test compares them).

**Release:** after 061.

1. Back up the database and test the restore.
2. Run the check: it should read `at 061, ready for 062`.
3. Apply 062, then run the check again: it should read `at 062`, with `server_functions` = 3 and `browser_function_access_must_be_0` = 0.
4. Deploy.

Apply 062 before the code. If the code goes out first, Assign to agents says "This feature needs CRM database update 062 after 061" until 062 is applied, including when one agent is chosen. Round-robin unassigned and the single-lead Reassign keep working.

**Rollback:** roll back the application. The older code works with 062 and brings back the single-agent picker.
