# Property inventory: production release runbook

Prepared 22 October 2026 for a **production-only** deployment: the existing Supabase project, the existing GitHub repository and the Hostinger KVM 2 VPS. There is no staging environment. Nothing in this runbook has been run against the hosted database, GitHub or the VPS; every step below needs your go-ahead.

Feature guide: [PROPERTY_INVENTORY.md](PROPERTY_INVENTORY.md). Server guide: [HD_MARKETING_PRODUCTION_DEPLOYMENT.md](../HD_MARKETING_PRODUCTION_DEPLOYMENT.md).

## Verdict: ready with prerequisites

The migration and code are ready. Clear the five blockers below before deploying.

| #   | Blocker                                                                                                                                                                                                                                            | Resolved by                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| B1  | No verified database backup exists. This Mac has no backup set up (`~/.hd-crm` and `~/HD-CRM-Backups` are absent) and no `pg_dump`, `age` or Homebrew. The backup guide was written on a different Mac.                                            | Section 2, steps 2.1–2.5                                      |
| B2  | ~~The Production workflow required a staging run, and a Staging workflow deployed every push.~~ **Resolved 22 October 2026** (section 7); takes effect once committed.                                                                             | Done; included in the commit plan                             |
| B3  | The release is not on GitHub. 57 changed and 45 new files are uncommitted: the inventory module plus the earlier production work (rate limits, graceful restarts, the deploy pipeline itself). The deploy ships all of it, not just the inventory. | Approve a commit and push of the whole working tree           |
| B4  | The VPS state is unknown to me. Is the CRM already live there (which release)? Are `crm-prod`, Nginx, the switch helper, `/etc/hd-crm/production/server.env` and the GitHub `production` environment set up?                                       | Confirm, or complete the production parts of the server guide |
| B5  | GitHub must enforce the approval. The release job stops unless GitHub recorded a `production` approval, which needs required reviewers on the environment. The repository is public since 23 October 2026, so every plan offers this, but on that day GitHub showed no environments and `main` unprotected. | Configure the environment and `main` protection (section 7) |

If a copy was deployed some other way than from GitHub, tell me which code it runs. To see the live release, if any: `curl -sI https://YOUR-CRM-DOMAIN/health | grep -i x-release-sha`.

## Migration safety findings (041)

| Area               | Finding                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Destructive SQL    | None. No table or column is dropped, no row is deleted or updated, nothing is truncated. Existing properties become company inventory with every original value and `updated_at` unchanged (tested).                                                                                                                                                                     |
| Rules replaced     | Two existing checks are replaced by wider ones in the same transaction: status adds `rented`; size units add `sq yd` and `acre`. Every existing value stays valid. If the live table has any other check rule, 041 refuses to run and changes nothing.                                                                                                                   |
| Function replaced  | `delete_property` (013) is replaced with the same signature and the same linked-record, photo-queue and audit behavior. Administrators still delete company properties; agents may now delete their own; administrators cannot delete an agent's property.                                                                                                               |
| New triggers       | On `properties`: owner and creator can never change. On `leads`, `visits` and `deals`: only company properties can be linked. Existing links are all to company properties, so nothing existing is affected.                                                                                                                                                             |
| Locks and duration | One transaction of a few seconds. `properties` and `property_photos` are locked briefly (the properties table is rewritten to add the reference number). Lead, visit and deal **reads continue**; their saves wait a moment. A 5-second lock timeout makes the migration roll back unchanged rather than queue behind a running backup or export; you then run it again. |
| Permissions        | New functions, the owner-contact table and the reference-number sequence are revoked from `public`, `anon` and `authenticated` (Supabase grants browser roles access to new objects by default). Only the API's service role can call the 11 entry functions. Existing grants are untouched.                                                                             |
| Data exposure      | No new exposure found. Owner contacts are in a separate table with RLS and no browser access. Private properties are reachable only through functions that check the signed-in account; another agent's property returns "not found". Audit entries hold field names, never values or phone numbers.                                                                     |
| Prerequisites      | PostgreSQL 14+, and updates 010, 013, 028, 036 and 040. 041 checks each and stops with a clear message, changing nothing, if one is missing.                                                                                                                                                                                                                             |
| Rerun              | Safe: a second run changes nothing (tested).                                                                                                                                                                                                                                                                                                                             |

## Compatibility

- **Current backend with 041 applied: compatible.** The last commit on GitHub (`dc05a9c`) passes its own 755 server tests on migrations 001–041, exactly as on 001–040. A separate test runs that release's own property calls on the 041 schema: create, archive, delete, photo upload and visit linking. **So apply 041 first, then deploy.**
- **New release without 041: not compatible.** Property lists, including the lead, visit and deal property choices, answer "Inventory needs CRM database update 041 after 040." Never deploy the new release before 041 is applied.
- **Open browser tabs from before the deploy:** they can still view properties and archive them. Saving the old add or edit form is refused ("Invalid input") until the page is refreshed. Ask everyone to refresh after the release.
- **Background worker:** unaffected by 041. The photo cleanup queue is unchanged, so the current worker keeps running.
- **Local development:** do not run `npm run dev` from this folder while the root `.env` points at production. It also starts a job runner against production. Before 041 is applied, its property screens show the update-041 message.

## Storage for real property pictures

- 041 changes no Storage setting and needs no new bucket or policy.
- The existing private `property-photos` bucket (from 004) has a 5 MB limit and allows JPEG, PNG and WebP. The API uploads with the server's service-role key, so no browser Storage policy is needed. Browsers only see 60-second signed links, issued after the ownership check.
- Agent pictures go in the same bucket under `<property id>/<random id>`. Uploads are checked for ownership **before** the file reaches Storage. The file's real image signature must match its type. The limit is 20 pictures per property.
- Removed pictures and deleted properties use the existing durable cleanup queue. The API cleans up immediately and the worker retries failures.
- Nginx allows 25 MB request bodies (`site.conf.example`), well above 5 MB.
- **Check your Supabase plan's Storage quota.** The Free plan includes 1 GB. Twenty 5 MB pictures are 100 MB per property.
- The preflight confirms the bucket is private with the expected limits, and that no Storage policy grants browser roles access.

## Admin and agent authorization

Rules: [PROPERTY_INVENTORY.md → Who can do what](PROPERTY_INVENTORY.md#who-can-do-what). The database enforces them for every request; buttons are not the protection.

Tested locally on real PostgreSQL (PGlite), all 41 migrations:

- **`server/tests/inventory.test.js` (17 tests):** cross-agent 404s, read-only company and agent inventories (403), owner spoofing rejected, admin-only directory and agent views, owner-contact sharing, phone masking, statistics scoped per role, picture permissions, and no browser-role access.
- **`server/tests/inventory-migration.test.js` (5 tests):** 041 applied over existing data.
- **`client/tests/inventory.test.jsx` (9 tests).**

Full suites: **server 820/820**, **client 374/374**, production build passes. The deploy checks pass: syntax and credential scan, 9 release and rollback tests, workflow YAML. Live verification is the smoke checklist in section 5.

## 1. Preflight (read-only, any time before the window)

Copy and run the check in **Supabase → SQL Editor → New query**:

```sh
cd "/Users/macbookpro/Desktop/HD-Marketing/HD marketing/hd-marketing-crm"
pbcopy < supabase/check-property-inventory.sql
```

It changes nothing and shows only flags and counts. Expected before 041:

| Column                                                                                 | Expected                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `postgres_14_or_newer`, `update_013/028/036/040_installed`, `properties_touch_trigger` | all `true`                                                                 |
| `properties_checks_as_expected`                                                        | `true` (names: area, area_unit, availability, price checks)                |
| `update_041_installed`                                                                 | `false`                                                                    |
| `properties_outside_rules`                                                             | `0`                                                                        |
| `browser_executable_functions`                                                         | `0`                                                                        |
| `browser_can_read_properties`                                                          | `false`                                                                    |
| `photo_bucket_exists` / `photo_bucket_public`                                          | `true` / `false`                                                           |
| `photo_bucket_size_limit` / `photo_bucket_types`                                       | `5242880` / `{image/jpeg,image/png,image/webp}`                            |
| `storage_browser_policies`                                                             | `0` (anything else: stop and review, someone added browser Storage access) |
| `properties`, `property_photos`, `leads`, `visits`, `deals`                            | write these down; they are compared with the backup and after 041          |

Any other result: stop and send it to me before going further.

## 2. Backup and verify (B1, same day, finish before the window)

**2.1 Supabase dashboard.** Open **Database → Backups** and note whether your plan has daily backups or point-in-time recovery, and the latest backup time. Do not rely on it alone; take your own backup below.

**2.2 Install the tools on this Mac (once).** Homebrew's official installer, then the PostgreSQL client and age:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install libpq age
```

**2.3 Set up the existing encrypted backup tool (once).** This reuses your current credentials and changes none. Follow [BACKUPS.md](BACKUPS.md) steps 2–4 with this Mac's path:

```sh
cd "/Users/macbookpro/Desktop/HD-Marketing/HD marketing/hd-marketing-crm"
node scripts/install-mac-backup.mjs
open -e ~/.hd-crm/backup.env
```

1. Paste the **Session pooler** connection string from Supabase → **Connect** after `SUPABASE_DB_URL=`.
2. Replace `[YOUR-PASSWORD]` and its brackets with the database password, and add `?sslmode=require`.
3. Save the file.
4. Put `~/.hd-crm/backup-key.txt` in your password manager. Without it, no backup can be opened.

**2.4 Take the backup:**

```sh
bash ~/.hd-crm/bin/run-backup.sh
```

Expect `Encrypted database backup recorded` and `Encrypted file backup saved (N files)`.

**2.5 Verify it.** This decrypts into a private folder, confirms the archive is readable, counts rows and pictures, and then deletes the decrypted copy:

```sh
umask 077; mkdir -p ~/hd-backup-check; export PATH="/usr/local/opt/libpq/bin:$PATH"
DB=$(ls -t ~/HD-CRM-Backups/hd-crm-*.dump.age | head -1)
FILES=$(ls -t ~/HD-CRM-Backups/hd-crm-files-*.tar.age | head -1)
ls -lh "$DB" "$FILES"
age --decrypt --identity ~/.hd-crm/backup-key.txt --output ~/hd-backup-check/db.dump "$DB"
pg_restore --list ~/hd-backup-check/db.dump | grep -E "TABLE DATA (public|auth) (properties|property_photos|leads|visits|deals|profiles|users) "
for t in properties property_photos leads visits deals; do
  printf '%-16s %s\n' "$t" "$(pg_restore --data-only --schema=public --table=$t -f - ~/hd-backup-check/db.dump | awk '/^COPY /{c=1;next} /^\\\.$/{c=0;next} c{n++} END{print n+0}')"
done
age --decrypt --identity ~/.hd-crm/backup-key.txt "$FILES" | tar -tf - | grep -c '^\./property-photos/.*[^/]$'
rm -rf ~/hd-backup-check
```

The backup passes when:

- both files are non-empty;
- every listed table appears;
- the five counts equal the preflight counts (allowing for anything users saved in between);
- the picture count is close to `property_photos`. A few extra files are normal (pending cleanup); far fewer means files are missing, so stop.

Copy the two encrypted files somewhere off this Mac, such as a USB drive or cloud folder. They are safe to copy because they're encrypted. Keep the key separately.

## 3. Migration window

Choose a quiet time:

- after the 18:00 shift, or before 10:00 Pakistan time;
- not during the scheduled 21:30 backup;
- with no lead import or export running.

1. Tell users that for about a minute, property and lead saves may pause.
2. Run the preflight again: `transactions_open_over_1_minute` should be `0`.
3. Copy the migration: `pbcopy < supabase/migrations/041_property_inventory.sql`. In **SQL Editor → New query**, paste it and click **Run**. Expect **Success. No rows returned**.
   - "canceling statement due to lock timeout": nothing changed. Wait a minute or two and run it again.
   - Any other error: nothing changed (single transaction). Stop and send me the message.
4. Run the preflight again. Expect:
   - `update_041_installed` = `true`;
   - the five counts unchanged;
   - `agent_owned_properties` = `0`;
   - `inventory_functions` = `17`;
   - `browser_executable_functions` = `0`;
   - `owner_contacts_rls` = `true`.
5. If a release is already live, open **Properties** and a lead form's property choice. Both still work on the current release.

## 4. Application release (after B2–B4)

1. With your approval: commit, push a branch, wait for **CI** to pass, and merge to `main` (CI runs again on the merge commit).
2. If an earlier release left an inactive slot running, retire it first (server guide section 10). The release refuses to overwrite an occupied slot.
3. GitHub → **Actions → Production → Run workflow** on `main` with the merged commit's full SHA.
4. The job:
   - waits for your approval in the `production` environment, and stops without one;
   - re-runs the tests;
   - builds with the production values;
   - starts the new release on the free slot;
   - waits for `/ready`;
   - switches Nginx atomically;
   - probes HTTPS for about a minute.

   On any failure, traffic stays on, or returns to, the current release automatically.

5. Confirm it's live: `curl -sI https://YOUR-CRM-DOMAIN/health | grep -i x-release-sha` shows the new SHA.
6. Ask everyone to refresh their browser.
7. Leave the worker on its current release. This release also changes the job runner (earlier graceful-shutdown work), so after 24 quiet hours update it with `worker.sh` (server guide section 9) and check **System status** heartbeats.

**First deployment to the VPS:** if the CRM is not live there yet, complete the server guide's production steps first. Skip everything about `crm-stage`, staging DNS, a staging certificate and a staging Supabase project. Set Supabase Auth's Site URL and redirect URLs to the production address. With nothing live yet, there is no downtime to manage.

**Expected interruption:** a few seconds during the migration, when property and photo requests and lead, visit and deal saves wait (not fail). None during the switch. Open tabs need a refresh before saving properties.

## 5. Production smoke checklist (within 15 minutes of going live)

Use a real administrator and one or two real agents who know about the test. Name test listings **TEST – delete me** and delete them at the end. These steps create audit entries and pictures; deleted pictures are cleaned up automatically.

**Administrator**

1. The sidebar shows **Inventory**; an old `/properties` link opens it.
2. The summary tiles show numbers, and **Admin properties** lists the existing properties (count = preflight `properties`).
3. Open an older listing: its details and pictures load, it has a `PR-…` reference, and **Edit** shows "Previously recorded as…" for an old type such as "Plot".
4. Add **TEST – delete me** (company):
   - with an owner phone, _not_ shared;
   - with a JPEG and a PNG picture, each under 5 MB.
   - Then use **Make cover** and change the status.
5. In a lead form, the property choices include the test listing. Don't save the lead.
6. **Agent inventories** lists the agents with their emails and counts.

**Agent A**

7. **My properties** is empty; **Admin inventory** shows the test listing with no edit controls and no owner contact.
8. The administrator ticks **Share owner name and phone with agents**. After a refresh, agent A sees the name and phone, but not the notes.
9. Add **TEST – agent – delete me** with a picture. Edit it and set the status to Reserved.

**Agent B** (if available)

10. Agent A's test property appears nowhere: not in My properties, Admin inventory or search.

**Administrator**

11. **Agent inventories → agent A** shows the test property read-only with its owner contact. There are no edit, delete or upload controls.
12. Existing work is unaffected: a lead with a linked property, the site-visits calendar, and the deal property choices.

**Clean up**

13. Agent A deletes their test property; the administrator deletes the company one. **Audit history** shows create, update and delete entries with field names only.
14. Run the preflight again:
    - `agent_owned_properties` = `0`;
    - counts back to the pre-test values;
    - `photo_cleanup_queue` = `0` within a minute or two.
15. **System status:** all job heartbeats are healthy.

Consider announcing **My properties** to agents only after a quiet first day. Until an agent saves a private property, the simple application rollback below stays available.

## 6. Rollback plan

Database rule: **041 is never reversed.** It is additive and the previous release works on it. Removing its columns or tables would destroy agents' private inventories. Application rollback never changes the database.

| Situation                                                                 | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 041 failed or timed out                                                   | Nothing changed (one transaction). Confirm `update_041_installed` = `false`, fix the cause, run again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| New release failed readiness or the cutover checks                        | Automatic: traffic stays on, or returns to, the current release. Inspect the failed release's logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| New release live, problem found, preflight `agent_owned_properties` = `0` | Roll back the application (server guide section 15): `cd /srv/hd-crm/production && read -r s sha < active && bash "releases/$sha/deploy/production/release.sh" rollback production`. This is instant while the previous slot is still running. Leave 041 in place.                                                                                                                                                                                                                                                                                                                                                                              |
| New release live, problem found, `agent_owned_properties` > `0`           | **Do not roll back to the pre-inventory release.** It reads all properties without owner checks, so it would show agents' private listings and pictures to every agent and let administrators edit them. Fix forward with a corrected release through the same pipeline. If the CRM must stop immediately, put the whole site into maintenance (503) with `sudo /usr/local/sbin/hd-crm-switch production 0000000000000000000000000000000000000000 blue`, then fix forward. To leave maintenance, switch back to the healthy release recorded in `/srv/hd-crm/production/active`: `sudo /usr/local/sbin/hd-crm-switch production FULL_SHA SLOT`. |
| Records damaged (not expected)                                            | Stop changes (maintenance mode as above). Recover the affected records from the verified backup with a qualified operator. A Supabase dashboard restore replaces the **entire** database and loses everything saved after that point; use it only as a last resort with your explicit decision. Never re-run `setup.sql`.                                                                                                                                                                                                                                                                                                                       |

Keep the previous release running for at least 24 hours before retiring its slot (server guide section 10). After retirement, an application rollback first needs that process restarted.

## 7. Production-only pipeline (done 22 October 2026, safety checks added 23 October; awaiting your commit approval)

| File                                                                                      | Change                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/staging.yml`                                                           | **Removed.** Nothing deploys on a push any more.                                                                                                                                      |
| `.github/workflows/production.yml`                                                        | Manual start only, from `main`. The commit must be part of `main` and have a successful **CI** run of that exact commit on `main` (instead of a staging run). |
| `.github/workflows/release.yml`                                                           | Always runs in the `production` environment and stops, before any secret is used, unless GitHub recorded an approval for it. Confirms the checkout is the release commit. Tests, build, packaging, upload and the blue/green release are unchanged. |
| `deploy/production/workflow_policy.py` (new), `check.py`                                  | CI and every release fail if a workflow could deploy automatically (push, schedule, chained run) or use secrets or an environment on an automatic trigger, if a check above is missing, or if any workflow refers to staging. |
| `deploy/production/tests/test_workflow_policy.py` (new)                                   | Seven tests.                                                                                                                |
| `HD_MARKETING_PRODUCTION_DEPLOYMENT.md`, `docs/PRODUCTION_FILES.md`, `RATE_LIMITS.md`     | Rewritten for production-only. `PRODUCTION_AUDIT.md` and `PRODUCTION_VERIFICATION.md` are dated records and carry a "production-only" update note.                                    |
| `release.sh`, `remote.sh`, `worker.sh`, `ecosystem.config.cjs`, `health.mjs`, `switch.py` | **Unchanged**, so health checks, blue/green switching and automatic rollback stay exactly as tested. Their staging branches are unreachable now that only `production` is passed.     |
| `staging-smoke.mjs`, `staging.env.example`                                                | Unused; kept until a separately reviewed cleanup.                                                                                                                                     |

In GitHub, create only the **production** environment, with deployment branches limited to `main` and the existing deployment values as *environment* secrets and variables, not repository ones (`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, `DEPLOY_USER=crm-prod`, `FRONTEND_ORIGIN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); no credential changes. Add yourself as required reviewer. As the only maintainer, allow self-review, otherwise no release can be approved. Protect `main` with the **CI / validate** status check. If the repository is made private again on a plan without required reviewers, the Production workflow cannot deploy: decide how to proceed rather than removing the check. As the repository is public, also enable secret scanning with push protection and require approval for workflow runs from outside contributors.

## 8. After the release

- Keep the previous slot running for 24 hours, then retire it.
- Update the worker with `worker.sh` and check heartbeats.
- Install the nightly backup on the VPS once it runs the CRM (server guide section 13). Until then, the Mac's 21:30 backup only runs while the Mac is on.
- Record the release SHA, the migration time and the preflight results in `VERIFICATION.md`.
