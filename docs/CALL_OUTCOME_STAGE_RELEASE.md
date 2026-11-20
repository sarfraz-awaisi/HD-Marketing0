# Call outcomes move the lead's stage (update 077)

The admin **Overview → Lead pipeline** counts open leads by their current
stage. Until now, logging an answered call only moved a new lead to
**Contacted**. A call marked Interested, Site visit scheduled or Deal
discussion left the lead at Contacted, so Interested showed 0.

## What changes

- **New calls** move the lead forward:

  | Call outcome         | Lead stage           |
  | -------------------- | -------------------- |
  | Interested           | Interested           |
  | Site visit scheduled | Site visit scheduled |
  | Deal discussion      | Negotiation          |

  - A lead never moves backwards: a later "Not interested" call keeps it
    where it is. An agent or administrator marks a lead Lost, with a
    reason, as before.
  - A won or lost lead is not reopened.
  - Visits and deals already moved the stage, unchanged.
- **Existing leads** move once to the furthest stage their earlier calls
  show.
  - Each move is in the lead's stage history at the time of the call that
    showed it, by that call's agent, and in Audit history. Both use request
    `update-077`.
  - Won, lost and deleted leads, and every call, visit, deal and follow-up,
    stay as they are.

Lists, filters, reports and the overview then show the same stages.

## Release

| Item            | Value |
| --------------- | ----- |
| Migration       | `supabase/migrations/077_call_outcome_stage.sql` |
| Read-only check | `supabase/check-call-outcome-stage-077.sql` |
| Requires        | Update 076 in production |
| Code            | None. The overview reads the stages 077 sets. |

1. Back up the database.
2. Run the check. It should read:
   - `release_stage` = `at 076, ready for 077`;
   - `transactions_open_over_1_min` = 0.

   Keep `leads_to_move` and `open_by_stage`.
3. Apply 077 and run the check again. It should read:
   - `release_stage` = `at 077`;
   - `leads_to_move` = `none`;
   - `history_rows_077` = the total of the earlier `leads_to_move`;
   - `open_by_stage` with the same total as before.

**Rollback:** 077 can stay with any earlier code. To stop new calls moving
the stage, restore the 076 `log_manual_call`. Moved leads keep their stage,
like any manual stage change. Stage history rows with request `update-077`
show each one.
