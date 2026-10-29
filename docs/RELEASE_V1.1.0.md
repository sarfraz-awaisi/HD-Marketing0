# Release v1.1.0 runbook

v1.1.0 adds updates 042–048 to production, which runs v1.0:

- 042: historical attendance
- 043: readable audit history
- 044: admin property promotion
- 045: daily tasks and checkout approvals
- 046: building categories
- 047: staff and Employee management
- 048: flexible shifts

The owner approves every step that touches production. Claude prepares and checks steps only with that approval.

| Item                       | Value                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| v1.0.0 (live since 24 Oct) | `595e9107b4faf8e4302b13fedc6211a878561422` (`origin/main`, fetched 30 Oct)   |
| v1.1.0 code                | `feature/flexible-employee-shifts` = `8d92bba`, 9 commits ahead of `595e910` |
| Production database        | at 041 (to confirm in step 4)                                                |
| Preflight                  | `supabase/check-release-1.1.0.sql`: one read-only SELECT                     |
| Worker process (PM2)       | `crm-production-jobs`, run as `crm-prod`                                     |

**Rules:**

- Order: database first, then code.
- Updates are applied in order and never re-applied out of order.
- The database is never rolled back.
- Never run two background workers at once.
- Checkout rules stay off.
- Do not set shift timings during the release, because employees would be notified.

## 1. Tag v1.0.0

1. Confirm the live SHA (read-only): `curl -sI https://hdmarketing.tech | grep -i x-release-sha` must show `595e910…`.
2. Tag and push the tag. Pushing a tag runs CI only, never a deployment.

   ```sh
   git tag -a v1.0.0 595e9107b4faf8e4302b13fedc6211a878561422 -m "HD Marketing CRM v1.0.0 (production since 24 Oct 2026)"
   git push origin v1.0.0
   ```

## 2. Pull request and CI (nothing deploys)

1. Push `feature/flexible-employee-shifts` and open a PR into `main`.
2. Wait until the CI check `validate` is green. It covers tests, build, deployment checks and `npm audit`.
3. Merge with a merge commit, as for PRs #4–#6.
4. Wait for CI on `main` to pass.
5. Record the **full** new `main` SHA (`<V11>`).

## 3. Worker handover: old Mac → VPS, never two at once

1. **Stop the old copy.** On admin Tayyab's Mac, stop the CRM copy (`npm run dev`) that runs against production. Confirm `pgrep -fl "server/src"` prints nothing. From now on Tayyab uses https://hdmarketing.tech.
2. **Confirm no worker is running.** Run the preflight twice, at least 2 minutes apart. `seconds_since_last_job_run` must be above 120 and growing.
3. **Start the VPS worker** on the active release, as `crm-prod`:

   ```sh
   cd /srv/hd-crm/production
   read -r slot sha < active
   bash "releases/$sha/deploy/production/worker.sh" production "$sha"
   pm2 ls   # exactly one crm-production-jobs, online
   ```

4. Within about 65 seconds, **System status** shows fresh job heartbeats, and `seconds_since_last_job_run` drops below 70.

## 4. Backup, restore check and preflight

Choose a quiet time (evening PKT). Keep the Mac awake with `caffeinate -dims` running in a terminal.

1. **Back up.** Run `launchctl kickstart gui/$(id -u)/com.hdmarketing.crm-backup`. Then `tail -n 20 ~/.hd-crm/backup.log` must show today's lines "Encrypted database backup recorded" and "Encrypted file backup saved".
2. **Check the restore** (on this Mac, as on 24 Oct):
   - decrypt the new dump and restore it into a throwaway local PostgreSQL 17 cluster with 0 errors;
   - the table row counts must equal the preflight counts;
   - `tar -tf` of the file archive must list `stored_files` files;
   - delete the decrypted copies afterwards.

   For a full recovery, see `deploy/restore.md`.

3. **Run the preflight** in the Supabase SQL Editor and save the result. Required:
   - `release_stage` = `at 041, ready for 042`;
   - every `*_must_be_0` = 0;
   - `transactions_open_over_1_min` = 0.

   **Stop if any differs.**

## 5. Apply 042 → 048 (Supabase SQL Editor)

For each file, in order:

1. Open a new query and paste the **whole** file.
2. For **042 only**, put `set lock_timeout = '5s';` on the first line; 042 has no lock timeout of its own.
3. Run it, then run the preflight.

After each file:

- `update_04x_installed` must be true;
- `release_stage` names the next update;
- the counts must not drop. They may grow slightly through normal use.

| File                                   | Notes                                              |
| -------------------------------------- | -------------------------------------------------- |
| `042_attendance_admin_entries.sql`     | Add the lock timeout line first                    |
| `043_audit_history.sql`                |                                                    |
| `044_admin_property_promotion.sql`     |                                                    |
| `045_daily_task_management.sql`        | `checkout_rules_off` must be `true` afterwards     |
| `046_building_property_categories.sql` |                                                    |
| `047_staff_management.sql`             | Briefly locks profiles and tasks                   |
| `048_flexible_employee_shifts.sql`     | `release_stage` = `at 048, release database ready` |

- **If a file fails:** each file is one transaction, so on any error (including a lock timeout) nothing from that file is applied.
  - Do not edit the file. Report the message, then run that same file again later.
  - The live v1.0 API keeps working at every stage: its schema tests pass on 001–048.
- **Afterwards:** `browser_executable_new_functions_must_be_0` must be 0.

## 6. Deploy v1.1.0 (blue/green)

1. **Stop the worker gracefully.** As `crm-prod`, run `pm2 stop crm-production-jobs`; it finishes its current job first. The v1.0 worker must not run once property promotion is live (finding H1).
2. **Start the Production workflow.** Actions → Production → Run workflow on `main` with `sha` = `<V11>`. Approve it in the `production` environment.
3. **Watch the run:** build → package → SSH check → upload → the new release starts on the idle slot → health check → traffic switch → public probe. On a failed health check or switch, traffic stays on, or returns to, v1.0 automatically.
4. **Restart the worker** on the new release with the commands from step 3.3. `active` now holds `<V11>`, and `pm2 ls` must show exactly one `crm-production-jobs`.

## 7. Smoke test (about 15 minutes), then tag v1.1.0

1. `curl -sI https://hdmarketing.tech | grep -i x-release-sha` shows `<V11>`.
2. **Admin:**
   - sign in;
   - Attendance management → **Shift management** shows four views, and Role timings shows the company default;
   - Employee management lists every account with its office timing;
   - Audit history loads;
   - System status shows fresh heartbeats and backups.
3. **Existing agent:**
   - sign in;
   - leads load, with phone numbers masked;
   - Attendance shows "Schedule: Company default";
   - check-in works.
4. **Staff restrictions** (optional; creates one account):
   - in Accounts, create a staff account;
   - sign in through **Staff Login**: the menu shows only the staff workspace, and opening `/leads` is refused;
   - disable the account afterwards.
5. **Final preflight:** `at 048, release database ready`, all `*_must_be_0` = 0, `checkout_rules_off` = true, and the counts match step 4, apart from normal use.
6. **Tag:** `git tag -a v1.1.0 <V11> -m "HD Marketing CRM v1.1.0"`, then `git push origin v1.1.0`.

## 8. Rollback (application only)

The database stays at 048, and v1.0 runs on it. v1.0's schema tests pass 640/641 on 001–048; the only difference is an extra `staff` count that the v1.0 screens ignore.

1. **Disable every staff account first.** v1.0 has no staff restrictions and masks phone numbers only for agents. The preflight's `active_staff_must_be_0_before_rollback` must be 0.
2. **Stop the worker:** `pm2 stop crm-production-jobs`.
3. **Switch back** to the previous release, as `crm-prod`:

   ```sh
   cd /srv/hd-crm/production
   read -r current_slot current_sha < active
   bash "releases/$current_sha/deploy/production/release.sh" rollback production
   ```

4. **Restart the worker** with step 3.3. It starts on the rolled-back active SHA.
5. **Never restore a backup over production for an application problem.** A data recovery is a separate, approved procedure (`deploy/restore.md`) and loses every change made after the backup.
