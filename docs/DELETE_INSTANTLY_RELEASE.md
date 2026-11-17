# Update 069: Delete instantly, and 14 days to restore

Administrators can now permanently delete leads from **Deleted leads** at
once, instead of waiting for the automatic erasure. Deleted leads can be
restored for 14 days instead of 30.

## What a deleted lead does today (checked, unchanged)

When an administrator deletes a lead from All leads, it moves to Deleted
leads (update 032):

- it is unassigned, its pending follow-ups and scheduled visits are
  cancelled and its unread reminders removed;
- it leaves every list: All leads, Assigned leads, Lead pipeline, an
  agent's pipeline, Follow-ups, Site visits, Deals and Call review;
- its work counts nowhere: dashboards, reports, leaderboard, targets, Team
  performance and every drill-down;
- opening it directly says it is not found.

This was checked in the CRM's database. A lead with calls, a note,
follow-ups, a visit and a deal was deleted, then every report was read again.
Every number went back to what it was before the lead existed. The only
number that rose was **Deleted today**, which counts deletions. Restoring a
lead brings it and its work back.

## Delete instantly

| Where                                   | What it does                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Deleted leads: select leads             | **Delete instantly** erases the selected leads now.                                                                    |
| Deleted leads: Deleted files with leads | **Delete instantly** erases the leads that file's deletion moved to Deleted leads. The file can no longer be restored. |

The administrator types **DELETE** to confirm; it cannot be undone.

Erased means gone from the CRM and the database, exactly as the automatic
erasure has always done:

- the lead and its protected number;
- calls and their recordings (removed from storage at once);
- notes, follow-ups and reminders, site visits, deals;
- assignments and status history;
- KYC documents and their files (removed from storage at once);
- Meta and Google Sheet copies, and notifications.

What stays:

- **Audit history** keeps one entry: who erased how many leads, with their
  HD numbers only. For example: "Permanently deleted 3 leads from Deleted
  leads, with all their records: HD-000123, HD-000124 and HD-000130. They
  cannot be restored."
- **Google Sheets:** a Sheet row's receipt stays, without the lead, so the
  next sync does not bring the lead back.

Rules:

- **Only leads already in Deleted leads.** A lead in All leads must be
  deleted first, with a reason.
- **A lead with a won deal is never erased.** It is reported as kept.
- **More than 50 leads permanently deleted in one Pakistan day** raises a
  critical security alert, as deleting does.
- **Administrators only;** agents and staff are refused.
- **Storage:** if removing a recording or document from storage fails, the
  lead is still erased. The file stays queued for the automatic cleanup, and
  the message says so.

## 14 days to restore

- Leads and files can be restored for 14 days; the Days left column counts
  14 days.
- The automatic erasure runs after 14 days. `LEAD_DELETE_RETENTION_DAYS`
  defaults to 14 and accepts 14 to 3,650.
- When 069 is applied, leads deleted 14 to 30 days earlier can no longer be
  restored. The check shows how many (`bin_14_to_30_days`).
- **In production the automatic erasure does not run yet:** the background
  jobs process is not running (since 30 October). Until it runs, deleted
  leads stay in Deleted leads after their 14 days, without Restore, until
  someone uses Delete instantly.
- If the production server's settings set `LEAD_DELETE_RETENTION_DAYS=30`,
  the automatic erasure would wait 30 days. It should be 14 or left out.

## Release

| Item            | Value                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/069_delete_leads_instantly.sql`: adds `lead_imports.erased_at` and `erased_by`; new `erase_lead`, `erase_deleted_leads`, `erase_deleted_import`, `lead_erasure_alert`; checked edits of five bin functions. Erases nothing by itself. |
| Read-only check | `supabase/check-delete-instantly-069.sql`                                                                                                                                                                                                                  |
| Requires        | update 068 in production                                                                                                                                                                                                                                   |
| Code            | Delete instantly in Deleted leads, 14-day texts, Audit history entries, security alert label. Before 069, Delete instantly says it needs update 069; nothing is erased.                                                                                    |

1. Back up the database and test the restore.
2. Run the check. It should read `at 068, ready for 069`, with
   `transactions_open_over_1_min = 0`. Note `bin_14_to_30_days`: those leads
   lose Restore.
3. Apply 069 and run the check again. It should read `at 069`, with every
   count unchanged.
4. Deploy the code.

**Rollback:** the code before 069 does not offer Delete instantly. Applying
update 032's versions of the five functions again restores 30 days.
Erased leads cannot be brought back, except from a database backup.
