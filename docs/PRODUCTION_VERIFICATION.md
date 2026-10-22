# Final production-readiness report — 22 October 2026

> **Update 22 October 2026: production-only.** There is no staging environment. The Staging workflow was removed, Production requires a successful CI run of the exact `main` commit, and `deploy/production/workflow_policy.py` enforces this in CI. Staging steps below are historical. Current procedure: [HD_MARKETING_PRODUCTION_DEPLOYMENT.md](../HD_MARKETING_PRODUCTION_DEPLOYMENT.md) and [PROPERTY_INVENTORY_RELEASE.md](PROPERTY_INVENTORY_RELEASE.md).

**Local regression is green. Ready for staging acceptance; live production readiness remains conditional on the deployment gates below.** No commit, push, deployment or production database access occurred.

## Review completed

Reviewed the current application, test and deployment diff, including authenticated identity checks, route-policy placement, rate-limit keys, frontend retry/polling behavior, blue-green release/rollback, environment isolation and CI approval flow. No running review agent or separate review findings artifact was available in this workspace; this is the completed direct source review, not a claimed result from an external review job.

No additional verified functional, security, data-integrity or deployment defect requiring a runtime change was found in this final review. The existing pending changes were preserved. Only the audit, file inventory, rate-limit evidence description and this report were updated during this pass. No new mock authentication system, fake database, fixture, simulation or dependency was added.

The previously confirmed 81 focused tests were not rerun separately. After reviewing the final code, the **complete backend suite ran once and the complete frontend suite ran once**, in that order. Both exited successfully. There were no subsequent application or test-code changes. These results cover the local uncommitted working tree; a future approved commit must pass GitHub CI and staging before release.

## Final verification results

Environment: macOS, Node v24.12.0. Loopback access was authorized for existing HTTP tests. No private environment file was opened, and no live Supabase test was attempted.

| Check | Result and scope |
|---|---|
| `npm run test -w server` | **798 tests passed, 40 files**, Vitest duration 183.75 s; exit 0. |
| `npm run test -w client` | **364 tests passed, 32 files**, Vitest duration 72.08 s; exit 0. |
| Production frontend build | **Passed**, 8.99 s, using explicitly supplied public CI fixture values. This validates compilation/bundling, not production authentication. |
| Backend build/runtime validation | JavaScript has no separate compiler build. Backend tests and `node --check` passed, including production runtime validation. |
| Existing deployment tests | **9 passed**, 25.394 s. Reused the existing tests; no new simulations were created. These test real shell orchestration and temporary-file configuration operations with external commands mocked. |
| Deployment syntax and guards | **Passed** `deploy/production/check.py`: Node/Bash/Python syntax, credential-pattern scan, and forbidden database-command checks in release scripts. |
| PM2 configuration | **Passed** evaluation of all four environment/slot combinations: production 3101/3102 and staging 3201/3202; one API per slot, readiness signal and drain timeout. Invalid environment/slot values were rejected. No actual PM2 daemon was run. |
| GitHub Actions YAML | **Passed** Ruby YAML parsing for all four existing workflows. Source review confirmed manual production dispatch, successful staging SHA evidence, named environments, pinned actions, host-key verification and deployment serialization. GitHub execution/protection settings remain unverified. |
| Real Nginx/PM2 configuration execution | **Pending**: neither binary is installed locally. No real proxy syntax/reload, daemon restart, TLS or traffic-draining result is claimed. Existing Ubuntu CI/VPS checks must pass. |
| Secret checks | The existing limited scanner passed for tracked and unignored files. This is not an exhaustive secret-history audit. No credential values were printed. |
| Whitespace | `git diff --check` passed. |
| Dependencies / database schema | No package manifest, lockfile or Supabase SQL change in the pending diff. The earlier 21 October npm audit reported zero vulnerabilities; advisory lookup was not repeated in this final pass. |
| Hosted Supabase integration | **Pending: staging configuration and credentials not supplied.** Neither `/etc/hd-crm/staging/server.env` nor `smoke.env` is provisioned here; staging smoke email/password are not provided. |

Existing jsdom tests emit two unsupported-navigation diagnostics. They did not fail a test; the complete frontend suite exited 0. No failing test was skipped or weakened during this review.

Raw local evidence (temporary files, not committed):

- `/tmp/hd-final-server-20261022.log`
- `/tmp/hd-final-client-20261022.log`
- `/tmp/hd-final-regression-20261022.json`
- `/tmp/hd-final-build-20261022.log`
- `/tmp/hd-final-deployment-20261022.log`

## What is actually integrated, and what is mocked

- **Local SQL integration:** existing tests execute application SQL/migrations and transactions in PGlite, an embedded PostgreSQL engine. This verifies real SQL behavior in that local environment, including durable login lockout across app instances. Supabase-managed Auth/Storage schemas are represented by test scaffolding; these tests do not validate the hosted provider, PostgREST, email delivery, TLS or cloud configuration.
- **HTTP/component integration with mocked providers:** Supertest exercises real Express middleware/routes, and React Testing Library exercises UI components in jsdom. Supabase token verification/sign-in, provider responses or database adapters are mocked where each fixture specifies. The office tests' JWT-shaped tokens and in-memory provider are existing test helpers, not real signed Supabase sessions.
- **Deployment orchestration tests:** existing Python tests run the actual shell/configuration logic with fake PM2, SSH-related/privileged commands, probes and Nginx/systemctl operations. They verify control flow and rollback decisions, not a real host switch.
- **Real Supabase end-to-end integration:** not run. Actual staging login, authorization/RLS, CRUD, storage, imports/exports, session continuity and deployment behavior remain pending. Do not substitute production credentials to make these tests run.

## Shared office IP: confirmed behavior and limits

**The current policies support 10–15 authenticated users sharing one office IP for the tested workload.** Quotas for ordinary API activity and sensitive actions use the user ID established by the existing Supabase authentication middleware, not the office IP, client-provided identity headers or unverified JWT claims.

The final backend suite includes an existing test where **15 agents perform 45 total call/status mutations in the same minute**, with users operating concurrently from one IP. Every response succeeds; each agent retains **27 of their own 30** sensitive requests. Other existing checks verify that an admin exhausting reporting/export/change/general quotas leaves colleagues' allowances available, and spoofed identity headers cannot select a different quota. These are HTTP tests with mocked Supabase, not a live 15-user cloud load test.

Relevant defaults:

| Policy | Scope | Limit |
|---|---|---|
| General authenticated API | Verified user | 1,000 / 15 min |
| Sensitive actions | Verified user | 30 / minute |
| Reports | Verified user | 300 / 15 min |
| Imports and exports | Separate policy per verified user | 30 / 15 min each |
| Failed login attempts | Client IP | 30 / 15 min; successful sign-ins release this counter |
| Public and unauthenticated traffic | Separate policies per client IP | 300 / 15 min each |
| Nginx API protection | Client IP | 50 requests/s, burst 200; configuration inspected, real behavior not tested |

This is not a promise of no 429s under every workload. One user's excessive activity is intentionally limited. Failed/abusive requests from the same office can exhaust its pre-authentication IP protection; authenticated requests also temporarily count against that guard until authentication finishes. Express counters are process-local and reset on replacement; a retained rollback process keeps its counters. PostgreSQL account lockouts remain durable. CDN/proxy changes need verified client-address configuration before use.

The historical workload table in `RATE_LIMITS.md` was not independently reproduced in this final pass. The concrete current evidence is the passing existing regression described above.

## Remaining launch gates

1. **Staging:** separate Supabase project, schema matching production's reviewed dependencies, synthetic confirmed admin/agent accounts and staging-only credentials. No customer personal information copied to routine staging.
2. **Ubuntu host:** install/test Node 24, PM2, Nginx, restricted deployment users, firewall, private files, verified SSH host keys, DNS and HTTPS renewal. Local configuration evaluation does not certify the server setup.
3. **GitHub approval controls:** configure main branch protection, staging/production environments, production required reviewers/prevent self-review, environment-specific SSH credentials and public build variables. The YAML alone does not enforce reviewer settings that have not been configured in GitHub.
4. **Real acceptance:** validate login/refresh/email, authorized and forbidden reads/writes, CSV/XLS imports, reports/exports, private uploads/downloads, 15-user office activity and meaningful database latency on staging. Rehearse failed readiness, traffic switch, long request/upload drain, old browser tabs and rollback on the actual proxy/process manager.
5. **Recovery and operations:** verify database plus Storage backups, independent encrypted off-site copies, retained stable secrets, a complete isolated restore, one worker per environment, job heartbeats, restart/reboot behavior and received alerts.
6. **Existing data-integrity limits:** import transactions and unique phone protection exist, but retrying after a lost response can create another import-batch record; universal stale-edit conflict rejection is absent. Review Imported Files/audit history before retrying uncertain work. Resolve stricter exactly-once or conflict-detection requirements through a separately reviewed change, not an automatic deployment migration.

No release script resets, seeds, migrates or restores production Supabase. Automatic application rollback is only suitable for backward-compatible code/schema/worker changes. No absolute zero-downtime guarantee is made.

## Exact next deployment steps — owner authorization required

These are future operator actions; none was performed in this review. Follow `HD_MARKETING_PRODUCTION_DEPLOYMENT.md` for the full matching commands.

1. **Authorize the eventual commit/push separately.** The current tested changes remain uncommitted. Once approved, commit them to a feature branch and require CI review before merging to main. Do not release a SHA that excludes this working tree.
2. **Provision infrastructure using guide sections 2–7.** Create the Ubuntu host/users, install the reviewed root switch helper and Nginx templates, configure the two domains/certificates, private environment files and verified SSH keys. Keep production connected to the existing Sydney Supabase project.
3. **Provision separate staging and its real smoke credentials.** Configure `/etc/hd-crm/staging/server.env` and `/etc/hd-crm/staging/smoke.env` with root ownership, crm-stage group and mode 640. The latter contains only the staging synthetic admin's `STAGING_SMOKE_EMAIL` and `STAGING_SMOKE_PASSWORD`. Set environment-specific GitHub variables/secrets listed in guide section 8.
4. **Run the main/staging workflow after the authorized merge.** On Ubuntu, require `sudo nginx -t` and the existing `python3 deploy/production/check-nginx.py` to pass before accepting the proxy setup. The workflow checks the candidate and runs the real staging smoke script before switching traffic. Start the one staging worker as documented and complete the acceptance cases above.
5. **Confirm backups, recovery and compatible schema/worker behavior.** Record the successful staging run and its full 40-character commit SHA. No migration is automatically applied by the application workflow.
6. **Only after explicit production approval**, run the Production workflow on main with that exact successful staging SHA, then obtain the protected-environment review. Check public HTTPS, existing sessions, API logs and job heartbeats. Start/update the single production worker separately after compatibility review. Retain the old API throughout the agreed rollback window.
7. **If rollback is needed**, as crm-prod with a healthy compatible retained previous release:

   ```sh
   cd /srv/hd-crm/production
   read -r current_slot current_sha < active
   bash "releases/$current_sha/deploy/production/release.sh" rollback production
   ```

   This changes application traffic only. Do not restore the database to reverse an application release; follow the guide's separate approved recovery procedure if database recovery is actually necessary.

**Final disposition:** 1,162 application tests and nine existing deployment tests passed. Local review/regression/build work is finished. Further runtime changes and repeat testing are stopped; remaining work is infrastructure provisioning and real staging/production acceptance under the owner's authorization.
