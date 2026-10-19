# Loading performance

Implemented 14 October 2026. These changes improve both portals without changing the customer fields, assignments or login policy.

## Install on the existing CRM

Restart the updated API and frontend. In the project terminal:

```sh
npm run dev
```

If the existing development server is still running, stop it in its own terminal with Control-C before restarting. Use the existing project directory and port; starting a second instance causes the occupied-port error.

For the database improvements, apply **027_loading_performance.sql once after migrations through 026**, in the Supabase project already used by this CRM. Copy the SQL from the project terminal:

```sh
pbcopy < supabase/migrations/027_loading_performance.sql
```

Paste into a new Supabase SQL Editor query, run the SQL, then reload the CRM. The expected result is `Success. No rows returned`. Do not run the fresh-project `setup.sql` on the existing database. Earlier migrations and customer data are preserved. The new indexes use normal transactional creation; on a large live database, schedule installation during a quiet period because index creation can hold writes.

The frontend works before 027 is installed: the dashboard falls back to the previous authorized database readers and property cards retain their existing photo requests. This upgrade does not create a login prerequisite. Monitoring continues to check its schema contract at version 26; administrator MFA remains removed. No hosted migration has been applied by this work.

If reverting the application code, leave the additive performance indexes/readers installed. They remain compatible with the earlier routes; rollback does not require deleting customer data or running the fresh-project setup.

## Changes

| Area              | Result                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard         | One `/api/dashboard` request replaces the separate reports, leaderboard, activity and target requests. Migration 027 returns that data in one database RPC. Admins no longer fetch unused personal targets.                                                            |
| Property cards    | `covers=true` batches cover metadata and signs all requested covers together. An eight-card page uses one property request rather than one property request plus eight photo requests. Opening a property still fetches its complete gallery.                          |
| Search            | Leads, imported files, properties, documents and social inbox search wait 250 ms after typing stops. Changed list queries cancel obsolete requests. Filters remain immediate.                                                                                          |
| Saves             | Lead/activity updates invalidate the related workspace queries without refetching unrelated property photos, PIN settings or system status. Property photo changes also refresh card covers.                                                                           |
| Authentication    | Only overlapping identical native Auth calls share an in-flight request. Completed results are discarded; every API request still reads the current active profile and saved role. Profile and signed-claim reads run concurrently after native identity verification. |
| Frontend download | The browser imports Supabase's native Auth client directly, preserving the existing session key, refresh, invitation and isolated portal login behavior. Unused database, Storage, Functions and Realtime clients are omitted from the browser bundle.                 |
| Navigation        | Hovering or focusing a sidebar link starts loading its page code. This does not fetch customer records; data-saving/slow connections skip this prefetch.                                                                                                               |
| Rendering         | Currency/date formatters are reused. Google font loading moves out of blocking CSS and into idle loading with system-font fallback. Images retain lazy loading and asynchronous decoding.                                                                              |
| Database          | Sixteen indexes cover substring searches, owner/file pagination, activity history, completed call ranges, pending reminders and property images. Leaderboard totals use grouped counts instead of count subqueries for each active agent.                              |

The dashboard and covers RPCs are service-role-only and recheck active profiles. Activity visibility follows current lead ownership. Phone reads, audit recording, invitations, PIN controls and optional-agent MFA remain enforced. No server response cache or persistent customer query cache was introduced. Browser query freshness remains 15 seconds; account changes, role changes, sign-out, denied access and MFA gating clear workspace caches.

## Verification and measurement

The initial JavaScript entry decreased from **686.10 KB to 465.72 KB** (32.1% smaller); gzip decreased from 203.79 KB to 146.91 KB (27.9%). This measures the initial entry, not the total of all lazy page chunks.

On the isolated fixture below:

| Query                 | Before 027 | After 027 | Comparison            |
| --------------------- | ---------- | --------- | --------------------- |
| Substring lead search | 54.103 ms  | 0.744 ms  | 72.72× faster         |
| Leaderboard           | 134.324 ms | 59.611 ms | 2.25× faster          |
| Assigned lead page    | 1.231 ms   | 1.146 ms  | Similar at about 1 ms |

The search plan changes from a sequential scan of 50,000 rows to the trigram index. The assigned-page planner still chooses the existing creation-date index on this uniformly distributed fixture; it already answers quickly. New ownership indexes provide another plan for other distributions. No planner settings were forced. Leaderboard outputs match before/after. The [recorded benchmark and plans](performance-benchmark.json) contain synthetic data only.

See the current entry in `VERIFICATION.md` for final test/build counts, browser checks and measured synthetic query timings. Build comparisons use the same empty-environment local configuration, not hosted production credentials. The initial entry is smaller; route chunks still download as needed, so total application code is not reduced by the same percentage.

Reproduce the database benchmark without any environment file or hosted access:

```sh
node scripts/benchmark-performance.js
```

It creates an isolated PostgreSQL-compatible PGlite database, applies migrations through 026, seeds 50,000 synthetic leads, 100,000 calls and 40 agents, then compares warm query medians before/after 027. Nine samples follow one warmup; the output includes actual `EXPLAIN ANALYZE` plans. Old/new leaderboard results must match. Run without competing CPU-heavy tests for useful timings. These measurements characterize the fixture; internet latency, database size, Supabase compute and device speed still affect live load times.

The index choices follow [Supabase query optimization guidance](https://supabase.com/docs/guides/database/query-optimization) and PostgreSQL's support for indexed substring matching in [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html). Browser freshness and cancellation follow the installed TanStack Query behavior documented in its [defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) and [cancellation guide](https://github.com/TanStack/query/blob/main/docs/framework/react/guides/query-cancellation.md).

## Faster request checks and startup chunks (17 October 2026)

Measured from the development machine, every request to the connected Supabase project takes about 350–400 ms, so the number of sequential trips per API call dominates loading time.

- **Parallel security checks.** Each API request used to verify the login token with Supabase first, and only then read the profile and token claims; agents then also waited for their two-factor state. The server now starts the profile and claim reads at the same time as token verification; an agent's two-factor state is still read only after all three are verified. It uses the user id inside the token only to start those reads. Their results are used only after Supabase confirms the token belongs to that same user; otherwise they are discarded and repeated for the verified user. Expired or malformed tokens skip the early reads. Every request is still fully rechecked and nothing is cached between requests. Admin requests drop from two sequential trips to one (about 400 ms faster) and agent requests from three to two.
- **Startup chunks.** React, Supabase Auth, form validation and the data cache now load as separate long-cached files. The app's own startup file shrank from 828 KB to about 92 KB, so an app update no longer forces browsers to download the libraries again. Libraries used only by lazy pages stay with those pages, and no chunk exceeds the 500 KB warning size.
- **Region.** For a live deployment, run the API in the same region as the Supabase project, and choose a Supabase region near your users. Network distance adds to every request.
