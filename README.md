# HD Marketing CRM

For the non-Docker Hostinger production setup, use [the Nginx/PM2 blue-green deployment guide](HD_MARKETING_PRODUCTION_DEPLOYMENT.md), [audit](docs/PRODUCTION_AUDIT.md), and [verification results](docs/PRODUCTION_VERIFICATION.md). No live deployment has been performed.

A locally run React/Express CRM for a real estate sales team. Navy, white and gold responsive workspace with separate admin and agent navigation. Supabase provides actual Auth, PostgreSQL and private Storage. No external resources have been created or deployed.

The [complete Word manual](docs/HD_Marketing_CRM_Complete_Documentation.docx) explains both portals, permissions, daily workflows, all implemented modules, account security, setup, API routes and named functions. Its [editable source](docs/CRM_COMPLETE_DOCUMENTATION.md) can be updated and rebuilt with `python3 scripts/build-project-doc.py` using Python's standard library.

The supplied animation style is integrated through `client/src/styles/animations.css`, using the CRM palette, mouse-only hover effects and reduced-motion support. [Animation behavior and customization](docs/ANIMATIONS.md) describes the shared effects and timing controls.

Missing security-alert readers in a partially upgraded database can be restored with `supabase/repair-security-alerts.sql`; the [contact/security guide](docs/PROTECTED_PHONE_NUMBERS.md#security-alert-warning-after-a-partial-migration) explains the repeatable repair.

The [loading-performance guide](docs/PERFORMANCE.md) explains the smaller frontend, batched dashboard/property requests, faster searches and migration **027** for database indexes. Existing installations retain compatible readers until this optional performance migration is applied.

Administrators can now [delete another account](docs/ACCOUNT_DELETION.md) from PIN-unlocked Accounts, preserving customer/activity history and moving assigned work to the admin pool. Apply **028_account_deletion.sql once after 027** to enable it.

If the deletion prerequisite check returns **022 false / 023 false / 027 true**, use `supabase/repair-account-deletion-prerequisites.sql` first, then install 028 once. The [deletion guide](docs/ACCOUNT_DELETION.md#result-022-false-023-false-027-true) provides the exact steps for this partial installation.

Both portals now show permanent HD lead numbers, page serials and scoped counts. Admins have bounded selection, bulk/direct assignment, atomic phone/owner editing and a 30-day Deleted leads bin. Apply updates **029–032 after 028** using `supabase/update-lead-management.sql` once if none is installed. The [lead-management guide](docs/LEAD_MANAGEMENT.md) includes Windows PowerShell/macOS copy commands, restore behavior and daily purge requirements.

## Quick start

Requires Node 22.12+ (tested with 24.13.1), npm, and either a configured Supabase development project or Docker with the Supabase CLI. Run commands **from `hd-marketing-crm/`**.

```sh
npm ci
cp .env.example .env
```

For a fully local Supabase instance, install Docker and the Supabase CLI using its official instructions, start Docker, then:

```sh
supabase start
supabase db reset
supabase status
```

`db reset` is destructive to the **local development database**. It executes all numbered migrations and safe property seed data. No Auth accounts are faked in SQL. For a hosted development Supabase project, execute migrations in filename order through a database migration tool or the SQL editor; do not reset a production database. Run `supabase/seed.sql` afterward if desired. Do not expose `crm_private` in API settings.

For first-time setup in a **fresh hosted project**, `supabase/setup.sql` combines all 37 migrations and the safe property seed in one transaction. In the project terminal on macOS, run `pbcopy < supabase/setup.sql`, paste into a new query in Supabase **SQL Editor**, and click **Run**. The result should say `HD Marketing database setup completed`. This creates the CRM tables; it does not create login accounts. The script refuses to run when an existing `profiles` table is present. To rebuild this file after changing migrations, run `node scripts/build-sql.js`. Do not run both the individual migrations and the combined setup on the same database.

Edit root `.env`: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your local status output or your development project. New secret keys are also supported. The service key stays exclusively on the server. Set `FRONTEND_URL=http://localhost:5173`.

Create `client/.env` with only:

```dotenv
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=your-public-anon-or-publishable-key
VITE_API_URL=/api
```

Set explicit development email/password pairs (`DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`, `DEV_AGENT_EMAIL`, `DEV_AGENT_PASSWORD`) in root `.env`, using passwords of at least 12 characters. The development script leaves users inactive until their inbox is confirmed and a trusted administrator enables the known profiles. It does not auto-confirm email. Then:

```sh
npm run setup:dev
npm run dev
```

Open **http://localhost:5173**. API health: **http://localhost:3001/health**. `npm run dev` also starts the background jobs (the `jobs` stream). On a server, run them as their own process:

```sh
npm run jobs
```

Other commands:

```sh
npm test
npm run build
npm run test -w server
npm run test -w client
```

## Auth and first admin

After the database is set up, `npm run configure` prompts for the Project URL, public Publishable/anon key, server Secret/service_role key, and distinct admin/agent login emails and passwords. Copy the URL from **Connect** and the keys from **Settings → API Keys**. Keys and passwords are hidden during entry. The command writes local root `.env` and `client/.env`, keeping the server key and passwords exclusively in the root file. It preserves existing root settings such as job configuration. Then run `npm run setup:dev` to create unconfirmed inactive development Auth accounts and request inbox links. Verify those inboxes and enable the known profiles through trusted administration before using them; `npm run dev` starts the workspace. These CRM login accounts are separate from your Supabase dashboard login. Do not put the keys in chat.

If you already created a login under **Authentication → Users**, run `npm run configure -- --connection-only`. This asks only for the URL and keys; press Enter to keep the saved URL and public key. Enter the Secret key locally, then run `npm run dev` and sign in using the existing account. Skip `setup:dev`, which creates new accounts. The profile trigger creates an inactive agent; verify the inbox first. To make it the first administrator, use trusted Supabase **Table Editor → profiles**, locate the row whose `id` matches that exact Auth user UUID, and set its `role` to `admin`. Set `active` true only after inbox verification. No user password is required in `.env` for an existing login account.

Public signup is disabled in the local configuration and there is no registration UI. The profile trigger always creates an **inactive agent**, ignoring metadata roles and access claims. The development script uses supported Auth Admin account creation and then a server-only profile update. It refuses production mode and has no default passwords. It deliberately rejects already existing accounts instead of changing their passwords.

In a non-development environment, invite/create the first user through Supabase Auth administration, then promote exactly that known ID through trusted database administration:

```sql
update public.profiles set role = 'admin' where id = 'known-auth-user-uuid';
```

Create additional Agent/Admin users through the PIN-protected **Accounts** page. Admins can edit names, roles and access and set another account's password. Manage your personal four-digit PIN under **Admin settings → Security**, using your current login password to set or reset it. The **Team** page is a read-only directory; every API request rechecks the profile, including requests with existing valid tokens. See [Accounts setup and security](docs/ACCOUNTS_AND_SECURITY.md). Set Auth Site URL and allowed recovery redirect to your frontend `/login`. Local Supabase delivers email to its local mail viewer; hosted development requires configured email delivery. Login, logout, session restoration and recovery use Supabase Auth.

On the login page, select **Agent** or **Admin** before entering the account's email and password. Agent is selected initially. Each option accepts only the corresponding active role stored in the CRM profile. A temporary Supabase client authenticates the credentials in memory; `/api/me?portal=agent|admin` then checks the saved role before the main browser session is installed. Wrong-portal, disabled-account and failed checks leave the login form open without saving a session. Switching portals clears entered credentials and form errors; controls are locked while signing in. The toggle does not change an account's role. No database migration is required for this login feature.

Both Agent and Admin sign-in have an email suggestion dropdown inside the CRM. It remembers up to five successful login emails per portal in this browser on this device; restoring an authorized session also remembers that account's email. Focus the email field or type part of an address, then click a suggestion or use the arrow keys and Enter. Selecting an email leaves the password empty. Failed logins and accounts rejected by the selected portal are not remembered. On a new device or browser origin, enter the full email and sign in once to start its history.

Only email strings are saved in the suggestion history. The login form, email and password fields request `autocomplete="off"`; passwords are entered manually and the eye icon still shows or hides typed text. Browsers and password-manager extensions can override this request; disable saved-password autofill in their settings if it continues. See [MDN's explanation of login autofill](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Turning_off_form_autocompletion#managing_autofill_for_login_fields). Forgot-password and recovery links remain available for both account types; email recovery and new-password recovery keep their appropriate autocomplete hints.

New Agent and Admin accounts are created directly by a PIN-unlocked admin, with no email code. They must use a valid `@gmail.com` address, and each receives a permanent six-digit UID (100000–999999), generated automatically or entered manually. UIDs appear on Accounts cards and details (with copy and UID search), in the Team directory, and in every user's **My profile** panel. The Supabase Auth UUID remains the login identity. Apply **036_account_uids.sql after 035**; it also gives every existing account a UID. Then redeploy. No new environment variables are needed. [Setup, verification queries and behavior](docs/ACCOUNT_UIDS.md). Email-code requests started before 036 can still be finished or cancelled ([earlier flow](docs/ACCOUNT_CREATION_OTP.md)). No hosted configuration was changed by this local work.

## Login security and daily backups

Sign-in now goes through the CRM server: **5 wrong passwords in 15 minutes lock that email for 15 minutes**, even for the correct password, and admins get a security alert. Browsers **sign out after 30 minutes of inactivity**, with a warning 5 minutes before. Admins see every attempt under **Login history**, and a sign-in outside business hours raises an alert. Apply **037_login_security.sql after 036**. [Behavior and settings](docs/LOGIN_SECURITY.md).

## Sales workflow: first calls and notifications

Every assigned lead must get its first call on the working day it is assigned. Leads assigned in the last 2 working hours, or outside **Mon–Sat 10 AM–6 PM**, are due by the next working day's close. Missed first calls and leads quiet for 7 days wait on the admin Overview for **Keep** or **Reassign**; nothing is reassigned automatically. Admins see each agent's calling today. Agents see **My calls today**. Both get bell notifications for assignments, deadlines, missed calls, follow-ups, tomorrow's visits and the end-of-day call summary. Apply **038_lead_response_and_notifications.sql after 037**. [Behavior, settings and jobs](docs/SALES_WORKFLOW.md).

**Site visits → Calendar** shows week and month views in Pakistan time and warns when an agent's visits fall within an hour of each other. **Targets** can be daily, weekly or monthly, with leads-contacted and follow-up goals and a copy-previous-period button; agents see the targets running today on their overview. **Reports** add lead-source, agent, sales-funnel and lost-reason tabs, each with CSV export. Apply **039_calendar_targets_reports.sql after 038**. [Details](docs/SALES_WORKFLOW.md#part-2-visit-calendar-period-targets-and-reports).

## Attendance

Admins and Agents check in and out under **My attendance**, using the database clock and Pakistan time. The default rules are 10 AM–6 PM, Monday–Saturday, a 15-minute grace period and Sunday off; they are versioned settings, so changes never rewrite past days. **Attendance management** gives admins:

- a daily register of everyone expected, including absentees
- weekly and monthly reports with charts and CSV or Excel export
- each employee's history, including disabled accounts
- holidays, and leave and correction requests, which another administrator must approve

Absences are worked out from the schedule, never stored, and attendance never changes lead ownership. Apply **040_attendance.sql after 039**. [Full guide](docs/ATTENDANCE_MANAGEMENT.md).

This Mac can keep **daily encrypted backups** of the database and all uploaded files (30 days, in `~/HD-CRM-Backups`). Set it up once with `brew install libpq age` and `node scripts/install-mac-backup.mjs`, then add the database address. [Setup, checking and restore](docs/BACKUPS.md).

## Administrator sign-in and optional agent MFA

Administrators sign in with their verified email and password. The user's later request removes mandatory admin two-factor login, including enforcement for existing factors/reset records. Admin sign-in does not call the MFA SQL functions or need migration 025. Active profiles, inbox/invitation verification, saved portal roles, verified identity and the personal Accounts PIN still apply.

Agents remain optional by default (`REQUIRE_AGENT_MFA=false`); unenrolled agents can also sign in without 025. Already-enrolled or explicitly required agents keep native TOTP verification and its durable reset/attempt checks. Their optional feature needs **025_admin_totp_mfa.sql after 024** and native TOTP enrollment/verification. PIN-unlocked Accounts offers factor reset only for agent accounts. Existing migration files and native factors are preserved. [Current login policy, installation and optional-agent recovery](docs/ADMIN_TWO_FACTOR_LOGIN.md) explains the behavior.

## Permissions and privacy

| Capability                              | Admin                                                             | Agent                              |
| --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Leads                                   | Create/import/edit/assign all                                     | Read own, change status            |
| Imported files                          | View/import/assign whole files                                    | Open own assigned files            |
| Documentation & policies                | Create/edit/delete all entries and files                          | Shared guidance; own clients' KYC  |
| Full phone                              | Automatic; all leads, audited                                     | Automatic; assigned leads, audited |
| Calls, notes, follow-ups, visits, deals | All records                                                       | Current assigned lead only         |
| Properties                              | Create/edit/archive/delete; private photos                        | Read and authorized photo links    |
| Targets                                 | Set per agent/month                                               | Personal targets/progress          |
| Team, reports CSV, audit, recordings    | Allowed                                                           | Denied                             |
| Accounts and admin security settings    | Active admin; account operations also require personal PIN unlock | Denied                             |
| Leaderboard                             | Limited aggregates                                                | Limited aggregates                 |

Browser `anon` and `authenticated` roles have **no CRM table grants or execute grants**; all CRM tables have RLS enabled with no browser policies. Full numbers live in an unexposed `crm_private` schema with explicit grant revocation. Thus REST, RPC and direct browser SQL cannot retrieve them. This is stricter than relying on row policies to hide columns. Profiles are read through `/me` and roles are never trusted from request bodies or editable Auth metadata. The service client bypasses RLS: backend routes check ownership, and transactional RPC functions independently recheck the actor and current assignment. Private photos and recordings have no browser storage policies.

Customer numbers now appear automatically in lead lists, assigned-file lists and customer profiles, with no Show/Hide buttons or two-minute expiry. Admins see all leads' contacts; agents see only their currently assigned leads. The API resolves just the requested page through an authorized, atomic SQL read and audits each available contact without storing the phone in audit metadata. Profile contacts support tap-to-call. Numbers are held in the account-scoped React Query memory cache; the CRM does not persist them in localStorage or sessionStorage. This requested behavior supersedes P2's masking, explicit-reveal and daily-quota display policy. Agent free text remains masked, original document binaries remain unchanged, and existing Security alerts remain reviewable. The old batch endpoint remains removed. See [visible contact setup](docs/PROTECTED_PHONE_NUMBERS.md).

Existing installations must apply missing migrations in order: **019 after 018, 020 after 019, and 021_visible_lead_contacts.sql after 020**, then refresh the CRM. Update 021 is required for automatic full contacts. Do not rerun the fresh setup bundle over an existing database. If the error persists after 021, copy `supabase/repair-visible-lead-contacts.sql` into the connected project's SQL Editor; this repeatable repair restores a missing phone-read history table, installs the function and requests a schema-cache refresh. Its phone_history_ready, phone_function_installed and server_access_ready columns should all be true. See the [repair instructions](docs/PROTECTED_PHONE_NUMBERS.md).

## Pipeline upgrade (F1)

The supplied roadmap is saved in [docs/REMAINING_FEATURES.md](docs/REMAINING_FEATURES.md). F1 adds updated stages, required lost reasons, history and automatic forward moves. Existing hosted projects must apply **only** `supabase/migrations/012_pipeline_and_lost_reasons.sql` once in SQL Editor before using these changes; the regenerated setup bundle is for fresh projects. [F1 setup and acceptance checks](docs/F1_PIPELINE.md) include the exact copy command and legacy-data mapping.

## Property deletion and responsive controls

After migration 012, apply `supabase/migrations/013_property_deletion.sql` once in the hosted SQL editor to enable the administrator's **Delete property** action beside **Edit property**. Deletion requires a separate confirmation and removes the property and its photos. Properties linked to leads, visits or deals return a conflict and remain available for archiving. An active administrator is rechecked inside the SQL transaction, and deletion and its audit record commit together.

Photo files are removed immediately after deletion. A protected durable queue preserves cleanup work when Storage is unavailable; `npm run jobs` retries it. Browser users cannot access the queue or execute the delete function directly. This extra requested migration uses number 013; subsequent roadmap migrations must use the next free number (027 or later).

Shared controls wrap on narrow screens, use 44-pixel button/tap targets, and keep forms, dialogs, notifications, cards and scrolling tables inside the viewport. Mobile navigation includes a close button, backdrop dismissal and Escape handling. See [the setup and verification notes](docs/PROPERTY_DELETION.md).

## Imported files and task assignment

Apply `supabase/migrations/014_import_files_and_assignments.sql` once to an existing database. Admins can then open **Task assign**, find any processed CSV/XLSX/XLS import and assign all its accepted leads to an active agent. Assignment and audit history commit together. Agents open **My leads**, click an assigned file, and see only their currently assigned leads from that file. **All my leads** also includes individual and manual assignments. Existing imports receive recovered groups labelled **Earlier import**, since older versions did not retain filenames. See [setup and workflow](docs/FILE_ASSIGNMENTS.md).

## Documentation and policies

Migration 015 creates the shared entry and attachment tables. Apply `supabase/migrations/017_document_categories.sql` once after migration 016 to enable the latest categories and search fields. **Documentation & policies** is available in both sidebars with **All, Property Deeds, Legal & NOC, Agency Policy, Client KYC, Tenancy Agreements** and the existing **Documentation** filter. Administrators choose the category and can add a property name and keywords when creating or editing written entries and PDF/DOC/DOCX attachments; agents read, filter and download. Search matches titles, property names, keywords and written content. Existing policies appear under Agency Policy. File downloads require an active session and are audited. Attachments stay in a private bucket; a durable queue retries failed file cleanup through `npm run jobs`. See [setup and usage](docs/DOCUMENTATION_AND_POLICIES.md).

## Accounts and admin security

Apply `supabase/migrations/016_accounts_and_security.sql` once after migration 015. Admins open **Admin settings → Security** to set a personal four-digit PIN using their login password. They then unlock **Accounts** to create Gmail-only Agent/Admin accounts with six-digit UIDs (update 036), view account details, edit roles/access/names and set another account's password. Unlocks last 15 minutes; five incorrect PINs cause a 15-minute lockout. Account history is retained when access is disabled. See [installation, recovery and account workflows](docs/ACCOUNTS_AND_SECURITY.md).

## Agent handover and Client KYC access

Migration **022_agent_offboarding_and_kyc_access.sql**, installed after 021, makes disabling an agent an atomic handover of all owned leads and pending work. The PIN-protected dialog previews counts and offers balanced sharing (default), one active recipient or the admin unassigned pool. Completed activity history remains with the original agent; re-enabling does not return clients. The jobs runner alerts admins about inactive owners without silently moving their leads.

Client KYC now requires a linked lead. Administrators see all KYC; agents see only their currently assigned clients' KYC through lists, search, counts, reading and private downloads. Older unlinked KYC is admin-only and can be corrected with **KYC not linked to a client**. Customer profiles include linked KYC files. [Usage, backup warning, exact SQL update steps and test results](CHANGES_OFFBOARDING_AND_KYC.md) are provided for the business owner. No hosted database update was performed here. P3/P4 are implemented locally; Mandatory P5 admin MFA was removed at the user's request; optional-agent MFA uses preserved migration 025. P6 files are implemented locally; hosted deployment/backup acceptance and P7/P8 remain pending.

## Workflows

- Leads: search by name, filter status/source, paginate, create, edit, import CSV or Excel, assign manually or round-robin, and review the timeline. Round-robin uses a database advisory transaction lock and least-recent assignment; ties use UUID order. Unique normalized phones are enforced transactionally in a protected table.
- Lead imports: **CSV (.csv), Excel (.xlsx), and older Excel (.xls)**, maximum 1,000 rows, 32 columns and 5 MB. Use **Admin → Leads → Import CSV / Excel**. Excel reads the first worksheet with headers in row 1. Header example: `name,phone,email,budget_min,budget_max,preferred_location`. Required: name and phone. Common headings such as Full Name, Mobile Number and Contact No. match automatically. Extra or unfamiliar columns open a matching screen before any leads are created; match fields or explicitly skip columns without selecting the file again. Optional `property_id` requires a CRM property UUID; `assigned_agent` accepts an active agent’s exact name or UUID. Unknown or ambiguous agents leave leads unassigned with visible warnings. Row errors identify the invalid field, and placeholder phone labels require valid numbers. Format Excel phone cells as Text before entering numbers to preserve leading zeros and country codes. Every row receives an import result; invalid/duplicate rows do not undo valid rows. Formulas in matched Excel columns are rejected; paste values instead. Pakistani `0300…`, `+92300…` and `0092300…` normalize to the same number. Numbers from other countries must include country codes. Phones cannot be edited in place; this avoids accidentally replacing a customer identity. See [the import guide](docs/LEAD_IMPORT.md) for supported headers and troubleshooting. File history and whole-file assignment require migration 014; see [file assignments](docs/FILE_ASSIGNMENTS.md).
- Documentation & policies: shared policies and guides with category filters, property names, keywords, search, pagination, multiline written content and optional PDF/Word attachments up to 10 MB each. Admin-only management is enforced in both API routes and SQL transactions. See [the guide](docs/DOCUMENTATION_AND_POLICIES.md).
- Lead detail: add notes, update status, create calls, submit outcomes/tags, schedule follow-ups/visits, and create a deal. Activity includes assignment history. Timeline is bounded to the latest 100 entries per activity type.
- Follow-ups: edit, complete or cancel; due, overdue, upcoming and completed views. Visits: scheduled/completed/cancelled/no-show. Dates are UTC in the database and shown in Asia/Karachi. Date/time inputs explicitly use Pakistan time.
- Deals: one record per lead, with property, recorded responsible agent, stage/value/close date/notes. Edit the existing deal for a stage change. Won requires a close date. Setting a lead status to won alone does not create a won deal or revenue.
- Property photos: both portals show saved pictures on property cards with availability, type and photo counts. Click a picture or **View property** to see the full price/location/type/area/availability/description and uploaded gallery. **Admin → Properties → Add property → Add pictures** selects several JPEG/PNG/WebP pictures with previews and individual removal. Pictures are optional, up to 5 MB each, and upload after saving the property. Edit property offers the same picker. Completed uploads open the saved gallery; partial failures retain the property ID and only the remaining selected pictures for retry. Existing gallery upload/delete controls remain available. Photos use the existing private bucket, server signature/MIME checks and 60-second signed access. The open gallery periodically renews URLs in the shared card/gallery cache; cards retry a failed URL once and retain readable fallbacks. Linked properties can be archived; unlinked properties can be deleted using the separate confirmation. See [property pictures](docs/PROPERTY_PICTURES.md).
- Targets: one row per agent/month; select the first day of the month. Progress uses the same SQL aggregation as reports. Leaderboard returns only names and completed call/won deal counts.

## Metric definitions

Reports aggregate across the full database query, never the current UI page. Ranges are half-open `[from,to)`, with the UI treating the chosen through-date inclusively in Pakistan time.

- Lead totals, status/source distribution: lead creation timestamp within range.
- Completed calls: `status=completed`, using `ended_at`.
- Completed visits: `status=completed`, using `scheduled_at`.
- Won deals: `stage=won`, using `close_date`; exactly one deal per lead.
- Closed revenue: sum won deals' recorded `expected_value`. This is entered closed value, not cash receipts or commission accounting.
- Agent/source filters: current lead assignment/source, plus activity agent for calls/visits/deals. Reassigned historical activity remains in the database; the current-ownership filter can exclude it from the new assignee's progress. No other agent's customer details are exposed.
- Due/overdue follow-ups and upcoming scheduled visits: current operational counts, independent of report date range. Active agents: current active agent profiles.

Admin dashboard metrics use the current Pakistan month. Agent overview also shows all assigned leads and today’s completed calls. Targets use their selected month. CSV exports contain aggregate metrics only and escape potential spreadsheet formulas.

## API routes

All `/api` routes require a verified Bearer token except the signature-verified webhook boundary. Limits: JSON 256 KB, uploads 5 MB for photos/lead imports and 10 MB for documentation files, page size 1–100, API rate limits per verified user once signed in and per IP before sign-in, configurable with `RATE_LIMIT_*` (see [docs/RATE_LIMITS.md](docs/RATE_LIMITS.md)).

| Routes                                                                      | Behavior                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /health`                                                               | Secret-free public health                                                                          |
| `GET /api/me`                                                               | Trusted active profile                                                                             |
| `GET /api/call-capabilities`                                                | Safe authorized manual/mock/provider availability                                                  |
| `GET/POST /api/leads`, `GET/PATCH /api/leads/:id`                           | Paginated leads / validated mutation                                                               |
| `POST /api/leads/import`                                                    | Multipart CSV/XLSX/XLS `file`, row results                                                         |
| `GET /api/lead-imports`, `GET /api/lead-imports/:id`                        | Imported file history / current-ownership metadata                                                 |
| `POST /api/lead-imports/:id/assign`                                         | Admin whole-file assignment `{agent_id}`                                                           |
| `GET/POST /api/documents`, `GET/PATCH/DELETE /api/documents/:id`            | Shared entries; mutations require admin                                                            |
| `POST /api/documents/:id/files`, `DELETE /api/documents/:id/files/:file`    | Admin attachment upload/deletion                                                                   |
| `GET /api/documents/:id/files/:file/download`                               | Authenticated, audited attachment download                                                         |
| `GET /api/leads/:id/phone`                                                  | Admin / assigned agent reveal, no-store, audited                                                   |
| `POST /api/leads/phones`                                                    | Visible contacts `{lead_ids}` (1–100 unique IDs), admin / current assignment, audited, no-store    |
| `POST /api/leads/:id/assign`                                                | Admin `{agent_id}`; null means round-robin                                                         |
| `GET /api/leads/:id/timeline`                                               | Authorized lead history                                                                            |
| `POST /api/leads/:id/call`                                                  | Server-resolved private destination                                                                |
| `POST /api/leads/:id/calls/manual`                                          | Admin/current assigned agent; validated manual logging, sensitive limit                            |
| `GET /api/calls`, `PATCH /api/calls/:id`                                    | Review / outcome, notes, tags                                                                      |
| `POST /api/calls/:id/mock-complete`                                         | Explicit development-only mock completion                                                          |
| `GET /api/calls/:id/recording`                                              | Admin, short-lived authorized playback                                                             |
| `GET/POST /api/{properties,targets,followups,visits,deals}`                 | List/create                                                                                        |
| `PATCH /api/{properties,targets,followups,visits,deals}/:id`                | Validated edit                                                                                     |
| `GET/POST /api/properties/:id/photos`                                       | Authorized photos / admin upload                                                                   |
| `DELETE /api/properties/:id/photos/:photo`                                  | Admin object deletion                                                                              |
| `POST /api/notes`                                                           | Authorized note                                                                                    |
| `GET /api/users`                                                            | Minimal admin team directory; legacy PATCH is refused                                              |
| `GET/PUT /api/account-security`, `POST /api/account-security/{unlock,lock}` | Admin personal PIN settings, current-password verification and temporary unlock                    |
| `GET/POST /api/accounts`, `GET/PATCH /api/accounts/:id`                     | PIN-protected admin account list (UID search), Gmail-only direct creation with UID, details, edits |
| `GET /api/accounts/uid-availability`                                        | PIN-protected `{uid,available}` check for a manual UID                                             |
| `POST /api/accounts/:id/email-code`                                         | PIN-protected agent OTP resend to the stored email                                                 |
| `POST /api/accounts/:id/email-code/verify`                                  | PIN-protected code verification and initial password setup                                         |
| `POST/DELETE /api/accounts/:id/invitation`                                  | PIN-protected resend/cancel; current tickets and server expiry                                     |
| `POST /api/onboarding/context`, `/api/onboarding/complete`                  | Verified recipient plus current invitation ticket only; context/password acceptance                |
| `POST /api/accounts/:id/password`                                           | PIN-protected change of another account's password                                                 |
| `GET /api/accounts/:id/offboard-preview`, `POST /api/accounts/:id/offboard` | PIN-protected counts and atomic agent handover                                                     |
| `GET /api/documents/clients`                                                | Admin-only KYC client picker, masked phone metadata                                                |
| `GET/PATCH /api/reminders[/:id]`                                            | Own unread reminders / dismiss                                                                     |
| `GET /api/reports`, `/api/reports/export`, `/api/leaderboard`               | `from`, `to`, optional `agent`, `source`                                                           |
| `GET /api/audit`                                                            | Admin paginated append-only history                                                                |
| `POST /api/webhooks/mock`                                                   | Development fixture HMAC only                                                                      |

## Jobs and retention

`npm run dev` starts the jobs alongside the web server; on a server run `npm run jobs` as its own process. It runs immediately and then every `JOB_INTERVAL_SECONDS` (minimum 10). Transaction advisory locks protect database jobs across instances; reminder uniqueness also protects reruns. Each recording deletion is idempotent, preserves metadata, and records safe errors for retry at the next tick. Storage deletion of an already missing object is considered successful; real provider adapters must offer the same idempotency.

- `deleteOldRecordings`: recording creation + **seven days by default** (`RECORDING_RETENTION_DAYS`, 1–7); actual storage object and any provider copy must both be removed before success. Playback refuses recordings aged seven days even if physical deletion is still retrying. Audit survives deletion. No permanent public URL.
- `attendanceReconciliation` (update 040): marks check-ins left open on earlier days as incomplete (never inventing a check-out), notifies the employee once and sends admins one attendance summary after the shift. Reports do not depend on it.
- `leadResponseCheck` (update 038): marks missed first calls and notifies the agent and admins; sends the afternoon first-call reminder, tomorrow's visits and the admins' end-of-day call summary. It never reassigns; quiet and missed leads wait for an admin's Keep or Reassign decision. Working hours come from Admin settings. `STALE_LEAD_DAYS` is no longer used.
- `reportInactiveLeadOwners`: detects inactive profiles still owning leads of any stage, raises one safe security alert per owner/Pakistan day and audits the counts; does not reassign. The stale job leaves those clients for the administrator's explicit handover decision.
- `cleanupKnowledgeFiles`: removes due document upload reservations and deleted attachments from private Storage, then clears their durable queue rows. Interrupted uploads become eligible after one hour; entry/file deletion requests attempt immediate cleanup.
- `followUpReminders`: pending follow-ups due within the next 24 hours (including overdue), one reminder per follow-up/due timestamp, to the current active owner or administering account holding unassigned pending work.
- `missingOutcomeCheck`: completed calls with no submitted outcome older than `OUTCOME_GRACE_MINUTES` (default 30).

`RECORDING_RETENTION_DAYS` may shorten retention to 1–7 days. Values beyond seven are rejected by the job and capped by SQL, so configuration cannot silently retain customer recordings longer. The runner should remain active; provider retention cannot be guaranteed until a real adapter is selected and verified.

## Facebook and Instagram incoming leads

Admin **Integrations → Meta Lead Ads** connects authorized Pages/forms; **Incoming social leads** provides review, duplicate inquiry handling, filters, explicit individual/bulk assignment and attribution reporting. Every new social customer stays unassigned and hidden from agents until an admin selects an active agent. Stale jobs cannot assign pending social leads. Apply **024_meta_lead_ads.sql once after 023**, configure the server-only Meta variables and run the background jobs. Existing customer matches keep their ownership and history.

This implementation supports **Instant Forms**. It awaits your Meta app, permissions/review, HTTPS deployment and real test-lead acceptance. External website forms need a separate integration. See [complete setup, API, security and acceptance instructions](docs/META_LEAD_ADS_INTEGRATION.md). No real Meta account was connected during development.

## Integrations and mock verification

Manual call logging works without a provider, including in production. After calling from the company phone, open a customer and choose **Log a call**. Enter answered state, Pakistan-local start, minutes/seconds, outcome, notes and tags. Answered logs count as completed calls; unanswered logs do not. Call review and timelines show Manual/Mock/Provider. Existing databases must apply migration `018_manual_call_logging.sql` once after 017; see [setup and usage](docs/MANUAL_CALL_LOGGING.md).

`CALL_PROVIDER=mock` enables an additional **Development mock call** button outside production. It does **not** make a real phone call. Complete it through the mock button and then submit its outcome. Production/unconfigured-provider screens hide mock controls; the corresponding routes refuse direct requests. Facebook/Instagram Instant Forms now have a real server-side integration; WhatsApp remains disabled. Configure Meta separately using [the integration guide](docs/META_LEAD_ADS_INTEGRATION.md).

A real calling adapter must support server-to-server click-to-call that hides destination numbers from the browser and agent, agent routing, idempotency keys, request timeouts, signed events, monotonic status transitions, authorized recording retrieval and deletion of provider copies. Keep recording references in `crm_private.recordings`; never include raw provider metadata in public calls. Physical retention guarantees depend on provider capabilities/contracts.

Edit the provider call ID in `server/fixtures/call-event.json` to match a created mock call, then run `node --env-file=.env scripts/send-mock-event.js`. Re-run to verify deduplication.

The local fixture webhook uses `X-HD-Signature: sha256=<HMAC-SHA256 of exact raw request bytes>`, with `WEBHOOK_SECRET`. Missing verification config is rejected. The database applies event deduplication and call status in one transaction. Terminal calls ignore late nonterminal transitions and submitted outcomes are never changed by events. The separate Meta receiver verifies X-Hub-Signature-256 and uses its durable queue; WhatsApp/calling remain unconnected. The fixture HMAC is not presented as their real protocol. Unknown call events are rejected so a sender can retry after the call record exists.

## Verification and limitations

Automated tests cover executable SQL migrations using embedded PostgreSQL (PGlite), browser-role permission denial, role escalation, ownership, atomic duplicate handling, round-robin ordering, webhook replay/late events, deal counts, reminder reruns, recording expiry/retry/audit preservation, API missing/invalid/expired sessions, disabled accounts, authorized phone reveals and denial for unassigned/other-agent leads, recording object deletion, CSV formula escaping, frontend route protection, outcome validation/tags and Pakistan timestamps.

The embedded database creates **minimal Auth/Storage schema fixtures** and omits the Supabase-provided `pgcrypto` extension statement. It does not test the real Supabase HTTP gateway, JWT expiry, email recovery, storage service or concurrent PostgreSQL connections. Supertest uses a mocked Auth client for negative token cases. Those service checks require real local Supabase credentials. Provider integrations are intentionally unverified and disabled. Headless Chrome checks responsive layouts and workflows with isolated service fixtures; see `VERIFICATION.md` for the tested features and remaining deployment checks.

For executable read-only checks, set `LIVE_OWN_LEAD_ID` to a lead assigned to the development agent and `LIVE_OTHER_LEAD_ID` to a lead assigned to another agent, put the public key in root `VITE_SUPABASE_ANON_KEY`, start the API, and run:

```sh
npm run verify:live
```

This signs in through actual Supabase Auth and asserts browser REST/RPC phone denial, cross-agent API denial, invalid/missing auth and attempted role escalation. It does not change CRM records. This script has not been run against a live Supabase instance here.

To verify against real Supabase after setup:

1. Run migrations with `supabase db reset` on the local instance. Confirm both test accounts can login and password recovery email reaches the local viewer.
2. Create a second real agent through Supabase Auth administration. Assign a lead to each. Sign in as each agent and verify the other lead, timeline, call, follow-up, visit and deal endpoints return 403/404.
3. With the agent JWT and public key, call `/rest/v1/leads?select=*`, `/rest/v1/profiles?select=*`, `/rest/v1/rpc/private_phone` and any attempted `crm_private` REST endpoint; all must deny access. Also try Storage listing/download directly with the agent JWT.
4. Save an agent token, disable that agent from Accounts, and verify its next API request gets 403. Test a revoked/expired JWT with `/api/me`.
5. Send concurrent duplicate lead creates and concurrent round-robin requests from separate connections; exactly one duplicate create should succeed and assignments should remain balanced. Embedded tests serialize through one PostgreSQL connection; the SQL advisory lock is what protects real concurrent instances.
6. Upload/view/delete photos and confirm object removal in the private bucket. Provision an expired private recording row for a mock call, run jobs, and confirm actual object deletion and audit history. Temporarily break storage access and confirm failed attempts remain retryable. Recover any orphaned uploads if a database outage also prevented upload compensation.
7. Repeat one valid signed mock event twice, then send ringing after completed. Confirm one event application, preserved outcome and terminal status.
8. Start two job runners and confirm no duplicate reminders and no repeated immediate stale assignment.

## Common setup errors

- **No `.env`**: copy the root template; keep client settings in `client/.env` separately.
- **Missing profiles / permission denied**: apply all migrations before creating Auth accounts. Existing Auth users created before migration need trusted profile provisioning.
- **401 / invalid API key**: confirm URL and keys belong to the same Supabase instance. Client uses public key; server uses secret/service key.
- **CORS**: direct requests to an explicitly configured backend URL require the configured `FRONTEND_URL`. Local development uses Vite's `/api` proxy and fixed port 5173, so the browser requests its own origin.
- **Load failed during login**: local browser API requests use `/api`, which Vite forwards to the loopback Express server. Both `localhost:5173` and `127.0.0.1:5173` work through this proxy. Keep `npm run dev` running and reload the page after configuration changes. An error mentioning **Supabase login** concerns the Auth connection; an error mentioning **CRM server** concerns the local API. Vite requires port 5173 to be free. For a production build, serve `/api` through your web server or set `VITE_API_URL` to the explicitly authorized backend origin before building.
- **No available agent**: create an active agent before round-robin assignment.
- **409**: duplicate normalized phone, duplicate target month or existing deal for the lead.
- **Recording unavailable**: missing, expired, deleted or no adapter ingestion configured.
- **Real call 503**: expected until a real provider adapter is implemented and configured.
- **Tests listen EPERM**: grant local port access; Supertest opens temporary listeners.

The API is bound to localhost. Rate-limit counts are kept per API process (see [docs/RATE_LIMITS.md](docs/RATE_LIMITS.md)); before running several active API processes for one environment, add a shared rate-limit store, configure trusted proxy boundaries, review provider adapters and run the real-service checks above. No deployment is included.

## Production deployment and system monitoring (P6)

Deployment files target one Ubuntu 24.04 VPS with Caddy and two PM2 processes. Production API/jobs startup requires real HTTPS connection settings, stable 32-character webhook/PIN secrets and CALL_PROVIDER=manual. Admin login remains email/password. Proxy trust defaults to loopback; never trust every forwarded header. Existing admins reset their PIN once after a new pepper is installed.

Apply **026_system_monitoring.sql once after 025** for the admin System status card, job/backup metadata and protected readiness. Ordinary login does not depend on 026. Jobs record safe durable outcomes; GET /api/health/ready is Admin-only and requires version 26/all eight fresh successful jobs. Backup state is reported separately. The backup wrapper streams pg_dump into age, keeps completed encrypted files 30 days and records safe metadata; Storage bytes and off-site copy/restore require separate acceptance.

[Step-by-step deployment/configuration/update guide](docs/DEPLOYMENT.md) and [separate-project restore guide](deploy/restore.md) cover the exact files, secrets, Auth/DNS, reboot, cron and limits. Page routes now load on demand; initial JavaScript is smaller. VPS/domain/SMTP are not prepared, so no live deployment, DNS, migration, real database backup or restore occurred here. P7 SMTP/reset refinements and P8 broader devices remain pending.
