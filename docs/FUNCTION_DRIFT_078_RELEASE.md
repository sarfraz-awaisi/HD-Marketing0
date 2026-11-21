# Two production functions catch up with the code (update 078)

Schema-only restores of the 17 and 21 November production backups showed
production matching the repository in every function, column and trigger
except two. Update 078 repairs both. It changes no row, and it needs no
application deploy.

## What differs in production

| Function             | Missing in production                                                                 | Added by                              | Effect today |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- | ------------ |
| `log_manual_call`    | `perform set_config('hd.actor_id',p_actor::text,true);` before the call is saved      | Update 061                            | A call an administrator logs on an agent's lead counts as the agent's first call: it clears New and the deadline, and credits the agent in reports and KPIs |
| `account_action_034` | The actions `email_confirmation_requested`, `email_confirmation_sent`, `email_confirmation_failed` | Update 020 (renamed by update 035)    | **Accounts → Send verification email** fails with "Invalid account action" |

Both functions keep their owner (`postgres`), `SECURITY DEFINER`, an empty
`search_path` and their grants (`service_role` only).

## After 078

- **An administrator's manual call** is saved under the lead's agent as
  before, but it no longer counts as the agent's first call. The lead stays
  New for the agent, with the deadline, until the agent calls.
  - **Agents' own calls count as before.**
  - Call outcomes still move the stage (update 077), whoever logs the call.
- **Send verification email works again.** The Accounts gate (an
  administrator with an unlocked PIN session) is unchanged, and any other
  action is still refused.
- **Earlier records are not changed.** The read-only check counts first
  calls that came from an administrator's call (`admin_logged_first_calls`)
  and their dates. Correcting them would be a separate decision.

## Release

| Item            | Value |
| --------------- | ----- |
| Migration       | `supabase/migrations/078_function_drift.sql` |
| Read-only check | `supabase/check-function-drift-078.sql` |
| Requires        | Update 077 |
| Application     | None. Releases `a0a1fb9` and later work before and after 078. |

1. Back up the database.
2. Run the check. It should read:
   - `release_stage` = `at 077, ready for 078`;
   - `records_call_actor` = false;
   - `accepts_email_confirmation` = false;
   - `transactions_open_over_1_min` = 0.

   Keep `admin_logged_first_calls`.
3. Apply 078 and run the check again. It should read:
   - `release_stage` = `at 078`;
   - both fixes true;
   - `functions_secure` = true;
   - `admin_logged_first_calls` unchanged.

The update checks each edit and changes nothing if a function is not
exactly the production or repository version. Running it again changes
nothing.

## Rollback

Production's earlier versions differ only by the two edits. To undo them:

```sql
begin;
do $$ begin
 execute replace(pg_get_functiondef('public.log_manual_call(uuid,uuid,jsonb,text)'::regprocedure),
  E'  perform set_config(''hd.actor_id'',p_actor::text,true);\n','');
 execute replace(pg_get_functiondef('public.account_action_034(uuid,text,text,uuid,text,text)'::regprocedure),
  $t$,'email_confirmation_requested','email_confirmation_sent','email_confirmation_failed'$t$,'');
end $$;
commit;
```

Then run the check. It should read `at 077, ready for 078`.
