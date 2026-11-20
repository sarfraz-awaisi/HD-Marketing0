# Lead Usage and agent history (update 075)

Administrators can see which leads have been passed between agents, and what
each agent did with them.

- **All leads → Lead Usage** (next to Export): All Leads, Used 2 Times …
  Used 5 Times, each with how many leads it would show.
- **Used N times** in a lead's row (under "Assigned to") opens the lead's
  **agent history**.

Update 075 edits All leads' list function (checked edits, as in 061–068) and
adds one read-only function. No table, row or trigger changes.

## What "used" means

A lead's usage is the number of **different sales agents it has ever been
assigned to**, counted by account ID from its assignment history
(`public.assignments`, one row for every assignment and removal).

| History                                   | Usage  |
| ----------------------------------------- | ------ |
| Agent A → Agent B                         | 2      |
| A → B → C                                 | 3      |
| A → B → A                                 | 2      |
| A → admin team (no agent) → B             | 2      |
| A → admin team → A → admin team → A       | 1      |
| A → B → C → D → E                         | 5      |

- **Exact, not "at least":** Used 3 Times lists leads with exactly 3 agents.
- **Only these choices:** All Leads (default) and Used 2, 3, 4 and 5 Times.
  There is no "Used 6+ Times" choice; the server and the database refuse
  any other number.
- **More than five agents:** such a lead is in no Used N Times choice (not
  in Used 5 Times). It stays under All Leads, shows "Used 6 times" (or
  more) in its row, and its agent history shows every agent and every
  period. Nothing in the history is shortened, and 075 never changes an
  assignment row.
- **The admin team is no agent.** Repeat assignments to the same agent count
  once.
- **Former and disabled agents still count.** Renaming an agent changes
  nothing.
- **Deleted leads** are never listed or counted. Erased leads no longer
  exist. A restored lead keeps its history.
- The counts are worked out in the database across every lead, with **every
  other search and filter applied** (search, assignment/agent, temperature,
  first call, call outcome, source, lead file, country). Choosing a usage
  also narrows the Total/Assigned/Unassigned counts, the pages and Select
  all.

## The agent history

One card per assignment period, oldest first:

- the agent, Agent ID, current or earlier, disabled or former account;
- when the period started and who assigned it;
- when it ended: the next assignment's time, "Current", or **"End not
  recorded"** (see limitations);
- what the agent did, in precise words: Assigned but never worked, Call
  attempted (not reached), Successfully contacted, Customer response,
  Follow-up performed;
- the agent's own calls, successful contacts, call outcomes, temperatures
  and latest call comment;
- every record saved in the period, oldest first, each with who saved it:
  calls (outcome, temperature, tags, comment exactly as saved), notes, stage
  changes, follow-ups, site visits and deals.

**Who did what** comes from the audit log, as everywhere in the CRM. A call
an administrator logs is filed under the lead's agent but recorded by the
administrator. It is shown as the administrator's and never counted as the
agent's. When no record of who saved something exists, it says "Historical
value unavailable".

Temperature is only ever saved with a call (update 052), so each call's
temperature is exactly what was chosen then. A period with no temperature
says so; nothing is copied from the lead's current temperature.

Administrators only, checked in the server and in the database. It returns
no phone number, document or recording.

## Export

**The export does not use Lead Usage.** It is update 074's file-by-file
export, unchanged. When Lead Usage is chosen, the Export dialog says so:
"The export does not use Lead Usage: it lists every assigned lead of the
file you choose, whatever its usage."

Proposal (not built, needs approval): add an optional `usage` (2–5) key to
074's `lead_file_export_match` and a "Lead Usage" choice under "Narrow the
list" in the Export dialog, preset from All leads. Small read-only function
change; the 37 columns stay as they are.

## Known limitations

- **Deleting a lead removes its agent without an assignment row** (update
  032), and its audit entry does not name the lead. When a lead is deleted
  and restored, the last agent's period has no recorded end ("End not
  recorded"). If such a lead was later given to a new agent, the earlier
  agent's period runs until that new assignment. Nothing in the database can
  say when it really ended.
  - Proposal (not built): have `delete_leads` add an assignment row with no
    agent and reason `lead_deleted`.
- Records are placed in a period **by when they were saved**. A manual call
  logged later with an earlier time shows "saved …".
- Assigning the same agent again with no one in between stays one period
  ("Assigned to … again …").
- The number of different agents is by account; an account whose role
  later changed still counts for the times it had the lead as an agent.

## Release

1. Owner runs `supabase/check-lead-usage-075.sql` (read-only, counts only).
   Expect `release_stage = 'at 074, ready for 075'` and
   `transactions_open_over_1_min = 0`. Any "NOT READY" stops the release.
2. Owner applies `supabase/migrations/075_lead_usage_history.sql`. It stops
   and changes nothing if All leads' function is not the expected version.
3. Run the check again. Expect `release_stage = 'at 075'` and
   `history_function = 1`.
4. Deploy the code.

**Order:** 075 before the code. Code without 075 still works: Lead Usage is
greyed out ("needs CRM database update 075"), and the history says the
same. 075 without the new code changes nothing visible; the old site ignores
the new fields.

**Rollback:** redeploy the previous code. 075 can stay: its list changes are
additive and its function is unused without the new code.

## Files

- `supabase/migrations/075_lead_usage_history.sql`
- `supabase/check-lead-usage-075.sql`
- `server/src/routes/crm.routes.js` (`GET /leads/all?usage=`,
  `GET /leads/:id/agent-history`)
- `server/src/utils/validators.js`
- `client/src/lib/leadUsage.js`
- `client/src/components/leads/LeadUsage.jsx`
- `client/src/components/leads/AdminLeadList.jsx`
- `client/src/components/leads/LeadExport.jsx`
- `client/src/pages/admin/Leads.jsx`
- `client/src/styles/lead-usage.css`
- Tests:
  - `server/tests/lead-usage.test.js`
  - `server/tests/lead-usage-migration.test.js`
  - `client/tests/lead-usage.test.jsx`
