# Number off, simpler lead lists and the new Call dialog: update 053 release plan

Update 053 refines what agents use every day:

- **Number off** is a new call outcome for a phone that is switched off. Like No answer, Busy and Wrong number, it is a call that did not connect, so it never puts a lead in the Lead pipeline or moves it to Contacted.
- **Lead pipeline:**
  - search, temperature and a new call-outcome filter (the latest call's outcome);
  - no status filter or sort menu: latest contact first;
  - an **Agent notes** column instead of Status: the agent's own latest note on the lead.
- **Assigned leads:**
  - columns: #, Customer, Phone, First call, Last contact, Actions;
  - filters: search, first call, and last call (which finds Number off leads never reached).
- **# is the row's place in the list** (1, 2, 3 … across pages). No file names, file numbers or HD numbers in either table.
- **Search** is by customer name or phone number only, in any common Pakistani format or by its last four or more digits.
- **The Call dialog** has three parts:
  - **Customer details:** Call, and WhatsApp click-to-chat in a new tab, which sends nothing and logs no call;
  - **Call information**;
  - **Lead qualification**;
  - Cancel and Save at the bottom.

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/053_number_off_and_agent_notes.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-number-off-053.sql`: one SELECT, flags and counts only                    |
| Requires        | update 052 in production                                                                  |

## What 053 changes

- **Two call rules** (`calls_outcome_check`, `calls_manual_values_check`) also accept Number off, only on a call that did not connect. Every existing call already satisfies them. The calls table is briefly locked while they are checked.
- **`log_manual_call`** is as in update 018, except Number off joins the outcomes of a call that did not connect, and is refused on an answered call.
- **One partial index on `audit_log`** (`audit_log_note_records`, notes only) finds who wrote a note. Audit writes wait for under a second while it is built.
- **`agent_lead_list`** is as in update 052, with these changes:
  - name or phone search only;
  - an `outcome` filter on the latest call;
  - each row's latest call;
  - the agent's own latest note (a lead note or a call's notes), worked out for the shown page only. The author is whoever the audit log says created it: a note or call saved by an administrator on an agent's lead is filed under that agent but never shown as theirs.
  - It still accepts 052's status filter and sorts, so a page left open from before keeps working.
- **No row, table or other function changes.** A test checks every row, every other function and trigger, and every report's output before and after 053.

## Release

1. **Merge** the PR, with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up**, and check that the backup restores (v1.1.0 runbook step 4).
3. **Run** `check-number-off-053.sql`. Required:
   - `release_stage` = `at 052, ready for 053`;
   - `transactions_open_over_1_min` = 0;
   - note the `existing_*` counts.
4. **Apply 053** in the SQL Editor: paste the whole file and run it.
5. **Run the check again.** Required:
   - `release_stage` = `at 053`;
   - `server_functions` = 2;
   - every `*_must_be_0` = 0;
   - the counts as before, apart from normal use.
6. **Retire the inactive slot** (server guide section 10), then **deploy `<SHA>`** with the Production workflow.

**The database comes first.** Before 053, the new pages show "No notes yet" and "Not called yet", and choosing an outcome filter fails. The live code works unchanged with 053.

## Smoke test (agent)

1. In the Call dialog:
   - WhatsApp opens a chat with the customer in a new tab;
   - Not connected offers Number off;
   - save one, and the lead stays out of the Lead pipeline.
2. **Assigned leads:** Last call: Number off lists that lead, numbered from 1.
3. **Lead pipeline:**
   - # runs 1, 2, 3, also on page 2;
   - search a number as `03…` and as `+92 …`;
   - the Agent notes column shows your latest note.

## Rollback

- **Code:** roll back the application (v1.1.0 runbook step 8.2–8.4).
- **Database:** nothing needs undoing; the older code works with 053.
  - Re-running `052_agent_lead_pipeline.sql` restores 052's list, if wanted.
  - Calls saved as Number off keep that outcome, so the two call rules stay.
