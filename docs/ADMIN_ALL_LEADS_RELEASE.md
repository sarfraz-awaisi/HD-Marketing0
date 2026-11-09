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
- **Reassigning and removing an agent** are done one lead at a time, never in bulk, so no agent's lead is taken by mistake.
- **The lead file filter** lists the latest 100 files. A file opened from Task assign or the Google Sheets page always works.
- **A search of three or fewer digits** is treated as a name.
