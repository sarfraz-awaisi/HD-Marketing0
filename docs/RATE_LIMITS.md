# API rate limits

Updated 22 October 2026. Code: `server/src/middleware/rateLimit.js` (policy table and limiters), wired in `server/src/app.js` and the route files. Tests: `server/tests/api-rate-limits.test.js` and `server/tests/rate-limit-deployment.test.js`.

## What changed and why

The 20 October change counted general signed-in traffic per user, but every "sensitive" route still shared **one 30-per-minute counter per IP address**. Lead status changes, call logs, follow-up, visit and deal edits, phone numbers, KYC downloads, bulk assignment, imports, account administration and attendance requests all drew from it. An office of 15 people behind one public IP therefore shared 30 such actions a minute. Sign-in counted successful sign-ins against the office's 30 attempts, password reset shared that allowance, and authenticator codes were limited per IP.

Now:

- Every limit for signed-in requests counts **per user**, using the identity Supabase verified (`auth()`), never a header, body or unverified token claim. One person's activity, an admin's included, never uses another person's allowance.
- Requests made before anyone has signed in count **per client IP**.
- Sign-in counts **only refused attempts**, so colleagues signing in from one office do not use the allowance. Password reset has its own stricter limit.
- Imports, exports and heavy reports have their own per-user limits, in addition to the existing ones. No existing protection was removed.
- Every limit can be changed with an environment variable. Values are checked at startup: a value that is not a whole number from 1 to 100000 stops the API from starting, and therefore stops a release before traffic switches. Limiting cannot be switched off.
- A refusal is HTTP 429 with JSON `{ error, request_id }`, `Retry-After`, and draft-8 `RateLimit` / `RateLimit-Policy` headers naming the policy.

## Policies and production defaults

| Policy            | Counted per    | Default       | Applies to                                                                                                                                                                                                                                          | Variable                                 |
| ----------------- | -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `perUser`         | signed-in user | 1000 / 15 min | every signed-in API request                                                                                                                                                                                                                         | `RATE_LIMIT_USER_PER_15_MIN`             |
| `sensitive`       | signed-in user | 30 / 1 min    | lead, call, follow-up, visit and deal edits; call logging; phone numbers; KYC downloads; bulk assignment, deletion and restore; imports; account administration; attendance requests, reviews and export; Meta configuration; target copy and edits | `RATE_LIMIT_SENSITIVE_PER_MIN`           |
| `reports`         | signed-in user | 300 / 15 min  | Overview dashboard, reports, report tabs, leaderboard, admin attendance views, Meta report, "select all matching" lead selection                                                                                                                    | `RATE_LIMIT_REPORTS_PER_15_MIN`          |
| `exports`         | signed-in user | 30 / 15 min   | report CSV exports, attendance export                                                                                                                                                                                                               | `RATE_LIMIT_EXPORTS_PER_15_MIN`          |
| `imports`         | signed-in user | 30 / 15 min   | CSV/XLS lead imports (1,000 rows each)                                                                                                                                                                                                              | `RATE_LIMIT_IMPORTS_PER_15_MIN`          |
| `accountCreation` | signed-in user | 20 / 15 min   | creating accounts (PIN-protected)                                                                                                                                                                                                                   | `RATE_LIMIT_ACCOUNT_CREATION_PER_15_MIN` |
| `accountSecurity` | signed-in user | 10 / 15 min   | Accounts PIN, email codes, invitations, verification email (unchanged)                                                                                                                                                                              | `RATE_LIMIT_ACCOUNT_SECURITY_PER_15_MIN` |
| `mfaVerify`       | signed-in user | 10 / 15 min   | authenticator code verification (was 30 per IP)                                                                                                                                                                                                     | `RATE_LIMIT_MFA_VERIFY_PER_15_MIN`       |
| `onboarding`      | invited user   | 20 / 15 min   | invitation set-up, after Supabase verifies the invitation session                                                                                                                                                                                   | `RATE_LIMIT_ONBOARDING_PER_15_MIN`       |
| `unauthenticated` | client IP      | 300 / 15 min  | requests that fail sign-in checks (no, invalid or expired token; disabled account; two-factor pending)                                                                                                                                              | `RATE_LIMIT_UNAUTHENTICATED_PER_15_MIN`  |
| `public`          | client IP      | 300 / 15 min  | all sign-in and invitation routes                                                                                                                                                                                                                   | `RATE_LIMIT_PUBLIC_PER_15_MIN`           |
| `login`           | client IP      | 30 / 15 min   | refused sign-ins (wrong password, locked, invalid)                                                                                                                                                                                                  | `RATE_LIMIT_LOGIN_FAILURES_PER_15_MIN`   |
| `passwordReset`   | client IP      | 5 / 15 min    | password reset requests                                                                                                                                                                                                                             | `RATE_LIMIT_PASSWORD_RESET_PER_15_MIN`   |
| `callbacks`       | client IP      | 30 / 1 min    | call-provider webhooks, Meta sign-in callback                                                                                                                                                                                                       | `RATE_LIMIT_CALLBACKS_PER_MIN`           |
| `metaWebhook`     | client IP      | 1200 / 1 min  | Meta lead webhooks (unchanged)                                                                                                                                                                                                                      | `RATE_LIMIT_META_WEBHOOK_PER_MIN`        |

Searches count only against `perUser`: lead and property search use trigram indexes (update 027, see `PERFORMANCE.md`) and the browser waits for typing to pause.

The security boundaries that matter most are enforced by PostgreSQL, per account, in every process and across restarts: sign-in lockout after 5 wrong passwords (`LOGIN_*`), at most 5 failed or 10 authenticator attempts per 15 minutes, the Accounts PIN lockout, email-code attempt and send quotas, and the daily phone-number reveal limit. The limits above are a first layer that sheds load and slows abuse.

## How the defaults were chosen

The busiest user in each case should stay at about a third of every limit or less. The previously recorded numbers below come from replaying the browser client's request pattern against the real Express app with a **mocked Supabase adapter**, not a real database: a **simulation, not a production measurement**. The final 22 October review did not rerun or independently reproduce this workload table; its current evidence is the existing full regression suite, including the 15-agent quota-isolation test. All 15 users shared one IP:

| Workload                                                                                       | Requests / min (mean, max)  | Busiest user's share                                             | 429s before → after                    |
| ---------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Working half hour, 2 admins + 13 agents                                                        | 185, 219                    | `perUser` 23%, `sensitive` 13%, `reports` 10%                    | 0 → 0 (office counter peaked at 27/30) |
| First-call rush: admin imports and bulk-assigns, agents call new leads back to back            | 190, 257                    | `sensitive` 47% (admin distributing to 13 agents), `perUser` 24% | 42 → 0                                 |
| Peak: everyone signs in, opens the Overview in the same second, saves 10 changes in one minute | 335, 667 (67 in one second) | `sensitive` 33%, `login` 20%, `perUser` 18%                      | 118 → 0                                |

The old browser code, which keeps running in open tabs until they reload, sent 7–18% more requests in these workloads (with a second tab open for everyone). It stays within the same limits.

## Client addresses behind Nginx

- Nginx sets `X-Forwarded-For` to the connecting address (`$remote_addr`). The API trusts only the loopback proxy (`TRUST_PROXY=loopback`), so `req.ip` is that address. Forged `X-Forwarded-For` hops, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` and identity headers change nothing. IPv6 clients are grouped by /56.
- **If a CDN or another proxy is ever placed in front of Nginx**, configure Nginx's `real_ip` module with that provider's published address ranges first. Otherwise every visitor appears as the CDN's addresses and the per-IP limits group unrelated people.
- The Nginx zone `crm_api` (50 requests/s, burst 200, per address) is far above the simulated office peak of 67 requests in one second.

## PM2, blue-green slots and Redis

- Counts live in the API process. Each environment has one active PM2 slot, so counts are exact while it runs.
- A newly started slot (deploy, restart or rollback target) starts counting from zero. A rollback returns traffic to the retained process, which still has its counts. While both slots serve during an Nginx reload, a user can get at most one allowance per slot.
- The durable PostgreSQL limits above, and the Nginx zone in shared memory, carry over every switch.
- **Redis is not needed** for one active API process serving 10–15 people. A reset at each deploy grants at most one extra window, and the security-critical limits are already durable. A shared store becomes necessary only if one environment runs several active API processes at the same time (PM2 cluster mode or more servers). It would then add a service to run, secure and back up: self-hosted on the KVM costs memory and maintenance, and a managed service is a monthly fee. Check current prices before deciding.

## Changing a limit

Edit `/etc/hd-crm/<environment>/server.env` (or the root `.env` locally), then deploy or restart the API. Raise a limit only with evidence of legitimate 429s: each refusal names its policy in the `RateLimit` header and the error message. Example: an admin importing a backlog of more than about 25 files in 15 minutes may temporarily raise `RATE_LIMIT_IMPORTS_PER_15_MIN`.

## Known limits

- Per-IP limits apply before sign-in. Someone on the office network who keeps entering wrong passwords can use up that network's sign-in allowance for up to 15 minutes. Each account's lockout is separate and applies from any network.
- The `unauthenticated` limit counts every request until it finishes, then releases those that proved who they are. A burst of slow requests from one office briefly holds part of it: 54 of 300 in the peak simulation with 40–120 ms of database latency per call.
- The Vercel entry point (`api/index.js`) counts per serverless instance.
- Not verified against real Supabase or a real Nginx/PM2 host. There is no staging environment; this is checked after a production release.
