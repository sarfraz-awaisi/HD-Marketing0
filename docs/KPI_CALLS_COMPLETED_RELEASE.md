# Calls completed: the day's assigned calls (update 081)

Daily KPIs gain **Calls completed**. Each day administrators assign leads
to agents, and an agent must save a call outcome for every lead assigned to
them that same day. There is no fixed target: the day's assigned leads are
the target.

The KPI shows only completed out of assigned:

| Day | Shown |
|---|---|
| All 50 completed | 50/50 Completed — Yes |
| 35 of 50 completed | 35/50 Completed — No |
| None of 50 completed | 0/50 Completed — No |
| Today, not finished yet | 35/50 Completed — In progress |
| Nothing assigned | 0/0 — No calls assigned (not counted as missed) |

The first-call deadline KPI is unchanged and stays a separate KPI. It is now
labelled **First-call deadline**.

## Why

On 23 November 2026, Abru saved 80 calls, but the Daily KPI showed
"Calls made 5".

That figure belonged to the first-call deadline KPI (update 072). It counts
only calls on the leads whose first-call deadline fell that day, made by the
deadline. No call was missing.

## Counting rules

All days are Pakistan (Asia/Karachi) calendar days.

- **Assigned:** the leads given to the agent that day. Each lead counts
  once, even if it was given twice.
- **Completed:** the assigned leads for which the agent saved at least one
  call outcome after receiving the lead, that same day.
  - Any outcome counts: answered or not, No answer, Busy, Number off,
    Wrong number, Interested, Not interested, Follow-up required and the
    others. The customer does not have to be reached.
  - More calls to the same lead do not add to completed.
  - Calls to older leads do not count towards that day's assigned leads.
  - An outcome saved the next day does not complete the lead.
- **Reassignment:**
  - A lead moved to another agent that day, before this agent called it,
    counts for the agent who received it.
  - A lead the agent called, then moved away, stays completed for them.
- **Deleted leads** do not count, as in Reports.
- **A call counts for whoever logged it,** as in Reports and Team
  performance. When an administrator logs a call on an agent's lead,
  nothing records who actually dialled. So that call does not complete the
  lead for the agent. Crediting such calls to agents would need an "on
  behalf of" choice when the call is logged. Earlier records are not
  guessed or rewritten.

Total calls, answered calls and other call statistics are not part of this
KPI. They remain in Reports, Team performance and Call history, which are
unchanged.

## What is unchanged

- No call, lead, answer or audit entry is changed.
- The first-call deadline KPI keeps its rules and results.
- Agents cannot answer KPIs the CRM fills in.
- An agent's Daily KPIs show only their own work.

## Migration 081

`supabase/migrations/081_kpi_calls_completed.sql` is applied after 080 and
is safe to rerun. It:

- accepts the new measure `call_activity` (daily, Yes/No) in
  `kpi_versions` and `kpi_rules_problem`;
- adds each agent's assigned and completed leads per day to
  `kpi_measures`. Its checked edits stop, changing nothing, on an
  unexpected definition;
- adds the KPI **Calls completed** once. It counts from the first day of
  Daily KPIs, so earlier days show their real results.

To rename the KPI or limit it to some agents, use Daily KPIs → Manage KPIs.

`supabase/check-kpi-calls-completed-081.sql` is read-only.

- Before 081: `at 080, ready for 081`.
- After 081: `at 081`, with yesterday's assigned and completed totals.

## Release order

**Deploy the code first, then apply 081.**

- The new code works without 081: no KPI uses the new measure until 081
  adds it.
- The old code does not know the new measure. If 081 comes first, the live
  site shows the new KPI wrongly until the deploy.

## Rollback

- **The code:** switch back to the previous release. The new KPI then shows
  wrongly until the code returns.
- **The KPI:** archive it in Manage KPIs. The database changes in 081 are
  only additions and need no rollback.
