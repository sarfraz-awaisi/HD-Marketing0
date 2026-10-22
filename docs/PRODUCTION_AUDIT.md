# HD Marketing CRM production audit

> **Update 22 October 2026: production-only.** There is no staging environment. The Staging workflow was removed, Production requires a successful CI run of the exact `main` commit, and `deploy/production/workflow_policy.py` enforces this in CI. Staging steps below are historical. Current procedure: [HD_MARKETING_PRODUCTION_DEPLOYMENT.md](../HD_MARKETING_PRODUCTION_DEPLOYMENT.md) and [PROPERTY_INVENTORY_RELEASE.md](PROPERTY_INVENTORY_RELEASE.md).

Initial architecture audit: 2026-10-21. Final diff review: 2026-10-22; see PRODUCTION_VERIFICATION.md for the final regression and remaining deployment gates. Repository inspected locally on 2026-10-21 before implementation. Initial working tree was clean. The repository root is `hd-marketing-crm`; its parent contains historical backup copies, not deployable workspaces. Only `main` and `origin/main` were visible locally; remote branch/protection settings were not queried. No AGENTS.md was found. No production systems or private environment contents were accessed.

## Architecture and evidence

- npm workspaces: `client` and `server`. React 19, React Router, React Query, Vite 7; no Next.js. Vite binds 127.0.0.1:5173 and proxies `/api` to 3001. Production frontend is `client/dist`.
- Express 5 entry `server/src/index.js`, app factory `server/src/app.js`, binds loopback port 3001 by default. JavaScript needs no backend compilation: syntax checks, runtime validation and integration tests validate it.
- Browser uses Supabase AuthClient with persistent/refreshable browser storage and bearer API tokens, not authentication cookies. API verifies Supabase identity, email confirmation and active profile; roles and RPC actor/ownership checks protect privileged operations. Admin login currently does not require MFA; optional/enrolled agent MFA is enforced. This policy is preserved.
- Server service-role client has no persisted auth session. Browser has public Auth access only; private schemas, restricted grants, RLS and security-definer RPCs implement database boundaries. Privileged server credentials remain outside releases.
- Main CRM router composes account/security/sales/attendance/document routers; other mounted endpoints include auth, onboarding, MFA, Meta callbacks/webhooks and admin health. Legacy route modules sometimes re-export the main router; they are not separate services.
- CSV/XLS/XLSX imports: 5 MiB in-memory upload, 1,000 rows, bounded columns, magic-byte checks for Excel, formulas rejected, normalized phone uniqueness. `import_leads` uses an advisory transaction lock and one database transaction with per-row rejection results. Duplicate retries cannot create duplicate phone records, but can create a second import batch. Assignments and several edits use SQL locks. General edits do not implement a universal expected-version comparison; concurrent updates can be last-writer-wins.
- Property and document files use private Supabase Storage with reservation/cleanup flows; document limit is 10 MiB. Local API disk is not durable customer storage. Nginx may temporarily buffer uploads; its disk and permissions matter. Original source uploads are not a durable resumable import queue.
- Separate `server/src/jobs/runner.js` runs recording retention, ownership alerts, lead response checks, reminders, missing outcomes, photo/document cleanup, Meta ingestion and attendance reconciliation, plus deleted-lead purge. Some SQL jobs have locks/idempotency, but no universal distributed singleton. Never start jobs in both API slots. No application WebSocket or SSE server was found; browser periodic fetches are ordinary HTTP.
- Helmet, exact-origin CORS, loopback proxy trust, input validation, generic 500 messages, request IDs and audit logs already exist. Login database lockout is durable. Express rate-limit counters are process-local: signed-in limits per verified user (1,000 per 15 minutes overall, sensitive actions 30/minute, plus report, export, import, account and authenticator limits) and per-IP limits before sign-in (refused sign-ins 30, password reset 5, unauthenticated and public routes 300 per 15 minutes). Details and measurements: `docs/RATE_LIMITS.md`. Counts reset across new processes; this remains a limitation. Nginx shared-memory IP limiting adds continuity but does not replace per-user counters.
- Existing tests cover SQL via in-memory PGlite, mocked providers, HTTP via Supertest, and client behavior via Vitest/jsdom. `npm test` runs server then client; `npm run build` builds the frontend. Test configs disable automatic .env loading. Existing production helpers use Caddy and a single API; new Nginx instructions supersede that route, without deleting legacy material.
- Existing encrypted database/object backups are retained. Database backup code records status and prunes older encrypted archives; it is not part of application releases and was not run. Existing `setup.sql`, seed, repair and cleanup SQL include writes and must never be run indiscriminately on production.

## Database relationships and migration boundaries

The 001–040 migration series is historical, not proof of the installed cloud state. `profiles` links Auth users to roles; leads depend on profiles, private phone records, import batches and properties. Calls, notes, assignments, followups, visits, deals and status history depend on leads. Properties own photo metadata; knowledge documents own file metadata; cleanup queues reconcile Storage. Attendance references employee profiles and policy periods. Security/account tables reference profiles; audit history spans actions. Meta tables retain submissions and encrypted private credentials. `crm_schema_versions` reports the legacy value 26 even after later migrations: it is not a complete migration ledger.

SQL table inventory (including historical definitions; verify actual schema separately):

- `crm_private.account_deletions`
- `crm_private.account_uid_review`
- `crm_private.lead_phones`
- `crm_private.lead_purge_runs`
- `crm_private.lead_recording_cleanup`
- `crm_private.login_attempts`
- `crm_private.meta_answers`
- `crm_private.meta_credentials`
- `crm_private.meta_oauth_states`
- `crm_private.meta_page_credentials`
- `crm_private.mfa_attempts`
- `crm_private.mfa_resets`
- `crm_private.phone_reveals`
- `crm_private.recordings`
- `public.account_creation_events`
- `public.account_creation_requests`
- `public.account_invitations`
- `public.account_provisioning`
- `public.account_security`
- `public.account_unlocks`
- `public.assignments`
- `public.attendance_corrections`
- `public.attendance_holidays`
- `public.attendance_leave_requests`
- `public.attendance_periods`
- `public.attendance_policies`
- `public.attendance_records`
- `public.audit_log`
- `public.backups`
- `public.calls`
- `public.crm_schema_versions`
- `public.crm_settings`
- `public.deals`
- `public.followups`
- `public.integration_events`
- `public.job_heartbeats`
- `public.knowledge_documents`
- `public.knowledge_file_cleanup`
- `public.knowledge_files`
- `public.lead_imports`
- `public.lead_status_history`
- `public.leads`
- `public.login_events`
- `public.meta_connections`
- `public.meta_forms`
- `public.meta_notice_reads`
- `public.meta_pages`
- `public.meta_submissions`
- `public.notes`
- `public.notifications`
- `public.profiles`
- `public.properties`
- `public.property_photo_cleanup`
- `public.property_photos`
- `public.reminders`
- `public.security_alerts`
- `public.targets`
- `public.visits`

## Environment inventory

Root `.env.example` remains the complete operational template, including destructured settings not visible as direct `process.env.NAME` references: SMTP/Resend OTP settings, login thresholds, Meta encryption/app/version/callback settings, development account setup values and public browser values. New examples distinguish staging from existing Sydney production. Backup credentials belong in a separate owner-readable file and never CI/browser variables. Never rotate stable PIN/OTP/Meta secrets during an application deployment.

Direct environment references inventoried from application sources:

`ACCOUNTS_PIN_PEPPER`, `CALL_PROVIDER`, `CRM_BLOCKED_EMAIL_DOMAINS`, `CRM_INVITATION_TTL_MINUTES`, `FRONTEND_URL`, `JOB_INTERVAL_SECONDS`, `LEAD_DELETE_RETENTION_DAYS`, `META_ANSWER_RETENTION_DAYS`, `NODE_ENV`, `OUTCOME_GRACE_MINUTES`, `PHONE_REVEAL_DAILY_LIMIT`, `PORT`, `RECORDING_RETENTION_DAYS`, `REQUIRE_AGENT_MFA`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TRUST_PROXY`, `VITE_API_URL`, `VITE_IDLE_TIMEOUT_MINUTES`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `WEBHOOK_SECRET`

## Readiness decisions and unresolved launch gates

| Risk | Preparation | Remaining acceptance work |
|---|---|---|
| Abrupt request termination | Graceful API drain; 300-second deadline; old process retained | Real upload and slow-request switch tests; timeouts cannot guarantee arbitrary-length work |
| Missing old frontend chunks | Shared immutable assets retained across releases | Retention policy and old-tab browser rehearsal |
| Duplicate jobs | Separate singleton worker, serial timer and graceful stop | Exactly one worker across VPS, cron, old laptop and any legacy host; never run local dev jobs against production |
| Bad candidate | DB-read readiness, exact release header, staging auth smoke, Nginx syntax/reload rollback | Real HTTPS, full authenticated user journeys and workload tests |
| Schema incompatibility | No SQL in release scripts; expand/contract procedure | Inventory actual schema; explicit migration review; backward compatibility approval |
| Import retry ambiguity | Existing transaction and phone uniqueness preserved; no proxy retry of mutations | Check Imported Files before retry; durable operation-result idempotency would need a separately reviewed migration |
| Concurrent edits | Existing DB transactions/locks preserved | Same-field stale edits remain last-writer-wins; reviewed optimistic locking needed if strict conflict detection is required |
| Per-process rate counters | Existing limits retained; shared Nginx IP limiter added | User limits reset on replacement; a shared store is needed for strict continuous per-user quotas |
| Single VPS failure | PM2 restart, backups, retained releases | This is not HA; host/network failure interrupts service |
| Protected deployment approval | Manual production workflow and named environment | Owner must enable required reviewers/prevent self-review and confirm plan supports them |
| Staging isolation | Separate Unix users, roots, ports, keys, Supabase and synthetic account | Separate VPS preferred; shared CPU/disk/network is not strong host isolation |
| Backup recovery | Existing encrypted backup tools and restore instructions | Off-site retention, verified complete restore, RPO/RTO measurement |

No schema or existing data was changed. Production readiness is conditional on these acceptance gates; this repository preparation is not a claim of verified zero downtime.
