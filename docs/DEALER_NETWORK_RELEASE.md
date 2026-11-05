# Dealer affiliate network: update 049 release plan

Update 049 adds the **Dealer Affiliate Network**. Agents record the property dealers they work with, and administrators review and manage them. Production runs v1.1.0, with its database at 048.

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/049_dealer_affiliate_network.sql` (one transaction, safe to rerun)         |
| Read-only check | `supabase/check-dealers-049.sql`: one SELECT, flags and counts only                             |
| Requires        | update 048 (049 refuses to run without it and changes nothing)                                  |
| Also ships      | everything else merged on `main` since v1.1.0, such as the follow-ups fix (PR #9; no migration) |

## What 049 changes

- A new table, `public.dealers`. RLS is on, and browsers have no access to the table or its sequence.
- Eight API functions, callable only by the server's service role: create, list, detail, check number, edit, approve/reject, delete, restore. The helper functions are callable by no one but the database owner.
- One small index on `audit_log`, covering dealer entries only, for each dealer's history.
- No existing table, row, function or permission changes.

## Who can do what

| Action                                       | Admin                           | Agent                                           | Staff |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------- | ----- |
| Add a dealer                                 | yes, approved at once           | yes, pending review                             | no    |
| List, search, count, open                    | every dealer                    | only their own (others' ids answer "not found") | no    |
| Edit details                                 | yes; status and review are kept | no                                              | no    |
| Approve or reject (with an optional reason)  | yes, only while pending         | no                                              | no    |
| Delete (soft, with confirmation) and restore | yes                             | no                                              | no    |
| See full contact numbers, call, WhatsApp     | every dealer                    | only their own dealers                          | no    |

The server takes the owner from the signed-in session. Every rule is checked again in the database.

## Duplicate policy

- Numbers are stored in one form. `03001234567`, `+923001234567`, `923001234567` and `3001234567` are all `+923001234567`.
- **One person, one number.** Nobody can hold two pending or approved dealers with the same number; a database unique index enforces this. The person is told which dealer already has it (for example `DL-000012 (pending)`), and the form warns before saving.
- **Rejected or deleted dealers do not count.** An agent may submit a rejected dealer again.
- **Different people may record the same dealer.**
  - Agents are never told: not when adding, searching, checking a number, counting or paging.
  - Administrators see a "Same number ×N" badge, a "Shared numbers only" filter and, on each dealer, the other records with that number and who added them.
- **Nothing is merged automatically.** An administrator decides: reject or delete the extra record.

## 1. Before the release

1. **Review and merge** the feature branch through a PR into `main`, with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up** with a fresh encrypted backup, and check that it restores into a throwaway local PostgreSQL 17 with 0 errors. Follow v1.1.0 runbook step 4 (`docs/RELEASE_V1.1.0.md`).
3. **Run the read-only check** in the Supabase SQL Editor and save the result. Required:
   - `release_stage` = `at 048, ready for 049`;
   - note every `existing_*` count.

## 2. Apply 049 (Supabase SQL Editor; database first)

1. Choose a quiet time (evening PKT).
2. Open a new query, paste the **whole** file, and run it. The file sets its own `lock_timeout` of 5 s.
3. Run the check again. Required:
   - `release_stage` = `at 049`;
   - `dealers` = 0;
   - `dealers_rls_enabled` = true;
   - every `*_must_be_0` = 0;
   - `dealer_api_functions` = 8;
   - `dealer_indexes_expected_6` = 6;
   - the `existing_*` counts equal step 1, apart from normal use.

**Locks.** For under a second, 049 holds:

- a brief lock on `profiles`, for the new table's foreign keys;
- a lock on `audit_log` while its small index is built. CRM saves that write audit entries wait during this.

If either lock is not granted within 5 s, the whole update rolls back and nothing is applied. Do not edit the file: run it again later.

**The live v1.1.0 code is unaffected by 049.** It never calls the new table or functions.

## 3. Deploy the code

1. Deploy `<SHA>` with the Production workflow, as in v1.1.0 runbook step 6: stop the worker, run the workflow, approve it, then restart exactly one worker. The dealer feature adds no background jobs.
2. If the code goes live before 049, the Dealers page only shows "Dealers need CRM database update 049 after 048." Nothing else is affected.

## 4. Smoke test

**Read-only (about 5 minutes):**

1. `curl -sI https://hdmarketing.tech | grep -i x-release-sha` shows `<SHA>`.
2. **Admin:**
   - the sidebar shows **Dealer Affiliate Network → Dealers**;
   - the page loads with every count at 0;
   - the "Added by" filter lists admins and agents;
   - Audit history still loads.
3. **Agent:**
   - the sidebar shows **My dealers**, and the page loads empty;
   - Leads, Inventory and Follow-ups still load.
4. **Staff** (if a staff account exists): the menu has no dealer section, and opening `/dealers` returns to the dashboard.

**Optional write test.** Owner approval is needed: it leaves one soft-deleted row and its audit entries permanently.

1. An agent adds `TEST dealer – delete me` with a number, and it shows as Pending.
2. An admin rejects it with a reason; the agent sees the reason.
3. The admin deletes it.

## 5. Rollback (application only)

- **The database stays at 049.** v1.1.0 runs on it unchanged: it never reads `dealers`.
- **To roll back the code:** stop the worker, switch to the previous release (v1.1.0 runbook step 8.2–8.4), and restart one worker. v1.1.0 already has the staff restrictions, so no accounts need disabling.
- **Dealer records are kept.** They reappear when the feature is deployed again.
- **Never drop `dealers`** or restore a backup to undo this release. A data recovery is a separate approved procedure (`deploy/restore.md`).

## Compatibility notes

- Agents see the full number of their own dealers, and can call, message on WhatsApp or copy it. This is a narrow exception to the phone protection that applies to every agent response:
  - The dealer API masks the whole response as before, then restores only the `phone` field, and only where the dealer's `owner_id` is the signed-in agent. The database already returns agents nothing but their own dealers.
  - Notes, rejection reasons, the number check and every error stay masked. Lead numbers and their rules are unchanged.
- Accounts are soft-deleted (Supabase soft delete), so the references from dealers to profiles never block deleting an account. This is the same as for tasks.
- Contact numbers are not written to the audit log. Edits record which fields changed, and the before and after values for everything except the number.
- Decisions are final. A rejected dealer is not reopened; the agent submits it again. An approved dealer cannot later be rejected, only edited or deleted.
- No new dependencies, environment variables, Nginx or PM2 changes.
