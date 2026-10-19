#!/usr/bin/env python3
"""Build the complete CRM Word manual using only Python's standard library.

Edit docs/CRM_COMPLETE_DOCUMENTATION.md for workflow changes, then run this
script. The named-function appendix is regenerated from source, not secrets,
customer data, installed dependencies or test fixtures.
"""

from datetime import datetime, timezone
from pathlib import Path
import json
import re
import zipfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/CRM_COMPLETE_DOCUMENTATION.md"
OUTPUT = ROOT / "docs/HD_Marketing_CRM_Complete_Documentation.docx"
START = "<!-- function-catalog:start -->"
END = "<!-- function-catalog:end -->"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("w", W)
ET.register_namespace("r", R)
NAVY, GOLD, GREY = "172C43", "B78B40", "61738B"
PAGE_WIDTH, PAGE_HEIGHT, MARGIN = 11906, 16838, 1080
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN


MODULE_PURPOSES = {
    "accountCreation": "Resume, resend or cancel email-code requests created before update 036; verify OTP and recover deterministic Auth provisioning without recipient sessions.",
    "accountProvisioning": "Gmail-only, six-digit-UID direct account creation: strict validation, SQL reservation, server-only Auth creation, timeout recovery and audited activation.",
    "CreateAccountForm": "Create Account form with Gmail validation, Auto/Manual UID choice, inline UID checks, advisory availability lookup and field-mapped server errors.",
    "AccountUid": "Read-only Supabase UID display with a copy-to-clipboard action and toast feedback.",
    "IdleGuard": "Inactivity warning dialog with countdown, Stay signed in and Sign out now; signs out idle sessions.",
    "useIdleLogout": "Wall-clock inactivity tracking shared across tabs; warns before the limit and signs out at it.",
    "LoginHistory": "Admin login history with account/result/date filters, failed-attempt and locked-account totals.",
    "auth.routes": "Server sign-in with per-account lockout, generic refusals and login history recording.",
    "accountFields": "Client mirrors of the Gmail and UID rules plus a clipboard copy helper with a non-secure-context fallback.",
    "accountCreationMail": "Deliver independent six-digit account challenges over bounded TLS SMTP or Resend with safe errors and no content logs.",
    "PendingAccountVerification": "Masked-recipient OTP modal, expiry/cooldown, original-password resume, cancellation and pending guards.",
    "agentEmailCodes": "Request native Agent/Admin email codes using an isolated nonpersistent Auth client; preserve service/admin sessions.",
    "formatLeadNo": "Format one permanent lead identity consistently in both portals.",
    "useLeadSelection": "Bound cross-page admin selection to 500 IDs and clear it on filter changes.",
    "DeleteLeadsDialog": "Preview affected work, require a reason and typed confirmation, and guard lead/file deletion.",
    "DeletedLeads": "Administrator-only paginated restore bin and file-with-leads restoration.",
    "leadManagement": "Call protected lead-management SQL and translate safe migration, conflict and permission errors.",
    "purgeDeletedLeads": "Run the SQL-persisted daily purge and retry orphan recording cleanup before acknowledgement.",
    "authRequests": "Deduplicate overlapping native Auth verification only; discard completed results.",
    "dashboard": "Single authorized dashboard snapshot with legacy reader compatibility.",
    "propertyCovers": "Batch property-card cover metadata and private Storage URL signing.",
    "authClient": "Native Supabase browser Auth with compatible sessions and isolated candidate login.",
    "useDebouncedValue": "Delay search requests until typing pauses while preserving immediate input updates.",
    "invalidateWorkspace": "Refresh affected workspace query families after mutations.",
    "fonts": "Load optional display fonts at idle with system-font fallback.",
    "routeLoaders": "Share lazy page loaders and preload code on sidebar intent without customer data.",
    "benchmark-performance": "Measure synthetic PostgreSQL queries before/after migration 027 without hosted access.",
    "SystemStatus": "Administrator-only job/backup monitoring with stale/failure feedback.",
    "systemStatus": "Safe operational reads and durable job outcome recording.",
    "health.routes": "Admin-only status and database/migration/job readiness.",
    "runtime": "Production secrets/origin/manual-calling validation and explicit proxy networks.",
    "maintenance": "Non-overlapping independent maintenance jobs and safe durable heartbeats.",
    "mfa": "Verify signed MFA assurance, private reset state and isolated native Auth request identity.",
    "mfa.routes": "Optional-agent native authenticator verification, admin refusal and safe outcome audits.",
    "mfaLogin": "Keep candidate MFA enrollment/verification isolated until accepted AAL2 workspace installation.",
    "MfaChallenge": "Private QR/key setup, factor selection, six-digit verification and cancellation with pending guards.",
    "App": "Role-protected lazy routing, loading feedback and recoverable chunk errors.",
    "main": "Mount React, query caching, routing, authentication and notifications.",
    "DealTagPicker": "Select supported outcome/deal tags without duplicated values.",
    "OutcomeForm": "Validate manual call logs and later outcomes, notes and tags; guard pending saves; optional dialler with call timer.",
    "CallDialog": "Call a lead through the device phone app (tel: link) and log the result with the manual-call endpoint.",
    "EmailSuggestionsInput": "Role-separated email-only suggestions with keyboard selection.",
    "RecordsPage": "Shared activity lists and forms for follow-ups, visits and deals.",
    "UI": "Shared buttons, modals, tables, pagination, fields and notifications.",
    "Button": "Compatibility export of the shared button component.",
    "Loader": "Compatibility export of the shared loading component.",
    "Modal": "Compatibility export of the shared accessible modal component.",
    "Table": "Compatibility export of the shared table component.",
    "Layout": "Grouped role navigation with collapsible sidebar, breadcrumbs, notifications, profile menu with UID and sign-out.",
    "navigation": "Role-based sidebar sections (paths, labels, icons) and breadcrumb names for the current route.",
    "Widgets": "Dashboard KPI tiles, ring gauge, navy month highlight and recent-activity list from existing APIs.",
    "ImportedFiles": "Import-file browsing, admin assignment and agent file selection.",
    "LeadForm": "Administrator customer creation and atomic metadata, phone and owner editing.",
    "LeadPhone": "Automatically render authorized full customer contacts with a Call button that opens the call dialog.",
    "PhoneReveal": "Compatibility export of automatic full-contact rendering without Show/Hide controls.",
    "SecurityAlerts": "Administrator-only alert filters, pagination, review controls and summary refresh.",
    "securityAlerts": "Shared administrator summary polling and safe alert labels.",
    "LeadStatusControl": "Lead stage/loss forms and status-change submission.",
    "PhotoGallery": "Shared signed property images; admin upload/delete controls.",
    "PropertyCard": "Property cover, photo count, summary and open-details interaction.",
    "PropertyDetails": "Full property summary and shared photo gallery.",
    "PropertyForm": "Validated property details, save-before-upload and retry behavior.",
    "PropertyPhotoPicker": "One multi-image picker, validation and released preview URLs.",
    "TargetProgress": "Goal/actual comparison and bounded progress display.",
    "AuthContext": "Session restoration, active-profile refresh and recovery state.",
    "api": "Authorized JSON/multipart requests, downloads and PKR/date/report helpers.",
    "calls": "Shared Manual/Mock/Provider labels and unanswered outcome definitions.",
    "authErrors": "Readable authentication failures without raw secret output.",
    "documentCategories": "Shared category values and document labels.",
    "loginEmails": "Validate, read and remember up to five emails per portal/device.",
    "pipeline": "Lead stage and loss-reason definitions and labels.",
    "portalLogin": "Isolated candidate sign-in; install only after role acceptance and required authenticator verification.",
    "supabase": "Public Auth client plus isolated non-persistent login clients.",
    "usePropertyPhotos": "Shared signed-photo query/cache with optional refresh polling.",
    "Login": "Portal toggle, email suggestions, password visibility and recovery.",
    "AcceptInvitation": "Isolated recipient callback, URL cleanup, password setup and explicit sign-out after acceptance.",
    "accountInvitation": "Validate invitation callbacks and use isolated verified sessions for setup API calls.",
    "accountInvitations": "Email/domain validation, configured invitation lifetime/redirects and native mail requests.",
    "onboarding.routes": "Verified recipient/ticket-only context and password acceptance; no public registration.",
    "Accounts": "PIN unlock, account list/details with UIDs, UID search, creation success popup and protected management.",
    "AgentHandover": "Preview counts and confirm atomic disable/handover to balanced agents, one recipient or the admin pool.",
    "KycClientPicker": "Administrator client search and required KYC selection using masked phone metadata.",
    "LeadKycDocuments": "List current-owner client KYC entries and use authorized private attachment downloads.",
    "AdminSettings": "Password-verified personal Accounts PIN set/reset.",
    "AuditLog": "Read-only administrator audit browsing.",
    "CallReview": "Administrator call filtering, outcomes and recording access.",
    "Dashboard": "Role-aware overview: greeting, KPI sections, pipeline, review tables, highlights and recent activity.",
    "Leads": "Admin/agent lead lists, imports, column matching and results.",
    "Properties": "Shared inventory/details with administrator editing/deletion.",
    "Reports": "Administrator aggregate report filters and CSV export.",
    "Targets": "Role-aware monthly goals and administrator target editing.",
    "Team": "Read-only team directory with UIDs; edits use PIN-protected Accounts.",
    "FollowUps": "Agent follow-up list/form using the shared activity implementation.",
    "LeadDetail": "Authorized customer timeline, notes, calls and activity actions.",
    "MyLeads": "Agent route alias for the shared ownership-scoped lead page.",
    "MyTargets": "Agent route alias for the shared monthly target page.",
    "SiteVisits": "Agent site visits using the shared activity implementation.",
    "Documentation": "Shared category/search library and admin entry/file editing.",
    "app": "Compose Express middleware, API boundaries, health and safe errors.",
    "index": "Start the loopback CRM API server.",
    "supabaseAdmin": "Create the server-only service-role Supabase client.",
    "cleanupKnowledgeFiles": "Retry durable private document attachment cleanup.",
    "cleanupPropertyPhotos": "Retry durable private property image cleanup.",
    "deleteOldRecordings": "Delete expired Storage/provider recordings and record retries.",
    "followUpReminders": "Invoke locked creation of deduplicated due reminders.",
    "missingOutcomeCheck": "Flag completed calls missing an outcome after the grace period.",
    "leadResponseCheck": "Flag missed first calls for admin review and send sales reminders; never reassigns.",
    "reportInactiveLeadOwners": "Raise safe administrator alerts for inactive profiles retaining leads; do not auto-reassign.",
    "runner": "Schedule the eight background jobs without local overlapping ticks.",
    "auditLogger": "Persist request-linked, bounded audit records.",
    "auth": "Verify native identity, confirmation, current active role (with UID when update 036 is installed), signed assurance and reset state before CRM access.",
    "role": "Reject requests lacking the required administrator role.",
    "rateLimit": "General and sensitive-route IP request limits.",
    "accounts.routes": "Personal PIN/grant endpoints and protected account operations.",
    "security.routes": "Protected phone-usage status and administrator-only alert listing/review.",
    "phoneAccess": "Load audited authorized page contacts; translate private RPC failures and preserve historical usage settings.",
    "phoneProtection": "Mask agent free text while preserving SQL-authorized structured contact fields.",
    "crm.routes": "Core CRM handlers with role/ownership checks and SQL mutations.",
    "documents.routes": "Current-owner KYC/shared category readers, audited private downloads and admin mutations.",
    "webhooks.routes": "Verify development-event HMAC and call the deduplicated event transaction.",
    "emailConfirmation": "Validate trusted confirmation redirects and request Supabase email delivery with safe error handling.",
    "accountsSecurity": "PIN hashing/checking, grant digests and isolated password verification.",
    "alerts": "Reminder query support and alert-related service boundaries.",
    "cloudCalling": "Server-authorized call capabilities, development mock adapter and recording cleanup boundary.",
    "documentFiles": "Bounded PDF/DOC/DOCX signature and archive validation.",
    "importFiles": "Persist parsed rows and import-file history/results through SQL.",
    "leadAssignment": "Invoke protected individual assignment/round-robin transaction.",
    "leadImport": "CSV/XLSX/XLS parsing, normalized headers/mapping and agent resolution.",
    "metaLeads": "Compatibility export of the durable Facebook/Instagram Instant Form worker.",
    "MetaIntegration": "Admin business connection, Page/form activation, mapping and recovery controls.",
    "IncomingSocial": "Admin-only enquiry inbox, review details, explicit transactional assignment and attribution report.",
    "meta": "Administrator-scoped summary polling and safe platform/processing labels.",
    "meta.routes": "Admin-only OAuth setup, Page/form control, inbox, review, assignment and reporting routes.",
    "metaWebhook.routes": "Exact raw-body HMAC verification, challenge and durable submission enqueue.",
    "processMetaLeads": "Fenced queue claims, bounded Graph retrieval, normalization, protected finalization and retry cleanup.",
    "graph": "Fixed-host authenticated Meta requests, timeout/size bounds and safe cursor pagination.",
    "normalize": "Allowlisted mappings, canonical phone identity, review reasons and truthful source attribution.",
    "config": "Validate server-only Meta settings, fixed HTTPS callback, Graph version and independent encryption key.",
    "crypto": "Context-bound AES-GCM token storage and constant-time webhook signature checks.",
    "rpc": "Translate protected Meta SQL failures without sensitive provider/database output.",
    "whatsapp": "Disabled WhatsApp integration boundary; no live messaging.",
    "duplicateCheck": "Normalized customer-phone duplicate lookup support.",
    "phoneMask": "Normalize contact identity, mask safe records and escape CSV cells.",
    "validators": "Strict entity, role-specific update, list and loss-reason schemas.",
    "build-sql": "Generate the fresh-install SQL bundle from ordered migrations and seed.",
    "configuration": "Validate connection/dev settings and safely construct environment files.",
    "configure": "Interactive private connection and optional development account setup.",
    "send-mock-event": "Send the explicitly configured signed development event fixture.",
    "setup-dev": "Provision explicit new development Auth accounts outside production.",
    "verify-live": "Opt-in read-only acceptance checks for a configured real development service.",
    "sales.routes": "Notifications, first-call queue, call activity, admin lead review decisions and working hours (update 038).",
    "CallActivity": "Admin team calling table for today and the agent's own first-call queue without contact numbers.",
    "LeadReview": "Admin keep-or-reassign decisions for missed first calls and quiet leads.",
    "WorkHours": "Admin working days, hours, last-call window and quiet-lead days.",
    "firstCall": "Format first-call deadlines, lateness and lead badges in Pakistan time.",
    "calendar": "Pakistan-date helpers for weeks from Monday, month grids and target period ranges.",
    "VisitCalendar": "Week and month site-visit calendar with agent filter and status colours.",
    "VisitConflicts": "Non-blocking warning when the agent already has a visit within an hour.",
    "TargetCard": "One target with live progress for its own day, week or month.",
    "attendance.routes": "Self-service attendance and admin attendance routes, reports and CSV/XLSX exports (update 040).",
    "attendanceReconciliation": "Mark earlier open attendance sessions incomplete and send the admins' daily summary; never moves leads.",
    "attendance": "Attendance state and punctuality labels, time and duration formatting in Pakistan time.",
    "MyAttendance": "Employee check-in/out, today's status, monthly summary, history and leave/correction requests.",
    "AttendanceManagement": "Admin attendance tabs: overview, register, reports, history, requests, holidays and settings.",
    "Badges": "Attendance state, punctuality and request status badges.",
    "LeaveRequestForm": "Full-day leave request for the signed-in employee.",
    "CorrectionRequestForm": "Attendance correction request with Pakistan-time check-in/out.",
    "ReviewDialog": "Approve or reject a leave or correction request with a note.",
    "ExportButtons": "CSV or Excel export of the attendance report on screen.",
    "attendanceDashboard": "Command Center queries (shared with the report tabs) and display-only grouping of attendance data.",
    "AttendanceCommandHeader": "Command Center title, today's date, rules from settings, refresh and export.",
    "AttendanceNavigation": "Keyboard-navigable attendance sections with waiting-request counts.",
    "AttendanceOverview": "Command Center overview layout of the attendance panels.",
    "AttendanceKpiStrip": "Five headline attendance figures for today.",
    "AttendanceDistributionChart": "Donut of today's mutually exclusive attendance states.",
    "AttendanceAttentionPanel": "Today's attendance issues and waiting requests with links to act on them.",
    "LiveAttendanceRegister": "Everyone expected on a date, with filters and quick details.",
    "WeeklyAttendanceChart": "Stacked daily attendance bars for a week with separate late counts.",
    "MonthlyAttendanceInsights": "Team monthly attendance totals and a daily calendar heatmap.",
    "EmployeeAttendanceDrawer": "Read-only side panel with one employee's recent attendance.",
    "Skeleton": "Loading placeholders and section error with retry.",
    "AdminDaily": "Daily register of every expected employee with filters and export.",
    "AdminPeriod": "Weekly and monthly attendance totals, day codes and charts.",
    "AdminEmployee": "One employee's attendance history, totals, leave and corrections.",
    "AdminRequests": "Leave and correction review lists; own requests need another administrator.",
    "AdminHolidays": "Add and remove company holidays.",
    "AdminAttendanceSettings": "Current attendance rules, scheduled changes and rule history.",
    "crm-fixture": "Shared in-memory CRM database and minimal Supabase client for server tests.",
}

SQL_PURPOSES = {
    "account_detail_034": "Preserve prior account detail fields behind safe independent-creation pending metadata.",
    "accounts_page_034": "Preserve prior account pagination behind safe independent-creation pending metadata.",
    "account_creation_summary": "Return only masked pending-request metadata and safe completion status.",
    "account_creation_context": "Authorize the initiating active admin and current session-bound PIN before private request access.",
    "account_creation_list": "List the initiating administrator's latest unfinished requests without hashes or full recipients.",
    "prepare_account_creation": "Reserve an independent OTP challenge and enforce durable duplicate and send limits without an Auth user.",
    "resend_account_creation": "Rotate OTP/version and expiry under cooldown, hourly limits and concurrency guards.",
    "finish_account_creation_email": "Record delivery request outcome without claiming verified ownership.",
    "begin_account_creation": "Atomically check original password binding and OTP, record attempts and lease one finalization.",
    "release_account_creation": "Release only the matching finalization lease after an operation finishes.",
    "complete_account_creation": "Validate the reserved native identity, assign role and complete activation in one audited transaction.",
    "cancel_account_creation": "Invalidate a request before external provisioning can begin.",
    "guard_pending_account_creation": "Deny role escalation/activation for a partial independent challenge user.",
    "update_account_034": "Preserve prior account editing behind the new partial-request guard.",
    "account_action_034": "Preserve prior account audits behind the new partial-request guard.",
    "issue_agent_email_code_034": "Retain historical native code issuance while excluding independent partial users.",
    "agent_email_code_context_034": "Retain historical native verification while excluding independent partial users.",
    "account_email_code_ready": "Require update 034 and the active-admin Accounts grant before provisioning either account role.",
    "agent_email_code_ready": "Require the current active-admin Accounts grant before native agent creation.",
    "issue_agent_email_code": "Stage a role-bound ten-minute account code request, preserve intended access and rotate private request state.",
    "finish_agent_email_code": "Record mail request success/failure without activating the account.",
    "agent_email_code_context": "Recheck PIN, target role/email/deletion, request method, state and expiry under ownership locks.",
    "begin_agent_email_code": "Claim a bounded verification attempt and reject parallel or exhausted checks.",
    "mark_agent_email_code": "Persist native inbox proof for the matching current claim without granting access.",
    "release_agent_email_code": "Release only the matching temporary verification claim.",
    "complete_agent_email_code": "Activate intended access only after verified native email and password setup, with atomic audit.",
    "invitation_context_032": "Retain recipient link context behind the guard excluding agent-code enrollments.",
    "issue_account_invitation_032": "Retain protected administrator invitation issuance behind delivery-state reset.",
    "accounts_page_032": "PIN/deletion-aware account pagination with UID column and UID search; later wrappers add safe delivery-method fields.",
    "account_detail_032": "Retain current PIN/MFA/deletion-aware detail reader behind safe email-code metadata.",
    "create_lead_031": "Retained lead creation implementation behind the recoverable-phone guard.",
    "crm_mutate_031": "Retained entity mutation and auditing behind deleted-lead authorization checks.",
    "crm_metrics_028": "Retained scoped report aggregates, upgraded to exclude deleted leads.",
    "guard_lead_number": "Prevent editing a permanent generated lead number.",
    "assign_leads_bulk": "Authorize and lock up to 500 leads, rotate active recipients evenly or assign/unassign through ownership helpers and report outcomes.",
    "normalize_lead_phone": "Normalize Pakistani/international customer phone identities using the shared rules.",
    "update_lead_phone": "Require admin, prevent duplicate identity, update vault/mask together and audit without phone values.",
    "edit_lead": "Atomically edit administrator fields, phone and owner with complete rollback on failure.",
    "format_lead_no": "Format stable HD identifiers for safe SQL conflict and restore messages.",
    "delete_leads": "Soft-delete eligible leads, cancel pending work, preserve won deals and emit a counts-only audit/security alert.",
    "restore_leads": "Restore at most 500 eligible leads within 30 days, preserving their numbers and history without assigning them.",
    "deleted_leads_page": "Admin-only filtered pagination of deleted lead identities, reasons and restore deadlines.",
    "lead_delete_preview": "Admin-only counts of customer leads and pending work before confirmation.",
    "delete_lead_import": "Remove only a file or soft-delete its eligible leads in bounded batches with shared recovery metadata.",
    "deleted_imports_page": "List recoverable file-and-lead deletions for administrators.",
    "restore_lead_import": "Restore a deleted file and its remaining eligible batch leads transactionally.",
    "purge_deleted_leads": "Serialize a daily purge of at most 200 expired leads and queue private storage cleanup while retaining audits.",
    "lead_recording_cleanup_batch": "Service-only bounded reader for orphan recording objects pending deletion.",
    "lead_recording_cleanup_done": "Acknowledge an orphan recording only after storage/provider cleanup succeeds.",
    "guard_account_deletion": "Prevent deleted/pending accounts being reenabled, renamed or restored.",
    "guard_deleted_invitation": "Keep invitations cancelled once account deletion starts.",
    "prepare_account_deletion": "Require admin/PIN/email confirmation, block access and hand pending work over atomically.",
    "finish_account_deletion": "Fence completion, verify native Auth deletion and safely finalize or retain retryable state.",
    "account_lifecycle_023": "Preserved invitation lifecycle reader behind deletion-state handling.",
    "account_detail_023": "Preserved PIN-protected account details behind deletion-state handling.",
    "dashboard_snapshot": "Return authorized metrics, grouped leaders, current-owner activities and own targets together.",
    "property_cover_photos": "Read the first photo and total count for a bounded set of properties after active-profile verification.",
    "record_job_heartbeat": "Persist safe job completion/failure times with service-only permissions.",
    "record_backup": "Record ciphertext backup metadata only after validated success or safe failure.",
    "system_status": "Authorize active Admin and report expected schema/fresh job/backup state.",
    "mfa_session_state": "Return active-user private reset state and old-session cutoff to the trusted server.",
    "mfa_begin_attempt": "Atomically reserve bounded per-user native verification work before provider calls.",
    "mfa_finish_attempt": "Fence attempt completion, audit safe results and create deduplicated repeated-failure alerts.",
    "mfa_reset_begin": "Require another active admin/PIN, stage blocked recovery, revoke target grants and audit intent.",
    "mfa_reset_finish": "Fence native-factor recovery completion/failure while retaining old-session invalidation.",
    'meta_oauth_start': 'Authorize administrator and store an expiring hashed browser-bound OAuth state.',
    'meta_oauth_consume': 'Atomically consume one valid cookie-bound state and recheck active administrator access.',
    'meta_save_connection': 'Replace encrypted authorization, save accessible Pages and pause old Page selections.',
    'meta_settings': 'Return safe administrator-only connection, Page and form configuration without credentials.',
    'meta_page_secret': 'Return the selected encrypted Page credential only to the trusted admin server path.',
    'meta_save_forms': 'Persist discovered provider form identities and bounded question metadata.',
    'meta_configure': 'Authorize Page/form synchronization and validate allowlisted question mappings.',
    'meta_disconnect': 'Pause all connected Pages, remove private credentials and retain customer history.',
    'meta_enqueue': 'Transactionally persist authorized provider submissions and replay identity before acknowledgement.',
    'meta_claim': 'Claim due durable work with bounded attempts and expiring fenced leases.',
    'meta_finish': 'Recheck lease/selection, retain private answers, create unassigned customer or match existing identity/review.',
    'meta_fail': 'Fence failed processing, schedule bounded retry and mark authorization problems safely.',
    'meta_retry': 'Authorize retryable lifecycle reset without duplicating provider identity.',
    'meta_resolve': 'Authorize review correction and reuse protected finalization without fake contacts.',
    'meta_first_assignment_guard': 'Refuse direct or automatic first ownership changes for pending social customers.',
    'meta_assign': 'Lock and assign distinct pending customers to one active agent atomically; reject conflicts.',
    'meta_inbox': 'Authorize/filter/count/page admin enquiries and audit visible structured customer contacts.',
    'meta_submission': 'Audit administrator detail access and return unexpired answers plus existing assignment history.',
    'meta_summary': 'Count real submissions and pending customers; return per-admin undismissed notices.',
    'meta_read_notice': 'Persist one administrator notice dismissal per saved provider submission.',
    'meta_report': 'Distinguish submissions from first-inquiry unique-customer cohorts and existing activity/value metrics.',
    'meta_cleanup': 'Remove expired private answers/states and mark exhausted crashed worker attempts failed.',
    'assign_lead_023': 'Retain prior assignment and pending-work handover implementation behind the social first-assignment guard.',

    "account_lifecycle": "Derive invitation/verification/active/suspended states using server time and native confirmation.",
    "guard_account_activation": "Refuse activation of unconfirmed accounts or unaccepted tracked invitations.",
    "check_account_email": "Admin/PIN-gated duplicate email check and safe creation intent audit.",
    "issue_account_invitation": "Rotate recipient-bound ticket hash, expiry and desired access; keep profile inactive.",
    "finish_account_invitation": "Audit mail-request result for the current ticket; uncertain setup remains blocked.",
    "cancel_account_invitation": "Admin/PIN-protected cancellation without deleting users or granting access.",
    "invitation_context": "Authorize the current confirmed recipient, exact email and unexpired invitation ticket.",
    "accept_account_invitation": "Accept after authorized password setup; atomically activate intended access and audit.",
    "update_account_022": "Retained migration-022 admin/PIN, role, continuity and handover validation used by the new wrapper.",
    "handover_lead": "Move one lead and pending follow-ups, scheduled visits and future unread reminders; preserve history.",
    "offboard_preview": "Require the current admin/PIN grant and return owned-work counts only.",
    "offboard_agent": "Atomically disable an agent, transfer all lead statuses using the selected mode and audit counts.",
    "require_kyc_client": "Require a lead link on new/converted/detached KYC while preserving older unlinked entries.",
    "knowledge_document_access": "Authorize an active admin or a KYC client's current agent; reject foreign/unlinked KYC as not found.",
    "read_knowledge_document": "Return authorized content, linked client name and safe attachment metadata.",
    "read_knowledge_file": "Resolve a private file after current document/client access checks.",
    "authorize_knowledge_download": "Authorize and audit a private attachment download in one transaction.",
    "knowledge_documents_page": "Apply current-owner KYC scope before literal search, counts and pagination.",
    "search_kyc_clients": "Administrator-only client name search/selected lookup returning masked phones.",
    "report_inactive_lead_owners": "Detect inactive owners across all stages and deduplicate safe daily security alerts.",
    "lead_contact_phones": "Lock and authorize a page of contacts, then return full numbers with atomic safe audits and no daily display quota.",
    "phone_reveal_window": "Compute the Pakistan day and its UTC bounds without a client-controlled reveal clock.",
    "phone_reveal_status": "Return only the active actor's distinct-lead daily usage and reset time.",
    "reveal_phone": "Serialize current-owner phone reads, enforce daily quotas, record reveals/audits and commit threshold alerts.",
    "security_alerts_summary": "Authorize an active administrator and aggregate unreviewed alert counts.",
    "security_alerts_page": "Authorize and filter/page safe administrator security alert metadata.",
    "review_security_alert": "Lock and mark an alert reviewed with administrator verification and atomic audit.",
    "log_manual_call": "Validate authorized phone-call logs, lock current ownership, preserve duration and audit atomically.",
    "prepare_call_method": "Classify mock adapter references without changing manually logged calls.",
    "create_profile": "Create an inactive Agent profile; metadata cannot grant role or access.",
    "touch_updated": "Maintain updated timestamps on mutable records.",
    "block_audit_changes": "Reject audit record updates and deletes.",
    "private_phone": "Service-only contact lookup after API authorization.",
    "assign_lead": "Admin/active-agent checks, locked assignment and history.",
    "create_lead": "Atomically create customer metadata, unique private phone and audit.",
    "crm_mutate": "Strict authorized CRM mutation with locks, history and audit.",
    "crm_metrics": "Aggregate the authorized dataset for a half-open range, including first-call speed and misses.",
    "crm_leaderboard": "Return safe names and completed-call/won-deal aggregates.",
    "apply_call_event": "Deduplicate events and preserve monotonic call/outcome state.",
    "recording_access": "Return an unexpired private recording reference.",
    "recording_batch": "Select a bounded batch of expired recording references.",
    "recording_deleted": "Record successful deletion or a retryable cleanup error.",
    "run_crm_job": "Run reminder, outcome and first-call jobs; the stale job no longer reassigns (update 038).",
    "prepare_lead_status": "Validate lead stage, loss reason and loss-note rules.",
    "record_lead_status_change": "Persist a real old/new stage transition and context.",
    "advance_lead_status": "Advance an authorized lead automatically; protect terminal stages.",
    "delete_property": "Reject linked deletion; queue eligible photos and audit removal.",
    "import_leads": "Persist an import batch and accepted rows with row-level rejections.",
    "lead_import_summary": "Return an import summary scoped to current member ownership.",
    "lead_imports_page": "Search/paginate currently visible import batches.",
    "assign_lead_import": "Atomically assign accepted batch members and audited history.",
    "save_knowledge_document": "Admin-only save of text, category, property name and keywords.",
    "delete_knowledge_document": "Remove an entry, queue attachment cleanup and audit.",
    "attach_knowledge_file": "Validate/attach a private file against its upload reservation.",
    "delete_knowledge_file": "Remove an attachment and queue its private object cleanup.",
    "list_knowledge_documents": "Authorize literal category/search filtering before pagination.",
    "accounts_admin": "Recheck that the actor is an active administrator.",
    "accounts_gate": "Require a valid personal, session-bound, unexpired unlock grant.",
    "save_accounts_pin": "Rotate personal PIN state, revoke grants and audit the change.",
    "unlock_accounts": "Track PIN attempts/lockout and issue a hashed temporary grant.",
    "lock_accounts": "Revoke the current matching session-bound unlock grant.",
    "accounts_page": "Return a PIN-gated, filtered account directory.",
    "account_detail": "Return PIN-gated account details, UID and bounded activity.",
    "login_attempt_status": "Report whether an email is currently locked after repeated wrong passwords.",
    "record_login_attempt": "Count failures in a window, lock after the limit, log the attempt and raise lockout/after-hours alerts.",
    "login_history_page": "Admin-only paginated login history with account, result and date filters plus summary totals.",
    "account_detail_035": "Preserve prior account detail fields behind the UID field.",
    "account_uid_candidate": "Draw one uniformly distributed six-digit candidate from the cryptographic generator.",
    "generate_account_uid": "Pick an unused six-digit UID under a lock, retrying up to 200 draws.",
    "assign_account_uid": "Copy a reserved UID/name/role or generate a UID when a profile is inserted; reject any UID change.",
    "account_provisioning_summary": "Return the saved account name, email, role, UID, access and lifecycle status after creation.",
    "account_uid_available": "PIN-gated advisory check that a six-digit UID is neither assigned nor reserved.",
    "begin_account_provisioning": "Validate a Gmail-only request, reject used emails/UIDs, recover abandoned reservations and reserve id/UID/role.",
    "fail_account_provisioning": "Release a reservation only when no Auth user exists for it.",
    "complete_account_provisioning": "Confirm the reserved Auth user and profile, activate intended access and audit creation.",
    "update_account": "Serialize name/role/access updates and preserve an active admin.",
    "account_action": "Validate and audit external Auth account-operation intent/results.",
    "format_pk_time": "Format a moment as a short Pakistan date and time for notification text.",
    "first_call_due": "Compute a first-call deadline from working days, hours and the last-call window.",
    "working_minutes": "Count minutes inside working hours between two moments.",
    "push_notification": "Create one notification per user/type/group, summarising repeats in the same group.",
    "track_lead_owner": "Restart the first-call clock whenever a lead changes owner.",
    "notify_lead_owner": "Notify the new and previous owner of an assignment, one summary per transaction.",
    "stamp_assignment": "Copy the deadline and review reason onto each assignment history row.",
    "record_first_call": "Stop the first-call clock at the owner's first logged call.",
    "lead_response_job": "Mark missed first calls and send missed-call, due-soon, visit and daily-summary notices.",
    "run_crm_job_037": "Previous job runner kept for reminders, outcomes and other existing jobs.",
    "crm_metrics_037": "Previous overview metrics extended by update 038.",
    "lead_review_page": "Admin-only paginated list of missed first calls or quiet leads.",
    "review_keep_leads": "Keep reviewed leads with their agent, set a new deadline and notify the agent.",
    "review_reassign_leads": "Reassign reviewed leads through the audited bulk path with a recorded reason.",
    "call_activity": "Today's calls, first calls, waiting, missed and overdue work per agent.",
    "first_call_queue": "An agent's leads waiting for a first call, without contact numbers.",
    "work_settings": "Read the working days and hours used for deadlines.",
    "save_work_settings": "Admin-only validated update of working hours with an audit row.",
    "notifications_page": "The signed-in user's latest notifications and unread count.",
    "read_notifications": "Mark the signed-in user's chosen or all notifications as read.",
    "report_scope": "Check the active user and date range; agents are limited to their own figures.",
    "visit_calendar": "Visits in a range of up to 62 days with lead, property and agent names, no phone numbers.",
    "visit_conflicts": "The same agent's other scheduled visits within 60 minutes of a time.",
    "prepare_target": "Keep the legacy month column and period start consistent on every target.",
    "stamp_followup_completion": "Record when a follow-up was completed for the follow-up goal.",
    "target_period_end": "First day after a day, week or month target period.",
    "targets_page": "Paginated targets by period, start or those running today; agents see their own.",
    "save_target": "Admin-only validated create or edit of a day, week or month target with audit.",
    "copy_targets": "Copy active agents' targets from the previous period without overwriting.",
    "crm_metrics_038": "Previous overview metrics extended by update 039.",
    "report_sources": "Leads created in a range by source with contacted, visited, won, lost and revenue.",
    "report_agents": "Per-agent assignment, first-call speed, calling, visits, sales and losses in a range.",
    "report_funnel": "Leads created in a range and the furthest pipeline stage each reached.",
    "report_lost": "Leads lost in a range by reason, source and agent.",
    "guard_attendance_policy": "Refuse overlapping attendance policy periods.",
    "attendance_local_date": "Pakistan calendar date of a moment.",
    "attendance_moment": "A Pakistan date and time as a timestamp.",
    "attendance_policy_on": "The attendance rules in force on a date.",
    "track_attendance_period": "Open or close attendance eligibility when an account is enabled, disabled or deleted.",
    "attendance_member": "Require an active Admin or Agent account.",
    "attendance_admin": "Require an active administrator.",
    "attendance_compute": "Punctuality, minutes late, worked, early-departure and overtime minutes.",
    "attendance_record_json": "Attendance record as JSON for API responses.",
    "attendance_days": "Each employee's derived attendance state for each day in a range.",
    "attendance_totals": "Per-employee attendance totals and percentage over a range.",
    "attendance_check_in_at": "Check in at an explicit time (database owner and tests only).",
    "attendance_check_out_at": "Check out at an explicit time (database owner and tests only).",
    "attendance_check_in": "Check the signed-in employee in with the database clock.",
    "attendance_check_out": "Check the signed-in employee out with the database clock.",
    "attendance_me": "Today's status, rules, month totals, recent days and open incomplete days for the signed-in user.",
    "attendance_employee": "One employee's history and requests; employees may view only themselves.",
    "attendance_notify_admins": "Notify every other active administrator.",
    "attendance_leave_request": "Validated leave request without overlaps; notifies admins.",
    "attendance_leave_cancel": "Cancel one's own pending leave request.",
    "attendance_leave_review": "Approve or reject leave; never one's own; audited and notified.",
    "attendance_leave_page": "Paginated leave requests (own, or all for admins).",
    "attendance_correction_request": "Validated correction request for a recent working day; notifies admins.",
    "attendance_correction_cancel": "Cancel one's own pending correction.",
    "attendance_correction_review": "Approve (recalculate and audit before/after) or reject a correction; never one's own.",
    "attendance_correction_page": "Paginated correction requests (own, or all for admins).",
    "attendance_overview": "Today's attendance counts by state and arrival time for admins.",
    "attendance_daily": "Filtered, paginated register of everyone expected on a date.",
    "attendance_period": "Weekly or monthly totals, daily states and trend for admins.",
    "attendance_employees": "Employees with attendance history, including disabled accounts.",
    "attendance_holidays_list": "Company holidays in a year.",
    "attendance_holiday_save": "Admin-only holiday creation with audit.",
    "attendance_holiday_delete": "Admin-only holiday removal with audit.",
    "attendance_policies_list": "Current attendance rules and their version history.",
    "attendance_policy_save": "Schedule versioned attendance rules from today or later without rewriting history.",
    "attendance_reconcile": "Mark earlier open sessions incomplete and send the admins' daily attendance summary.",
    "run_crm_job_039": "Previous job runner kept for reminders, outcomes and first-call jobs.",
}


def arrow_at(text, start):
    """Read balanced parameters; do not mistake an array's filter for a function."""
    tail = text[start:]
    whitespace = re.match(r"\s*(?:async\s+)?", tail)
    index = whitespace.end()
    if tail[index:index + 1] == "(":
        depth, quote, escaped = 0, None, False
        while index < len(tail):
            char = tail[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in {"'", '"', "`"}:
                quote = char
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    index += 1
                    break
            index += 1
        else:
            return False
    else:
        parameter = re.match(r"[A-Za-z_$][\w$]*", tail[index:])
        if not parameter:
            return False
        index += parameter.end()
    return tail[index:].lstrip().startswith("=>")


def named_functions(text):
    """Inventory declarations, direct arrow helpers and useCallback handlers."""
    found = []
    for pattern in [
        r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(",
        r"^\s*(?:async\s+)([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{",
    ]:
        found.extend((m.start(), m.group(1)) for m in re.finditer(pattern, text, re.M))
    for match in re.finditer(r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*", text):
        start = match.end()
        wrapped = re.match(r"useCallback\s*\(\s*", text[start:])
        if wrapped:
            start += wrapped.end()
        if arrow_at(text, start):
            found.append((match.start(), match.group(1)))
    return list(dict.fromkeys(name for _, name in sorted(found)))


def aligned_tables(markdown):
    """Keep generated Markdown tables stable with the repository's formatter."""
    lines, output, index = markdown.splitlines(), [], 0
    while index < len(lines):
        if not lines[index].startswith("|"):
            output.append(lines[index])
            index += 1
            continue
        rows = []
        while index < len(lines) and lines[index].startswith("|"):
            rows.append([cell.strip() for cell in lines[index].strip("|").split("|")])
            index += 1
        widths = [max(3, *(len(row[col]) for row in rows)) for col in range(len(rows[0]))]
        for row in rows:
            if all(re.fullmatch(r"-{3,}", cell) for cell in row):
                cells = ["-" * width for width in widths]
            else:
                cells = [cell.ljust(width) for cell, width in zip(row, widths)]
            output.append("| " + " | ".join(cells) + " |")
    return "\n".join(output)


def inventory():
    groups, module_count, function_count = [], 0, 0
    for folder, label in [
        ("client/src", "Frontend components, pages and helpers"),
        ("server/src", "API, services, validation and background jobs"),
        ("scripts", "Local setup and maintenance scripts"),
    ]:
        rows = ["### " + label, "", "| Module | Named functions/helpers | Responsibility |", "| --- | --- | --- |"]
        files = sorted(p for p in (ROOT / folder).rglob("*") if p.suffix in {".js", ".jsx"})
        for path in files:
            names = named_functions(path.read_text())
            purpose = MODULE_PURPOSES.get(path.stem)
            if path.relative_to(ROOT).as_posix() == "client/src/lib/meta.js":
                purpose = "Administrator-scoped social summary polling and safe platform/processing labels."
            if purpose is None and path.stem.endswith(".routes"):
                purpose = "Compatibility export of the shared CRM router; no duplicated route implementation."
            if purpose is None:
                raise ValueError(f"Add a reviewed responsibility for {path.relative_to(ROOT)}")
            cell = ", ".join(f"`{name}`" for name in names) or "Startup, shared constants or compatibility export"
            rows.append(f"| `{path.relative_to(ROOT)}` | {cell} | {purpose} |")
            module_count += 1
            function_count += len(names)
        groups.append("\n".join(rows))
    latest = {}
    for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        sql = path.read_text()
        definitions = [(m.start(), "create", m) for m in re.finditer(r"\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([\w]+)\s*\(", sql, re.I)]
        renames = [(m.start(), "rename", m) for m in re.finditer(r"\balter\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s+rename\s+to\s+(\w+)", sql, re.I)]
        for _, kind, m in sorted(definitions + renames, key=lambda item: item[0]):
            if kind == "rename":
                latest.pop(m.group(1), None)
                latest[m.group(2)] = path.name
            else:
                latest[m.group(1)] = path.name
    sql_rows = ["### PostgreSQL function inventory", "", "Each entry identifies its latest definition after all ordered migrations. Replaced earlier definitions are not counted twice.", "", "| Function | Latest migration | Responsibility |", "| --- | --- | --- |"]
    for name, migration in sorted(latest.items()):
        if name not in SQL_PURPOSES:
            raise ValueError(f"Add a reviewed SQL responsibility for {name}")
        sql_rows.append(f"| `{name}` | `{migration}` | {SQL_PURPOSES[name]} |")
    groups.append("\n".join(sql_rows))
    stats = {"source_modules": module_count, "named_javascript_functions": function_count, "sql_functions": len(latest)}
    intro = f"The current inventory covers {module_count} JavaScript/JSX modules, {function_count} explicitly named JavaScript functions/helpers (counted per module), and {len(latest)} latest PostgreSQL function definitions."
    return aligned_tables(intro + "\n\n" + "\n\n".join(groups)), stats


def node(parent, tag, attrs=None, text=None):
    attrs = {key if key.startswith("{") else f"{{{W}}}{key}": str(value) for key, value in (attrs or {}).items()}
    element = ET.SubElement(parent, f"{{{W}}}{tag}", attrs)
    if text is not None:
        element.text = str(text)
    return element


def root(tag):
    return ET.Element(f"{{{W}}}{tag}")


def serialize(element):
    return ET.tostring(element, encoding="utf-8", xml_declaration=True)


def run(parent, text, bold=False, code=False, color=None, size=None):
    r = node(parent, "r")
    props = node(r, "rPr")
    if bold:
        node(props, "b")
    if code:
        node(props, "rFonts", {"ascii": "Consolas", "hAnsi": "Consolas"})
        node(props, "sz", {"val": size or 19})
    elif size:
        node(props, "sz", {"val": size})
    if color:
        node(props, "color", {"val": color})
    node(r, "t", {f"{{{XML}}}space": "preserve"}, text)
    return r


def inline(parent, text, **defaults):
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not part:
            continue
        style = dict(defaults)
        if part.startswith("**") and part.endswith("**"):
            style["bold"] = True
            part = part[2:-2]
        elif part.startswith("`") and part.endswith("`"):
            style["code"] = True
            part = part[1:-1]
        run(parent, part, **style)


class WordManual:
    def __init__(self):
        self.document = root("document")
        self.body = node(self.document, "body")
        self.numbering = root("numbering")
        self.number_id = 0
        for identifier, kind, marker in [(0, "bullet", "•"), (1, "decimal", "%1.")]:
            abstract = node(self.numbering, "abstractNum", {"abstractNumId": identifier})
            node(abstract, "multiLevelType", {"val": "singleLevel"})
            level = node(abstract, "lvl", {"ilvl": 0})
            node(level, "start", {"val": 1})
            node(level, "numFmt", {"val": kind})
            node(level, "lvlText", {"val": marker})
            node(level, "lvlJc", {"val": "left"})
            ppr = node(level, "pPr")
            node(ppr, "ind", {"left": 420, "hanging": 240})

    def paragraph(self, text="", style=None, parent=None, numbering=None, **runs):
        p = node(parent if parent is not None else self.body, "p")
        props = node(p, "pPr")
        if style:
            node(props, "pStyle", {"val": style})
        if numbering:
            num = node(props, "numPr")
            node(num, "ilvl", {"val": 0})
            node(num, "numId", {"val": numbering})
        inline(p, text, **runs)
        return p

    def list_number(self, kind):
        self.number_id += 1
        num = node(self.numbering, "num", {"numId": self.number_id})
        node(num, "abstractNumId", {"val": 0 if kind == "bullet" else 1})
        return self.number_id

    def page_break(self):
        p = node(self.body, "p")
        node(node(p, "r"), "br", {"type": "page"})

    def table(self, rows):
        count = len(rows[0])
        if any(len(row) != count for row in rows):
            raise ValueError("Inconsistent Markdown table column count")
        if count == 3:
            shares = (0.24, 0.32, 0.44) if rows[0][0] in {"Module", "Function"} else (0.35, 0.29, 0.36)
        else:
            shares = tuple(1 / count for _ in range(count))
        widths = [int(CONTENT_WIDTH * share) for share in shares]
        widths[-1] = CONTENT_WIDTH - sum(widths[:-1])
        table = node(self.body, "tbl")
        props = node(table, "tblPr")
        node(props, "tblW", {"w": CONTENT_WIDTH, "type": "dxa"})
        borders = node(props, "tblBorders")
        for side in ["top", "left", "bottom", "right", "insideH", "insideV"]:
            node(borders, side, {"val": "single", "sz": 4, "color": "DDE3EA"})
        node(props, "tblLayout", {"type": "fixed"})
        margins = node(props, "tblCellMar")
        for side in ["top", "left", "bottom", "right"]:
            node(margins, side, {"w": 95, "type": "dxa"})
        grid = node(table, "tblGrid")
        for width in widths:
            node(grid, "gridCol", {"w": width})
        for index, row in enumerate(rows):
            tr = node(table, "tr")
            trpr = node(tr, "trPr")
            node(trpr, "cantSplit")
            if index == 0:
                node(trpr, "tblHeader")
            for width, text in zip(widths, row):
                cell = node(tr, "tc")
                cellpr = node(cell, "tcPr")
                node(cellpr, "tcW", {"w": width, "type": "dxa"})
                node(cellpr, "shd", {"val": "clear", "fill": NAVY if index == 0 else ("F3F6F9" if index % 2 else "FFFFFF")})
                node(cellpr, "vAlign", {"val": "top"})
                self.paragraph(text, style="TableText", parent=cell, bold=index == 0, color="FFFFFF" if index == 0 else NAVY, size=19)
        self.paragraph("", style="TableSpace")

    def cover_and_contents(self, lines):
        self.paragraph("HD MARKETING", style="CoverBrand")
        self.paragraph("CRM", style="CoverTitle")
        self.paragraph("Complete Project Documentation", style="CoverSubtitle")
        self.paragraph("Administrator and Agent User Guide", style="CoverSubtitle")
        self.paragraph("Functional and Technical Reference", style="CoverMeta")
        self.paragraph(next(line for line in lines if line.startswith("Updated:")), style="CoverMeta")
        migration_count = len(list((ROOT / "supabase/migrations").glob("*.sql")))
        self.paragraph(f"Based on the current source and migrations 001–{migration_count:03d}", style="CoverMeta")
        self.paragraph("A complete reference for workspace access, daily sales workflows, administration, security, configuration and the implemented code functions.", style="CoverNote")
        self.paragraph("This manual contains no real customer records, account passwords, API keys or PINs.", style="CoverNote")
        self.page_break()
        self.paragraph("Contents", style="ContentsTitle")
        self.paragraph("Click a chapter title to jump to its section. The user guide comes first; architecture, functions and setup follow.")
        chapter = 0
        for line in lines:
            if line.startswith("## "):
                chapter += 1
                p = self.paragraph(style="ContentsItem")
                link = node(p, "hyperlink", {"anchor": f"chapter_{chapter}", "history": 1})
                run(link, line[3:], color=NAVY, size=21)

    def body_from_markdown(self, markdown):
        lines = markdown.splitlines()
        self.cover_and_contents(lines)
        index = next(i for i, line in enumerate(lines) if line.startswith("## "))
        chapter, list_kind, list_number = 0, None, None
        while index < len(lines):
            line = lines[index].strip()
            if not line or line.startswith("<!--"):
                index += 1
                continue
            if line.startswith("## "):
                chapter += 1
                p = self.paragraph(line[3:], style="Heading1")
                p.insert(1, ET.Element(f"{{{W}}}bookmarkStart", {f"{{{W}}}id": str(chapter), f"{{{W}}}name": f"chapter_{chapter}"}))
                node(p, "bookmarkEnd", {"id": chapter})
            elif line.startswith("### "):
                self.paragraph(line[4:], style="Heading2")
            elif line.startswith("```"):
                index += 1
                while index < len(lines) and not lines[index].strip().startswith("```"):
                    self.paragraph(lines[index], style="CodeBlock", code=True, size=19)
                    index += 1
            elif line.startswith("|"):
                rows = []
                while index < len(lines) and lines[index].strip().startswith("|"):
                    cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                    if not all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                        rows.append(cells)
                    index += 1
                self.table(rows)
                list_kind = None
                continue
            elif match := re.match(r"^([-*]|\d+\.)\s+(.+)$", line):
                kind = "bullet" if match[1] in {"-", "*"} else "decimal"
                if kind != list_kind:
                    list_number = self.list_number(kind)
                self.paragraph(match[2], numbering=list_number)
                list_kind = kind
                index += 1
                continue
            else:
                parts = [line]
                while index + 1 < len(lines):
                    following = lines[index + 1].strip()
                    if not following or re.match(r"^(#|\||```|<!--|[-*] |\d+\. )", following):
                        break
                    parts.append(following)
                    index += 1
                self.paragraph(" ".join(parts))
            list_kind = None
            index += 1
        section = node(self.body, "sectPr")
        node(section, "headerReference", {"type": "default", f"{{{R}}}id": "rIdHeader"})
        node(section, "footerReference", {"type": "default", f"{{{R}}}id": "rIdFooter"})
        node(section, "pgSz", {"w": PAGE_WIDTH, "h": PAGE_HEIGHT})
        node(section, "pgMar", {"top": MARGIN, "bottom": MARGIN, "left": MARGIN, "right": MARGIN, "header": 540, "footer": 540, "gutter": 0})


def styles():
    document = root("styles")
    defaults = node(document, "docDefaults")
    rpr = node(node(defaults, "rPrDefault"), "rPr")
    node(rpr, "rFonts", {"ascii": "Arial", "hAnsi": "Arial"})
    node(rpr, "sz", {"val": 22})
    node(rpr, "color", {"val": NAVY})
    node(rpr, "lang", {"val": "en-GB"})
    ppr = node(node(defaults, "pPrDefault"), "pPr")
    node(ppr, "widowControl")
    node(ppr, "spacing", {"after": 120, "line": 276, "lineRule": "auto"})
    specifications = [
        ("Normal", "Normal", 22, NAVY, False, 0, 120),
        ("Heading1", "Heading 1", 34, NAVY, True, 0, 240),
        ("Heading2", "Heading 2", 26, GOLD, True, 200, 120),
        ("CoverBrand", "Cover Brand", 30, GOLD, True, 2200, 160),
        ("CoverTitle", "Cover Title", 90, NAVY, True, 0, 520),
        ("CoverSubtitle", "Cover Subtitle", 34, NAVY, True, 0, 180),
        ("CoverMeta", "Cover Metadata", 23, GREY, False, 60, 80),
        ("CoverNote", "Cover Note", 23, GREY, False, 340, 100),
        ("ContentsTitle", "Contents Title", 38, NAVY, True, 0, 240),
        ("ContentsItem", "Contents Item", 21, NAVY, False, 0, 90),
        ("TableText", "Table Text", 19, NAVY, False, 0, 35),
        ("TableSpace", "Table Space", 10, NAVY, False, 0, 80),
        ("CodeBlock", "Code Block", 19, NAVY, False, 0, 0),
    ]
    for identifier, label, size, color, bold, before, after in specifications:
        element = node(document, "style", {"type": "paragraph", "styleId": identifier, **({"default": 1} if identifier == "Normal" else {})})
        node(element, "name", {"val": label})
        if identifier != "Normal":
            node(element, "basedOn", {"val": "Normal"})
        node(element, "next", {"val": "Normal"})
        ppr = node(element, "pPr")
        if identifier.startswith("Heading"):
            node(ppr, "keepNext")
            node(ppr, "keepLines")
        if identifier == "Heading1":
            node(ppr, "pageBreakBefore")
            border = node(ppr, "pBdr")
            node(border, "bottom", {"val": "single", "sz": 10, "space": 10, "color": GOLD})
        if identifier == "CodeBlock":
            node(ppr, "shd", {"val": "clear", "fill": "F3F6F9"})
        node(ppr, "spacing", {"before": before, "after": after, "line": 240 if identifier in {"TableText", "TableSpace", "CodeBlock"} else 276, "lineRule": "auto"})
        if identifier == "CodeBlock":
            node(ppr, "ind", {"left": 160, "right": 160})
        if identifier.startswith("Heading"):
            node(ppr, "outlineLvl", {"val": 0 if identifier == "Heading1" else 1})
        rpr = node(element, "rPr")
        node(rpr, "sz", {"val": size})
        node(rpr, "color", {"val": color})
        if bold:
            node(rpr, "b")
    return document


def header_footer():
    header = root("hdr")
    p = node(header, "p")
    ppr = node(p, "pPr")
    border = node(ppr, "pBdr")
    node(border, "bottom", {"val": "single", "sz": 4, "space": 5, "color": "DDE3EA"})
    run(p, "HD MARKETING CRM  |  COMPLETE DOCUMENTATION", bold=True, color=GREY, size=17)
    footer = root("ftr")
    p = node(footer, "p")
    node(node(p, "pPr"), "jc", {"val": "right"})
    run(p, "HD Marketing CRM  ·  Page ", color=GREY, size=17)
    field = node(p, "fldSimple", {"instr": "PAGE"})
    run(field, "1", color=GREY, size=17)
    return header, footer


def relationships(entries):
    document = ET.Element(f"{{{REL}}}Relationships")
    for identifier, kind, target in entries:
        ET.SubElement(document, f"{{{REL}}}Relationship", {"Id": identifier, "Type": f"{R}/{kind}", "Target": target})
    return document


def package(manual):
    header, footer = header_footer()
    settings = root("settings")
    node(settings, "defaultTabStop", {"val": 420})
    node(settings, "updateFields", {"val": "true"})
    parts = {
        "word/document.xml": manual.document,
        "word/styles.xml": styles(),
        "word/numbering.xml": manual.numbering,
        "word/settings.xml": settings,
        "word/header1.xml": header,
        "word/footer1.xml": footer,
        "word/_rels/document.xml.rels": relationships([
            ("rIdStyles", "styles", "styles.xml"),
            ("rIdNumbers", "numbering", "numbering.xml"),
            ("rIdSettings", "settings", "settings.xml"),
            ("rIdHeader", "header", "header1.xml"),
            ("rIdFooter", "footer", "footer1.xml"),
        ]),
    }
    types = ET.Element(f"{{{CT}}}Types")
    for extension, mime in [("rels", "application/vnd.openxmlformats-package.relationships+xml"), ("xml", "application/xml")]:
        ET.SubElement(types, f"{{{CT}}}Default", {"Extension": extension, "ContentType": mime})
    for name, kind in [("document", "document.main"), ("styles", "styles"), ("numbering", "numbering"), ("settings", "settings"), ("header1", "header"), ("footer1", "footer")]:
        ET.SubElement(types, f"{{{CT}}}Override", {"PartName": f"/word/{name}.xml", "ContentType": f"application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"})
    ET.SubElement(types, f"{{{CT}}}Override", {"PartName": "/docProps/core.xml", "ContentType": "application/vnd.openxmlformats-package.core-properties+xml"})
    ET.SubElement(types, f"{{{CT}}}Override", {"PartName": "/docProps/app.xml", "ContentType": "application/vnd.openxmlformats-officedocument.extended-properties+xml"})
    parts["[Content_Types].xml"] = types
    root_rels = ET.Element(f"{{{REL}}}Relationships")
    for identifier, kind, target in [
        ("rIdDoc", f"{R}/officeDocument", "word/document.xml"),
        ("rIdCore", f"{REL}/metadata/core-properties", "docProps/core.xml"),
        ("rIdApp", f"{R}/extended-properties", "docProps/app.xml"),
    ]:
        ET.SubElement(root_rels, f"{{{REL}}}Relationship", {"Id": identifier, "Type": kind, "Target": target})
    parts["_rels/.rels"] = root_rels
    cp, dc, dt = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties", "http://purl.org/dc/elements/1.1/", "http://purl.org/dc/terms/"
    core = ET.Element(f"{{{cp}}}coreProperties")
    for namespace, tag, value in [
        (dc, "title", "HD Marketing CRM — Complete Project Documentation"),
        (dc, "subject", "Administrator and Agent User Guide; Functional and Technical Reference"),
        (dc, "creator", "HD Marketing CRM Project"),
        (cp, "lastModifiedBy", "HD Marketing CRM documentation generator"),
        (dc, "description", "Current role permissions, workflows, modules, functions, migrations, API, setup and implementation limits."),
    ]:
        ET.SubElement(core, f"{{{namespace}}}{tag}").text = value
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for tag in ["created", "modified"]:
        element = ET.SubElement(core, f"{{{dt}}}{tag}", {"{http://www.w3.org/2001/XMLSchema-instance}type": "dcterms:W3CDTF"})
        element.text = stamp
    ET.register_namespace("dcterms", dt)
    parts["docProps/core.xml"] = core
    app = ET.Element("{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}Properties")
    ET.SubElement(app, "{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}Application").text = "HD Marketing CRM documentation generator"
    parts["docProps/app.xml"] = app
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, element in parts.items():
            archive.writestr(name, serialize(element))
    return parts


def main():
    markdown = SOURCE.read_text()
    if markdown.count(START) != 1 or markdown.count(END) != 1:
        raise ValueError("The editable manual needs exactly one pair of inventory markers")
    catalog, stats = inventory()
    markdown = markdown.split(START)[0] + START + "\n\n" + catalog + "\n\n" + END + markdown.split(END)[1]
    SOURCE.write_text(markdown)
    manual = WordManual()
    manual.body_from_markdown(markdown)
    parts = package(manual)
    with zipfile.ZipFile(OUTPUT) as archive:
        if archive.testzip() is not None:
            raise ValueError("Generated Word archive failed integrity validation")
        for name in parts:
            ET.fromstring(archive.read(name))
    stats.update({"chapters": len(re.findall(r"^## ", markdown, re.M)), "tables": len(manual.document.findall(f".//{{{W}}}tbl")), "words": len(markdown.split()), "bytes": OUTPUT.stat().st_size, "word_file": str(OUTPUT)})
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
