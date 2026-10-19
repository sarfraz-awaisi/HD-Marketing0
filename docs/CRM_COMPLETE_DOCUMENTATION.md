# HD Marketing CRM

Complete Project Documentation

Administrator and Agent User Guide · Functional and Technical Reference

Updated: 16 October 2026

Prepared from the current project source, migrations and verification records. This manual documents implemented behavior through migration 036, with Gmail-only direct account creation and permanent six-digit account UIDs, including account deletion and aligned account controls, loading-performance improvements, system monitoring/deployment files, administrator email/password login, optional-agent authenticator verification and recovery, Facebook/Instagram Instant Form ingestion with admin-only incoming leads, secure administrator-managed invitations, recipient password setup, manual call logging, automatically visible authorized contacts, safe agent handover, administrator security alerts and current-owner Client KYC access. Existing hosted databases need missing migrations for the features they use; optional-agent MFA uses 025 after 024. Admin login no longer needs update 025. The latest database upgrade has not been applied to hosted Supabase by this work. New accounts need no email sender; existing password recovery and legacy mail retain their separate Supabase configuration. It contains no real account passwords, API keys, customer records or PINs.

## 1. Project purpose and current scope

HD Marketing CRM is a real estate sales workspace for administrators and sales agents. It organizes customer leads, imported lead files, assignments, conversations, follow-ups, site visits, deals, properties, targets and shared documentation. Administrators supervise the business and manage access. Agents work on their currently assigned leads and read the shared property and document libraries.

The application runs locally as a React website and an Express API connected to Supabase Authentication, PostgreSQL and private file storage. Its interface uses navy, white and gold, responsive layouts and accessible motion. Business amounts are shown in Pakistani rupees (PKR). Operational dates and times are displayed in Asia/Karachi; timestamp records are stored in UTC.

Implemented modules include separate Agent/Admin login, optional-agent authenticator verification, email-only suggestions, password visibility and recovery, dashboards, lead management and pipeline history, CSV/XLSX/XLS imports, whole-file task assignment, automatically visible authorized customer contacts, notes, production-capable manual call logs, development mock calls and outcomes, follow-ups, visits, deals, monthly targets, property cards and uploaded pictures, shared documents and policies, reports, audit history, personal admin PIN settings and protected account management with optional-agent authenticator recovery.

Facebook/Instagram Instant Form ingestion is implemented with a secure durable queue and awaits real Meta configuration/HTTPS acceptance. Live calling and WhatsApp messaging remain unconnected. Users call from their company phone and record the result manually without needing a calling provider. An explicitly labelled mock remains for development only. The code includes boundaries for future provider adapters and recording retention, but it does not make real calls or automatically create call recordings. A source label such as Meta or WhatsApp can be entered manually without activating an integration.

This document describes the current application. `docs/REMAINING_FEATURES.md` is a roadmap containing additional proposals; its presence does not mean those proposals are implemented. Features requiring migrations depend on those migrations being installed in the user's database.

For a partial database installation where contacts load but the administrator dashboard reports missing migration 019, `supabase/repair-security-alerts.sql` restores only security-alert storage/readers and service-only grants. It can be run repeatedly without modifying customer or alert history, hiding numbers or changing login policy. System monitoring remains a separate 026 installation. See `docs/PROTECTED_PHONE_NUMBERS.md`.

Administrators can delete another account from PIN-unlocked Accounts after typing its email in a confirmation dialog. Update 028 removes sign-in access, hides the account from management/assignment lists, returns leads/files to the admin pool and retains completed business history. Pending provider/audit failures remain blocked and retryable. Own-account deletion is refused and active-admin continuity is protected. Account controls have equal sizes and consistent responsive alignment. See `docs/ACCOUNT_DELETION.md`.

For the reported deletion prerequisite result 022 false / 023 false / 027 true, `supabase/repair-account-deletion-prerequisites.sql` reconciles the missing 022/023 features before installing 028 once. The repair preserves customer history and later Meta/performance/monitoring rules; unconfirmed accounts remain inactive until their inbox verification and invitation setup are complete. It is repeatable, keeps 028 wrappers when already installed and requests a database API schema refresh. See the deletion guide for copy/run steps.

The loading-performance update batches dashboard data and property cover photos, debounces searches, cancels obsolete list requests, preloads sidebar page code and uses the native Auth-only browser client. It adds query indexes and grouped leaderboard counts in 027 without changing permissions or login requirements. Existing databases keep compatible readers until 027 is installed. See `docs/PERFORMANCE.md` and the latest `VERIFICATION.md` entry for installation and measurements. Account/role changes and access denial clear cached workspace records.

## 2. Administrator and agent permissions

Every user needs a valid Supabase login with a confirmed email and an active CRM profile, plus completed account enrollment. Agent and Admin email OTP enrollment is completed by an existing PIN-unlocked admin inside Accounts. Administrators sign in with email/password, without an authenticator step. Agents require two-factor assurance when enabled by the server setting or already enrolled. The profile's saved role controls access. Selecting a login toggle cannot change a user's role. Agents' customer access follows current lead ownership; administrators can supervise the full workspace.

| Feature or action                                                | Administrator                                           | Agent                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Sign in                                                          | Use Admin with an active admin account                  | Use Agent with an active agent account                                     |
| Authenticator verification                                       | Removed; admins use verified email/password             | Optional unless required by server policy or already enrolled              |
| Reset another account's two-factor login                         | Admin plus PIN and confirmation; agent targets only     | No; ask another administrator for recovery                                 |
| Dashboard                                                        | Workspace metrics and operational lists                 | Own metrics, assigned leads and own targets                                |
| Lead list and customer profiles                                  | All CRM leads                                           | Only currently assigned leads                                              |
| Customer phone numbers                                           | Automatic for all leads; recorded/audited               | Automatic for assigned leads; recorded/audited                             |
| Create a lead                                                    | Yes                                                     | No                                                                         |
| Edit customer name, email, budget, source or interested property | Yes                                                     | No                                                                         |
| Update lead stage and lost reason                                | Any authorized lead                                     | Own assigned leads                                                         |
| Import CSV, XLSX or XLS                                          | Yes, through one picker                                 | No                                                                         |
| Assign an individual lead or use round-robin                     | Yes                                                     | No                                                                         |
| Assign an entire imported file                                   | Yes, to an active agent                                 | No; open assigned files to work their leads                                |
| Add notes and work with call outcomes                            | Any authorized lead                                     | Own assigned leads                                                         |
| Log manual phone calls                                           | Any authorized lead                                     | Own currently assigned leads                                               |
| Follow-ups, site visits and deals                                | Create/edit across the workspace                        | Create/edit for own currently assigned leads                               |
| Call review page                                                 | Yes                                                     | Use the call timeline within an assigned lead                              |
| Recording playback endpoint                                      | Admin only, when a valid recording exists               | No                                                                         |
| View property cards, details and pictures                        | Yes                                                     | Yes                                                                        |
| Create/edit/archive/delete a property                            | Yes; deletion requires no linked leads, visits or deals | No                                                                         |
| Upload/delete property pictures                                  | Yes                                                     | No                                                                         |
| Read/filter/download documents and policies                      | Yes                                                     | Shared categories and own clients' KYC                                     |
| Create/edit/delete documents or attachments                      | Yes                                                     | No                                                                         |
| Set or edit monthly targets                                      | Yes, for active agents                                  | No; view own targets and progress                                          |
| Team leaderboard                                                 | Names and aggregate completed-call/won-deal counts      | Same safe aggregate leaderboard                                            |
| Reports page and CSV report export                               | Yes                                                     | Own metrics are used by overview/targets; no Reports sidebar or CSV export |
| Team directory                                                   | Yes, read-only                                          | No                                                                         |
| Accounts                                                         | Active admin plus a valid personal PIN unlock           | No                                                                         |
| Admin settings / personal PIN                                    | Own admin security settings                             | No                                                                         |
| System status and readiness                                      | Read job/backup state; readiness is admin-only          | No                                                                         |
| Security alerts                                                  | Read/filter/review alerts and see unreviewed counts     | No                                                                         |
| Audit history                                                    | Read-only administrator page                            | No                                                                         |
| Bulk assignment / deletion / restore bin                         | Administrator only, up to 500 leads per action          | No                                                                         |
| Edit phone and owner                                             | Atomic administrator edit                               | No                                                                         |
| Reminders                                                        | Own reminders and dismissal                             | Own reminders and dismissal                                                |

The server enforces role and ownership checks even if someone manually enters a route or sends an API request. SQL mutation functions also check protected operations. Browser database roles cannot directly read the private phone vault or invoke protected CRM functions.

There are two roles, Admin and Agent. A Team Lead role, document-specific audiences and permissions for independently selected agent groups are not implemented. Non-KYC categories belong to the shared active-team library. Client KYC entries require a lead link: admins see all; agents see only entries for currently assigned clients. Older unlinked KYC is admin-only until linked. This is checked for lists, search, counts, detail, file lists and downloads; unauthorized requests return 404.

## 3. Sign-in, email suggestions and session behavior

### Selecting a portal

1. Open the CRM login page.
2. Select Agent or Admin; Agent is selected initially.
3. Enter the email registered for that account and its password.
4. Click the matching Sign in button.
5. Admins open the workspace after accepted email/password login. Only required or enrolled agents complete authenticator setup/verification.

Only an active, email-confirmed account whose saved CRM role matches the selected portal is accepted. An Admin account entered under Agent, or an Agent account entered under Admin, is rejected with instructions to choose the correct portal. The candidate login uses an isolated temporary Auth client. Its tokens are installed in the main browser session only after the server confirms the matching role and any required two-factor assurance. Rejected portal logins or wrong authenticator codes do not open a workspace or persist a candidate session. For required/enrolled agents, first setup offers a QR/private manual key; later agent logins request the current six-digit code. Admin login does not consult MFA storage, even if native factors or old reset records exist. Cancel discards the candidate. See Two-factor login and lost-phone recovery below for installation and recovery.

Changing the portal clears typed credentials and errors. While authorization is pending, portal changes and login controls are disabled. Accounts are provisioned by administrators; the CRM has no public self-registration form.

### Password visibility and email-only suggestions

The eye icon shows or hides the password typed into the field. The CRM's email dropdown fills only the email address. It remembers up to five recent successful emails separately for Agent and Admin on the same browser/device. An already authorized restored session also adds its own email to this history. Failed logins and accounts rejected by the selected portal are not saved.

Focus the email field to see saved addresses or type part of an email to narrow the list. Click a suggestion, or use Arrow Up/Down and Enter. Escape closes the list; Tab moves normally to the next control. On a browser with no saved history, enter the full email and successfully sign in once. Using another device, browser or origin creates a separate history.

The history stores email strings, never passwords or tokens. Login fields request that browser autofill stay off. A separately installed password manager or browser preference can still override that request. The user's configured password manager is independent of the CRM dropdown.

### Recovery, authorization refresh and sign-out

Forgot your password? requests a Supabase recovery email. Following the recovery link opens the new-password form. Recovery requires the project's email delivery and permitted redirect configuration to be working. Resetting an admin's Accounts PIN is a separate operation described in section 15.

The Auth provider restores saved sessions and rechecks the active CRM profile every 60 seconds. Rechecking the same authorized account keeps the page mounted, which avoids the earlier full-workspace reload during routine authentication refresh. Initial loading, a different account, failed authorization or navigation can still change the displayed page. Development code edits can trigger Vite's normal live refresh.

Sign out clears the workspace's query cache. Disabled accounts are rejected by subsequent API requests even when their Auth token has not yet expired.

## 4. Navigation, dashboards and notifications

### Administrator sidebar

Overview, Leads, Deleted leads, Task assign, Properties, Documentation & policies, Call review, Follow-ups, Site visits, Deals, Team targets, Team, Accounts, Admin settings, Reports, Audit history and Security alerts.

### Agent sidebar

My overview, My leads, Follow-ups, Site visits, My deals, Properties, My targets and Documentation & policies.

### Dashboard information

Administrator overview includes an unreviewed Security alerts count and link to review number-access warnings/limits. The sidebar badge shares this count. Administrator overview shows leads created, completed calls, completed visits and closed revenue for the current Pakistan month. Agent overview shows all currently assigned leads and today's completed calls, alongside monthly completed visits and closed revenue. Operational panels show the lead pipeline, overdue follow-ups, upcoming scheduled visits, won deals, due follow-ups and scheduled visit records. Agents also see their monthly target progress.

The leaderboard exposes agent names and aggregate completed-call and won-deal counts. It does not expose another agent's customer identities or phone numbers. Dashboard and target metrics are computed by the server's SQL aggregation, rather than by counting only the currently displayed page.

### Reminder bell and mobile navigation

The reminder bell shows unread reminders for the signed-in account and refreshes every minute. Open it to read due dates and click Dismiss to mark a reminder read. Reminders are generated by the background jobs described in section 18; the bell does not itself schedule jobs or send external messages.

On smaller screens, the menu button opens the sidebar. Navigation can be closed with its close button, the backdrop or Escape. Links open only sections appropriate to the signed-in role.

## 5. Lead management and visible customer contacts

### Administrator lead creation and editing

Open Leads and choose Add lead. Enter the customer name and valid phone number, plus optional email, source, minimum/maximum budget, preferred location, interested property and active assigned agent. Source choices are manual, CSV, Meta, WhatsApp and other. A maximum budget cannot be below the minimum; leaving the maximum open records no upper limit.

An administrator can edit the customer's name, email, source, budget, location and property interest. Assignments are changed through the assignment controls. The phone number is used as the unique customer identity and is not editable in the existing lead-edit form or lead-update API.

### Finding and opening leads

Lists support customer-name search, status, lost-reason and source filters with pagination. File-filtered lists retain those controls. Open a customer to see their contact information, budget, preferred location, creation/last-activity dates, current stage and activity timeline.

Administrators see all leads. Agents see only leads currently assigned to them. An agent can update the stage, record a lost reason, add notes and create or edit their authorized follow-ups, visits, deals and call outcomes, and log company-phone conversations. Agents cannot create/import leads, edit customer metadata or assign work to another person.

### Customer phone display

Full contacts appear automatically in ordinary lead lists, assigned-file lists and customer profiles. There are no Show/Hide controls, two-minute expiry or daily display quota. Admins see all leads' contacts; agents see only their currently assigned leads' contacts. Missing stored contacts display Number unavailable. A Call button beside each number on the lead list and profile opens the call dialog, which dials through the device's phone app (for example Microsoft Phone Link) and logs the result; Log a call records company-phone conversations made outside the CRM.

The API resolves only the requested page through service-only lead_contact_phones. SQL verifies the active actor and locks current lead ownership; a mixed or unauthorized selection fails as a whole. Each available contact appends to the private read ledger and writes a safe lead.phone_revealed audit in the same transaction. An audit failure returns no contacts and rolls the ledger back. Audit metadata contains identifiers/field names, never the full contact.

Contacts are held in account-scoped React Query memory with the authorized lead payload; the CRM does not persist them in localStorage or sessionStorage. Sign-out closes the workspace; account-scoped cached queries remain in browser memory until garbage-collected or the page closes. Subsequent API reads recheck ownership; previously rendered information cannot be remotely erased before the client receives refreshed session/assignment information. There are no extra per-row phone requests.

Agent JSON free text still masks common international/Pakistan phone formats; only SQL-authorized structured contact fields are returned in full. Original document binaries remain unchanged. Pattern masking does not detect every arbitrary written representation. Client KYC access is now restricted by current lead ownership through migration 022.

Migration 021 is required after 020. It leaves the existing private phone vault, reveal ledger and Security alerts history intact. Historical P2 SQL quota helpers/status remain for compatibility; PHONE_REVEAL_DAILY_LIMIT does not restrict automatic display and normal contact reads do not generate quota alerts. Admins can still review existing alerts with safe audits. The old POST /api/leads/phones batch endpoint remains removed. A loading failure shows an error without falsely claiming zero records. See docs/PROTECTED_PHONE_NUMBERS.md for the update command.

### Notes and activity history

Use Add note on a customer profile to save a written note. The timeline combines notes, calls, follow-ups, visits, deals, assignment records and lead-stage history. It shows timestamps, saved content and relevant dates. Retrieval is bounded to the latest 100 entries from each activity type.

The current CRM has no lead hard-delete action, general note editor or bulk customer export. Lifecycle updates and reassignment retain customer history. The administrator delete actions currently implemented apply to eligible properties, property pictures, document entries and document attachments.

### Permanent numbers, selection and recoverable deletion (029–032)

Both portals show the same permanent HD number, page-relative serial column and scoped list counts. Customer profiles, activity links, timelines and reminders carry the same identity. Leads search accepts the numeric number or its HD prefix. Admin file counts include assigned/unassigned members; agent counts include only current owned members. Dashboard totals reflect the current active-lead scope.

Admins can select rows/pages or all matching leads (maximum 500), with selection retained across pages and cleared on changed filters/completed actions. The action bar provides direct/round-robin assignment, unassignment, deletion and clearing; row controls provide quick assignment and editing. Bulk round-robin rotates through active agents in initial least-recent-assignment order, keeping batches balanced despite transaction timestamp ties; pending social leads still require an explicit receiving agent. Atomic editing now includes the private phone and assigned agent. Duplicate phone errors reveal only the conflicting HD number; recoverable duplicates direct the admin to restore. Agents keep their existing stage/loss, notes and activity permissions and see no bulk controls.

Deleted leads move to the administrator-only sidebar bin for 30 days, leave normal reads/counts/reports/KYC and return 404 by direct ID. Pending work is cancelled, unread reminders removed and the lead unassigned; won-deal leads are kept. Restore preserves the permanent number and history, leaves ownership empty and does not reschedule cancelled work. Task assign supports file-only removal or file-and-lead deletion with batch restoration. Confirmation requires a reason, shows affected work and requires DELETE for at least 20 leads. More than 50 deleted in a Pakistan day creates a critical alert and dashboard notice.

The jobs runner purges at most 200 expired leads daily, retaining audits and using durable recording/KYC storage cleanup. LEAD_DELETE_RETENTION_DAYS defaults to 30; jobs must run for erasure. See docs/LEAD_MANAGEMENT.md for all endpoints, retention semantics, Windows setup and the single 029–032 upgrade bundle. This bundle is for existing databases after 028; fresh setup is separate. No hosted installation or real customer erasure has been performed by development.

## 6. CSV, XLSX and XLS imports

The single Import CSV / Excel control in Admin → Leads accepts `.csv`, `.xlsx` and older `.xls` files. A separate native Choose File field is hidden behind this one control. Imports allow up to 5 MB, 1,000 lead rows and 32 columns. Excel reads the first worksheet with plain-text headers in row 1.

### Supported fields and header matching

| CRM field               | Required? | Meaning                                                                 |
| ----------------------- | --------- | ----------------------------------------------------------------------- |
| name                    | Yes       | Customer name; aliases include Full Name, Customer Name and Client Name |
| phone                   | Yes       | Valid customer number; aliases include Mobile Number and Contact No.    |
| email                   | No        | Valid email address or empty                                            |
| budget_min / budget_max | No        | PKR budget values; PKR-labelled header aliases are accepted             |
| preferred_location      | No        | Preferred location/area/city label                                      |
| property_id             | No        | Existing CRM property UUID                                              |
| assigned_agent          | No        | Active agent's exact name or UUID                                       |
| source                  | No        | Supported source field; imported leads use the CRM CSV source label     |

Case, spaces and punctuation in familiar headings are normalized. Unfamiliar, extra or ambiguous columns open Match file columns before any lead is created. Match customer name and phone, optionally match other supported fields, or choose Skip column. Fields already matched to another column are disabled there. Skipping a matched column releases its field for reuse. Required fields must remain matched.

Columns such as bedrooms, asking price, lead priority or an external lead ID are not automatically created as additional CRM fields. They must be skipped unless they genuinely correspond to a supported field. Skipped column values and original spreadsheet bytes are not retained in the CRM file-history module.

### Valid numbers, agents and row results

Format Excel phone cells as Text before entering numbers to preserve leading zeros and country codes. Pakistani `0300…`, `+92300…` and `0092300…` normalize to the same identity. Other countries' numbers need country codes. Text such as Phone 1 or an incomplete numeric value is rejected; the CRM does not generate customer numbers.

Matched spreadsheet formulas are rejected. Paste calculated values when preparing an import. A property reference must point to an existing property. Agent resolution checks active agent names or IDs. Unknown, duplicate-name, disabled or admin references do not cause an arbitrary assignment; otherwise valid rows remain unassigned and show warnings.

The results show accepted and rejected counts, row numbers, field-specific rejection reasons, skipped columns and assignment warnings. Valid rows can succeed while other rows are invalid or duplicate. The private normalized-phone unique constraint blocks duplicate contacts, including equivalent local/international formats.

### Import workflow

1. Prepare the CSV/Excel file with valid customer names and numbers.
2. Click Import CSV / Excel and select it.
3. Match or skip columns if the dialog opens.
4. Submit and review every row result.
5. Open the recorded file under Task assign to allocate its accepted leads.

Cancelling column matching creates no leads. Errors retain the file and mappings for correction/retry. Pending submission prevents repeated uploads and dismissal. A reupload is a new import attempt and still applies the normal duplicate-number rules.

## 7. Task assignment and agent file workflows

### Whole-file assignment by an administrator

Task assign lists imported files with filename, format, accepted lead count, rejected count, import date and assignment summary. Search filenames and use pagination to locate a file. Click Assign file, choose an active agent and confirm. Every accepted member of that file moves to the selected agent, including members previously assigned to another person.

The change is transactional: assignments, per-lead history and the file-level audit record commit together. Failure preserves prior assignments. Members already owned by the selected agent are skipped to avoid duplicate history. A wholly rejected or empty file cannot be assigned. Agents and inactive target accounts cannot perform file assignment.

### Individual assignment and round-robin

On a customer profile, an admin can assign one active agent or leave the selector blank for round-robin. Round-robin chooses the active agent with the least recent assignment, using UUID order to resolve ties. Database advisory and row locks serialize the assignment operation. Saving a lead without an assignee does not automatically distribute it; use these assignment controls or Task assign.

### Agent My leads

1. Open My leads to see assigned-file cards.
2. Click a file to open its leads as a list.
3. Search/filter the list, open customer profiles and record work.
4. Use Assigned files to return to file cards.
5. Use All my leads to include individually assigned and manual leads with no import file.

Visibility is based on each member lead's current owner, not just the file's historical assignee. If a file is split across agents, each sees its own members and count. Reassigning the whole file removes the former agent's access on subsequent requests and refreshed pages; historical activity remains attached to the customer.

### File history limitations

New history stores sanitized filenames, format, first worksheet name, counts and membership. It does not store or offer downloads of the original uploaded spreadsheet. Older imports are recovered into Earlier import groups where possible. Their original filename was never saved and may be displayed as unavailable.

## 8. Lead stages, lost reasons and automatic progression

| Stored stage    | Display/meaning                             |
| --------------- | ------------------------------------------- |
| new             | Newly created customer lead                 |
| contacted       | Customer contact activity has been recorded |
| interested      | Customer interest is recorded               |
| visit_scheduled | Site visit scheduled                        |
| visit_done      | Visit done                                  |
| negotiation     | Business discussion/negotiation             |
| won             | Won (booked)                                |
| lost            | Lost, with a required reason                |

Administrators and assigned agents can change stages through the customer profile. Selecting Lost requires a reason and allows a note up to 500 characters. Reasons are Price, Location, Budget, Not interested, No response, Bought elsewhere, Wrong number and Other. Lost records show the reason, note and loss timestamp. Leaving Lost clears obsolete loss details on the affected lead/deal record.

Every actual stage change records old/new stages, actor, timestamp and request context in history. The timeline displays those changes. Automated activities can advance an open lead: completing a call moves it toward Contacted; scheduling/completing a visit moves it toward Site visit scheduled/Visit done; deal activity moves it toward Negotiation, Won or Lost.

Automatic progression is forward-only and cannot reopen a Won/Lost lead or move it backwards after later progress. Manual authorized stage changes remain possible. A late provider/mock event does not overwrite a submitted outcome or reverse a terminal call status.

Changing a lead to Won alone does not create a won deal or add revenue. Financial metrics require the corresponding deal record, stage, value and close date described in section 11.

## 9. Calls, outcomes, deal tags and recordings

### Current call workflow

Open an authorized customer profile and choose Log a call after calling from the company phone. This works in production without a calling provider. Choose Call connected? (Connected / Not connected), the Pakistan-local call start, duration in minutes and remaining seconds, an outcome, notes and tags. Saving adds a Manual record to the timeline. Answered calls have Completed status and can advance a New lead to Contacted; unanswered calls have Failed status, do not advance its stage and do not count as completed calls.

Start defaults to the current Pakistan minute; enter the actual earlier start when appropriate. Agents can log calls from the past 48 hours and admins from the past 30 days. Two minutes of future clock skew are allowed. Duration is 0–7,200 total seconds, with at least one second for an answered call. Unanswered outcomes must be No answer, Busy or Wrong number. An admin log credits the currently assigned agent, or the admin when the lead is unassigned. Saving updates lead activity and stores the exact calculated end time. SQL rechecks ownership under a row lock; a reassigned lead cannot be logged by its former agent. Invalid fields and audit failures leave the call, stage and history unchanged.

Pending saves block repeated submission, input changes and dismissal. A failure retains the draft. Manual logs create no telephone call or audio recording; their Call review rows do not offer Recording. Administrators and current assigned agents can edit authorized saved outcomes; manual unanswered-call restrictions remain enforced.

With CALL_PROVIDER=mock outside production, an additional Development mock call button creates the labelled simulation. Complete mock call & add outcome finishes it and opens the outcome form. The browser obtains safe calling capabilities from the server; production and unconfigured-provider screens show Log a call and no mock controls. Disabled mock routes return 404 if requested directly.

Administrators can use Call review to filter calls by Method (Manual, Mock or Provider), status and agent; open the customer; review duration/outcomes/notes/tags; edit outcomes and request authorized existing recording playback. Timelines display the call method. Agents work with calls in their assigned customer's timeline and cannot open the admin Call review page or recording playback endpoint. Answered manual calls count through the existing report, target and leaderboard aggregates.

### Outcomes and tags

Outcomes: No answer, Busy, Wrong number, Interested, Not interested, Follow-up required, Site visit scheduled and Deal discussion. Outcome notes allow up to 4,000 characters. Tags: Hot lead, Warm lead, Cold lead, Budget mismatch, Location mismatch, Ready to visit and Ready to close. Multiple supported tags can be selected and edited.

Saving an outcome records the submitted result and notes. Selecting an outcome label does not itself create a separate follow-up, visit or deal; use the corresponding action on the customer profile. The missing-outcome job flags completed calls that still lack a submitted outcome after the configured grace period.

### Signed event boundary and recordings

The development event script sends a mock fixture through a verified HMAC boundary. Events are deduplicated by provider/event ID and update call state transactionally. Missing or invalid signatures are rejected. A real provider will require its own verified protocol and adapter.

If a valid private recording has been supplied by a supported integration, an admin can request a one-minute signed playback URL. Access refuses deleted or seven-day-old recordings. Retention defaults to seven days and can be shortened to 1–7 days. Jobs attempt both private Storage and provider-copy deletion and retain safe errors for retry. Recording audit history remains.

The current mock does not record real audio, and no real provider adapter has been connected. A Recording button or retention function therefore does not imply that playable recordings already exist. Actual provider recording capture and deletion need separate integration acceptance.

## 10. Follow-ups, visits and reminders

### Follow-ups

Create a follow-up from a customer profile or the Follow-ups page. Choose the customer when using the general page, enter the Pakistan-local due date/time, status and notes, then save. Statuses are Pending, Completed and Cancelled. Edit to reschedule or change the status. Filters show Due, Overdue, Upcoming and Completed records.

The jobs runner creates unread reminders for pending follow-ups due within the next 24 hours, including overdue items. Reminders go to the current active owner or the administrator holding unassigned pending work after handover. Repeated runs do not create another reminder for the same follow-up/due timestamp. Cancelling/completing the follow-up changes its operational status; reminder dismissal marks only the reminder read.

### Site visits

Create a visit from a customer profile or Site visits. Select the customer and property, enter scheduled Pakistan date/time, notes and status. Statuses are Scheduled, Completed, Cancelled and No-show. Edit the visit to record the actual result. Creating/changing a scheduled or completed visit can advance the lead's stage as described in section 8.

### Ownership and selection limits

Administrators can manage workspace activity. Agents can work only on activity attached to their currently assigned leads. The general forms show the first 100 lead/property choices; for a customer outside the general lead selector, open that customer's profile and use its activity action. Large searchable selectors have not yet been implemented.

No hard-delete button is provided for follow-ups or visits. Use their status fields to complete or cancel work while preserving history.

## 11. Deals and closed-business tracking

Create a deal from an authorized customer profile or the Deals/My deals page. Select the property, enter the expected/closed value in PKR, stage, optional close date and notes. Stages are Discussion, Negotiation, Won and Lost.

Only one deal record is allowed per lead. Edit that existing deal to change the stage rather than creating a second deal. Won requires a close date. Lost requires a reason and allows a note up to 500 characters. The deal tracks its responsible agent; the server resolves ownership instead of trusting a browser-supplied agent ID.

Administrators can see and edit workspace deals. Agents see deals connected to currently assigned leads. Reassignment preserves historical activity and responsible-agent fields, so a current-ownership filter may exclude historical work from the new agent's counts.

Closed revenue is the sum of the recorded values of won deals in the selected reporting period. It is a sales-performance measure, not a payment ledger, collected cash, commission calculation, invoice or accounting statement. Payments, commission splits, installment schedules and invoicing are not implemented.

## 12. Properties, uploaded pictures and full details

### Viewing properties in both portals

Both Admin and Agent see property cards with title, location, PKR price, area, property type and availability. A saved picture appears on the card when available. Multiple pictures show a photo count. Cards without pictures show No pictures added; a failed image has a readable unavailable state.

Click the picture or View property to open the details: price, availability, location, type, area, description and all uploaded pictures. The picture control is keyboard-accessible. Administrators have management controls in this window; agents can read the same information and view images.

### Administrator property management

Add/edit fields: title, location, price, type, area, area unit, availability and description. Form types are House, Apartment, Plot and Commercial. Area units are sq ft, marla and kanal. Availability choices are Available, Reserved, Sold and Archived. Area must be positive and price nonnegative.

Archive retains the property and existing customer/deal history. Permanent deletion is available only for properties with no linked leads, visits or deals and requires confirmation. Linked properties must be archived. Photo cleanup work survives a Storage interruption through a protected queue and is retried by jobs.

### Adding and managing pictures

Use Add pictures in Add property or Edit property to choose one or several nonempty JPEG/PNG/WebP files, up to 5 MB each. Preview selections, remove unwanted files and add more before saving. Selecting pictures alone does not save a property or upload them.

Save record first saves metadata, then uploads selected pictures. Inputs/removal controls and dialog dismissal are guarded while saving. With pictures, successful saving opens the gallery. Saving without pictures closes normally. Existing gallery controls also let an admin upload or delete pictures.

If metadata saving fails, no pictures upload. If a later picture fails, the saved property and completed uploads remain; retry uploads only pending selections to the same property. Closing after a partial failure discards unsaved selections and retains saved content.

### Image access and refresh

Photos are kept in private Storage. The API validates image signatures/MIME types and issues 60-second signed viewing links to active authorized users. Cards and the gallery share a query cache. Upload/delete refreshes both views; deleting the cover uses the next available picture. The open gallery renews links every 45 seconds. Loaded cards do not poll individually; a failed lazy-loaded image requests a renewed link once and then shows a fallback if it still fails.

## 13. Documentation and policies

The shared sidebar section supports written entries and PDF, DOC and DOCX attachments. Admins add, update and delete entries/files; agents search, filter, read and download them. There is no separate draft/publish or approval stage. Shared categories are available to the active team; Client KYC follows current lead ownership, and older unlinked KYC is admin-only.

### Categories and search

Filters are All, Property Deeds, Legal & NOC, Agency Policy, Client KYC, Tenancy Agreements and the existing Documentation category. Existing policy records retain their stored `policy` value and display as Agency Policy.

Search matches title, optional property name, keywords and written content without regard to case. Search and the category apply before pagination across the eligible data. Text inside uploaded attachments is not extracted for search.

### Administrator workflow

1. Open Documentation & policies → Add entry.
2. Enter a title, category and written content, or a description of the attached files.
3. Optionally enter Property name and Keywords.
4. Add PDF/DOC/DOCX files up to 10 MB each and remove unwanted selections.
5. Save. Open the reading page to review the text and attachments.
6. Use Edit to change the entry/add files, Delete file to remove one attachment, or Delete to remove the entry and attachments after confirmation.

Titles/property names allow 200 characters; keywords allow 500; content allows 50,000. Property name is a text label and does not require an existing property ID. Content preserves line breaks and is rendered as text, not executed as HTML.

Save failures retain inputs. After a partial attachment failure, retry updates the same saved entry and only uploads remaining files. Pending operations prevent repeat submission/dismissal. File downloads require an active authenticated account and are audited. Metadata lists do not expose private Storage paths.

### Agent workflow and file cleanup

Choose a category or search, open Read entry/the title and download an attachment. There are no agent mutation controls, and direct writes are denied. Files remain in the private knowledge bucket. Durable upload reservations and deletion queues allow failed cleanup to be retried; interrupted uploads become eligible after one hour.

The categories organize documents; they do not create ready-written legal deeds, policies, NOCs, customer KYC forms or tenancy agreements. Administrators supply the actual company text and files. Revision history, acknowledgements, document expiry and arbitrary per-document audiences are not implemented. Client KYC has its enforced current-owner rule.

### Client KYC linking and access

For Client KYC, the admin must search and select Client (lead) before saving or attaching a new file. The picker uses names and masked phones. The saved entry shows its linked client name. Check KYC not linked to a client to find old entries, then Edit, select the correct lead and Save entry. Agents see a KYC documents section on their client profile with links and authorized file downloads. Counts and search omit foreign/unlinked KYC. Downloads audit atomically before Storage access and recheck ownership before returning bytes. Already downloaded copies cannot be recalled.

## 14. Monthly targets, reports and metric definitions

### Targets

An admin opens Team targets → Set target, selects an active agent and the first day of the relevant month, and sets goals for completed calls, completed visits, won deals and closed revenue. There is one target row per agent/month. Edit updates the existing goals. Agents open My targets to read their own goals and actual progress.

Progress shows actual values against goals. Progress bars cap at their goals visually while text still reports actual counts. Reports and targets share the same SQL metrics so displayed pages are not the counting source.

### Reports

The admin Reports page supports From/Through dates, agent and source filters, numeric metrics and Export CSV. Through is inclusive in Pakistan time: the UI converts it to a half-open UTC range ending at the next local midnight. The CSV contains aggregate metrics and applies spreadsheet formula escaping; it is not a raw lead/customer download.

| Metric                                      | Definition                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lead totals and status/source distributions | Leads whose creation timestamp is in the range                                                          |
| Completed calls                             | Completed calls, including answered manual logs, counted by end timestamp; unanswered logs are excluded |
| Completed visits                            | Completed visits, counted by scheduled timestamp                                                        |
| Won deals                                   | Won deal records, counted by close date; one per lead                                                   |
| Closed revenue                              | Sum of those won deals' recorded expected/closed values                                                 |
| Assigned leads on agent overview            | Current count of leads assigned to that agent                                                           |
| Today's agent calls                         | Completed calls for the current Pakistan day                                                            |
| Due/overdue follow-ups and scheduled visits | Current operational counts independent of the report range                                              |
| Active agents                               | Current active agent profiles                                                                           |

Agent/source selection considers current lead ownership/source and the relevant activity agent. Historic reassignment is retained but can change how records appear under ownership filters. An agent's report API scope is limited to their own data even if a forged agent parameter is supplied. The full Reports page and export remain admin-only.

## 15. Accounts and the administrator's personal PIN

### Setting or changing the PIN

The recommended implemented location is Admin settings → Security, outside the locked Accounts page. This lets an administrator recover a forgotten PIN without first knowing it. Enter the current login password, a new four-digit PIN and its confirmation, then save. Leading zeros work. Each admin has a personal PIN; there is no default or shared PIN.

The server verifies the current password with a separate temporary Auth session. PINs use salted scrypt/HMAC hashing and a private server pepper. PIN/password values are not displayed in account details or audit records. A four-digit PIN is an extra gate for an authenticated admin, not a separate role or multifactor authentication.

### Unlocking and locking Accounts

Open Accounts and enter the PIN. The grant lasts 15 minutes and is bound to the exact authenticated session token. Five wrong attempts cause a database-enforced 15-minute lockout. Resetting through the login-password form clears a forgotten PIN/lockout and revokes previous personal grants.

Leaving Accounts, clicking Lock Accounts, reloading or grant expiry requires a new unlock. Local account data/dialogs are cleared on locking. Refreshed login tokens or revoked admin rights can also require another check. The unlock secret stays in page memory; only token/session hashes are stored in the database.

### What an unlocked administrator can do

| Account action                   | Behavior                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Browse/search/filter             | View accounts with UIDs (copy button), totals, role/access filters and pagination; search name, email or UID           |
| Read details                     | View UID, registered email, role, access, account dates, confirmation status and CRM activity counts                   |
| Create Agent/Admin               | Both roles: Gmail address, initial password and an automatic or manual six-digit UID; created immediately              |
| Earlier email-code requests      | Requests started before 036 can be resumed, resent or cancelled; older admin links remain supported                    |
| Edit                             | Change name, role and access; registered email remains read-only                                                       |
| Disable/enable                   | Confirm agent handover before disabling; preserve completed history; enabling does not return leads                    |
| Set password for another account | Set/confirm a replacement; the old password no longer works for new sign-ins                                           |
| Reset an agent account's MFA     | Confirm a PIN-protected native factor reset; old assurance is denied and replacement setup is required when applicable |
| Edit own account                 | Update own name; self-disable/self-demotion are refused                                                                |
| Protect administrator continuity | SQL serializes role/access changes and preserves an active administrator                                               |

Passwords require at least 12 characters and at most 72 UTF-8 bytes. New Agent/Admin creation (update 036) collects full name, role, a Gmail address, password and confirmation, and an **Account UID** choice. The email is trimmed, lowercased and must be a valid address ending exactly in `@gmail.com`; otherwise _Only valid @gmail.com email addresses are allowed._ appears inline. This checks syntax and domain only, not whether Google registered the mailbox. **Auto Generate UID** (default) draws a random six-digit UID from PostgreSQL's cryptographic generator. **Enter UID Manually** accepts exactly six digits from 100000 to 999999, checks availability, and shows _This UID is already assigned to another account. Please choose a different UID._ when taken. A manual UID is never replaced with a random one.

The server validates every field again. A PIN-gated SQL function then reserves the new Auth UUID, the UID, email, name and role under the shared account locks, refusing existing emails and assigned or reserved UIDs. The server creates the confirmed Supabase Auth user with the service-role key and the reserved UUID; the admin's session is untouched and no email is sent. The Auth trigger creates the profile, and a UID trigger copies the reserved UID, name and role in the same database transaction, so a failed profile insert also discards the Auth user. An audited transaction activates intended access. Only then does **Account Created Successfully!** show the name, email, role, UID and status (Active only when the account is active), with **Done**, and the list refreshes. Auth rejection releases the reservation; an ambiguous timeout is recovered through the reserved UUID; an unconfirmed outcome is released automatically after five minutes if no user exists; and a failed activation leaves a consistent disabled account with its UID for **Enable**.

UIDs are business identifiers, never passwords or tokens; the Auth UUID remains the identity. PostgreSQL enforces the range CHECK, UNIQUE, NOT NULL and a trigger that rejects any UID change. Migration 036 gives every existing profile a UID without changing emails, roles, passwords, PINs or lead ownership, records any replaced invalid/duplicate pre-existing values in `crm_private.account_uid_review`, and is safe to rerun. Accounts cards and details show UIDs with a copy button, search matches UIDs, the Team directory lists them, and every signed-in Admin or Agent sees a read-only Employee UID in **My profile** from the top bar. Requests started before 036 under the earlier email-code flow can still be completed or cancelled ([ACCOUNT_CREATION_OTP.md](ACCOUNT_CREATION_OTP.md)); `ACCOUNT_OTP_SECRET` and sender settings are needed only for those. Setup and verification queries: [ACCOUNT_UIDS.md](ACCOUNT_UIDS.md). No hosted migration or deployment was changed by local implementation.

Disabled accounts fail subsequent CRM API access, including requests from an already open browser. Agent disabling previews all owned leads, pending follow-ups and scheduled visits. Choose balanced sharing among active agents (default), one active recipient, or the admin unassigned pool. Every lead, including Won/Lost, transfers in the same transaction as disabling. Pending follow-ups, scheduled visits and future unread reminders follow the recipient; completed/cancelled activity and read/already-due reminders keep their historical agent. In admin mode the leads become unassigned and pending work belongs to the administering account. Editing access to Disabled opens this same confirmation; cancellation changes nothing. Enabling restores access and can clear an Auth ban without returning old clients. Setting another account's password does not promise immediate revocation of every already issued Auth token; disable CRM access if required.

Account deletion uses the existing typed-email confirmation and audited handover; completed business history is retained. Disable-and-handover remains available when account removal is unnecessary. Own-password recovery uses the existing Forgot password flow. A newly created admin sets their own personal PIN after login.

### Provisioning and partial failures

New users begin unconfirmed, without an initial password, with an inactive profile. Trusted server provisioning chooses the role and records invitation intent; only verified invitation/password acceptance can enable its intended access. User-supplied signup metadata cannot grant admin access. Auth administration and PostgreSQL are separate services; if final setup fails, the app reports that the account exists and asks for review rather than silently inviting duplicate creation.

Team is a read-only directory. The legacy user-edit endpoint is refused so account changes must pass through the PIN-protected Accounts workflow. The minimal directory needed by assignment selectors does not require opening account details. Accounts also offers optional-agent two-factor recovery. Admin accounts have no factor-reset button or mandatory MFA. A failed agent recovery remains blocked until an admin retries. The personal Accounts PIN still protects account management.

## 16. Audit history and data protection

Admin Audit history is a read-only paginated view of time, action, entity, actor, request ID and safe metadata. Database triggers prevent updates/deletes to audit rows. Important assignments, stage transitions, mutations, phone reads, document downloads, account actions and retention operations have audit behavior in their respective paths.

Audit metadata uses safe identifiers and changed-field names rather than password/PIN values, unlock secrets, whole customer payloads or raw provider metadata. Several protected SQL changes save their audit in the same transaction; an audit failure rolls those changes back. Auth/Storage operations that cross service boundaries have explicit partial-failure/retry behavior rather than claiming one universal transaction.

Full customer phones remain in a private schema. Server service credentials stay in the root server configuration; the client receives only the public URL/key. Browser roles have no direct CRM table or protected RPC permissions. Photo/document/recording buckets are private. API requests use verified Bearer tokens and active profiles; role/ownership checks govern reads and changes.

The API uses no-store responses, request IDs, bounded JSON/file sizes, input schemas, IP request limits, security headers and a controlled frontend origin. The IP limiter is in memory; production uses one API instance and explicit trusted proxy networks (loopback by default). Shared limiting is needed before scaling to multiple instances. These mechanisms do not replace real hosted acceptance and operational access management.

## 17. Responsive interface and animations

The layout adapts to phone, tablet and desktop widths. Cards/grids adjust columns, tables retain scrollable regions, dialogs remain within the viewport, long errors/content wrap and mobile navigation uses a drawer. The login toggle, password eye and email list support keyboard use and accessible labels. Native hidden file inputs remain hidden behind their visible picker buttons.

Animations include page entrances, staggered cards, restrained hover lift, button press/shine feedback, sidebar selection indicators, selected deal tags, dialog/toast entrances, progress bars, loading shimmer and reminder feedback. Disabled controls do not animate as active controls. Hover effects apply to suitable pointer devices. Reduced-motion preferences turn motion off while preserving static focus/selection feedback.

Normal API refresh and same-account authorization checks preserve the mounted page and form drafts. Several upload/account/deletion workflows guard repeated submissions and dismissal while pending. This does not promise that every network operation everywhere is resumable after closing the browser.

## 18. Background jobs and operational automation

Run `npm run jobs` in a separate terminal. Starting `npm run dev` does not start jobs. The runner performs an immediate tick, then repeats every `JOB_INTERVAL_SECONDS` (default 60; minimum 10). Local overlapping ticks are skipped. Database advisory locks and uniqueness protect applicable database jobs across instances.

| Job                      | Work and default behavior                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| deleteOldRecordings      | Remove recordings aged 7 days by default; allowed retention is 1–7 days. Private object/provider-copy failures remain retryable                     |
| reassignStaleLeads       | Reassign up to a bounded batch of nonterminal leads with no activity for 7 days; skip future pending follow-ups; requires an active admin and agent |
| followUpReminders        | Insert reminders for pending follow-ups due within the next 24 hours, including overdue items                                                       |
| missingOutcomeCheck      | Flag completed calls with no submitted outcome after 30 minutes by default                                                                          |
| cleanupPropertyPhotos    | Retry queued photo removal after an eligible property deletion                                                                                      |
| cleanupKnowledgeFiles    | Remove expired upload reservations/deleted document files and clear completed cleanup queue items                                                   |
| reportInactiveLeadOwners | Alert admins about inactive profiles still owning leads of any stage; no automatic reassignment                                                     |

Stale reassignment uses the normal audited round-robin operation and updates activity time, preventing immediate repeat assignment. A future pending follow-up protects the lead from this job. Won/Lost leads are skipped. No eligible agent means no reassignment. Inactive owners are excluded from automatic stale reassignment; the safety job raises one alert per owner/Pakistan day for explicit admin handover. An inactive account with leftover leads offers Details → Hand over remaining work.

Jobs retry failures on later ticks. The runner reports safe completion/failure messages; it is not an admin scheduling interface, email service, push notification service or WhatsApp automation. Provider recording removal cannot be certified until a real provider is connected and accepted.

## Deployment, monitoring and encrypted backups (migration 026)

Admin overview includes System status with real job/backup dates and stale/failed/missing warnings, polling every minute. Each of eight maintenance jobs writes a safe heartbeat after completion. An earlier job or heartbeat failure does not stop later work; local overlapping ticks are skipped. All jobs must have succeeded within five minutes for protected GET /api/health/ready to return 200; otherwise it returns 503. Migration 26 and database reachability are checked. GET /api/health/status returns safe diagnostics to admins. Agents cannot read operational state. Backup status does not gate readiness, and public /health is process liveness only.

Production startup validates real HTTPS origins, required server credentials, stable minimum-32-character webhook/PIN secrets, explicit bounded proxy trust and manual calling. Changing the PIN pepper requires existing admins to reset their PIN once with their login password. Admin login remains email/password and has no MFA/monitoring migration dependency.

| Deployment helper                                                       | Responsibility                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| deploy/ecosystem.config.cjs                                             | Separate API/jobs PM2 fork apps, explicit production env file, bounded restarts and logs                          |
| deploy/Caddyfile                                                        | HTTPS SPA/API routing, security headers, compression and distinct index/asset caching                             |
| databaseEnvironment / command / ledger / runBackup in deploy/backup.mjs | Validate TLS PG connection, isolate child credentials, stream ciphertext, record safe metadata and retain 30 days |
| deploy/backup.sh / cron.txt                                             | Private Node env loading, Linux flock and nightly 03:00 Pakistan schedule on a UTC VPS                            |
| deploy/install-node.sh                                                  | Ubuntu-only official Node 22 archive download and checksum verification                                           |
| deploy/restore.md                                                       | Operator-reviewed separate-project database/Auth/Storage restore and acceptance                                   |

The deploy directory contains a two-process PM2 ecosystem, Caddy SPA/API/cache/security configuration, official-archive Node installer, encrypted backup helper/wrapper, cron example and separate-project restore guide. pg_dump streams into age without a plaintext VPS dump; ciphertext gets a private file, atomic finalization, safe ledger and 30-day completed-file retention after success. Native secrets stay out of argv/audits. Storage bytes, off-site transfers, provider settings and a real restore are separate responsibilities. Native Caddy/age checks use synthetic local fixtures, not hosted customer data.

Routes load on demand with Suspense and recoverable chunk-load feedback. The initial JavaScript entry is smaller; total available route code remains needed as pages open. Mobile heading actions retain 44px tap targets rather than a column flex basis stretching them to 160px. docs/DEPLOYMENT.md and deploy/restore.md explain installation, secrets, DNS/HTTPS, Auth, PM2 reboot/logs, backup limits, updates and acceptance. P6 is complete locally; VPS/domain/SMTP, actual TLS, real cron/database backup/restore and physical devices are unprepared or unverified.

## 19. Architecture, packages and source organization

### Request and data flow

1. React renders role-appropriate pages and sends requests through the shared API helper.
2. Supabase Auth supplies the user's session token.
3. Express verifies native identity, signed claims and required two-factor/reset state, loads the active profile, then applies schema/role/ownership checks and request limits.
4. The server reads authorized records or calls protected PostgreSQL transaction functions.
5. Private Storage returns authorized signed images or audited document downloads.
6. Successful mutations invalidate the relevant client cache and update the visible page.

The browser does not use the public Supabase client to read CRM tables directly. That client handles authentication. The server's separate service-role client performs protected CRM access. The local frontend uses a `/api` proxy to the loopback server.

| Technology                                    | Use                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| React and React Router                        | Components, state, route protection and portal navigation                   |
| Vite                                          | Local development, module refresh and production browser bundle             |
| TanStack Query                                | API cache, loading/error states, refetching and invalidation                |
| React Hook Form and Zod                       | Form state and input validation                                             |
| Lucide React and CSS                          | Icons, responsive styling, motion and accessible feedback                   |
| Node.js and Express                           | API routes, verified request handling and jobs                              |
| Supabase SDK                                  | Auth, server Auth administration, PostgreSQL/RPC and private Storage        |
| Multer                                        | Bounded multipart uploads                                                   |
| csv-parse and SheetJS CE 0.20.3               | CSV, genuine XLSX and legacy XLS reading; CFB support reused for DOC checks |
| Helmet, CORS and express-rate-limit           | Security headers, controlled origin and request limits                      |
| Node crypto                                   | Event HMAC, random tokens, PIN hashing and digests                          |
| Vitest, Testing Library, Supertest and PGlite | Frontend, API and executable isolated PostgreSQL verification               |

React hooks such as useState/useEffect/useRef manage page state, lifecycle and pending guards. useQuery/useQueryClient load and refresh data. useForm/zodResolver handle form validation. Router links/hooks navigate to authorized record views. Native browser file inputs and object URLs provide local previews before upload.

### Important directories

| Directory                             | Contents                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| client/src/pages/admin                | Admin screens and shared role-aware dashboard, leads, properties and targets                      |
| client/src/pages/agent                | Agent activity/customer views and aliases for shared screens                                      |
| client/src/pages/shared               | Documentation and policies                                                                        |
| client/src/components                 | Reusable UI, lead/call/property/target controls and layout                                        |
| client/src/context and client/src/lib | Auth provider, API helpers, role login, email history, pipeline/category labels and photo queries |
| client/src/styles                     | Base responsive styles and supplied animation adaptation                                          |
| server/src/routes                     | CRM, accounts, documentation and webhook boundaries                                               |
| server/src/services                   | Imports, file validation, assignment, PIN/password checks and provider boundaries                 |
| server/src/middleware                 | Authentication, role, audit and limits                                                            |
| server/src/jobs                       | Retention, reassignment, reminders and cleanup                                                    |
| server/src/utils                      | Shared validators, phone normalization and CSV escaping                                           |
| supabase/migrations                   | Thirty-two ordered schema/transaction upgrades                                                    |
| scripts                               | Local configuration, setup, SQL bundle, mock event and live-check utilities                       |
| docs and VERIFICATION.md              | Feature guides, roadmap and recorded validation evidence                                          |

Several route/component files are compatibility re-exports. The actual shared CRM route logic is principally in `crm.routes.js`; this is not a separate backend implementation for every similarly named file.

## 20. Database tables and migration history

### Data model

| Table/schema                                         | Responsibility                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| auth.users                                           | Supabase-managed login identities                                                                                    |
| profiles                                             | CRM name, role and active access tied to Auth user IDs                                                               |
| leads                                                | Customer metadata, stage, current owner, property/budget/location and import membership                              |
| crm_private.phone_reveals                            | Successful per-account/per-lead contact-read ledger; historical usage totals                                         |
| security_alerts                                      | Protected warnings/critical notices and administrator review state                                                   |
| crm_private.lead_phones                              | Unique normalized customer phone identities                                                                          |
| assignments                                          | Per-lead agent assignment history                                                                                    |
| notes                                                | Written customer activity notes                                                                                      |
| calls                                                | Call method, answered state, start/end/duration, outcome, notes and tags                                             |
| crm_private.recordings                               | Private recording references, expiry/deletion state and retry errors                                                 |
| properties / property_photos                         | Property metadata and private image references                                                                       |
| targets                                              | Agent/month sales goals                                                                                              |
| followups / visits                                   | Scheduled customer work and result statuses                                                                          |
| deals                                                | One deal per lead, property, responsible agent, stage and value                                                      |
| reminders                                            | Agent-specific unread/read follow-up reminders                                                                       |
| audit_log                                            | Append-only important action history                                                                                 |
| meta_connections / meta_pages / meta_forms           | Admin integration selection and safe authorization metadata                                                          |
| meta_submissions / meta_notice_reads                 | Durable provider queue, attribution, linked customers and per-admin notice dismissal                                 |
| crm_private.meta_credentials / meta_page_credentials | Context-bound encrypted provider tokens; never browser readable                                                      |
| crm_private.meta_oauth_states / meta_answers         | Expiring hashed authorization sessions and private form/review contents                                              |
| integration_events                                   | Provider/event ID deduplication                                                                                      |
| lead_status_history                                  | Old/new stage, actor and loss/history context                                                                        |
| property_photo_cleanup                               | Durable photo cleanup queue                                                                                          |
| lead_imports                                         | Import filename/format/worksheet/count metadata                                                                      |
| knowledge_documents / knowledge_files                | Written shared entries, category/search metadata and private attachment records                                      |
| knowledge_file_cleanup                               | Durable document upload reservation/deletion queue                                                                   |
| account_invitations                                  | Current hashed invitation ticket, server expiry, delivery-request state, acceptance/cancellation and intended access |
| account_security / account_unlocks                   | Personal PIN state, lockout/version and hashed temporary session-bound grants                                        |
| crm_private.mfa_attempts / mfa_resets                | Durable verification outcomes/limits and blocked recovery state/old-session cutoff; no authenticator secrets         |
| crm_schema_versions / job_heartbeats / backups       | Version 26 marker, durable safe job outcomes and encrypted database backup metadata; browser reads revoked           |

Foreign keys connect activity to customers/properties/profiles. Unique constraints enforce normalized phone identity, one deal per lead, one target per agent/month, reminder deduplication and provider event deduplication. Mutable records use timestamp maintenance; recorded history is preserved.

### Ordered migrations

| Number | Work introduced                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001    | Profiles, roles, private schema and profile/timestamp triggers                                                                                          |
| 002    | Leads, private phones, assignments and notes                                                                                                            |
| 003    | Calls and private recording metadata                                                                                                                    |
| 004    | Properties, photos and private media buckets                                                                                                            |
| 005    | Monthly targets                                                                                                                                         |
| 006    | Follow-ups, visits and reminders                                                                                                                        |
| 007    | Deals and single-lead deal constraints                                                                                                                  |
| 008    | Audit log, append-only protection and event IDs                                                                                                         |
| 009    | RLS/access restrictions and private-phone boundary                                                                                                      |
| 010    | Atomic assignments, lead creation, validated mutation and SQL metrics/leaderboard                                                                       |
| 011    | Call event application, recording access/retention and database jobs                                                                                    |
| 012    | Updated pipeline, lost reasons, stage history and automatic forward progression                                                                         |
| 013    | Eligible property deletion and durable photo cleanup                                                                                                    |
| 014    | Import-file history, recovered legacy groups and whole-file assignment                                                                                  |
| 015    | Shared written documentation, private attachments and cleanup                                                                                           |
| 016    | Personal admin PINs, temporary grants and protected account management                                                                                  |
| 017    | Document categories, property names, keywords and expanded search                                                                                       |
| 018    | Manual call logging, methods/answered state, mock classification and transactional validation/auditing                                                  |
| 019    | Protected single phone reveals, Pakistan-day quotas, private reveal ledger and administrator security alerts                                            |
| 020    | Audited account email confirmation requests, safe resend and API confirmation gate                                                                      |
| 021    | Automatically visible authorized lead contacts with page-scoped SQL reads and atomic safe audits                                                        |
| 022    | Atomic agent disable/handover, pending-work transfers, inactive-owner alerts and current-owner Client KYC                                               |
| 023    | Secure admin invitations, inactive new profiles, recipient password setup, lifecycle/expiry/cancellation and activation guards                          |
| 024    | Meta OAuth, encrypted credentials, signed durable Instant Form ingestion, admin-only incoming leads, explicit assignment guards, review and attribution |
| 025    | Historical P5 MFA schema, now used for optional-agent verification/limits/recovery after the user removed admin MFA                                     |
| 026    | RLS-protected schema marker, job heartbeat/backup metadata and safe admin operational status                                                            |
| 027    | Loading-performance indexes, grouped leaderboard, authorized dashboard snapshots and batch property cover readers                                       |
| 028    | PIN-protected account deletion, native Auth confirmation, pending-work handover, history retention and recoverable completion                           |
| 029    | Permanent generated lead numbers, creation-order backfill and current scoped totals                                                                     |
| 030    | Admin-only 500-lead bulk assignment with row outcomes and pending-work handover                                                                         |
| 031    | Atomic administrator metadata/owner/phone edits with private conflict messages                                                                          |
| 032    | Deleted leads bin, soft deletion, file recovery, deleted-aware reads and daily purge/cleanup                                                            |
| 033    | Agent email OTP entered in Accounts, initial password setup, attempt/claim/expiry guards and safe account reader fields                                 |
| 034    | Extend native email codes to new Admin accounts, bind proof to issued role and preserve older invitations                                               |
| 035    | Independent pending OTP requests before Auth creation, durable limits, original-password binding, idempotent provisioning and partial-user guards       |
| 036    | Permanent six-digit account UIDs with backfill/repair, Gmail-only direct account creation reservations, UID search and audited activation               |

`supabase/setup.sql` is the generated fresh-install bundle of all 37 migrations and the safe property seed. Individual migrations update existing installations in order. The seed can create a sample property such as Park View; a seeded property is demonstration inventory, not a newly synchronized real listing. The setup script does not create fake login accounts in SQL.

## Facebook and Instagram Instant Forms (migration 024)

Admins can open Integrations → Meta Lead Ads to connect an authorized business account, select Pages/forms, map custom questions, activate/pause synchronization, refresh forms, check a bounded recent history and disconnect locally. Stored tokens are server-only encrypted credentials; agents have no integration access. Real app configuration, review, public HTTPS delivery and test-lead acceptance are pending.

Incoming social leads displays real submission/platform/review/failure counts, filtered paginated customer enquiries, full authorized contact phones, source/campaign/form details, private unexpired answers and assignment history. Administrators correct missing names/phones without creating fake customer identities. A repeated provider ID is ignored; a new enquiry from an existing normalized phone preserves that customer's owner, status, notes and deals.

Every new social customer starts unassigned and is invisible to ordinary agents. Database guards and stale-job exclusion keep it pending until an admin explicitly selects one active agent. Individual assignment and bulk assignment (up to 100 distinct customers) use existing assignment/audit history; bulk is all-or-nothing and refuses stale/conflicting selections. The assigned agent can then work the customer through the ordinary lead/call/follow-up/visit/deal workflow. Other agents remain denied; raw advertising submissions stay admin-only.

Sidebar/overview counts and per-admin dismissible notices poll saved events. The current-month attribution report distinguishes submissions from the first-Meta-inquiry unique-customer cohort, current stages, completed visits, won deals and existing recorded closed value. Times display in Asia/Karachi and money in PKR. Unknown source placement remains Meta/unknown. Custom answer data expires after the configured 1–90 day retention, default 30; canonical CRM identity and safe attribution/history remain.

Webhooks verify exact-byte HMAC, persist before acknowledging and process through fenced durable worker leases. Temporary failures retry with bounded backoff; token failures require reconnect. Source tables, complete endpoint list, credentials, permissions, external Meta/deployment requirements, limitations and actual test procedure are documented in `docs/META_LEAD_ADS_INTEGRATION.md`. No website forms or messaging/calling are included, and real Meta acceptance has not been claimed.

### Meta endpoints and configuration

All paths below begin `/api/integrations/meta`. Only challenge/ingress/callback are public; all administration uses authenticated, active, confirmed Admin authorization.

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

Server-only settings are META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID, META_GRAPH_VERSION, META_OAUTH_REDIRECT_URL, META_WEBHOOK_VERIFY_TOKEN and META_TOKEN_ENCRYPTION_KEY (64 hex characters), plus META_ANSWER_RETENTION_DAYS (1–90, default 30). Existing FRONTEND_URL sets the fixed CRM origin. None belongs in VITE client variables. HTTPS deployment, the Meta app/business configuration, appropriate approved permissions, app-level Page leadgen subscription and supervised jobs are required for actual delivery. Real Meta acceptance remains pending; full external setup is in the dedicated guide.

## Administrator login and optional-agent MFA (preserved migration 025)

The user removed mandatory administrator two-factor login after P5 was implemented. Admins now use verified email/password; the server still verifies native identity/signed claims, confirmed inbox, active profile and saved role. Existing native factors or historical reset states do not force an admin code step. No migration 025 is needed for admin login. Admin settings explains password/PIN access; Accounts has no admin-factor reset button.

Agents are optional by default. An unenrolled optional agent also works without 025. REQUIRE_AGENT_MFA=true or an already-enrolled TOTP factor requires native setup/verification through the isolated candidate flow and preserved 025 schema. Their verified same-user AAL2, active saved role and private reset cutoff are checked before main-session installation or protected business access. Five rejected codes in 15 minutes create a critical alert and limit retries; provider outages are distinct. Codes and setup secrets stay out of CRM records/audits.

A PIN-unlocked admin can reset an agent account's factors with confirmation. Durable blocked staging, safe audits, old-token denial and operation fences remain; partial failure stays recoverable for retry. Administrator reset targets and verification requests are refused before native calls. Existing migrations, native factors and private state were preserved; no hosted factor deletion or database change occurred. See docs/ADMIN_TWO_FACTOR_LOGIN.md for current policy, optional-agent setup, recovery and acceptance.

## 21. Core technical functions and protected transactions

### Authentication, UI and shared helpers

| Function/component                                                      | Responsibility                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Protected / AuthProvider / useAuth                                      | Guard pages, restore/recheck authorized active profiles and expose logout/recovery state             |
| signInToPortal / createLoginClient                                      | Isolate candidate login and authorize the selected saved role before installing tokens               |
| prepareMfa / completeMfa / restoreMfa / MfaChallenge                    | Private TOTP setup/verification and restored-session gates before accepted main-session installation |
| savedLoginEmails / rememberLoginEmail                                   | Read/write bounded role-separated email-only device history                                          |
| EmailSuggestionsInput / PasswordInput                                   | Keyboard email list and typed-password visibility                                                    |
| api / download                                                          | Attach Bearer authorization, encode JSON/multipart, surface safe errors and download blobs           |
| pkr / date / localISO / localInput / monthRange / reportSearch          | Money/date display, Pakistan-local input conversion and reporting ranges                             |
| RecordForm / ActivityForm / OutcomeForm                                 | Shared validation/save behavior and specialized activity/call inputs                                 |
| outcomeSchema / callMethodLabel                                         | Manual-call validation, unanswered outcome restrictions and shared call-method labels                |
| LeadPhone / PhoneReveal                                                 | Automatically render authorized full contacts with no Show/Hide controls; profile tap-to-call links  |
| SecurityAlerts / useSecurityAlertSummary / securityAlertLabel           | Administrator review workflow, shared sidebar/dashboard counts and readable alert types              |
| LeadStatusControl / LostReasonForm                                      | Stage updates with required loss reason and bounded notes                                            |
| ImportedFiles / assignFile                                              | Admin file allocation and agent file cards                                                           |
| PropertyForm / PropertyPhotoPicker / SelectedPicture                    | Property inputs, optional multi-image selection and released preview URLs                            |
| PropertyCard / PropertyDetails / PhotoGallery / usePropertyPhotos       | Saved card images, complete shared details, admin gallery controls and signed-image cache            |
| Documentation / EntryForm / EntryEditor                                 | Shared readers/filters and administrator entry/file workflows                                        |
| Accounts / AccountDetails / AccountDialog / AdminSettings               | PIN unlock lifecycle, account operations and personal security settings                              |
| TargetCard / TargetProgress / Dashboard / Reports                       | Goal comparison and authorized SQL aggregates                                                        |
| Button / Modal / Table / Pagination / Loader / ErrorBox / ToastProvider | Consistent responsive interaction, bounded navigation and feedback                                   |

### API services and validation

| Function                                                          | Responsibility                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| leadContacts / phoneRevealLimit / phoneAccessRpc / securityRouter | Load audited page contacts, translate private errors and preserve historical usage/alert routes          |
| maskAgentResponse / protectAgentPhones                            | Mask agent free text; return full structured contacts only from authorized SQL results                   |
| createApp / crmRouter                                             | Compose API middleware, routes, safe errors and CRM handlers                                             |
| auth / adminOnly / ownedLead                                      | Verify identity/active profile and enforce role/current customer ownership                               |
| unwrap / checked / result / fileRpc                               | Translate database/service results into scoped API errors                                                |
| audit                                                             | Persist a safe request-linked audit entry                                                                |
| getAdmin                                                          | Create the server-only Supabase service client                                                           |
| normalizePhone / phoneMask / csvCell                              | Normalize unique contact identity, mask ordinary records and escape spreadsheet output                   |
| parseLeadImport / csvRecords / excelRecords / leadRows            | Read files, normalize headings, validate matching/limits and build import rows                           |
| resolveImportAgents / importValidationMessage                     | Resolve exact active agent references and produce field-specific errors without customer-value dumps     |
| importLeadFile                                                    | Prepare validated rows and persist import history/results through SQL                                    |
| assign                                                            | Invoke the protected assignment transaction                                                              |
| validateDocumentFile / checkDocx                                  | Check bounded PDF/DOC/DOCX formats and safe DOCX directory structure                                     |
| digest / pinSecret / hashPin / matchesPin / verifyAdminPassword   | Hash grants, choose the private pepper, hash/check PINs and reauthenticate admin passwords               |
| accountsRouter / documentsRouter                                  | Enforce account gates and document permissions/workflows                                                 |
| verifySignature / webhooksRouter                                  | Verify raw fixture HMAC and apply deduplicated mock events                                               |
| callingProvider / initiate / deleteRecording                      | Provide explicit development mock behavior; reject missing real provider configuration                   |
| manualCall / callCapabilities                                     | Strict manual-log validation, split-to-total duration conversion and server-authorized mock availability |
| metaLeads / whatsapp                                              | Meta durable ingestion worker / disabled WhatsApp boundary                                               |

Validators such as `leadCreate`, `leadUpdate`, `agentLeadUpdate`, `dealCreate`, `dealUpdate`, `manualCall`, `schemas` and `listQuery` restrict field names, statuses, ownership-sensitive changes, numbers, UUIDs, pagination and loss requirements. Agents' lead updates allow only stage/loss fields. The function inventory in section 26 records module names and local helper names from the current source.

### PostgreSQL functions

| Function/group                                                            | Transactional work                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| phone_reveal_window / phone_reveal_status / reveal_phone                  | Historical P2 compatibility: Pakistan day/usage and quota-enforcing single reveals                                                         |
| security_alerts_summary / security_alerts_page / review_security_alert    | Administrator-only filtered alert counts, listing and atomic idempotent review                                                             |
| create_profile / touch_updated                                            | Provision default agent profiles, recognize trusted inactive account staging and maintain timestamps                                       |
| block_audit_changes                                                       | Refuse audit update/delete                                                                                                                 |
| lead_contact_phones                                                       | Authorize and lock page contacts; atomically audit full-number reads without a display quota                                               |
| private_phone                                                             | Service-only private contact lookup after API authorization                                                                                |
| create_lead                                                               | Create lead, private phone, audit and optional assignment together                                                                         |
| assign_lead                                                               | Recheck admin/active agent, lock, choose round-robin when requested and record ownership/history                                           |
| crm_mutate                                                                | Strict entity/field allowlists, actor/ownership checks, row locks, timestamps and auditing                                                 |
| prepare_lead_status / record_lead_status_change                           | Validate stage/loss values and persist actual stage-change history                                                                         |
| advance_lead_status                                                       | Authorized forward-only automatic stage changes and terminal protection                                                                    |
| crm_metrics / crm_leaderboard                                             | Full-dataset scoped metrics and safe aggregate ranking                                                                                     |
| apply_call_event                                                          | Deduplicate verified events and protect monotonic call/outcome state                                                                       |
| log_manual_call / prepare_call_method                                     | Lock and validate authorized call logs, save exact timing/outcomes, advance eligible stages and audit atomically; classify mock references |
| recording_access / recording_batch / recording_deleted                    | Enforce access age, select expired records and save deletion/retry state                                                                   |
| run_crm_job                                                               | Locked reminder, stale-assignment and missing-outcome work                                                                                 |
| delete_property                                                           | Refuse linked deletion; remove eligible property metadata with cleanup queue/audit                                                         |
| import_leads                                                              | Create import metadata and accepted leads with per-row errors                                                                              |
| lead_import_summary / lead_imports_page                                   | Scope file visibility/counts by current member ownership                                                                                   |
| assign_lead_import                                                        | Atomically allocate accepted file members and their audited assignment history                                                             |
| save_knowledge_document / list_knowledge_documents                        | Validate/save text/category/search metadata and authorize literal filtered listing                                                         |
| delete_knowledge_document / attach_knowledge_file / delete_knowledge_file | Administrator-only entry/file mutation with audit and cleanup reservations                                                                 |
| accounts_admin / accounts_gate                                            | Recheck active administrator and valid matching temporary grant                                                                            |
| save_accounts_pin / unlock_accounts / lock_accounts                       | Rotate personal PIN state, persist attempts/lockout and issue/revoke hashed grants                                                         |
| accounts_page / account_detail                                            | PIN-gated account lists/details with safe activity data                                                                                    |
| update_account / account_action                                           | Serialized role/access/name changes, administrator continuity and audited account intent/results                                           |

Protected functions revoke execution from browser roles and grant it to the server role. The function of a transaction is scoped: it does not make a network call to Auth or Storage part of the same PostgreSQL commit.

## 22. API reference

All CRM routes require an active verified Bearer account. Admin-only and current-ownership conditions below apply in addition. Accounts requests need a session-bound `X-Accounts-Unlock` grant after PIN verification. General request limits are 300 per 15 minutes per IP; selected sensitive routes are 30 per minute, with additional account-specific limits.

| Endpoint                                                   | Authorized use               | Purpose                                                                 |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| GET /health                                                | Public                       | Secret-free API status                                                  |
| GET /api/me                                                | Active account               | Current profile; optional selected portal check                         |
| GET /api/call-capabilities                                 | Active account               | Secret-free manual/mock/provider availability                           |
| GET /api/leads                                             | Admin / own agent scope      | Paginated search/status/source/loss/file filtering                      |
| POST /api/leads                                            | Admin                        | Create a validated customer                                             |
| GET /api/leads/:id                                         | Admin / assigned agent       | Read customer details                                                   |
| PATCH /api/leads/:id                                       | Admin / assigned agent       | Metadata for admin; stage/loss fields for agent                         |
| POST /api/leads/import                                     | Admin                        | One multipart CSV/XLSX/XLS upload plus optional mapping                 |
| GET /api/lead-imports                                      | Admin / owned file members   | Filename search and paginated file metadata                             |
| GET /api/lead-imports/:id                                  | Authorized file scope        | Current-ownership file summary                                          |
| POST /api/lead-imports/:id/assign                          | Admin                        | Whole-file assignment to an active agent                                |
| GET /api/leads/:id/phone                                   | Admin / assigned agent       | Authorized audited no-store number; current ownership checked           |
| GET /api/phone-reveals/status                              | Active account               | Own Pakistan-day reveal totals only                                     |
| GET /api/security-alerts; GET /api/security-alerts/summary | Admin                        | Filtered alerts and unreviewed counts                                   |
| PATCH /api/security-alerts/:id                             | Admin                        | Idempotent Mark reviewed with safe audit                                |
| POST /api/leads/:id/assign                                 | Admin                        | Individual assignment; null requests round-robin                        |
| GET /api/leads/:id/timeline                                | Admin / assigned agent       | Bounded combined customer history                                       |
| POST /api/leads/:id/call                                   | Admin / assigned agent       | Create a configured development mock call                               |
| POST /api/leads/:id/calls/manual                           | Admin / assigned agent       | Sensitive-limit validated manual call log; returns 201                  |
| GET /api/calls                                             | Admin / owned lead scope     | Call list/filtering                                                     |
| PATCH /api/calls/:id                                       | Admin / owned lead scope     | Save outcome, notes and supported tags                                  |
| POST /api/calls/:id/mock-complete                          | Authorized, development mock | Finish mock call                                                        |
| GET /api/calls/:id/recording                               | Admin                        | Short-lived valid recording playback link                               |
| GET /api/properties                                        | Both roles                   | Paginated property inventory                                            |
| POST /api/properties                                       | Admin                        | Create property                                                         |
| PATCH /api/properties/:id                                  | Admin                        | Edit/archive property                                                   |
| DELETE /api/properties/:id                                 | Admin                        | Delete only an unlinked property                                        |
| GET /api/properties/:id/photos                             | Both roles                   | Authorized signed pictures                                              |
| POST /api/properties/:id/photos                            | Admin                        | Multipart JPEG/PNG/WebP, maximum 5 MB                                   |
| DELETE /api/properties/:id/photos/:photo                   | Admin                        | Remove a saved property photo                                           |
| GET /api/targets                                           | Admin / own agent            | Paginated target list                                                   |
| POST /api/targets; PATCH /api/targets/:id                  | Admin                        | Create/edit monthly targets                                             |
| GET/POST /api/followups; PATCH /api/followups/:id          | Admin / assigned lead scope  | List/create/edit follow-ups                                             |
| GET/POST /api/visits; PATCH /api/visits/:id                | Admin / assigned lead scope  | List/create/edit visits                                                 |
| GET/POST /api/deals; PATCH /api/deals/:id                  | Admin / assigned lead scope  | List/create/edit one deal per lead                                      |
| POST /api/notes                                            | Admin / assigned agent       | Add a customer note                                                     |
| GET /api/documents                                         | Both roles                   | Literal category/property/keyword/content search and pagination         |
| GET /api/documents/:id                                     | Both roles                   | Written content and safe attachment metadata                            |
| POST /api/documents; PATCH /api/documents/:id              | Admin                        | Create/edit entry/category/search fields                                |
| DELETE /api/documents/:id                                  | Admin                        | Remove entry and queue attachment cleanup                               |
| POST /api/documents/:id/files                              | Admin                        | Multipart PDF/DOC/DOCX, maximum 10 MB                                   |
| DELETE /api/documents/:id/files/:file                      | Admin                        | Remove attachment                                                       |
| GET /api/documents/:id/files/:file/download                | Both roles                   | Audited private binary download                                         |
| GET /api/users                                             | Admin                        | Minimal team/assignment directory                                       |
| PATCH /api/users/:id                                       | Refused                      | Direct account edits must use PIN-gated Accounts                        |
| GET/PUT /api/account-security                              | Admin                        | Own PIN status or password-verified set/reset                           |
| POST /api/account-security/unlock                          | Admin                        | Verify PIN and issue temporary grant                                    |
| POST /api/account-security/lock                            | Admin                        | Revoke current grant                                                    |
| GET/POST /api/accounts                                     | Admin plus grant             | List/search (incl. UID) accounts or create a Gmail account with a UID   |
| GET /api/accounts/uid-availability                         | Admin plus grant             | `{uid,available}` advisory check for a manual UID                       |
| GET/PATCH /api/accounts/:id                                | Admin plus grant             | Read account/activity or edit name/role/access                          |
| POST /api/accounts/:id/verification                        | Admin plus grant             | Empty body; resend inbox confirmation to registered email; safe audit   |
| POST /api/accounts/:id/password                            | Admin plus grant             | Set another account's password                                          |
| GET /api/reminders; PATCH /api/reminders/:id               | Own reminder scope           | List unread reminders or dismiss                                        |
| GET /api/dashboard                                         | Admin / own agent workspace  | Authorized aggregate snapshot; compatible readers until 027             |
| GET /api/reports                                           | Admin / own agent metrics    | Scoped full-dataset aggregation                                         |
| GET /api/reports/export                                    | Admin                        | Aggregate CSV export                                                    |
| GET /api/leaderboard                                       | Both roles                   | Names and aggregate call/deal ranking                                   |
| GET /api/audit                                             | Admin                        | Read append-only audit history                                          |
| POST /api/webhooks/mock                                    | Verified fixture signature   | Development event boundary; ordinary user login is not its verification |

Manual JSON requires answered, timezone-qualified started_at, duration_seconds and outcome, with optional duration_minutes, notes and deal_tags. Seconds mean the total if minutes are absent; with minutes present, seconds must be 0–59. The server converts to total seconds before SQL. GET /api/calls?method=manual|mock|provider filters before pagination; unsupported method filters are refused. A missing manual-call function returns 503 naming migration 018; another agent's customer returns 404. The old initiation/completion routes are mock-only and return 404 when unavailable.

Lists default to 20 rows and allow 1–100, with bounded search/page values. JSON bodies are limited to 256 KB. Unknown/malformed fields and identifiers are rejected by strict schemas. Missing/invalid sessions return 401; forbidden access typically returns 403 or an ownership-scoped 404; duplicates use 409; unavailable providers or missing required migrations can return 503.

Migration 022 adds GET /api/accounts/:id/offboard-preview (counts only) and POST /api/accounts/:id/offboard (strict mode, target and optional name/role changes), both requiring an active admin, sensitive rate limit and current PIN grant. GET /api/documents/clients is an admin-only masked client picker. Document lists accept lead_id and the admin-only unlinked_kyc filter; KYC detail/file/download requests use current-owner SQL helpers. New KYC requires lead_id; other categories clear it.

New onboarding API routes are POST /api/onboarding/context and POST /api/onboarding/complete, requiring a trusted native verified recipient and current invitation ticket. POST/DELETE /api/accounts/:id/invitation are admin/PIN-protected resend/cancel routes. No unrestricted registration is introduced.

## 23. Setup, commands and configuration

### Existing configured workspace

Run commands from the project directory, not the user's home folder:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
npm run dev
```

Open `http://localhost:5173`. The API health URL is `http://localhost:3001/health` with the default port. Keep the development process running. In a second terminal, run `npm run jobs` from the same project directory if background automation is needed.

### New installation or connection

Use a supported Node version (project requirement 22.12+), install dependencies with `npm ci`, and copy `.env.example` to `.env` if the file does not already exist. `npm run configure` prompts for the Supabase connection and optional development accounts without displaying secrets. For existing Auth accounts, use `npm run configure -- --connection-only`, skip account-creation setup and sign in using the existing account.

In a fresh hosted project, copy/run `supabase/setup.sql` through Supabase SQL Editor. It combines all 37 migrations and the optional sample property seed in one transaction and refuses an existing profiles table. It does not create login accounts. A local Docker/Supabase CLI installation can use `supabase start` and a local `supabase db reset`; reset rebuilds that local development database.

Existing hosted databases receive only missing numbered migrations in order. Do not run the fresh-install bundle over an existing database. On macOS, `pbcopy < supabase/migrations/018_manual_call_logging.sql` copies migration 018; paste/run it once only after 017. Then copy/run supabase/migrations/019_protected_phone_numbers.sql once after 018, 020_account_email_confirmation.sql once after 019, and 021_visible_lead_contacts.sql once after 020. Missing 021 prevents loading full-contact lead pages; it does not delete existing leads. If the error persists after 021, use the repeatable supabase/repair-visible-lead-contacts.sql script in the same project used by the CRM. It preserves records and existing history, restores a missing phone-read history table, installs or replaces the function, restores restricted access and requests a database API cache refresh. Verify phone_history_ready, phone_function_installed and server_access_ready are all true, then refresh the CRM. If the repair stops on prerequisites, run supabase/check-visible-lead-contacts.sql first; it returns five table-presence flags with no customer data. The repair restores a missing phone_reveals table using migration 019's restricted schema, and names missing core tables explicitly. Missing core tables require checking the project and earlier setup. This targeted contact repair does not install all remaining P2/email-confirmation features or mark their migrations fully installed. An existing contact function does not prove its referenced tables exist. Use docs/PROTECTED_PHONE_NUMBERS.md to choose the verified missing upgrade. Success. No rows returned is normal for a schema upgrade. Property-card picture display needs no additional migration beyond its existing property schema.

### First administrator and later accounts

An existing Auth user needs its matching profile. New ordinary profiles default to Agent. Trusted Supabase administration can promote the first known user ID to Admin; no public signup metadata chooses that role. The development setup script creates explicit dev users through supported Auth administration and refuses production/default credentials/existing-account overwrites. Once an active admin exists, use the PIN-protected Accounts page for later users.

### Command reference

| Command                                         | Work                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| npm ci                                          | Install locked project dependencies                                                                             |
| npm run configure                               | Prompt for connection and optional explicit development credentials                                             |
| npm run configure -- --connection-only          | Configure connection for already existing Auth users                                                            |
| npm run setup:dev                               | Create unconfirmed inactive dev accounts; verify inboxes and explicitly activate through trusted administration |
| npm run dev                                     | Start loopback Express and Vite development processes                                                           |
| npm run jobs                                    | Start the separate background runner                                                                            |
| npm test                                        | Run server followed by frontend automated suites                                                                |
| npm run test -w server                          | Server/API/SQL tests                                                                                            |
| npm run test -w client -- --maxWorkers=4        | Frontend tests with reduced local parallel load                                                                 |
| npm run build                                   | Create the production browser bundle                                                                            |
| node scripts/build-sql.js                       | Regenerate the fresh SQL bundle from ordered migrations                                                         |
| node --env-file=.env scripts/send-mock-event.js | Send the explicitly configured signed development fixture                                                       |
| npm run verify:live                             | Read-only real-service acceptance script after its test IDs/credentials are configured                          |
| python3 scripts/build-project-doc.py            | Regenerate this Word manual and named-function inventory from the editable source                               |

### Configuration reference

| Setting                                             | Meaning/location                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY            | Root server connection; service/secret key stays server-only                                                           |
| ACCOUNTS_PIN_PEPPER                                 | Optional private server secret, at least 32 characters; otherwise service-key fallback; changing it requires PIN reset |
| REQUIRE_AGENT_MFA                                   | Server setting, exactly true/false; false by default. Applies only to agents; enrolled agent factors are honored       |
| FRONTEND_URL / PORT                                 | Permitted frontend origin and loopback API port                                                                        |
| NODE_ENV / CALL_PROVIDER                            | Development/production behavior and explicit mock provider selection                                                   |
| WEBHOOK_SECRET                                      | Server secret for signed development fixture events                                                                    |
| PHONE_REVEAL_DAILY_LIMIT                            | Historical usage-status setting only; automatic contact display has no daily quota                                     |
| STALE_LEAD_DAYS                                     | Default 7 days before eligible inactive-lead reassignment                                                              |
| OUTCOME_GRACE_MINUTES                               | Default 30 minutes before missing-outcome flag                                                                         |
| RECORDING_RETENTION_DAYS                            | Allowed 1–7; default 7                                                                                                 |
| JOB_INTERVAL_SECONDS                                | Default 60; runner minimum 10                                                                                          |
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY          | Client public project connection settings                                                                              |
| VITE_API_URL                                        | Usually /api for local proxy access                                                                                    |
| DEV_ADMIN_EMAIL/PASSWORD / DEV_AGENT_EMAIL/PASSWORD | Explicit optional development provisioning values; never default live credentials                                      |

Real keys/passwords must stay in local configuration and are deliberately absent from this manual. Production hosting/reverse-proxy files are included; configuring actual infrastructure is separate work and a successful build does not publish the site.

For an existing database, back up and install missing numbered updates for the features in use, in order: 022 handover/KYC, 023 invitations, 024 Meta, and optional-agent MFA 025. Admin login now uses email/password without requiring 025; this policy removal needs only the updated API/frontend and a browser refresh. Do not delete/rerun old migration files or run the fresh setup bundle on an existing database. Native factors and private MFA tables already installed remain stored.

Performance migration 027 is applied once after 026; it adds indexes and aggregate readers without creating a login requirement. Monitoring still checks its version-26 contract. See docs/PERFORMANCE.md. Monitoring requires 026 once after 025, without re-enabling admin MFA. See docs/DEPLOYMENT.md for VPS/monitoring/backup setup, docs/ADMIN_TWO_FACTOR_LOGIN.md for current login/optional-agent installation, CHANGES_OFFBOARDING_AND_KYC.md for handover/KYC acceptance, docs/META_LEAD_ADS_INTEGRATION.md for Meta configuration and CRM_Authentication_Email_Verification_Implementation.md for SMTP/invitation callbacks. Deploy matching API/frontend versions together and restart the existing dev process rather than starting another on port 5173.

## 24. Work completed, verification and current limits

### Completed development work

The CRM foundation includes private customer identity, protected Auth/API/SQL access, atomic mutations, reports, activity records, mock boundaries and jobs. Subsequent changes expanded lead stages/loss history, eligible property deletion, responsive controls and supplied animations; added genuine CSV/XLSX/XLS import through one picker, flexible headings/column matching and field-specific diagnostics; initially made assigned contacts automatically visible and later replaced that policy with P2 explicit, limited reveals; added import-file history and whole-file assignments; added property selection/upload previews and saved card pictures; added written/file documentation and category/property/keyword search; added password visibility, role login and email-only device suggestions; and added personal admin PIN settings and protected account management.

P1 adds provider-independent manual call logging, method filtering, production-safe controls and transactional validation/auditing. Historical P2 added masked lists, timed reveals, quotas and alerts; the user-requested migration 021 now shows all authorized contacts automatically without those display restrictions. Existing alerts remain reviewable. P3/P4 are implemented locally together in migration 022; Mandatory P5 admin MFA was subsequently removed at the user's request; optional-agent MFA uses the preserved 025 schema and awaits hosted acceptance. P6 deployment/monitoring code is implemented locally in 026; live deployment/backup restore, P7 and P8 remain pending. Hosted installation and real-account acceptance are separate. This does not certify production readiness. The latest manual-call checks are recorded in VERIFICATION.md.

New Agent/Admin accounts are created directly with Gmail-only addresses and permanent six-digit UIDs (036), replacing the 035 email challenge for new requests. Earlier pending requests, historical native pending users and older invitations remain supported. No email sender is needed for new accounts. Hosted migration, Vercel deployment and live acceptance remain manual and unverified.

### Latest recorded evidence

| Area                                          | Recorded result and scope                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gmail-only creation and six-digit UIDs (036)  | Direct creation, automatic/manual unique UIDs, permanence guard, migration backfill/repair, UID display/search/profile. Final full checks: 651 server + 293 client cases passed; production build passed. Hosted migration/redeploy acceptance pending.                        |
| Independent pre-creation email OTP (035)      | No Auth user before independent proof; durable keyed challenge/password binding, same-admin PIN, deterministic recovery and legacy-route guards. Final full checks: 601 server + 278 client cases passed; production build passed. Sender/migration/Vercel acceptance pending. |
| Strict six-digit account codes                | Both roles require the exact current native code; fake/expired/used codes cannot complete setup. Server code/account checks 45 + 33 passed across targeted runs; full client 270 passed; production build passed; live sender setup pending.                                   |
| Agent/Admin codes and free sender setup (034) | Full npm test: 569 server + 270 client = 839 passed; focused Accounts UI 40 passed; production build passed. Manual hosted SMTP/templates/migration and real inbox acceptance pending.                                                                                         |
| Agent email codes in Accounts                 | Full regression 830 cases; final 81 server cases include one extra native delivery case (831 distinct combined); five desktop Chrome checks; hosted templates/update pending                                                                                                   |
| Lead management and both portals              | Final full npm test passed: 550 server + 263 client = 813, including seven installer cases, even 500-lead bulk rotation and social assignment safeguards; nine desktop Chrome checks; hosted installation pending                                                              |
| Account deletion / equal controls             | 522 server + 251 frontend = 773 unique validated cases across full runs and targeted reruns; eight responsive browser layouts; hosted installation pending                                                                                                                     |
| Loading-performance regression                | 497 server + 247 frontend = 744 unique validated cases across full runs and corrected targeted reruns; 15 responsive Chrome layouts; no hosted changes                                                                                                                         |
| Loading-performance build                     | Initial JavaScript 465.72 KB / 146.91 KB gzip, 32.1% smaller raw entry than the previous comparable local build; separate page chunks remain                                                                                                                                   |
| Loading-performance database benchmark        | Synthetic 50,000 leads / 100,000 calls / 40 agents: substring search 54.103 to 0.744 ms; leaderboard 134.324 to 59.611 ms; hosted latency unmeasured                                                                                                                           |
| Previous P6 server suite                      | 477 server tests passed; production startup, proxy trust, readiness/heartbeats, backup failure/retention, admin password policy and prior CRM checks                                                                                                                           |
| Previous P6 frontend suite                    | 233 frontend tests passed; system status/role/error feedback, admin password login, optional-agent flows and prior CRM checks                                                                                                                                                  |
| Latest combined regression                    | 477 server + 233 frontend = 710 tests across full server/client suites with file parallelism disabled                                                                                                                                                                          |
| System monitoring browser checks              | 13 checks at 320/390/768/1440 px with actual local React/API/all26 SQL, controlled Auth, missing/healthy/failed status, readiness and lazy routes; no errors/overflow                                                                                                          |
| Native deployment tools                       | Caddy 2.11.7 validation and seven synthetic HTTP cache/routing/proxy checks; age 1.3.2 round trip through the actual helper using fixture database commands; no real TLS/backup/restore                                                                                        |
| Admin password browser checks                 | 12 checks at 320/390/768/1440 px with actual local React/API/SQL through 024; no admin MFA RPCs; enrolled/unenrolled login, restoration, wrong portal, PIN and admin-factor controls passed                                                                                    |
| Historical MFA browser checks                 | 13 checks using actual local React/API/all25 SQL and controlled native Auth at desktop/mobile sizes; enrollment, wrong-code retry, verified installation, existing-factor login, PIN reset and old-token denial                                                                |
| Meta browser checks                           | 18 layouts at 320/390/768/1440 px using actual local React/API/all24 SQL and controlled Auth/Meta; ingestion, unassigned restrictions, assignment, report and no JavaScript errors                                                                                             |
| Handover/KYC browser checks                   | 28 layouts at 320/390/768/1440 px with actual local React/API/all22 SQL and isolated Auth/Storage; choices, cancellation, ownership, legacy linking and two audited downloads; no JavaScript errors                                                                            |
| Historical P1 regression (13 October 2026)    | 291 server + 162 frontend = 453 tests in one npm test run                                                                                                                                                                                                                      |
| Fresh setup                                   | All 26 migrations executed in isolated PostgreSQL; fresh setup/upgrade and atomic rollback checks passed                                                                                                                                                                       |
| Production build                              | Passed with empty environment config: initial JavaScript 686.10 KB (203.79 KB gzip), CSS 40.72 KB (9.40 KB gzip); 14.6% smaller entry than 803.28 KB before route splitting; not comparable to a configured deployment bundle; existing warnings remain                        |
| Login browser checks                          | 24 layout checks at 320, 390, 768 and 1440 pixels with isolated Auth/profile fixtures                                                                                                                                                                                          |
| Accounts browser checks                       | 36 layout checks with actual local API/SQL and fixture Auth administration                                                                                                                                                                                                     |
| Documents browser checks                      | 28 layout checks with local API/SQL and isolated Auth/Storage, including real document fixtures                                                                                                                                                                                |
| Property browser checks                       | 30 layout checks with actual local photo API and isolated records/Storage; renewal, role views and PNG/JPEG/WebP checks passed                                                                                                                                                 |
| Email confirmation browser checks             | 12 layouts at 320/390/768/1440 px, actual API/all20 SQL with isolated Auth/mail; pending/confirmed access and resend guards passed; no real email sent                                                                                                                         |
| Visible-contact browser checks                | 18 layouts at 320/390/768/1440 px; both portals, assigned-file pagination, no expiry/controls, migration error/recovery; 219 safe audits                                                                                                                                       |
| Manual-call browser checks                    | 20 layouts at 320/390/768/1440 px, actual production-mode API/SQL, both roles, 18 saved calls and 18 safe audits; pending/retry and method filtering passed                                                                                                                    |

The earlier production regression passed 477 server + 233 frontend = 710 tests, using fileParallelism=false and a 15-second frontend test timeout on this machine. The prior admin-MFA removal regression passed 672 tests. The prior mandatory-MFA regression passed 659 tests before the user removed the admin requirement. The prior Meta regression passed 609 tests, the invitation regression passed 553 and the earlier email-confirmation regression passed 489. The contact-repair follow-up passed 40 targeted server tests, including restoration of the confirmed missing phone-read ledger and full API recovery; it was not a new full-suite run. The earlier P1-only regression passed 453 tests. Browser rows identify separate recorded feature checks, not one combined browser session. Verification uses isolated fixtures and does not change hosted customer data.

Automated SQL tests use PGlite with minimal Auth/Storage schema fixtures; browser checks use controlled fixtures and do not read or modify hosted customer records/accounts. This is evidence about local implementation, not a certificate that the hosted project, email delivery or real provider connections have passed acceptance. Read `VERIFICATION.md` for the complete test record.

### Boundaries and further work

- Meta Instant Form code is implemented but real authorization/delivery acceptance is pending. Real calling, real recording capture and WhatsApp delivery remain unconnected and disabled. Manual logging records calls made from the company phone.
- P3/P4 are implemented locally; apply migration 022 and verify hosted handover/KYC behavior. Mandatory P5 admin MFA was removed by user request; optional-agent MFA remains available; P6 code is implemented locally; live deployment/backup acceptance, P7 email and P8 broader devices remain pending.
- Actual email confirmation/recovery delivery, hosted Storage operations and separate PostgreSQL-connection concurrency need real-service acceptance.
- Physical phones and Safari/Firefox have not been verified by the recorded headless Chrome checks.
- Original imported spreadsheets are not stored; skipped columns do not become CRM fields.
- General activity selectors are bounded to 100 items; advanced searchable lookups remain future work.
- Page routes load on demand and the initial bundle is reduced, but the shared entry remains large and needs further optimization before heavier use.
- General lead/activity/account hard deletion, customer exports, payments, commissions, document approvals/versioning/acknowledgements and advanced roles are not present.
- Notifications are in-app reminders. Automated email/WhatsApp/push notification delivery is not implemented.
- Production deployment files are provided, but no live deployment has been performed.

Migration 023 invitation browser checks passed 18 layouts at 320/390/768/1440 pixels with actual React/API/all23 SQL and fixture Auth/mail. No real email or hosted record was used.

These items describe current scope. They are not requirements imposed on an admin's ordinary daily use.

## 25. Daily workflows, troubleshooting and supporting guides

### Administrator daily workflow

Review Overview and overdue work; create/import leads; review import row errors; assign files/individual leads to active agents; maintain property details/pictures and shared documents; set monthly targets; review call outcomes and report aggregates; review Security alerts and use Audit history for investigation; manage accounts through the PIN gate. Keep the jobs runner active if reminders, stale assignment and cleanup should operate.

### Agent daily workflow

Select Agent and sign in; review My overview/reminders; open an assigned file or All my leads; read customer details/budgets and automatically visible full contacts; record notes/outcomes and stage changes; schedule/update follow-ups and property visits; maintain the single deal record as business progresses; consult shared properties/photos and company documents; check My targets; dismiss read reminders and sign out when finished.

### Common problems

| Symptom                                            | Meaning and action                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| npm cannot find /Users/air/package.json            | Terminal is in the home directory; cd into hd-marketing-crm before running npm                               |
| setup:dev asks for explicit credentials            | Configure distinct new dev emails/passwords or skip this script for existing Auth users                      |
| Login failed / load failed                         | Confirm both local processes run and project URL/keys match; distinguish Auth error from unreachable CRM API |
| Account cannot sign in to selected portal          | Choose the saved role's portal; an admin must change the actual profile role if required                     |
| No email suggestion                                | Successfully sign in once on this browser/origin; the CRM does not enumerate unknown accounts                |
| File assignments/documents/accounts need an update | Apply missing migrations in order; features use 014, 015, 016 and 017 as described above                     |
| Unsupported/ambiguous spreadsheet headings         | Use the matching screen; map required name/phone, select supported optional fields and skip extras           |
| Invalid row / invalid phone                        | Correct the stated field; use valid text-formatted numbers, supported email/values and real references       |
| Daily number limit reached                         | The distinct agent quota is exhausted until Pakistan midnight; previously revealed leads remain permitted    |
| Visible contacts need migration 021                | Apply missing 019, 020 and 021 in order, then refresh; do not rerun the fresh bundle                         |
| Duplicate row/customer                             | Normalized phone already exists; inspect the prior customer instead of replacing its identity                |
| Agent cannot see a file or customer                | Verify current lead ownership and active access; use All my leads for individual assignments                 |
| Property card has no picture                       | Add a valid saved photo as an admin; images are optional and private access must be working                  |
| Property cannot be deleted                         | It has a linked lead/visit/deal; archive it to preserve history                                              |
| Forgotten/locked Accounts PIN                      | Reset it in Admin settings with the admin's current login password                                           |
| Recording unavailable / real call 503              | No valid recording/provider is connected; use Log a call to record a company-phone conversation              |
| No reminders/stale changes/cleanup retries         | Run the separate jobs process and verify the configured interval/eligibility                                 |
| Success. No rows returned after migration          | Normal schema-upgrade result; refresh the CRM afterward                                                      |

### Supporting source documents

`README.md` covers installation and overall operation. `VERIFICATION.md` records checks and limitations. Feature guides are `docs/LEAD_IMPORT.md`, `FILE_ASSIGNMENTS.md`, `F1_PIPELINE.md`, `PROPERTY_PICTURES.md`, `PROPERTY_DELETION.md`, `DOCUMENTATION_AND_POLICIES.md`, `ACCOUNTS_AND_SECURITY.md`, `EMAIL_CONFIRMATION.md`, `MANUAL_CALL_LOGGING.md`, `PROTECTED_PHONE_NUMBERS.md` and `ANIMATIONS.md`. `PRODUCTION_FIXES.md` tracks the ordered P1–P8 scope; P1–P4 are implemented locally; hosted installation is separate. The root CHANGES_OFFBOARDING_AND_KYC.md explains migration 022, backup steps and business-owner usage. `REMAINING_FEATURES.md` is a proposal/roadmap and can contain migration numbers or behaviors superseded by later implemented requests.

This Word manual is generated from `docs/CRM_COMPLETE_DOCUMENTATION.md`. Its named-function appendix is refreshed from source during generation. After future feature changes, update the manual's workflows/permissions and rerun its generator.

## 26. Named function and module inventory

The following inventory is generated from explicit named function declarations, arrow helpers and named useCallback handlers in the current project source. It includes local named event helpers and lists startup/re-export modules. Inline anonymous callbacks are described by their containing workflow rather than individually named. The responsibilities explain each module's purpose; section 21 explains the principal functions and protected SQL operations in detail.

<!-- function-catalog:start -->

The current inventory covers 193 JavaScript/JSX modules, 549 explicitly named JavaScript functions/helpers (counted per module), and 236 latest PostgreSQL function definitions.

### Frontend components, pages and helpers

| Module                                                                     | Named functions/helpers                                                                                                                                                                                                                            | Responsibility                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/App.jsx`                                                       | `Protected`, `App`                                                                                                                                                                                                                                 | Role-protected lazy routing, loading feedback and recoverable chunk errors.                                                                        |
| `client/src/components/accounts/AccountUid.jsx`                            | `AccountUid`                                                                                                                                                                                                                                       | Read-only Supabase UID display with a copy-to-clipboard action and toast feedback.                                                                 |
| `client/src/components/accounts/AgentHandover.jsx`                         | `AgentHandover`, `submit`                                                                                                                                                                                                                          | Preview counts and confirm atomic disable/handover to balanced agents, one recipient or the admin pool.                                            |
| `client/src/components/accounts/CreateAccountForm.jsx`                     | `passwordError`, `check`, `CreateAccountForm`                                                                                                                                                                                                      | Create Account form with Gmail validation, Auto/Manual UID choice, inline UID checks, advisory availability lookup and field-mapped server errors. |
| `client/src/components/accounts/PendingAccountVerification.jsx`            | `PendingAccountVerification`, `run`, `close`                                                                                                                                                                                                       | Masked-recipient OTP modal, expiry/cooldown, original-password resume, cancellation and pending guards.                                            |
| `client/src/components/attendance/AdminAttendanceSettings.jsx`             | `minutes`, `AdminAttendanceSettings`, `save`                                                                                                                                                                                                       | Current attendance rules, scheduled changes and rule history.                                                                                      |
| `client/src/components/attendance/AdminDaily.jsx`                          | `AdminDaily`, `reset`                                                                                                                                                                                                                              | Daily register of every expected employee with filters and export.                                                                                 |
| `client/src/components/attendance/AdminEmployee.jsx`                       | `AdminEmployee`                                                                                                                                                                                                                                    | One employee's attendance history, totals, leave and corrections.                                                                                  |
| `client/src/components/attendance/AdminHolidays.jsx`                       | `AdminHolidays`, `add`, `remove`                                                                                                                                                                                                                   | Add and remove company holidays.                                                                                                                   |
| `client/src/components/attendance/AdminPeriod.jsx`                         | `DayCell`, `Bars`, `AdminPeriod`, `move`                                                                                                                                                                                                           | Weekly and monthly attendance totals, day codes and charts.                                                                                        |
| `client/src/components/attendance/AdminRequests.jsx`                       | `AdminRequests`, `review`                                                                                                                                                                                                                          | Leave and correction review lists; own requests need another administrator.                                                                        |
| `client/src/components/attendance/Badges.jsx`                              | `Pill`, `StateBadge`, `PunctualityBadge`, `RequestBadge`                                                                                                                                                                                           | Attendance state, punctuality and request status badges.                                                                                           |
| `client/src/components/attendance/CorrectionRequestForm.jsx`               | `needsIn`, `needsOut`, `CorrectionRequestForm`, `set`, `submit`                                                                                                                                                                                    | Attendance correction request with Pakistan-time check-in/out.                                                                                     |
| `client/src/components/attendance/ExportButtons.jsx`                       | `ExportButtons`, `save`                                                                                                                                                                                                                            | CSV or Excel export of the attendance report on screen.                                                                                            |
| `client/src/components/attendance/LeaveRequestForm.jsx`                    | `LeaveRequestForm`, `set`, `submit`                                                                                                                                                                                                                | Full-day leave request for the signed-in employee.                                                                                                 |
| `client/src/components/attendance/ReviewDialog.jsx`                        | `ReviewDialog`, `decide`                                                                                                                                                                                                                           | Approve or reject a leave or correction request with a note.                                                                                       |
| `client/src/components/attendance/command/AttendanceAttentionPanel.jsx`    | `names`, `AttendanceAttentionPanel`                                                                                                                                                                                                                | Today's attendance issues and waiting requests with links to act on them.                                                                          |
| `client/src/components/attendance/command/AttendanceCommandHeader.jsx`     | `AttendanceCommandHeader`                                                                                                                                                                                                                          | Command Center title, today's date, rules from settings, refresh and export.                                                                       |
| `client/src/components/attendance/command/AttendanceDistributionChart.jsx` | `AttendanceDistributionChart`                                                                                                                                                                                                                      | Donut of today's mutually exclusive attendance states.                                                                                             |
| `client/src/components/attendance/command/AttendanceKpiStrip.jsx`          | `AttendanceKpiStrip`                                                                                                                                                                                                                               | Five headline attendance figures for today.                                                                                                        |
| `client/src/components/attendance/command/AttendanceNavigation.jsx`        | `AttendanceNavigation`, `onKeyDown`, `button`                                                                                                                                                                                                      | Keyboard-navigable attendance sections with waiting-request counts.                                                                                |
| `client/src/components/attendance/command/AttendanceOverview.jsx`          | `AttendanceOverview`                                                                                                                                                                                                                               | Command Center overview layout of the attendance panels.                                                                                           |
| `client/src/components/attendance/command/EmployeeAttendanceDrawer.jsx`    | `EmployeeAttendanceDrawer`                                                                                                                                                                                                                         | Read-only side panel with one employee's recent attendance.                                                                                        |
| `client/src/components/attendance/command/LiveAttendanceRegister.jsx`      | `LiveAttendanceRegister`, `update`                                                                                                                                                                                                                 | Everyone expected on a date, with filters and quick details.                                                                                       |
| `client/src/components/attendance/command/MonthlyAttendanceInsights.jsx`   | `MonthlyAttendanceInsights`, `weekday`                                                                                                                                                                                                             | Team monthly attendance totals and a daily calendar heatmap.                                                                                       |
| `client/src/components/attendance/command/Skeleton.jsx`                    | `Skeleton`, `PanelSkeleton`, `PanelError`                                                                                                                                                                                                          | Loading placeholders and section error with retry.                                                                                                 |
| `client/src/components/attendance/command/WeeklyAttendanceChart.jsx`       | `WeeklyAttendanceChart`                                                                                                                                                                                                                            | Stacked daily attendance bars for a week with separate late counts.                                                                                |
| `client/src/components/calls/CallDialog.jsx`                               | `CallDialog`, `requestClose`                                                                                                                                                                                                                       | Call a lead through the device phone app (tel: link) and log the result with the manual-call endpoint.                                             |
| `client/src/components/calls/DealTagPicker.jsx`                            | `DealTagPicker`                                                                                                                                                                                                                                    | Select supported outcome/deal tags without duplicated values.                                                                                      |
| `client/src/components/calls/OutcomeForm.jsx`                              | `outcomeSchema`, `clock`, `OutcomeForm`, `tick`, `startDial`, `endDial`                                                                                                                                                                            | Validate manual call logs and later outcomes, notes and tags; guard pending saves; optional dialler with call timer.                               |
| `client/src/components/common/Button.jsx`                                  | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Compatibility export of the shared button component.                                                                                               |
| `client/src/components/common/EmailSuggestionsInput.jsx`                   | `EmailSuggestionsInput`, `choose`                                                                                                                                                                                                                  | Role-separated email-only suggestions with keyboard selection.                                                                                     |
| `client/src/components/common/IdleGuard.jsx`                               | `IdleGuard`, `timeout`                                                                                                                                                                                                                             | Inactivity warning dialog with countdown, Stay signed in and Sign out now; signs out idle sessions.                                                |
| `client/src/components/common/Loader.jsx`                                  | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Compatibility export of the shared loading component.                                                                                              |
| `client/src/components/common/MfaChallenge.jsx`                            | `MfaChallenge`                                                                                                                                                                                                                                     | Private QR/key setup, factor selection, six-digit verification and cancellation with pending guards.                                               |
| `client/src/components/common/Modal.jsx`                                   | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Compatibility export of the shared accessible modal component.                                                                                     |
| `client/src/components/common/RecordsPage.jsx`                             | `ActivityForm`, `RecordsPage`                                                                                                                                                                                                                      | Shared activity lists and forms for follow-ups, visits and deals.                                                                                  |
| `client/src/components/common/SystemStatus.jsx`                            | `SystemStatus`                                                                                                                                                                                                                                     | Administrator-only job/backup monitoring with stale/failure feedback.                                                                              |
| `client/src/components/common/Table.jsx`                                   | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Compatibility export of the shared table component.                                                                                                |
| `client/src/components/common/UI.jsx`                                      | `Button`, `Loader`, `ErrorBox`, `motionAllowed`, `Modal`, `requestClose`, `Table`, `Pagination`, `Badge`, `useToast`, `ToastProvider`, `PasswordInput`, `RecordForm`                                                                               | Shared buttons, modals, tables, pagination, fields and notifications.                                                                              |
| `client/src/components/dashboard/Widgets.jsx`                              | `KpiTile`, `RingProgress`, `MonthHighlight`, `noticeIcon`, `timeAgo`, `RecentActivity`                                                                                                                                                             | Dashboard KPI tiles, ring gauge, navy month highlight and recent-activity list from existing APIs.                                                 |
| `client/src/components/documents/KycClientPicker.jsx`                      | `KycClientPicker`                                                                                                                                                                                                                                  | Administrator client search and required KYC selection using masked phone metadata.                                                                |
| `client/src/components/documents/LeadKycDocuments.jsx`                     | `LeadKycDocuments`, `getFile`                                                                                                                                                                                                                      | List current-owner client KYC entries and use authorized private attachment downloads.                                                             |
| `client/src/components/layout/Layout.jsx`                                  | `storedCollapse`, `Layout`, `toggleCollapsed`, `close`, `markRead`, `signOut`                                                                                                                                                                      | Grouped role navigation with collapsible sidebar, breadcrumbs, notifications, profile menu with UID and sign-out.                                  |
| `client/src/components/layout/navigation.js`                               | `breadcrumb`, `detailLabel`                                                                                                                                                                                                                        | Role-based sidebar sections (paths, labels, icons) and breadcrumb names for the current route.                                                     |
| `client/src/components/leads/DeleteLeadsDialog.jsx`                        | `DeleteLeadsDialog`, `close`                                                                                                                                                                                                                       | Preview affected work, require a reason and typed confirmation, and guard lead/file deletion.                                                      |
| `client/src/components/leads/ImportedFiles.jsx`                            | `format`, `ImportedFiles`, `close`, `assignFile`                                                                                                                                                                                                   | Import-file browsing, admin assignment and agent file selection.                                                                                   |
| `client/src/components/leads/LeadForm.jsx`                                 | `LeadForm`                                                                                                                                                                                                                                         | Administrator customer creation and atomic metadata, phone and owner editing.                                                                      |
| `client/src/components/leads/LeadPhone.jsx`                                | `visiblePhone`, `LeadPhone`                                                                                                                                                                                                                        | Automatically render authorized full customer contacts with a Call button that opens the call dialog.                                              |
| `client/src/components/leads/LeadStatusControl.jsx`                        | `LostReasonForm`, `LeadStatusControl`                                                                                                                                                                                                              | Lead stage/loss forms and status-change submission.                                                                                                |
| `client/src/components/leads/PhoneReveal.jsx`                              | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Compatibility export of automatic full-contact rendering without Show/Hide controls.                                                               |
| `client/src/components/properties/PhotoGallery.jsx`                        | `PhotoGallery`                                                                                                                                                                                                                                     | Shared signed property images; admin upload/delete controls.                                                                                       |
| `client/src/components/properties/PropertyCard.jsx`                        | `PropertyCard`                                                                                                                                                                                                                                     | Property cover, photo count, summary and open-details interaction.                                                                                 |
| `client/src/components/properties/PropertyDetails.jsx`                     | `PropertyDetails`                                                                                                                                                                                                                                  | Full property summary and shared photo gallery.                                                                                                    |
| `client/src/components/properties/PropertyForm.jsx`                        | `PropertyForm`                                                                                                                                                                                                                                     | Validated property details, save-before-upload and retry behavior.                                                                                 |
| `client/src/components/properties/PropertyPhotoPicker.jsx`                 | `SelectedPicture`, `PropertyPhotoPicker`, `choosePictures`                                                                                                                                                                                         | One multi-image picker, validation and released preview URLs.                                                                                      |
| `client/src/components/sales/CallActivity.jsx`                             | `useCallActivity`, `workdayStarted`, `TeamCallActivity`, `MyCalls`                                                                                                                                                                                 | Admin team calling table for today and the agent's own first-call queue without contact numbers.                                                   |
| `client/src/components/sales/LeadReview.jsx`                               | `LeadReview`, `decide`                                                                                                                                                                                                                             | Admin keep-or-reassign decisions for missed first calls and quiet leads.                                                                           |
| `client/src/components/sales/WorkHours.jsx`                                | `minutes`, `WorkHours`, `save`                                                                                                                                                                                                                     | Admin working days, hours, last-call window and quiet-lead days.                                                                                   |
| `client/src/components/targets/TargetCard.jsx`                             | `TargetCard`                                                                                                                                                                                                                                       | One target with live progress for its own day, week or month.                                                                                      |
| `client/src/components/targets/TargetProgress.jsx`                         | `TargetProgress`                                                                                                                                                                                                                                   | Goal/actual comparison and bounded progress display.                                                                                               |
| `client/src/components/visits/VisitCalendar.jsx`                           | `VisitCard`, `VisitCalendar`, `move`                                                                                                                                                                                                               | Week and month site-visit calendar with agent filter and status colours.                                                                           |
| `client/src/components/visits/VisitConflicts.jsx`                          | `VisitConflicts`                                                                                                                                                                                                                                   | Non-blocking warning when the agent already has a visit within an hour.                                                                            |
| `client/src/context/AuthContext.jsx`                                       | `AuthProvider`, `clearWorkspace`, `requireMfa`, `isCurrent`, `refresh`, `restore`, `useAuth`                                                                                                                                                       | Session restoration, active-profile refresh and recovery state.                                                                                    |
| `client/src/lib/accountFields.js`                                          | `normalizeEmail`, `gmailError`, `uidError`, `copyText`                                                                                                                                                                                             | Client mirrors of the Gmail and UID rules plus a clipboard copy helper with a non-secure-context fallback.                                         |
| `client/src/lib/accountInvitation.js`                                      | `readInvitationCallback`, `openInvitation`                                                                                                                                                                                                         | Validate invitation callbacks and use isolated verified sessions for setup API calls.                                                              |
| `client/src/lib/api.js`                                                    | `api`, `download`, `pkr`, `date`, `localISO`, `localInput`, `monthRange`, `reportSearch`                                                                                                                                                           | Authorized JSON/multipart requests, downloads and PKR/date/report helpers.                                                                         |
| `client/src/lib/attendance.js`                                             | `stateLabel`, `punctualityLabel`, `leaveTypeLabel`, `correctionTypeLabel`, `pkTime`, `clockLabel`, `minutesLabel`, `percentLabel`, `workDaysLabel`, `pkMoment`, `useMyAttendance`, `invalidateAttendance`                                          | Attendance state and punctuality labels, time and duration formatting in Pakistan time.                                                            |
| `client/src/lib/attendanceDashboard.js`                                    | `get`, `useAttendanceOverview`, `useAttendancePolicy`, `useRegister`, `useWeekReport`, `useMonthReport`, `currentWeekStart`, `currentMonth`, `todaySummary`, `n`, `workDayRange`, `isoWeekday`, `weekSeries`, `monthTotals`, `sum`, `monthGrid`    | Command Center queries (shared with the report tabs) and display-only grouping of attendance data.                                                 |
| `client/src/lib/authClient.js`                                             | `createAuthClient`                                                                                                                                                                                                                                 | Native Supabase browser Auth with compatible sessions and isolated candidate login.                                                                |
| `client/src/lib/authErrors.js`                                             | `authErrorMessage`                                                                                                                                                                                                                                 | Readable authentication failures without raw secret output.                                                                                        |
| `client/src/lib/calendar.js`                                               | `utc`, `iso`, `pkDate`, `todayPk`, `addDays`, `weekday`, `startOfWeek`, `startOfMonth`, `addMonths`, `dayStartIso`, `visitTime`, `dayLabel`, `fullDayLabel`, `monthLabel`, `periodStart`, `shiftPeriod`, `periodEnd`, `periodRange`, `periodLabel` | Pakistan-date helpers for weeks from Monday, month grids and target period ranges.                                                                 |
| `client/src/lib/calls.js`                                                  | `callMethodLabel`                                                                                                                                                                                                                                  | Shared Manual/Mock/Provider labels and unanswered outcome definitions.                                                                             |
| `client/src/lib/documentCategories.js`                                     | `documentCategoryLabel`                                                                                                                                                                                                                            | Shared category values and document labels.                                                                                                        |
| `client/src/lib/firstCall.js`                                              | `dueLabel`, `lateBy`, `idleFor`, `firstCallState`                                                                                                                                                                                                  | Format first-call deadlines, lateness and lead badges in Pakistan time.                                                                            |
| `client/src/lib/fonts.js`                                                  | `loadFonts`, `load`                                                                                                                                                                                                                                | Load optional display fonts at idle with system-font fallback.                                                                                     |
| `client/src/lib/formatLeadNo.js`                                           | `formatLeadNo`                                                                                                                                                                                                                                     | Format one permanent lead identity consistently in both portals.                                                                                   |
| `client/src/lib/invalidateWorkspace.js`                                    | `invalidateWorkspace`                                                                                                                                                                                                                              | Refresh affected workspace query families after mutations.                                                                                         |
| `client/src/lib/loginEmails.js`                                            | `emailAddress`, `history`, `savedLoginEmails`, `rememberLoginEmail`                                                                                                                                                                                | Validate, read and remember up to five emails per portal/device.                                                                                   |
| `client/src/lib/meta.js`                                                   | `useMetaSummary`, `platformLabel`, `metaStatus`                                                                                                                                                                                                    | Administrator-scoped social summary polling and safe platform/processing labels.                                                                   |
| `client/src/lib/mfaLogin.js`                                               | `check`, `prepareMfa`, `cancelMfa`, `completeMfa`, `restoreMfa`                                                                                                                                                                                    | Keep candidate MFA enrollment/verification isolated until accepted AAL2 workspace installation.                                                    |
| `client/src/lib/pipeline.js`                                               | `statusLabel`, `lostReasonLabel`                                                                                                                                                                                                                   | Lead stage and loss-reason definitions and labels.                                                                                                 |
| `client/src/lib/portalLogin.js`                                            | `signInToPortal`                                                                                                                                                                                                                                   | Isolated candidate sign-in; install only after role acceptance and required authenticator verification.                                            |
| `client/src/lib/routeLoaders.js`                                           | `once`, `preloadRoute`                                                                                                                                                                                                                             | Share lazy page loaders and preload code on sidebar intent without customer data.                                                                  |
| `client/src/lib/securityAlerts.js`                                         | `useSecurityAlertSummary`, `securityAlertLabel`                                                                                                                                                                                                    | Shared administrator summary polling and safe alert labels.                                                                                        |
| `client/src/lib/supabase.js`                                               | `createLoginClient`                                                                                                                                                                                                                                | Public Auth client plus isolated non-persistent login clients.                                                                                     |
| `client/src/lib/useDebouncedValue.js`                                      | `useDebouncedValue`                                                                                                                                                                                                                                | Delay search requests until typing pauses while preserving immediate input updates.                                                                |
| `client/src/lib/useIdleLogout.js`                                          | `idleSettings`, `readShared`, `writeShared`, `useIdleLogout`, `touch`, `visible`, `check`                                                                                                                                                          | Wall-clock inactivity tracking shared across tabs; warns before the limit and signs out at it.                                                     |
| `client/src/lib/useLeadSelection.js`                                       | `useLeadSelection`, `replace`, `toggle`, `togglePage`                                                                                                                                                                                              | Bound cross-page admin selection to 500 IDs and clear it on filter changes.                                                                        |
| `client/src/lib/usePropertyPhotos.js`                                      | `usePropertyPhotos`                                                                                                                                                                                                                                | Shared signed-photo query/cache with optional refresh polling.                                                                                     |
| `client/src/main.jsx`                                                      | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Mount React, query caching, routing, authentication and notifications.                                                                             |
| `client/src/pages/AcceptInvitation.jsx`                                    | `AcceptInvitation`                                                                                                                                                                                                                                 | Isolated recipient callback, URL cleanup, password setup and explicit sign-out after acceptance.                                                   |
| `client/src/pages/Login.jsx`                                               | `Login`                                                                                                                                                                                                                                            | Portal toggle, email suggestions, password visibility and recovery.                                                                                |
| `client/src/pages/admin/Accounts.jsx`                                      | `roleLabel`, `needsInvitation`, `needsAccountCode`, `accountStatus`, `statusTone`, `accountFields`, `checkPassword`, `AccountDetails`, `AccountDialog`, `run`, `AccountCreated`, `Accounts`, `lock`, `request`, `unlock`, `saved`                  | PIN unlock, account list/details with UIDs, UID search, creation success popup and protected management.                                           |
| `client/src/pages/admin/AdminSettings.jsx`                                 | `AdminSettings`, `save`                                                                                                                                                                                                                            | Password-verified personal Accounts PIN set/reset.                                                                                                 |
| `client/src/pages/admin/AttendanceManagement.jsx`                          | `AttendanceManagement`, `go`, `openEmployee`, `openDrawer`, `closeDrawer`                                                                                                                                                                          | Admin attendance tabs: overview, register, reports, history, requests, holidays and settings.                                                      |
| `client/src/pages/admin/AuditLog.jsx`                                      | `AuditLog`                                                                                                                                                                                                                                         | Read-only administrator audit browsing.                                                                                                            |
| `client/src/pages/admin/CallReview.jsx`                                    | `CallReview`                                                                                                                                                                                                                                       | Administrator call filtering, outcomes and recording access.                                                                                       |
| `client/src/pages/admin/Dashboard.jsx`                                     | `workingTime`, `greeting`, `todayLabel`, `CurrentTargets`, `Dashboard`                                                                                                                                                                             | Role-aware overview: greeting, KPI sections, pipeline, review tables, highlights and recent activity.                                              |
| `client/src/pages/admin/DeletedLeads.jsx`                                  | `DeletedLeads`, `restore`                                                                                                                                                                                                                          | Administrator-only paginated restore bin and file-with-leads restoration.                                                                          |
| `client/src/pages/admin/IncomingSocial.jsx`                                | `Assignment`, `SocialDetail`, `refresh`, `IncomingSocial`, `SocialInbox`, `change`                                                                                                                                                                 | Admin-only enquiry inbox, review details, explicit transactional assignment and attribution report.                                                |
| `client/src/pages/admin/Leads.jsx`                                         | `Leads`, `LeadList`, `importLeads`, `submitImport`, `closeMapping`, `matchImportColumn`, `importMatchedColumns`, `assignSelected`                                                                                                                  | Admin/agent lead lists, imports, column matching and results.                                                                                      |
| `client/src/pages/admin/LoginHistory.jsx`                                  | `deviceLabel`, `nextDay`, `LoginHistory`, `filter`                                                                                                                                                                                                 | Admin login history with account/result/date filters, failed-attempt and locked-account totals.                                                    |
| `client/src/pages/admin/MetaIntegration.jsx`                               | `FormMapping`, `MetaIntegration`, `run`                                                                                                                                                                                                            | Admin business connection, Page/form activation, mapping and recovery controls.                                                                    |
| `client/src/pages/admin/Properties.jsx`                                    | `Properties`, `closeModal`, `removeProperty`                                                                                                                                                                                                       | Shared inventory/details with administrator editing/deletion.                                                                                      |
| `client/src/pages/admin/Reports.jsx`                                       | `sourceName`, `percent`, `minutes`, `Bar`, `BarList`, `Summary`, `Sources`, `Agents`, `Funnel`, `Lost`, `list`, `Reports`                                                                                                                          | Administrator aggregate report filters and CSV export.                                                                                             |
| `client/src/pages/admin/SecurityAlerts.jsx`                                | `SecurityAlerts`, `review`                                                                                                                                                                                                                         | Administrator-only alert filters, pagination, review controls and summary refresh.                                                                 |
| `client/src/pages/admin/Targets.jsx`                                       | `Targets`, `go`, `copyPrevious`                                                                                                                                                                                                                    | Role-aware monthly goals and administrator target editing.                                                                                         |
| `client/src/pages/admin/Team.jsx`                                          | `Team`                                                                                                                                                                                                                                             | Read-only team directory with UIDs; edits use PIN-protected Accounts.                                                                              |
| `client/src/pages/agent/FollowUps.jsx`                                     | `FollowUps`                                                                                                                                                                                                                                        | Agent follow-up list/form using the shared activity implementation.                                                                                |
| `client/src/pages/agent/LeadDetail.jsx`                                    | `LeadDetail`, `refresh`, `act`                                                                                                                                                                                                                     | Authorized customer timeline, notes, calls and activity actions.                                                                                   |
| `client/src/pages/agent/MyLeads.jsx`                                       | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Agent route alias for the shared ownership-scoped lead page.                                                                                       |
| `client/src/pages/agent/MyTargets.jsx`                                     | Startup, shared constants or compatibility export                                                                                                                                                                                                  | Agent route alias for the shared monthly target page.                                                                                              |
| `client/src/pages/agent/SiteVisits.jsx`                                    | `SiteVisits`                                                                                                                                                                                                                                       | Agent site visits using the shared activity implementation.                                                                                        |
| `client/src/pages/shared/Documentation.jsx`                                | `fileSize`, `EntryForm`, `chooseFiles`, `save`, `EntryEditor`, `Documentation`, `changePending`, `open`, `close`, `invalidate`, `remove`, `actions`                                                                                                | Shared category/search library and admin entry/file editing.                                                                                       |
| `client/src/pages/shared/MyAttendance.jsx`                                 | `useRunningMinutes`, `MyRequests`, `cancel`, `MyAttendance`, `act`, `done`                                                                                                                                                                         | Employee check-in/out, today's status, monthly summary, history and leave/correction requests.                                                     |

### API, services, validation and background jobs

| Module                                        | Named functions/helpers                                                                                                                                                                                            | Responsibility                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/app.js`                           | `createApp`                                                                                                                                                                                                        | Compose Express middleware, API boundaries, health and safe errors.                                                                                        |
| `server/src/config/runtime.js`                | `trustProxy`, `validateRuntime`                                                                                                                                                                                    | Production secrets/origin/manual-calling validation and explicit proxy networks.                                                                           |
| `server/src/config/supabaseAdmin.js`          | `getAdmin`                                                                                                                                                                                                         | Create the server-only service-role Supabase client.                                                                                                       |
| `server/src/index.js`                         | Startup, shared constants or compatibility export                                                                                                                                                                  | Start the loopback CRM API server.                                                                                                                         |
| `server/src/jobs/attendanceReconciliation.js` | `attendanceReconciliation`                                                                                                                                                                                         | Mark earlier open attendance sessions incomplete and send the admins' daily summary; never moves leads.                                                    |
| `server/src/jobs/cleanupKnowledgeFiles.js`    | `cleanupKnowledgeFiles`                                                                                                                                                                                            | Retry durable private document attachment cleanup.                                                                                                         |
| `server/src/jobs/cleanupPropertyPhotos.js`    | `cleanupPropertyPhotos`                                                                                                                                                                                            | Retry durable private property image cleanup.                                                                                                              |
| `server/src/jobs/deleteOldRecordings.js`      | `deleteOldRecordings`                                                                                                                                                                                              | Delete expired Storage/provider recordings and record retries.                                                                                             |
| `server/src/jobs/followUpReminders.js`        | `followUpReminders`                                                                                                                                                                                                | Invoke locked creation of deduplicated due reminders.                                                                                                      |
| `server/src/jobs/leadResponseCheck.js`        | `leadResponseCheck`                                                                                                                                                                                                | Flag missed first calls for admin review and send sales reminders; never reassigns.                                                                        |
| `server/src/jobs/maintenance.js`              | `createJobRunner`, `tick`                                                                                                                                                                                          | Non-overlapping independent maintenance jobs and safe durable heartbeats.                                                                                  |
| `server/src/jobs/missingOutcomeCheck.js`      | `missingOutcomeCheck`                                                                                                                                                                                              | Flag completed calls missing an outcome after the grace period.                                                                                            |
| `server/src/jobs/processMetaLeads.js`         | `processMetaLeads`                                                                                                                                                                                                 | Fenced queue claims, bounded Graph retrieval, normalization, protected finalization and retry cleanup.                                                     |
| `server/src/jobs/purgeDeletedLeads.js`        | `checked`, `purgeDeletedLeads`                                                                                                                                                                                     | Run the SQL-persisted daily purge and retry orphan recording cleanup before acknowledgement.                                                               |
| `server/src/jobs/reportInactiveLeadOwners.js` | `reportInactiveLeadOwners`                                                                                                                                                                                         | Raise safe administrator alerts for inactive profiles retaining leads; do not auto-reassign.                                                               |
| `server/src/jobs/runner.js`                   | `scheduledTick`                                                                                                                                                                                                    | Schedule the eight background jobs without local overlapping ticks.                                                                                        |
| `server/src/middleware/auditLogger.js`        | `audit`                                                                                                                                                                                                            | Persist request-linked, bounded audit records.                                                                                                             |
| `server/src/middleware/auth.js`               | `tokenSubject`, `auth`, `reads`, `readProfile`                                                                                                                                                                     | Verify native identity, confirmation, current active role (with UID when update 036 is installed), signed assurance and reset state before CRM access.     |
| `server/src/middleware/phoneProtection.js`    | `maskAgentResponse`, `protectAgentPhones`, `restore`                                                                                                                                                               | Mask agent free text while preserving SQL-authorized structured contact fields.                                                                            |
| `server/src/middleware/rateLimit.js`          | Startup, shared constants or compatibility export                                                                                                                                                                  | General and sensitive-route IP request limits.                                                                                                             |
| `server/src/middleware/role.js`               | `adminOnly`                                                                                                                                                                                                        | Reject requests lacking the required administrator role.                                                                                                   |
| `server/src/routes/accounts.routes.js`        | `fail`, `checked`, `authResult`, `accountsRouter`, `session`, `grant`, `rpc`, `gate`, `action`, `update`, `confirmation`, `unban`, `invite`, `sendAccountCode`                                                     | Personal PIN/grant endpoints and protected account operations.                                                                                             |
| `server/src/routes/attendance.routes.js`      | `attendanceRpc`, `addDays`, `monthRange`, `filters`, `page`, `attendanceRouter`, `self`, `time`, `hours`, `dayCell`, `dailySheet`, `periodSheet`, `sendSheet`, `attendanceAdminRouter`, `admin`, `daily`, `period` | Self-service attendance and admin attendance routes, reports and CSV/XLSX exports (update 040).                                                            |
| `server/src/routes/auth.routes.js`            | `bounded`, `loginSettings`, `createSignInClient`, `fail`, `authRouter`, `rpc`, `record`, `refuse`                                                                                                                  | Server sign-in with per-account lockout, generic refusals and login history recording.                                                                     |
| `server/src/routes/calls.routes.js`           | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/crm.routes.js`             | `unwrap`, `ownedLead`, `crmRouter`, `mutate`                                                                                                                                                                       | Core CRM handlers with role/ownership checks and SQL mutations.                                                                                            |
| `server/src/routes/documents.routes.js`       | `result`, `documentsRouter`, `cleanup`                                                                                                                                                                             | Current-owner KYC/shared category readers, audited private downloads and admin mutations.                                                                  |
| `server/src/routes/health.routes.js`          | `healthRouter`                                                                                                                                                                                                     | Admin-only status and database/migration/job readiness.                                                                                                    |
| `server/src/routes/leads.routes.js`           | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/meta.routes.js`            | `cookieValue`, `metaCallbackRouter`, `metaRouter`, `rpc`                                                                                                                                                           | Admin-only OAuth setup, Page/form control, inbox, review, assignment and reporting routes.                                                                 |
| `server/src/routes/metaWebhook.routes.js`     | `metaWebhookRouter`                                                                                                                                                                                                | Exact raw-body HMAC verification, challenge and durable submission enqueue.                                                                                |
| `server/src/routes/mfa.routes.js`             | `mfaRouter`                                                                                                                                                                                                        | Optional-agent native authenticator verification, admin refusal and safe outcome audits.                                                                   |
| `server/src/routes/onboarding.routes.js`      | `result`, `onboardingRouter`                                                                                                                                                                                       | Verified recipient/ticket-only context and password acceptance; no public registration.                                                                    |
| `server/src/routes/properties.routes.js`      | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/reports.routes.js`         | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/sales.routes.js`           | `salesRpc`, `runReport`, `salesRouter`                                                                                                                                                                             | Notifications, first-call queue, call activity, admin lead review decisions and working hours (update 038).                                                |
| `server/src/routes/security.routes.js`        | `securityRouter`                                                                                                                                                                                                   | Protected phone-usage status and administrator-only alert listing/review.                                                                                  |
| `server/src/routes/targets.routes.js`         | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/users.routes.js`           | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the shared CRM router; no duplicated route implementation.                                                                         |
| `server/src/routes/webhooks.routes.js`        | `verifySignature`, `webhooksRouter`                                                                                                                                                                                | Verify development-event HMAC and call the deduplicated event transaction.                                                                                 |
| `server/src/services/accountCreation.js`      | `fail`, `creationSecret`, `creationDigest`, `creationBinding`, `accountCreationService`, `rpc`, `config`, `deliver`, `context`, `trustedNative`, `nativeLookup`, `resend`, `verify`                                | Resume, resend or cancel email-code requests created before update 036; verify OTP and recover deterministic Auth provisioning without recipient sessions. |
| `server/src/services/accountCreationMail.js`  | `unavailable`, `accountMailConfig`, `sendAccountCreationEmail`                                                                                                                                                     | Deliver independent six-digit account challenges over bounded TLS SMTP or Resend with safe errors and no content logs.                                     |
| `server/src/services/accountInvitations.js`   | `checkEmailProvider`, `invitationMinutes`, `invitationRedirect`, `requestInvitationEmail`                                                                                                                          | Email/domain validation, configured invitation lifetime/redirects and native mail requests.                                                                |
| `server/src/services/accountProvisioning.js`  | `fail`, `parseAccountCreation`, `accountProvisioningService`, `rpc`, `trusted`, `lookup`, `create`                                                                                                                 | Gmail-only, six-digit-UID direct account creation: strict validation, SQL reservation, server-only Auth creation, timeout recovery and audited activation. |
| `server/src/services/accountsSecurity.js`     | `digest`, `pinSecret`, `input`, `hashPin`, `matchesPin`, `verifyAdminPassword`                                                                                                                                     | PIN hashing/checking, grant digests and isolated password verification.                                                                                    |
| `server/src/services/agentEmailCodes.js`      | `createEmailOtpClient`, `requestAgentEmailCode`                                                                                                                                                                    | Request native Agent/Admin email codes using an isolated nonpersistent Auth client; preserve service/admin sessions.                                       |
| `server/src/services/alerts.js`               | `reminders`                                                                                                                                                                                                        | Reminder query support and alert-related service boundaries.                                                                                               |
| `server/src/services/authRequests.js`         | `authRequest`, `remove`                                                                                                                                                                                            | Deduplicate overlapping native Auth verification only; discard completed results.                                                                          |
| `server/src/services/cloudCalling.js`         | `callCapabilities`, `callingProvider`, `initiate`, `deleteRecording`                                                                                                                                               | Server-authorized call capabilities, development mock adapter and recording cleanup boundary.                                                              |
| `server/src/services/dashboard.js`            | `checked`, `dashboardSnapshot`, `activities`                                                                                                                                                                       | Single authorized dashboard snapshot with legacy reader compatibility.                                                                                     |
| `server/src/services/documentFiles.js`        | `invalid`, `checkDocx`, `validateDocumentFile`                                                                                                                                                                     | Bounded PDF/DOC/DOCX signature and archive validation.                                                                                                     |
| `server/src/services/emailConfirmation.js`    | `confirmationRedirect`, `sendEmailConfirmation`                                                                                                                                                                    | Validate trusted confirmation redirects and request Supabase email delivery with safe error handling.                                                      |
| `server/src/services/importFiles.js`          | `fileRpc`, `importLeadFile`                                                                                                                                                                                        | Persist parsed rows and import-file history/results through SQL.                                                                                           |
| `server/src/services/leadAssignment.js`       | `assign`                                                                                                                                                                                                           | Invoke protected individual assignment/round-robin transaction.                                                                                            |
| `server/src/services/leadImport.js`           | `headerKey`, `invalid`, `rowLimit`, `blank`, `csvRecords`, `excelRecords`, `leadRows`, `matchColumns`, `parseLeadImport`, `agentKey`, `emptyAgent`, `resolveImportAgents`, `importValidationMessage`               | CSV/XLSX/XLS parsing, normalized headers/mapping and agent resolution.                                                                                     |
| `server/src/services/leadManagement.js`       | `leadManagementRpc`                                                                                                                                                                                                | Call protected lead-management SQL and translate safe migration, conflict and permission errors.                                                           |
| `server/src/services/meta/config.js`          | `metaConfig`, `metaReady`                                                                                                                                                                                          | Validate server-only Meta settings, fixed HTTPS callback, Graph version and independent encryption key.                                                    |
| `server/src/services/meta/crypto.js`          | `encryptToken`, `decryptToken`, `validSignature`, `safeEqual`                                                                                                                                                      | Context-bound AES-GCM token storage and constant-time webhook signature checks.                                                                            |
| `server/src/services/meta/graph.js`           | `failure`, `graphClient`, `request`, `list`                                                                                                                                                                        | Fixed-host authenticated Meta requests, timeout/size bounds and safe cursor pagination.                                                                    |
| `server/src/services/meta/normalize.js`       | `normalizeSubmission`                                                                                                                                                                                              | Allowlisted mappings, canonical phone identity, review reasons and truthful source attribution.                                                            |
| `server/src/services/meta/rpc.js`             | `metaRpc`                                                                                                                                                                                                          | Translate protected Meta SQL failures without sensitive provider/database output.                                                                          |
| `server/src/services/metaLeads.js`            | Startup, shared constants or compatibility export                                                                                                                                                                  | Compatibility export of the durable Facebook/Instagram Instant Form worker.                                                                                |
| `server/src/services/mfa.js`                  | `requireAgentMfa`, `mfaRpc`, `createMfaClient`, `totpFactors`, `verifiedClaims`, `freshMfa`                                                                                                                        | Verify signed MFA assurance, private reset state and isolated native Auth request identity.                                                                |
| `server/src/services/phoneAccess.js`          | `phoneRevealLimit`, `phoneAccessRpc`, `leadContacts`                                                                                                                                                               | Load audited authorized page contacts; translate private RPC failures and preserve historical usage settings.                                              |
| `server/src/services/propertyCovers.js`       | `propertyCovers`                                                                                                                                                                                                   | Batch property-card cover metadata and private Storage URL signing.                                                                                        |
| `server/src/services/systemStatus.js`         | `recordJob`, `systemStatus`                                                                                                                                                                                        | Safe operational reads and durable job outcome recording.                                                                                                  |
| `server/src/services/whatsapp.js`             | `whatsapp`                                                                                                                                                                                                         | Disabled WhatsApp integration boundary; no live messaging.                                                                                                 |
| `server/src/utils/duplicateCheck.js`          | `isDuplicate`                                                                                                                                                                                                      | Normalized customer-phone duplicate lookup support.                                                                                                        |
| `server/src/utils/phoneMask.js`               | `normalizePhone`, `phoneMask`, `csvCell`                                                                                                                                                                           | Normalize contact identity, mask safe records and escape CSV cells.                                                                                        |
| `server/src/utils/validators.js`              | `manualCall`, `minutesOf`, `periodStartValid`, `requireLostReason`, `clockMinutes`                                                                                                                                 | Strict entity, role-specific update, list and loss-reason schemas.                                                                                         |

### Local setup and maintenance scripts

| Module                             | Named functions/helpers                                            | Responsibility                                                                         |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `scripts/benchmark-performance.js` | `measure`, `ordered`                                               | Measure synthetic PostgreSQL queries before/after migration 027 without hosted access. |
| `scripts/build-sql.js`             | Startup, shared constants or compatibility export                  | Generate the fresh-install SQL bundle from ordered migrations and seed.                |
| `scripts/configuration.js`         | `envValue`, `legacyRole`, `validateSettings`, `configurationFiles` | Validate connection/dev settings and safely construct environment files.               |
| `scripts/configure.js`             | `ask`                                                              | Interactive private connection and optional development account setup.                 |
| `scripts/send-mock-event.js`       | Startup, shared constants or compatibility export                  | Send the explicitly configured signed development event fixture.                       |
| `scripts/setup-dev.js`             | Startup, shared constants or compatibility export                  | Provision explicit new development Auth accounts outside production.                   |
| `scripts/verify-live.js`           | `get`                                                              | Opt-in read-only acceptance checks for a configured real development service.          |

### PostgreSQL function inventory

Each entry identifies its latest definition after all ordered migrations. Replaced earlier definitions are not counted twice.

| Function                         | Latest migration                           | Responsibility                                                                                                                        |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `accept_account_invitation`      | `023_admin_account_invitations.sql`        | Accept after authorized password setup; atomically activate intended access and audit.                                                |
| `account_action`                 | `035_pending_account_verification.sql`     | Validate and audit external Auth account-operation intent/results.                                                                    |
| `account_action_034`             | `035_pending_account_verification.sql`     | Preserve prior account audits behind the new partial-request guard.                                                                   |
| `account_creation_context`       | `035_pending_account_verification.sql`     | Authorize the initiating active admin and current session-bound PIN before private request access.                                    |
| `account_creation_list`          | `035_pending_account_verification.sql`     | List the initiating administrator's latest unfinished requests without hashes or full recipients.                                     |
| `account_creation_summary`       | `035_pending_account_verification.sql`     | Return only masked pending-request metadata and safe completion status.                                                               |
| `account_detail`                 | `036_account_uids.sql`                     | Return PIN-gated account details, UID and bounded activity.                                                                           |
| `account_detail_023`             | `028_account_deletion.sql`                 | Preserved PIN-protected account details behind deletion-state handling.                                                               |
| `account_detail_032`             | `033_agent_email_codes.sql`                | Retain current PIN/MFA/deletion-aware detail reader behind safe email-code metadata.                                                  |
| `account_detail_034`             | `035_pending_account_verification.sql`     | Preserve prior account detail fields behind safe independent-creation pending metadata.                                               |
| `account_detail_035`             | `036_account_uids.sql`                     | Preserve prior account detail fields behind the UID field.                                                                            |
| `account_email_code_ready`       | `034_account_email_codes.sql`              | Require update 034 and the active-admin Accounts grant before provisioning either account role.                                       |
| `account_lifecycle`              | `028_account_deletion.sql`                 | Derive invitation/verification/active/suspended states using server time and native confirmation.                                     |
| `account_lifecycle_023`          | `028_account_deletion.sql`                 | Preserved invitation lifecycle reader behind deletion-state handling.                                                                 |
| `account_provisioning_summary`   | `036_account_uids.sql`                     | Return the saved account name, email, role, UID, access and lifecycle status after creation.                                          |
| `account_uid_available`          | `036_account_uids.sql`                     | PIN-gated advisory check that a six-digit UID is neither assigned nor reserved.                                                       |
| `account_uid_candidate`          | `036_account_uids.sql`                     | Draw one uniformly distributed six-digit candidate from the cryptographic generator.                                                  |
| `accounts_admin`                 | `016_accounts_and_security.sql`            | Recheck that the actor is an active administrator.                                                                                    |
| `accounts_gate`                  | `016_accounts_and_security.sql`            | Require a valid personal, session-bound, unexpired unlock grant.                                                                      |
| `accounts_page`                  | `035_pending_account_verification.sql`     | Return a PIN-gated, filtered account directory.                                                                                       |
| `accounts_page_032`              | `036_account_uids.sql`                     | PIN/deletion-aware account pagination with UID column and UID search; later wrappers add safe delivery-method fields.                 |
| `accounts_page_034`              | `035_pending_account_verification.sql`     | Preserve prior account pagination behind safe independent-creation pending metadata.                                                  |
| `advance_lead_status`            | `012_pipeline_and_lost_reasons.sql`        | Advance an authorized lead automatically; protect terminal stages.                                                                    |
| `agent_email_code_context`       | `035_pending_account_verification.sql`     | Recheck PIN, target role/email/deletion, request method, state and expiry under ownership locks.                                      |
| `agent_email_code_context_034`   | `035_pending_account_verification.sql`     | Retain historical native verification while excluding independent partial users.                                                      |
| `agent_email_code_ready`         | `033_agent_email_codes.sql`                | Require the current active-admin Accounts grant before native agent creation.                                                         |
| `apply_call_event`               | `012_pipeline_and_lost_reasons.sql`        | Deduplicate events and preserve monotonic call/outcome state.                                                                         |
| `assign_account_uid`             | `036_account_uids.sql`                     | Copy a reserved UID/name/role or generate a UID when a profile is inserted; reject any UID change.                                    |
| `assign_lead`                    | `024_meta_lead_ads.sql`                    | Admin/active-agent checks, locked assignment and history.                                                                             |
| `assign_lead_023`                | `024_meta_lead_ads.sql`                    | Retain prior assignment and pending-work handover implementation behind the social first-assignment guard.                            |
| `assign_lead_import`             | `014_import_files_and_assignments.sql`     | Atomically assign accepted batch members and audited history.                                                                         |
| `assign_leads_bulk`              | `030_bulk_lead_assignment.sql`             | Authorize and lock up to 500 leads, rotate active recipients evenly or assign/unassign through ownership helpers and report outcomes. |
| `attach_knowledge_file`          | `022_agent_offboarding_and_kyc_access.sql` | Validate/attach a private file against its upload reservation.                                                                        |
| `attendance_admin`               | `040_attendance.sql`                       | Require an active administrator.                                                                                                      |
| `attendance_check_in`            | `040_attendance.sql`                       | Check the signed-in employee in with the database clock.                                                                              |
| `attendance_check_in_at`         | `040_attendance.sql`                       | Check in at an explicit time (database owner and tests only).                                                                         |
| `attendance_check_out`           | `040_attendance.sql`                       | Check the signed-in employee out with the database clock.                                                                             |
| `attendance_check_out_at`        | `040_attendance.sql`                       | Check out at an explicit time (database owner and tests only).                                                                        |
| `attendance_compute`             | `040_attendance.sql`                       | Punctuality, minutes late, worked, early-departure and overtime minutes.                                                              |
| `attendance_correction_cancel`   | `040_attendance.sql`                       | Cancel one's own pending correction.                                                                                                  |
| `attendance_correction_page`     | `040_attendance.sql`                       | Paginated correction requests (own, or all for admins).                                                                               |
| `attendance_correction_request`  | `040_attendance.sql`                       | Validated correction request for a recent working day; notifies admins.                                                               |
| `attendance_correction_review`   | `040_attendance.sql`                       | Approve (recalculate and audit before/after) or reject a correction; never one's own.                                                 |
| `attendance_daily`               | `040_attendance.sql`                       | Filtered, paginated register of everyone expected on a date.                                                                          |
| `attendance_days`                | `040_attendance.sql`                       | Each employee's derived attendance state for each day in a range.                                                                     |
| `attendance_employee`            | `040_attendance.sql`                       | One employee's history and requests; employees may view only themselves.                                                              |
| `attendance_employees`           | `040_attendance.sql`                       | Employees with attendance history, including disabled accounts.                                                                       |
| `attendance_holiday_delete`      | `040_attendance.sql`                       | Admin-only holiday removal with audit.                                                                                                |
| `attendance_holiday_save`        | `040_attendance.sql`                       | Admin-only holiday creation with audit.                                                                                               |
| `attendance_holidays_list`       | `040_attendance.sql`                       | Company holidays in a year.                                                                                                           |
| `attendance_leave_cancel`        | `040_attendance.sql`                       | Cancel one's own pending leave request.                                                                                               |
| `attendance_leave_page`          | `040_attendance.sql`                       | Paginated leave requests (own, or all for admins).                                                                                    |
| `attendance_leave_request`       | `040_attendance.sql`                       | Validated leave request without overlaps; notifies admins.                                                                            |
| `attendance_leave_review`        | `040_attendance.sql`                       | Approve or reject leave; never one's own; audited and notified.                                                                       |
| `attendance_local_date`          | `040_attendance.sql`                       | Pakistan calendar date of a moment.                                                                                                   |
| `attendance_me`                  | `040_attendance.sql`                       | Today's status, rules, month totals, recent days and open incomplete days for the signed-in user.                                     |
| `attendance_member`              | `040_attendance.sql`                       | Require an active Admin or Agent account.                                                                                             |
| `attendance_moment`              | `040_attendance.sql`                       | A Pakistan date and time as a timestamp.                                                                                              |
| `attendance_notify_admins`       | `040_attendance.sql`                       | Notify every other active administrator.                                                                                              |
| `attendance_overview`            | `040_attendance.sql`                       | Today's attendance counts by state and arrival time for admins.                                                                       |
| `attendance_period`              | `040_attendance.sql`                       | Weekly or monthly totals, daily states and trend for admins.                                                                          |
| `attendance_policies_list`       | `040_attendance.sql`                       | Current attendance rules and their version history.                                                                                   |
| `attendance_policy_on`           | `040_attendance.sql`                       | The attendance rules in force on a date.                                                                                              |
| `attendance_policy_save`         | `040_attendance.sql`                       | Schedule versioned attendance rules from today or later without rewriting history.                                                    |
| `attendance_reconcile`           | `040_attendance.sql`                       | Mark earlier open sessions incomplete and send the admins' daily attendance summary.                                                  |
| `attendance_record_json`         | `040_attendance.sql`                       | Attendance record as JSON for API responses.                                                                                          |
| `attendance_totals`              | `040_attendance.sql`                       | Per-employee attendance totals and percentage over a range.                                                                           |
| `authorize_knowledge_download`   | `022_agent_offboarding_and_kyc_access.sql` | Authorize and audit a private attachment download in one transaction.                                                                 |
| `begin_account_creation`         | `035_pending_account_verification.sql`     | Atomically check original password binding and OTP, record attempts and lease one finalization.                                       |
| `begin_account_provisioning`     | `036_account_uids.sql`                     | Validate a Gmail-only request, reject used emails/UIDs, recover abandoned reservations and reserve id/UID/role.                       |
| `begin_agent_email_code`         | `033_agent_email_codes.sql`                | Claim a bounded verification attempt and reject parallel or exhausted checks.                                                         |
| `block_audit_changes`            | `008_audit_log.sql`                        | Reject audit record updates and deletes.                                                                                              |
| `call_activity`                  | `038_lead_response_and_notifications.sql`  | Today's calls, first calls, waiting, missed and overdue work per agent.                                                               |
| `cancel_account_creation`        | `035_pending_account_verification.sql`     | Invalidate a request before external provisioning can begin.                                                                          |
| `cancel_account_invitation`      | `023_admin_account_invitations.sql`        | Admin/PIN-protected cancellation without deleting users or granting access.                                                           |
| `check_account_email`            | `023_admin_account_invitations.sql`        | Admin/PIN-gated duplicate email check and safe creation intent audit.                                                                 |
| `complete_account_creation`      | `035_pending_account_verification.sql`     | Validate the reserved native identity, assign role and complete activation in one audited transaction.                                |
| `complete_account_provisioning`  | `036_account_uids.sql`                     | Confirm the reserved Auth user and profile, activate intended access and audit creation.                                              |
| `complete_agent_email_code`      | `034_account_email_codes.sql`              | Activate intended access only after verified native email and password setup, with atomic audit.                                      |
| `copy_targets`                   | `039_calendar_targets_reports.sql`         | Copy active agents' targets from the previous period without overwriting.                                                             |
| `create_lead`                    | `032_deleted_leads_bin.sql`                | Atomically create customer metadata, unique private phone and audit.                                                                  |
| `create_lead_031`                | `032_deleted_leads_bin.sql`                | Retained lead creation implementation behind the recoverable-phone guard.                                                             |
| `create_profile`                 | `023_admin_account_invitations.sql`        | Create an inactive Agent profile; metadata cannot grant role or access.                                                               |
| `crm_leaderboard`                | `027_loading_performance.sql`              | Return safe names and completed-call/won-deal aggregates.                                                                             |
| `crm_metrics`                    | `039_calendar_targets_reports.sql`         | Aggregate the authorized dataset for a half-open range, including first-call speed and misses.                                        |
| `crm_metrics_028`                | `029_lead_numbers.sql`                     | Retained scoped report aggregates, upgraded to exclude deleted leads.                                                                 |
| `crm_metrics_037`                | `038_lead_response_and_notifications.sql`  | Previous overview metrics extended by update 038.                                                                                     |
| `crm_metrics_038`                | `039_calendar_targets_reports.sql`         | Previous overview metrics extended by update 039.                                                                                     |
| `crm_mutate`                     | `032_deleted_leads_bin.sql`                | Strict authorized CRM mutation with locks, history and audit.                                                                         |
| `crm_mutate_031`                 | `032_deleted_leads_bin.sql`                | Retained entity mutation and auditing behind deleted-lead authorization checks.                                                       |
| `dashboard_snapshot`             | `029_lead_numbers.sql`                     | Return authorized metrics, grouped leaders, current-owner activities and own targets together.                                        |
| `delete_knowledge_document`      | `015_documentation_and_policies.sql`       | Remove an entry, queue attachment cleanup and audit.                                                                                  |
| `delete_knowledge_file`          | `015_documentation_and_policies.sql`       | Remove an attachment and queue its private object cleanup.                                                                            |
| `delete_lead_import`             | `032_deleted_leads_bin.sql`                | Remove only a file or soft-delete its eligible leads in bounded batches with shared recovery metadata.                                |
| `delete_leads`                   | `032_deleted_leads_bin.sql`                | Soft-delete eligible leads, cancel pending work, preserve won deals and emit a counts-only audit/security alert.                      |
| `delete_property`                | `013_property_deletion.sql`                | Reject linked deletion; queue eligible photos and audit removal.                                                                      |
| `deleted_imports_page`           | `032_deleted_leads_bin.sql`                | List recoverable file-and-lead deletions for administrators.                                                                          |
| `deleted_leads_page`             | `032_deleted_leads_bin.sql`                | Admin-only filtered pagination of deleted lead identities, reasons and restore deadlines.                                             |
| `edit_lead`                      | `031_admin_lead_editing.sql`               | Atomically edit administrator fields, phone and owner with complete rollback on failure.                                              |
| `fail_account_provisioning`      | `036_account_uids.sql`                     | Release a reservation only when no Auth user exists for it.                                                                           |
| `finish_account_creation_email`  | `035_pending_account_verification.sql`     | Record delivery request outcome without claiming verified ownership.                                                                  |
| `finish_account_deletion`        | `028_account_deletion.sql`                 | Fence completion, verify native Auth deletion and safely finalize or retain retryable state.                                          |
| `finish_account_invitation`      | `023_admin_account_invitations.sql`        | Audit mail-request result for the current ticket; uncertain setup remains blocked.                                                    |
| `finish_agent_email_code`        | `033_agent_email_codes.sql`                | Record mail request success/failure without activating the account.                                                                   |
| `first_call_due`                 | `038_lead_response_and_notifications.sql`  | Compute a first-call deadline from working days, hours and the last-call window.                                                      |
| `first_call_queue`               | `038_lead_response_and_notifications.sql`  | An agent's leads waiting for a first call, without contact numbers.                                                                   |
| `format_lead_no`                 | `032_deleted_leads_bin.sql`                | Format stable HD identifiers for safe SQL conflict and restore messages.                                                              |
| `format_pk_time`                 | `038_lead_response_and_notifications.sql`  | Format a moment as a short Pakistan date and time for notification text.                                                              |
| `generate_account_uid`           | `036_account_uids.sql`                     | Pick an unused six-digit UID under a lock, retrying up to 200 draws.                                                                  |
| `guard_account_activation`       | `023_admin_account_invitations.sql`        | Refuse activation of unconfirmed accounts or unaccepted tracked invitations.                                                          |
| `guard_account_deletion`         | `028_account_deletion.sql`                 | Prevent deleted/pending accounts being reenabled, renamed or restored.                                                                |
| `guard_attendance_policy`        | `040_attendance.sql`                       | Refuse overlapping attendance policy periods.                                                                                         |
| `guard_deleted_invitation`       | `028_account_deletion.sql`                 | Keep invitations cancelled once account deletion starts.                                                                              |
| `guard_lead_number`              | `029_lead_numbers.sql`                     | Prevent editing a permanent generated lead number.                                                                                    |
| `guard_pending_account_creation` | `035_pending_account_verification.sql`     | Deny role escalation/activation for a partial independent challenge user.                                                             |
| `handover_lead`                  | `022_agent_offboarding_and_kyc_access.sql` | Move one lead and pending follow-ups, scheduled visits and future unread reminders; preserve history.                                 |
| `import_leads`                   | `014_import_files_and_assignments.sql`     | Persist an import batch and accepted rows with row-level rejections.                                                                  |
| `invitation_context`             | `034_account_email_codes.sql`              | Authorize the current confirmed recipient, exact email and unexpired invitation ticket.                                               |
| `invitation_context_032`         | `033_agent_email_codes.sql`                | Retain recipient link context behind the guard excluding agent-code enrollments.                                                      |
| `issue_account_invitation`       | `033_agent_email_codes.sql`                | Rotate recipient-bound ticket hash, expiry and desired access; keep profile inactive.                                                 |
| `issue_account_invitation_032`   | `033_agent_email_codes.sql`                | Retain protected administrator invitation issuance behind delivery-state reset.                                                       |
| `issue_agent_email_code`         | `035_pending_account_verification.sql`     | Stage a role-bound ten-minute account code request, preserve intended access and rotate private request state.                        |
| `issue_agent_email_code_034`     | `035_pending_account_verification.sql`     | Retain historical native code issuance while excluding independent partial users.                                                     |
| `knowledge_document_access`      | `022_agent_offboarding_and_kyc_access.sql` | Authorize an active admin or a KYC client's current agent; reject foreign/unlinked KYC as not found.                                  |
| `knowledge_documents_page`       | `022_agent_offboarding_and_kyc_access.sql` | Apply current-owner KYC scope before literal search, counts and pagination.                                                           |
| `lead_contact_phones`            | `021_visible_lead_contacts.sql`            | Lock and authorize a page of contacts, then return full numbers with atomic safe audits and no daily display quota.                   |
| `lead_delete_preview`            | `032_deleted_leads_bin.sql`                | Admin-only counts of customer leads and pending work before confirmation.                                                             |
| `lead_import_summary`            | `029_lead_numbers.sql`                     | Return an import summary scoped to current member ownership.                                                                          |
| `lead_imports_page`              | `014_import_files_and_assignments.sql`     | Search/paginate currently visible import batches.                                                                                     |
| `lead_recording_cleanup_batch`   | `032_deleted_leads_bin.sql`                | Service-only bounded reader for orphan recording objects pending deletion.                                                            |
| `lead_recording_cleanup_done`    | `032_deleted_leads_bin.sql`                | Acknowledge an orphan recording only after storage/provider cleanup succeeds.                                                         |
| `lead_response_job`              | `038_lead_response_and_notifications.sql`  | Mark missed first calls and send missed-call, due-soon, visit and daily-summary notices.                                              |
| `lead_review_page`               | `038_lead_response_and_notifications.sql`  | Admin-only paginated list of missed first calls or quiet leads.                                                                       |
| `list_knowledge_documents`       | `022_agent_offboarding_and_kyc_access.sql` | Authorize literal category/search filtering before pagination.                                                                        |
| `lock_accounts`                  | `016_accounts_and_security.sql`            | Revoke the current matching session-bound unlock grant.                                                                               |
| `log_manual_call`                | `018_manual_call_logging.sql`              | Validate authorized phone-call logs, lock current ownership, preserve duration and audit atomically.                                  |
| `login_attempt_status`           | `037_login_security.sql`                   | Report whether an email is currently locked after repeated wrong passwords.                                                           |
| `login_history_page`             | `037_login_security.sql`                   | Admin-only paginated login history with account, result and date filters plus summary totals.                                         |
| `mark_agent_email_code`          | `033_agent_email_codes.sql`                | Persist native inbox proof for the matching current claim without granting access.                                                    |
| `meta_assign`                    | `024_meta_lead_ads.sql`                    | Lock and assign distinct pending customers to one active agent atomically; reject conflicts.                                          |
| `meta_claim`                     | `024_meta_lead_ads.sql`                    | Claim due durable work with bounded attempts and expiring fenced leases.                                                              |
| `meta_cleanup`                   | `024_meta_lead_ads.sql`                    | Remove expired private answers/states and mark exhausted crashed worker attempts failed.                                              |
| `meta_configure`                 | `024_meta_lead_ads.sql`                    | Authorize Page/form synchronization and validate allowlisted question mappings.                                                       |
| `meta_disconnect`                | `024_meta_lead_ads.sql`                    | Pause all connected Pages, remove private credentials and retain customer history.                                                    |
| `meta_enqueue`                   | `024_meta_lead_ads.sql`                    | Transactionally persist authorized provider submissions and replay identity before acknowledgement.                                   |
| `meta_fail`                      | `024_meta_lead_ads.sql`                    | Fence failed processing, schedule bounded retry and mark authorization problems safely.                                               |
| `meta_finish`                    | `024_meta_lead_ads.sql`                    | Recheck lease/selection, retain private answers, create unassigned customer or match existing identity/review.                        |
| `meta_first_assignment_guard`    | `024_meta_lead_ads.sql`                    | Refuse direct or automatic first ownership changes for pending social customers.                                                      |
| `meta_inbox`                     | `024_meta_lead_ads.sql`                    | Authorize/filter/count/page admin enquiries and audit visible structured customer contacts.                                           |
| `meta_oauth_consume`             | `024_meta_lead_ads.sql`                    | Atomically consume one valid cookie-bound state and recheck active administrator access.                                              |
| `meta_oauth_start`               | `024_meta_lead_ads.sql`                    | Authorize administrator and store an expiring hashed browser-bound OAuth state.                                                       |
| `meta_page_secret`               | `024_meta_lead_ads.sql`                    | Return the selected encrypted Page credential only to the trusted admin server path.                                                  |
| `meta_read_notice`               | `024_meta_lead_ads.sql`                    | Persist one administrator notice dismissal per saved provider submission.                                                             |
| `meta_report`                    | `024_meta_lead_ads.sql`                    | Distinguish submissions from first-inquiry unique-customer cohorts and existing activity/value metrics.                               |
| `meta_resolve`                   | `024_meta_lead_ads.sql`                    | Authorize review correction and reuse protected finalization without fake contacts.                                                   |
| `meta_retry`                     | `024_meta_lead_ads.sql`                    | Authorize retryable lifecycle reset without duplicating provider identity.                                                            |
| `meta_save_connection`           | `024_meta_lead_ads.sql`                    | Replace encrypted authorization, save accessible Pages and pause old Page selections.                                                 |
| `meta_save_forms`                | `024_meta_lead_ads.sql`                    | Persist discovered provider form identities and bounded question metadata.                                                            |
| `meta_settings`                  | `024_meta_lead_ads.sql`                    | Return safe administrator-only connection, Page and form configuration without credentials.                                           |
| `meta_submission`                | `024_meta_lead_ads.sql`                    | Audit administrator detail access and return unexpired answers plus existing assignment history.                                      |
| `meta_summary`                   | `024_meta_lead_ads.sql`                    | Count real submissions and pending customers; return per-admin undismissed notices.                                                   |
| `mfa_begin_attempt`              | `025_admin_totp_mfa.sql`                   | Atomically reserve bounded per-user native verification work before provider calls.                                                   |
| `mfa_finish_attempt`             | `025_admin_totp_mfa.sql`                   | Fence attempt completion, audit safe results and create deduplicated repeated-failure alerts.                                         |
| `mfa_reset_begin`                | `025_admin_totp_mfa.sql`                   | Require another active admin/PIN, stage blocked recovery, revoke target grants and audit intent.                                      |
| `mfa_reset_finish`               | `025_admin_totp_mfa.sql`                   | Fence native-factor recovery completion/failure while retaining old-session invalidation.                                             |
| `mfa_session_state`              | `025_admin_totp_mfa.sql`                   | Return active-user private reset state and old-session cutoff to the trusted server.                                                  |
| `normalize_lead_phone`           | `031_admin_lead_editing.sql`               | Normalize Pakistani/international customer phone identities using the shared rules.                                                   |
| `notifications_page`             | `038_lead_response_and_notifications.sql`  | The signed-in user's latest notifications and unread count.                                                                           |
| `notify_lead_owner`              | `038_lead_response_and_notifications.sql`  | Notify the new and previous owner of an assignment, one summary per transaction.                                                      |
| `offboard_agent`                 | `022_agent_offboarding_and_kyc_access.sql` | Atomically disable an agent, transfer all lead statuses using the selected mode and audit counts.                                     |
| `offboard_preview`               | `022_agent_offboarding_and_kyc_access.sql` | Require the current admin/PIN grant and return owned-work counts only.                                                                |
| `phone_reveal_status`            | `022_agent_offboarding_and_kyc_access.sql` | Return only the active actor's distinct-lead daily usage and reset time.                                                              |
| `phone_reveal_window`            | `022_agent_offboarding_and_kyc_access.sql` | Compute the Pakistan day and its UTC bounds without a client-controlled reveal clock.                                                 |
| `prepare_account_creation`       | `035_pending_account_verification.sql`     | Reserve an independent OTP challenge and enforce durable duplicate and send limits without an Auth user.                              |
| `prepare_account_deletion`       | `028_account_deletion.sql`                 | Require admin/PIN/email confirmation, block access and hand pending work over atomically.                                             |
| `prepare_call_method`            | `018_manual_call_logging.sql`              | Classify mock adapter references without changing manually logged calls.                                                              |
| `prepare_lead_status`            | `012_pipeline_and_lost_reasons.sql`        | Validate lead stage, loss reason and loss-note rules.                                                                                 |
| `prepare_target`                 | `039_calendar_targets_reports.sql`         | Keep the legacy month column and period start consistent on every target.                                                             |
| `private_phone`                  | `032_deleted_leads_bin.sql`                | Service-only contact lookup after API authorization.                                                                                  |
| `property_cover_photos`          | `027_loading_performance.sql`              | Read the first photo and total count for a bounded set of properties after active-profile verification.                               |
| `purge_deleted_leads`            | `032_deleted_leads_bin.sql`                | Serialize a daily purge of at most 200 expired leads and queue private storage cleanup while retaining audits.                        |
| `push_notification`              | `038_lead_response_and_notifications.sql`  | Create one notification per user/type/group, summarising repeats in the same group.                                                   |
| `read_knowledge_document`        | `022_agent_offboarding_and_kyc_access.sql` | Return authorized content, linked client name and safe attachment metadata.                                                           |
| `read_knowledge_file`            | `022_agent_offboarding_and_kyc_access.sql` | Resolve a private file after current document/client access checks.                                                                   |
| `read_notifications`             | `038_lead_response_and_notifications.sql`  | Mark the signed-in user's chosen or all notifications as read.                                                                        |
| `record_backup`                  | `026_system_monitoring.sql`                | Record ciphertext backup metadata only after validated success or safe failure.                                                       |
| `record_first_call`              | `038_lead_response_and_notifications.sql`  | Stop the first-call clock at the owner's first logged call.                                                                           |
| `record_job_heartbeat`           | `026_system_monitoring.sql`                | Persist safe job completion/failure times with service-only permissions.                                                              |
| `record_lead_status_change`      | `012_pipeline_and_lost_reasons.sql`        | Persist a real old/new stage transition and context.                                                                                  |
| `record_login_attempt`           | `037_login_security.sql`                   | Count failures in a window, lock after the limit, log the attempt and raise lockout/after-hours alerts.                               |
| `recording_access`               | `032_deleted_leads_bin.sql`                | Return an unexpired private recording reference.                                                                                      |
| `recording_batch`                | `011_jobs_and_events.sql`                  | Select a bounded batch of expired recording references.                                                                               |
| `recording_deleted`              | `011_jobs_and_events.sql`                  | Record successful deletion or a retryable cleanup error.                                                                              |
| `release_account_creation`       | `035_pending_account_verification.sql`     | Release only the matching finalization lease after an operation finishes.                                                             |
| `release_agent_email_code`       | `033_agent_email_codes.sql`                | Release only the matching temporary verification claim.                                                                               |
| `report_agents`                  | `039_calendar_targets_reports.sql`         | Per-agent assignment, first-call speed, calling, visits, sales and losses in a range.                                                 |
| `report_funnel`                  | `039_calendar_targets_reports.sql`         | Leads created in a range and the furthest pipeline stage each reached.                                                                |
| `report_inactive_lead_owners`    | `022_agent_offboarding_and_kyc_access.sql` | Detect inactive owners across all stages and deduplicate safe daily security alerts.                                                  |
| `report_lost`                    | `039_calendar_targets_reports.sql`         | Leads lost in a range by reason, source and agent.                                                                                    |
| `report_scope`                   | `039_calendar_targets_reports.sql`         | Check the active user and date range; agents are limited to their own figures.                                                        |
| `report_sources`                 | `039_calendar_targets_reports.sql`         | Leads created in a range by source with contacted, visited, won, lost and revenue.                                                    |
| `require_kyc_client`             | `022_agent_offboarding_and_kyc_access.sql` | Require a lead link on new/converted/detached KYC while preserving older unlinked entries.                                            |
| `resend_account_creation`        | `035_pending_account_verification.sql`     | Rotate OTP/version and expiry under cooldown, hourly limits and concurrency guards.                                                   |
| `restore_lead_import`            | `032_deleted_leads_bin.sql`                | Restore a deleted file and its remaining eligible batch leads transactionally.                                                        |
| `restore_leads`                  | `032_deleted_leads_bin.sql`                | Restore at most 500 eligible leads within 30 days, preserving their numbers and history without assigning them.                       |
| `reveal_phone`                   | `022_agent_offboarding_and_kyc_access.sql` | Serialize current-owner phone reads, enforce daily quotas, record reveals/audits and commit threshold alerts.                         |
| `review_keep_leads`              | `038_lead_response_and_notifications.sql`  | Keep reviewed leads with their agent, set a new deadline and notify the agent.                                                        |
| `review_reassign_leads`          | `038_lead_response_and_notifications.sql`  | Reassign reviewed leads through the audited bulk path with a recorded reason.                                                         |
| `review_security_alert`          | `022_agent_offboarding_and_kyc_access.sql` | Lock and mark an alert reviewed with administrator verification and atomic audit.                                                     |
| `run_crm_job`                    | `040_attendance.sql`                       | Run reminder, outcome and first-call jobs; the stale job no longer reassigns (update 038).                                            |
| `run_crm_job_037`                | `038_lead_response_and_notifications.sql`  | Previous job runner kept for reminders, outcomes and other existing jobs.                                                             |
| `run_crm_job_039`                | `040_attendance.sql`                       | Previous job runner kept for reminders, outcomes and first-call jobs.                                                                 |
| `save_accounts_pin`              | `016_accounts_and_security.sql`            | Rotate personal PIN state, revoke grants and audit the change.                                                                        |
| `save_knowledge_document`        | `022_agent_offboarding_and_kyc_access.sql` | Admin-only save of text, category, property name and keywords.                                                                        |
| `save_target`                    | `039_calendar_targets_reports.sql`         | Admin-only validated create or edit of a day, week or month target with audit.                                                        |
| `save_work_settings`             | `038_lead_response_and_notifications.sql`  | Admin-only validated update of working hours with an audit row.                                                                       |
| `search_kyc_clients`             | `022_agent_offboarding_and_kyc_access.sql` | Administrator-only client name search/selected lookup returning masked phones.                                                        |
| `security_alerts_page`           | `022_agent_offboarding_and_kyc_access.sql` | Authorize and filter/page safe administrator security alert metadata.                                                                 |
| `security_alerts_summary`        | `022_agent_offboarding_and_kyc_access.sql` | Authorize an active administrator and aggregate unreviewed alert counts.                                                              |
| `stamp_assignment`               | `038_lead_response_and_notifications.sql`  | Copy the deadline and review reason onto each assignment history row.                                                                 |
| `stamp_followup_completion`      | `039_calendar_targets_reports.sql`         | Record when a follow-up was completed for the follow-up goal.                                                                         |
| `system_status`                  | `040_attendance.sql`                       | Authorize active Admin and report expected schema/fresh job/backup state.                                                             |
| `target_period_end`              | `039_calendar_targets_reports.sql`         | First day after a day, week or month target period.                                                                                   |
| `targets_page`                   | `039_calendar_targets_reports.sql`         | Paginated targets by period, start or those running today; agents see their own.                                                      |
| `touch_updated`                  | `001_users_and_roles.sql`                  | Maintain updated timestamps on mutable records.                                                                                       |
| `track_attendance_period`        | `040_attendance.sql`                       | Open or close attendance eligibility when an account is enabled, disabled or deleted.                                                 |
| `track_lead_owner`               | `038_lead_response_and_notifications.sql`  | Restart the first-call clock whenever a lead changes owner.                                                                           |
| `unlock_accounts`                | `016_accounts_and_security.sql`            | Track PIN attempts/lockout and issue a hashed temporary grant.                                                                        |
| `update_account`                 | `035_pending_account_verification.sql`     | Serialize name/role/access updates and preserve an active admin.                                                                      |
| `update_account_022`             | `023_admin_account_invitations.sql`        | Retained migration-022 admin/PIN, role, continuity and handover validation used by the new wrapper.                                   |
| `update_account_034`             | `035_pending_account_verification.sql`     | Preserve prior account editing behind the new partial-request guard.                                                                  |
| `update_lead_phone`              | `031_admin_lead_editing.sql`               | Require admin, prevent duplicate identity, update vault/mask together and audit without phone values.                                 |
| `visit_calendar`                 | `039_calendar_targets_reports.sql`         | Visits in a range of up to 62 days with lead, property and agent names, no phone numbers.                                             |
| `visit_conflicts`                | `039_calendar_targets_reports.sql`         | The same agent's other scheduled visits within 60 minutes of a time.                                                                  |
| `work_settings`                  | `038_lead_response_and_notifications.sql`  | Read the working days and hours used for deadlines.                                                                                   |
| `working_minutes`                | `038_lead_response_and_notifications.sql`  | Count minutes inside working hours between two moments.                                                                               |

<!-- function-catalog:end -->
