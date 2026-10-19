# Login security: lockout, inactivity sign-out and login history

Added 17 October 2026 (roadmap F21, F22 and F24). Apply database update **037 after 036**, then restart the CRM.

## What it does

- **Account lockout.** Sign-in now goes through the CRM server, which checks the password with Supabase. After **5 wrong passwords within 15 minutes** for the same email, that email is locked for **15 minutes**. Even the correct password is refused until the lock ends. Wrong-password and locked attempts show the same message, so nobody can tell whether an account exists or is locked. Each lockout of a real account creates a **Sign-in locked after wrong passwords** security alert. A Supabase outage or Supabase's own rate limit is reported as such and does not count against the user.
- **Inactivity sign-out.** After **30 minutes** with no keyboard, mouse, touch or scrolling, the CRM signs out. Five minutes before, **Are you still there?** shows a countdown with **Stay signed in** and **Sign out now**. Activity in any open CRM tab keeps every tab signed in. A laptop that slept past the limit signs out as soon as it wakes. The login page then explains why. Unsaved form changes are lost, which is what the warning is for.
- **Login history.** Admins open **Login history** in the sidebar. It shows every sign-in attempt: time (Pakistan), account with UID, email, Agent/Admin portal, result (Signed in, Wrong password, Locked), IP address and device. Filter by account, result and dates; totals show failed attempts in the last 24 hours and accounts locked now. A successful sign-in outside business hours (default **08:00–21:00 Pakistan time**) creates one **Sign-in outside business hours** alert.

Passwords are never stored or logged. Login history and the lockout counters are reachable only through the admin API; browsers cannot read them directly.

## Install

1. In Supabase **SQL Editor → New query**, run the update:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/migrations/037_login_security.sql
   ```

   Paste and **Run**. Expected: **Success. No rows returned**. It is safe to run again.

2. Restart the CRM (`npm run dev`). Until 037 is installed, sign-in shows that update 037 is required.

## Settings (optional)

Server, in the root `.env`:

| Setting                | Default | Meaning                                                   |
| ---------------------- | ------- | --------------------------------------------------------- |
| `LOGIN_MAX_ATTEMPTS`   | `5`     | Wrong passwords before a lock (1–20)                      |
| `LOGIN_WINDOW_MINUTES` | `15`    | Time window in which wrong passwords are counted (1–1440) |
| `LOGIN_LOCK_MINUTES`   | `15`    | Lock length (1–1440)                                      |
| `LOGIN_BUSINESS_HOURS` | `08-21` | Pakistan hours without after-hours alerts (start-end)     |

Browser, in `client/.env`: `VITE_IDLE_TIMEOUT_MINUTES` (default `30`, 5–480). Restart `npm run dev` after changing it.

## Limits

- Locks expire on their own after the lock period; there is no early-unlock button yet. An admin can see a locked account in Login history.
- The lockout protects the CRM sign-in page. Supabase's public sign-in endpoint is protected separately by its per-IP rate limits and the 12-character password rule. Supabase Pro plans can also enforce session inactivity and time-boxing at the Auth level.
- Sign-ins are checked by the server, so Supabase's own per-IP sign-in limit applies to the server's address. Raise it under **Authentication → Rate Limits** if a large team signs in at the same moment.
