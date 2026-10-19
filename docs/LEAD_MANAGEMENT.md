# Lead numbers, assignments and recoverable deletion

Implemented locally 15 October 2026. The CRM browser interface supports Windows PCs and laptops; the application server may run on its existing development/production host. Administrator-only controls remain enforced by HTTP and SQL, independently of sidebar visibility.

## Install on an existing database

Install updates 029, 030, 031 and 032 **after 028**, in order. If none of these four updates has been installed, `supabase/update-lead-management.sql` combines them in one transaction and refuses missing 028 or an already installed lead-number column. It does not reset the database. Run the entire file in the same Supabase project used by the CRM.

From PowerShell in `hd-marketing-crm`:

```powershell
Get-Content -Raw -Encoding UTF8 .\supabase\update-lead-management.sql | Set-Clipboard
```

From the existing macOS development terminal:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/update-lead-management.sql
```

In Supabase SQL Editor, open a new query, paste and Run. Expect `Lead management updates 029–032 completed`. If some updates were installed individually, apply only the missing numbered files in order. Do not replay 022/023 or the fresh-install bundle. Updating source code does not install hosted SQL. Restart the matching API/jobs processes after installation, then reload the browser. New installations use the generated `supabase/setup.sql` through 032.

## Numbers and counts in both portals

Each lead receives a unique generated bigint `lead_no`, displayed as `HD-000123`. Existing leads are numbered in creation order, using ID order to resolve ties. Backfill preserves original timestamps and phone/activity records. The same lead always has the same number in both portals, including after restoration. Generated numbers cannot be edited and the identity sequence is not reset by the purge.

The shared Table's `showSerial`, `page` and `pageSize` options display a first `#` column relative to the current filtered/sorted page. For a 20-row page, page two starts at 21. Serial positions are display values, independent of the permanent ID. Lists show `Showing X–Y of Z leads`, including an empty state. Main/file lead pages, follow-ups, visits, deals, call review, social inbox and the bin show permanent IDs and serials. Customer headers, timelines, dashboard activity links and reminders show permanent IDs. Search on Leads/My leads supports the HD prefix or the numeric identifier.

Admin overview shows the current total; agent overview shows the current assigned total. File counts follow active member leads and current ownership. Admin file rows include assigned and unassigned counts; agent cards show only that agent's visible members. Original import accepted/rejected metadata remains historical, while `lead_count` is the current visible count.

## Selection and assignment

Administrators can select rows or the current page in Leads and file-member lists. Selection persists across pages with the same filters, and clears when filters change or an action succeeds. Select-all-matching is limited to 500; larger results ask the admin to narrow the filter. The header checkbox affects the current page only.

The action bar offers a receiving agent, Assign to agent, Round-robin, Unassign, Delete and Clear selection. A row's quick assignment selector moves one lead to an active agent or the unassigned admin pool. Existing-owner assignments are skipped without creating another assignment record. Results include assigned/skipped/failed counts and per-lead outcomes. Known row failures do not cancel other valid rows; unexpected database/audit errors roll back the transaction. The summary audit contains counts only; existing per-lead assignment/audit history remains.

Assignment checks the active administrator and active agent inside SQL, takes the existing ownership advisory lock and locks selected leads in ID order. Bulk round-robin captures the active agents in least-recent-assignment order, then cycles through them explicitly. This keeps a batch evenly distributed even when assignment timestamps are equal within one transaction. Pending follow-ups, scheduled visits and applicable unread reminders follow the new owner through the existing handover logic. Completed history retains attribution. Meta's explicit-first-assignment rule is retained, so automatic round-robin cannot claim a pending social lead. Successful actions refresh affected lead/file counts, dashboards and activity queries. Agents have no checkboxes or bulk controls.

## Administrator editing

Use Edit on a lead row or Edit lead on a customer profile. Admins can change name, email, source, budgets, preferred location, interested property, owner and phone in one transaction. Invalid ownership/phone/metadata leaves the entire edit unchanged. Agents retain stage/lost-reason, notes and activity permissions.

Phone normalization accepts local Pakistani and international formats using the existing rules. SQL writes the private vault and display mask together. An active duplicate returns HTTP 409 with only the conflicting HD number. A recoverable duplicate asks the administrator to restore that lead. The `lead.phone_changed` audit records the action and identity, without either phone value.

## Delete, restore and retention

Delete requires an active administrator and a reason of 3–300 trimmed characters. Confirmation previews the selected leads, pending follow-ups and scheduled visits; 20 or more leads require typing DELETE. Cancellation makes no mutation. While saving, repeat submission/dismissal is blocked. Leads with won deals are retained and return `Has a won deal` in results.

Deletion records timestamp, actor, reason and batch, cancels pending follow-ups and scheduled visits, removes unread reminders and leaves the lead unassigned. Customer metadata, phones and completed history remain recoverable. Normal lists, counts, profile/timeline/phone access, activity lists, metrics, leaderboard, file views, reminders and linked KYC exclude deleted leads. Direct customer links return 404. Social submission readers/cohort reports also exclude linked deleted customers. Re-creation/import of a recoverable phone creates nothing and returns the restore message with its HD number.

Administrators open Deleted leads from the sidebar, search by name or number, select rows and Restore. Restoration is allowed for 30 days, retains the same HD number and history, and leaves the lead unassigned. Cancelled work is not silently rescheduled and removed unread reminders are not recreated by restoration. Agents cannot open this section or call its endpoints. There is no manual permanent-delete button.

Task assign offers Delete file only (keep leads), which removes membership and leaves active leads in normal Leads; or Delete file and its leads, which soft-deletes eligible members and records a common batch. Won-deal leads are kept as ordinary leads without the removed file. Individually restoring a lead whose file is still deleted also returns it to ordinary Leads. Restoring the file and its batch together keeps those members attached. File-and-lead deletions can be restored together from the bin within 30 days. File-only removal does not provide a restore action. File deletion operates in bounded internal batches for files larger than the 500-lead action limit.

Deleting more than 50 leads in one Pakistan day creates a critical security alert and an admin overview notice. Counts come from successful deletion audits, so a subsequent restore does not erase the day's event count.

The jobs runner invokes `purgeDeletedLeads` alongside its existing maintenance loop. SQL persists a daily schedule and advisory lock, purging at most 200 expired leads per run. `LEAD_DELETE_RETENTION_DAYS` defaults to 30 and accepts 30–3650; restoration remains limited to 30 days. A longer retention delays erasure without extending the restore window. Run the supervised jobs process for automatic cleanup; without it, records stay in the bin.

Purge removes customer private phones, notes, calls, follow-ups, visits, assignments, status/reveal history, deals, linked KYC entries and linked Meta submission/answer copies. Audit rows remain. Private recording references are copied to a durable cleanup queue independent of deleted call IDs. Storage/provider deletion is acknowledged only after success and failures retry. KYC file objects use the existing knowledge-file cleanup queue. The eight frequent-job monitoring heartbeat contract remains unchanged; the daily purge has its own SQL run ledger.

## API and schema

New functions are service-only; browser roles cannot call them or read the active-lead view/private cleanup state directly. New write endpoints have strict Zod allowlists and sensitive rate limits:

- POST `/api/leads/assign-bulk` `{ lead_ids, mode, agent_id? }`.
- PATCH `/api/leads/:id/phone` `{ phone }`; admin PATCH `/api/leads/:id` supports atomic phone/owner/metadata editing.
- GET `/api/leads/selection` uses the current validated filters and returns at most 500 IDs.
- POST `/api/leads/delete-preview` accepts `{ lead_ids }` or `{ import_id }`.
- POST `/api/leads/delete` `{ lead_ids, reason }`.
- POST `/api/leads/restore` `{ lead_ids }`.
- GET `/api/leads/deleted` supports page, limit and search.
- DELETE `/api/lead-imports/:id` `{ mode, reason }`.
- GET `/api/deleted-lead-imports` and POST `/api/lead-imports/:id/restore` support file recovery.

Migration 029 adds permanent identities/counts, 030 bulk assignment, 031 atomic administrator editing, and 032 deletion-aware readers, the restore bin and purge/cleanup transactions. Earlier numbered migrations are preserved. See VERIFICATION.md for actual local checks and remaining hosted acceptance.
