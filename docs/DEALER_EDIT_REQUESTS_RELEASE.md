# Dealer edits with approval: update 059 release plan

Agents can now edit their own dealers in **My dealers**: an Edit (pencil) button sits beside View, and in the dealer's details.

| The dealer is…          | Saving an agent's edit…                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Waiting for review**  | Changes the submitted dealer itself. It stays pending, and the administrator reviews the latest version. No second dealer or request is made. |
| **Rejected**            | Submits the corrected dealer again (unchanged is allowed), pending once more. The rejection stays in its history.        |
| **Approved**            | Leaves the approved details as they are and sends the changes for approval. The dealer shows **Changes pending**. The agent can revise them, or withdraw them by changing everything back. |

**Administrators:**

- **Edit requests**, a new tab, lists approved dealers with changes waiting. A pending dealer is marked "New dealer request".
- **An edit request shows:**
  - who proposed it (with UID) and when;
  - how many times it was revised;
  - for each detail, **Approved now → Proposed**;
  - a warning if an approved detail changed after the agent proposed.
- **Approve changes** applies them.
- **Reject changes** keeps the approved details, and the agent sees the reason. The agent can correct and propose again.
- **Edit details** is as before: administrators change any dealer directly, never through a request.

**Safety:**

- **Every edit and decision names the version it was made from.** One made from an older view is refused with a message to refresh. Examples:
  - an approval after the agent revised;
  - an agent's edit after a decision;
  - two windows sending at once.
- **Ownership is checked in the database.**
  - Agents edit only their own dealers; another agent's is "not found".
  - Only administrators decide, and nobody reviews their own changes.
- **Records are preserved:** dealer IDs, numbers, ownership, existing approvals and history stay.
- **Audit history:** each step is recorded (changed while waiting, submitted again, changes proposed, revised, withdrawn, approved, rejected), with the before and after values. Contact numbers stay out of the audit log.
- **Duplicates:** an agent still cannot hold two active dealers with one contact number.

| Item            | Value                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/059_dealer_edit_requests.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-dealer-edit-requests-059.sql`                               |
| Requires        | update 058 in production (applied)                                          |

## What 059 changes

- **A new table,** `dealer_change_requests`: one pending request per dealer, enforced by a unique index. Row-level security is on, and browsers have no access.
- **New server functions:**
  - `dealer_submit_changes` (the agent's Edit);
  - `dealer_change_review` (approve or reject changes);
  - a `dealer_review` that names the version reviewed.
- **Replaced:** `dealer_json` (adds the waiting and last-decided changes) and `dealers_page` (adds the Edit requests filter and its count).
- **No existing row changes.** The 049 functions, the old `dealer_review` included, stay as they were, so the current code keeps working with 059.
- **Before 059,** the new code shows dealers as before. An agent's Edit, or an administrator's approve or reject, says "Editing dealers needs CRM database update 059 after 058."

## Release

1. **Back up** the database and check that the backup restores.
2. **Run** `check-dealer-edit-requests-059.sql`. Required:
   - `release_stage` = `at 058, ready for 059`;
   - `transactions_open_over_1_min` = 0.

   Note the dealer counts.
3. **Apply 059** in the SQL Editor.
4. **Run the check again.** Required:
   - `release_stage` = `at 059`;
   - `server_functions` = 4;
   - `change_requests` = 0;
   - every `*_must_be_0` = 0;
   - the dealer counts as before.
5. **Retire the inactive slot,** then **deploy** the merge SHA.

## Smoke test

1. **As an agent,** in My dealers:
   - edit a pending test dealer: it stays pending with the new details;
   - edit an approved test dealer: Changes pending appears, and the details still show the approved values;
   - edit it again: the form starts from your changes.
2. **As an administrator:**
   - Edit requests lists that dealer, with the agent, the time and Approved now → Proposed;
   - approve: the dealer shows the new details.
3. **Reject a second proposed change with a reason.** The agent sees it, and can edit and propose again.
4. **Another agent** cannot open or edit the first agent's dealer.

## Rollback

Roll back the application; the older code works with 059. Requests left waiting simply stay in the table until the new code is back. Nothing in the database needs undoing.
