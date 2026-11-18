# Update 073: Lead export, file by file

Administrators can export leads file by file from **All leads → Export**,
with each lead's CRM history and the advertisement it came from. A file
here is a Google Sheet or an imported CSV/Excel file, or "No file" for
leads added another way.

The export works only from records the CRM already keeps. No table or row
changes; update 073 adds read-only database functions.

## How a lead's file and advertisement are known

- **Google Sheet:** each Sheet keeps one CRM lead file for good (update
  056).
  - A Sheet is told apart by its spreadsheet ID and tab, never by its name.
    Two Sheets called "General Form Leads" are two separate files.
  - Each Sheet row the CRM read is recorded, with whether it created a new
    lead or was a repeat inquiry from a customer who was already a lead.
- **CSV/Excel file:** each import is a lead file, with each lead's row in
  it (`lead_file_rows`).
- **No file:** leads added by hand, from Meta Lead Ads directly, WhatsApp
  or other sources.
- **Advertisement:** the one that created the lead, as recorded.
  - A Google Sheet row or a Meta Lead Ads submission gives the campaign, ad
    set, ad and form, with their IDs.
  - A CSV/Excel file gives only an ad name.
  - Nothing is guessed for a lead with none: it shows "None recorded".

## Administrators: All leads → Export

- **Starting point:** the dialog starts from the list's own filters: agent,
  assignment, temperature, latest call outcome, source and lead file.
- **Quick choices:** All leads from the files, Contacted, Not contacted,
  Interested, Hot, Warm, Follow-up required, Site visit scheduled, Won deals.
- **Files:** each Google Sheet (with its tab and, when names repeat, its
  spreadsheet ID), each CSV/Excel file, and No file, with the file's
  figures.
- **The lead now:**
  - Agent (or any agent, or no agent).
  - Source and status.
  - Temperature and latest call outcome, read exactly as All leads reads
    them.
  - Contacted, follow-ups, site visits and deals.
- **History (Pakistan days):**
  - Lead created from–to.
  - Had a call from–to; this also limits Call history to those days.
  - Had a call with a given outcome.
- **Count:** the number of matching leads, calls, notes and assignments
  shows before exporting.
- **Formats:** Excel with the chosen worksheets, or one worksheet as CSV.

## The file

| Worksheet          | One row per                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read me            | The export: when, by whom, the filters in words, what the columns mean                                                                                                                          |
| Lead summary       | Lead: number, CRM ID, name, phone, email, file (ID, spreadsheet ID, tab, row), source, advertisement (campaign, ad set, ad, form, IDs), agent, status, calls, temperature, latest comment, follow-up, site visit, deal |
| Call history       | Call: when, made by, the lead's agent then, answered (as recorded), duration (only for finished calls), outcome, temperature saved, notes                                                         |
| Notes              | Lead note, and follow-up, site visit and deal note, with author and date                                                                                                                        |
| Assignment history | Move: from, to (or back to the administrators), by whom, first-call deadline and first call                                                                                                     |
| Ad quality         | Advertisement: leads, contacted, not contacted, showed interest, Hot, Warm, Cold, none, with follow-ups, site visits, deals, won deals                                                          |
| Files              | File: rows in the source, new leads created, repeat inquiries, rows rejected, leads in the CRM now, in Deleted leads, no longer in the CRM, leads in this export                                  |

**Definitions** (also on the Read me sheet):

- **Contacted:** at least one answered (connected) call, from anyone, as
  Reports count answered calls. No answer, Busy, Wrong number and Number
  off are attempts, not contacts.
- **Showed interest:** at least one call with the outcome Interested, Site
  visit scheduled or Deal discussion, whatever came after.
- **Temperature:** the latest Hot, Warm or Cold saved with a call since the
  lead came to its current agent. Each lead counts once.
- **Latest call outcome:** the most recent call's outcome.
- **Repeat inquiry:** a Sheet row from a customer who was already a lead.
  It is counted under Files and is not exported as that Sheet's lead.
- **Rows in the source:** a Sheet's rows at its last check, or the rows in
  an imported file.

## Security

- **Administrators only:** the server checks on every request, and the
  database checks the administrator again on every call. Agents get 403
  whatever address they use.
- **Phone numbers:** shown in full, as in All leads, only on the Lead
  summary. Each number in the file is recorded as viewed. An export
  without the Lead summary reads no number.
- **Audit history:** each export is recorded with its filters and counts,
  never a customer's details.
- **Downloads:** sent once. Nothing is stored and there is no link to fetch
  the file again.
- **No formulas:** Excel cells are plain values. A CSV cell starting with
  `=`, `+`, `-` or `@` gets a leading apostrophe.
- **Deleted and erased leads:** leads in Deleted leads are never exported.
  Restored leads are exported again. Erased leads no longer exist and are
  counted only under Files, as "No longer in the CRM".
- **Size limits:** records are read 500 leads at a time, and CSV is
  written as it is read.
  - One Excel file holds up to 10,000 leads and 60,000 calls, notes and
    assignments.
  - A CSV worksheet holds up to 50,000 leads and 300,000 records.
- **Nothing is sent to Meta or anywhere else.**

## Release

| Item            | Value                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/073_lead_export.sql`: read-only functions only. No table, row or existing function changes. Safe to rerun.          |
| Read-only check | `supabase/check-lead-export-073.sql`                                                                                                   |
| Requires        | Update 072 in production (073 refuses to run before it)                                                                                |
| Code            | The Export dialog on All leads, server routes under `/leads/export`, Audit history wording. Before 073, the dialog says "Lead export needs CRM database update 073". |

1. Release 072 first (see `KPI_EVIDENCE_RELEASE.md`).
2. Run the check. It should read `at 072, ready for 073` with
   `transactions_open_over_1_min = 0`.
3. Apply 073 and run the check again. It should read `at 073` and
   `export_functions = 6`.
4. Deploy the code. Its order with 073 does not matter: the code before 073
   never calls the new functions.

**Rollback:** the code before 073 has no Export dialog and ignores the
functions. They can stay; they read only.
