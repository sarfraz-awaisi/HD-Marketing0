> **Current new-account setup:** [Independent pre-creation OTP, update 035](ACCOUNT_CREATION_OTP.md). New challenges use application-server sender settings, not Supabase Auth mail templates. Existing login/recovery and historical native pending users retain their previous configuration.

# Email confirmation and account invitations

Current new Agent and Admin accounts use an email OTP entered by an existing admin in Accounts, followed by initial password setup. Apply update 034 after 033 and install the two hosted templates after configuring an SMTP sender. Supabase’s default free sender has recipient and template restrictions; [account codes and free Gmail setup](AGENT_EMAIL_CODES.md) explains a small-volume option without a paid subscription. Link confirmation below describes legacy/bootstrap flows and older administrator invitations.

Migration **023**, after 022, replaces initial admin-chosen passwords with tracked invitations and recipient-owned password setup. Read [the current authentication implementation and installation guide](../CRM_Authentication_Email_Verification_Implementation.md) before upgrading. It contains the original-flow audit, exact lifecycle, API/SQL authorization, SMTP/redirect/template settings, expiry/cancellation/resend rules, legacy-account behavior and test limits.

Admins create accounts with name, email and role. A native verified inbox session, a current unexpired invitation ticket and password setup are necessary before an invited profile becomes active. Email send success alone grants nothing. Existing verified accounts retain access; existing unconfirmed profiles are made inactive and require verification followed by explicit admin activation or completion of a tracked invitation.

The following migration-020 notes describe the **legacy confirmation flow**, retained for older accounts. They do not describe new invitation-based account creation. No hosted email delivery has been verified here.

---

# Account email confirmation

Implemented locally on 13 October 2026. The owner must follow an email confirmation link before a new Agent or Admin can access the CRM. This verifies control of the inbox. It does not look up whether arbitrary addresses exist, restrict the domain to Google/Microsoft, or require Google/Microsoft OAuth.

## Installation and email delivery

1. Apply missing CRM migrations in order. **020_account_email_confirmation.sql** follows **019** and extends protected account audit actions. Existing records are preserved; the migration does not confirm or unconfirm Auth users. Do not rerun the fresh-install setup bundle over an existing project.
2. In Supabase Authentication, enable the Email provider and **Confirm email**. Keep public signup disabled; administrators still provision accounts.
3. Configure an authorized SMTP sender for reliable delivery to your team. Supabase's default service has testing restrictions/rate limits; accepting a send request does not prove receipt. Custom SMTP has not yet been prepared in this project.
4. Set the server `FRONTEND_URL` to the actual CRM address. HTTPS and an explicit value are required for production confirmation links. Local development can use `http://localhost:5173`.
5. In Supabase Auth URL configuration, set Site URL and allow the exact `<FRONTEND_URL>/login` redirect. The email template should use Supabase's confirmation URL, not a plain link to the homepage. Do not put secret keys or SMTP passwords in the browser configuration or chat.
6. Restart the API and refresh the CRM. Create an isolated test account; confirm real inbox receipt, click the link, and verify the correct portal and disabled-account behavior before rollout. No hosted mail was sent during automated verification.

On macOS, from the project directory:

```sh
pbcopy < supabase/migrations/020_account_email_confirmation.sql
```

Paste into Supabase SQL Editor and run once after 019. `Success. No rows returned` is normal. The combined setup bundle now includes 23 migrations and is only for a fresh database.

## Administrator workflow

Unlock **Accounts** with your personal PIN and create an account with its name, role, access preference, email and initial password. Auth creation uses **email_confirm=false**. Provisioning temporarily bans Auth and stages an inactive profile, saves the intended role, removes the temporary Auth ban and applies the CRM access preference. Both an active profile and a confirmed email are necessary for CRM access.

The server asks Supabase to send a signup confirmation link. The card shows **Pending email confirmation** for an enabled but unconfirmed account. A disabled profile remains **Disabled**, with its unconfirmed email shown in Details. Initial passwords are still supplied privately; email confirmation does not replace the CRM password.

In **Details**, use **Resend confirmation email** for an unconfirmed account. The address is read from Auth on the server; callers cannot change the recipient or redirect through the resend API. Requests require the active Admin role and current PIN grant, and have rate limits. The UI guards repeat clicks and dismissal while sending. It does not mark the address confirmed just because the send request succeeded.

If SMTP, provider restrictions or a rate limit prevents sending, the account remains pending and the error explains how to retry. Do not create it again; inspect Accounts and resend after fixing email delivery. If provisioning itself was interrupted, review the saved role/access first; an unfinished account stays inactive. A confirmed email alone never enables a disabled CRM profile.

## Owner workflow

Open the Supabase confirmation link from your inbox, checking spam if necessary. Supabase consumes and validates the token and records `email_confirmed_at`; the CRM then authorizes the account's current profile. The existing Auth callback/session handling opens the authorized workspace when confirmation succeeds. Otherwise return to the login screen, choose the assigned Agent/Admin portal and enter the registered email/password. An expired, already-used or invalid link does not authorize access; ask the admin to resend.

The API checks the trusted user returned by `auth.getUser(token)` on **every CRM route**, including `/api/me`. Without `email_confirmed_at`, it returns HTTP 403 with `EMAIL_CONFIRMATION_REQUIRED`. It never trusts `user_metadata.email_verified`, a client timestamp, a password change or an Accounts Active toggle as confirmation. Incorrect-portal or unconfirmed password sessions are rejected before candidate tokens are installed in the main browser session.

## Existing accounts and verification limits

Previous Accounts versions used email_confirm=true. Those existing Supabase timestamps indicate administrative confirmation; they are not historical evidence that the owner clicked an inbox link. This update does not silently invalidate existing accounts or fabricate proof for them. Supabase's signup-resend operation does not re-confirm an already-confirmed address. Re-verifying historical accounts needs a separate mailbox challenge/reverification rollout; do not claim all prior users have now proven ownership.

Addresses may still be entered incorrectly and remain as pending registrations. An account cannot use that unconfirmed address for CRM access. Delivery acceptance, a Gmail/Outlook domain suffix, and syntactic email validation do not prove an inbox exists or is owned by the intended person; successful confirmation is the ownership step. Supabase project administrators/service-key holders remain trusted authorities outside this CRM UI.

## API and audit

- `POST /api/accounts`: creates an unconfirmed Auth account and requests confirmation after provisioning. HTTP 201 includes `email_confirmation_required` and `verification_sent`; a send failure is a warning on the created account, not permission to retry account creation.
- `POST /api/accounts/:id/verification` with an empty JSON object: admin plus PIN grant; sends to the trusted registered email or reports `already_confirmed`. Email/redirect/confirmation-status overrides are refused.
- `GET /api/accounts` and `/api/accounts/:id`: existing trusted email confirmation timestamp powers status/details; no new profile schema field is needed.
- CRM API authentication: unconfirmed users receive 403 `EMAIL_CONFIRMATION_REQUIRED`, even if Supabase issued a token.

Migration 020 extends service-only `account_action` with `email_confirmation_requested`, `email_confirmation_sent` and `email_confirmation_failed`. PIN/active-role checks and request-linked audit insertion run in SQL. Metadata does not include email, password, link or token. Intent is saved before sending. Auth mail delivery and SQL audit cannot be one transaction: if mail is accepted but completion auditing fails, a warning asks the admin to inspect the account before retrying. The app never creates or returns its own verification token.

Official implementation references: [Supabase resend confirmation](https://supabase.com/docs/reference/javascript/auth-resend), [password/email confirmation flow](https://supabase.com/docs/guides/auth/passwords), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). See `VERIFICATION.md` for local test evidence and remaining hosted acceptance.
