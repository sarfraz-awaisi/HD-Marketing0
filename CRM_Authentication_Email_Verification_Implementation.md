> **Latest implementation:** [Independent account-creation OTP (035)](docs/ACCOUNT_CREATION_OTP.md) creates no Auth user before verification. Older native OTP/invitation design below is historical; existing pending users remain recoverable.

> Current enrollment: update **034 after 033** makes new Agent and Admin accounts use email codes entered in Accounts. Supabase default-free email cannot deliver numeric codes to arbitrary addresses; see [the free Gmail SMTP setup and current workflow](docs/AGENT_EMAIL_CODES.md). The earlier invitation design below remains historical and supports already-issued links.

# CRM authentication, invitations and email verification

Current agent enrollment changed in update 033: administrators enter an emailed OTP and set the initial password in Accounts. The 023 invitation audit below remains the historical design and the current administrator invitation flow. See [agent email codes](docs/AGENT_EMAIL_CODES.md) for the current agent workflow and hosted template setup.

Updated 14 October 2026. Implementation covers migration **023_admin_account_invitations.sql** after 022. Changes and verification are local; no production database, SMTP setting, deployment, real inbox or real account was accessed or changed.

## Audit of the original flow

The CRM uses Supabase Auth through `@supabase/supabase-js` / `@supabase/auth-js` **2.117.3**, React/Vite and an Express API. Public configuration belongs to the browser; the privileged Supabase client is created by `server/src/config/supabaseAdmin.js` on the server.

| Area                  | Original implementation and assessment                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                 | `client/src/pages/Login.jsx` uses an isolated password sign-in client, then `/api/me?portal=agent\|admin` checks the saved role before installing the main session. No registration form or CRM signup endpoint.                              |
| Session restoration   | `AuthContext.jsx` restores and periodically rechecks `/api/me`; protected routes use its authorized profile. Same-account checks preserve mounted pages.                                                                                      |
| API authentication    | `auth.js` calls trusted `auth.getUser(token)`, requires native `email_confirmed_at` and an active saved profile on each CRM request. Supabase login success alone was already insufficient.                                                   |
| Roles                 | `public.profiles.role`, constrained to Admin/Agent values. Role selection is enforced server-side; user-editable metadata cannot choose an admin role.                                                                                        |
| Accounts              | `Accounts.jsx` and `accounts.routes.js` require an active admin and a personal PIN grant bound to the current Bearer token. SQL independently rechecks both.                                                                                  |
| Creation              | The admin supplied a password. The server used `admin.createUser`, `email_confirm:false`, trusted provisioning metadata, staged inactivity and an Auth ban, then assigned the role, removed the ban and enabled requested access.             |
| Confirmation          | Migration 020 added audited `auth.resend({type:'signup'})`. The API refused unconfirmed native emails. Send success did not mean inbox verification.                                                                                          |
| Profile trigger       | `create_profile` defaulted ordinary Auth users to active agents unless trusted staging metadata was present. Public signup was disabled in local config, but the default would be unsafe if hosted signup settings were accidentally enabled. |
| Database/Storage      | CRM tables have RLS and no browser-role grants/policies; protected functions are service-only. Private Storage reads pass through authorized server routes.                                                                                   |
| Account changes       | PIN-gated name/role/access edits, last-admin/self-protection and password administration. Disabling agents uses migration 022 handover; records/history are retained. No account deletion UI.                                                 |
| Recovery              | Supabase password-recovery email redirects to `/login`; existing recovery behavior remains.                                                                                                                                                   |
| Development bootstrap | `setup-dev.js` previously auto-confirmed explicitly configured development users. It now creates unconfirmed inactive users and requests verification; it never auto-confirms them.                                                           |

Existing controls were retained. The main weaknesses were the lack of a tracked invitation lifecycle, admin-chosen initial passwords, the ordinary Auth profile's active default, and enabling the administrative access bit before email ownership was proven. Email confirmation already blocked actual unverified CRM access; a syntactically valid address being created did not prove an access bypass.

## What an email check can prove

Syntax and domain structure are validated before privileged creation. Addresses are trimmed and case-folded to match Supabase's account identity; dots and plus suffixes are preserved. Supported input is an ordinary ASCII address with a dotted DNS domain. Quoted local parts, internationalized input, domain literals and single-label domains are refused rather than silently rewritten.

The PIN-gated SQL check detects existing Auth users and pending invitations case-insensitively. Supabase's unique Auth email handling remains the final protection if two requests race; a second request cannot create a second profile or send another initial invitation.

`CRM_BLOCKED_EMAIL_DOMAINS` optionally lists exact provider domains separated by commas. It is empty by default, uses no third-party lookup and does not reject existing users. No automatic disposable-provider list or MX lookup is used. A legitimate address must not be denied because of a guessed mailbox-existence check.

A random Gmail address may still be syntactically acceptable and produce an **inactive pending account**. It cannot become usable until someone proves access through Supabase's verified email flow and the current invitation. A valid domain, provider send request or invented metadata is insufficient. This verifies inbox control; it does not certify legal identity or Google/Microsoft employee status.

## New account creation and acceptance

1. An active admin unlocks **Accounts** with their personal PIN and clicks **Create account**.
2. Enter name, email and Agent/Admin role. There is no initial-password field; the recipient chooses their own password.
3. The API validates input, the configured trusted redirect/expiry, the current admin identity and PIN, and duplicate accounts before contacting Auth.
4. `admin.createUser` stages an **unconfirmed user without a password**. The profile trigger always creates an inactive Agent; audited admin SQL assigns the selected name/role while keeping access inactive. This preparation protects against an invitation being opened before role provisioning finishes.
5. SQL records the invitation with a hash of a random 256-bit ticket, recipient ID/email, expiry, administering user and intended access. The raw ticket is not stored in the database or audits and is never returned by Accounts APIs.
6. The server uses `auth.admin.inviteUserByEmail` with the trusted `/accept-invitation?ticket=…` redirect. Accounts shows pending state even if the mail request succeeds.
7. Supabase verifies the inbox link and returns its session. `/accept-invitation` uses an isolated, non-persistent client; it does not replace an existing main CRM session. The page removes ticket/session parameters from browser history.
8. `/api/onboarding/context` verifies the session through trusted `getUser`, checks native email confirmation, exact recipient identity/email and the current unexpired ticket in SQL, then returns only that recipient's setup information.
9. The recipient chooses and confirms a password of at least 12 characters and at most 72 UTF-8 bytes. `/api/onboarding/complete` repeats authorization, updates only that verified recipient's password through Auth, then accepts the invitation and activates its intended access in an audited SQL transaction.
10. The isolated invitation session is discarded. The recipient signs in normally with the selected Agent/Admin portal and their new password. All regular CRM API checks still apply.

The supported Supabase invitation API is server-side. It can invite an unconfirmed user; a confirmed user requires a different supported email flow. The application never manually writes `email_confirmed_at`. See [Supabase users and invitations](https://supabase.com/docs/guides/auth/users) and [inviteUserByEmail](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail).

## Lifecycle and administrator actions

The new `public.account_invitations` table is application state, separate from `auth.users` and `public.profiles`. Its internal states are `preparing`, `sent`, `failed`, `accepted` and `cancelled`. Expiry is derived from the server clock rather than waiting for a background job.

| Display state        | Meaning and access                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pending invitation   | Invitation preparation/mail-request failure; profile inactive; review and resend.                                                |
| Pending verification | An invitation was requested but acceptance/password setup is incomplete, or a legacy user has not verified email. No CRM access. |
| Invitation expired   | Latest pending invitation's CRM deadline passed. No access; request a new link.                                                  |
| Invitation cancelled | Admin cancelled the latest pending invitation. No access; account/history retained.                                              |
| Active               | Native confirmed email, completed invitation where tracked, and active CRM profile.                                              |
| Suspended            | Verified eligible account with inactive CRM profile. No access; an admin may reactivate it.                                      |

Accounts retains its layout, name/email/role, creation date and native last-sign-in date. Details now show invitation date/expiry, verification and lifecycle state. Filters include pending, expired and cancelled accounts. Native last sign-in can record authentication before CRM authorization; it is not proof that a user entered the workspace.

- **Resend invitation:** Details on pending/failed/expired/cancelled invited accounts. Each request rotates the ticket and expiry, invalidating old links. Requests are PIN/admin-protected and limited by both API limits and a durable one-minute SQL cooldown.
- **Confirmed but unfinished:** if a user clicked an earlier invite and native email is already confirmed, resending uses `resetPasswordForEmail` to the same invitation callback. This renews inbox proof and password setup without trying to invite a confirmed user or auto-confirming anything. Ordinary password recovery still uses `/login`. See [Supabase recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).
- **Cancel pending invitation:** a separate confirmation keeps the Auth user/profile/history, marks the invitation cancelled and keeps access inactive. Resending after cancellation is an explicit admin decision to offer access again after acceptance.
- **Suspend:** existing verified accounts use the protected disable/handover workflow. The next API request is denied even with a previously issued valid token.
- **Reactivate:** available for verified eligible accounts, including accepted invitations. It restores access without returning old assigned leads. Pending invitations cannot be activated through the UI, API or SQL access trigger.
- **Password administration:** remains available for other verified accounts after completed invitation setup. It is not available as a shortcut around pending verification.
- **Legacy pending users:** after migration 023 they remain inactive. They can verify with the existing confirmation link and then receive explicit admin activation, or receive a new tracked invitation. Existing verified users retain their prior role and active/suspended access.

## Authorization and failure handling

The ordinary `/api` boundary continues to require trusted Supabase identity, native email confirmation and `profiles.active=true`. Roles come from `profiles`, never the request body or browser toggle. All creation/resend/cancel operations also require `adminOnly`, the current Accounts grant and SQL checks.

Only `/api/onboarding/context` and `/api/onboarding/complete` allow a verified recipient with an inactive profile to finish setup. They accept strictly the invitation ticket and, for completion, password. No caller-selected user ID, role, redirect, email or active status is accepted. The ticket is bound to the trusted authenticated user; knowing another ticket or guessing an ID grants no access.

Invitation functions and the table have RLS, revoked browser access and empty SQL `search_path`. The activation trigger rejects unconfirmed activation and any tracked invitation not yet accepted. Role changes preserve existing audit immutability, admin continuity and migration 022 handover checks. Every new Auth user defaults to inactive, so native self-signup cannot grant CRM data access even if hosted signup is accidentally enabled.

Auth, SMTP and PostgreSQL cannot share one transaction. If creation/setup/mail fails, the account is retained inactive for review. A send request whose SQL completion cannot be audited is not accepted for onboarding; the admin must review/resend. If password update succeeds but acceptance/auditing fails, the profile stays inactive and the user may retry while the current ticket is valid. If a response is lost after successful acceptance, use normal sign-in with the chosen password. Cancellation/expiry during setup may change the native password without granting CRM access.

No API response or audit contains a password, raw ticket, PIN, unlock secret or privileged key. The ticket must exist in the emailed redirect URL: configure infrastructure to redact query strings from request logs, use HTTPS and keep scripts on this callback trusted. Previously received emails cannot be recalled; cancelled/rotated/expired tickets simply fail authorization.

## Required Supabase dashboard configuration

These settings were **not inspected or changed** in the hosted project:

1. **Authentication → General/Sign-in settings:** disable new-user signup and anonymous sign-ins. Keep **Confirm Email** enabled. Review enabled identity providers according to the company's existing access policy. [Official configuration](https://supabase.com/docs/guides/auth/general-configuration).
2. **URL Configuration:** set Site URL to the real CRM origin. Keep the existing `/login` recovery redirect. Allow the exact invitation callback path with its ticket query, for example `https://crm.example.com/accept-invitation\?ticket=*` in Supabase's glob syntax. Use the actual configured `FRONTEND_URL`, including a base path if applicable; do not allow arbitrary domains. Local config includes the corresponding localhost callback. Verify that the complete query survives redirection. [Redirect URL rules](https://supabase.com/docs/guides/auth/redirect-urls).
3. **Email templates:** retain `{{ .ConfirmationURL }}` for Invite user and Reset password templates. It contains the provider verification step and redirect. Linking directly to `{{ .SiteURL }}` or dropping the ticket breaks the flow. The optional token-hash callback also accepts explicit `type=invite` or `type=recovery`; test any customized template separately. [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates).
4. **Email OTP expiration:** align the provider lifetime with the CRM invitation deadline. CRM expiry defaults to 60 minutes; `CRM_INVITATION_TTL_MINUTES` allows 5–60. If Supabase's link expires sooner, the earlier expiry wins and an admin must resend.
5. **Custom SMTP:** configure a verified sender/domain and provider credentials in Supabase, check provider limits and disable link tracking that rewrites verification URLs. The built-in sender has restricted recipients/limits and is not evidence of production delivery. [SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp), [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).
6. Test Invite user and the confirmed-but-unfinished recovery template with **owned test inboxes** or a controlled mail service. Check inbox/spam, actual acceptance, password setup and correct portal authorization. Do not send to invented real-world addresses. Email security scanners can consume one-time links; request a fresh invitation and assess template changes if that occurs.

Server settings are `FRONTEND_URL`, optional `CRM_INVITATION_TTL_MINUTES` and optional `CRM_BLOCKED_EMAIL_DOMAINS`. Existing server-only Supabase and PIN configuration remains. No new privileged browser setting is needed. Never put SMTP credentials or service-role/secret keys in a `VITE_` variable. No real `.env` file was read or modified by this work.

## Safe installation

1. Back up the database and confirm recovery is possible. Test this upgrade in a separate development project first.
2. Apply missing prior migrations in order through **022**, then copy the new file:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/migrations/023_admin_account_invitations.sql
   ```

3. In the correct project's Supabase SQL Editor, paste the **complete SQL file** into a new query and Run once. `Success. No rows returned` is expected. A failure rolls back the migration; retain its exact error. Do not reset the database or run the fresh-install bundle over an existing CRM.
4. Complete the dashboard/SMTP/redirect configuration above. Deploy the updated API and frontend together and restart jobs. Do not create invitations with the old application after the schema change.
5. Run the owned-inbox acceptance checks before using the workflow with staff. Keep an existing verified active admin available. Review legacy unconfirmed users and explicitly activate only after their inbox verification or invitation completion.

All previous migration files are unchanged. The fresh-install `supabase/setup.sql` includes 23 migrations and retains its fresh-database guard. No users are deleted. Verified accounts are retained; unconfirmed accounts are intentionally made inactive. Bootstrap a first admin through trusted Supabase administration and a real verification link, then promote/activate the known verified profile. The development script now leaves users inactive until verification and trusted activation; it has no auto-confirm bypass.

## Changed files

- `supabase/migrations/023_admin_account_invitations.sql`, generated `supabase/setup.sql`, local `supabase/config.toml`.
- `server/src/services/accountInvitations.js`, `routes/onboarding.routes.js`, `routes/accounts.routes.js`, `app.js`.
- `client/src/lib/accountInvitation.js`, `lib/supabase.js`, `pages/AcceptInvitation.jsx`, `pages/admin/Accounts.jsx`, `App.jsx`.
- `scripts/setup-dev.js`; the bootstrap no longer auto-confirms or activates unverified accounts.
- New invitation API/SQL and callback/UI tests; existing Accounts tests updated for recipient-owned passwords and pending activation. Other SQL fixtures explicitly provision their trusted operational users now that the profile trigger defaults inactive; previous protection assertions are retained.
- This implementation guide, README, email/account guides, verification record and complete project manual.

## Verification and limits

Automated tests cover syntax, normalization, optional screening, duplicate/pending accounts, inaccessible controlled addresses, admin/PIN denial, forged fields, native verification, accepted password setup for both roles, cancellation, expiry/rotation, resend cooldown, SMTP failures, rollback, active/suspended/legacy accounts and denied browser table/RPC access. Client checks cover isolated sessions, StrictMode callback initialization, URL cleanup, validation/pending/retry, portal login and recovery/session regressions.

Full server suite: **364 tests passed** across 16 files. Full client suite: **189 tests passed** across 16 files. Total: **553 tests**. The production build passed with the existing vendor/chunk warnings. Headless Chrome passed **18 responsive layouts** at 320/390/768/1440 px using actual local React/API/all23 SQL with fixture Auth/mail, including creation without an initial password, pending actions, isolated recipient setup, acceptance/portal authorization, used-link denial and cancellation. There were no overflow/undersized-control findings or JavaScript page errors; mobile creation and acceptance screenshots were visually reviewed. Detailed results and final follow-ups are recorded in `VERIFICATION.md`. The existing historically auto-confirmed accounts are not retroactively proven to own an inbox; review those accounts separately with the administrators. Native confirmation data is retained to preserve working legacy access.

Historically auto-confirmed accounts are not retroactively proven to own their inbox; their native state is retained to preserve working legacy access. Review them separately with administrators.

The tests use controlled Auth/SMTP fixtures and local PostgreSQL; they do not establish real email delivery or live Supabase gateway/Storage acceptance. No TypeScript/type-check script is configured; the code is JavaScript, tested by Vitest and the production build. Separate PostgreSQL connections, physical devices and owned-inbox delivery remain deployment acceptance steps. Admin MFA remains the next separate production-roadmap task.
