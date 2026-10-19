# F1 — Pipeline stages, lost reasons and history

Implemented in the application and verified locally. The hosted migration completed on 9 October 2026, and read-only Supabase checks passed for the lead/deal fields, history table, legacy-stage cleanup, required reasons on existing Lost leads and denied anonymous history access. Admin/agent browser acceptance remains pending.

## Apply to the existing HD Marketing Project

Run this in the project terminal on the Mac:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/012_pipeline_and_lost_reasons.sql
```

In Supabase, open **HD Marketing Project → SQL Editor → New snippet**, paste the copied SQL, then click **Run**. Run the entire migration once. It wraps the upgrade in a transaction.

Use this numbered migration for the current project. `supabase/setup.sql` is a separate, regenerated **fresh-install** bundle and must not be run again against the current database.

After success, reload the CRM. If development is stopped, run `npm run dev`. Existing users and passwords do not change. The project has server API credentials but no configured management token/database connection for applying arbitrary SQL; applying this upgrade through the hosted SQL editor is required.

## What changes

- Stages: New → Contacted → Interested → Site visit scheduled → Visit done → Negotiation → Won (booked) → Lost.
- Selecting Lost opens a reason dialog. Reason is required; its optional note is limited to 500 characters. Both admin and the current assigned agent can submit it.
- Reasons: price, location, budget, not interested, no response, bought elsewhere, wrong number and other.
- Lead detail shows the reason, note and loss time. Leads lists have a lost-reason filter and a reason column; choosing a reason selects the Lost status filter.
- The activity timeline includes stage changes. Each changed stage writes one history row and one status-change audit row in the same database transaction. Audit metadata contains field names/stages rather than note text.
- The overview shows the pipeline in stage order with readable labels.
- A first completed call advances a New lead to Contacted. Scheduled visits advance to Site visit scheduled; completed visits advance to Visit done. Creating a discussion/negotiation deal advances to Negotiation; winning it advances to Won; losing it requires and copies a lost reason to the lead.
- Automatic moves never go backwards and never reopen Won/Lost leads. A user can explicitly reopen a lead through its status selector; its current lost fields then clear while history remains.
- Lost deals have their own reason/note fields so the required data travels through the deal-to-lead transition. Cancelled/no-show visits do not advance a lead.
- Signed mock completion events use the same forward-only SQL helper. Replayed or late events do not add duplicate stage changes.
- Agent ownership is checked in SQL at mutation time. An old assignee cannot edit a lead after it is reassigned.
- PATCH operations preserve fields not supplied by the caller; schema defaults no longer overwrite a lead's source/budget or a visit's status on unrelated edits.

## Existing data

- Legacy `follow_up` becomes `contacted`; `site_visit` becomes `visit_scheduled`. Follow-up records are retained. These stage mappings receive history and audit entries with request ID `migration:012`.
- Existing Lost leads/deals receive reason `other` with a note identifying the previously unrecorded reason. The lead's previous `updated_at` supplies the legacy loss time and is described as an approximation in its note.
- No earlier stage timestamps are reconstructed. New history starts with the upgrade and subsequent changes.
- The private phone vault, Auth accounts, existing assignments and CRM activity records are preserved.
- Browser roles have no history-table grants or access policies, and cannot execute the new protected functions.

## Local checks

- Database: invalid/missing reasons, 500-character limit, actor/ownership denial, exactly one history/audit row, automatic forward moves, terminal protection, lost-deal rollback, event replay, browser denial and transactional rollback when history persistence fails.
- Upgrade: executable migration on legacy stages and lost records, with unchanged private phone rows.
- API: admin/agent validation, SQL-backed transitions, old-assignee denial, lost-deal validation, timeline ownership and lost-reason filters. Status-only updates preserve source and budget.
- UI: admin/agent Lost dialog, required reason, note limit/count, cancellation, retained draft on errors, timeline labels, list filters and deal loss validation.
- Fresh-install bundle: new fields/grants/seed and whole-bundle rollback after a later failure.

The simulated tests and hosted schema checks do not replace checking the running application after applying the migration.

## Hosted acceptance checklist

1. Sign in as the administrator, open a test lead and select Lost. An empty reason must fail. Save a reason/note and confirm the detail, list filter and timeline.
2. Sign in as the assigned agent and repeat on a lead owned by that agent. Requests for a lead owned by someone else must be denied.
3. On a New test lead, complete a development mock call. Confirm Contacted and one timeline transition.
4. Create a scheduled visit, then mark it Completed. Confirm Site visit scheduled then Visit done. Completing a later call must not move it back to Contacted.
5. Create a discussion deal, then mark it Won with a close date. Confirm Negotiation then Won. On a different lead, mark a deal Lost with a reason and confirm the lead reason/history.
6. Reassign a test lead and confirm its old agent cannot submit a status change. Confirm history is visible only through an authorized lead timeline.

Following the supplied roadmap, F2 starts after the F1 hosted migration and acceptance checks are complete.
