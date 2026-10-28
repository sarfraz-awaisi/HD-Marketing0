# Attendance management

Added 19 October 2026 with database update **040** (after 039). Attendance is for both **Admins and Agents**. It never changes lead ownership; no attendance rule reassigns leads.

## 1. Overview

- Everyone checks in when they start work and checks out when they finish. Times come from the database clock, never the device.
- Default rules:
  - Monday–Saturday, 10:00 AM–6:00 PM, with Sunday off
  - 15-minute grace period
  - Pakistan time (Asia/Karachi)
  - No break tracking
- The rules are stored as versioned settings, so a change never rewrites earlier days.
- Admins see a daily register, weekly and monthly reports, each employee's history, leave and correction requests, holidays and settings.
- Absences are never stored. They are worked out from the schedule, so reports are correct even if a background job has not run.

## 2. Employee workflow (Admins and Agents)

Open **My attendance** in the sidebar:

- **Today:**
  - the date and weekday, your status, shift, and check-in and check-out times
  - worked time, which runs live while you are checked in
  - punctuality, minutes late and minutes left early
- **Check in** is available on a working day that is not a holiday or approved leave.
- **Check out** asks for confirmation, because you cannot check in again that day.
- **This month:** attendance %, present, absent, late, leave, incomplete, worked time and overtime.
- **Last 14 days:** each day's status and times.
- **Request leave** and **Request correction**, each with the request's status and the reviewer's note. You can cancel a request while it is still pending.
- **Missing check-outs:** if you forgot to check out, a red **Check-out missing** box offers a correction for that day.

## 3. Admin workflow

Open **Attendance management**, the _Attendance Command Center_. The header shows today's date, the rules in force (shift, working days and grace, read from Settings), **Refresh** and today's CSV/Excel export.

**Navigation:**

- Main views: **Overview, Daily, Weekly, Monthly, Employees**.
- Management group: **Manage** (enter or correct earlier days, section 8a), **Leave requests**, **Corrections** (each with a count of waiting requests), **Holidays** and **Settings**.
- Arrow keys, Home and End move between sections.
- Links such as `?tab=weekly` keep working.

**The Overview dashboard** (all figures come from the existing attendance API):

| Panel              | What it shows                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline figures   | **Expected today** (scheduled to work and not on approved leave), **Working now**, **Checked out**, **Not checked in**, **On leave**. Each person is counted once; hover a figure for its definition.                                                                                         |
| Today's attendance | A donut of today's states (working, checked out, not checked in, absent, incomplete, on leave). The centre shows recorded attendance (checked in or out) out of the expected employees. Arrival time (on time, within grace, late) is shown separately below it, never mixed into the states. |
| Needs attention    | <ul><li>absences after the shift ended, late arrivals, and people not checked in yet (while the shift is still running)</li><li>missing check-outs in the last 30 days</li><li>waiting leave and correction requests</li></ul>Each has a link to the right place.                             |
| Live attendance    | Everyone expected on a date, including those not checked in, with search, role, status and date filters. **View** opens a side panel with today's times and the last 14 days; **Full employee history** opens the Employees view.                                                             |
| Weekly trend       | Present, incomplete, absent and leave per day, Monday–Sunday. Late arrivals are a separate number on each bar. Days off and upcoming days are striped. Uses the weekly report's data.                                                                                                         |
| This month         | The team's attendance % for the month (present ÷ eligible days, using the server's per-employee totals), absences, late arrivals, leave, incomplete days and hours worked. Includes a calendar shaded by the share of expected staff present each day. Uses the monthly report's data.        |

- **Daily, Weekly, Monthly:** see sections 4–6.
- **Employees:** history for any employee, including disabled accounts, over any date range up to 400 days. It shows totals, each day, and their leave and correction history.
- **Leave requests** and **Corrections:** approve or reject with an optional note. Your own requests show _Another administrator must review your own request_.
- **Holidays** and **Settings:** see sections 9–11.

Admins check in and out from **My attendance** like everyone else.

## 4. Daily register

- Pick any date. The register lists **every employee expected that day**, including those with no record: absent, on leave, holiday, day off.
- Columns:
  - shift
  - check-in, check-out, worked time
  - minutes late, punctuality, minutes left early, overtime
  - state
  - indicators for leave, pending correction and corrected day
- Filter by name or UID, role, state, punctuality, and active or inactive account. 25 rows per page. **View** opens that person's history.

| State             | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| Checked in        | Working now (today only)                                                              |
| Checked out       | Complete day                                                                          |
| Incomplete        | Checked in on an earlier day but never checked out                                    |
| Not checked in    | Today, before the shift ends; not yet counted                                         |
| Absent            | A working day that has ended with no check-in                                         |
| Approved leave    | Approved full-day leave and no check-in                                               |
| Holiday           | Company holiday                                                                       |
| Scheduled day off | Not a working day (Sunday by default)                                                 |
| Upcoming          | A future date                                                                         |
| Not active        | The account was not active that day (before it was enabled, or after it was disabled) |
| Not tracked       | Before attendance tracking started                                                    |

Punctuality is shown separately: **On time**, **Within grace** or **Late**.

## 5. Weekly report

- Weeks run Monday–Sunday.
- For each employee: scheduled days, present, absent, leave, late, incomplete, worked hours, minutes left early, overtime and attendance %.
- Each day of the week is shown as a code:
  - **P** present
  - **LT** late
  - **A** absent
  - **LV** leave
  - **H** holiday
  - **I** incomplete
  - **–** day off
- Filter by name or UID, role and account status. Export as CSV or Excel.

## 6. Monthly report

- Choose the month. The weekly figures are shown, plus within-grace arrivals and average hours per completed day.
- Charts show:
  - present and absent days per employee
  - late arrivals per employee
  - worked hours per employee
  - the daily trend
- Export as CSV or Excel.

**How the numbers are calculated (the server works them out from daily rows):**

- **Scheduled days:** working days under the rules, while the account was active and tracking was on, up to today.
- **Eligible days:** scheduled days minus holidays, approved leave (with no check-in) and today before the shift ends. That equals present + incomplete + absent.
- **Present:** a completed day, or today's open session.
- **Attendance %:** present ÷ eligible × 100, rounded to one decimal place.
- **Incomplete days:** count as **not present** until a correction is approved. They are never credited with 8 hours.
- **Worked time:** check-in to check-out in whole minutes, completed days only. Average = worked ÷ completed days.
- **Leave:** full days only; partial leave is not supported, so record it as attendance with an early departure. A day of approved leave on which the person checked in counts as **present**; leave never overwrites a check-in.
- **Joiners and disabled accounts:**
  - Someone who joined mid-month is counted only from the day their account was enabled.
  - A disabled account keeps all its history and is not counted after it was disabled.

## 7. Leave management

- **Types:** casual, sick, emergency, unpaid, other.
- **Dates:**
  - Full days, at most 31 per request.
  - The start can be up to 30 days in the past, and the end up to a year ahead.
  - The end cannot be before the start.
- **Overlaps:** a request cannot overlap your own pending or approved leave.
- **Pending and rejected leave never excuse an absence.**
- **Approval** applies straight away to past days too: absences on those days become **Approved leave**.
- **Who can review:**
  - Only an administrator can review, and never their own request; the database refuses it.
  - With only one administrator, that admin's own requests stay pending until a second administrator account exists.
  - There is no override.
- **Notifications:** every decision notifies the employee, and new requests notify the other admins.

## 8. Corrections

- **Types:** missing check-in, missing check-out, incorrect check-in, incorrect check-out.
- **Rules:**
  - The date must be a working day in the last 45 days, and the times must be on that date.
  - Times cannot be in the future, and check-out must come after check-in.
  - One pending correction per day is allowed.
- **On approval:**
  - The day is recalculated: punctuality, worked time, early departure and overtime.
  - It is marked **Corrected**.
  - The audit history keeps the times before and after.
- **If the day changed after the request was made,** approval is refused and the request must be rejected and asked again.
- **Two admins at once:** only the first review counts.
- Self-review is refused.

## 8a. Entering and correcting earlier days (update 042)

An administrator can enter or correct another employee's attendance for days before today, for example the days before the CRM started tracking.

**Where:**

- **Manage** tab: choose the employee, then **One day** or **Several days** (up to 31).
- **Manage** next to an earlier day in the **Daily** register or an employee's daily record.

**What each choice stores** (no new statuses):

| Choice                  | Stored as                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Present, Late, Half day | A check-in and check-out. Punctuality, worked time and early departure are calculated with that day's rules, as for a normal day. **Late** must arrive after the grace period. **Half day** must end before the shift ends. |
| Absent                  | Nothing is stored, as before. The day counts as absent because it has no attendance.                                                                                                                                        |
| Leave                   | Approved one-day leave, marked as recorded by the administrator. The employee sees it in their leave list as _Recorded by an administrator_; your reason stays in the audit log.                                            |

**Rules** (checked by the database):

- Only days before today, within the last year.
- Only working days that are not holidays.
- Never your own attendance; another administrator must do it.
- Not while a correction request for the day is waiting.
- Existing attendance is kept unless you confirm replacing it.
- An employee's own approved leave request, and a record with correction history, can't be removed here.

**Days before an employee's own attendance:** a day counts only once you enter it. It gets an attendance period of its own, marked with the administrator who entered it, so days nobody entered stay uncounted (_Not active_ or _Not tracked_) and never become absences. Weekends between entered days count as days off. Entering a day before tracking began also moves the first rules' start back, under the same rules; other employees are not affected. **Remove entry** takes an entered day out again, without leaving an absence. Days inside the employee's own attendance can't be removed, only changed or marked absent.

**Every save is previewed** (one day: before and after; several days: each date's result, with days off and holidays left out) and then saved together. Results are reported as added, changed, unchanged, kept as is or not saved.

**Audit and notifications:**

- Each change is written to `audit_log`: `attendance.manual_create` or `attendance.manual_update`, with the employee, date, administrator, values before and after, the reason, and whether the day became counted. Moving the start of tracking is logged as `attendance.tracking_start_moved`.
- The day's history appears under the form.
- Edited days show **Corrected**.
- Nothing notifies anyone; these are earlier days.

## 9. Working hours

- **Settings → Schedule a change** sets:
  - working days
  - shift start and end
  - grace minutes
  - the date the change takes effect (today or later, up to a year ahead)
- Earlier days keep the rules they were recorded under; each record stores its own copy.
- Days recorded today under today's rules cannot be changed for today; choose tomorrow.
- **Time zone** is fixed to Asia/Karachi.
- **Break tracking** is off and not configurable yet.

## 10. Grace period

- Lateness is counted in whole minutes from the shift start.
- With 15 minutes of grace:

  | Check-in     | Result                          |
  | ------------ | ------------------------------- |
  | 09:50, 10:00 | On time                         |
  | 10:10, 10:15 | Within grace                    |
  | 10:15:59     | Within grace (15 whole minutes) |
  | 10:16        | Late (16 minutes)               |
  | 11:00        | Late (60 minutes)               |

- "Minutes late" is the actual minutes after the start. The register can also show minutes beyond grace.
- A late employee is still **present**.

## 11. Holidays

- **Holidays** adds a date, name and optional description; there is one holiday per date.
- On a holiday nobody needs to check in, and the day is not an absence.
- Removing a holiday turns the date back into a working day. People without a check-in that day then show as absent.

## 12. Database tables

| Table                       | Purpose                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attendance_policies`       | Versioned rules (shift, days, grace, effective dates). Periods cannot overlap. Seeded on install: 10:00–18:00, Mon–Sat, 15 min.                                                                                       |
| `attendance_periods`        | When each account counts for attendance; opened and closed automatically when an account is enabled or disabled. Earlier days an administrator entered have their own closed periods with `recorded_by` (update 042). |
| `attendance_records`        | One row per person per day: snapshot of the rules, times and calculated values. Unique per person and date; one open session per person; check-out after check-in.                                                    |
| `attendance_holidays`       | Company holidays, unique by date.                                                                                                                                                                                     |
| `attendance_leave_requests` | Leave requests and reviews; reviewer can never be the requester. `recorded_by` (update 042) names the administrator who recorded the leave directly.                                                                  |
| `attendance_corrections`    | Correction requests with the original and requested times; one pending request per person and date.                                                                                                                   |

Row-level security is on for every table, and browsers have no access to any of them. Events go into the existing append-only `audit_log` (`attendance.*` actions), so there is no separate audit table.

## 13. SQL functions

- **Self-service:**
  - `attendance_check_in` and `attendance_check_out`, which use `now()`
  - `attendance_me`
  - `attendance_employee`: own history, or anyone's for admins
  - `attendance_leave_request`, `attendance_leave_cancel` and `attendance_leave_page`
  - `attendance_correction_request`, `attendance_correction_cancel` and `attendance_correction_page`
  - `attendance_holidays_list`
- **Admin:**
  - `attendance_overview`, `attendance_daily`, `attendance_period` and `attendance_employees`
  - `attendance_leave_review` and `attendance_correction_review`
  - `attendance_holiday_save` and `attendance_holiday_delete`
  - `attendance_policies_list` and `attendance_policy_save`
  - `attendance_admin_day` and `attendance_admin_set` (update 042): an earlier day as an administrator sees it, and entering or correcting earlier days (with a dry run)
- **Shared calculation:**
  - `attendance_days`: each person's state for each day
  - `attendance_totals`: the totals above
  - `attendance_compute`: punctuality and durations
- **Job:** `attendance_reconcile`, reached through `run_crm_job('attendance')`.
- **Test-only:** `attendance_check_in_at`, `attendance_check_out_at`, `attendance_admin_day_at` and `attendance_admin_set_at` take an explicit time and are callable only by the database owner, never the API.

Errors use SQLSTATE `HA400`, `HA403`, `HA404` and `HA409`, with messages that are safe to show to the user.

## 14. API

All routes need a signed-in, active account.

- **Self-service routes** (under `/api/attendance`) use only the signed-in person; a request that includes a user id is rejected:
  - `GET /me`, `POST /check-in`, `POST /check-out`
  - `GET /history?from&to`, `GET /summary?month`, `GET /holidays?year`
  - `GET /leave`, `POST /leave`, `POST /leave/:id/cancel`
  - `GET /corrections`, `POST /corrections`, `POST /corrections/:id/cancel`
- **Admin-only routes** (under `/api/admin/attendance`):
  - `GET /overview`, `GET /daily?date&search&role&state&punctuality&account&page`
  - `GET /weekly?week_start` (a Monday), `GET /monthly?month=YYYY-MM`
  - `GET /employees`, `GET /employees/:id?from&to`
  - `GET /leave`, `POST /leave/:id/review`, `GET /corrections`, `POST /corrections/:id/review`
  - `GET /settings`, `PATCH /settings`
  - `GET /holidays`, `POST /holidays`, `DELETE /holidays/:id`
  - `GET /manage?user&date` and `POST /manage` (update 042). The body is `user_id`, `entries` (1–31 of `date`, `status`, `check_in`, `check_out`, `leave_type`), `reason`, `replace` and `dry_run`. A dry run returns the same per-date plan without saving.
  - `GET /export?type=daily|weekly|monthly&format=csv|xlsx` plus the report's filters

Responses are never cached. Exports protect against spreadsheet formulas and contain only attendance data: no customers, phone numbers, passwords or tokens.

## 15. Permissions

| Action                                           | Agent | Admin                                        |
| ------------------------------------------------ | ----- | -------------------------------------------- |
| Check in or out, view own attendance and summary | Yes   | Yes                                          |
| Request leave or a correction; view decisions    | Yes   | Yes                                          |
| View others' attendance, reports, exports        | No    | Yes                                          |
| Review leave or corrections                      | No    | Yes, except their own                        |
| Holidays and attendance settings                 | No    | Yes                                          |
| Change today's times directly                    | No    | No (only through an approved correction)     |
| Enter or correct earlier days (update 042)       | No    | Yes, except their own; previewed and audited |

## 16. Background reconciliation

- The `attendanceReconciliation` job runs every minute with `npm run dev` or `npm run jobs`.
- **Open sessions from earlier days:** marked **Incomplete**, without inventing a check-out, and the employee is notified once.
- **After the shift on a working day:** admins get one notification: _Today's attendance: X present, Y absent_, naming who was late or absent.
- Safe to run repeatedly or at the same time (database lock); it creates no absence rows.
- Reports do not depend on it.
- **When an employee checks in after forgetting to check out:** the CRM closes the old day as incomplete, so the new day can start.

## 17. Testing

- **Server (Vitest + PGlite + Supertest):** `server/tests/attendance.test.js`; earlier-day entries in `server/tests/attendance-admin.test.js`.
- **Screens:** `client/tests/attendance.test.jsx`.
- **Run everything:** `npm test` from the project folder.
- Results are recorded in [VERIFICATION.md](../VERIFICATION.md).

## 18. Troubleshooting

- **"Attendance needs CRM database update 040 after 039":** install update 040.
- **"Today is a scheduled day off" or "company holiday":** expected. Check **Settings** or **Holidays**.
- **"Attendance is not enabled for your account today":** the account was disabled, or was enabled after today. Check **Accounts**.
- **"Your last check-in was never closed":**
  - Check in for today; that closes the old day as incomplete.
  - Then request a correction for the old day.
- **An admin's own leave stays pending:** a second administrator must review it.

## 19. Installing update 040

1. In Supabase, open **SQL Editor → New query**:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/migrations/040_attendance.sql
   ```

   Paste and **Run**. Expected: **Success. No rows returned**. It is safe to run again.

2. Restart the CRM: press Ctrl+C, then `npm run dev`.

- **Tracking start:** tracking starts on the day you install it. Earlier dates show _Not tracked_ instead of absent.
- **Undoing it:** there is no automatic rollback. Removing attendance means dropping the six `attendance_*` tables and functions, which deletes attendance history. Nothing else in the CRM depends on them, and no existing data is changed by installing it.

## 20. Production checklist

- [ ] Updates up to 039 installed. Update **013** must also be installed; your live database was missing it.
- [ ] Update 040 run in the SQL Editor, with no errors.
- [ ] CRM restarted, and **System status** shows the _Attendance check_ job running.
- [ ] One agent and one admin each check in and out once; the daily register shows them.
- [ ] Company holidays added for the year.
- [ ] A second administrator account exists if admins will request leave.
- [ ] Before inviting staff, a test export opens correctly in Excel.
