# Independent account-creation OTP implementation report

16 October 2026. Scope follows the latest attached task: independent email OTP before account provisioning. The earlier Google-sign-in choice was superseded by that task; no Google lookup or OAuth flow is claimed. The repository is React/Vite + Express + Supabase, so its existing framework was preserved.

## A. Implementation summary

The admin enters name, email, password/confirmation and Agent/Admin role. Initial submission reserves a protected pending request and sends a cryptographically random six-digit challenge; there is **no Auth user or profile yet**. The masked-address modal supports paste, autofocus, numeric input, expiry timer, resend cooldown, cancel, loading and errors. The same active/PIN-unlocked initiating admin must enter the correct code and original password before server-only Auth provisioning. Stored request fields determine role and intended access.

A keyed OTP digest and separate keyed commitment to the whole original request/password are kept in PostgreSQL. No plaintext code or password is stored there. Passwords live only in the current form's short-lived memory and HTTPS request payloads, never URLs or browser storage. A same-admin pending list permits resuming after the form is closed; the original password must be re-entered.

Auth uses a reserved deterministic UUID and a server-owned operation marker. Trigger-created profiles remain inactive until an audited SQL transaction assigns the correct role and completes activation. Timeouts and partial failures are recoverable without duplicating users or modifying an unrelated legitimate account. No recipient authentication session is created, and administrator login/session state is unchanged.

## B. Files changed

Created:

- `supabase/migrations/035_pending_account_verification.sql`
- `server/src/services/accountCreation.js`
- `server/src/services/accountCreationMail.js`
- `client/src/components/accounts/PendingAccountVerification.jsx`
- `api/index.js`
- `vercel.json`
- `server/tests/account-creation.test.js`
- `server/tests/account-creation-mail.test.js`
- `client/tests/pending-account-verification.test.jsx`
- `docs/ACCOUNT_CREATION_OTP.md`
- `docs/ACCOUNT_CREATION_OTP_REPORT.md`

Modified for integration, regression coverage or documentation:

- `server/src/routes/accounts.routes.js`
- `client/src/pages/admin/Accounts.jsx`
- `server/package.json`, `package-lock.json` (pinned Nodemailer transport)
- `.env.example`
- `supabase/setup.sql` (fresh installation only, through 035)
- `server/tests/account-invitations.test.js`, `server/tests/accounts.test.js` (historical pending-user fixtures remain covered)
- `client/tests/accounts.test.jsx` (new pre-creation workflow and earlier management behavior)
- `client/tests/documents.test.jsx` (test-only live-render assertions for debounced property/keyword searches)
- `README.md`, `VERIFICATION.md`
- `docs/ACCOUNTS_AND_SECURITY.md`, `docs/AGENT_EMAIL_CODES.md`, `docs/EMAIL_CONFIRMATION.md`
- `CRM_Authentication_Email_Verification_Implementation.md`
- `docs/CRM_COMPLETE_DOCUMENTATION.md`, `scripts/build-project-doc.py`, generated `docs/HD_Marketing_CRM_Complete_Documentation.docx`

Earlier numbered migrations and unrelated CRM business logic are preserved. The existing lead-management upgrade bundle remains 029–032.

## C. Database changes

Apply **035 after 034**, once. New protected `account_creation_requests` and `account_creation_events` tables store durable request/status, keyed digests, role/owner, expiry, failed attempts, send counts/timestamps and finalization leases. Browser roles have neither table access nor helper-function execution. The additional profile trigger blocks unfinished request users from activation/role escalation. Guard wrappers prevent older edit/password/native-code controls from mutating a partially provisioned user. Existing active users and earlier native pending-user/invitation completion remain supported.

The request UUID is also the reserved native user ID. Correct-code processing leases one finalization. Completion independently rechecks native email, confirmation, operation metadata, profile state and current admin/PIN; activation and completion audit commit together. External Auth creation cannot share that transaction, so failures leave a managed inactive partial user tied to the durable request. The implementation never automatically deletes an existing user to compensate for an ambiguous error.

## D. Supabase setup

Follow [the beginner setup guide](ACCOUNT_CREATION_OTP.md), starting with its read-only 034/035 check. In Terminal copy only the needed migration:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/035_pending_account_verification.sql
```

Paste into **Supabase → SQL Editor → New query** and Run. Expected: **Success. No rows returned**. Install missing predecessors in order first; do not rerun existing migrations or fresh setup over existing data.

No global confirmation/security switch changes, Supabase email-template edits or Auth hook are needed for **new** account challenges. Supabase's usual email settings still serve existing recovery/legacy flows and remain separate.

## E. Email provider setup

Choose SMTP or Resend and enter private values directly in the server/Vercel environment. An eligible Gmail sender with Google 2-Step Verification and an App Password can serve small volumes without a paid subscription or purchased domain, subject to Google limits/blocks. The application requires that sender's host/port/username/app password; saving them only inside Supabase does not configure this independent server sender.

Resend uses an HTTPS sending key and an authorized From address on a verified domain you control. Its general-recipient production delivery requires domain verification; provider quotas/domain ownership may have costs. The guide covers both options without requiring a paid signup.

Professional HTML/text mail is generated server-side. A provider accepting the send request is not proof of receipt or ownership. SMTP uses required TLS/certificate checks, bounded timeouts, no pooled/background connections and disabled protocol/body logging. Resend uses a bounded HTTPS request and per-challenge idempotency key. Provider errors are sanitized.

## F. Vercel configuration

Add server-only `ACCOUNT_OTP_SECRET`, `ACCOUNT_EMAIL_PROVIDER`, `ACCOUNT_EMAIL_FROM` and either `ACCOUNT_SMTP_HOST`, `ACCOUNT_SMTP_PORT`, `ACCOUNT_SMTP_USER`, `ACCOUNT_SMTP_PASSWORD` or `RESEND_API_KEY` under **Project → Settings → Environment Variables**. Preserve existing server runtime credentials/settings. Use only the public Supabase URL/key in `VITE_` browser variables.

Deploy matching source from the repository root with `npm run build`, output `client/dist`, supported Node 22+ runtime and the supplied `api/index.js`/`vercel.json`. The entry exports Express without binding a port or starting jobs. PostgreSQL stores challenges and rate state, so the feature needs no persistent instance, memory-only OTP map, filesystem or worker. Redeploy after environment changes and confirm `/api/me` returns protected JSON rather than the SPA HTML.

Hosted deployment/routing, runtime outbound SMTP/API connectivity and actual inbox delivery were not exercised. Existing unrelated scheduled jobs retain their separate deployment requirements.

## G. Testing results

Final checks passed:

- `npm run test -w server`: **601 tests / 28 files**.
- `npm run test -w client`: **278 tests / 24 files**.
- Focused account creation, mail, existing account/invitation and setup-bundle regression: **115 tests / five files**.
- `npm run build`: production frontend build passed after the final account UI/security changes. Existing vendor annotation/large-entry warnings remain nonfatal.
- Prettier checks on changed JavaScript/JSX/JSON, plus relevant Node syntax checks, passed.

The separate final full suites total **879 passing tests**, with no remaining failures. During development, intermediate checks exposed a native unban call occurring before the partial-account guard, which was fixed in production code. A debounced Documents search test also asserted a detached element; the test now checks the expected count/link together against the current render, without changing Documents behavior. `VERIFICATION.md` records these and the earlier corrected fixture/render issues.

The isolated tests exercise real PostgreSQL migration/helper logic through PGlite and Express routing with synthetic Auth/email-provider responses, plus React interaction coverage and the production build.

Cases cover both roles; no user before verification; exact/wrong/expired/reused codes; bounded attempts/resends and old-code invalidation; malformed/duplicate emails; unauthorized/agent/other-admin denial; disabled/demoted admin; binding against changed password/role/email; concurrent/repeated submissions; provider errors; Auth and profile failures; ambiguous-timeout and audited-completion recovery; deterministic identity protection; browser grants; legacy-route bypass denial; session preservation; and configured-password/role propagation. SMTP/Resend transport tests check safe TLS/timeouts and sanitized failures.

Local synthetic identity/session checks do not prove a real hosted password login or inbox delivery. Real multi-connection contention, native-provider acceptance, Vercel routing and physical-device accessibility remain hosted/device acceptance. The project has no TypeScript or ESLint configuration; applicable JavaScript syntax, Prettier, test and build checks are used instead of inventing unavailable checks.

## H. Security review

- Five atomic failed code/password-binding checks per challenge; server ten-minute expiry; 60-second resend cooldown; at most initial + four sends per request, five per normalized email/hour and twenty per admin/hour. Verification requests have a durable per-admin fifteen-minute quota. Existing HTTP/IP/provider limits remain additional controls.
- Challenge digests use a separate stable server-only HMAC key with request/version/purpose separation. Original fields/password are bound by a keyed commitment; changing role/email/password cannot finalize the original request. Plain OTPs and passwords never appear in challenge storage/audits/API responses.
- Every operation checks current authenticated active-admin authority, the initiating admin ID and session-bound PIN. Agent/public/another-admin access is denied. Revocation during external provisioning prevents final activation.
- Row/transaction locks and durable claim leases serialize finalization. Auth's reserved UUID and trusted operation marker permit safe recovery without altering unrelated accounts. Completed replay returns only the prior safe result and makes no new user/mutation.
- Trigger/default inactive profiles, audited completion and legacy-route guards prevent partial users from gaining CRM access or changing passwords through an alternate management path.
- Native passwordless Auth methods are not used in new account creation. The browser keeps the original admin session; no recipient token is generated or installed.

## I. Final status

Local implementation is complete; final automated verification results are recorded in section G and VERIFICATION.md. **Hosted configuration and acceptance are still required**: install 035 after 034, configure the independent secret and sender privately, deploy matching code and test a controlled inbox/login. No real account, email, sender, Supabase setting or Vercel deployment was changed automatically. Production readiness and live delivery are not claimed.
