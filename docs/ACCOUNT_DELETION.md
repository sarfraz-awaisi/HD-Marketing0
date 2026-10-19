# Delete an account

Implemented 15 October 2026. Administrators can delete another Agent or Admin account from the PIN-unlocked **Accounts** page or account details. Account-card controls use matching two-column button grids, aligned action areas, consistent icons and 44 px minimum targets. Delete has a distinct soft red treatment. The signed-in administrator has no Delete button.

## Enable deletion on the existing database

The message **Account deletion needs CRM database update 028 after 027** means the API cannot find the deletion functions or a table they require. Updating project code does not install hosted SQL.

Apply only **028_account_deletion.sql**, once after all missing prerequisites through 027, in the Supabase project used by the CRM:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/028_account_deletion.sql
```

Open **Supabase → SQL Editor → New query**, paste the complete SQL, and click **Run**. The expected result is **Success. No rows returned**. Wait a few seconds and refresh the CRM. The file requests a database API schema refresh. If the prerequisite check fails, apply the named missing earlier updates first. Do not rerun the fresh-install setup against this existing database.

The matching API/frontend code must be running. After updating them, stop the existing development process in its own terminal with Control-C and restart it with `npm run dev`; avoid starting a second instance on the occupied port.

### If 028 reports missing prerequisites

The 028 prerequisite guard checks the handover function from 022, the invitation table from 023, and the dashboard snapshot function from 027. The generic error does not identify which check failed. Run this read-only diagnostic in the same Supabase project:

```sh
pbcopy < supabase/check-account-deletion.sql
```

Paste into a new SQL Editor query and Run. `false` means that particular prerequisite object is absent; it does not prove that an entire numbered migration is absent. `true` confirms that object only. Share the three flags before attempting another installation so a partially installed migration can be reconciled rather than replayed over existing objects. The check reads no customer/account records and does not change the database.

The prerequisite error occurs before 028 creates or alters any objects; its transaction must not be bypassed. Existing partial installations may need targeted repair, especially when a previous contact/security repair restored selected objects without applying an entire numbered migration. Once the prerequisites are present, run the complete 028 migration once.

### Result: 022 false, 023 false, 027 true

This result was reported on 15 October 2026. The database has the performance reader, but lacks the handover function and invitation table required for deletion. Use the repeatable repair prepared for this state:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/repair-account-deletion-prerequisites.sql
```

Paste the **complete file** into **Supabase → SQL Editor → New query** in the CRM project and Run. The last result should show `update_022`, `update_023` and `update_027` all **true**. If it reports an error, stop and share that error before proceeding. After the three flags are true, copy `supabase/migrations/028_account_deletion.sql` using the command above and run it once in another new query. Expect **Success. No rows returned**, then refresh the CRM. Do not rerun the original 022/023 files after this repair; their features have already been reconciled.

After lead-management update 032 is installed, this older prerequisite repair refuses replay so it cannot replace deletion-aware readers. Use only verified missing numbered updates at that point.

The repair restores the 022 handover/offboarding and client-KYC rules, along with the 023 invitation schema, functions and inbox-confirmation guards. Existing unconfirmed accounts become inactive and still require confirmation; no email is automatically confirmed or sent. It keeps existing customer/contact/activity records, invitation history, Accounts PINs, visible-contact reader, the later Meta assignment wrapper and job rules, performance functions, monitoring and MFA state. Administrator MFA remains removed by the application's existing policy. Existing objects use repeatable creation/replacement, and any failure rolls back the complete repair. On an already completed 028 installation, its deletion-aware account list/detail/lifecycle wrappers are retained.

If 028 already succeeded but the message remains, refresh the connected project's database API cache and check that the running server connects to that same project. Existing numbered migrations are unchanged. Administrator MFA remains removed; this update adds no admin authenticator step or new login requirement.

## Administrator workflow

1. Unlock Accounts with the existing personal PIN.
2. Choose **Delete** for another account, including an account still awaiting email confirmation.
3. Read the confirmation and type that account's email address. A mismatched email leaves confirmation disabled.
4. Choose **Delete account**. Cancel leaves the account unchanged. Pending submission disables repeated actions.

Deletion removes sign-in access and hides the completed account from Accounts, Team and assignment selectors. Own-account deletion is refused in both UI and SQL, and serialized account changes preserve an active administrator.

Current leads, including won/lost records, return to the unassigned admin pool. Imported-file assignment markers are cleared. Pending follow-ups, scheduled visits and unread reminders follow current ownership or the administrator handling deletion. Completed calls, completed activities, deals, customer numbers, property/document history, attribution and prior audits remain intact. A historical profile is retained so those foreign keys and original names still work. This feature deletes account access; it does not erase customer or business records.

## Native Auth and recovery

The server uses Supabase's supported `auth.admin.deleteUser(id, true)` soft-deletion operation. It is irreversible; the Auth record is retained with deletion metadata while identity fields/credentials and sessions are cleared by Auth. Keeping the record avoids breaking this CRM's foreign-key history. See the [official deleteUser API](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser) and [Auth implementation](https://github.com/supabase/auth/blob/master/internal/models/user.go).

Before calling Auth, one SQL transaction blocks the profile, revokes its Accounts grants, cancels its invitation, hands over work and records safe intent. Existing JWTs cannot regain CRM access because API/SQL reads check the current inactive profile. Completed accounts cannot be reenabled or edited. The final SQL transaction independently verifies the native `auth.users.deleted_at` marker before hiding the account and recording completion. It releases the invitation email for a future, separately verified new account with a different ID.

Auth and PostgreSQL do not share one transaction. A provider failure or an interrupted completion therefore leaves **Deletion pending**, with access blocked and a **Retry delete** action. Other account mutations are refused. Retrying preserves the original counts and does not hand work over twice. Overlapping attempts are fenced; after a process interruption an abandoned attempt becomes retryable after two minutes. A failed completion audit remains recoverable without repeating native deletion when Auth reports the account already deleted. If the PIN expires, unlock Accounts again before retrying.

Deletion SQL and private operation records are service-role-only. Browser roles cannot call these readers or access the ledger. Audit metadata contains identifiers/counts rather than passwords, email text or provider errors. The pending operation retains its confirmation email privately for recovery and clears it on completion.

## Verification

Tests use isolated PostgreSQL, native Auth fixtures and real local API routes. They cover confirmations, PIN/role/self protection, last-admin continuity, all-status lead handover, pending work and history, provider errors, operation fences, expired grants, audit rollback, idempotent completion, email reuse and direct-browser denial. Browser checks measure equal control sizes and dialog responsiveness at 320, 390, 768 and 1440 px, then cancel and complete an actual fixture deletion. See `VERIFICATION.md` for results. No real hosted account was deleted by implementation or testing.

## Permanently removing deleted test agents

**Delete account** keeps a hidden profile row so history stays intact, and Supabase therefore refuses to delete that row directly (a foreign-key error from `account_deletions`). Do not add cascade rules to bypass this. To remove agent accounts that were only used for testing:

1. Delete them in the CRM first; this also hands over any leads.
2. In Supabase **SQL Editor**, run `supabase/preview-deleted-agent-cleanup.sql`. It is read-only and lists each deleted agent's UID as **will be removed** or **kept (has work history)**.
3. Run `supabase/cleanup-deleted-agents.sql`. It permanently removes only the agents marked **will be removed**: profile, login and deletion bookkeeping. It records `account.purged` in the audit log and frees their UIDs. It cannot be undone, and any error rolls back everything.

Active agents, all admins and any account linked to leads, calls, notes, follow-ups, visits, deals, targets, audit actions or security records are never removed.
