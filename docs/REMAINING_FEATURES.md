# HD Marketing CRM: Remaining Features and Functions

Prepared 8 October 2026. Companion to _Complete Project Documentation_. Implement one feature (F1–F37) at a time.

**Implementation update, 14 October 2026:** The user removed mandatory F20 administrator TOTP login after its implementation. Admins now use email/password without update 025; optional-agent TOTP and PIN-protected agent recovery use the preserved 025 schema. Hosted acceptance remains pending. Accounts already includes invitations, roles and MFA reset. P6 deployment code/files and system monitoring are implemented locally in 026; live deployment/backup restore, P7 and P8 remain pending. VPS/domain/SMTP are unprepared. Historical feature specifications and proposed migration names below must be reconciled with the current source before implementation.

**Phone access update, 9 October 2026:** the user's later request supersedes this document's original admin-only phone rule. Full phone numbers now display automatically without Show/Hide buttons. Admins see any accessible lead's number; agents see only their currently assigned leads' numbers through the audited server endpoints. Direct Supabase table/RPC access remains denied. Use the current [README permissions](../README.md#permissions-and-privacy) when implementing later features.

# 1. How to use this document

This document compares your current HD Marketing CRM (as described in **Complete Project Documentation, 8 October 2026**) with the complete feature set we designed for the CRM, and lists only what is still missing or incomplete. Everything already built is left as it is.

Each missing item has an ID (F1, F2 …) and is written as a build specification: what exists now, the database changes, the API and server work, the screens, any background jobs, and the checks that prove it is done. You can hand one feature at a time to your VS Code AI assistant using the prompt template in Appendix D.

## Rules every new feature must follow

These are the conventions your project already uses. Keeping them means the new work fits the existing code and does not weaken security.

- **Migrations:** preserve applied files and choose the next free number after the latest actual migration (currently 026; next 027). For the existing hosted project, run each missing migration once, in order, in the Supabase SQL editor. Appendix A retains historical planning proposals, not runnable updates. Do not run setup.sql again on that project, because it refuses to run when public.profiles exists. Regenerate setup.sql with node scripts/build-sql.js only for fresh installs.

- **Writes go through SQL:** create or change business records through crm_mutate or a new security-definer function that checks the active actor, checks lead ownership, locks the rows it changes and writes an audit_log row in the same transaction. Set an empty search_path, revoke browser execute and grant only service_role.

- **Browser never reads tables directly:** new tables get RLS enabled with no browser policies and no browser grants. The browser only calls /api routes.

- **Validation:** add strict Zod schemas in server/src/utils/validators.js; unknown fields are rejected. Mirror form rules in the client.

- **Roles:** admin-only routes use adminOnly(); agent access follows the lead's current assignment. Full authorized contact numbers display automatically under the later user request. Admins use verified email/password. Required/enrolled agent MFA is enforced by the server before protected business handlers.

- **Time and money:** store UTC, show and enter Asia/Karachi time, format money as PKR.

- **Audit:** every sensitive read (phone reveal, recording playback, export) and every business change is audited with safe metadata only (field names and IDs, never phone numbers or message text).

- **Tests:** each feature adds tests in server/tests/ (API and database) and client/tests/ (screens), and npm test must stay green.

# 2. Gap summary

## 2.1 Already complete in your CRM

These planned features are implemented and need no new work, apart from the improvements listed later:

- Supabase login, password recovery, admin and agent roles, trusted profile checks on every request, disabled-account blocking.

- Masked customer phones, private phone vault, audited admin phone reveal, no agent export, account watermark.

- Lead create, edit, search, filters, CSV import with duplicate prevention, manual and round-robin assignment, assignment history, activity timeline.

- Call outcomes, seven deal tags, missing-outcome job, admin Call Review, protected recording playback and 7-day retention infrastructure.

- Properties with private photos, follow-ups, site visits, in-app follow-up reminders, separate deal records.

- Monthly targets with progress, overview dashboard, reports with CSV export, leaderboard, team enable/disable, immutable audit log.

- Rate limiting, signed webhook boundary with replay protection, stale-lead reassignment job.

## 2.2 What is missing or partial

| **ID**  | **Feature**                                                         | **Status now**                                            | **Phase** |
| ------- | ------------------------------------------------------------------- | --------------------------------------------------------- | --------- |
| **F1**  | Full pipeline stages, required lost reason, stage history           | Partial                                                   | 1         |
| **F2**  | Required short call conclusion and lead temperature                 | Partial                                                   | 1         |
| **F3**  | First-response time and uncontacted-lead tracking                   | Implemented in 038                                        | 1         |
| **F4**  | Hours-based reassignment of uncalled new leads                      | 038: admin review, no automatic moves (user decision)     | 1         |
| **F5**  | Rule-based assignment and bulk assignment                           | Missing                                                   | 1         |
| **F6**  | Return or redistribute leads when an agent is disabled              | Missing                                                   | 1         |
| **F7**  | General notifications (new lead assigned, alerts)                   | Implemented in 038                                        | 1         |
| **F8**  | Site visit calendar view                                            | Implemented in 039                                        | 1         |
| **F9**  | Extra dashboard cards and sorted leaderboard                        | Partial                                                   | 1         |
| **F10** | Daily and weekly targets, follow-up and contact goals               | Implemented in 039                                        | 2         |
| **F11** | Attach leads to a target in one step                                | Missing                                                   | 2         |
| **F12** | Source, agent, funnel and lost-lead reports                         | Implemented in 039                                        | 2         |
| **F13** | Projects and units                                                  | Missing                                                   | 3         |
| **F14** | Payment plans                                                       | Missing                                                   | 3         |
| **F15** | Property videos and map location                                    | Missing                                                   | 3         |
| **F16** | Automatic property availability from deals                          | Missing                                                   | 3         |
| **F17** | Property matching for a lead                                        | Missing                                                   | 3         |
| **F18** | Bookings, token money, installments and payments                    | Missing                                                   | 3         |
| **F19** | Agent commission                                                    | Missing                                                   | 3         |
| **F20** | Two-factor login (OTP)                                              | Admin requirement removed; optional agents supported      | 4         |
| **F21** | Per-account lockout after failed logins                             | Partial (IP rate limit only)                              | 4         |
| **F22** | Auto logout after inactivity                                        | Missing                                                   | 4         |
| **F23** | Approved devices for agents                                         | Missing                                                   | 4         |
| **F24** | Login history and security alerts                                   | Missing                                                   | 4         |
| **F25** | Unusual activity detection                                          | Missing                                                   | 4         |
| **F26** | Keep-recording flag and expiry label                                | Missing                                                   | 4         |
| **F27** | Encrypted customer phones (optional)                                | Missing                                                   | 4         |
| **F28** | Production deployment, HTTPS and Cloudflare                         | Missing                                                   | 5         |
| **F29** | Daily backups, monitoring and job heartbeat                         | Missing                                                   | 5         |
| **F30** | Team management screen (invite, roles, MFA reset)                   | Accounts implemented; device/work-phone additions pending | 5         |
| **F31** | Real cloud calling and recording ingestion                          | Mock only                                                 | 6         |
| **F32** | Social inbox for organic Facebook, Instagram and WhatsApp enquiries | Missing                                                   | 6         |
| **F33** | Meta Lead Ads auto-import                                           | Implemented; live setup pending                           | 6         |
| **F34** | Website and link-in-bio enquiry form                                | Missing                                                   | 6         |
| **F35** | WhatsApp property sharing and templates                             | Disabled boundary                                         | 6         |
| **F36** | AI call conclusion (optional)                                       | Not started                                               | 7         |
| **F37** | Team Lead role (optional)                                           | Missing                                                   | 7         |

# 3. Phase 1: Complete the sales workflow

These features need no external services and make the daily lead-to-call flow complete. Build them first.

## F1. Pipeline stages, lost reasons and stage history

The planned pipeline is New → Contacted → Interested → Site visit scheduled → Visit done → Negotiation → Won (booked) → Lost, with a required reason whenever a lead is lost, so the admin can see why leads are lost.

**Current state:**

- Leads have a status field with filters and an overview pipeline. Deals have separate stages. There is no lost reason and no record of when each stage changed.

**Database:**

- Migration 012_pipeline_and_lost_reasons.sql: align lead status values to new, contacted, interested, visit_scheduled, visit_done, negotiation, won, lost. Map existing values with UPDATE before replacing the CHECK constraint.

- Add leads.lost_reason (CHECK in price, location, budget, not_interested, no_response, bought_elsewhere, wrong_number, other), leads.lost_note (≤ 500 chars) and leads.lost_at. CHECK: status = 'lost' requires lost_reason.

- New table lead_status_history (id, lead_id, from_status, to_status, actor_id, created_at), written by the same transaction that changes status.

- Automatic forward moves inside SQL (never backwards): first completed call → contacted; visit created → visit_scheduled; visit completed → visit_done; deal created → negotiation; deal won → won; deal lost → lost (reason required).

**API and server:**

- PATCH /leads/:id accepts lost_reason and lost_note; Zod refinement requires a reason when status is lost. Extend crm_mutate to allow these fields for the assigned agent.

**Screens:**

- Status change to Lost opens a dialog with a required reason dropdown and optional note.

- Leads list gets a Lost reason filter; the timeline shows stage changes.

**Done when:**

- Saving Lost without a reason fails in both the API (400) and database.

- Each status change creates one history row and one audit row.

- Agents can change status only on leads currently assigned to them.

## F2. Required call conclusion and lead temperature

After every call the admin should be able to read a one or two line conclusion and see at a glance whether the client is hot, warm, cold or dead, without opening long notes.

**Current state:**

- OutcomeForm requires an outcome; notes (up to 4,000 chars) and seven deal tags are optional.

**Database:**

- Migration 013_call_conclusion_and_temperature.sql: add calls.conclusion (10–300 chars) and calls.temperature (hot, warm, cold, dead).

- Add leads.temperature and leads.temperature_at, updated from the latest call outcome, for filtering.

- Rule: for completed calls, outcome submission requires conclusion and temperature. No-answer, busy and wrong-number outcomes may skip the conclusion.

**API and server:**

- Extend the PATCH /calls/:id schema with both fields and the conditional rule.

**Screens:**

- OutcomeForm: a short Conclusion box with a live character counter and a single-choice Hot / Warm / Cold / Dead selector. Keep the existing tags for extra detail.

- Call Review shows Conclusion and Temperature columns with a temperature filter. Leads list shows a temperature badge and filter.

**Jobs:**

- missingOutcomeCheck also flags completed calls missing a conclusion or temperature.

**Done when:**

- A completed call cannot be saved without a conclusion and temperature.

- Admin can filter today's Hot leads in one click.

## F3. First-response time and uncontacted leads

Leads go cold fast. The admin needs to see which assigned leads have not been called yet and how quickly each agent responds.

**Current state:**

- Leads store last_activity_at. No first-contact timestamp and no uncontacted count exist.

**Database:**

- Migration 014_response_tracking.sql: add leads.assigned_at (set on every assignment) and leads.first_call_at (first call attempt by the current assignee; cleared on reassignment).

- Partial index on (assigned_agent) where first_call_at IS NULL and status not in won/lost.

- Extend crm_metrics with uncontacted_leads and avg_first_response_minutes (assigned_at → first_call_at, within range).

**API and server:**

- GET /leads?view=uncontacted filter.

**Screens:**

- Dashboard card Uncontacted leads linking to the filtered list. Agents' My Leads shows uncontacted leads first with a Not called yet badge and time since assignment.

**Done when:**

- Calling a lead removes it from the uncontacted list within one refresh.

- Average response time matches a manual calculation in tests.

## F4. Fast reassignment of uncalled new leads

If an agent does not call a new lead within a few working hours, the lead should go back to the admin or the next agent instead of waiting seven days.

**Current state:**

- reassignStaleLeads reassigns after STALE_LEAD_DAYS (default 7) of inactivity.

**Database:**

- Add assignments.reason (manual, round_robin, rule, bulk, auto_no_response, auto_stale, deactivation) and leads.auto_reassign_count.

- New job case in run_crm_job for no_response, reusing the existing advisory-lock pattern and 100-lead batch.

**Jobs:**

- New job reassignUncalledLeads.js: leads assigned more than NEW_LEAD_RESPONSE_HOURS (default 2) business hours ago with first_call_at IS NULL are moved.

- REASSIGN_MODE=queue returns them unassigned and notifies admins; round_robin gives them to the next eligible agent (never the same agent).

- Count only hours inside BUSINESS_HOURS_START–BUSINESS_HOURS_END (Asia/Karachi) so night leads are not bounced. After MAX_AUTO_REASSIGN (default 2) moves, send the lead to the admin queue.

**Done when:**

- A lead assigned at 21:00 is not moved overnight.

- Previous agent and admins receive notifications (F7); assignment history shows the reason.

## F5. Rule-based and bulk assignment

The admin should be able to route leads automatically by source, project, area or budget, and assign many leads at once.

**Current state:**

- Assignment is one lead at a time from lead detail (manual or round-robin).

**Database:**

- Migration 015_assignment_rules.sql: table assignment_rules (id, name, priority, active, source, project_id, location_pattern, min_budget, max_budget, agent_ids uuid\[\], created_at, updated_at).

- Extend assign_lead with a mode rules: first active rule (by priority) that matches → least-recent round-robin among that rule's active agents; no match → global round-robin or unassigned per ASSIGNMENT_DEFAULT.

**API and server:**

- GET/POST/PATCH /assignment-rules (admin).

- POST /leads/assign-bulk (admin, sensitive limit): { lead_ids (1–200), mode: manual\|round_robin\|rules, agent_id? }, returning per-lead results like CSV import.

**Screens:**

- Checkbox selection on the admin Leads table with an Assign selected action.

- New admin screen Assignment rules with drag or number priority.

- CSV import and integration leads (F32–F34) use the rules mode by default.

**Done when:**

- Bulk assignment of 200 leads completes with one assignment and audit row per lead.

- Rules never assign to a disabled agent.

## F6. Return leads when an agent is disabled

When an employee leaves, their leads must come back to the company immediately so nothing is lost.

**Current state:**

- Disabling a profile blocks API access, but the agent's open leads, follow-ups and visits stay assigned to them.

**Database:**

- New function deactivate_user(p_user, p_actor, p_mode, p_request): in one transaction sets active = false, moves open leads (not won/lost) to the admin queue or redistributes them round-robin, moves pending follow-ups and scheduled visits to the new owner (or cancels them in queue mode), and writes assignment reason deactivation plus one audit summary.

**API and server:**

- PATCH /users/:id with active: false calls deactivate_user and accepts lead_mode: queue\|redistribute.

- Also ban the Supabase Auth user (auth.admin.updateUserById with a long ban_duration) so existing refresh tokens stop working; remove the ban when re-enabled.

**Screens:**

- Disable confirmation dialog shows how many open leads, follow-ups and visits will move and asks for queue or redistribute.

**Done when:**

- After disabling, the agent owns zero open leads and cannot sign in again.

## F7. General notifications

Agents should be told instantly when a lead is assigned to them, and admins when something needs attention.

**Current state:**

- reminders holds follow-up reminders only; the layout polls unread reminders every minute.

**Database:**

- Migration 016_notifications.sql: table notifications (id, user_id, type, title, body, entity, entity_id, created_at, read_at); copy existing reminders in and keep the follow-up dedupe rule.

- Types: lead_assigned, lead_moved_away, followup_due, visit_tomorrow, missing_outcome, target_reminder, new_enquiry, security_alert. Insert inside the same SQL transaction as the event.

- Notification text never contains customer phone numbers.

**API and server:**

- GET /notifications, PATCH /notifications/:id, POST /notifications/read-all. Keep /reminders as an alias until the client is updated.

**Screens:**

- Bell menu with a list, links to the record and mark-all-read. Optional browser push in Phase 5.

**Jobs:**

- Visit-tomorrow reminder at 18:00 PKT; missing-outcome notification to the agent.

**Done when:**

- Assigning a lead creates exactly one notification for the new owner.

## F8. Site visit calendar

**Current state:**

- Site visits appear in a paginated list (RecordsPage).

**API and server:**

- GET /visits?from=&to= range query (bounded to 62 days).

**Screens:**

- Visits screen List / Calendar toggle with week and month views in Asia/Karachi time, coloured by status. Admin can filter by agent.

- Warn when the same agent already has a visit within 60 minutes of the chosen time.

- Lazy-load the calendar route to protect bundle size.

**Done when:**

- Visits created in the list appear on the correct Pakistan date in the calendar.

## F9. Dashboard cards and sorted leaderboard

**Current state:**

- Admin overview has four headline cards; the leaderboard is not sorted by performance.

**Database:**

- crm_leaderboard gains p_sort and returns rows already ordered.

**Screens:**

- Admin cards: Today's new leads, Uncontacted leads (F3), Calls today, Visits today, Hot leads today (F2), Overdue follow-ups, Bookings this month (F18).

- Leads-by-source chart using the existing source distribution metric.

- Leaderboard period selector (today, week, month) sorted by won deals, then completed calls; agents see their own rank only and aggregate counts.

**Done when:**

- Leaderboard order matches the sort key in tests.

# 4. Phase 2: Targets and reports

## F10. Daily, weekly and monthly targets

**Current state:**

- One target per agent per month for calls, visits, deals and revenue.

**Database:**

- Migration 017_target_periods.sql: add targets.period (day, week, month) and targets.period_start; migrate existing rows to month. Unique (agent_id, period, period_start); weeks start Monday PKT.

- Add goals leads_contacted and followups_completed; extend crm_metrics with both counts.

**Screens:**

- Period selector on Targets, Copy last period's targets to all agents action, and an agent dashboard showing today and this month together.

**Jobs:**

- Optional 10:00 PKT target reminder notification with yesterday's result.

**Done when:**

- A weekly target shows progress for exactly Monday 00:00 to next Monday 00:00 PKT.

## F11. Attach leads to a target

In your process the admin gives each agent a target and the leads to work on in the same step.

**Database:**

- Add assignments.target_id (nullable) so leads given with a target can be tracked.

**API and server:**

- POST /targets accepts optional lead_ids\[\] or auto_pick: { count, source?, created_from? }; the server bulk-assigns using F5 and returns per-lead results.

**Screens:**

- Target form step 2, Attach leads: pick from unassigned leads or choose a count and filters. The target card shows leads given, contacted and converted.

**Done when:**

- Leads attached to a target appear in that agent's list with the target shown in assignment history.

## F12. Source, agent, funnel and lost-lead reports

**Current state:**

- Reports give aggregate metrics with date, agent and source filters and an aggregate CSV export.

**Database:**

- New scoped SQL functions (same actor rules as crm_metrics): report_sources, report_agents, report_funnel, report_lost, report_calls.

- Sources: leads, contacted, visits, won, conversion %, revenue per source (and per campaign once F33 stores it).

- Agents: assigned, contacted %, average first response, completed calls, total talk time, visits, won, conversion %, target achievement %.

- Funnel: counts and stage-to-stage conversion from lead_status_history. Lost: counts by reason, source and agent. Calls: temperature mix and missing outcomes per agent.

**API and server:**

- GET /reports/:type and GET /reports/:type/export (admin export only, formula-escaped, no phones).

**Screens:**

- Report tabs with tables and simple bar charts; agents see only their own agent row.

**Done when:**

- Totals in each report equal the overview metrics for the same range.

# 5. Phase 3: Properties, bookings and commission

## F13. Projects and units

**Current state:**

- Properties are a flat list; there is no project or unit grouping.

**Database:**

- Migration 018_projects_units_media.sql: table projects (id, name, developer, city, location, description, map_url, latitude, longitude, status upcoming\|active\|completed\|archived, timestamps).

- Add to properties: project_id (nullable for standalone listings), unit_no, block, floor, category (residential\|commercial); unique (project_id, unit_no).

- Add leads.project_id and leads.property_type preferences.

**API and server:**

- GET/POST/PATCH /projects (admin writes; all active users read).

**Screens:**

- Projects screen with a units table and available / reserved / sold counts. Lead form gains Interested project and Property type.

**Done when:**

- A unit can be filtered by project, block and availability.

## F14. Payment plans

**Database:**

- Table payment_plans (id, project_id or property_id, name, total_price, down_payment, installment_count, frequency monthly\|quarterly\|half_yearly, installment_amount, possession_amount, notes, active).

**API and server:**

- GET/POST/PATCH /payment-plans (admin writes) and GET /payment-plans/:id/schedule?start= returning a calculated preview.

**Screens:**

- Payment plan section on project and property detail with a schedule preview in PKR.

**Done when:**

- Down payment + installments + possession amount equals total price, enforced by a CHECK.

## F15. Property videos and map location

**Database:**

- Add properties.video_url and map_url (and latitude, longitude). Validate allowed hosts (for example YouTube and Google Maps). Linking unlisted videos avoids large video storage costs.

**Screens:**

- Video embed or link and an Open map button on property detail.

**Done when:**

- Unsafe or unknown URLs are rejected by the API.

## F16. Automatic property availability

When a deal closes, the unit must stop being offered by other agents.

**Database:**

- In the deal mutation path: booking created (F18) → property reserved; deal won → sold; deal lost → back to available if this deal had reserved it. Audit each change.

- Partial unique index on deals(property_id) where stage = 'won' so one unit cannot be sold twice.

**Screens:**

- Availability badge everywhere a property is chosen; selecting a sold unit for a visit or deal shows a blocking message.

**Done when:**

- A second won deal on the same unit returns 409.

## F17. Property matching for a lead

**Database:**

- Function match_properties(p_lead, p_actor) returning up to 20 available units ranked by budget fit (within 10% of the lead's range), project or location match and type match.

**API and server:**

- GET /leads/:id/matches (admin or assigned agent).

**Screens:**

- Matching properties panel on lead detail with Schedule visit and Share (F35) actions.

**Done when:**

- Sold and archived units never appear.

## F18. Bookings, installments and payments

Your deals currently record a closed value only. The planned CRM also tracks token money, the agreed price and the installment schedule.

**Database:**

- Migration 020_bookings_installments.sql: bookings (id, deal_id unique, lead_id, property_id, agent_id, agreed_price, token_amount, token_date, payment_plan_id, created_by, created_at).

- installments (id, booking_id, due_date, amount, status pending\|paid\|partly_paid\|overdue\|waived, paid_amount).

- payments (id, installment_id, amount, method cash\|bank\|cheque\|online, reference, received_at, recorded_by). Payments are append-only; corrections are new reversing rows.

**API and server:**

- POST /deals/:id/booking (admin) generates installments from the chosen plan. POST /installments/:id/payments (admin). Agents read bookings for their leads.

**Screens:**

- Booking tab on lead and deal detail; admin Collections screen (due this month, overdue).

**Jobs:**

- Daily 09:00 PKT job marks overdue installments and notifies admins.

**Done when:**

- Installment totals equal the agreed price minus token. This is sales tracking, not accounting software.

## F19. Agent commission

**Database:**

- Migration 021_commissions.sql: commission_rules (agent_id nullable for default, project_id nullable, percent, fixed_amount, basis agreed_price\|collected, effective_from).

- commissions (id, deal_id, agent_id, amount, status pending\|approved\|paid, approved_by, approved_at, paid_at). Calculated on booking (agreed basis) or on each payment (collected basis), for the deal's recorded agent.

**API and server:**

- GET /commissions (admin all; agent own, read-only), PATCH /commissions/:id approve or mark paid (admin).

**Screens:**

- Admin Commissions screen and an agent My commissions page.

**Done when:**

- Reassigning a lead never changes commission already earned on a booked deal.

# 6. Phase 4: Security hardening

Your CRM already has strong data rules. These features close the remaining gaps from the security plan: stronger login, session control, device control and alerts.

## F20. Two-factor login (OTP)

**Mandatory admin MFA was removed at the user's later request.** Admins sign in with their verified email/password. Native identity, inbox/invitation verification, active profiles, saved roles and Accounts PIN checks remain. Admin login ignores existing factor/reset state and has no migration-025 dependency.

Optional-agent TOTP remains available: REQUIRE_AGENT_MFA=true or a verified enrolled TOTP factor requires the native QR/code flow and preserved migration 025 after 024. Ordinary unenrolled agents need no MFA migration to log in. Agent verification retains isolated candidates, verified assurance, durable attempt limits, alerts and blocked recoverable resets. PIN-unlocked Accounts offers factor reset only for agent accounts.

See [current login policy and optional-agent recovery](ADMIN_TWO_FACTOR_LOGIN.md). Existing schema/factors were preserved; no hosted records were changed. Do not re-enable admin MFA from historical specifications without a new user request.

## F21. Account lockout after failed logins

**Current state:**

- Only per-IP rate limits apply; the browser signs in to Supabase directly.

**API and server:**

- New POST /auth/login on the server: checks crm_private.login_attempts, calls Supabase sign-in with the public key, and returns the session for the client to set with setSession.

- After LOGIN_MAX_ATTEMPTS (default 5) failures in 15 minutes for an email, lock it for LOGIN_LOCK_MINUTES (default 15) and notify admins. Return the same generic error for wrong password and locked account.

**Screens:**

- Login uses the new endpoint; password reset stays as it is.

**Done when:**

- The sixth wrong attempt within 15 minutes is refused even with the correct password until the lock ends.

## F22. Auto logout after inactivity

**API and server:**

- Also set session inactivity and time-box limits in Supabase Auth settings (available on paid plans) so a stolen token cannot live for days.

**Screens:**

- Track keyboard, mouse, touch and tab visibility in Layout. At VITE_IDLE_TIMEOUT_MINUTES − 5 (default 30) show a warning dialog with Stay signed in; at the limit sign out and clear the query cache.

- Warn before discarding an open form so drafts are not silently lost.

**Done when:**

- An idle browser is signed out after the limit; an active user is never interrupted.

## F23. Approved devices for agents

Websites cannot read hardware IDs, so this is the web replacement for the planned company-phone lock: agents can only use browsers the admin has approved.

**Database:**

- Migration 022_security_devices_logins.sql: trusted_devices (id, user_id, device_hash, label, user_agent, first_ip, approved, approved_by, approved_at, last_seen_at, revoked_at).

**API and server:**

- On first login the server issues a random 256-bit device ID that the browser keeps; only its hash is stored. Every request sends X-Device-Id.

- When REQUIRE_DEVICE_APPROVAL=true, agents on unapproved devices get 403 device_pending and admins are notified. GET/PATCH /devices (admin) approve or revoke.

**Screens:**

- Admin Devices screen; agent sees Waiting for admin approval.

**Done when:**

- Revoking a device blocks its next request.

- Clearing browser data requires re-approval. Pair this with MDM on company phones, since it is a deterrent, not a hardware lock.

## F24. Login history and security alerts

**Database:**

- login_events (id, user_id, email, success, device_id, ip, user_agent, created_at), written by F21's endpoint.

**Screens:**

- Admin Login history screen with user and date filters.

**Jobs:**

- Notify admins on: login from a new device, login outside BUSINESS_HOURS (for example 21:00–08:00 PKT), account lockout, and repeated MFA failures.

**Done when:**

- A night-time login creates one security alert.

## F25. Unusual activity detection

**Database:**

- lead_views (user_id, lead_id, viewed_at) written by GET /leads/:id and the timeline, kept 90 days. Do not put views in audit_log, which would grow too fast.

**Jobs:**

- Every 5 minutes: alert when an agent opens more than LEAD_VIEW_ALERT_PER_HOUR (default 60) leads, when an admin reveals more than 20 phones per hour, or on any admin export.

- Optional ALERT_AUTO_SUSPEND=true: suspend the agent above a hard limit until an admin reviews.

**Done when:**

- Alerts contain counts and user names only, never customer data.

## F26. Keep-recording flag and expiry label

**Current state:**

- Recordings expire after 7 days with no way to keep an important one.

**Database:**

- Migration 023_recording_keep.sql: add keep, kept_by, kept_reason, kept_at to crm_private.recordings. recording_batch skips kept recordings; recording_access allows them after 7 days.

**API and server:**

- POST /calls/:id/recording/keep and DELETE …/keep (admin, reason required, audited).

**Screens:**

- Call Review shows Expires in N days or Kept by admin, with a Keep button for disputes, complaints and booked deals.

**Done when:**

- A kept recording survives the cleanup job; un-keeping lets it expire on the next run if older than 7 days.

## F27. Encrypted customer phones (optional)

Supabase already encrypts stored data on disk, and your phones sit in a private schema. Column encryption adds protection if a database export ever leaks.

**Database:**

- Store the phone encrypted with a key held outside the table (for example Supabase Vault), plus phone_hash (HMAC-SHA256 of the normalized phone with a server secret) for the unique duplicate check.

- private_phone() decrypts for the service role only. Migrate existing rows in one transaction.

**Done when:**

- A plain database dump shows no readable phone numbers; duplicate detection still works.

# 7. Phase 5: Deployment and operations

Your CRM currently runs only on your Mac. It must be deployed before real webhooks (Phase 6) can reach it, because Meta, WhatsApp and calling providers need a public HTTPS address.

## F28. Production deployment, HTTPS and Cloudflare

**API and server:**

- Host on a VPS or Node host. Serve client/dist with SPA fallback and proxy /api to Express through Nginx or Caddy; keep Express bound to 127.0.0.1.

- Run the API and the jobs runner (npm run jobs) as two managed processes (systemd or pm2) that restart on failure.

- HTTPS everywhere; put Cloudflare in front to hide the server address and block attacks. Set app.set('trust proxy', 1) so rate limits use the real client IP.

- Set production FRONTEND_URL, Supabase Auth Site URL and redirect URLs, disable public signup in the hosted project, and use custom SMTP for password-reset emails.

- Upgrade Supabase to Pro so the project never pauses and gets daily backups.

- Replace the in-memory rate limiter with a shared store before running more than one API instance.

- Optional ADMIN_ALLOWED_IPS check in adminOnly() to restrict admin access to the office.

**Done when:**

- The app works on its domain over HTTPS; /health is reachable; restarting the server restarts both processes.

## F29. Backups, monitoring and job heartbeat

**API and server:**

- Internal readiness check that pings the database. Error tracking with personal data scrubbed. Uptime monitor on /health.

**Screens:**

- Admin System status card: last backup, last job tick, failed recording deletions.

**Jobs:**

- Nightly pg_dump, encrypted (for example with age or GPG), copied to separate storage with 30-day retention. Test a restore monthly.

- Jobs runner writes job_heartbeats each tick; alert admins if no tick for 5 minutes.

**Done when:**

- A restore of last night's backup into a test project succeeds.

## F30. Team management screen

**Current state:**

- New users and role changes require trusted Supabase administration; the Team screen only enables or disables access.

**API and server:**

- POST /users/invite (admin): auth.admin.inviteUserByEmail, creates the profile with the chosen role. PATCH /users/:id/role through a security-definer function that refuses to demote the last active admin.

- Also: set an agent's work phone (needed by F31), reset MFA (F20), view devices (F23). All audited.

**Screens:**

- Team screen gains Invite, Change role, Reset 2FA and Devices actions.

**Done when:**

- The last admin cannot be demoted or disabled.

# 8. Phase 6: Real integrations

Your project already has the right boundaries for these (cloudCalling.js, metaLeads.js, whatsapp.js, the signed webhook route and integration_events deduplication). Each integration replaces a disabled boundary with a real adapter.

## F31. Real cloud calling and recording ingestion

Because the CRM is web-only, cloud calling replaces the planned Android app: calls are placed by the CRM, recorded automatically, and the agent never sees the customer's number.

**Current state:**

- CALL_PROVIDER=mock; no real calls, no audio ingestion.

**API and server:**

- Choose a provider that supports Pakistani mobile numbers with good quality, a local caller ID, click-to-call bridge mode (rings the agent's company phone first, then the customer), recording, signed webhooks, and APIs to download and delete recordings. Run a paid test of about 20 calls before committing.

- Implement the adapter interface in cloudCalling.js: initiate, verifyEvent, mapEvent, fetchRecording, deleteRecording. Keep the CRM call ID as the idempotency key.

- Webhook route /api/webhooks/calls/:provider with the provider's signature check, reusing apply_call_event and integration_events.

- Add profiles.work_phone (admin-managed, F30) for bridge mode.

- Play a short recording-consent announcement at the start of each call.

**Jobs:**

- On a recording-ready event: download the audio into the private recordings bucket at recordings/YYYY/MM/\<call_id\>, insert crm_private.recordings, then delete the provider's copy. Existing 7-day cleanup and playback then work unchanged.

**Done when:**

- A real call creates a call row, status events, duration and a playable recording; the provider copy is deleted.

## F32. Social inbox for organic enquiries

Your leads are organic: people message your Facebook Page, Instagram account or WhatsApp. Lead forms only exist inside paid ads, so organic messages need their own capture path. Many messages arrive without a phone number, which your leads table requires, so they land in an inbox first.

**Database:**

- Future enquiries migration (choose a number after the latest applied migration; 024 is now Meta Instant Forms): enquiries (id, channel facebook\|instagram\|whatsapp\|website\|tiktok, external_user_id, display_name, phone (private, nullable), first_message, source_detail jsonb, status new\|converted\|spam\|closed, lead_id, assigned_to, created_at).

- Add leads.source_detail jsonb (page, form, campaign, ad, UTM values).

- An integration actor so create_lead can run for webhooks without a human admin, still audited as system.

**API and server:**

- Webhooks for Facebook Page messages, Instagram messages and WhatsApp messages, each with Meta's X-Hub-Signature-256 check and dedupe through integration_events.

- WhatsApp enquiries already include a phone, so they can become leads directly. Duplicate phones never fail: add a note "Re-enquiry via \<channel\>" to the existing lead and notify its agent.

- POST /enquiries/:id/convert (admin, or assigned agent) once a phone is collected; then rules assignment (F5).

**Screens:**

- Inbox screen with channel filter, Convert to lead, Mark spam.

**Done when:**

- A test message to the Page appears in the inbox within a minute and converts to an assigned lead.

## F33. Meta Lead Ads auto-import

Implemented through migration **024** for Facebook/Instagram **Instant Forms**: business authorization, encrypted Page tokens, selected Page/form subscriptions, raw-HMAC durable queue, Graph retrieval, mappings/review, canonical-phone duplicate handling, admin-only inbox, notifications, manual individual/bulk assignment and attribution reporting.

**New customers remain unassigned until explicit admin selection.** Stale/round-robin jobs cannot assign pending social leads. Repeat inquiries preserve existing ownership. This replaces the earlier roadmap suggestion of automatic rules assignment.

The implementation awaits the real Meta app configuration/review, public HTTPS deployment and actual test leads; it is not live-connected. Missed leads can be checked explicitly for a bounded recent period; no scheduled 15-minute historical polling was added. See [the implementation and acceptance guide](META_LEAD_ADS_INTEGRATION.md).

**Accepted when:** a real eligible Meta test lead appears unassigned only to admins, and becomes visible only to the chosen active agent after successful explicit assignment. Actual external acceptance remains pending.

## F34. Website and link-in-bio enquiry form

**API and server:**

- Public POST /api/public/enquiry: strict schema, honeypot field, Cloudflare Turnstile check, tight rate limit, consent checkbox, UTM capture. Creates an enquiry or lead through the integration actor.

**Screens:**

- A simple branded landing page (navy, white, gold) for your Instagram and Facebook bio link.

**Done when:**

- Bots without a valid Turnstile token are rejected; real submissions appear within seconds.

## F35. WhatsApp property sharing and templates

Agents should send property details from the CRM using the company WhatsApp number, so they never need the customer's number on their own phone.

**Database:**

- Future WhatsApp migration (number unallocated; choose after the latest actual migration): whatsapp_messages (id, lead_id, direction, template, body, status, wa_message_id, sent_by, created_at).

**API and server:**

- WhatsApp Cloud API adapter in whatsapp.js. Business-initiated messages outside the 24-hour window must use Meta-approved templates: greeting, property details, visit confirmation, follow-up.

- POST /leads/:id/whatsapp (admin or assigned agent, sensitive limit) resolves the phone on the server; status webhooks update delivery and read state.

**Screens:**

- Send on WhatsApp from lead detail and the matching-properties panel (F17), with a template picker and preview. Messages appear in the timeline.

**Done when:**

- An agent can send a property template without ever seeing the full number.

# 9. Phase 7: Optional additions

## F36. AI call conclusion (optional)

Your current CRM follows the non-AI design: the agent writes the conclusion. AI can later add an independent conclusion beside the agent's, which also reveals agents who over-rate weak calls. It needs real recordings from F31 first.

**Database:**

- Future AI migration (number unallocated): calls.ai_conclusion, ai_temperature, ai_processed_at, ai_error, ai_override_by.

**API and server:**

- Service files transcription.js and callConclusion.js, provider chosen by TRANSCRIBE_PROVIDER. Process only answered calls longer than AI_MIN_CALL_SECONDS (default 30). Do not store transcripts.

- Prompt: reply only with TAG (Hot / Warm / Cold / Dead) and a maximum two-line English conclusion covering what the client wants, how the agent handled them, and whether it is a good deal.

- Before choosing a provider, test 30 real Urdu-Punjabi calls and check its data retention terms. Estimated cost at about 27,300 minutes a month: roughly USD 20–170 depending on the model.

**Screens:**

- Call Review shows the agent and AI conclusions side by side with an admin override.

**Done when:**

- Failed AI processing never blocks the agent's outcome form.

## F37. Team Lead role (optional)

Build only if you add team leads who manage a group of agents.

**Database:**

- teams table, profiles.team_id, role team_lead. Extend ownership checks (ownedLead, crm_mutate, crm_metrics) so a team lead sees their team's leads.

**Done when:**

- A team lead can never see another team's leads or any full phone numbers.

## Also outstanding from your own known-limits list

- Run the full verify-live.js checklist against the hosted project.

- Test real photo upload and delete, and add a reconciliation job for orphaned storage objects.

- Test assignment and duplicate creation through separate PostgreSQL connections.

- Lazy-load routes to reduce the 985 KB main bundle; replace 100-item selectors with searchable lookups.

- Non-code: employee confidentiality agreements (have a lawyer word them with reference to PECA 2016), MDM on company phones, and only one or two full admin accounts.

# 10. Build order and time estimate

Estimates assume one developer working with an AI coding assistant on your existing codebase. Meta and WhatsApp review times are outside your control, so start those applications during Phase 4.

| **Phase**                            | **Features** | **Estimate**                |
| ------------------------------------ | ------------ | --------------------------- |
| 1\. Sales workflow                   | F1–F9        | 2–3 weeks                   |
| 2\. Targets and reports              | F10–F12      | 1.5–2 weeks                 |
| 3\. Properties, bookings, commission | F13–F19      | 2–3 weeks                   |
| 4\. Security hardening               | F20–F27      | 2 weeks                     |
| 5\. Deployment and operations        | F28–F30      | 1 week                      |
| 6\. Real integrations                | F31–F35      | 3–4 weeks, plus Meta review |
| 7\. Optional additions               | F36–F37      | 1–2 weeks                   |
| Total                                |              | About 12–17 weeks           |

A practical shortcut: after Phase 1 and the deployment part of Phase 5, the CRM is ready for daily team use with manual call logging. Everything after that can be added while the team is working.

# Appendix A. New migrations

Rows 012–023 below are the original planning proposals from 8 October and are **not** the current applied migration inventory. The actual files are listed in Complete Project Documentation. Meta 024, preserved MFA 025 and monitoring 026 are implemented; allocate future numbers only when work starts.

| **File**                                 | **Feature**                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| 012_pipeline_and_lost_reasons.sql        | F1                                                                          |
| 013_call_conclusion_and_temperature.sql  | F2                                                                          |
| 014_response_tracking.sql                | F3, F4                                                                      |
| 015_assignment_rules.sql                 | F5, F6, F11                                                                 |
| 016_notifications.sql                    | F7                                                                          |
| 017_target_periods.sql                   | F10                                                                         |
| 018_projects_units_media.sql             | F13, F15, F16, F17                                                          |
| 019_payment_plans.sql                    | F14                                                                         |
| 020_bookings_installments.sql            | F18                                                                         |
| 021_commissions.sql                      | F19                                                                         |
| 022_security_devices_logins.sql          | F21, F23, F24, F25, F27                                                     |
| 023_recording_keep.sql                   | F26                                                                         |
| 024_meta_lead_ads.sql                    | Implemented F33 Instant Forms; real Meta acceptance pending                 |
| 025_admin_totp_mfa.sql                   | Historical P5 schema; now optional-agent MFA only                           |
| 026_system_monitoring.sql                | P6 monitoring/readiness, encrypted backup metadata; real deployment pending |
| Future enquiries migration (unallocated) | F29 heartbeats, F31 work phone, F32, F34                                    |
| Future WhatsApp migration (unallocated)  | F35                                                                         |
| Future AI migration (unallocated)        | F36 (optional)                                                              |

# Appendix B. New environment variables

All are server-only in the root .env, except those starting with VITE\_. Never put a secret in a VITE\_ variable.

| **Variable**                                                            | **Default / purpose**                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| NEW_LEAD_RESPONSE_HOURS                                                 | 2; business hours before an uncalled lead moves (F4) |
| REASSIGN_MODE                                                           | queue or round_robin (F4)                            |
| BUSINESS_HOURS_START / \_END                                            | 10:00 / 20:00 Asia/Karachi (F4, F24)                 |
| MAX_AUTO_REASSIGN                                                       | 2 (F4)                                               |
| ASSIGNMENT_DEFAULT                                                      | round_robin or unassigned when no rule matches (F5)  |
| REQUIRE_AGENT_MFA                                                       | true or false (F20)                                  |
| LOGIN_MAX_ATTEMPTS / LOGIN_LOCK_MINUTES                                 | 5 / 15 (F21)                                         |
| VITE_IDLE_TIMEOUT_MINUTES                                               | 30 (F22)                                             |
| REQUIRE_DEVICE_APPROVAL                                                 | true for agents (F23)                                |
| LEAD_VIEW_ALERT_PER_HOUR / ALERT_AUTO_SUSPEND                           | 60 / false (F25)                                     |
| ADMIN_ALLOWED_IPS                                                       | Optional comma-separated list (F28)                  |
| CALL_PROVIDER plus provider keys                                        | Real provider name and credentials (F31)             |
| META_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN / META_TOKEN_ENCRYPTION_KEY | Meta webhooks and Graph API (F32, F33)               |
| WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID                               | WhatsApp Cloud API (F32, F35)                        |
| TURNSTILE_SECRET_KEY / VITE_TURNSTILE_SITE_KEY                          | Website form bot protection (F34)                    |
| TRANSCRIBE_PROVIDER / AI_API_KEY / AI_MIN_CALL_SECONDS                  | Optional AI (F36)                                    |

# Appendix C. New API routes

| **Route**                                                                  | **Access**                | **Feature**   |
| -------------------------------------------------------------------------- | ------------------------- | ------------- |
| GET /leads?view=uncontacted                                                | Admin / own agent         | F3            |
| GET/POST/PATCH /assignment-rules                                           | Admin                     | F5            |
| POST /leads/assign-bulk                                                    | Admin                     | F5            |
| GET /notifications; PATCH /notifications/:id; POST /notifications/read-all | Owner                     | F7            |
| GET /visits?from=&to=                                                      | Admin / own agent         | F8            |
| GET /reports/:type; GET /reports/:type/export                              | Active user; export admin | F12           |
| GET/POST/PATCH /projects                                                   | Read all; write admin     | F13           |
| GET/POST/PATCH /payment-plans; GET /payment-plans/:id/schedule             | Read all; write admin     | F14           |
| GET /leads/:id/matches                                                     | Admin / assigned agent    | F17           |
| POST /deals/:id/booking; POST /installments/:id/payments                   | Admin                     | F18           |
| GET /commissions; PATCH /commissions/:id                                   | Admin; agent reads own    | F19           |
| POST /auth/login                                                           | Public, rate limited      | F21           |
| GET/PATCH /devices; GET /login-events                                      | Admin                     | F23, F24      |
| POST/DELETE /calls/:id/recording/keep                                      | Admin                     | F26           |
| POST /users/invite; PATCH /users/:id/role                                  | Admin                     | F30           |
| POST /webhooks/calls/:provider                                             | Signed provider           | F31           |
| GET/POST /webhooks/meta; POST /webhooks/whatsapp                           | Signed Meta               | F32, F33, F35 |
| GET /enquiries; POST /enquiries/:id/convert                                | Admin / assigned agent    | F32           |
| POST /public/enquiry                                                       | Public, Turnstile         | F34           |
| POST /leads/:id/whatsapp                                                   | Admin / assigned agent    | F35           |

# Appendix D. Prompt template for Codex

Give your AI assistant one feature at a time. Attach this document and paste the prompt below, replacing F1 with the feature you are building:

> Read docs/REMAINING_FEATURES.md and implement feature F1 only.
>
> Follow the existing conventions in hd-marketing-crm exactly:
>
> \- New SQL in a new numbered migration in supabase/migrations/ (do not edit old migrations).
>
> \- Business writes through crm_mutate or a security-definer function that checks the active actor, lead ownership, takes row locks and writes audit_log in the same transaction.
>
> \- RLS on, no browser grants on new tables; browser only calls /api.
>
> \- Strict Zod schemas in server/src/utils/validators.js; adminOnly() for admin routes; agents limited to their currently assigned leads; never return full customer phones to agents.
>
> \- UTC storage, Asia/Karachi display and input, PKR formatting.
>
> \- Add server and client tests for every 'Done when' check and keep npm test passing.
>
> Before writing code, list the files you will change and the migration you will add. Do not change unrelated files.

After each feature: run npm test, try it as admin and as agent, apply the new migration to the hosted project, and only then move to the next feature.
