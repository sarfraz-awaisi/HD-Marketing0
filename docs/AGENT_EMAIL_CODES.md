> **Current new-account workflow:** update **035 after 034** verifies an independent email challenge before creating Auth users. Follow [ACCOUNT_CREATION_OTP.md](ACCOUNT_CREATION_OTP.md). The native-code setup below is retained only for historical pending users from 033/034.

# Account email codes in Accounts

New Agent **and Admin** accounts use the same flow: an existing PIN-unlocked administrator requests a code, enters the code received in the new account's inbox, and sets the initial password in Accounts. The new account stays pending and cannot sign in until verification and audited password setup finish. Supabase needs a pending Auth user to issue its native code; that pending record does not grant CRM access.

## What can be free

Supabase's default hosted sender cannot deliver this flow to arbitrary team inboxes. Its default SMTP service sends only to Supabase project-team members and currently permits two emails per hour. Adding CRM users to the Supabase organization is not a workaround: CRM membership must not grant database/dashboard access.

Since 3 June 2026, newer free projects using the default sender cannot customize authentication templates. Their default confirmation email contains a link, so the CRM cannot make it display a numeric code by changing SQL or frontend code. Enabling custom SMTP permits template customization on the Supabase Free plan. Sources: [default sender restrictions](https://supabase.com/docs/guides/auth/auth-smtp), [free-project template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

A paid SMTP subscription or purchased domain is not necessary for small-volume testing with an eligible Gmail sender. Configure that Gmail account as Supabase's SMTP sender using an app password. Google account eligibility, sending limits and delivery controls still apply. This is a free sender setup, not unlimited built-in Supabase delivery. No subscription, credit-card signup, sender account, Google security setting or hosted configuration has been created or changed by this local implementation.

## Set up a Gmail sender

1. Use a Gmail inbox controlled by the CRM administrator, preferably a dedicated sender inbox.
2. Enable **2-Step Verification** on that Google account. This setting protects the sender account; it does not add a two-factor step to CRM login.
3. Open [Google App Passwords](https://myaccount.google.com/apppasswords), create an app password named **HD Marketing**, and enter it directly in Supabase's SMTP password field. Never use the ordinary Gmail login password or send either password in chat. Some managed/Advanced Protection accounts cannot create app passwords; [Google explains eligibility](https://support.google.com/accounts/answer/185833?hl=en).
4. In Supabase **Authentication → Emails → SMTP Settings**, enable custom SMTP and enter:

| Supabase field | Value                                 |
| -------------- | ------------------------------------- |
| Sender email   | The Gmail address used for SMTP login |
| Sender name    | HD Marketing                          |
| Host           | `smtp.gmail.com`                      |
| Port           | `587` (TLS/STARTTLS)                  |
| Username       | The full Gmail address                |
| Password       | That account's generated app password |

Save the settings. Supabase still generates and verifies the codes; Gmail only transports the mail. [Google's SMTP settings](https://support.google.com/mail/answer/7104828?hl=en). Do not enable POP or IMAP just to send messages. Google enforces [sending limits](https://support.google.com/mail/answer/22839?hl=en); Supabase also applies its configured email rate limit. If Google rejects this connection, inspect the sender's security alerts and SMTP error; never disable account protections to bypass a rejection.

## Apply the database update manually

Existing databases apply missing migrations in order through **033**, then **034_account_email_codes.sql**. Do not rerun an already installed migration, and do not run the fresh `setup.sql` against existing data. Fresh installations include all 34 updates.

A read-only check in Supabase SQL Editor can distinguish the two updates:

```sql
select
  to_regprocedure('public.agent_email_code_ready(uuid,text,text)') is not null as update_033,
  to_regprocedure('public.account_email_code_ready(uuid,text,text)') is not null as update_034;
```

If 033 is false, copy and run 033 first:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/033_agent_email_codes.sql
```

Then copy 034 in Terminal:

```sh
pbcopy < supabase/migrations/034_account_email_codes.sql
```

Paste each needed **SQL** file into its own new Supabase SQL Editor query and click **Run**. Expected result: **Success. No rows returned**. Earlier migrations remain unchanged. Both roles require 034 before the API provisions another native Auth account.

## Install the two email templates

After saving SMTP settings, Supabase permits editing the hosted templates. These are HTML/Go templates, **not SQL**. Copy from Terminal, paste into the specified email **Body**, and choose **Save**, not SQL Editor's Run.

1. **Authentication → Emails → Templates → Confirm signup**:

```sh
pbcopy < supabase/templates/confirmation-email.html
```

This template renders `{{ .Token }}` for administrator-created CRM accounts and preserves link confirmation for legacy/bootstrap users. New unconfirmed accounts use native signup-confirmation resend; public self-registration can remain disabled.

2. **Magic Link** (sometimes labeled **Magic link or OTP**) template:

```sh
pbcopy < supabase/templates/agent-email-code.html
```

Use a subject such as **HD Marketing verification code**. The historical filename serves both account roles. This code-only template handles resends for already-confirmed pending users. Existing Invite user emails still support older invitations; ordinary password recovery is unchanged.

3. In the Email provider settings, set **Email OTP expiration to 600 seconds**. Set the code length to six digits if that setting is available; the default is six. CRM rejects setup requests after ten minutes regardless of a longer provider expiry.
4. Restart the existing API if it did not reload, then refresh the browser. If the project is stopped, run `npm run dev` from the repository root. Do not launch a second copy on an occupied development port.

On Windows PowerShell, replace `pbcopy < file` with `Get-Content -Raw -Encoding UTF8 .\path\to\file | Set-Clipboard`.

Changing repository HTML, local `supabase/config.toml`, or SQL never installs hosted templates or SMTP credentials. An actual hosted inbox-delivery check remains necessary after manual setup; local tests use isolated synthetic mail responses.

## Accounts workflow

1. Sign in as admin and unlock **Accounts** with your personal PIN.
2. Choose **Create account**, enter the name, Agent/Admin role and inbox address.
3. The **Verify account email** form opens. The native Auth user and CRM profile remain pending/inactive. A successful send request does not itself verify ownership or prove receipt.
4. Ask the account owner for the code from that inbox. Enter it, the initial password and matching confirmation in Accounts, then select **Verify email and save password**. Passwords require at least 12 characters and at most 72 UTF-8 bytes.
5. Only after native email verification, password saving and audited SQL completion can the account use the selected Agent/Admin portal with email/password. Ordinary later logins do not gain a new email-code step. Existing agent authenticator policy and administrator login rules remain unchanged.

Use **Verify email** on a pending code account card or **Verify email code** in Details to reopen the form. **Resend verification code** always uses the stored address; no arbitrary destination is accepted. Wait at least 60 seconds between sends. Five failed code checks require a new request. Native Auth and HTTP limits also apply. Cancelling or expiring verification keeps access blocked. A previously selected disabled-after-setup state survives resending and completion.

Existing active agents/admins keep their roles and access. Older administrator invitation links can still be completed or cancelled; their legacy resend endpoint remains available. Pending legacy agents can switch to code verification. New accounts of either role do not receive invitation links.

## Security and recovery

Code endpoints require an active admin and current session-bound Accounts PIN grant, checked again inside SQL. Native Auth owns the code; CRM stores only request versions, attempt counts, temporary claims and proof timestamps. Neither codes, passwords, request hashes nor native sessions appear in account reader responses or CRM audit records. Browser database roles cannot run the helper functions.

Update 034 binds verification to the selected account role as well as the stored email. Role changes, email changes, deletion, cancellation, stale requests or concurrent claims cannot activate an account with old proof. Both roles use the same expiry, attempt limits, isolated nonpersistent Auth client and local recipient-session cleanup. Administrator browser/service sessions are never replaced by the recipient session.

Mail or verification failures leave the profile inactive. Native codes are single-use. If native verification succeeded but password saving or final activation failed, request a fresh email code before retrying. Previously recorded proof alone cannot approve another submission, even when a different six-digit value is entered. Final SQL/audit failure rolls back activation even if Auth saved a password. Do not recreate a pending account after an SMTP failure; fix delivery and resend from Accounts. Historically auto-confirmed accounts are not retroactively proven to own their inbox.

Email OTP proves access to the inbox, not employment or Microsoft/Google organizational identity. The owner's cooperation is required; the application never fetches codes from an inbox or displays a delivery code to the administrator.

## API and schema

- POST `/api/accounts` requests a code for either role and returns safe pending-account fields including `role`, `email_code_required`, and `email_code_sent`.
- POST `/api/accounts/:id/email-code` accepts only `{}` and requests a resend.
- POST `/api/accounts/:id/email-code/verify` accepts only `{ code, password }`.

Codes must be exactly six ASCII digits and stay strings to preserve leading zeroes. Wrong, expired, stale and already-used codes cannot complete setup. All earlier authorization, account deletion, handover, PIN and optional-agent MFA protections are preserved. Internal `agent_email_code_*` function names from 033 remain for compatibility; update 034 extends their checked behavior to both roles and adds the version preflight `account_email_code_ready`.

Native references: [email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp), [confirmation resend implementation](https://github.com/supabase/auth/blob/master/internal/api/resend.go), [unconfirmed passwordless behavior](https://github.com/supabase/auth/blob/master/internal/api/magic_link.go).
