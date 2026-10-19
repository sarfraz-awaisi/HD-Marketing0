# Imported files and task assignment

Administrators can assign every accepted lead from a CSV, XLSX or XLS upload to one active agent. Agents see those files in **My leads** and open a file to see its leads as a list. Customer phone numbers load automatically, without Show/Hide buttons.

## Existing database setup

Apply `supabase/migrations/014_import_files_and_assignments.sql` once in the existing project's Supabase **SQL Editor**. This is an additive migration; it preserves existing leads, assignments, timestamps and private phone records. Apply earlier migrations in order if they have not been installed. Do not rerun the fresh-install `setup.sql` against an existing database.

From the project directory on macOS:

```sh
pbcopy < supabase/migrations/014_import_files_and_assignments.sql
```

Paste into a new SQL query and click **Run**. `Success. No rows returned` is expected. Keep `npm run dev` running and refresh the CRM afterward. New projects can use the regenerated `supabase/setup.sql`, which includes all 17 migrations.

Without this update, file pages and imports report that a database update is required. **All my leads** remains available for existing individual assignments.

## Administrator workflow

1. Open **Leads → Import CSV / Excel**. The same picker accepts CSV, XLSX and XLS. Match columns if requested and review row results.
2. Open **Task assign** from the sidebar or the import result link. Search filenames or use pagination to find a file. Each entry shows its format, lead count, rejected count, current assignee and import date.
3. Click **Assign file**, choose an active agent, then submit. Every accepted lead in that file moves to that agent, including leads previously assigned to someone else. The dialog states this before submission.
4. Repeat to reassign the file. Already assigned members are skipped, preventing duplicate per-lead assignment history. An empty or wholly rejected import cannot be assigned. Individual assignment remains available on customer profiles.

One transaction changes all member assignments and writes their history plus a file audit entry. An error leaves every prior assignment intact. Agents, disabled accounts and inactive target agents cannot perform file assignments. The UI prevents repeat submissions while saving and retains the selected agent after an error.

## Agent workflow

1. Open **My leads** to see assigned-file cards with filename, format, assigned lead count and import date.
2. Click a file to open its customer list. Search, status, lost-reason and source filters continue to work within that file, with normal pagination and customer profiles.
3. Use **Assigned files** to return to the cards. From a customer profile, **Back to leads** returns to its file list.
4. Use **All my leads** for individual assignments, including manually created leads that have no import file.

Visibility follows each lead's current assignment. If individual leads from one file belong to different agents, each sees the file with only their own leads. If the whole file moves to another agent, the former agent loses access on subsequent API requests and refreshed pages. Historical activity stays attached to its lead.

## Older imports and storage

Earlier CRM versions did not save filenames or original file bytes. The migration groups existing CSV/Excel-source leads using their original create-audit request IDs. If no request ID exists, the lead gets its own recovered group. These groups are labelled **Earlier import (date/time)** and **Original filename unavailable**, preserving existing ownership. Original filenames cannot be recovered from this data, and reuploading accepted contacts is unnecessary.

New uploads save a sanitized filename, format, first worksheet name, accepted/rejected counts and lead membership. Raw file bytes and skipped columns are not stored. Reuploading a file creates a separate import attempt and applies normal normalized-phone duplicate checks. Consult [the import guide](LEAD_IMPORT.md) for headers, valid phones and limits of 5 MB, 1,000 rows and 32 columns.

## Implementation

- `lead_imports` stores file metadata; `leads.import_id` preserves membership independently of later assignment changes.
- `import_leads` creates a file and accepted members atomically, with row-level rejection handling.
- `lead_imports_page` and `lead_import_summary` calculate access and counts from current member ownership.
- `assign_lead_import` rechecks the active administrator and target agent, serializes assignment operations and calls the existing audited `assign_lead` for changed members.
- `GET /api/lead-imports` accepts `page`, `limit` and filename `search`; `GET /api/lead-imports/:id` returns authorized metadata.
- `POST /api/lead-imports/:id/assign` accepts only `{ "agent_id": "agent UUID" }` and is administrator-only.
- `GET /api/leads?import_id=UUID` combines file filtering with the existing current-assignment restriction for agents. Clients cannot set import membership through lead mutations.
- Browser roles have no direct table or RPC access. Contact loading retains its current ownership checks, audit requirement and no-store responses.

SQL/API tests cover genuine CSV/XLSX/XLS uploads, 1,000-row assignment, partial results, old-import recovery, permissions, filtered lists, reassignment and transactional rollback. UI tests cover cards, assignment, retries, pending state, cancellation, pagination, filtering and automatic phone display. Verification uses isolated records, never hosted customer data.
