# Google Sheets lead import: update 056 release plan

Update 056 imports leads from Meta Lead Ads' Google Sheets through a Google Apps Script. Each Sheet becomes one CRM lead file, and a database key on Sheet + Meta lead ID prevents duplicates. How it works and how to set it up: [GOOGLE_SHEETS_IMPORT.md](GOOGLE_SHEETS_IMPORT.md).

**The owner approves every step that touches production.** Nothing in this plan has been run against production. The release leaves the import **off**: no key exists and no Sheet is on until the owner turns them on (stages 2 and 3). **The historical import is enabled only after the owner's explicit confirmation**, which the CRM itself requires and records (stage 3).

| Item            | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/056_google_sheets_import.sql` (one transaction, `lock_timeout` 5 s, safe to rerun)                 |
| Read-only check | `supabase/check-google-sheets-import-056.sql`: one SELECT, flags and counts only                                        |
| Requires        | update 055 in production                                                                                                |
| New settings    | none required. Optional: `RATE_LIMIT_SHEETS_SYNC_REFUSED_PER_15_MIN` (30) and `RATE_LIMIT_SHEETS_SYNC_PER_15_MIN` (900) |
| Nginx           | no change. `/api` is already proxied, with a 25 MB body limit and 50 requests per second per address                    |

## What 056 changes

- **New tables, empty at release:**
  - `sheet_sources`;
  - in the private schema:
    - `sheet_lead_receipts`: the import records;
    - `sheet_lead_inquiries`: what customers submitted;
    - `sheet_row_rejections`;
    - `sheet_sync_keys`.
  - Row-level security is on, and browsers have no access.
- **One more lead-file type,** `sheets`, in the `lead_imports` file-type check. Existing files keep their types, and no lead or file row changes.
- **One more notification type,** `ad_inquiry`, in the `notifications` type check. It tells an agent about a customer's repeat inquiry, and existing notifications are unchanged.
- **Twelve server-only functions and four helpers** no API role can call. No existing function or trigger changes.
- **Compatibility:**
  - The new code before 056: the Google Sheets page says "Google Sheets import needs CRM database update 056", the script's endpoint answers 503, and lead pages simply show no advertisement panel.
  - The older code with 056: works unchanged. The new tables are unused, and a `sheets` file shows as "SHEETS" in its file list.

## Stage 1: database and code (import stays off)

1. **Merge** the PR with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up, and test the restore.** Scheduled backups have been unreliable, so run one by hand and check it restores (v1.1.0 runbook step 4; [BACKUPS.md](BACKUPS.md)).
3. **Run** `check-google-sheets-import-056.sql`. Required:
   - `release_stage` = `at 055, ready for 056`;
   - `transactions_open_over_1_min` = 0.

   Note the `existing_*` counts and `lead_file_formats`.

4. **Apply 056** in the SQL Editor: paste the whole file and run it. If it reports a lock timeout, run it again when the CRM is quiet.
5. **Run the check again.** Required:
   - `release_stage` = `at 056`;
   - `server_functions` = 12;
   - every `*_must_be_0` = 0;
   - `sheets_file_type_allowed` and `inquiry_notifications_allowed` = true;
   - `sheets_configured`, `sheets_turned_on`, `histories_confirmed` and `active_keys` = 0;
   - the `existing_*` counts and `lead_file_formats` as before, apart from normal use.
6. **Retire the inactive slot** (server guide section 10), then **deploy `<SHA>`** with the Production workflow.
7. **Check:**
   - `X-Release-SHA` = `<SHA>`;
   - a request without a key is refused: `curl -s https://hdmarketing.tech/api/integrations/sheets-sync/sources` answers 401 `SHEETS_INVALID_KEY`.

**Smoke test** (administrator):

- Administration › Integrations shows Meta Lead Ads and Google Sheets.
- The Google Sheets page loads with no key and no Sheets.
- An agent's menu has no Integrations, and an agent opening `/integrations/sheets` is sent back.
- The lead page, Assigned leads, Lead pipeline and Task assign work as before.

## Stage 2: credential and Sheets (owner)

1. **Use a company-controlled Google account** to run the script, not a personal one. It needs Viewer access to each advertisement's Sheet.
2. **In the CRM,** Administration › Integrations › Google Sheets:
   - **Create key**, and copy it. It is shown once.
   - **Add the three Sheets.** Leave them off, and decide each one's start date:
     - **empty** imports every row in the Sheet;
     - **a date** imports only rows submitted from that day.

     If the older rows were already imported by CSV, an empty date is still safe: their numbers become repeat inquiries, not new leads.
3. **In Google Apps Script** (setup in [GOOGLE_SHEETS_IMPORT.md](GOOGLE_SHEETS_IMPORT.md)):
   - paste `Code.gs` and `appsscript.json`;
   - set the Script Properties `CRM_BASE_URL` = `https://hdmarketing.tech` and `CRM_SHEETS_KEY` = the key;
   - run `checkSetup`. Expected: "The CRM accepted the key. Sheets turned on: 0".

## Stage 3: first import, then automatic

1. **The owner confirms the historical import explicitly** before any Sheet with earlier rows is turned on. Decide per Sheet how far back to import: every row, rows from a start date, or new submissions only (a start date after today, which needs no confirmation).
   - Turning such a Sheet on opens **Confirm the historical import**. Without that confirmation the CRM refuses to turn the Sheet on, and the script is never offered it.
   - The CRM records who confirmed and for which start date.
2. **Turn on one Sheet,** confirming as above. Run `checkSetup` (its columns are found), then run `syncLeads`.
3. **Check that Sheet:**
   - the Google Sheets page shows its new lead file and no error;
   - new leads + repeat inquiries + rejected rows account for the Sheet's rows, apart from rows before the start date and repeated rows;
   - a few imported leads have the right name, number and Advertisement inquiry;
   - rejected rows have reasons.
4. **Run `syncLeads` again.** Nothing new is imported, and the log says 0 sent.
5. **Turn on the other two Sheets,** each with its own confirmation, and run `syncLeads`. Three different lead files result.
6. **Run `installTrigger`.** Then confirm that within 10 minutes the page shows a fresh "Checked" time for every Sheet that is on.
7. **Assign the files** to agents (Task assign). Then check, as an agent:
   - the leads are in Assigned leads;
   - a lead's page shows its Advertisement inquiry;
   - a repeat inquiry on one of their leads appears in their notifications.
8. **Watch for a day:**
   - Apps Script **Executions** show a run every five minutes, each finishing in seconds;
   - the page shows no lasting error.

## Stopping and rollback

- **Stop imports at once:** Turn off the key (CRM), or turn off a Sheet, or run `removeTrigger` (Apps Script). Imported leads stay as ordinary leads.
- **Code:** roll back the application (v1.1.0 runbook steps 8.2–8.4). The older code works with 056; the import endpoint is then simply gone.
- **A wrong import:**
  - delete the Sheet's lead file together with its leads; they can be restored from Deleted leads for 30 days;
  - the import records stay, so those rows are not imported again.
  - There is no import-again-from-the-start, by the owner's decision.
- **Database:** nothing needs undoing; leave 056 in place. The tables and functions are unused by the older code.

## Known limits

- **Every row is sent again** while it stays rejected (one request per 100 such rows each run), until the row is fixed or removed.
- **A tab of more than 50,000 rows** is refused: move older rows to another tab.
- **Per-run time:** a free Google account allows about 90 minutes of triggers a day. A normal five-minute run takes a few seconds; a large first import spreads over several runs.
- **No automatic assignment,** by the owner's decision: rows arriving after a file was assigned wait for an administrator.

## Update 064: phone numbers from any country

Overseas customers' numbers are read with their country's numbering rules (libphonenumber) and stored in E.164; Pakistani numbers read as before. See "Phone numbers" in [GOOGLE_SHEETS_IMPORT.md](GOOGLE_SHEETS_IMPORT.md).

| Item            | Value                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/064_international_phones.sql` (no row changes; safe to rerun) |
| Read-only check | `supabase/check-international-phones-064.sql`                                      |
| Requires        | update 063 in production                                                           |
| New dependency  | `libphonenumber-js` (server, MIT, no dependencies)                                 |

**What 064 changes:** two more rejection reasons, `phone_missing` and `phone_needs_country`, in the rejections table's check and in `sheet_sync_import`'s list. Numbers are stored by the same rule as before: E.164, 10 to 15 digits. Each edit checks the existing text first, and the update stops and changes nothing if anything differs.

**Release:**

1. Back up the database and test the restore.
2. Run the check. It should read `at 063, ready for 064`. Note the counts, and `numbers_with_0_after_92` (older `+920…` numbers the import's `+92…` will not match).
3. Apply 064 and run the check again. It should read `at 064`, with `new_reasons_accepted` = true, `browser_function_access_must_be_0` = 0 and the same counts.
4. Deploy the code.

Apply 064 before the code. The live code works with 064. If the new code went out first, any batch with a row missing its phone or its country code would be refused as a whole (and tried again on each run) until 064 is applied.

**Rollback:** roll back the application; the older code works with 064. No data changes.

**Known limits:**

- **A local number without a country code that is also a valid Pakistani number** is read as Pakistani. For example, New York's `212 555 0123` is also a Karachi landline. A country code or a `country` column settles it.
- **Existing numbers are not rewritten.** A lead stored in an older form (`+920300…`) is not matched by a new import's `+92300…`, so such a customer gets a new lead. The check counts these numbers; a cleanup would be a separate, approved update.
- **Numbers shorter than 10 digits** (valid only in a few small territories, such as Niue or the Falkland Islands) are refused as not valid. The CRM's number protection shows three characters at each end of a number, which would reveal most of so short a number.
- **Other ways leads are added** (Add lead, file imports, Meta Lead Ads) keep their earlier rule, in which a leading `0` means Pakistan.
