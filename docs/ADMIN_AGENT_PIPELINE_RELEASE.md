# Administrators' Lead pipeline, agent by agent: update 055 release plan

Update 055 lets administrators follow the leads each agent personally contacted, and shows agents the same distinction on their own Lead pipeline.

- **Sales › Leads › Lead pipeline** opens a list of agents.
  - Search by name or UID.
  - Each agent shows their personally contacted leads, Hot, Warm and Cold counts, and follow-ups due (overdue ones marked).
  - The numbers cover every lead, not one page.
- **Opening an agent** shows that agent's pipeline with the agent's own tools:
  - search by customer name or phone number;
  - Hot, Warm and Cold;
  - the latest call's outcome, Number off included;
  - the agent's latest note;
  - next follow-up, lead details and call history;
  - 20 per page, numbered 1, 2, 3 across pages.
- **Earlier contacts**, a separate tab, lists leads the agent spoke to that are now someone else's, with who has them now. They never count in the agent's numbers.
- **An agent's own Lead pipeline** keeps listing every lead of theirs with an answered call, including calls made before a lead was reassigned to them.
  - Its heading says so, instead of "Leads you have spoken to".
  - It shows two counts: **My pipeline** (every lead in the list) and **Personally contacted** (those with an answered call the agent made, the number administrators see).
  - A lead whose last answered call was logged by someone else is marked "Logged by an administrator", "Logged by another agent" or "Caller not recorded".

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/055_admin_agent_pipeline.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-admin-agent-pipeline-055.sql`: one SELECT, flags and counts only    |
| Requires        | update 053 in production (054 is already there)                                     |

## Who counts as having spoken to a lead

- **Personally contacted:** an answered call counts for an agent only when it is filed under the agent and the audit log names the agent as the one who recorded it, as the reports do since update 050.
  - A call an administrator logs is filed under the lead's agent, so the filing alone is not enough.
  - A call with no audit entry counts for no one, and its caller is never guessed. The check reports how many there are.
- No answer, Busy, Wrong number and Number off never count.
- **Current pipeline:** leads assigned to the agent now, not deleted, that the agent spoke to.
  - The latest contact, the latest call (and its outcome filter) and the note are the agent's own.
  - The temperature and next follow-up are the lead's, as in the agent's own pipeline.
- **Earlier contacts:** leads the agent spoke to that are now assigned to someone else or no one.
- **Follow-ups due:** pending follow-ups due by the end of today (Pakistan time), overdue ones included, on all of the agent's leads, as the dashboard's call activity counts them.

**The agent's own list is unchanged.** It still lists every lead of theirs with an answered call, whoever made it: that is My pipeline. Personally contacted is the same number on the agent's page and the administrator's. The administrator's page explains the gap: how many of the agent's leads were last answered by an administrator, by another agent before a reassignment, or in an older call with no recorded caller.

On the agent's page the Hot, Warm and Cold buttons count the whole list (My pipeline), as before. On the administrator's page they count personally contacted leads only.

## What 055 changes

- Five new functions. No table, no data and no existing function changes; `agent_lead_list` stays as it is.
  - `admin_pipeline_agents` and `admin_agent_pipeline` (administrators only) and `agent_pipeline_attribution` (the agent themself), for the server only.
  - `agent_spoken_leads` and `agent_pipeline_numbers`, helpers no API role can call.
- Administrators only, checked by the server and again in the database. Agents and staff get 403 from the API whatever the address says.
- **The deployed code keeps working with 055.** Until 055 is applied, the new code reports "This feature needs CRM database update 055 after 054." on the administrators' page, and an agent's Lead pipeline shows as before, without the two counts or the marks.

## Release

1. **Merge** the PR with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up**, and check that the backup restores (v1.1.0 runbook step 4).
3. **Run** `check-admin-agent-pipeline-055.sql`. Required:
   - `release_stage` = `at 053 or 054, ready for 055`;
   - `transactions_open_over_1_min` = 0;
   - note the `existing_*` counts;
   - for information, `pipeline_difference` shows how many leads in agents' own Lead pipelines their agent never spoke to, by who answered them last, and `answered_calls_without_recorder` shows the older calls with no recorded caller.
4. **Apply 055** in the SQL Editor: paste the whole file and run it.
5. **Run the check again.** Required:
   - `release_stage` = `at 055`;
   - `server_functions` = 3;
   - every `*_must_be_0` = 0;
   - the counts as before, apart from normal use.
6. **Retire the inactive slot** (server guide section 10), then **deploy `<SHA>`** with the Production workflow.

## Smoke test

1. **Administrator:** Sales › Leads › Lead pipeline lists every agent with a UID. Search by part of a name, then by the first digits of a UID.
2. **Open an agent** with calls. The numbers match the directory.
   - Hot, Warm and Cold filter the list. The outcome filter finds Number off.
   - Search finds a customer by name and by phone.
   - View details opens the lead, and Back returns to the same filters.
3. **Earlier contacts** shows leads the agent spoke to that were reassigned, with their current agent. They are not in the Current pipeline.
4. **An agent** opening `/leads/pipeline` sees only their own pipeline. Changing the address to another agent's pipeline goes back to their overview.
5. **The same agent's page** shows My pipeline and Personally contacted. Personally contacted equals the administrator's number for that agent, and a lead an administrator called last is marked "Logged by an administrator".

## Rollback

- **Code:** roll back the application (v1.1.0 runbook step 8.2–8.4). The older code works with 055.
- **Database:** nothing needs undoing. The five functions are unused by the older code. To remove them anyway, drop the five functions.

## Known limits

- Who made a call relies on the audit log, as the reports do. A call recorded with no audit entry is counted for no one.
- An administrator's own calls on an agent's lead never make it the agent's contact, even if they answered.
