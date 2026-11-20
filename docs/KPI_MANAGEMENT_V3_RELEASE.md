# Manage every KPI's rules (update 076)

Administrators can now change the frequency, answer type and target of
every Daily KPI in **Daily KPIs → Manage KPIs → Edit**, including the five
KPIs the CRM fills in (update 072). Before, those KPIs locked Frequency and
Answer type.

Each KPI stays measured by the CRM: agents still cannot answer it or change
its result.

## Why the fields were locked

Update 072 tied each CRM source to one set of rules, in two places:

- the database constraint `kpi_versions_measure`, which allowed calls and
  social only as daily Yes / No, inventory only as a daily number, and
  visits and video only as weekly numbers;
- `kpi_apply_rules`, which refused any change of frequency or answer type
  for a KPI the CRM fills in.

The Edit dialog disabled both fields to match.

## What each CRM source can measure

| KPI (source)                          | Daily | Weekly | Yes / No (expects Yes)                      | Number                               |
| ------------------------------------- | ----- | ------ | ------------------------------------------- | ------------------------------------ |
| Assigned calls (first calls)          | ✓     | —      | ✓ every lead due that day called on time    | —                                    |
| Social media (approved links)         | ✓     | ✓      | ✓ at least one link approved                | ✓ up to 5 a day / 35 a week          |
| Verified inventory (verified listings)| ✓     | ✓      | ✓ at least one listing verified             | ✓ any target                         |
| Project visits (approved visits)      | ✓     | ✓      | ✓ at least one visit approved               | ✓ any target                         |
| HD Marketing video (approved videos)  | ✓     | ✓      | ✓ at least one video approved               | ✓ up to 2 a day / 20 a week          |

- **Assigned calls stay daily Yes / No.**
  - Weekly is not offered: each day is decided on its own, and adding days
    up does not say whether every deadline in the week was met.
  - Number is not offered: there is no count to reach, only "every lead
    called by its deadline".
  - Each day still shows the calls due, on time and late.
- **Target caps come from the evidence limits.** Agents can add up to 5
  social links a day and 20 video links a week. A higher target could never
  be met, so it is refused.
  - A daily video target is capped at 2, because a week can have 7 working
    days.
- **Anything else is refused with the reason.** The Edit dialog shows the
  reason before saving, and the server and database refuse it too.
- **KPIs agents answer themselves** may use any frequency and answer type,
  and a Yes / No KPI may now **expect No**: it is met on a day answered No.
  A KPI the CRM fills in always expects Yes.

## When changes take effect

| Change                                              | Takes effect                       |
| --------------------------------------------------- | ---------------------------------- |
| Title, question, description                        | At once                            |
| Daily rules (target, expected answer, on/off, agents)| The next Pakistan day             |
| Weekly rules, or Daily ↔ Weekly                     | The next Monday                    |

The confirmation in the Edit dialog shows these dates (described below).

- **Earlier periods keep their rules.** Days and weeks before the start date
  keep their rules and results. A week always has one set of rules.
- **Only one change waits at a time.** Editing again before it starts
  replaces it, from the same day.
  - Setting the rules back to today's rules cancels the waiting change, and
    Audit history records the cancellation.
- **A KPI the CRM fills in is never changed in place.** Its current day or
  week already has results.
- **An agents' own KPI** whose rules started this period, and that no one
  has answered under them, is still corrected at once, as before.
- **The Edit dialog shows the start date before saving.** For Daily →
  Weekly it also shows the first weekly period. A change of frequency or
  answer type is confirmed first.
- **Results show each day under its own rules.** A range spanning a change
  of daily target shows each target with the day it took over. Weekly
  results show each week's own target.
- **Audit history records every change** with the person, the time, and the
  rules before → after. For example: "Daily → Weekly; target 1 a day → 3 a
  week". It also records the previous question when it was reworded.

## Verified inventory as a weekly number

The update does not change any KPI. After release, an administrator sets
it up in **Manage KPIs → Edit**:

1. Set the question to "How many verified property inventories with owner
   details did you complete?".
2. Choose **Weekly**. The target empties: enter the weekly target, for
   example 3.
3. Check the start date and first weekly period shown. Save, then confirm.

Changing the target later (to 2 or 5, for example) works the same way, from
the next Monday.

How the weekly result is counted:

- **What counts:** the agent's listings added in the week (Monday to Sunday,
  Pakistan time) that an administrator verified with the owner's name and
  phone.
- **Late verification:** a listing verified after its week still counts for
  the week it was added.
- **A finished week below target** with listings still waiting shows
  "Awaiting review", not "Missed".
- **Rejected or waiting listings never count.** Listings without the
  owner's phone cannot be verified.

## Security

- Only administrators edit KPIs, checked by the server and by the database.
  Agents get 403 and cannot answer KPIs the CRM fills in.
- Every value is checked by the server's validators and again in the
  database, which knows each KPI's source (`kpi_rules_problem`).
- **Conflicting versions are prevented:**
  - each KPI has one version per start day;
  - saving is serialized;
  - a new change replaces any waiting one.
- No answer, evidence, verification or earlier version is changed. Owner
  details are never shown in KPI lists.

## Release

| Item            | Value |
| --------------- | ----- |
| Migration       | `supabase/migrations/076_kpi_management_v3.sql` |
| Read-only check | `supabase/check-kpi-management-076.sql` |
| Requires        | Update 075 in production |

What the migration changes:

- adds `kpi_versions.expect_yes` (Yes for every existing version);
- replaces the `kpi_versions_measure` constraint;
- adds `kpi_rules_problem`;
- makes 18 checked edits to five KPI functions.

It changes no row. It stops, changing nothing, if a function it edits
differs.

**Order: apply 076 first, then deploy the code.** The code relies on 076,
for example for the list's answer counts and the expected answer.

1. Back up the database and test the restore.
2. Run the check. It should read:
   - `release_stage` = `at 075, ready for 076`;
   - `transactions_open_over_1_min` = 0.

   Keep `kpis_now` and `changes_waiting`.
3. Apply 076 and run the check again. It should read:
   - `release_stage` = `at 076`;
   - `rules_check_function` = 1;
   - `versions_expecting_no` = 0;
   - `kpis_now` and `changes_waiting` unchanged.
4. Deploy the code.

**Rollback:**

- **Before any administrator uses the new options:** redeploy the earlier
  code. 076 can stay: the earlier code ignores the new column and fields.
- **After an administrator switched a CRM KPI to rules 072 did not allow**
  (for example social links as a number): the earlier code reads each
  source only in its 072 way, so it can show wrong numbers for that KPI.
  For example, approved social links would count as one a day. Before
  rolling back, set such KPIs back to their 072 rules in Manage KPIs, which
  takes effect from the next period, or keep the new code.

## Limitations

- **Assigned calls cannot be weekly or a number.** A weekly "every deadline
  met" rule could be added later as its own update.
- **Daily visits and inventory can change after the day.** A daily KPI for
  visits or inventory counts a photo or listing for its visit or
  listing day, so a later upload or verification can change an earlier
  day's result. This is the same rule weekly totals already follow.
- **Wording changes show at once on earlier days** of KPIs the CRM fills in.
  Those KPIs have no stored answers carrying their own question text.
