# Lead export: one lead file's assigned leads (updates 073 and 074)

Administrators export leads from **All leads → Export**, one lead file at
a time. A lead file is a Google Sheet, an imported CSV/Excel file, or "No
file" for leads added another way.

The Excel file lists **every lead of that file that is assigned to an agent
now**: contacted or not, called or not, with or without a temperature. Each
lead appears once. The columns are exactly the Lead pipeline export's 37
columns, filled by the same code.

Update 073 (in production since 18 Nov) added read-only functions for the
first, multi-worksheet version. Update 074 adds the read-only functions this
version needs. No table or row changes in either.

## How a lead's file is known

- **Google Sheet:** each Sheet keeps one CRM lead file for good (update
  056).
  - A Sheet is told apart by its spreadsheet ID and tab, never by its name.
    Two Sheets called "General Form Leads" are two separate files.
  - A Sheet row from a customer who was already a lead is a **repeat
    inquiry** on that lead. It stays with the lead and its first file; it
    is not a lead of the second Sheet.
- **CSV/Excel file:** each import is a lead file. A number that is already
  a lead is rejected at import.
- **No file:** leads added by hand, from Meta Lead Ads directly, WhatsApp or
  other sources.
- **What changes it:** only importing, deleting a file with "file only"
  (its leads keep going, with no file), and restoring a lead whose file was
  deleted. Reassigning or editing a lead never changes its file.

## Administrators: All leads → Export

1. **Lead file:** choose one. Each file shows its figures: rows, new leads,
   repeat inquiries, rejected rows, leads in the CRM now. When two files
   share a name, the spreadsheet ID or date tells them apart. If All leads
   is showing one file, it is chosen to start with; nothing else is.
2. **Narrow the list (optional):** agent, temperature, status, last call
   outcome, contacted, worked. By default, none.
3. **Counts:** rows in the Sheet or file (when known), the file's leads in
   the CRM, those assigned to an agent now, and the leads to export.
4. **Export Excel:** one file, for example
   `General-Form-Leads-Assigned-2026-11-19.xlsx` (the day in Pakistan).

## The file

- One worksheet, **Leads**: the 37 headings in row 1, one lead per row
  from row 2, in the file's order. Nothing else: no notes, no other
  worksheets.
- The heading row is bold, stays in view (frozen), and has AutoFilter on
  every column.
- Long text (notes, ad answers, location) wraps. Phone numbers, Lead # and
  Agent UID are text; budgets are numbers; times are Pakistan time
  (`2026-11-19 14:05`), as in the Lead pipeline export.

**Definitions** (the Lead pipeline's, for every lead):

- **Agent's last contact / Last contact outcome:** the agent's own latest
  answered call.
- **Last call / Last call outcome:** the agent's own latest call, answered
  or not.
- **Agent's latest note:** the newest lead note the agent wrote, or call
  note the agent recorded.
- An agent's own call is filed under the agent **and** recorded by the
  agent. An administrator's call is never the agent's, and an earlier
  agent's calls and notes are not the new agent's.
- **Temperature:** the latest Hot, Warm or Cold saved with a call since the
  lead came to its current agent.
- **Next follow-up:** the earliest pending follow-up.
- **Ad columns:** from the lead's Google Sheet inquiries, the latest first,
  as on the lead's page. "Advertisement" falls back to the ad name kept on
  the lead.
- **Filters:** Contacted means the agent got through; Worked means the
  agent called.

**The Lead pipeline export** (Lead pipeline → Export, Excel) now uses the
same layout: bold, frozen heading row with AutoFilter, the same widths and
wrapping, Agent UID as text. Its leads, columns and values are unchanged;
its CSV is unchanged.

## Known limitations

Both exports share these. They are unchanged by this release.

- **Ad columns show the latest inquiry, not necessarily the ad that created
  the lead.** A customer created by "DHA Phase 9 plots" who later wrote in
  through "Bahria Town houses" shows Bahria Town in Advertisement,
  Campaign, Ad form and the ad answers. Only Google Sheet inquiries are
  read: a lead from Meta Lead Ads directly has blank ad columns, except
  Advertisement when the lead keeps an ad name.
- **Budget from shows 0 when no minimum budget was given.** The database
  cannot tell "not given" from a real 0: `leads.budget_min` is required,
  with 0 as its default, and the lead form sends 0 when it is left empty.
  See the proposal below.
- **A lead called only by an administrator** has a blank Last call and
  Agent's last contact: the call is not the agent's.
- **Rows in the Sheet** counts every row at the Sheet's last check,
  including blank rows and rows before its start date.

**Proposal (separate update, not in 074): a missing minimum budget.**

1. Let `leads.budget_min` be empty (drop its default of 0); the lead form,
   imports and Meta stop sending 0 for an empty field.
2. The exports and lead pages show an empty budget as blank.
3. Existing zeros stay as they are: none can be told apart from a real 0.
   Treating every historical 0 as "not given" (an amount of PKR 0 is not a
   real budget) is a separate decision for the owner, and would change no
   stored value: only how 0 is shown.

## Security

- **Administrators only:** the server checks on every request, and the
  database checks the administrator again on every call. Agents get 403.
- **Phone numbers:** in full, as in All leads. Each number in the file is
  recorded as viewed.
- **Audit history:** each export is recorded with its filters and count,
  never a customer's details.
- **Downloads:** sent once. Nothing is stored and there is no link to fetch
  the file again.
- **No formulas:** every cell is a plain value; the file has no formula at
  all.
- **Deleted and erased leads:** never exported. A restored lead comes back
  with no agent, so it is exported again once it is assigned.
- **Size:** up to 10,000 leads in one file, read 500 at a time.
- **Nothing is sent to Meta or anywhere else.**

## Release of 074

| Item            | Value                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/074_file_lead_export.sql`: read-only functions only. No table, row or existing function changes. Safe to rerun.                 |
| Read-only check | `supabase/check-file-lead-export-074.sql`                                                                                                            |
| Requires        | Update 073 in production (074 refuses to run before it)                                                                                              |
| Code            | The Export dialog on All leads and the server routes under `/leads/export`. Before 074, the dialog says "Lead export needs CRM database update 074". |

1. Run the check. It should read `at 073, ready for 074` with
   `transactions_open_over_1_min = 0`.
2. Apply 074 and run the check again. It should read `at 074` and
   `export_functions = 2`.
3. Deploy the code **after** 074: the new code calls the new functions. The
   code before it never calls them.

**Rollback:** the code before this release goes back to the multi-worksheet
export, which still works: 073's functions are kept. 074's functions can
stay; they only read.
