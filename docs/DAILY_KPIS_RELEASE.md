# Update 070: Daily KPIs

**Daily KPIs** replaces **Team targets** (administrators) and **My targets**
(agents) in the menu.

- **Administrators** set daily or weekly KPI questions, each with a Yes/No
  or a number answer and a target.
- **Agents** answer them for each day.
- **Administrators** see the results for a day, a week, a month or any
  range.

The earlier sales targets are not changed or deleted: their table, data and
page stay, at `/targets` (linked from Manage KPIs).

## The five KPIs it starts with

| KPI                                                                                                                        | Frequency | Answer   | Target   |
| -------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | -------- |
| Assigned calls answered: "Did you answer your assigned calls today?"                                                       | Daily     | Yes / No | Yes      |
| Social media activity: "Did you complete your social media activity today?"                                                | Daily     | Yes / No | Yes      |
| Project visits: "How many project visits did you complete today?"                                                          | Weekly    | Number   | 3 a week |
| Verified inventory with owner details: "How many verified property inventories with owner details did you complete today?" | Daily     | Number   | 1 a day  |
| HD Marketing video: "How many videos did you complete for the HD Marketing page today?"                                    | Weekly    | Number   | 1 a week |

- **Daily KPIs** start the day 070 is applied. **Weekly KPIs** start that
  week's Monday.
- **Every answer is self-reported.** Nothing is read from calls, inventory
  or social media, and nothing is posted anywhere.
- **The inventory KPI** asks for a count only, never owner contact
  details.

## Agents: Daily KPIs

- **Each KPI is answered for a Pakistan day.**
  - Yes/No starts with nothing chosen.
  - A number takes whole numbers from 0 to 1,000.
  - 0 and No are answers; a blank is no answer.
- **Daily KPIs** are answered on their day.
- **Weekly KPIs** take the day's count on any day of the current week up
  to today. The week's progress shows as, for example, "This week: 2/3".
- **Saving again replaces that day's answer.** Changing Monday's visits
  from 2 to 1 makes the week 1 less, never more.
- **Agents see only their own answers**, with the last 14 days.
- **My overview** shows "Daily KPIs today" in place of "My targets now".

## Administrators: Results and Manage KPIs

**Results**

- Today, Yesterday, This week, Last week, This month or a custom range, for
  all agents or one.
- A table with one row per agent:
  - their answers (answered / expected, with missed and pending);
  - one column per KPI;
  - overall targets met.
- Clicking an agent opens their day-by-day history and weekly totals.
- Disabled agents' history stays.

**Manage KPIs**

- Create, edit, switch off, archive and restore KPIs.
- A KPI no one has answered can be deleted.
- Assign a KPI to all agents or to chosen agents.

## Rules

- **Days and weeks:** Pakistan time, and weeks run Monday to Sunday. The
  Reports page's weeks start on Sunday; KPI weeks follow the weekly
  targets.
- **Daily targets:** a daily KPI is met on a day when the answer is Yes, or
  the count reaches the target. One good day never counts for the week.
- **Weekly targets:** a weekly KPI is met when the week's daily entries add
  up to the target, and it stays met once reached. A week still running is
  "in progress", never "missed".
- **Missed versus pending:**
  - A working day with no answer is **missed** once the day is over, and
    **pending** until then.
  - A weekly KPI's day stays pending until its week closes, because it can
    still be entered.
  - Days off, holidays, approved leave and days outside employment come
    from Attendance and never count as missed. The attendance rules
    themselves are not changed.
- **Weeks across two months:** a week counts in the range or month that
  holds its Thursday, so it lands in the month with most of its days. A
  single day shows its own week.
- **History is never recalculated:**
  - Wording changes show at once. Each answer keeps the question it was
    given.
  - Changes to the frequency, answer type, target, on/off or agents start
    from the next period: tomorrow for a daily KPI, next Monday for a
    weekly one.
  - The only exception: a version that started this period and that no
    one has answered under is corrected in place.
  - Earlier days and weeks always keep their rules.
- **Archiving** stops a KPI from the next period and keeps its answers.
  Deleting is only for a KPI with no answers.

## Security

- The three tables (`kpis`, `kpi_versions`, `kpi_submissions`) have
  row-level security and no browser access. Only the CRM's server uses
  them, through database functions that check the person every time.
- **Administrators** manage KPIs and see everyone.
- **Agents** can only:
  - read their own KPIs;
  - answer as themselves (the server never takes an agent from the
    request);
  - answer KPIs that apply to them, on days they may answer.
- **Every input is checked twice:** by the server's validators and again in
  the database. Saving is all or nothing.
- **Audit history** records KPI changes (created, changed, archived,
  restored, deleted) and every saved answer, with before and after.

## Release

| Item            | Value                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/070_daily_kpis.sql`: three new tables, their functions and the five KPIs. No existing table, row or function changes. Safe to rerun. |
| Read-only check | `supabase/check-daily-kpis-070.sql`                                                                                                                       |
| Requires        | Update 069 in production (070 refuses to run before it)                                                                                                   |
| Code            | Daily KPIs pages, menu, overview card and server routes. Before 070, the pages say "Daily KPIs need CRM database update 070".                             |

1. Release 069 first (see `DELETE_INSTANTLY_RELEASE.md`).
2. Back up the database and test the restore.
3. Run the check. It should read `at 069, ready for 070` with
   `transactions_open_over_1_min = 0`. Note `sales_targets`.
4. Apply 070 and run the check again. It should read `at 070`, with
   `kpis = 5`, `kpi_answers = 0` and `sales_targets` unchanged.
5. Deploy the code.

**Rollback:**

- The code before 070 ignores the new tables. Sales targets still work and
  return to the menu.
- The tables and their answers stay unless they are dropped on purpose.
