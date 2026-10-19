# Agent handover and Client KYC access

Updated 14 October 2026. These changes are implemented and tested locally. The hosted Supabase database has **not** been updated by this work.

## Disabling an agent safely

An administrator can now disable an agent and hand over all their clients in one operation. This includes Won and Lost leads, so a disabled person does not retain ownership.

1. Sign in as an administrator, open **Accounts**, and unlock it with your personal four-digit PIN.
2. Find the agent and click **Disable**. The confirmation shows their lead count, pending follow-ups and scheduled visits.
3. Choose where the work should go:
   - **Share equally among all active agents** is selected initially. It considers each recipient's current open-lead workload and assigns the next lead to the least loaded agent, using a stable tie order.
   - **Give all to one agent** lets you select another active agent.
   - **Keep with admin (unassigned)** puts the leads in the administrator's unassigned pool. Pending follow-ups, scheduled visits and future unread reminders go to the administrator performing the handover.
4. Click **Disable access**. The agent's access change and handover commit together. If any database step fails, neither is saved.

**Cancel** leaves access and ownership unchanged. Selecting Disabled while editing an agent opens this same handover confirmation; any name or role edit is saved in the same operation. If no other active agents are available, choose the admin pool. Re-enabling an account restores access but does not return the old leads automatically.

Pending follow-ups and scheduled visits move with the client. Future unread reminders move without changing their IDs or creating duplicates. Completed/cancelled activity, read reminders and reminders already due keep their historical agent. Calls, notes and other completed history are retained. Ordinary lead and imported-file assignments also move the pending work; their usual round-robin selection remains unchanged.

Every subsequent CRM API request rechecks active access, including requests from an already open browser tab. The handover writes assignment history, safe per-lead audit entries and one `offboard_agent` summary. Audit metadata contains IDs and counts, without customer names, phone numbers, passwords or PINs.

If an agent was disabled outside this workflow, **Details → Hand over remaining work** lets an administrator recover their owned leads. The jobs runner also raises an administrator security alert for inactive owners. It reports the issue without automatically choosing a new owner. Keep `npm run jobs` running to receive these checks.

## Client KYC now follows client ownership

Client KYC entries are linked to a CRM lead:

| Account              | Client KYC access                                             |
| -------------------- | ------------------------------------------------------------- |
| Active administrator | All entries, including older unlinked entries                 |
| Active agent         | Only entries linked to leads currently assigned to that agent |
| Disabled account     | No CRM API access                                             |

The rule covers lists, search results, counts, reading pages, attachment lists and downloads. Guessing another client's document/file ID returns **not found**. Reassignment immediately changes which agent may make new requests for that client's KYC. Previously downloaded copies cannot be recalled.

Other document categories remain available to the active team. Only administrators can create, edit or delete entries and attachments. Files stay in the private `knowledge-files` bucket and download through the authenticated server route. Downloads are audited; no public file links or new browser Storage permissions were added.

For a new KYC entry, choose **Client KYC**, search by customer name and select **Client (lead)** before saving. The picker shows masked phone numbers to help distinguish customers. The selected client's name appears on the saved entry. On a client profile, **KYC documents** shows linked entries and their downloadable files to the administrator and current assigned agent.

## Link older KYC entries

Older entries are preserved. An existing KYC entry without a client link becomes administrator-only until corrected:

1. Open **Documentation & policies** as an administrator.
2. Check **KYC not linked to a client**.
3. Click **Edit** on an entry.
4. Search for and select its actual **Client (lead)**, then click **Save entry**.
5. Confirm the linked client name. The entry leaves the unlinked filter and becomes available to that client's current agent.

Link carefully: the selected client's owner receives access to the written entry and all its attachments. New KYC entries and newly attached KYC files require a client link.

## Install the database update in Supabase

**Back up the database first and confirm the backup can be restored.** Choose the Supabase project used by this CRM. This is a schema upgrade for an existing database; do not reset that database or run the fresh-install `setup.sql` bundle over it.

1. Confirm migrations **001–021** have been applied in order. The earlier visible-contact repair alone does not prove that every earlier migration is installed. If earlier migrations are missing, resolve those upgrades first.
2. In Terminal, run:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   pbcopy < supabase/migrations/022_agent_offboarding_and_kyc_access.sql
   ```

3. Open the correct project's **Supabase → SQL Editor → New query**. Paste the **complete file**, then click **Run** once. Do not paste the terminal commands or this guide into SQL Editor.
4. **Success. No rows returned** is expected. If an error appears, keep its exact text and resolve it before using the updated screens. The migration uses one transaction, so a failure rolls back that attempt.
5. Restart the local CRM API/client with `npm run dev` if they are not already running, and restart the jobs process with `npm run jobs`. Refresh the browser. If port 5173 is already in use, use the existing development terminal instead of starting a second copy.
6. With test accounts and sample clients, verify each handover choice, disabled-session denial, legacy KYC linking and cross-agent KYC denial before using the feature with customer data.

Migration 022 preserves existing leads, activity, accounts, documents and audit history. It adds the client link, protected handover/access functions and an inactive-owner alert. It also restores missing phone-history/security-alert prerequisites from migration 019 using their original restricted definitions, addressing the partial earlier setup discovered during contact troubleshooting. This does not replace installing all missing migrations in order. Current authorized lead numbers remain automatically visible as previously requested; the legacy phone protection functions and existing alerts remain intact.

Apply this numbered migration once. Keep migrations 001–021 unchanged. A fresh new database can use the regenerated setup bundle, which contains all 22 migrations and retains the fresh-project guard.

## Verification

- Full server suite: **340 tests passed** across 15 test files.
- Full client suite: **179 tests passed** across 15 test files.
- Total: **519 tests passed**. These include all handover modes, rollback, PIN/role denial, disabled sessions, pending-work transfer, unchanged completed history, KYC visibility/counts/guessing IDs, live ownership changes, safe audited downloads, private browser access denial and existing contact/import/assignment regressions.
- Client production build passed. Existing vendor annotation and large-bundle warnings remain. Validation used empty environment configuration and temporary output; no real environment files or secrets were read or changed.
- Headless Chrome passed **28 responsive layout checks** at 320, 390, 768 and 1440 pixels with the actual local React/API/SQL and isolated Auth/Storage. The checks covered PIN unlock, handover previews and choices, cancellation, all-status transfer, disabled API access, own/foreign KYC, legacy linking, a masked client picker and two audited file downloads. There were no page/dialog/control overflows, undersized measured tap targets or JavaScript page errors. Mobile handover/picker and desktop client-profile screenshots were visually reviewed.

Tests use isolated PostgreSQL, Auth and Storage fixtures. No hosted Supabase records were read or changed, and no real emails were sent. Real Supabase gateway/Storage behavior, separate database connections and physical mobile-device acceptance still require installation checks. See `VERIFICATION.md` for browser results and detailed limits.

The next code task in the production roadmap is **P5: administrator two-factor login**. VPS/domain/SMTP deployment work remains pending because those services are not prepared.
