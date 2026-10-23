# Property deletion and responsive controls

> **Update 041:** `delete_property` is now ownership-aware. Administrators delete company properties and agents delete their own; administrators cannot delete an agent's property. Linked records, the photo cleanup queue and the audit entry work as described below. See [PROPERTY_INVENTORY.md](PROPERTY_INVENTORY.md).

This change adds **Delete property** beside **Edit property** when an administrator opens a property. Agents can view properties without these management controls. Opening the confirmation or choosing Cancel does not delete anything. The destructive action displays a pending state, prevents duplicate submissions and keeps the dialog open on failure.

## Existing hosted project

Migration 012 must already be installed. Copy the new SQL from the project terminal:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/013_property_deletion.sql
```

Paste in **Supabase → HD Marketing Project → SQL Editor → New snippet**, then click **Run**. Success normally says **Success. No rows returned**. The migration adds the delete function and cleanup queue; applying it does not delete any existing properties. Refresh the CRM after success.

The regenerated `supabase/setup.sql` contains all 13 migrations for fresh projects. Do not rerun it against the existing project. This requested improvement uses migration number 013, so future roadmap features must start at the next unused number rather than the original document's proposed filename.

## Data and authorization

- `DELETE /api/properties/:id` requires a valid session and an active administrator, validates the UUID, and calls a service-only SQL function.
- The SQL function rechecks and locks the active administrator and locks the property. Linked leads, visits or deals block deletion with HTTP 409 and an explanation to archive instead. History is retained.
- An unlinked property is permanently deleted with its photo metadata, one safe audit entry and queued Storage paths in the same transaction. Audit failure rolls everything back.
- Photo cleanup attempts immediately after commit. If Storage fails, the queue remains for `npm run jobs` to retry. Cleanup is idempotent; a retry can also complete after files were removed but queue acknowledgement failed.
- The queue has RLS and no browser grants/policies. The RPC is executable only by the service role. Storage paths never appear in the delete response or audit metadata.
- Successful deletion refreshes the property list and property choices used in lead, visit and deal forms, and clears cached photos.

## Responsive behavior

The shared stylesheet handles wrapping buttons, controls, long text, constrained grids, mobile form columns, touch targets, bounded dialogs and reminders, photo galleries, dashboard cards and table scrolling. Phone input text is 16 pixels to avoid automatic focus zoom. Narrow screens use full-width actions and filters. Wide tables scroll inside their container rather than widening the page.

The mobile sidebar scrolls independently, supports a visible Close action and backdrop dismissal, and closes with Escape. Hidden mobile navigation is also hidden from keyboard focus. Reminders support a pending dismissal state and display retryable errors. Dialogs have accessible titles and return focus to their opener.

## Manual acceptance after migration

1. As admin, add a temporary unlinked property. Open it and confirm **Edit**, **Delete** and **Archive** are available. Choose Delete, then Cancel; confirm it remains.
2. Confirm deletion of that temporary property. It disappears from the property list and form choices and has a delete entry in Audit history.
3. Try deleting a property linked to a lead, visit or deal. Confirm it remains and the dialog explains the conflict. Archive remains available.
4. As agent, confirm properties can be viewed and management actions are absent.
5. At phone, tablet and desktop widths, check navigation, long property titles, edit/add/delete dialogs, forms, filters, dashboards, reminders and horizontal scrolling inside tables.

Local verification results are recorded in `VERIFICATION.md`. Browser layout checks use isolated fixture accounts and API responses; they do not mutate hosted CRM records. Hosted SQL installation and real-account acceptance remain separate steps.
