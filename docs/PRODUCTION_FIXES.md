# HD Marketing CRM: Production Fixes (P1–P8)

Prepared 13 October 2026, based on _HD Marketing CRM Complete Documentation_ (migrations 001–017).

Implementation tracking, updated 14 October 2026: P1 and P2 are implemented locally in migrations 018 and 019. The requested automatic-contact behavior supersedes the original P2 display restrictions in migration 021. P3 and P4 are implemented locally together in migration **022_agent_offboarding_and_kyc_access.sql**; hosted installation and real-account acceptance remain required. The later security task expands handover to all lead statuses and adds the single-agent option. See [handover and KYC usage/install steps](../CHANGES_OFFBOARDING_AND_KYC.md), [manual calls](MANUAL_CALL_LOGGING.md), [contacts](PROTECTED_PHONE_NUMBERS.md) and `VERIFICATION.md`. **Mandatory P5 admin MFA was removed at the user's request on 14 October 2026. Admin login uses verified email/password without migration 025. Optional-agent MFA remains available through the preserved 025 schema. P6 code/files are implemented locally in migration 026; live deployment/backup acceptance and P7/P8 remain pending.** VPS/domain/SMTP are not yet prepared. The original plan below is preserved as the ordered scope.

These eight fixes must be finished before the CRM is used with real customers. Give Codex **one fix per task**, in this order:

The later authentication audit adds migration **023_admin_account_invitations.sql** for verified invitation/password acceptance, inactive new profiles and tracked resend/expiry/cancellation. It preserves existing verified accounts and does not implement P5 MFA. See [authentication audit and installation](../CRM_Authentication_Email_Verification_Implementation.md). Meta Instant Forms uses 024; the preserved 025 schema supports optional-agent TOTP MFA. System monitoring uses 026. The next free migration number is 027. See [two-factor setup and recovery](ADMIN_TWO_FACTOR_LOGIN.md).

| Order | Fix                                           | Type                           |
| ----- | --------------------------------------------- | ------------------------------ |
| 1     | P1. Manual call logging                       | Code                           |
| 2     | P2. Protected phone numbers                   | Code                           |
| 3     | P3. Return leads when an agent is disabled    | Code                           |
| 4     | P4. Restrict Client KYC documents             | Code                           |
| 5     | P5. Two-factor login for admins               | Code                           |
| 6     | P6. Production readiness and deployment files | Code + server setup            |
| 7     | P7. Reliable password-reset email             | Supabase settings + small code |
| 8     | P8. Real phone and browser testing            | Tests + manual checks          |

---

## Rules for every fix (Codex must follow these)

Paste this block at the start of every task, or put it in `AGENTS.md` once.

```
Project rules for hd-marketing-crm:
- Read docs/CRM_COMPLETE_DOCUMENTATION.md and docs/PRODUCTION_FIXES.md first.
- New SQL goes in a NEW numbered migration in supabase/migrations/. Check the highest existing number and use the next one (018 if 017 is the latest). Never edit old migrations. Regenerate supabase/setup.sql with node scripts/build-sql.js.
- Business writes go through crm_mutate or a security-definer SQL function that checks the active actor and current lead ownership, locks rows, and writes audit_log in the same transaction. Set an empty search_path, revoke execute from browser roles, grant only to service_role.
- New tables: RLS enabled, no browser policies, no browser grants. The browser only calls /api.
- Strict Zod schemas in server/src/utils/validators.js. adminOnly() for admin routes. Agents are limited to leads currently assigned to them.
- Store UTC; show and enter Asia/Karachi time; format money as PKR.
- Audit metadata contains IDs and field names only, never phone numbers, passwords, PINs or message text.
- Add server tests (API + PGlite SQL) and client tests for every "Done when" item. npm test and npm run build must pass.
- Update docs/CRM_COMPLETE_DOCUMENTATION.md (permissions, workflows, API, migrations, limits), regenerate the Word manual with python3 scripts/build-project-doc.py, and add the results to VERIFICATION.md.
- Before writing code, list the files you will change and the migration you will add. Do not change unrelated features.
```

---

## P1. Manual call logging

**Why:** "Call lead" only works with the development mock, which is disabled in production. Without this fix, agents cannot record any call once the CRM is live, so outcomes, targets and reports stop working.

**Prompt for Codex:**

```
Implement fix P1 (manual call logging) from docs/PRODUCTION_FIXES.md.

Goal: agents call customers from their company phone, then record the call in the CRM. This must work in production with no calling provider.

Database (new migration):
- Add calls.method text NOT NULL DEFAULT 'provider' CHECK (method IN ('provider','mock','manual')); set existing mock calls to 'mock'.
- Add calls.answered boolean.
- New SQL function log_manual_call(p_lead, p_actor, p_data, p_request): checks the actor is an active admin or the lead's current assigned agent, locks the lead, inserts the call with method='manual', agent_id = actor (or the lead's current agent when an admin logs it), started_at, ended_at = started_at + duration, duration_seconds, answered, outcome, notes, deal_tags, outcome_submitted_at = now(), missing_outcome = false. Status = 'completed' when answered, 'failed' when not answered. Call advance_lead_status exactly as a completed provider call does (only when answered). Update last_activity_at. Write audit 'call.manual_logged'.
- Rules enforced in SQL and Zod: started_at not in the future (allow 2 minutes of clock skew) and not older than 48 hours for agents (admins: 30 days); duration_seconds 0–7200; when answered=false the outcome must be No answer, Busy or Wrong number and duration may be 0; when answered=true duration must be at least 1.

API:
- POST /api/leads/:id/calls/manual (admin or current assigned agent, sensitive rate limit). Body: answered, started_at, duration_minutes and duration_seconds (or total seconds), outcome, notes, deal_tags.
- Keep the mock routes for development only. In production, POST /api/leads/:id/call must not return a confusing 503 to agents; the UI should simply not offer it.

Screens:
- On the customer profile replace "Call lead" (when CALL_PROVIDER is not configured, or in production) with "Log a call". The dialog has: Answered? (Yes/No), call start (defaults to now, Pakistan time), duration (minutes + seconds), outcome, notes, tags. Reuse OutcomeForm and DealTagPicker.
- Show the method (Manual / Mock / Provider) in the timeline and on Call review, with a Method filter on Call review.
- Mock buttons appear only in development.

Done when:
- An agent can log an answered and an unanswered call on their own lead; the lead moves to Contacted only for the answered call.
- An agent cannot log a call on another agent's lead (404), in the future, or older than 48 hours.
- Completed-call metrics, targets and leaderboard count answered manual calls.
- With NODE_ENV=production and no provider, the profile shows "Log a call" and no mock controls.
```

---

## P2. Protected phone numbers

> Current phone behavior (13 October 2026): the user explicitly requested full numbers in all authorized lead lists and profiles. Migration 021 supersedes P2's masked-list, Show-number, two-minute expiry and daily display-quota requirements below. Admins see all contacts; agents see their currently assigned contacts automatically, with safe atomic audits. The original P2 specification is retained as history. See [current setup and behavior](PROTECTED_PHONE_NUMBERS.md).

**Why:** Full customer numbers now appear automatically in lists and profiles, and the batch endpoint returns up to 100 numbers at once. An agent can copy every lead before leaving. Until cloud calling is connected, numbers must be shown one at a time, on request, with a daily limit and admin alerts.

**Prompt for Codex:**

```
Implement fix P2 (protected phone numbers) from docs/PRODUCTION_FIXES.md. P1 must already be done.

Behavior:
- Lists, file views, timelines, dashboards and search results show only the masked number (e.g. 0300-XXX-567). Remove automatic phone loading everywhere (LeadPhones, PhoneBatch, AutomaticPhone).
- Remove POST /api/leads/phones (batch) entirely, for all roles.
- On the customer profile, show a "Show number" button. Clicking it calls GET /api/leads/:id/phone and displays the number with a tap-to-call link (tel:) and the "Log a call" button. The number is kept only in component memory, never in the query cache or localStorage, and is hidden again after 2 minutes or when leaving the page.

Database (new migration):
- Table crm_private.phone_reveals (id, user_id, lead_id, revealed_at). Index (user_id, revealed_at).
- Table public.security_alerts (id, type, severity 'info'|'warning'|'critical', user_id, message, metadata jsonb, created_at, reviewed_at, reviewed_by). RLS on, no browser access.
- SQL function reveal_phone(p_lead, p_actor, p_request): checks admin or current assigned agent; counts the agent's distinct leads revealed today (Asia/Karachi day). Revealing the same lead again the same day does not count again. If the count would exceed PHONE_REVEAL_DAILY_LIMIT (passed as a parameter, default 80), refuse with a clear error and insert a 'critical' security alert. When the agent reaches 80% of the limit, insert one 'warning' alert per day. Inserts phone_reveals and audit 'lead.phone_revealed', then returns the phone. Admins have no limit but are still recorded and audited.

API and config:
- New env PHONE_REVEAL_DAILY_LIMIT (default 80) in .env.example and docs.
- GET /api/security-alerts (admin, paginated, filter unreviewed) and PATCH /api/security-alerts/:id (mark reviewed).
- The response for a refused reveal is 429 with message "Daily number limit reached. Ask your admin."

Screens:
- Admin sidebar: "Security alerts" page with unreviewed count badge. Admin dashboard card "Unreviewed security alerts".
- Agent profile shows "Numbers shown today: X of 80".

Done when:
- No API response sent to an agent contains a full phone number except GET /api/leads/:id/phone.
- The 81st distinct reveal in one Pakistan day is refused and creates a critical alert; repeat reveals of the same lead do not count.
- The day resets at Asia/Karachi midnight.
- Tests prove lists, timelines, imports and file views return masked numbers only.
```

---

## P3. Return leads when an agent is disabled

**Why:** Disabling an account does not move its leads. When an agent leaves, their leads, follow-ups and visits stay with a disabled person until someone remembers to reassign them.

**Prompt for Codex:**

```
Implement fix P3 (return leads when an agent is disabled) from docs/PRODUCTION_FIXES.md.

Database (new migration):
- Extend the existing account access change path (update_account / account_action from migration 016) so that disabling an AGENT, in the SAME transaction:
  - moves every open lead (status not won/lost) owned by that agent according to a mode chosen by the admin: 'queue' (unassign; leads appear in an "Unassigned" admin view) or 'redistribute' (round-robin among other active agents using the existing assign_lead logic and locks);
  - writes one assignments row per lead with a reason column value 'deactivation' (add assignments.reason text, default 'manual', and backfill existing rows);
  - writes one audit summary 'account.leads_returned' with counts only.
- Change assign_lead (and assign_lead_import, and the deactivation path) so pending follow-ups and scheduled visits of a reassigned lead move to the new owner. In queue mode they stay attached to the lead and move when the lead is next assigned.
- Disabling must still preserve all history, deals and the responsible agent on past calls and deals.

API:
- The account disable request accepts lead_mode: 'queue' | 'redistribute' (required when the account owns open leads).
- Keep the existing Auth ban on disable so the person cannot sign in again.

Screens:
- In Accounts, the disable confirmation shows how many open leads, pending follow-ups and scheduled visits the agent owns, and asks: "Return to admin queue" or "Share among active agents".
- Admin Leads list gets an "Unassigned" filter and a dashboard card "Unassigned leads".

Done when:
- After disabling, the agent owns zero open leads and cannot sign in.
- In redistribute mode no lead goes to a disabled agent or an admin.
- If any step fails, nothing changes (access, leads and history roll back together).
- Reassigning any lead moves its pending follow-ups and scheduled visits to the new owner, and reminders go to the new owner.
```

---

## P4. Restrict Client KYC documents

**Why:** Client KYC entries are in the shared library, so every agent can read and download every customer's identity documents.

**Prompt for Codex:**

```
Implement fix P4 (restrict Client KYC documents) from docs/PRODUCTION_FIXES.md.

Database (new migration):
- Add knowledge_documents.lead_id uuid NULL references leads.
- Rule: category 'client_kyc' (use the exact stored value from migration 017) is visible to admins, and to an agent only when lead_id is set AND that lead is currently assigned to the agent. Existing KYC entries without a lead_id become admin-only.
- Enforce this in list_knowledge_documents, the document detail read, and the file download path. An unauthorized KYC entry must behave as not found (404), and must not appear in counts or search results.
- Other categories keep their current shared behavior.

API and screens:
- Admin entry form: when category is Client KYC, show a required "Customer" field (search leads by name). Saving KYC without a customer is refused.
- Customer profile: a "KYC documents" section lists that lead's KYC entries for the admin and the assigned agent, with download.
- When a lead is reassigned, KYC access follows the new owner automatically.

Done when:
- An agent sees zero KYC entries for leads not assigned to them, through every route including search and direct ID access.
- After reassignment the old agent loses access and the new agent gains it.
- KYC downloads remain audited.
```

---

## P5. Two-factor login for admins

**Superseded by the user's later request to remove admin two-factor login. Do not re-enable mandatory admin MFA from this historical specification.** Current admin login uses email/password; optional-agent MFA remains supported.

**Why:** Admin accounts can see every lead and number but are protected only by a password. The Accounts PIN is not two-factor login.

**Prompt for Codex:**

```
Implement fix P5 (two-factor login) from docs/PRODUCTION_FIXES.md using Supabase Auth TOTP MFA (authenticator app). Check the installed @supabase/supabase-js version and use its documented MFA methods (mfa.enroll, mfa.challenge, mfa.verify, mfa.getAuthenticatorAssuranceLevel, and the admin API for deleting factors).

Login flow:
- The existing portal login uses an isolated candidate client and installs tokens only after the server accepts the role. Add the MFA step inside that flow, before tokens are installed:
  - Admin with no verified factor: show "Set up two-factor login" with QR code and secret, then verify a 6-digit code.
  - Admin with a factor: show "Enter the 6-digit code from your authenticator app".
  - Only an aal2 session is installed for admins.
- Agents: MFA optional by default. New env REQUIRE_AGENT_MFA=false; when true, agents follow the same flow.

Server:
- In auth middleware, after getUser succeeds, read the verified token's aal claim. Admin (and agent when REQUIRE_AGENT_MFA=true) with aal1 gets 403 { code: 'mfa_required' } on every CRM route except GET /api/me, which reports mfa_required so the client can show the MFA step.
- Accounts page (PIN-protected): "Reset two-factor" action for another account, which deletes their factors through the Auth admin API and writes an audit entry. An admin cannot reset their own factor this way.
- Rate-limit code verification attempts and audit repeated failures; 5 failures in 15 minutes creates a security alert (table from P2).

Docs:
- Add a short guide: recommended authenticator apps, what to do if a phone is lost, and keep at least two active admins so one can reset the other.

Done when:
- An admin password-only session receives 403 mfa_required on all CRM routes.
- Enrolment, login with code, wrong code and reset all have tests.
- Agents can still log in normally when REQUIRE_AGENT_MFA=false.
```

---

## P6. Production readiness and deployment files

**Implemented locally, 14 October 2026:** migration 026, startup validation, explicit proxy trust, job heartbeats, admin status/readiness, lazy routes, PM2/Caddy and encrypted backups. See [deployment and real acceptance steps](DEPLOYMENT.md). VPS/domain/SMTP and live backup/restore remain unprepared.

**Why:** The CRM runs only on a Mac. It needs a server, HTTPS, background jobs that always run, backups and monitoring.

**Before this task (you, not Codex):**

1. Buy a VPS (a Linux server). Shared web hosting cannot run this app. A Hostinger **VPS** plan with Ubuntu 24.04, 2 CPU and 4 GB RAM is enough.
2. Point a domain or subdomain (for example `crm.yourcompany.com`) to the server.
3. Upgrade Supabase to the **Pro** plan so the project never pauses and has daily backups.

**Prompt for Codex:**

```
Implement fix P6 (production readiness) from docs/PRODUCTION_FIXES.md. Target: one Ubuntu 24.04 VPS, Caddy as HTTPS reverse proxy, PM2 for processes, Supabase hosted database.

Code changes:
- Startup config validation: in production refuse to start if required env values are missing, if CALL_PROVIDER=mock, if WEBHOOK_SECRET or ACCOUNTS_PIN_PEPPER (min 32 chars) is missing, or if FRONTEND_URL is not https. ACCOUNTS_PIN_PEPPER becomes required in production (no service-key fallback); document that existing admins must reset their PIN once after it is set.
- TRUST_PROXY env (default 'loopback') passed to app.set('trust proxy', ...) so rate limits use the real client IP behind Caddy/Cloudflare.
- Jobs heartbeat: new table job_heartbeats (job, last_success_at, last_error_at, last_error). Runner updates it each tick. Admin dashboard card "System status": last job run, any job failing, last backup time (from a backups table written by the backup script).
- GET /api/health/ready (admin only): database reachable, migrations at expected version, jobs heartbeat younger than 5 minutes.
- Route-level lazy loading (React.lazy) for admin pages, Documentation, Reports and Accounts to reduce the main bundle.

Deployment files:
- deploy/ecosystem.config.cjs: two PM2 apps, "crm-api" (server) and "crm-jobs" (npm run jobs), restart on failure, production env file path.
- deploy/Caddyfile: serve client/dist with SPA fallback; reverse proxy /api/* and /health to 127.0.0.1:3001; security headers; gzip/zstd; long cache for hashed assets, no cache for index.html.
- deploy/backup.sh: nightly pg_dump of the Supabase database (connection string from SUPABASE_DB_URL), encrypted with age to /var/backups/hd-crm, keep 30 days, write a row to the backups table. deploy/restore.md explains a test restore into a separate Supabase project.
- deploy/cron.txt: the crontab line for the nightly backup.
- docs/DEPLOYMENT.md: step-by-step for a non-technical owner, from a fresh VPS to a working https site: install Node 22 LTS, PM2, Caddy, age; clone; npm ci; npm run build; create .env (list every variable); apply missing migrations in Supabase; start PM2; enable PM2 startup on reboot; Cloudflare DNS and SSL "Full (strict)"; Supabase Auth Site URL and redirect URLs; disable public signups; how to update the app later; how to check logs.

Done when:
- npm run build passes and the main bundle is smaller than before (report sizes).
- Starting in production with a missing secret fails with a clear message.
- Tests cover config validation, heartbeat and the ready endpoint.
```

---

## P7. Reliable password-reset email

**Why:** Supabase's built-in email service is meant for testing and sends very few emails per hour, so "Forgot password" will fail with real users.

**You do this in Supabase (no code):**

1. Create an account with an email-sending service (for example Brevo, Resend or Amazon SES) and verify your company domain.
2. Supabase → Authentication → Emails → **SMTP settings**: enable custom SMTP and enter the service's host, port, username, password and a sender like `no-reply@yourcompany.com`.
3. Supabase → Authentication → **URL configuration**: set Site URL to your live CRM address and add it to Redirect URLs.
4. Edit the "Reset password" email template with your company name.
5. Send yourself a reset email and confirm it arrives and opens the new-password page.

**Prompt for Codex:**

```
Implement fix P7 from docs/PRODUCTION_FIXES.md.
- Password recovery must redirect to VITE_SITE_URL + '/login' (new env, required in production builds), not a hard-coded or localhost origin.
- Show a friendly message if the recovery email cannot be sent (rate limit or SMTP error) without revealing whether the email exists.
- Add the Supabase SMTP and URL configuration checklist from P7 to docs/DEPLOYMENT.md.
- Tests for the redirect URL and error message.
```

---

## P8. Real phone and browser testing

**Why:** The CRM was only tested in automated desktop Chrome. Agents will mostly use phones, often Safari on iPhone.

**Prompt for Codex:**

```
Implement fix P8 from docs/PRODUCTION_FIXES.md.
- Extend the existing browser checks with Playwright projects for WebKit iPhone (iPhone 13), Chromium Android (Pixel 7) and Firefox desktop, using the same isolated fixtures (never hosted customer data).
- Cover the agent journey: login (Agent portal, MFA when required), My leads, open file, open customer, Show number, Log a call, change stage with lost reason, add follow-up, add visit, open property pictures, open documents, reminders bell, sign out.
- Cover admin: import file, assign file, disable agent with lead return, security alerts, accounts unlock.
- Check at 320, 390, 768 and 1440 px: no horizontal page scroll, tap targets at least 44px, dialogs fit the screen, keyboard does not hide the active input on mobile.
- Fix every layout or behavior problem found. Record results in VERIFICATION.md.
```

**You do this on real devices before launch:**

| Check                                    | iPhone (Safari) | Android (Chrome) |
| ---------------------------------------- | --------------- | ---------------- |
| Log in as agent                          | ☐               | ☐                |
| Open My leads and a customer             | ☐               | ☐                |
| Show number, tap to call                 | ☐               | ☐                |
| Log a call after hanging up              | ☐               | ☐                |
| Add follow-up and visit                  | ☐               | ☐                |
| View property pictures                   | ☐               | ☐                |
| Download a document                      | ☐               | ☐                |
| Reminder bell and sign out               | ☐               | ☐                |
| Rotate phone; text fits, nothing cut off | ☐               | ☐                |

---

## After all eight fixes

1. Apply every new migration to the hosted Supabase project in order.
2. Run a 2-week trial with 2–3 agents on real leads.
3. Fix what they report, then roll out to the whole team.
4. Continue with docs/REMAINING_FEATURES.md (fast reassignment, won-deal check, searchable selectors, integrations).
