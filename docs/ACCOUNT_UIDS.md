# Gmail-only accounts and six-digit UIDs (update 036)

Updated 17 October 2026. This is the current way to create **Admin and Agent accounts**. It replaces the emailed-code step in [ACCOUNT_CREATION_OTP.md](ACCOUNT_CREATION_OTP.md). Email-code requests started before this update can still be finished or cancelled from **Pending account verification**.

## What changed

- **Gmail only.** New accounts need a valid address ending exactly in `@gmail.com`. Spaces are trimmed and capitals lowercased. Anything else shows: _Only valid @gmail.com email addresses are allowed._ This checks the address format only; it cannot prove that Google has registered the mailbox. Existing accounts with other addresses keep working.
- **Six-digit UID.** Every Admin and Agent has a permanent UID from 100000 to 999999. When creating an account, choose **Auto Generate UID** (default) or **Enter UID Manually**. The Supabase Auth UUID remains the login identity. The UID is a reference number for people, never a password or secret.
- **No email code.** _Create account_ creates the login immediately. The owner signs in with the Gmail address and the password the admin set, using the matching Agent or Admin login.
- **Success popup.** **Account Created Successfully!** shows the name, email, role, UID and status, with **Done**. It appears only after the login and profile are saved. The password is never shown.
- **Accounts page.** Every card and account details show the UID with a copy button. Search also matches UIDs. Filters and account actions are unchanged.
- **My profile.** Anyone signed in can click their name or avatar in the top bar to see Name, Email, Role and Employee UID. The UID cannot be edited there or anywhere else.
- **Team** directory shows a UID column.

## How creation works

1. Only an active admin with a current Accounts PIN unlock can create accounts or check UID availability. Agents are refused.
2. The server checks every field. The database then reserves the email and UID, refusing any already used or being created at that moment.
3. The server creates the Supabase login with the service-role key. That key never reaches the browser, and the admin's own session is not touched.
4. In the same database transaction, the profile is created with its UID, name and role. If the profile cannot be saved, Supabase discards the login too, so the two never disagree.
5. Access is switched on in an audited step. Then the popup appears and the list refreshes.

| If something goes wrong                         | What happens                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bad email, bad UID, or email/UID already used   | Error on that field; nothing is created                                                                |
| Supabase refuses the login                      | Nothing is saved; the UID and email can be used again                                                  |
| Network timeout after the login was created     | Detected automatically; creation finishes normally                                                     |
| Result cannot be confirmed                      | You are asked to refresh Accounts; the reservation clears itself after five minutes if no login exists |
| Login saved but access could not be switched on | The account appears **disabled** with its UID and role; choose **Enable**                              |

**Automatic UIDs** use PostgreSQL's cryptographic random generator, and every six-digit value is equally likely. A value already in use is redrawn, up to 200 times. **Manual UIDs** are never replaced with a random one. A database `UNIQUE` constraint is the final guarantee, so two simultaneous requests for the same UID or email give exactly one account. A database trigger blocks any later change to a UID.

## Supabase setup (one time)

Do not run `supabase/setup.sql`; that file is only for brand-new projects.

1. **Open the right project.** In the [Supabase dashboard](https://supabase.com/dashboard), open the project whose URL matches `SUPABASE_URL` in your Vercel environment variables (**Project Settings → API**). Back it up first (**Database → Backups**).
2. **Open SQL Editor.** Left sidebar → **SQL Editor** → **New query**.
3. **Check prerequisites.** On your Mac:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/check-account-uids.sql
   ```

   Paste and **Run**. `update_035_installed` must be **true**. If it is false, install the missing numbered migrations in order first (step 1 of [ACCOUNT_CREATION_OTP.md](ACCOUNT_CREATION_OTP.md)).

4. **Run the update.** In a new query:

   ```sh
   pbcopy < supabase/migrations/036_account_uids.sql
   ```

   Paste and **Run**. Expected: **Success. No rows returned.** If anything fails, nothing is changed. Running it again is safe and never changes a valid UID.

5. **Verify the column and UNIQUE constraint.** Run `check-account-uids.sql` again; every column should be **true**. To see the constraints:

   ```sql
   select conname, pg_get_constraintdef(oid) as definition
   from pg_constraint
   where conrelid = 'public.profiles'::regclass and conname like 'profiles_uid%'
   order by conname;
   ```

   Expect `profiles_uid_key` = `UNIQUE (uid)` and `profiles_uid_range` = `CHECK (uid between 100000 and 999999)`. Some PostgreSQL versions also list `NOT NULL uid`.

6. **Check existing accounts.**

   ```sql
   select u.email, p.name, p.role, p.active, p.uid
   from public.profiles p join auth.users u on u.id = p.id
   where p.deleted_at is null
   order by p.created_at;
   ```

   Each account keeps its email, name, role and access, and now has a UID. Passwords, PINs and lead assignments are untouched.

7. **Confirm UIDs are saved and unique.**

   ```sql
   select count(*) as accounts, count(uid) as with_uid,
          count(distinct uid) as distinct_uids,
          count(*) filter (where uid not between 100000 and 999999) as out_of_range
   from public.profiles;
   ```

   `accounts`, `with_uid` and `distinct_uids` must match, and `out_of_range` must be 0. Deleted accounts keep their UID, so it is never reused.

8. **Review replaced values (normally empty).** These rows appear only if a `uid` column existed before this update with invalid or duplicate values. In that case the earliest account kept a shared value, and the replacements are listed here:

   ```sql
   select profile_id, previous_value, reason, assigned_uid, recorded_at
   from crm_private.account_uid_review order by recorded_at;
   ```

9. **RLS policies.** No changes needed. Browsers still have no direct table access, the new `account_provisioning` table has RLS enabled with server-only access, and existing protections are unchanged.
10. **Vercel environment variables.** Nothing new to add. `ACCOUNT_OTP_SECRET` and the `ACCOUNT_EMAIL_*`, `ACCOUNT_SMTP_*` and `RESEND_API_KEY` settings are no longer needed for new accounts. Keep them only while **Pending account verification** still lists earlier requests you want to finish.
11. **Redeploy.** Yes, after step 4. Use **Vercel → Deployments → Redeploy**, or push the code to your connected branch. Sign-in keeps working even if the code arrives before the database update, but account creation will say update 036 is required.
12. **Test it.** Unlock Accounts and create a test Agent with a Gmail address you control and **Auto Generate UID**. Check the popup, then search for its UID. Sign in as that agent in a private window and compare the UID in **My profile**. Next, try a manual UID that is already used; it must be refused. Delete the test account afterwards.

## API reference

| Endpoint                                        | Behavior                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/accounts`                            | Admin + PIN. `{name,email,password,role,active?,uid_mode:"auto"\|"manual",uid?}` → **201** `{id,uid,name,email,role,active,account_status}` |
| `GET /api/accounts/uid-availability?uid=583214` | Admin + PIN. `{uid,available}`; creation checks again                                                                                       |
| `GET /api/accounts`, `GET /api/accounts/:id`    | Include `uid`; `search` also matches UIDs                                                                                                   |
| `GET /api/me`                                   | Includes the signed-in user's `uid` and `email`                                                                                             |
| `GET /api/users`                                | Team directory includes `uid`                                                                                                               |

Error codes: `ACCOUNTS_INVALID_EMAIL`, `ACCOUNTS_INVALID_UID`, `ACCOUNTS_EMAIL_EXISTS`, `ACCOUNTS_UID_TAKEN`, `ACCOUNTS_CREATE_INCOMPLETE` and `ACCOUNTS_MIGRATION_REQUIRED`.

## Limitations

- The Gmail check cannot confirm the mailbox exists, and no email is sent. Double-check addresses; a mistyped account can be deleted and created again.
- UIDs are permanent. If a wrong manual UID is used, delete the account (that UID stays retired) and create it again.
- Automated tests run the real SQL in an embedded single-connection database. Real simultaneous connections are protected by database locks and constraints, but live Supabase/Vercel behavior still needs the test in step 12.
- Request rate limits are counted per Vercel instance; the database constraints are the lasting protection.
