# HD Marketing CRM deployment (P6)

**Legacy Caddy/single-process guide.** For new Hostinger deployments, follow [the Nginx/PM2 blue-green guide](../HD_MARKETING_PRODUCTION_DEPLOYMENT.md). Do not combine these proxy/service setup instructions.

Prepared 14 October 2026 for one Ubuntu 24.04 VPS, Caddy, one PM2 API process, one PM2 jobs process and hosted Supabase. These files are implemented locally. The owner has not prepared a VPS/domain/custom SMTP, so no live deployment, DNS, hosted migration or backup was performed. Administrator login stays email/password under the user's latest request.

## What is needed

Choose a VPS able to run Node rather than shared static/PHP hosting, a domain/subdomain you control and a Supabase project with a suitable backup/availability plan. The original plan suggests 2 CPU/4 GB RAM; actual load/large imports must be measured. Supabase Pro offers seven days of daily database backups; database backups do not include Storage object bytes. Maintain separate encrypted off-site database/object copies and rehearse recovery. [Supabase backup scope and retention](https://supabase.com/docs/guides/platform/backups)

All VPS commands below run on **Ubuntu**, not the Mac terminal. Replace example hostname/IP/repository values before use. Do not send SSH passwords or private keys in chat. Keep SSH access working before enabling a firewall.

## Prepare Ubuntu and software

As the VPS administrator, install security updates, a non-root `crm` deployment account and SSH keys. Allow SSH, 80 and 443 with the server firewall; port 3001 remains loopback-only. Set the VPS timezone to UTC so the cron example runs at the documented Pakistan time.

```sh
sudo apt update
sudo apt upgrade
sudo adduser crm
sudo usermod -aG sudo crm
sudo apt install ca-certificates curl gnupg git rsync age cron xz-utils ufw
sudo timedatectl set-timezone UTC
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo install -d -o crm -g crm -m 755 /srv/hd-crm
sudo install -d -o crm -g crm -m 700 /etc/hd-crm /var/backups/hd-crm
```

Install the latest patched **Node 22 LTS**, at least 22.12, from an official Node distribution or approved package repository. The supplied `deploy/install-node.sh` is for a fresh Ubuntu VPS: review it, install `xz-utils`, then run `sudo /bin/bash /srv/hd-crm/deploy/install-node.sh` after copying this project's deployment files there. It selects x64/arm64, downloads the current official Node 22 archive, checks its official SHA-256 and installs under /usr/local. It does not run on the Mac or install PM2/Caddy. If Node is already managed by your operator, use that supported method instead of overwriting it. A system-wide executable lets PM2/reboot/cron use the same interpreter. The source also tests on Node 24; this guide retains the planned Node 22 target. Check `node --version` and `npm --version` before proceeding. [Node release support](https://nodejs.org/en/about/previous-releases)

Install `pm2` with `sudo npm install -g pm2` after reviewing the selected current release. Install Caddy using its signed official Ubuntu apt repository instructions. Install the PostgreSQL client major matching or newer than the Supabase server (check your project, not an assumed major). The Ubuntu PostgreSQL repository provides versioned `postgresql-client-N` packages; an older pg_dump can refuse a newer server. [Caddy Ubuntu installation](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), [PostgreSQL Ubuntu packages](https://www.postgresql.org/download/linux/ubuntu/)

Log in as `crm` for application tasks. Create the PM2 startup service later using the exact command PM2 prints. Avoid running the API as root.

## Copy the project and configure secrets

If you have a private Git repository, clone its reviewed branch into `/srv/hd-crm` as crm. This local workspace currently has no repository remote; you can instead transfer reviewed source with rsync/SFTP, excluding node_modules, generated dist, private `.env` files and all local customer/backup files. Keep `package-lock.json` and install reproducibly:

```sh
cd /srv/hd-crm
npm ci
cp deploy/server.env.example /etc/hd-crm/server.env
chmod 600 /etc/hd-crm/server.env
```

Edit `/etc/hd-crm/server.env` privately. Do not print/upload its contents. Required production settings:

| Variable                  | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| NODE_ENV                  | production (also enforced by PM2)                                       |
| SUPABASE_URL              | Actual HTTPS project origin                                             |
| SUPABASE_SERVICE_ROLE_KEY | Private service-role/secret key; never a VITE variable                  |
| FRONTEND_URL              | Exact HTTPS CRM origin, e.g. https://crm.yourcompany.com, no path/query |
| PORT                      | 3001 to match Caddy                                                     |
| CALL_PROVIDER             | manual; production rejects mock/unconnected cloud calling               |
| WEBHOOK_SECRET            | Independent stable random secret, at least 32 characters                |
| ACCOUNTS_PIN_PEPPER       | Independent stable private random secret, at least 32 characters        |
| TRUST_PROXY               | loopback for direct Caddy traffic; explicit trusted networks only       |
| REQUIRE_AGENT_MFA         | false by default; admin login is exempt regardless                      |
| JOB_INTERVAL_SECONDS      | 60; allowed 10–240 for a five-minute readiness window                   |

Root `.env.example` lists optional OUTCOME_GRACE_MINUTES=30, RECORDING_RETENTION_DAYS=7 and historical PHONE_REVEAL_DAILY_LIMIT=80. Optional Meta settings: META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID, META_GRAPH_VERSION, META_OAUTH_REDIRECT_URL, META_WEBHOOK_VERIFY_TOKEN, META_TOKEN_ENCRYPTION_KEY and META_ANSWER_RETENTION_DAYS=30. Configure them only after the real app/Pages are ready; use [the Meta guide](META_LEAD_ADS_INTEGRATION.md). DEV_ADMIN_EMAIL/PASSWORD and DEV_AGENT_EMAIL/PASSWORD are development provisioning settings; leave them absent on production.

Optional invitation settings are CRM_INVITATION_TTL_MINUTES (default 60) and CRM_BLOCKED_EMAIL_DOMAINS (comma-separated exact blocked domains). The isolated verify:live acceptance script additionally uses LIVE_OWN_LEAD_ID, LIVE_OTHER_LEAD_ID, public VITE_SUPABASE_ANON_KEY and explicit test-agent credentials; these are not ordinary production server requirements. Backup settings are separated into backup.env: SUPABASE_DB_URL, PGSSLROOTCERT, BACKUP_AGE_RECIPIENT and BACKUP_DIR. CRM_BACKUP_ENV_FILE can select the wrapper's private backup file; retain the documented standard paths unless your operator updates both cron and locking configuration.

Generate secrets locally with a trusted password manager or `openssl rand -hex 32` and enter them privately. Keep encrypted recovery copies outside the VPS. Adding/changing the PIN pepper changes PIN hashing: **each existing admin resets their personal PIN once through Admin settings using their login password**. Existing PIN grants cannot be assumed usable. Never fall back to the service key in production. API and jobs startup both reject missing/short secrets, non-HTTPS origins and mock calling, with messages naming settings but not values.

Create `client/.env` with only public VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (publishable key is supported by the existing client) and VITE_API_URL=/api. Set restrictive file permissions and never put service keys, PIN pepper, webhook/Meta secrets or database URLs in it. Run `npm run build`; Caddy serves only `client/dist`. Page chunks load on demand; stale/missing chunks show a reload action.

## Database update and Auth

Back up your existing database and apply only missing migrations in order. **026_system_monitoring.sql follows 025.** The preserved 025 schema is needed for the numbered 026 prerequisite, but installing it does not re-enable admin MFA. Admin login requires neither update to sign in; the new monitoring card needs 026. Copy on the Mac with `pbcopy < supabase/migrations/026_system_monitoring.sql`, paste SQL into the connected project's SQL Editor and Run once after prerequisites. Never rerun setup.sql on an existing project. `supabase/setup.sql` now bundles 28 migrations for a fresh project only.

In Supabase Auth: disable public signup, enable inbox confirmation, set Site URL to your exact HTTPS CRM origin and allow `/login` plus `/accept-invitation**` callbacks on that origin. Configure native TOTP only if optional-agent MFA is used. Configure custom SMTP and verify the sender domain before real invitations/recovery; SMTP credentials live in Supabase, not client code. P7's dedicated redirect/email-error improvements and actual SMTP delivery acceptance remain pending.

## Start processes and HTTPS

From `/srv/hd-crm` as crm:

```sh
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u crm --hp /home/crm
```

Run the exact sudo command that `pm2 startup` prints, then verify restart after a planned reboot. The ecosystem uses two fork processes, no development watchers, explicit production environment and `/etc/hd-crm/server.env` through Node's env-file argument. `crm-jobs` runs the same entrypoint as npm run jobs, with the explicit production file. Configure PM2/system log rotation so logs cannot fill the disk. [PM2 ecosystem attributes](https://pm2.keymetrics.io/docs/usage/application-declaration/), [startup persistence](https://pm2.keymetrics.io/docs/usage/startup/)

Point the hostname's DNS A/AAAA records to the VPS. Initially use Cloudflare DNS-only mode. Replace `crm.example.com` in deploy/Caddyfile, then:

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy obtains HTTPS for the real hostname. The supplied configuration proxies /api and /health without stripping paths, serves the SPA fallback, compresses content, caches existing hashed assets long-term and prevents index/SPA response caching. Missing chunks return 404. It serves only the build directory, not source/configuration. [Caddy SPA and API pattern](https://caddyserver.com/docs/caddyfile/patterns)

If later enabling the Cloudflare proxy, select **Full (strict)** and keep a valid origin certificate. Before proxying traffic, configure Caddy's trusted proxies with Cloudflare's current published IP ranges, strict right-to-left client-IP parsing and a firewall that accepts origin traffic only from your approved sources. Extend Express TRUST_PROXY only with those exact ranges plus loopback as needed, then test a real request and a forged forwarded chain. Do not set TRUST_PROXY=true or a hop count. The supplied file defaults to direct Caddy; it does not automatically trust Cloudflare headers. [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/), [Caddy proxy trust](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## Encrypted nightly database backups

Generate an age identity on a trusted owner machine: `age-keygen -o owner-backup-key.txt`. Secure the private key offline and record the **public recipient** in `/etc/hd-crm/backup.env`, created from deploy/backup.env.example with mode 0600. The VPS needs only the public recipient, not the decryption identity. [age streaming encryption](https://github.com/FiloSottile/age)

Use Supabase's direct or session connection, not transaction pooler port 6543. Prefer sslmode=verify-full with the project's trusted CA saved at PGSSLROOTCERT. Percent-encode special password characters in SUPABASE_DB_URL; never put it in shell arguments/history. The helper passes credentials only in child process environment and suppresses raw tool errors. [Supabase connection choice](https://supabase.com/docs/guides/database/connecting-to-postgres)

Run `/bin/bash /srv/hd-crm/deploy/backup.sh` as crm. It acquires a Linux flock, streams pg_dump directly into age, writes only a private ciphertext partial file, renames after both tools succeed and records safe metadata through record_backup. No plaintext dump is written on the VPS. Success records require nonempty ciphertext/digest; failures exit nonzero and do not silently claim success. Completed valid ciphertext stays available if ledger recording fails; pruning occurs only after a recorded success and only for matching completed regular files older than 30 days. Separate backup connection/configuration is not loaded by the API.

Add deploy/cron.txt to `crontab -e` for the crm user. With the VPS set to UTC, 22:00 runs at 03:00 Pakistan. Protect/rotate backup.log and inspect exit/failure messages. Copy encrypted files to an independent off-site destination and separately back up Storage objects. Off-site transfer/object backups are not automated here because no destination/provider is prepared. Follow [test restore instructions](../deploy/restore.md); run a separate-project rehearsal before launch. Do not treat local command-fixture tests as a real hosted backup/restore.

## Monitor, update and roll back

Admin overview's System status polls once a minute: expected migration, each of eight job outcomes/last run, oldest last completed run and last successful database backup, including failed/stale/missing warnings. Agent overview does not request the status. `/api/health/ready` is authenticated Admin-only and returns 200 only when the database/status function works, expected version 26 is installed and all expected jobs have completed successfully within five minutes. Backup freshness is reported separately; it does not gate readiness. `/health` is public process liveness only, not proof of database/jobs/backups health.

```sh
pm2 status
pm2 logs crm-api --lines 50
pm2 logs crm-jobs --lines 50
sudo journalctl -u caddy --since "1 hour ago"
```

On updates: create and verify a backup first, keep a copy of the previous reviewed code/build, transfer/checkout the new reviewed source, npm ci, build, apply missing numbered migrations once, then `pm2 restart deploy/ecosystem.config.cjs --update-env` and refresh the browser. Recheck both roles, imports/assignment, PIN, documents/photos and readiness. Route chunks should be published with the matching index; retain a previous release if uninterrupted open tabs are required. This directory-based guide permits a short maintenance window; it is not an atomic release orchestrator.

Rollback code/build to the prior compatible release if necessary. Do not run inverse SQL/delete migrations on real data without a reviewed recovery plan. New migration 026 is operational metadata and leaves existing business data intact. A database restore is a separate operator-managed procedure into a safe destination. VPS/domain/SMTP, TLS issuance, live PM2 reboot/cron, real backup restore, Cloudflare client-IP verification and physical devices remain external acceptance work.
