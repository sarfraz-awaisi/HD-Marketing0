# Update 072: Daily KPIs filled in by the CRM

The five Daily KPIs from update 070 stop being self-reported. The CRM fills
them in from its own records and from evidence an administrator approves.

| KPI                                   | Frequency | Filled in from                                                    | Target   |
| ------------------------------------- | --------- | ----------------------------------------------------------------- | -------- |
| Assigned calls answered               | Daily     | First calls by their deadline (Yes / No)                          | Yes      |
| Social media activity                 | Daily     | Social media links an administrator approved (Yes / No)           | Yes      |
| Verified inventory with owner details | Daily     | The agent's listings, verified with the owner's name and phone    | 1 a day  |
| Project visits                        | Weekly    | Visit photos an administrator approved (distinct project visits)  | 3 a week |
| HD Marketing video                    | Weekly    | Video links an administrator approved                             | 1 a week |

- **The weekly questions lose "today":** "How many project visits did you
  complete?" and "How many videos did you complete for the HD Marketing
  page?".
- **Answers already given stay as they were.** A KPI switches at once only
  if no one has answered it under its current rules. Otherwise it switches
  from tomorrow (daily) or next Monday (weekly).
- **A KPI an administrator has reworded is left self-reported.** The check
  below shows it as `kpis_found` under 5.
- **Other KPIs an administrator creates are answered by agents, as
  before.**

## How each KPI is counted

All days are Pakistan days, and weeks run Monday to Sunday.

**Assigned calls answered (daily, Yes / No)**

- **The day's workload** is every lead whose first-call deadline fell that
  day while the agent had it. It uses the same rule as Team performance's
  missed deadlines: the lead was not given to anyone else by then, not won
  by then, and not lost by then (unless it came from another agent).
  Deleted leads never count.
- **Any outcome is a call**, including No answer, Busy and Wrong number.
- **Yes** when every lead in the workload got the agent's first call by its
  deadline. **No** as soon as one deadline passes without it. A call made
  after the deadline is shown as late and does not make the day Yes.
- **Pending** while a deadline is still ahead.
- **A day with nothing due** shows "No assigned calls due" and is never
  missed.
- **Administrators' calls do not count for the agent.**
- **The page also shows:** the workload, called by the deadline, called
  late, remaining, calls made, and answered (connected) calls, as Reports
  count them.

**Social media activity (daily, Yes / No)**

- Agents add 1 to 5 links a day, one at a time: Facebook, Instagram,
  TikTok or YouTube, https only.
- The same link twice in a day is refused, including in another form, such
  as with tracking added or on m.facebook.com.
- **Yes** once an administrator approves one of the day's links.
- **Awaiting review** while links wait.
- **No** when all of the day's links were rejected.
- **Missed** on a working day with no link.

**Verified inventory with owner details (daily, number)**

- Counted from Inventory: the agent's own listings, by the day they were
  added.
- **A listing counts** once an administrator verifies it with the owner's
  name and phone filled in.
- **A listing verified later still counts for the day it was added.**
- Editing a listing never counts it again.
- Rejected listings, or listings still waiting, do not count.
- **The page shows:** uploaded, waiting for verification, verified and
  rejected.

**Project visits (weekly, number)**

- **One photo is one visit:** the agent gives the project and the visit
  date (a day of this week, up to today) with each photo.
- **The week counts distinct approved visits** (one per project and date),
  so two photos of one visit count once.
- **The same image file is refused**, whoever sends it.
- **An approval after the week ends still counts for the visit's week.**
- A finished week below target with photos still waiting shows "Awaiting
  review" rather than "Missed".
- **The visit records in Site visits are not used.** Those are customer
  site visits.

**HD Marketing video (weekly, number)**

- **Agents add links to finished videos.** Each link has its own status.
- **The same video is refused**, by anyone, in any form (youtu.be,
  youtube.com/watch?v=, /shorts/).
- **Approved videos count in the week they were added.**

## Agents: Daily KPIs

- **Each KPI the CRM fills in** shows its result, the numbers behind it,
  and the agent's evidence with its status (Waiting for review, Approved
  or Rejected) and the administrator's reason.
- **Add link** (social, today), **Upload photo** (visits, this week) and
  **Add video link** (videos, this week).
- **Listings link to Inventory.** A listing without the owner's name and
  phone says so.
- **There is no Yes/No or number to enter for these KPIs**, and no
  override.
- **The overview card** shows answers apart from "filled in by the CRM met
  so far".

## Administrators: Daily KPIs → Reviews

- **Four lists:** Social links, Visit photos, Videos and Inventory, each
  with how many are waiting.
- **Filters:** status (Waiting, Approved/Verified, Rejected, All), agent,
  and period (All dates, Today, Yesterday, This week, Last week, This
  month, or a custom range).
- **Approve, or Reject with an optional reason** the agent sees.
- **A decision can be changed later.**
- **Links open in a new tab** that gets no access to the CRM.
- **Photos open through a link that expires after 60 seconds.**
- **Inventory:** Verify (only with the owner's name and phone), Reject, or
  Clear (back to waiting). This is separate from **Add to Admin List**,
  which still copies a listing to the company inventory.
- **Results** shows the CRM's numbers in each KPI's cell.
- **Manage KPIs** marks these KPIs "CRM: …". Their frequency and answer
  type cannot be changed; the target, on/off and agents can, from the next
  period as before.
- **Audit history** records every link and photo added, every approval and
  rejection (with the earlier decision and the reason), every listing
  verified, rejected or cleared, and each KPI switched to the CRM.

## Security

- **Two new tables:** `kpi_evidence` and `property_verifications`. Both have
  row-level security and no browser access. Only the CRM's server uses
  them, through database functions that check the person every time.
- **Agents** add and see only their own evidence, and cannot approve
  anything, their own included.
- **Only administrators** review and verify.
- **Photos** are kept in the new private bucket `kpi-evidence`: JPEG, PNG
  or WebP, up to 5 MB, in the agent's own folder.
  - The server checks the file's first bytes, not its name.
  - A refused upload is removed from Storage.
  - Photos are shown only to their agent and administrators.
- **Links** are checked twice, by the server and the database:
  - https only;
  - no user name, password or port;
  - only the four platforms' own domains, so look-alikes such as
    facebook.com.example.net are refused.
- **The owner's phone or name never appears in KPI lists**, only whether
  they are filled in.

## Release

| Item            | Value                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/072_kpi_evidence.sql`: <br>• two new tables, the `kpi-evidence` bucket and their functions; <br>• `kpi_versions.measure` (default `self`); <br>• seven checked edits of 070's functions; <br>• the switch of the first five KPIs. <br>No row is deleted or rewritten. Safe to rerun. |
| Read-only check | `supabase/check-kpi-evidence-072.sql`                                                                                                                                                                                                                                                                   |
| Requires        | Update 071 in production. 072 refuses to run before it, and stops (changing nothing) if a function it edits differs from 070's.                                                                                                                                                                         |
| Code            | Daily KPIs pages (My KPIs, Results, Reviews, Manage KPIs), the overview card, the server routes and Audit history wording.                                                                                                                                                                              |

**Order: the code first, then 072.**

- **The new code works on a database at 071** (tested): every KPI reads as
  answered by the agent, and Reviews says "Daily KPIs need CRM database
  update 072" until it is applied.
- **The code live now (before this update) does not know these KPIs are
  filled in by the CRM.** With 072 applied first, an agent saving answers
  for them is refused.

1. Back up the database and test the restore.
2. Deploy the code.
3. Run the check. It should read:
   - `release_stage` = `at 071, ready for 072`;
   - `edits_ready` = 7 and `edits_unexpected` = 0;
   - `kpis_found` = 5;
   - `transactions_open_over_1_min` = 0.

   `answers_this_period` shows which KPIs switch at once (0 answers) and
   which from tomorrow or next Monday.
4. Apply 072 and run the check again. It should read:
   - `release_stage` = `at 072` and `edits_applied` = 7;
   - `kpis_measured` = `kpis_found`;
   - `kpi_evidence` = 0 and `evidence_bucket_private` = true.

   `measured_from` lists when each KPI's CRM rules start.

**Rollback:**

- The earlier code ignores the new tables and the `measure` column, and
  shows these KPIs as questions again. An agent's save is then refused for
  KPIs the CRM fills in.
- To make them self-reported again, an administrator would need a new
  version of each KPI with `measure = 'self'`. This is a separate SQL step,
  to be approved on its own.
- Evidence, decisions and photos stay unless they are deleted on purpose.

## Not in this update

- **Old listings:** Reviews → Inventory lists every agent listing ever
  added, all waiting. Older ones can be left, or filtered out by period.
- **No bulk approval:** each decision is one click, and an administrator
  can make up to 30 changes a minute (the CRM-wide limit for changes).
- **No change** to Site visits, Add to Admin List, calls or attendance
  rules.
