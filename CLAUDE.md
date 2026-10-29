# HD Marketing CRM: rules for Claude

There are two separate environments. **Development is where we build and experiment. Production runs only approved, tested releases.** If a request doesn't say which environment, it means development.

## Production: live at https://hdmarketing.tech

Production is the Hostinger VPS (Nginx, PM2 API) and Supabase Cloud (database, Auth, Storage), with real users and business data.

- During development, keep production live and untouched: its code, database, migrations, data, credentials, services and infrastructure.
- Never stop, restart or change a production service or process (API, background worker, Nginx, PM2) on your own initiative.
- Before **any** production operation, including read-only checks, explain its scope and impact and get the owner's explicit authorization. Approval covers that one operation only.
- Never commit, push, merge, deploy or run the Production workflow without explicit approval. "Done", "working" or "tests passed" is not approval.

## Development: this Mac

Development runs on Docker Desktop with Supabase Local, the local Express API and Vite site, and local test accounts. See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

- Build and test every feature, bug fix, UI change and schema change locally first.
- Apply migrations only to local Supabase. Never use `--linked` or `--db-url`, `supabase link`, `supabase db push` or `supabase config push`.
- Never use production credentials, databases, storage or live integrations (real email, Meta, calling providers) for development. Use local substitutes, mocks or sandboxes; local email goes to Mailpit.
- Never copy real customer data into development without an approved anonymization process.
- Before starting the app, check that `.env` contains `LOCAL_DEV_ONLY=true` and `SUPABASE_URL=http://127.0.0.1:54321`, and that `client/.env` uses the same Supabase URL. If not, stop and ask.
- Preserve the `LOCAL_DEV_ONLY` safeguards in:
  - `server/src/config/runtime.js` and `server/src/config/supabaseAdmin.js`;
  - `server/src/jobs/runner.js`;
  - `client/vite.config.js`;
  - `scripts/setup-dev.js` and `scripts/verify-live.js`.
  
  Never weaken or bypass them, and extend them whenever a new external service is added.
- Local background jobs stay off unless `RUN_LOCAL_JOBS=true`, and then they run only against local Supabase.

## Production background jobs and backups

Both are production operations, kept separate from development.

- Production jobs must eventually run in exactly one controlled place, but the existing worker stays untouched until the owner separately approves its migration. Never start, stop or replace a production worker without that approval.
- The scheduled encrypted backups (LaunchAgent `com.hdmarketing.crm-backup`, settings in `~/.hd-crm`) read production by design. Never change them, pause them, or reuse their settings for development.

## Workflow

**Feature or fix:**
1. Inspect the existing code.
2. Explain the plan.
3. Implement locally on a feature branch.
4. Run `npm test` and `npm run build`, and check for regressions.
5. Show the results.
6. Wait for approval.

**Production release, only when the owner explicitly requests one:**
1. Review the complete change.
2. Verify the tests and migration compatibility.
3. Verify a fresh encrypted backup.
4. Prepare a rollback plan.
5. Confirm readiness and get final approval.
6. Deploy only the approved changes.
7. Monitor and verify production.

## Git and secrets

- Work on feature branches. Never merge into `main`, push, or commit without authorization.
- Never commit `.env`, `client/.env`, `*.production.backup`, passwords, service keys or private keys, and never print secret values.
