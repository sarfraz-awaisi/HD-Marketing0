# Accounts and admin security

Administrators manage CRM login accounts from **Accounts** in the sidebar. Each admin protects this page with a personal four-digit PIN, managed under **Admin settings → Security**. Agents cannot open either section or use their APIs. The PIN supplements the authenticated administrator role; it is not multifactor authentication.

See [Delete an account](ACCOUNT_DELETION.md) for the new confirmation, pending-retry behavior and migration **028 after 027**. The matching card buttons use equal widths/heights in a responsive two-column layout.

## Database installation

Apply migration **016** once, after migration 015. It adds private PIN settings, temporary unlock grants and protected account-management functions. It preserves existing accounts, customer records and history.

In the project terminal on macOS:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/016_accounts_and_security.sql
```

Open **Supabase → SQL Editor → New query**, paste and click **Run**. `Success. No rows returned` is expected. Refresh the CRM afterward. Do not rerun `setup.sql` against the existing database. The regenerated setup bundle contains all 37 migrations for fresh projects only. Existing installations must apply missing upgrades in order, including migration 022 for the handover workflow described below; [back up first and follow these steps](../CHANGES_OFFBOARDING_AND_KYC.md).

## Set, change or recover a PIN

1. Sign in through the **Admin** login option.
2. Open **Admin settings → Security**.
3. Enter your current login password, a new four-digit PIN and its confirmation, then save. Leading zeros work.
4. Open **Accounts** and enter your PIN.

Each admin has their own PIN; there is no default or shared company PIN. Set/reset requires that admin's current password, verified through a separate temporary Supabase Auth session. This does not replace the browser session or the server's service-role client. Forgotten PINs can be replaced in the same form. Use the existing login recovery flow first if the login password is also forgotten.

Accounts unlocks for 15 minutes. Leaving the page or clicking **Lock Accounts** clears local account data and revokes that page's grant. Reloading requires unlocking again. Expired grants, refreshed login tokens and revoked administrator access require another check. Changing the PIN revokes all that admin's grants. Five incorrect PINs cause a database-enforced 15-minute lockout; resetting with the login password clears it. Separate request rate limits also apply.

**Why this settings location:** it stays accessible for forgotten-PIN recovery without first unlocking Accounts. The current-password check stops someone with only an unattended session from choosing a new PIN, following [OWASP reauthentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features).

## Account management

- **Find accounts:** search by name, email or UID, filter role/access and paginate. Cards show the UID (with a copy button), role, status, email and last sign-in. Summary cards show totals.
- **Details:** UID, account ID, creation/sign-in dates, email confirmation, assigned leads, completed calls and open follow-ups. Existing passwords and PINs are never shown.
- **Create Agent/Admin:** enter name, a `@gmail.com` address, role, password and confirmation. Under **Account UID**, choose **Auto Generate UID** or **Enter UID Manually** (six digits, not starting with 0; availability is checked). The account is created immediately, with no email code, and **Account Created Successfully!** shows its name, email, role, UID and status. Apply **036 after 035** and follow [the UID setup guide](ACCOUNT_UIDS.md).
- **Earlier email-code requests:** requests started before update 036 stay in the initiating admin's **Pending account verification** panel. They can be resumed with the original password, resent or cancelled, as described in [ACCOUNT_CREATION_OTP.md](ACCOUNT_CREATION_OTP.md). No new requests are created.
- **Older admin invitations:** already issued links and legacy resend/cancellation remain supported. New administrators use the same independent challenge form as agents. Historical native pending users retain the older form; new requests bind the role and original password.

- **Edit account:** change name, role or CRM access. The registered email remains read-only. The role determines which login option accepts the account.
- **Disable an agent:** the PIN-protected confirmation previews all owned leads, pending follow-ups and scheduled visits. Choose balanced sharing among active agents (default), one active recipient, or the admin unassigned pool. Disabling and handover commit atomically, including Won/Lost leads. Pending work and future unread reminders follow the recipient; completed/cancelled activity and read/already-due reminders retain historical ownership. Editing an agent to Disabled opens the same confirmation. Cancel changes nothing.
- **Enable:** restores CRM access and clears an Auth ban when necessary. It does not return former clients automatically. An inactive agent with leftover leads has **Details → Hand over remaining work**. The jobs runner alerts admins about inactive owners without auto-assigning them.
- **Set password:** after the other account is verified and any invitation is accepted, open its details, choose **Set password**, and confirm the new password. The previous password stops working for new sign-ins. This does not promise immediate revocation of every previously issued Auth token; CRM access can be disabled separately.
- **Your own account:** edit your name; you cannot disable or demote yourself here. Use sign-out and password recovery for your own login password. Role/access edits serialize in SQL and preserve at least one active administrator.

**Team** is now a read-only directory linking to Accounts. The old `PATCH /api/users/:id` mutation is refused, closing the PIN bypass. Minimal names/roles/access data used by admin assignment selectors remains available without unlocking Accounts.

## Failures and privacy

New accounts start only as protected verification requests. After independent OTP proof, Auth provisioning creates a confirmed user with the original CRM password and an inactive profile until audited role assignment completes. Every new Auth profile is inactive by default; ordinary signup metadata cannot choose a role or grant access. Audited SQL records the selected role, and active accounts are enabled last.

Auth administration and SQL cannot share one transaction. If final setup fails, the UI reports that the account was created and asks you to review its role/access in Accounts. Check its state before retrying creation. Uncommitted activation leaves the profile inactive; a lost final response requires checking the account list.

PIN changes and profile edits commit with their audit records. Creation/password-change intent is audited before contacting Auth. Password updates also attempt completion/failure audit records. If Auth succeeds but completion audit cannot be confirmed, the UI reports success with a warning. Audit records contain action names, account IDs and changed field names, never passwords, PINs or unlock secrets.

PINs use random salts, scrypt (`N=32768, r=8, p=3`), a server-side HMAC pepper and constant-time comparison. Random unlock tokens stay only in page memory and travel in `X-Accounts-Unlock`. The database stores only token/session hashes. PIN/grant tables have RLS, no browser-role table permissions and no browser-role execution rights on the new functions. Account operations recheck active-admin status and the matching unexpired grant inside SQL.

Optionally set `ACCOUNTS_PIN_PEPPER` in the root server `.env` to a private random secret of at least 32 characters, never in `client/.env`. Otherwise the existing service-role key is used. Changing the effective pepper requires admins to reset their PINs. A dedicated pepper avoids tying PIN validity to service-key rotation. See [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## API

All routes require an authenticated active admin. Account routes additionally require `X-Accounts-Unlock`, bound to the exact Bearer token.

| Route                                      | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `GET /api/account-security`                | Own configured status and safe dates                                  |
| `PUT /api/account-security`                | Set/reset with `{pin, confirm_pin, password}`                         |
| `POST /api/account-security/unlock`        | Verify `{pin}` and issue a 15-minute grant                            |
| `POST /api/account-security/lock`          | Revoke the provided grant                                             |
| `GET /api/accounts`                        | Search/filter/paginate accounts and totals                            |
| `GET /api/accounts/:id`                    | Details and activity counts                                           |
| `POST /api/accounts/:id/email-code`        | Request an account code for its stored email; admin plus PIN          |
| `POST /api/accounts/:id/email-code/verify` | Verify code and save initial password before activation               |
| `POST/DELETE /api/accounts/:id/invitation` | Protected resend/cancel of pending invitations                        |
| `POST /api/accounts/:id/verification`      | Resend to registered email; empty body; admin plus PIN                |
| `POST /api/accounts`                       | Create a Gmail-only account with an automatic or manual six-digit UID |
| `GET /api/accounts/uid-availability`       | Check whether a manual UID is free; admin plus PIN                    |
| `DELETE /api/accounts/:id`                 | Confirmed admin/PIN account deletion; history retained; 028 required  |
| `PATCH /api/accounts/:id`                  | Edit name, role and/or access                                         |
| `POST /api/accounts/:id/password`          | Set another account's password                                        |
| `GET /api/accounts/:id/offboard-preview`   | Counts only for agent handover; admin plus PIN                        |
| `POST /api/accounts/:id/offboard`          | Atomic disable/handover; `{mode, target, changes?}`; admin plus PIN   |

## Verification

Automated tests execute all migrations in isolated PostgreSQL (PGlite) and exercise real API routes: permissions, hashing, password verification, session binding, resets/expiry/lockout, provisioning failures, audits and the closed legacy route. Frontend checks cover guarded routes, forms, confirmations, late responses, locking and pending actions. Browser checks use the actual React pages and local API/SQL with fixture Auth administration/password verification. No hosted accounts are read or changed. Results are recorded in [VERIFICATION.md](../VERIFICATION.md).

For the email confirmation upgrade, apply migration 020 once after 019 and configure Supabase Confirm email, SMTP and allowed login redirects as described in EMAIL_CONFIRMATION.md. After installing migration 016, set your real admin PIN and verify account creation, matching portal login and disabled access. Hosted Supabase Auth acceptance remains a separate step from isolated local checks.

## Administrator login and optional-agent recovery

Admins sign in with verified email/password and manage accounts through their personal PIN. Mandatory admin MFA was removed at the user's request; existing factors or old reset states cannot force an admin code step, and admin login needs no 025 installation. Email confirmation, completed enrollment, active profiles and saved roles remain enforced.

For optional-agent MFA, a PIN-unlocked administrator may open an agent account's details and choose Reset two-factor. Confirmation deletes native factors, invalidates old CRM assurance/grants and records safe audits without changing role, password or client ownership. Partial failures leave blocked state for retry. No reset button is offered for administrator accounts. Only this optional agent feature needs 025 after 024. See [current login and recovery policy](ADMIN_TWO_FACTOR_LOGIN.md). Existing database migrations/native factors were not deleted.
