# Update 067: a reassigned lead starts fresh for its new agent

When an administrator gives a lead to a different agent, the new agent gets
it as a fresh lead, marked **Reassigned** and **New**. They see nothing of the
previous agent's work. Administrators keep the full history of both agents.

## What the new agent saw before, and sees now

Update 061 already gave the new agent a fresh workspace. The earlier
assignment's notes, calls (outcomes, comments, tags), status changes and
stage stayed out of sight. Update 066 cleared the temperature. Three things
still reached the new agent:

| Before 067                                                                                                                                                                                         | From 067                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The previous agent's **pending follow-ups and scheduled site visits** moved to the new agent (update 022). The new agent saw them with their dates, but without comments, and got their reminders. | They are **cancelled** the moment the lead reaches a different agent, and their unread reminders are removed, as when a lead is deleted. Each cancellation is recorded in Audit history ("Cancelled a follow-up when the lead was reassigned"). The new agent books their own. |
| The previous assignment's **open deal** showed with its stage and value.                                                                                                                           | It no longer shows to the new agent, unless it changes during their assignment. Administrators and reports see it as before.                                                                                                                                                   |
| **"Previously not interested"** showed until the new agent's first call.                                                                                                                           | Never shown. The earlier result is no longer sent to the new agent at all.                                                                                                                                                                                                     |

Administrators still see everything:

- every call, note, comment and stage change of both agents;
- the cancelled follow-ups and visits, still filed under the previous agent
  with their comments.

Lead details the customer gave are not the previous agent's work, so the new
agent still sees them: name, phone, email, preferred location, budget,
advertisement answers and documents. Existing authorization rules apply.

## Audit history

Each cancellation is one entry, written by the administrator who moved the
lead, in the same request as the move. It names:

- the lead (`lead_id`);
- the new agent (`agent_id`);
- whose commitment it was (`user_id`, usually the previous agent);
- the day it was due or booked (`due_on`, `visit_on`, Pakistan time).

For example: "Cancelled Ali Agent's pending follow-up due November 18, 2026
for lead HD-008891 when the lead was given to Sara Agent." Searching Audit
history for either agent's name finds it.

## Security review (direct requests)

The new agent cannot reach the earlier assignment's work through the API.

- **Lists:** calls, follow-ups, visits and deals keep only the agent's
  current workspace, whatever filter is sent (`status`, `view`).
- **Timeline:** only the current assignment.
- **Single records:** there is no single-record GET for these.
- **Recordings:** administrators only.
- **Reminders:** each agent's own only.

067 closes two gaps that could have revealed something:

- **Changing a record by its ID.** The server now checks whether the record
  belongs to an earlier assignment _before_ anything else. Every change to
  such a record is refused with the same 403, whatever it asks.
  - Before 067, asking to set a hidden call's outcome to "Follow-up
    required" without a time answered 400 or 403 depending on that call's
    real outcome.
  - A record on someone else's lead is refused as not found, as before.
- **Filtering leads by the lead's own status or lost reason.** On a lead
  reassigned to the agent, those are the previous agent's result, so
  `GET /leads?status=…` and `?lost_reason=…` are refused for agents. Agents
  filter by their own stage in My leads. Administrators are unaffected.

## Every way a lead changes hands

The rule is applied in `handover_lead`. Every change of agent goes through
it:

- single Reassign and the lead's own Assign;
- bulk Assign to agents and round-robin distribution;
- lead review;
- editing a lead's agent;
- file and Meta assignments;
- offboarding an agent to other agents, and account deletion.

What stays as before:

- **A lead's first agent:** commitments already on the lead, such as an
  administrator's intake follow-up, move to them as before.
- **A lead left with no agent** (Keep with admin): its commitments go to the
  administrator, as before. When it is later given to a different agent
  than before, that agent starts fresh.
- **The same agent:** giving a lead to the agent who already has it changes
  nothing.
- **A → B → A:** a different agent each time, so A starts fresh too.

The reassign dialogs say this before you confirm:

- the single Reassign dialog;
- Assign to agents;
- the lead's Assign;
- the lead review;
- the offboarding hand-over.

## Leads reassigned before 067

067 changes no record when it is applied. Commitments that already moved to a
new agent before 067 stay with that agent until they are done, shown with
their dates as before. The read-only check counts them. The next time such a
lead changes hands, they are cancelled.

| Item            | Value                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/067_fresh_reassigned_leads.sql`: checked edits of `handover_lead`, `workspace_item` and `lead_workspace`. No table or row changes, safe to rerun.                                                |
| Read-only check | `supabase/check-fresh-reassignment-067.sql`                                                                                                                                                                           |
| Requires        | update 066 in production                                                                                                                                                                                              |
| Code            | The "Previously not interested" badge is removed; the reassign dialogs explain the fresh start; Audit history describes the cancellations. It works before 067 too, but tasks are only cancelled once 067 is applied. |

## Release

1. Back up the database and test the restore.
2. Run the check. It should read `at 066, ready for 067`, with
   `transactions_open_over_1_min = 0`. Note the counts:
   - `earlier_pending_followups_with_new_agents` and
     `earlier_scheduled_visits_with_new_agents`: commitments that already
     moved and stay until done;
   - `earlier_open_deals_hidden_after_067`: earlier deals the new agents will
     stop seeing;
   - `earlier_results_shown_to_new_agents`: leads now showing "Previously not
     interested".
3. Apply 067 and run the check again. It should read `at 067`, with
   `earlier_results_shown_to_new_agents = 0` and every other count unchanged.
4. Deploy the code.

**Rollback:** applying update 066's versions of the three functions again
restores the old behaviour for later reassignments. Follow-ups and visits
cancelled meanwhile stay cancelled. They are kept, with their comments, and
an administrator can reschedule them for the new agent.
