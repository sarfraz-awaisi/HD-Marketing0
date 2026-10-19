# Sales workflow: first calls, review, notifications, calendar, targets and reports

Added 17 October 2026 (roadmap F3, F4 and F7). Apply database update **038 after 037**, then restart the CRM.

## What it does

- **First-call deadline.** Every newly assigned lead must get its first call on the working day it is assigned. Leads assigned in the last 2 working hours (after 4:00 PM with the default hours), or outside working hours, are due by the end of the next working day. Default working hours: **Monday–Saturday, 10:00 AM–6:00 PM Pakistan time**.
- **What counts as a call.** The lead owner's first logged call of any outcome stops the clock, including "No answer". **Log a call** counts; changing the lead's status alone does not. A reassigned lead starts a new clock for its new owner.
- **Nothing moves on its own.** Leads are never reassigned automatically. The old rule that handed leads to another agent after 7 quiet days is switched off.
- **Leads waiting for your decision** (admin Overview):
  - **Missed first call:** the deadline passed with no call.
  - **No activity 7+ days:** no update for 7 days and no follow-up planned.
  - For each lead (or a selection), choose **Keep** to leave it with the agent, or **Reassign to…** another agent or Unassigned. Keeping a missed lead gives the agent a new deadline. Keeping a quiet lead hides it for another 7 days.
  - Every decision is recorded in Audit history. Reassignments show their reason in the lead's history.
- **Today's calling** (admin Overview): for each agent, today's calls (and how many were answered), first calls, leads still waiting, missed first calls, overdue follow-ups and quiet leads. An agent with no calls yet on a working day is flagged **No calls yet today**.
- **First-call figures** on both overviews: leads waiting, missed first calls, on-time first calls this month, and average time to first call. The average counts working hours only.
- **Agents** see **My calls today** on their overview: today's numbers and the leads still to call, earliest deadline first. The lead list's **First call** column shows **Called**, **Call by …** or **Missed first call**. Use the **First call** filter to list waiting or missed leads.
- **Notifications** (the bell):

  | Who    | When                                                          | Notification                                         |
  | ------ | ------------------------------------------------------------- | ---------------------------------------------------- |
  | Agent  | A lead is assigned                                            | New lead assigned, with its deadline                 |
  | Agent  | Several leads are assigned at once                            | One summary instead of many notices                  |
  | Agent  | A lead is moved away                                          | Lead reassigned                                      |
  | Agent  | 2 hours before closing, if leads due today are still uncalled | Leads need a first call today                        |
  | Agent  | A first call is missed                                        | Missed first call                                    |
  | Agent  | The admin keeps a reviewed lead with them                     | Kept with you, with the new deadline                 |
  | Agent  | A follow-up is due within 24 hours                            | Follow-up due                                        |
  | Agent  | After closing, if visits are booked for tomorrow              | Site visits tomorrow                                 |
  | Admins | First calls are missed                                        | Missed first calls to review, by agent               |
  | Admins | After closing on a working day                                | Today's calls per agent, naming agents with no calls |

  Mark one notification read, or all of them. Notifications never contain phone numbers.

## Install

1. In Supabase **SQL Editor → New query**, run the update:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/migrations/038_lead_response_and_notifications.sql
   ```

   Paste and **Run**. Expected: **Success. No rows returned**. It is safe to run again.

2. Restart the CRM: press Ctrl+C, then `npm run dev`. `npm run dev` now also starts the background jobs. The terminal shows a third stream named `jobs`; these jobs send the timed notifications above.

Existing assigned leads still at **New** get a deadline counted from when they were assigned. Older uncalled ones appear as missed on the first run. Leads already past New are not reported.

## Settings

Admins change working days, start and end times, the last-call window and the quiet-lead days under **Admin settings → Working hours and first calls**. New deadlines use the new hours. Deadlines already set stay as they are.

## Background jobs now running with `npm run dev`

These existing jobs ran only with `npm run jobs` before. They now start with `npm run dev`:

- follow-up reminders
- flags for calls missing an outcome
- deletion of 7-day-old call recordings
- alerts for inactive accounts that still own leads
- retries of file clean-up
- Meta lead processing (idle until Meta is connected)
- permanent erasure of leads that have been in **Deleted leads** for 30 days

To restore something from Deleted leads, do it within 30 days. In production, keep running the jobs as their own process (`npm run jobs`).

## Limits

- First-call speed counts working hours only, so a lead assigned at 9:00 PM and called at 10:30 AM the next morning shows 30 minutes.
- Calls are credited to the lead's owner. A call an admin logs on an agent's lead counts as that agent's first call.
- Changing the working hours does not move deadlines that are already set.

## Part 2: visit calendar, period targets and reports

Added 17 October 2026 (roadmap F8, F10 and F12). Apply database update **039 after 038**; no restart is needed.

### Site visit calendar

- **Site visits → Calendar** shows the week (Monday to Sunday) or the whole month in Pakistan time. Use the arrows and **Today** to move between weeks or months. **List** returns to the table.
- Each visit shows its time, lead number and name, property and (for admins) agent. Colours show the status: gold for scheduled, green for completed, red for cancelled or no-show. Click a visit to open the lead.
- In the month view, click a day to list that day's visits underneath. On a phone, each day shows how many visits it has.
- Admins can show one agent's visits. Agents see visits for their own leads.
- When adding or editing a visit, the form warns if the same agent already has a scheduled visit within an hour of the chosen time. The warning doesn't stop you from saving.

### Daily, weekly and monthly targets

- **Team targets** (**My targets** for agents) has **Daily**, **Weekly** and **Monthly** tabs. Weeks run Monday to Sunday. Use the arrows or **Go to** to pick a day, week or month.
- A target can include these goals: **answered calls**, **leads contacted** (different leads called, any outcome), **follow-ups completed**, **site visits**, **won deals** and **closed revenue**. Goals left at 0 aren't tracked or shown. Progress counts only the target's own day, week or month.
- **Copy previous day/week/month** copies each active agent's targets from the period before into the period shown. Targets already set there are kept.
- On their overview, agents see **My targets now**: the targets running today, for the day, the week and the month.
- Existing monthly targets keep working unchanged.

### Reports

**Reports** now has five tabs. All use the From/Through dates in Pakistan time, and **Export CSV** downloads the tab you're viewing.

| Tab              | What it shows                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Summary**      | The existing overall figures.                                                                                                                                                                                                                                   |
| **Lead sources** | Leads created in the range, by source (CSV / Excel, Meta, manual …), and how far each group has got: contacted, visited, won, lost, conversion and won revenue.                                                                                                 |
| **Agents**       | For each agent in the range: leads assigned, first calls, % called on time, average time to first call, missed first calls, calls (answered), talk time, visits done, won deals, revenue and lost leads.                                                        |
| **Sales funnel** | Leads created in the range and how many reached each stage (Contacted → Interested → Site visit scheduled → Visit done → Negotiation → Won), as a share of all leads and of the stage before. A lead that is later lost still counts for the stages it reached. |
| **Lost reasons** | Leads lost in the range, by reason, source and agent.                                                                                                                                                                                                           |

Reports never include phone numbers. CSV values are protected against spreadsheet formulas.

### Install part 2

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/039_calendar_targets_reports.sql
```

In Supabase, open **SQL Editor → New query**, paste, and **Run**. Expected: **Success. No rows returned**. It is safe to run again. Then reload the CRM page.
