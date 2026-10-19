# Visible customer contacts

Updated locally on 13 October 2026. The user's request for automatically visible numbers supersedes P2's masked lists, Show-number control, two-minute expiry and daily display quota.

## Update an existing Supabase project

Apply missing migrations in order: 019 after 018, 020 after 019, then **021_visible_lead_contacts.sql once after 020**. Do not rerun the fresh-install setup bundle on an existing database. From the project terminal on macOS:

```sh
pbcopy < supabase/migrations/021_visible_lead_contacts.sql
```

Open Supabase → SQL Editor → New snippet, paste and Run. **Success. No rows returned** is the expected schema-update result. Refresh the CRM afterwards. The existing app server also needs the current code. No phone data is deleted or rewritten by migration 021.

If this error persists after running 021, the function may be missing in the connected project or the database API may have a stale function cache. The screen suppresses the table and pagination on loading errors so it does not misleadingly claim that no leads exist.

Use the repeatable repair instead of rerunning the numbered migration:

```sh
pbcopy < supabase/repair-visible-lead-contacts.sql
```

Paste the **entire file** into the SQL Editor of the **same Supabase project used by the CRM** and Run. It checks core CRM tables, creates the missing migration-019 phone-read history table with restricted access if needed, creates or replaces the contact function, restores service-only execution and requests the database API's schema refresh with `NOTIFY pgrst, 'reload schema'`. It does not modify customer records, assignments or prior read/audit history. The result should show **phone_history_ready = true**, **phone_function_installed = true** and **server_access_ready = true**, with a repair status. Wait a few seconds and refresh the CRM.

If the script reports missing CRM tables, run the read-only diagnostic before applying another update:

```sql
select
  to_regclass('public.profiles') is not null as profiles,
  to_regclass('public.leads') is not null as leads,
  to_regclass('public.audit_log') is not null as audit_log,
  to_regclass('crm_private.lead_phones') is not null as lead_phones,
  to_regclass('crm_private.phone_reveals') is not null as phone_reveals;
```

This query is also saved as `supabase/check-visible-lead-contacts.sql`. It returns only true/false schema-presence flags. Core tables are created by the earlier CRM migrations; **phone_reveals is created by migration 019**. If only that flag is false, the migration-019 history table is missing. The updated contact repair creates that table automatically; copy the repair file again and run the entire updated script. It does not reset existing tables or remove customer records. If core flags are false, verify the selected project and its earlier setup first. An existing contact function does not prove that every table it references exists. The repair names missing core tables in its error rather than only reporting a generic prerequisite failure.

For missing core tables, verify the project and its earlier migrations before running the repair. For only the missing history table, run the updated repair directly. Do not reset the existing database or rerun the fresh-install bundle to resolve this error. If all readiness results are true but the API still reports a missing function, check that the server's SUPABASE_URL points to the project where the repair ran; do not share keys or passwords. A successful SQL result proves the function and grants in that database, not that the API has processed the cache notification.

The cache-refresh command follows [Supabase's official troubleshooting guide](https://supabase.com/docs/guides/troubleshooting/refresh-postgrest-schema).

## Security-alert warning after a partial migration

If the administrator dashboard says **Protected phone numbers and security alerts need database migration 019 after 018**, the security-alert table or RPCs may be missing even when full lead contacts already work. The earlier visible-contact repair restores contact reads and their ledger; it does not install the security-alert readers. A partially installed database can therefore show this separate warning.

Use the repeatable, targeted repair instead of blindly rerunning 019 over existing phone objects:

```sh
pbcopy < supabase/repair-security-alerts.sql
```

Paste the entire file into a new query in the **CRM's Supabase project**, then Run. The result should show **security_alerts_ready, summary_ready, list_ready, review_ready and server_access_ready = true**. The script creates the missing alert table/indexes, creates or replaces the latest summary/list/review functions, restores RLS and service-only grants, and asks PostgREST to reload its schema cache. Wait a few seconds and refresh the CRM.

Existing alerts, reviews, lead data, contact functions, read history and audit entries are preserved. The script does not enable phone-display quotas, hide customer numbers, change MFA policy or mark other migrations as installed. If 022's inactive-owner reporter is already installed, its deduplication index is restored when needed; otherwise the repair leaves that index for numbered migration 022.

The separate **System monitoring needs database update 026 after 025** message still needs the monitoring update described in `docs/DEPLOYMENT.md`. Security-alert repair does not install monitoring. If this repair reports missing core tables, check the selected project and missing migrations first. If readiness flags are all true but the same warning remains, verify that the API connects to this project and reload the database API cache; a local code update does not apply hosted SQL automatically.

## What administrators and agents see

Full phone numbers appear automatically in ordinary lead lists, All my leads, assigned-file lists and customer profiles. No Show/Hide button, daily usage indicator or timed expiry is used. Administrators see contacts for all leads; agents see contacts only for their currently assigned leads. An agent cannot read unassigned leads or another agent's customers. A missing stored number is displayed as **Number unavailable**, rather than inventing a number or substituting a masked contact.

Profile numbers are tap-to-call links. **Log a call** records conversations made from the company phone; the CRM does not itself place or record telephone calls.

The API returns only the requested page's authorized contacts. The UI makes no separate phone request for each row. Full contacts are held in account-scoped React Query memory alongside the authorized lead payload. The CRM does not persist these customer numbers in localStorage or sessionStorage. Authentication session storage is separate. Sign-out, account/role changes and access denial clear workspace query caches. Otherwise unused queries remain in memory until garbage-collected or the page closes. Previously rendered information remains visible until the application receives updated ownership/session information; access is rechecked on subsequent API reads.

## API, SQL and audit

- `GET /api/leads`: the requested, filtered page plus full authorized contact fields.
- `GET /api/leads/:id`: the authorized customer plus full contact.
- `GET /api/leads/:id/phone`: retained single-contact endpoint using the same authorization/audit function; no daily display quota.
- `POST /api/leads/phones`: remains removed and returns 404.
- `lead_contact_phones(p_actor,p_leads,p_request)`: service-only SQL function, 1–100 distinct IDs per call. The API supplies the authenticated actor and page IDs. SQL checks the active profile and locks current lead ownership. Any invalid or unauthorized selection fails the whole call.

Available contacts append to the private read ledger and write `lead.phone_revealed` audit entries in the same transaction. Audit fields contain only identifiers and field names. An audit failure prevents any contacts being returned and rolls the ledger back. Browser `anon` and `authenticated` roles cannot execute this function or read the private vault/ledger directly. Ordinary API rate limits still apply.

Agent JSON free text still masks common international/Pakistan number formats in notes, timelines and import summaries. Structured contact fields are restored only from the authorized SQL result. Numeric amounts, dates and UUIDs are preserved. This pattern matching is not OCR and cannot redact every possible written representation; original document binaries are unchanged.

## Historical P2 compatibility

For projects with migration 019 fully installed, its `reveal_phone`, Pakistan-day usage helpers and Security alerts schema remain installed for compatibility and existing history. The contact repair restores the phone-read history table and current contact function; it does not install the remaining historical P2 features or email-confirmation migration 020, or mark those migrations as fully installed. Other feature upgrades must reconcile any partially installed objects rather than blindly rerunning a numbered file. The current lead UI/API uses migration 021 instead of the historical quota-enforcing function. `PHONE_REVEAL_DAILY_LIMIT` applies only to the retained historical usage-status endpoint; it does not restrict automatic contact display. Normal contact reads do not create quota warning/critical alerts.

Administrators can still read/filter/review existing Security alerts. Reviewing an alert writes a safe atomic audit. There is no current phone-quota settings editor.

## Local verification

Tests use isolated fixture databases, Auth claims and customer records. Check both portals, ordinary/assigned-file lists, full profile contacts, ownership denial, service-only SQL permissions and audit rollback. The hosted project needs the numbered migration before this behavior can be verified there. See `VERIFICATION.md` for recorded results.
