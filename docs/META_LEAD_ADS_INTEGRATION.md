# Facebook and Instagram Instant Form integration

Implemented in the existing HD Marketing CRM on 14 October 2026. This guide describes code and isolated tests, not a connected advertising account. No real Meta credentials, hosted database changes, paid ads or live lead retrieval were used during development. Your chosen capture destination is **Facebook/Instagram Instant Forms**.

## Flow and permissions

Instant Form → signed Page webhook → durable PostgreSQL submission → background Graph API retrieval → existing protected CRM customer creation → admin-only unassigned inbox → explicit administrator assignment → current assigned agent.

New customers have `assigned_agent = NULL` and `meta_pending_assignment = true`. The database refuses first round-robin assignment, job assignment and direct ownership changes. The stale-lead job excludes pending social leads. Explicit assignment uses the existing assignment/history/pending-work transfer functions, then clears the pending flag. Existing manual/import behavior and later reassignment remain available. No campaign/form default-agent option is introduced.

All integration screens and API readers require an active, email-confirmed administrator. Agents cannot fetch configuration, summaries, inbox rows, private answers or assignment actions. Browser database roles cannot read the new tables or execute the new functions. Assigned agents use the existing My leads/customer screens and audited full-contact access. The integration submission and its custom answers remain admin-only even after assignment.

This captures Instant Forms, including Instagram placements supported by Meta. External website forms need a separate website integration. WhatsApp, Messenger, Instagram messages, calling, chatbots and outbound messaging are outside this implementation.

## Installation on an existing database

1. Back up the CRM database and private credentials before upgrading. Verify the Supabase project matches the running CRM.
2. Apply any missing migrations in filename order through **023**. Then apply **`supabase/migrations/024_meta_lead_ads.sql` once**. It is transactional and does not reset/delete customer data or seed social customers. Previously applied 001–023 files were preserved.
3. On macOS, from the project directory, copy the new SQL with `pbcopy < supabase/migrations/024_meta_lead_ads.sql`, paste into Supabase SQL Editor and run the complete file. A successful execution may say “Success. No rows returned”. Do not paste terminal commands or prose into SQL Editor.
4. Restart the API, client and job runner after configuring server settings. Test the existing login, PIN/accounts, lead import, file assignment and agent access before connecting Meta.

For a fresh database only, the regenerated `supabase/setup.sql` includes all **24** migrations and the existing optional property seed. Never run the fresh setup or a reset on an existing database. Do not expose `crm_private` through Supabase Data API.

New public tables: `meta_connections`, `meta_pages`, `meta_forms`, `meta_submissions`, `meta_notice_reads`. Private tables: `meta_credentials`, `meta_page_credentials`, `meta_oauth_states`, `meta_answers`. Public tables have RLS enabled and browser privileges revoked; reads go through the authorized server. `integration_events` is reused for provider event identity. Existing leads gain one pending-first-assignment boolean and an index. Existing phone identity, assignment, activity and audit tables are reused.

## Server configuration

Use the root server environment or a production secret manager. `.env.example` contains blank placeholders. **Do not put these values in `VITE_*`, client files, source control, screenshots or chat.**

| Variable                          | Purpose                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `META_APP_ID`                     | Numeric Meta developer App ID                                                        |
| `META_APP_SECRET`                 | App secret for webhook HMAC, token exchange and app-secret proof                     |
| `META_LOGIN_CONFIG_ID`            | Numeric Facebook Login for Business configuration ID                                 |
| `META_GRAPH_VERSION`              | Explicit currently supported version selected in your App Dashboard, in `vNN.0` form |
| `META_OAUTH_REDIRECT_URL`         | Exact public HTTPS `/api/integrations/meta/callback` URL; no query/hash              |
| `META_WEBHOOK_VERIFY_TOKEN`       | Private random token you also enter in the Page webhook setup                        |
| `META_TOKEN_ENCRYPTION_KEY`       | Stable independent random 32-byte key encoded as 64 hexadecimal characters           |
| `META_ANSWER_RETENTION_DAYS`      | Private answers/review data lifetime, integer 1–90; default 30                       |
| `FRONTEND_URL`                    | Public CRM origin; HTTPS in production; callbacks redirect only to this fixed origin |
| Existing Supabase server settings | Existing server-only database/service credentials                                    |

Generate the encryption key locally using a trusted random generator, for example `openssl rand -hex 32`, and store it privately. Back it up securely. Losing/changing it makes saved tokens unreadable; reconnect every affected account. App secret and encryption key have separate purposes. An App secret rotation also requires review of Meta configuration. There is no automatic key rotation or token renewal.

The webhook address is derived from your deployed public CRM origin: `https://YOUR-CRM-DOMAIN/api/integrations/meta/webhook`. No separate URL variable is needed for the receiver. The OAuth callback is configured explicitly. Without complete Meta configuration the UI says it is not configured, connection controls are disabled, the worker skips ingestion, and other CRM modules remain usable. Retention cleanup still runs if credentials are later removed.

## Meta developer setup before real acceptance

Create/select the Meta business app and the lead-capture use case supported by your account. Configure **Facebook Login for Business** with the authorization-code response used here and a user access token compatible with `/me/accounts`. Set the exact valid OAuth redirect URI above. Use a supported Graph version from that app; the fixture test version is not a claim about the latest production version.

The code verifies these baseline granted permissions before saving authorization:

- `leads_retrieval`: retrieve submitted lead answers.
- `pages_show_list`: discover Pages accessible to the authorizing user.
- `pages_read_engagement` and `pages_manage_ads`: lead/Page access dependencies for this workflow.
- `pages_manage_metadata`: subscribe and inspect the app's Page `leadgen` subscription.

Select only permissions justified by this workflow and any dependencies required by Meta for your chosen use case, app access level and Graph version. `ads_read`, `ads_management`, `business_management` or Ads Management access may be dependencies in your App Dashboard; the CRM does not request arbitrary extra scopes in its OAuth URL. The Business Login configuration controls the grant. Associated Instagram identity is optional and no Instagram messaging scope is requested. A missing association does not prevent lead-platform attribution.

**Permission verification limitation:** Meta's public permissions/retrieval documentation returned HTTP 429 during this audit. The official Meta SDK and Meta-owned retrieval checklist were readable and used to verify lead fields, Page/form edges, subscriptions, time filtering and test procedures. Current permission dependencies, Business Login availability, Advanced Access/App Review, business verification and Page Lead Access Manager requirements still need confirmation in your own App Dashboard before production acceptance. Baseline scope checks alone do not prove endpoint access. Do not add broad unrelated permissions to suppress an error.

For production users outside app roles, complete the required review/access/verification process. Ensure the authorizing person has appropriate Page tasks and lead access, and assign the CRM/app the required lead access in the business account. Development mode and app-role tests are not evidence that live advertisers can connect.

Official references:

- [Meta-owned leads retrieval setup/checker](https://github.com/facebookincubator/catalogue-of-api-solutions/blob/main/solutions/leads/leads-retrieval-set-up-checker.md)
- [Meta Business SDK Lead fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/lead.py)
- [Meta Business SDK Page edges](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py)
- [Meta Business SDK LeadgenForm](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/leadgenform.py)
- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/)
- [Lead retrieval guide](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/)
- [Permissions reference](https://developers.facebook.com/docs/permissions/)
- [Page webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages)

## Connect Pages and forms

1. Sign into the **Admin** portal and open **Integrations → Meta Lead Ads**.
2. Choose Connect / reconnect Meta, authorize the configured business app, and select the Pages you manage. OAuth state is random, hashed in SQL, tied to a secure HttpOnly SameSite cookie, expires after ten minutes and is consumed once. Administrator activity is rechecked at callback.
3. Tokens are exchanged and validated on the server. Accessible Pages are discovered; available Instagram business identity is displayed. User/Page tokens are encrypted with AES-256-GCM and context binding in the private schema. No token is returned to React.
4. For each Page, refresh forms, map custom questions and enable the intended forms. Activate the Page to install/verify `leadgen` on that Page's subscription. Both Page and form must be enabled for ingestion. Existing unrelated subscription fields are preserved.
5. The **Meta app's own Page webhook product subscription** must also be configured in the Meta dashboard. Page activation does not create that app-level setup. Use the public GET/POST webhook URL above and the private verification token. Select the Page `leadgen` field.
6. Keep `npm run jobs` running as a supervised service, alongside the API and frontend. It claims up to ten due submissions per tick. Default existing interval is 60 seconds, with an effective minimum of ten seconds. A worker is required; starting only the frontend/API does not process queued submissions. Each maintenance job handles its own failure so a Storage cleanup error cannot starve Meta ingestion or retention cleanup.

A reconnect replaces credentials and pauses all Pages from that authorization. Explicitly reselect/activate authorized Pages afterward. This prevents stale Page grants from silently continuing. Multiple Pages are supported; an already-connected Page cannot be silently transferred to a different provider authorization. Page discovery and form discovery each stop at five pages of 100 results and report truncation for form discovery.

Pause Page stops local ingestion first, even if remote subscription removal fails; the UI reports any remote-removal warning. Pause form affects only that form. Queued work stays durable while synchronization is paused. Disconnect stops local synchronization and removes saved credentials while retaining customers/submission history. It does not revoke your whole Meta business grant; remove the app in Meta Business Integrations if needed. Other integration modules are unaffected.

## Incoming leads and manual assignment

**Incoming social leads** shows real submission totals, pending new customers, Facebook/Instagram counts, review items, assignments today, repeat inquiries and processing failures. Filters cover search, platform, processing state, date range, campaign/form IDs, assignment and sorting. Results are counted after filtering and paginated at 20 per page. Times display in Asia/Karachi and budgets in PKR. Unknown lead platform is labelled “Meta / unknown”. A Page's Instagram association is never used to guess the source platform.

Open a submission for customer details, attribution, custom answers, processing warnings, assignment history and a link to existing customer activity. Full structured customer phones use the existing authorized phone-vault RPC and audit. Private raw answers are only in the admin detail view; general logs, notifications and audit metadata contain no raw form contents.

Select Assign Agent, choose a searchable active Agent account, then confirm. Bulk selection uses the same confirmation with the selected customer names/count. The UI selects within the current 20-row page; the API accepts up to 100 distinct customers. **Bulk assignment is all-or-nothing, up to 100 distinct customers**: if any selected lead is already assigned or no longer pending, the entire transaction fails with a refresh/conflict message. No completed assignment is overwritten and no false success is shown. Inactive accounts and administrator accounts cannot be recipients. Database row/global locks and existing assignment history prevent conflicting first assignments. After assignment, the correct agent can open that customer; other agents remain denied. Later ordinary reassignment retains existing CRM behavior.

Admin sidebar/overview counters and the existing bell poll saved SQL state. Each administrator can dismiss a submission's notice once independently. Provider replays create neither another customer nor another notice. UI polling is 30 seconds, not a push-notification service; refresh latency includes the worker interval. Notices show the newest ten undismissed final/review submissions.

## Mapping and duplicate policy

Recognized defaults include name/full_name, first/last name, phone/phone_number, email, city/preferred_location, minimum/maximum budget, interested property, property type, preferred contact time and message/comments. Admin mapping selects supported CRM targets for actual question keys. Blank mappings use a recognized default or preserve the question as an answer; they do not promise to discard a question. Location/email/budgets go into supported existing customer fields. Property interest/type/contact time/message and unmapped answers stay in the protected submission detail rather than inventing new customer columns or property IDs.

Provider lead ID and normalized customer phone are distinct identities:

- Repeated **provider lead ID**: replay ignored by a unique constraint; one submission and one processing lifecycle.
- New provider ID with **existing normalized phone**: retain a private repeat-inquiry submission linked to that customer. Never overwrite the customer name, phone, owner, status, notes or deals.
- New ID/new valid phone: call existing protected `create_lead`; save the canonical phone in the existing private vault; create the new customer unassigned.
- Missing/invalid phone or name: keep a review submission without a fake CRM customer. Admin can correct name/phone/email or retry retrieval. Resolution still creates an unassigned customer, or links a duplicate. Enable/reconnect the Page/form before resolving an item whose synchronization was paused.

Existing Pakistani normalization treats `03001234567`, `+923001234567` and `00923001234567` as one identity. Optional malformed email/budget values are omitted with a warning and retained in raw answers. Normalized custom values are bounded; arbitrary provider fields cannot be inserted into protected columns.

## Durable processing and recovery

Webhook POST verifies `X-Hub-Signature-256` against the exact raw bytes using constant-time comparison before JSON parsing. Middleware ordering preserves raw bytes; ordinary CRM JSON and the separate mock webhook remain intact. Valid authorized identities are saved transactionally before success. Missing database support/storage failure returns an error, allowing provider retry. Unknown/unselected/paused Page/form events are ignored and not fetched.

Statuses: queued → processing → new customer / repeat inquiry / needs review. Temporary timeout, provider availability or rate-limit errors become retry-scheduled with exponential delay (starting at 60 seconds, bounded at six hours), maximum ten attempts. A five-minute lease permits crash recovery; UUID lease fencing prevents an old worker from completing a newer attempt. A worker crash on the last attempt becomes a visible failure during cleanup. Durable submission state survives API/worker restarts.

Expired authorization or missing permissions marks the connection as needing reconnect and the affected submission as failed. Reconnect, reselect Pages, then retry the failed item. Previously queued work becomes eligible when the connection is active again. The UI provides retry for failed/review/retry records. Do not repeatedly retry a permanent permissions/configuration error without fixing the cause.

Check missed submissions performs an explicit admin request for the last day (API supports one to seven days), limited to three pages/300 provider leads with honest truncation reporting. It uses the same durable queue, provider deduplication and first-assignment guard. There is no automatic historical backfill or 15-minute catch-up poll; webhooks are the primary capture mechanism. Provider retention/access limits still apply. Meta's generic sample “test webhook” payload may use a non-retrievable lead ID; use an actual test lead for end-to-end verification.

Graph requests use a fixed HTTPS Meta host/version, Bearer authorization, app-secret proof, a 15-second timeout, redirect refusal, a 2 MB streamed response limit and bounded cursor pagination. Provider `paging.next` URLs are never followed. Error output uses safe codes, not tokens or raw provider messages. Keep proxy/APM logs from recording OAuth callback query strings, authorization headers, bodies or outbound token-debug queries. Do not enable verbose secret-bearing request logging.

Private answers and normalized review data expire after the configured retention period. Readers enforce expiry and the job deletes expired records, even if Meta credentials are later removed. This does not delete the CRM customer, canonical phone, minimal attribution/submission status or immutable audit history. Broader customer-data deletion and Meta data-deletion callback obligations require your approved operational process; no new public erasure endpoint is added here.

## Marketing report definitions

The admin inbox includes a current-Pakistan-month report. The API permits an explicit UTC half-open range up to 366 days. It reports submissions by platform/campaign/form, distinct customer references per group, unique customer cohort, assigned/unassigned, current CRM stages, completed visits, won deals and recorded closed value.

A customer enters the unique cohort only in the period of their **first Meta inquiry**, including matches to existing customers. Each customer is counted once globally; repeats remain submission counts. Group distinct-customer references can overlap and must not be added as a global unique total. Visits use completed status and scheduled time in range. Won deals use the existing won stage, Pakistan-local close date and sum of `expected_value`. This is the CRM's recorded closed value, not collected cash or causal ad-return attribution. Missing campaign/ad metadata stays unknown. Reports do not fabricate missing metadata or multiply deal value by repeat submissions.

## API and source inventory

All paths below begin `/api/integrations/meta`. All except challenge/ingress/callback require authenticated active Admin; mutations have additional rate limits. Bodies/queries are strict Zod schemas.

| Method/path                     | Operation                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| GET/POST `/webhook`             | Private-token challenge / raw-HMAC durable event ingress                              |
| POST `/connect`                 | Create one-use browser-bound OAuth session and authorization URL                      |
| GET `/callback`                 | Consume session, server-only exchange/debug, encrypt/save credentials, fixed redirect |
| GET `/settings`                 | Safe connection/Page/form state and configured flag                                   |
| POST `/pages/:id/forms`         | Refresh bounded form discovery                                                        |
| PATCH `/pages/:id`              | Enable/pause verified Page subscription (`enabled`)                                   |
| PATCH `/forms/:id`              | Save enabled flag and allowlisted question mapping                                    |
| POST `/forms/:id/sync`          | Bounded explicit recent-lead check (`days`, default 1)                                |
| DELETE `/connections/:id`       | Stop local synchronization and wipe credentials                                       |
| GET `/summary`                  | Real counts and administrator-specific undismissed notices                            |
| GET `/inbox`                    | Filtered paginated safe admin records                                                 |
| GET `/submissions/:id`          | Audited admin detail, unexpired answers and assignment history                        |
| POST `/submissions/:id/retry`   | Reset a retryable lifecycle without duplicating an existing provider ID               |
| POST `/submissions/:id/resolve` | Validate corrections and finalize a review item transactionally                       |
| POST `/assign`                  | Explicit atomic assignment (`lead_ids`, `agent_id`)                                   |
| POST `/notices/:id/read`        | Persist this administrator's notice dismissal                                         |
| GET `/report`                   | Cohort/submission/activity report (`from`, `to`)                                      |

Created: migration 024; `server/src/services/meta/{config,crypto,graph,normalize,rpc}.js`; `server/src/routes/meta.routes.js`, `metaWebhook.routes.js`; `server/src/jobs/processMetaLeads.js`; `client/src/lib/meta.js`; `client/src/pages/admin/{MetaIntegration,IncomingSocial}.jsx`; server/client Meta test files; this guide.

Updated: server app/runner/rate limits and `metaLeads` compatibility boundary; client routes/layout/overview/styles; `.env.example`; fresh SQL bundle; README, roadmap, verification/live checks and complete manual/function generator. No npm dependencies were added. No previous migration, real environment file or technical snapshot report was replaced.

## Deployment and actual Meta test procedure

Deploy the existing API/frontend and supervised jobs to your prepared HTTPS CRM host, following `docs/PRODUCTION_FIXES.md`. Your VPS, domain and custom Supabase SMTP are not prepared yet; no deployment was attempted. Serve OAuth and the CRM from the same public site so the Secure callback cookie can return; development HTTP localhost cannot receive public Meta callbacks. If using a temporary HTTPS tunnel, explicitly configure its fixed callback/frontend and allowed origins for that test. Never rely on a changing callback URL in production.

Proxy `/api/integrations/meta/webhook` as raw JSON without body rewriting or login redirects; permit GET and POST and retain the HMAC header. Preserve HTTPS and OAuth cookies. Do not cache the API. Open only intended public HTTPS ingress; keep database/service keys and API internals private. Confirm the job service recovers on restart and logs safe failures.

Before running paid campaigns:

1. Configure the Meta app review/access, Business Login configuration, HTTPS redirects, app-level Page webhook `leadgen` and Lead Access Manager.
2. Connect through the Admin UI, refresh forms and explicitly enable the intended Page and form. Confirm Page subscription and saved status.
3. In Meta's **Lead Ads Testing Tool**, create a retrievable test lead for the chosen Page/form using a test contact you control. Meta documents one test lead per form; remove the old test lead in Meta before recreating. Do not treat dummy dashboard events as full retrieval evidence.
4. Confirm webhook challenge, a saved queued record, worker completion, attribution, protected phone and **unassigned** admin lead. Verify no ordinary agent can read it, including a guessed customer ID/API request.
5. Leave a pending test lead stale past the configured threshold in a separate test environment; confirm the stale job cannot assign it.
6. Manually assign to one active test agent. Confirm only that agent gains access, history/audit exists, and source/attribution remain intact. Test bulk conflict rollback with two admins on separate sessions/connections.
7. Submit another actual test lead using the same phone (new provider ID). Confirm a repeat inquiry, no extra customer and no changed owner/status/notes.
8. Verify incomplete-phone review/correction, revoke/reconnect behavior, pause/disconnect, restart recovery and recent-lead catch-up. Perform actual Instagram-placement acceptance if you will advertise on Instagram; a fixture `ig` value is not that proof.
9. Verify privacy/retention, approved Meta privacy policy/data handling, webhook delivery health and real deployment monitoring. Record App ID/version/date and pass/fail without storing tokens or customer answers in the verification report.

## Local tests and acceptance limits

Run from the project root: `npm test` and `npm run build`. The automated integration tests use embedded PostgreSQL with every migration, local Express listeners, synthetic Auth identities and controlled Graph HTTP responses. They never contact a real advertiser. UI tests use the actual React components with controlled API fixtures. Browser acceptance uses actual local React/API/SQL with fixture Auth/Meta responses, across 320/390/768/1440 px.

The verification record contains final counts and browser/build results. Covered behaviors include HMAC challenge/tampering, durable replay, restart recovery, Facebook/Instagram/unknown attribution, review/correction, canonical-phone matching without ownership changes, admin/agent denial, encrypted credentials, OAuth cookie/state replay/expiry, private table/RPC denial, explicit/bulk/conflicting assignment, stale-job exclusion, notifications, filtering/reporting, retries/lease fencing, retention, safe unconfigured state and disconnect.

**Implemented and tested locally:** CRM-side queue/security/creation/review/assignment/report/UI workflows with isolated provider responses.

**Implemented but awaiting real configuration:** business authorization, actual Page/form discovery/subscription, public webhook delivery, real Graph retrieval and actual Facebook/Instagram test leads. These acceptance criteria are unverified until the external test procedure passes. Production acceptance is not complete.

**Not implemented:** website forms, messaging/calling, automatic token renewal, scheduled missed-webhook backfill, account-wide remote grant revocation, paid-ad management and public Meta deletion callbacks. Separate live PostgreSQL connection contention, Meta review approval, SMTP delivery and physical-device/browser acceptance require the prepared environment.
