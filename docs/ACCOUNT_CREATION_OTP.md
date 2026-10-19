# Account creation after independent email verification

> **Superseded by update 036 (17 October 2026).** New accounts are now created directly, with Gmail-only addresses and six-digit UIDs and no email code; see [ACCOUNT_UIDS.md](ACCOUNT_UIDS.md). This page applies only to finishing or cancelling email-code requests started before 036. `POST /api/accounts` no longer starts a request.

Updated 16 October 2026. This is the current workflow for **new Admin and Agent accounts** after database update **035**. It supersedes new-account native OTP instructions in `AGENT_EMAIL_CODES.md`; historical native pending users and invitation links remain supported. The later attached OTP task superseded the briefly selected Google-sign-in alternative. No Google sign-in implementation was installed.

## Implemented behavior

The existing repository is React/Vite with an Express API, not Next.js. It has been extended without migrating its framework. Accounts still requires an active administrator and that administrator's personal session-bound PIN unlock.

1. Open Accounts and choose **Create account**. Enter name, email, account role, password and confirmation. Passwords need at least 12 characters and at most 72 UTF-8 bytes.
2. Create account validates the fields and reserves a durable pending request. **No Auth user or profile is created at this point.** A six-digit code generated with Node's cryptographic random generator is sent by the application server using the configured provider.
3. **Verify Email Address** shows a masked address, numeric paste-friendly input, ten-minute countdown, loading/errors, **Verify & Create Account**, **Resend Code**, **Cancel request** and Close. Closing retains the pending request, while cancellation invalidates it if provisioning has not begun.
4. Enter the code obtained from the email owner. The same initiating admin, current PIN, original password and stored name/email/role/access must match. Wrong code: **Invalid verification code. Please try again.** Wrong original passwords also fail the binding check without permitting substitution.
5. Correct code authorizes server-only Supabase Auth creation with the original password and a reserved unique user ID. The existing trigger makes its profile inactive. A separate audited SQL transaction saves its role/name, completes the request and enables intended access.
6. Account list refreshes. The owner signs in through the matching Agent/Admin portal with that email/password. No recipient session is ever created in the administrator's browser or server client.

The password is retained only in the current React dialog state during setup and transmitted to the server at start and finalization. It is never written to a pending table, audit, URL, localStorage, sessionStorage or cookie. Closing, locking, navigating away or refreshing removes it from the form; **Resume verification** then asks for the original password. The server stores only a keyed commitment to the whole request including the password, not a separate password hash. Changing the password requires cancelling an unstarted request and creating a fresh request. Do not reuse a real personal/Gmail password as the CRM password.

An accepted email-send response does not verify an inbox. Verification occurs only after the correct request-bound code passes. This proves access to the inbox, not employment, personal identity, or Google/Microsoft organizational membership. The system does not pretend to look up arbitrary Gmail accounts.

## What was completed locally

- Migration 035 adds protected pending requests, durable send/verify rate events, PIN/owner-gated helpers, atomic attempts/claims, fixed identity reservation and a profile-activation guard.
- New server service implements independently generated OTP/HMAC, strict payloads, original-password binding, current authorization checks, sender configuration and recovery.
- SMTP and Resend delivery adapters have timeouts and sanitized failures; the new flow does not use `signInWithOtp`, `verifyOtp`, invitation mail or recovery mail.
- Accounts creation and the responsive modal/pending-request recovery list are implemented. Existing native pending accounts retain their separate completion form.
- Root `api/index.js` exports Express without `.listen()` or background jobs. `vercel.json` prepares same-origin API routes, SPA fallback and a 60-second Node function.
- Automated isolated PostgreSQL/API, mock-provider and React tests, formatting and production build are recorded in `VERIFICATION.md`. These cannot certify live hosted acceptance.

No hosted migration, Vercel configuration, sender credentials, actual account or outbound email was changed by this task. The user chose manual database installation. No production readiness claim is made before the following configuration and acceptance steps.

## Step 1 — Apply only missing SQL updates

Open the CRM Supabase project, then **SQL Editor → New query**. A read-only prerequisite check is:

```sql
select
  to_regprocedure('public.account_email_code_ready(uuid,text,text)') is not null as update_034,
  to_regclass('public.account_creation_requests') is not null as update_035;
```

If 034 is false, install the missing numbered migrations in order through 034 first. If 035 is false, copy the new SQL from Terminal:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/035_pending_account_verification.sql
```

Paste into a new SQL Editor query and **Run**. Expected result: **Success. No rows returned**. Do not rerun an installed numbered migration or run `supabase/setup.sql` against an existing database. The generated setup contains all 35 migrations for fresh projects only.

Migration 035 changes no earlier migration and does not modify existing user roles, Auth settings or RLS policies. New tables have RLS and no browser grants; only server/service-role helper calls can read or mutate challenges. Existing profiles receive an additional guard only if their ID belongs to an unfinished new verification request.

## Step 2 — Choose an email sender

**This new flow sends its own email. Supabase Email Templates, SMTP Settings and Send Email hooks are not used for new-account challenges.** Do not paste its template into SQL Editor or create an Auth hook. Existing password recovery/legacy email configuration remains separate and should retain its current settings.

Use one provider below. Do not post private credentials in chat or commit them. Configure credentials in root `.env` for local development and in Vercel server environment variables for hosted execution. Merely saving SMTP in the Supabase dashboard does not give the application server those credentials.

### Gmail SMTP for small-volume use

An eligible Gmail account with App Password access can send small volumes without purchasing a subscription or domain. Google limits, blocking and deliverability controls apply; it is not an unlimited transactional service. Enable Google 2-Step Verification and generate an app password for HD Marketing. Enter it directly into private environment settings. Some managed/Advanced Protection accounts cannot generate app passwords.

```dotenv
ACCOUNT_EMAIL_PROVIDER=smtp
ACCOUNT_EMAIL_FROM=your-sender@gmail.com
ACCOUNT_SMTP_HOST=smtp.gmail.com
ACCOUNT_SMTP_PORT=587
ACCOUNT_SMTP_USER=your-sender@gmail.com
ACCOUNT_SMTP_PASSWORD=your-generated-google-app-password
```

Use the same Gmail address for FROM and username. Port 587 uses required STARTTLS; port 465 uses TLS from connection start. Certificate checking remains enabled. No domain verification is required when sending from that authorized Gmail account. No POP/IMAP setting is needed. [Google App Passwords](https://support.google.com/accounts/answer/185833?hl=en), [SMTP settings](https://support.google.com/mail/answer/7104828?hl=en), [sending limits](https://support.google.com/mail/answer/22839?hl=en), [Nodemailer SMTP](https://nodemailer.com/smtp).

Google may reject authentication from a hosting provider even when the password is correct. Inspect the sender's security alerts; never weaken TLS or expose credentials to bypass a block. A verified transactional sender is the production alternative.

### Resend transactional delivery

Create/use your Resend account, add a domain you control under **Domains**, and install the requested SPF/DKIM DNS records until verification succeeds. Use a sender on that domain. The provider's development sender is not general production delivery to arbitrary recipients. Provider plans/quotas and owning a domain may have costs; this path is optional and is not promised to be free for every deployment.

```dotenv
ACCOUNT_EMAIL_PROVIDER=resend
ACCOUNT_EMAIL_FROM=accounts@your-verified-domain.example
RESEND_API_KEY=your-private-sending-api-key
```

The application sends through the HTTPS API with a request/version idempotency key; it does not configure Resend as a Supabase Auth hook. Disable mail content/body logging and unnecessary tracking in provider dashboards. [Resend sending API](https://resend.com/docs/api-reference/emails/send-email), [sender domain verification](https://resend.com/docs/dashboard/domains/introduction).

## Step 3 — Configure the independent hash secret

Generate a random 32-byte value privately in your own Terminal:

```sh
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
```

Store its output as **ACCOUNT_OTP_SECRET**, never with a `VITE_` or `NEXT_PUBLIC_` prefix. Use a stable value shared by all instances of the same deployment/database. Keep it separate from Supabase keys and Accounts PIN pepper. Rotating it invalidates pending OTPs and original-password commitments; complete/cancel pending work first. Existing completed accounts are unaffected by key rotation.

The application validates its configured secret and sender before inserting a new challenge or sending mail. Missing settings show a clear setup error, with no Auth creation.

## Step 4 — Configure Vercel and redeploy

In **Vercel → Project → Settings → Environment Variables**, add the new server-only variables to the environment that will use this database:

| Name                     | Required                                       |
| ------------------------ | ---------------------------------------------- |
| `ACCOUNT_OTP_SECRET`     | Both providers, stable private random value    |
| `ACCOUNT_EMAIL_PROVIDER` | `smtp` or `resend`                             |
| `ACCOUNT_EMAIL_FROM`     | Authorized sender address only                 |
| `ACCOUNT_SMTP_HOST`      | SMTP only                                      |
| `ACCOUNT_SMTP_PORT`      | SMTP only; normally `587`                      |
| `ACCOUNT_SMTP_USER`      | SMTP only                                      |
| `ACCOUNT_SMTP_PASSWORD`  | SMTP only; Gmail App Password where applicable |
| `RESEND_API_KEY`         | Resend only                                    |

Keep the existing server settings: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FRONTEND_URL` (exact public HTTPS origin), `ACCOUNTS_PIN_PEPPER`, `WEBHOOK_SECRET`, `CALL_PROVIDER=manual`, and the existing optional-agent MFA settings. Existing runtime validation remains enabled. Keep production and preview credentials/databases separate where possible.

Browser settings remain only the public `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (or existing public-key equivalent) and optional `VITE_API_URL`. For the supplied same-origin deployment, leave `VITE_API_URL` unset or `/api`. Never prefix sender/API keys, hash secrets or service-role credentials with `VITE_`/`NEXT_PUBLIC_`.

Use the repository root **hd-marketing-crm** as Vercel's Root Directory, Node 22 or newer supported by your project, build `npm run build`, output `client/dist`. The supplied `api/index.js` is a Node serverless function, not an Edge function. The new challenge flow awaits all work within the HTTP request and requires no worker, local filesystem, in-memory challenge store or persistent process. PostgreSQL enforces send/attempt limits across instances. Existing in-process HTTP rate limits are extra protection, not the durable security boundary.

Choose **Deployments → Redeploy** after saving environment variables and deploying the matching source. Do not deploy only the frontend while leaving an older API. Confirm `/api/me` returns 401 when signed out rather than HTML, and confirm client routes such as `/accounts` load after refresh. Vercel routing and real provider network access must be verified in your deployment; no hosted deploy was performed here.

Other existing CRM scheduled jobs still need their own established scheduling; this change does not silently turn them into Vercel cron jobs. Existing platform request/upload limits also still apply to unrelated features.

## Step 5 — Safe hosted acceptance

1. Use a controlled recipient inbox and an existing active admin. Unlock Accounts.
2. Create a clearly labeled test Agent with a new strong CRM password. Confirm a pending verification row appears, and **Authentication → Users** contains no new user yet.
3. Enter an incorrect code. Expect the invalid-code alert and still no new Auth user. After five wrong submissions, request a new code; the server enforces cooldown and send quotas.
4. Confirm the real code arrived. The provider accepting a request alone is not receipt. Check spam/junk if needed. Enter the correct current code with the original password.
5. Confirm success, one new Auth user in **Authentication → Users**, and correct profile in **Table Editor → profiles**: matching UUID, name, `role=agent`, `active=true`. A read-only SQL check may join profiles/Auth for your test email, but do not share passwords, hashes or full customer rows.
6. Confirm the original admin session stayed open. In another browser/private window, sign in as the new Agent using the configured email/password. Confirm Admin portal denial and normal assigned-lead scope.
7. Repeat with an Admin test account. Confirm Admin role and usual personal Accounts PIN setup; agent users must be denied account-creation APIs.
8. Test Close → Resume and re-enter the original password, resend after 60 seconds, old-code rejection, expiry after ten minutes, cancellation before provisioning, and a duplicate Create click. There must never be two users for one request.
9. Use the normal Accounts deletion process to remove only these explicit test users when finished. No test emails/users are created automatically by local verification.

## Limits, recovery and troubleshooting

- Expiry: ten minutes, checked server-side. Countdown is informational; changing the browser clock cannot extend validity.
- Failed code/password binding checks: at most five per challenge, atomically recorded. Resend resets the attempt counter and invalidates the prior code. Random code generation excludes the previous visible code for that request.
- Sends: minimum 60 seconds between sends, at most five sends per request (initial plus four resends), five to the same normalized address/hour, and twenty per initiating admin/hour. Verification is capped at one hundred submissions per admin per fifteen minutes across all instances. HTTP/IP/provider limits also apply. A non-provisioned exhausted request can be cancelled and restarted subject to the same hourly limits.
- A new request for an already registered email or another live pending request returns 409. Same-admin pending requests appear in Accounts; another admin cannot read or finish them. Email normalization trims/case-folds without rewriting dots or plus aliases.
- Sender error/timeout leaves a request in failed/unconfirmed delivery state, never an Auth user. Resume and resend after cooldown; do not repeatedly create requests.
- Auth timeout after a correct OTP uses the reserved UUID and server-owned `crm_account_request` metadata to discover only that operation's user. It never searches for and deletes someone else's user or resets an existing user's password. A failed or ambiguous Auth operation can be retried with the same request, original password and still-valid exact code. Completed duplicate requests return the existing result with no new account/mutation; an old code cannot create another account.
- If profile/audit completion fails after Auth insertion, the trigger-created profile remains inactive and the request stays tracked as creating. Resume with the same credentials to finish, or resend if expired and no creation lease is active. OTP and password binding are checked again on each retry; arbitrary codes cannot reuse earlier proof. Resend clears earlier claims/proof and issues a fresh challenge. There is no unrestricted bearer verification ticket.
- Cancellation is refused once provisioning starts; use Resume to complete safely. This prevents treating a possibly committed external Auth operation as a cancelled/no-user request. A partial user remains tracked by the reserved request, never silently activated or automatically deleted. If the originating admin is disabled or demoted, that request cannot complete until authorization is legitimately restored; another admin can use the existing account-management/deletion process for a tracked inactive partial account. Do not bypass the owner/PIN gate by editing database state.
- If the admin loses authorization during the external operation, SQL activation fails. The native account may have been inserted already, but its CRM profile stays inactive. The unavoidable external/SQL transaction boundary is explicit.
- On reload or close, the browser forgets the password. Resume requires the exact original one; otherwise cancel a request that has not begun provisioning and restart with a different password. A wrong original password shows the same invalid verification error as a wrong code and consumes an attempt.
- Pending request rows retain audit/recovery state in protected storage. Expired never-verified requests are marked expired on subsequent creation; no background job is required for security. Completed/cancelled OTP hashes are cleared. A retention purge is not scheduled by this change; configure a reviewed retention policy for these protected operational rows if needed.
- Update-required error: install only missing numbered SQL migrations through 035 in the connected project, then reload/redeploy matching code. Do not paste email HTML into SQL Editor.

## API and file reference

| Endpoint                                       | Behavior                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/accounts`                           | Strict `{name,email,password,role,active?}` → HTTP 202 pending challenge, no Auth user          |
| `GET /api/accounts/pending`                    | Safe masked list of this admin's unfinished requests                                            |
| `POST /api/accounts/pending/:requestId/resend` | Strict `{}`; stored recipient, fresh code/version/expiry                                        |
| `POST /api/accounts/pending/:requestId/verify` | Strict `{code,password}`; current admin/PIN and original binding; Auth created only after proof |
| `DELETE /api/accounts/pending/:requestId`      | Strict `{}`; cancel before provisioning                                                         |

Primary files: `server/src/services/accountCreation.js`, `accountCreationMail.js`, `server/src/routes/accounts.routes.js`, `client/src/pages/admin/Accounts.jsx`, `client/src/components/accounts/PendingAccountVerification.jsx`, migration `035_pending_account_verification.sql`, generated `supabase/setup.sql`, `.env.example`, `api/index.js`, `vercel.json`, new/updated automated test files, README and complete documentation.
