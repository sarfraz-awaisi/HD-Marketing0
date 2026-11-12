# Update 061: a fresh workspace for reassigned leads

When an administrator moves a lead from one agent to another (single Reassign or All leads → Assign to agent), the new agent used to see the previous agent's notes, call outcomes, tags, temperature and stage as if they were current. After 061 the new agent starts a fresh assignment period. Administrators keep the complete history, and no record is changed or deleted.

## What the receiving agent sees

- **Assignment period.** It starts when the lead was assigned to them (`leads.assigned_at`, kept since update 038). The fresh view applies only when another agent had the lead before. A lead's first agent sees its whole history, as before.
- **Hidden from the agent** (screens and API): earlier assignments' notes, calls (outcomes, comments, tags), temperature, stage changes, completed follow-ups and visits, a closed deal, and a lost reason and note set before the move.
- **Carried over.** Pending follow-ups and scheduled visits that moved with the lead, and an open deal:
  - they show their date, time, status and property, under "Carried over from the previous assignment";
  - the earlier comments are not shown;
  - the agent can complete, reschedule or cancel them, but not rewrite their comments.
- **Indicators.**
  - **Reassigned** stays for the whole assignment.
  - **New** stays until the agent's own first call. An administrator's call on the lead is kept and shown, but it does not end New, the previous result or the agent's first-call deadline.
  - **Previously not interested** also shows until then, and only when the previous assignment ended Not interested: its latest call, or the lead marked Lost for that reason.
- **Stage.** The stage the agent sees follows their own work, as a new lead's does: New, Contacted after their answered call, a visit or deal stage, or the stage they set. The lead's own status, which reports use, changes only through that work.
- **Lists.**
  - Assigned leads, Lead pipeline and their counts use the current assignment only.
  - The lead joins the agent's pipeline after their own answered call.
  - Assigned leads has a "Reassigned to me" filter.
- **Lost leads.** A Lost lead moved to another agent joins that agent's first calls: Waiting for first call, the deadline, and missed-first-call alerts. It stays Lost until someone changes it.
- **Moved more than once.** Each move starts a fresh period. This includes a lead returning to an earlier agent (A, B, then A).
- **No changes to earlier work.** An agent cannot change records from an earlier assignment. The API says why, and the database refuses too.

## What stays the same

- Administrators see every lead's full timeline and all records.
- No row changes. Calls stay filed under the agent who made them, and the audit log and reports keep their numbers.
- The administrators' agent pipeline pages count who spoke to whom as before. Only "answered by someone else" and the temperature follow the agent's own pipeline.
- Agents' own report drill-downs keep the lead's status and lost reason, which are what the numbers count. Calls, temperature, visit, deal and comments come from the current assignment only.
- Notifications are unchanged: the new agent is told about the lead, and the old one that it moved.

| Item            | Value                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Migration       | `supabase/migrations/061_reassigned_lead_workspace.sql` (no table or row changes; safe to rerun) |
| Read-only check | `supabase/check-reassigned-workspace-061.sql`                                                    |
| Requires        | update 060 in production (applied)                                                               |

**Why a migration:** agents' lists, counts, first calls and report rows are worked out in the database.

- 061 adds helpers, adds one index (`audit_log_lead_records`), and replaces `agent_lead_list`, `agent_pipeline_attribution`, `visit_calendar`, `first_call_queue`, `crm_mutate`, the `record_first_call` trigger function and the `lead_review_queue` view.
- It makes checked, minimal edits to the first-call rule in six functions. It also edits `report_drilldown`, `dashboard_snapshot`, `agent_pipeline_numbers` and `admin_agent_pipeline`, and makes `log_manual_call` record who logs a call before saving it.
- Each edit checks the function's exact text first. 061 stops and changes nothing if a function is not as expected.

**Release:**

1. Back up the database and test the restore.
2. Run the check before applying 061. It should read `at 060, ready for 061` with `transactions_open_over_1_min` = 0. Note these two counts:
   - `reassigned_lost_waiting_first_call`: Lost leads that join their agent's first calls;
   - `deadline_already_passed`: those of them that will be reported as missed first calls, to the agent and to administrators, at the next background check.
3. Apply 061, then run the check again. It should read `at 061`, with `server_functions` = 9 and `browser_function_access_must_be_0` = 0, and the record counts unchanged.
4. Retire the inactive slot and deploy.
5. Smoke test:
   - as an agent, open a lead moved to you: Reassigned and New, no earlier notes or outcomes;
   - as administrator, open the same lead: its full history.

Apply 061 before the code. The live code keeps working with 061, but until the deploy:

- its agent lists already follow the new rules;
- an agent's attempt to change earlier work fails with a general error rather than the explanation.

If the code goes out first, it behaves as before until 061 is applied. Only the "Reassigned to me" filter refuses.

**Rollback:** roll back the application; the older code works with 061. 061 itself changes no data. Withdrawing its rules would take a new update that restores the earlier function versions. Restoring the pre-061 backup would also undo all work saved since.

**Known limits:**

- **Owner changes.** A lead's owner changed directly in the database, without an assignment record, is not treated as reassigned. Every CRM screen records one.
- **One deal per lead.** A deal won or lost in an earlier assignment prevents adding another.
- **First call on a lead's first agent.** On a lead that was never anyone else's, an administrator's call still counts as the agent's first call, as it always has. Only reassigned leads use the new rule.
