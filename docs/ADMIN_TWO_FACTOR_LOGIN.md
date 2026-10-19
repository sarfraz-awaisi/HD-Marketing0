# Administrator login and optional agent MFA

Updated 14 October 2026. The user requested removal of administrator two-factor login after P5 was implemented.

## Administrator login

Select Admin and enter the registered email and password. The API verifies native identity/signed claims, inbox confirmation, active profile and the saved portal role before installing the main session. Email suggestions store only accepted emails. Invitation acceptance and recipient password setup remain required for invited accounts.

**Admin login requires no authenticator code and no migration 025.** Existing native factors and historical pending/failed/completed MFA reset records do not force an admin code step. The agent MFA environment setting does not apply to admins. Admin settings now describes email/password and personal PIN management. Accounts offers no administrator-factor reset button; obsolete admin verification/reset API requests are refused without native factor changes.

Restart the updated API with Ctrl+C then `npm run dev`, and refresh the browser. If a development server is already running, restart that existing terminal instead of opening a second instance on port 5173. No SQL update, setup.sql rerun or database reset is needed to remove admin MFA. Missing updates for other features, such as Meta 024, still follow their separate installation guides.

The personal four-digit Accounts PIN remains required for account administration. Use Forgot your password for login-password recovery. Confirmed inbox ownership, active access, role checks and client ownership still govern CRM operations.

## Optional agent two-factor login

REQUIRE_AGENT_MFA=false remains the default. An unenrolled optional agent can sign in with email/password even if migration 025 is absent. The API tolerates only a known missing-MFA-schema error for that case; an unavailable/malformed installed security state is not silently accepted.

An agent with a verified enrolled TOTP factor, or REQUIRE_AGENT_MFA=true, must verify native TOTP. This optional feature requires the missing numbered updates through **024**, then **025_admin_totp_mfa.sql**, and enabled native TOTP enrollment/verification. For an existing database, apply each missing migration once in order. Never rerun setup.sql there or delete old migrations to disable admin login checks. The fresh-install bundle still includes all 25 historical migrations.

From the project terminal on macOS, after prerequisites are installed:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/025_admin_totp_mfa.sql
```

Paste the copied SQL into the connected Supabase project's SQL Editor and Run, then restart API/jobs. This installation is only needed for optional-agent MFA. It was not performed on hosted Supabase here.

Required agents without a verified factor see QR/private-key enrollment and enter the current six-digit code. Enrolled agents verify an existing authenticator; multiple factors can be selected. Candidates remain isolated until same-user signed AAL2 and the active saved portal role are accepted. Cancel removes only newly created unverified setup, never an existing verified factor. Codes and setup keys stay out of CRM records/audits; keep them private.

## Optional-agent verification and recovery

POST /api/mfa/verify accepts strict factor UUID/six-digit code only for agents. A durable SQL reservation precedes the installed SDK's native challenge/verify. Five rejected attempts in a rolling 15 minutes create one critical alert and block CRM retries; ten total reservations and an additional per-IP limit bound incomplete/concurrent requests. Provider outages/disabled verification are recorded as unavailable, not wrong-code failures. No raw provider error, code or setup key is audited. Direct native Auth requests use Supabase's own limits; provider-wide failure hooks are not installed.

A PIN-unlocked admin can open an agent account's details and choose Reset two-factor, confirm identity and confirm the action. The supported Auth Admin API deletes native factors after durable blocked staging. Safe audits and an old-session cutoff remain. Role, password, lead ownership and history stay intact. Partial native/SQL failure stays blocked for retry; operation fences prevent old workers completing newer resets. Running operations have a five-minute recovery window. Required agents enroll a replacement; unenrolled optional agents can use a fresh password session after successful reset.

Administrators are exempt from MFA reset states under the user's new policy. Existing native factors/private records are preserved, not deleted remotely. No actual Auth factor enrollment/reset was performed by this work.

## API and stored state

- GET /api/me returns current active identity and policy flags. Administrators always receive mfa_required=false and mfa_reset_pending=false.
- POST /api/mfa/verify rejects admin calls with MFA_NOT_REQUIRED before any provider/attempt write.
- POST /api/accounts/:id/mfa-reset requires Admin/PIN and an agent target; admin targets are refused before factor deletion.
- Protected CRM handlers accept valid confirmed active admin password sessions; required/enrolled agents still need native AAL2 and a valid private reset state.

Migration 025's private RLS tables mfa_attempts/mfa_resets and service-only empty-search-path functions are preserved unchanged. Their secrets-free attempt/recovery records support optional-agent MFA. All existing migrations 001–025 remain unchanged; no new migration is needed for the admin policy removal.

## Validation and acceptance

Automated coverage includes admin password login with/without stored factors, historical reset states, saved portal/active/confirmation checks, private PIN protection, real isolated schema through 024, optional-agent missing-schema behavior and required-agent enforcement. Frontend checks cover direct admin session installation/restoration, no authenticator prompt, hidden admin reset controls and retained optional-agent flows. Latest test/build/browser results are in VERIFICATION.md.

Real hosted email, native optional-agent TOTP, signing-key behavior, SMTP and physical-device acceptance remain separate. No real .env, passwords, keys, customer data, native factors or hosted settings were read or changed. P6 deployment, P7 SMTP/password-reset delivery and P8 broader devices remain pending.

Native MFA references retained for the optional-agent implementation:

- [Supabase TOTP workflow](https://supabase.com/docs/guides/auth/auth-mfa/totp)
- [Verified JWT claims](https://supabase.com/docs/reference/javascript/auth-getclaims)
