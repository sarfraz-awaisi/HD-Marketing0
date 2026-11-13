# Update 066: Hot, Warm and Cold start again on reassignment

When an administrator gives a lead to a different agent, the lead's Hot, Warm or Cold no longer carries over anywhere. The receiving agent classifies it afresh with the existing call form.

## How the classification works

Hot, Warm and Cold are not a field on the lead. They are tags (`Hot lead`, `Warm lead`, `Cold lead`) saved on a call when the agent records it, and the lead's classification is the latest such tag. Since update 061, the following read it only from calls made since the lead reached its current agent from another agent (`workspace_since`, which is `leads.assigned_at` once an earlier assignment named someone else):

- the receiving agent's Assigned leads and Lead pipeline, with their counts;
- administrators' view of an agent's pipeline.

Two places still read the whole history, so the earlier agent's classification showed there after a reassignment:

- **All leads**, temperature filter (update 058);
- **administrators' report drill-down rows** (update 050).

066 makes them read the current assignment the same way.

## What changes and what does not

- **Atomic and not bypassable.** The reset is the reassignment itself: the existing trigger sets `assigned_at` in the same statement that changes the lead's agent. It works the same for single Reassign, Assign or reassign, bulk assignment, Assign to agents, file and Meta assignments, and any other path, because they all change `leads.assigned_agent`.
- **Same agent:** assigning a lead to the agent who already has it changes nothing, so the classification stays. Editing a lead, notes, follow-ups and status changes never touch it.
- **A → B → A** is a different agent each time, so A starts afresh too (as in update 061).
- **Nothing is deleted.** Earlier calls keep their tags in the call history and audit log. Notes, follow-ups, stage, source, contact details and assignment history are untouched. Only reading the classification changes.
- **An unassigned lead** (taken from an agent and given to no one) shows its last classification until it is given to another agent.

| Item            | Value                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/066_reassignment_temperature.sql` (no table or row changes; safe to rerun) |
| Read-only check | `supabase/check-reassignment-temperature-066.sql`                                               |
| Requires        | update 065 in production                                                                        |
| Code            | none: the server and pages already show what the database returns                               |

**Release:**

1. Back up the database and test the restore.
2. Run the check. It should read `at 065, ready for 066`. `reassigned_leads_classified_by_earlier_agent` counts the leads that will show unclassified in All leads and drill-downs, as their agents already see them.
3. Apply 066 and run the check again. It should read `at 066`, with the same counts.

**Rollback:** applying update 065's versions of the two functions again undoes it. No data changes.
