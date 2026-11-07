# Agents' Assigned leads and Lead pipeline: update 052 release plan

Update 052 reorganises an agent's leads under **My leads** in the menu:

- **Assigned leads** (the old My leads, simplified):
  - one search box for a customer's name, contact number (any common format) or **#**;
  - no status, lost-reason or HD-number columns and filters;
  - the source and first-call filters, call actions and first-call tracking are kept.
- **Lead pipeline**: only the agent's leads with an **answered call**, whatever their status now.
  - Status and temperature filters, with search, work together across every page.
  - Hot, Warm and Cold counts can be selected as filters.
- **Lead temperature** in the call form is exactly 🔥 Hot, 🌤️ Warm or ❄️ Cold, one per call, asked only after a conversation.

Administrators' Leads page and workflows are unchanged. The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/052_agent_lead_pipeline.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-agent-lead-pipeline-052.sql`: one SELECT, flags and counts only    |
| Requires        | update 051 in production                                                           |
| Code            | this branch, built on `main` `5a586cf` (which holds 050 and 051)                   |

## Why the status filter seemed broken

The filter itself was correct. On a real local stack it returned exactly the stored statuses, matching the database for all eight. What made agents' lists look broken:

- **Statuses move less than people expect.** Only an answered call moves a lead from New to Contacted. Choosing the call outcome "Interested" does not make the lead Interested, so "Interested" listed only leads someone had set by hand.
- **Filters were lost on every lead opened.** They lived in the page, not the address, and Back to leads went to the file's first page.
- **# was only a place on the page.** Inside a file, leads were ordered newest first, and a whole file has one creation time, so their order (and every #) was effectively random.
- **Searching with + or # failed.** "+92 300 …" or "#22" made the list show "Invalid input: search", and contact numbers were not searched at all.

## What 052 changes

- **New private table `crm_private.lead_file_rows`:** each file lead's fixed number (#).
  - Existing files are numbered in import order (lead numbers rise row by row). Deleted leads keep their number, so a restored lead returns to its place.
  - Numbers never change: not with filters, pages, reassignment or the deleted-leads purge.
- **New trigger `number_file_lead` on `leads`:** gives the next number when a lead joins a file (imports create each lead, then set its file).
- **New function `agent_lead_list`:** one agent's own leads, for Assigned leads or the pipeline. Only the server's service role can call it, and it refuses anyone but an active agent.
- **No existing table, row or function changes.** A test checks every row, every other function and trigger, and every report's output before and after 052.

**Temperature is not a new field.** It is the existing call tag (Hot lead, Warm lead, Cold lead), as the report lists already read it (update 050). A lead's temperature is the latest one saved with a call; no call is ever changed. Agents update it by recording their next conversation. A call's other old tags (Budget mismatch and so on) stay on that call; new calls no longer offer them.

**In the pipeline, "contacted" means an answered call:** `calls.status = 'completed'`, the same rule that moves a lead to Contacted. Unanswered calls, missed first calls and opening a lead never count.

## How it was verified (locally only)

- **Server tests:** 15 new tests plus a migration test.
  - Fixed numbers through reassignment, deletion and the purge.
  - Search by name, contact number (seven formats) and #, on any page; a # is never matched against contact numbers.
  - Every status × temperature combination over 48 leads, all pages, exact counts.
  - Agents see only their own leads; administrators, staff and invalid filters are refused.
  - One temperature per call, only after a conversation.
- **Migration test:** on a database at 051, 052 changes no row, function, trigger or report output. It numbers existing files in import order, and applying it again changes nothing. It numbers new imports and refuses to run before 051. The read-only check gives the expected answers before and after.
- **Real browser, throwaway local stack** (`hd-crm-work`, PostgreSQL 17): 35 of 36 checks passed, with data seeded through the real API.
  - The one flag was test noise: font and favicon requests cut off when the test opened the next page. No app console errors, no failed API calls.
  - Covered: the menu; # and paging; search by #, phone and name; Back keeping filters; 45 status × temperature combinations against SQL written separately; a call from the pipeline changing the temperature; 390 px; Sara's and the administrator's views.
  - A bug found there was fixed before the final run: "#10" also matched contact numbers containing 10.
  - Afterwards the main local database was identical.
- **Full suites:** server 1100 passed, client 488 passed; build and `check.py` pass.

## 1. Before the release

1. **Update 051 must already be in production:** its check says `at 051`.
2. **Review and merge** this PR into `main`, with CI green. Record the full new `main` SHA as `<SHA>`.
3. **Back up** with a fresh encrypted backup, and check that it restores (v1.1.0 runbook step 4).
4. **Run** `supabase/check-agent-lead-pipeline-052.sql` and save the result. Required:
   - `release_stage` = `at 051, ready for 052`;
   - `transactions_open_over_1_min` = 0;
   - note the `existing_*` counts and `file_leads`.

## 2. Apply 052 (Supabase SQL Editor; database first)

1. Open a new query, paste the **whole** file and run it. It sets a 5 s `lock_timeout`, briefly locks `leads` to add the trigger, and numbers about 1,100 leads.
2. Run the check again. Required:
   - `release_stage` = `at 052`;
   - `numbered_file_leads` = `file_leads`;
   - `number_trigger` = 1, `server_functions` = 1;
   - every `*_must_be_0` = 0;
   - the `existing_*` counts as in step 1, apart from normal use.

**The live code is unaffected by 052.** It never calls the new function, and the trigger only numbers leads.

## 3. Deploy the code

Deploy `<SHA>` with the Production workflow, as in v1.1.0 runbook step 6. The inactive slot must be retired first (server guide section 10).

**The database comes first:** code deployed before 052 shows agents "This feature needs CRM database update 052" on Assigned leads and the pipeline.

## 4. Smoke test (read-only, about 10 minutes)

1. `curl -sI https://hdmarketing.tech | grep -i x-release-sha` shows `<SHA>`.
2. **Agent menu:** My leads opens and closes; it holds Assigned leads and Lead pipeline.
3. **Agent, Assigned leads:**
   - open a file: # runs 1, 2, 3 in file order, also on page 2;
   - search `#` plus a number on page 2: that lead alone;
   - open it, then Back to leads: the search is still there.
4. **Agent:** search a lead's contact number written as `03…`, then as `+92 …`: the same lead.
5. **Agent, Lead pipeline:**
   - the Hot, Warm and Cold counts add up to the total;
   - choose a status, then a temperature: the list and total agree;
   - Reset filters shows everything.
6. **Administrator:** Leads still has the status and lost-reason filters and the Lead number column.

Opening the lists audits phone numbers as the old My leads did; nothing else is written.

## 5. Rollback

- **Code:** roll back the application (v1.1.0 runbook step 8.2–8.4). The older code ignores everything 052 adds.
- **Database:** nothing needs undoing. 052 adds a table, a trigger and a function, and changes no data. If the owner wants them gone, after the code rollback and as a separately approved step:

  ```sql
  begin;
  drop trigger if exists number_file_lead on public.leads;
  drop function if exists public.number_file_lead();
  drop function if exists public.agent_lead_list(uuid,jsonb);
  drop table if exists crm_private.lead_file_rows;
  commit;
  ```

  Dropping the table loses the numbers; reapplying 052 numbers the files again, in the same import order.

- **Never restore a backup** to undo this release.

## Decisions and limits

- **Leads added without a file** (manually, Meta, WhatsApp) have no # and show "No file". Search finds them by name, contact number or HD number (`HD-000145` still works).
- **Search rules:**
  - `#15`, or one to four digits, is a file number;
  - five or more digits is part of a contact number;
  - anything else is part of a name.
  - In All my leads, numbers repeat between files, so each # shows its file's name.
- **Searching part of a contact number** looks only at the agent's own leads, whose numbers the list already shows them.
- **A lead contacted by one agent and then reassigned** is in the new owner's pipeline (it has an answered call) and leaves the old owner's.
- **The status filter lists the app's existing statuses** with their existing names: "Site visit scheduled", "Won (booked)".
- **Lost reason** now shows under the Lost status in Assigned leads, rather than in its own column.
