# P1: Manual call logging

Implemented locally on 13 October 2026. Existing databases need migration 018 before this feature can save calls. No hosted customer records or accounts were changed during implementation.

## Update the existing Supabase database

Run in the Mac terminal:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/018_manual_call_logging.sql
```

Open the project's Supabase SQL Editor, create a new snippet, paste and run the complete migration once after migrations 001–017. `Success. No rows returned` is normal. Refresh the CRM after success. Use `supabase/setup.sql` only for a fresh database; it now includes all 18 migrations.

## Call button (19 October 2026)

A **Call** button sits beside each customer number on the leads list and the customer profile. It needs no database update.

1. Choose **Call**. The call dialog shows the lead number, stage, location and budget.
2. Choose **Call +92…**. The browser passes the number to the device's phone app through a standard `tel:` link. On Windows, Microsoft Phone Link can place the call; the computer asks which app to use unless a default app for phone links is already set. On a phone, the dialler opens.
3. The dialog fills in the call start and runs a call timer. Choose **End call** when the conversation ends; the duration is copied into the minutes and seconds fields and can still be changed. Saving while the timer runs ends it first.
4. Choose **Call connected?** (Connected / Not connected), the outcome, the agent notes and any deal tags, then **Save call**. The log is saved with the same rules as **Log a call** below.
5. Closing the dialog after starting a call asks for confirmation, so an unsaved log is not lost by accident.

The dialog uses the number already shown on the page, so it makes no extra phone-number request. Agents see the Call button only for their own leads; admins see it for every lead with a valid number. **Log a call** on the profile remains for calls made outside the CRM.

## Administrator and agent workflow

1. Open an authorized customer profile. Agents can log calls only for their currently assigned leads; admins can log for any lead.
2. Call from the company phone, then choose **Log a call** in the CRM.
3. Choose **Call connected?** (Connected / Not connected), enter the call start in Pakistan time, minutes, remaining seconds, outcome, optional notes and tags.
4. Choose **Save call**. The timeline shows Manual, answered/unanswered, status and duration. An answered call advances a New lead to Contacted; unanswered calls leave its stage unchanged.
5. Administrators use **Call review → All methods / Manual / Mock / Provider** to filter the records. Later outcome edits retain unanswered-call restrictions.

The form defaults the start to the current Pakistan minute. Enter the actual start if the call happened earlier. Agents can log within the past 48 hours; admins within the past 30 days. Two minutes of future clock skew are allowed. Total duration is 0–7,200 seconds; answered calls require at least one second. Unanswered outcomes must be No answer, Busy or Wrong number; duration may be zero. Notes allow 4,000 characters and up to seven distinct supported tags.

Answered manual calls have status Completed and contribute to completed-call reports, target actuals and the leaderboard. Unanswered calls have status Failed and do not contribute to completed-call totals. An admin logging an assigned lead credits its current agent; an unassigned lead credits that admin. Automatic progression does not move a later stage backwards or reopen Won/Lost.

Save errors retain the draft. Repeated submission, input changes and dialog dismissal are blocked while the request is pending. Manual logging creates no real telephone call or audio recording; manual review rows have no Recording button.

## API and database

- `GET /api/call-capabilities` returns secret-free authorized flags. Manual logging is available regardless of provider configuration. Mock calling is advertised only outside production with `CALL_PROVIDER=mock`.
- `POST /api/leads/:id/calls/manual` requires an active admin/current assigned agent and the sensitive request limit. JSON contains `answered`, timezone-qualified `started_at`, `duration_seconds`, optional `duration_minutes`, `outcome`, optional `notes` and optional `deal_tags`. With minutes supplied, seconds must be 0–59; without minutes, `duration_seconds` is the total 0–7,200. The API normalizes the split duration before SQL.
- Unknown fields, spoofed agent/method IDs, malformed types, invalid times, invalid outcomes/tags and oversized durations/notes are refused. Another agent's lead returns 404. Missing migration 018 returns an actionable 503 error.
- `GET /api/calls?method=manual|mock|provider` filters before pagination. Method filters on unrelated entity lists are rejected.
- Production/no-provider screens offer Log a call and no mock controls. Development initiation/completion routes refuse use when mock calling is unavailable.
- Migration 018 adds `calls.method` and nullable `calls.answered`, backfills mock references and classifies new adapter mock IDs. Existing answered history is left unknown rather than invented.
- `log_manual_call` rechecks the active actor and current ownership, locks rows, enforces its own strict rules, writes exact start/end/duration/outcome fields, advances eligible leads, updates activity time and writes `call.manual_logged` in one transaction. Audit metadata includes IDs and field names, never notes or phone values. SQL constraints also preserve manual-call consistency during later edits.
- Both new functions have an empty search path and server-only execution. Existing calls-table browser/RLS restrictions remain in force. Audit failure rolls the call, lead changes and history back together.

## Checks and remaining production work

Server checks execute the real migrations/transactions using PGlite and the actual Express routes with isolated Auth fixtures. Client checks cover both portals, production capabilities, valid/invalid logs, cancellation, pending guards, retained drafts, timeline labels and the review method filter. Current test/build/browser results are recorded in `VERIFICATION.md`.

This completes P1's local implementation. P2–P8 in `docs/PRODUCTION_FIXES.md` remain separate tasks, including number protection, agent lead return, KYC access, MFA, deployment, email and broader browser/device acceptance. P1 alone does not certify production readiness.
