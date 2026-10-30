# Local development

The whole CRM runs on this Mac: a local Supabase in Docker (database, sign-in, file storage, email catcher), the Express API and the Vite website. Nothing here reaches https://hdmarketing.tech or the production Supabase project.

| Service                                  | Address                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| CRM website                              | http://localhost:5173                                         |
| API                                      | http://127.0.0.1:3001 (the website reaches it through `/api`) |
| Supabase API                             | http://127.0.0.1:54321                                        |
| Supabase Studio (local database browser) | http://127.0.0.1:54323                                        |
| Mailpit (every email sent locally)       | http://127.0.0.1:54324                                        |
| PostgreSQL                               | 127.0.0.1:54322                                               |

Run every command from the project folder:

```bash
cd "/Users/macbookpro/Desktop/HD-Marketing/HD marketing/hd-marketing-crm"
```

## Start

1. **Docker:** `open -a Docker`, then wait until `docker info` answers without an error.
2. **Supabase:** `npx supabase@2.122.0 start`. It reports `imgproxy` and `pooler` as stopped; the CRM uses neither.
3. **API** (terminal 1): `npm run dev -w server`. Check http://127.0.0.1:3001/ready shows `"status":"ready"`.
4. **Website** (terminal 2): `npm run dev -w client`, then open **http://localhost:5173**. Use `localhost`, not `127.0.0.1`, so that links in local emails return to the same browser session.

`npm run dev` also works. It starts the API, the website and a jobs stream that stays idle (see Background jobs).

## Sign in

| Portal | Email                 | Password                       |
| ------ | --------------------- | ------------------------------ |
| Admin  | `admin@hd-local.test` | `DEV_ADMIN_PASSWORD` in `.env` |
| Agent  | `agent@hd-local.test` | `DEV_AGENT_PASSWORD` in `.env` |

Create more accounts on the Accounts page. It requires `@gmail.com` addresses. Any made-up Gmail address works, because no email leaves this Mac.

## Email

Supabase Auth sends every email locally to **Mailpit** (http://127.0.0.1:54324): verification links and codes, invitations and password resets. Open a message there and use its link or code.

The older account-code sender (`ACCOUNT_EMAIL_PROVIDER`), used only for requests started before update 036, stays disabled locally.

## Stop

Press Ctrl+C in each terminal, then run `npx supabase@2.122.0 stop`. Local data is kept for next time. You can quit Docker Desktop afterwards.

## Back up local data

Back up before anything that changes many rows or the schema. Backups contain only local test data, including the test accounts' password hashes. They go to `~/HD-CRM-Local-Backups`, outside the project. Never use the production backup folder (`~/HD-CRM-Backups`) or production settings for local backups.

```bash
mkdir -p ~/HD-CRM-Local-Backups && chmod 700 ~/HD-CRM-Local-Backups
F=~/HD-CRM-Local-Backups/hd-crm-local-$(date +%Y%m%d-%H%M).dump
docker exec supabase_db_hd-marketing-crm pg_dump -U supabase_admin -d postgres -Fc > "$F" && chmod 600 "$F"
docker exec -i supabase_db_hd-marketing-crm pg_restore --list < "$F" | grep -c "TABLE DATA"   # about 110
```

**Check a backup** by restoring it into a throwaway database next to the real one. Compare a few counts with the real database (for example `public` tables, `auth.users`, `profiles`), then remove the throwaway copy:

```bash
docker exec supabase_db_hd-marketing-crm createdb -U supabase_admin restore_check
docker exec -i supabase_db_hd-marketing-crm pg_restore -U supabase_admin -d restore_check < "$F"
docker exec supabase_db_hd-marketing-crm psql -U supabase_admin -d restore_check -c "select count(*) from auth.users"
docker exec supabase_db_hd-marketing-crm dropdb -U supabase_admin restore_check
```

Restoring a backup over the live local database has **not been tested yet**. Ask before trying it.

## Reset or rebuild local data

`db reset` **wipes the local database**, then re-applies `supabase/migrations`. Automatic sample seeding is disabled. Back up first. Stopping a reset halfway can leave an empty database; if so, follow the rebuild steps below instead.

```bash
npx supabase@2.122.0 db reset
npm run seed:local         # optional sample property; local database only
npm run setup:dev          # recreates the two accounts; open both emails in Mailpit and click the link
docker exec -i supabase_db_hd-marketing-crm psql -U postgres -c "update public.profiles p set active = true from auth.users u where u.id = p.id and u.email in ('admin@hd-local.test','agent@hd-local.test')"
```

**Rebuild an empty local database** (no tables in `public`) without resetting again:

1. If `auth.identities` is missing, run `docker restart supabase_auth_hd-marketing-crm` so Auth creates its tables.
2. `npx supabase@2.122.0 migration up --local` applies every migration.
3. `npm run seed:local` optionally adds the sample property without changing existing records.
4. Recreate the two accounts: the last two commands of the reset steps above.

Never add `--linked` or `--db-url`, and never run `supabase link`, `supabase db push` or `supabase config push`. Those commands act on a hosted project. Production database changes go through the reviewed release process only.

## Local or production?

The local `.env` contains `LOCAL_DEV_ONLY=true` and `SUPABASE_URL=http://127.0.0.1:54321`. To check both settings files:

```bash
grep -E '^(LOCAL_DEV_ONLY|SUPABASE_URL)=' .env
grep -E '^VITE_SUPABASE_URL=' client/.env
grep -c supabase.co .env client/.env   # must print 0 for both files
```

`setup:dev`, `seed:local`, `verify:live` and `send-mock-event.js` require `LOCAL_DEV_ONLY=true` and `http://127.0.0.1:54321`; missing opt-in or a hosted URL stops them before any request.

With `LOCAL_DEV_ONLY=true`, the API, the jobs, `setup:dev`, `verify:live` and the website all refuse to start if any of these is set:

- a Supabase other than the local one;
- `NODE_ENV=production`;
- real email (`smtp` or `resend`);
- Meta settings;
- a calling provider other than `manual` or `mock`.

The error starts with `LOCAL_DEV_ONLY:`. Production behaviour is unchanged: the VPS never sets this flag.

The original production settings are kept in `.env.production.backup` and `client/.env.production.backup`. Never copy them into `.env`. To regenerate the production server settings, pass them explicitly:

```bash
node deploy/production/make-server-env.mjs --domain hdmarketing.tech --from .env.production.backup
```

## Background jobs

Locally, the jobs are **off by default**. `npm run dev` shows `Background jobs are off for local development`.

To run them against the local database, set `RUN_LOCAL_JOBS=true` in `.env` and run `npm run jobs`. Remove it again when you're done. Production jobs run only on the VPS.

## Tests

`npm test` runs the server tests on an in-memory database and the website tests on mocks; neither needs Supabase running. `npm run build` checks the production build.
