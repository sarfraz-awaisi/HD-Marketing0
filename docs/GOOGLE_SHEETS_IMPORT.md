# Google Sheets lead import (update 056)

Meta Lead Ads write each advertisement's submissions to its own Google Sheet. A Google Apps Script reads those Sheets every five minutes and sends new rows to the CRM. **One Sheet is one CRM lead file, for good.**

- Administrators manage the Sheets in **Administration › Integrations › Google Sheets**.
- Imported leads arrive in the Sheet's lead file with source **Meta**, unassigned. Administrators assign them as usual (Task assign, bulk assignment or one by one), and agents then see them in Assigned leads.
- Nothing is assigned automatically, even in a file already assigned to an agent, and every Sheet starts turned off.
- Turning on a Sheet that would import rows submitted before it was added (its **historical import**) needs an administrator's explicit confirmation, which the CRM records.

The release plan is [GOOGLE_SHEETS_IMPORT_RELEASE.md](GOOGLE_SHEETS_IMPORT_RELEASE.md).

## How it works

```
Meta Lead Ads ──▶ Google Sheet (one per advertisement)
                     │  read by
                     ▼
            Google Apps Script (every 5 minutes, one run at a time)
                     │  HTTPS, integration key
                     ▼
   CRM API /api/integrations/sheets-sync  (apart from CRM sign-in)
                     │  server-only database functions
                     ▼
   Supabase: the Sheet's lead file, leads, import records
```

Each run:

1. The script asks the CRM for the Sheets that are turned on (`GET /sources`). The answer includes the CRM's clock, which marks the start of the pass.
2. For each Sheet, it reads every row and sends the Meta lead IDs (`POST /sources/:id/pending`). The CRM answers with the ones it has not imported.
3. It sends only those rows, 100 per request (`POST /sources/:id/rows`). The CRM answers for each row.
4. It reports how the pass went (`POST /sources/:id/report`). That report is what the Google Sheets page shows.

**The CRM decides what is new**, from its own record of every Meta lead ID imported from each Sheet. A unique key in the database (Sheet + Meta lead ID) enforces it.

- A retry, a lost reply, two runs at once, a reordered Sheet or a repeated row can never import a lead twice.
- The CRM has a row once it has answered for it. Each request is one database transaction: all of its rows are saved, or none.
- The Sheet itself is never changed.

### What each row becomes

| Result      | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `inserted`  | A new lead in the Sheet's lead file.                                                                                          |
| `existing`  | The phone number already belongs to a lead: a **repeat inquiry** on that lead, which is not changed.                          |
| `duplicate` | Already imported from this Sheet (the same Meta lead ID).                                                                     |
| `skipped`   | Submitted before the Sheet's start date.                                                                                      |
| `rejected`  | Cannot be imported as it is: the reason is shown on the Google Sheets page. Sent again on later runs, so a fixed row imports. |
| `failed`    | An unexpected error. Nothing was saved for it, and it is sent again on the next run.                                          |

**Existing customers.** The CRM allows one lead per phone number. When an advertisement brings a number the CRM already has, the submission is kept as a repeat inquiry on that lead, as Meta Lead Ads does.

- Nothing on the lead changes: not its name (even one an agent corrected), agent, calls, temperature, notes, follow-ups, status or history. The lead stays in its own file, and the repeat inquiry shows on its page.
- **The lead's current agent gets an in-app notification**, "New advertisement inquiry: HD-…", linking to the lead.
  - It is sent once per inquiry, so retries never repeat it.
  - Further inquiries for the same lead on the same day (Pakistan time) are counted in the same notice ("2 new advertisement inquiries"), which shows as unread again.
  - An unassigned lead notifies no one. The notice is erased if the lead is deleted for good.

**Deleted leads.** A number in Deleted leads is rejected ("This number is in Deleted leads (HD-…)") until the lead is restored. A lead deleted for good is never imported again from the same row, and what the customer submitted is erased with it.

### Columns

Columns are found by heading, ignoring case and spacing, in any order. Extra columns are kept, and a missing optional column is simply empty.

| Sheet column                                                           | In the CRM                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `id`                                                                   | The Meta lead ID: the import's identity. Required. Meta's `l:` prefix is removed. |
| `full_name` (or `first_name` + `last_name`)                            | Lead name. Required, up to 200 characters.                                        |
| `phone_number`                                                         | The lead's protected number. Required. See below.                                 |
| `email`                                                                | Lead email, when valid; otherwise left empty (the original is kept).              |
| `city`                                                                 | Preferred location, and City on the inquiry.                                      |
| `created_time`                                                         | Submitted, kept apart from the CRM's import time.                                 |
| `what_are_you_interested_in?_` (any column mentioning "interest")      | Property interest, on the inquiry.                                                |
| `what_is_your_preferred_investment_budget?_` (any mentioning "budget") | Preferred budget, as text, on the inquiry. The numeric budget fields stay empty.  |
| `ad_name`, `adset_name`, `campaign_name`, `form_name` and their IDs    | Advertisement details, on the inquiry.                                            |
| `platform`, `is_organic`                                               | Facebook, Instagram, Messenger or Audience Network; organic or paid.              |
| `lead_status`                                                          | Kept as Meta's own status. It is never the CRM's sales status.                    |
| any other column                                                       | Kept and shown on the inquiry as another answer.                                  |

**Phone numbers** from any country are checked against that country's numbering rules (update 064, Google's libphonenumber data). They are stored in E.164, `+` then the country code and digits, as every CRM number is. So the same customer is found however the number was written, and different customers are never merged.

- **With a country code:** `+971 50 123 4567`, `(+971) 50-123-4567` and `00971501234567` are all `+971501234567`. A `0` written by mistake after the code (`+92 0300 …`, `+44 (0)7911 …`) is dropped.
- **Pakistani numbers, as before:** `03001234567`, `0300-1234567`, `3001234567` (a number cell that dropped the leading zero), `923001234567`, `0092 300 1234567`.
- **Without a country code:** the number is read for the row's `country` column when the form has one and it says clearly which country. That can be an English name (`United Arab Emirates`), a two-letter code (`AE`), a common short form (`UAE`, `KSA`, `UK`, `USA`) or a calling code (`+971`). Otherwise the number is read as Pakistani, as the CRM always has. It is never guessed to be from another country.
- Meta's `p:` prefix, spaces, hyphens, brackets and dots, Arabic-Indic and Urdu digits, and invisible direction marks copied with a number are all handled.

A number that cannot be read is rejected with one of these reasons; fix the row in the Sheet and the next sync imports it:

| Reason                                                         | Meaning                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone number missing                                           | The phone cell is empty.                                                                                                                                                                                                                                                  |
| Phone number not valid for its country                         | Wrong digits or length for the country (for example a Pakistani mobile with a digit missing, or an unknown country code). Numbers shorter than 10 digits, valid only in a few small territories, are also refused: the CRM keeps and protects numbers of 10 to 15 digits. |
| Phone number has no country code and is not a Pakistani number | Write it with `+` and its country code (`+971 50 123 4567`), or add a `country` column.                                                                                                                                                                                   |

**What is stored for the lead page.** Every original column except the phone number is kept on the inquiry. The phone number is kept only as the lead's protected number, behind the usual number reveal.

**Times.** Meta's `created_time` (for example `2026-11-01T10:15:30+0500`) and date cells are read with their time zone. A time without a zone is Pakistan time.

## Setting it up

### In the CRM (administrator)

1. **Administration › Integrations › Google Sheets › Create key.** Copy the key: it is shown once.
   - Leads are created as the administrator who created the key, and stop being accepted if that person is no longer an active administrator.
   - Only the key's SHA-256 hash is stored. Replace key stops the old key at once, and Turn off the key stops all imports.
2. **Add Sheet** for each advertisement:
   - **Name:** also the lead file's name. It can be renamed later, and the file is renamed with it.
   - **Google Sheet link or ID.** The spreadsheet never changes for a Sheet; add another spreadsheet as a new Sheet.
   - **Tab name:** usually `Sheet1`.
   - **Import rows submitted from:** optional. Empty imports every row already in the Sheet, which is the historical import. A date after today imports new submissions only.
   - **Import from this Sheet:** leave it off until the script is ready.
3. **Turning a Sheet on** asks you to confirm the historical import when the Sheet would import rows submitted before it was added: no start date, or a start date before the day it was added.
   - The CRM refuses to turn such a Sheet on without the confirmation. It records who confirmed and when, in the audit history and on the Sheet's row.
   - A confirmation covers its start date and any later one. Moving the start date earlier asks again.

The same tab of the same spreadsheet cannot be added twice, so one Sheet never feeds two files.

### In Google Apps Script

Use a **company-controlled Google account** that can open every Sheet. Viewer access is enough. Not a personal account: the script and its trigger stop if the account that owns them is removed.

1. Go to <https://script.google.com> and create a new project, for example "HD Marketing CRM sync".
2. Replace `Code.gs` with [`integrations/google-sheets/Code.gs`](../integrations/google-sheets/Code.gs).
3. Open **Project Settings**:
   - tick **Show "appsscript.json" manifest file in editor**, then replace it with [`appsscript.json`](../integrations/google-sheets/appsscript.json). It asks only to read Sheets, connect to the CRM and run on a timer.
   - under **Script properties**, add:
     - `CRM_BASE_URL` = `https://hdmarketing.tech` (HTTPS only; the script refuses anything else);
     - `CRM_SHEETS_KEY` = the key from the CRM.

   Never put the key in the code.

4. Run **`checkSetup`**. Google asks for permission the first time. It imports nothing. The log should say the CRM accepted the key and, for each Sheet that is on, "the columns the CRM needs are there".
5. Turn the Sheets on in the CRM, confirming each historical import, then run **`syncLeads`** once. This is the historical import:
   - one run imports as much as it can in about 4½ minutes;
   - a larger Sheet continues on the next run, never twice.
6. Run **`installTrigger`**: `syncLeads` then runs every five minutes. Running it again replaces the trigger, and **`removeTrigger`** stops it.

### Adding a fourth Sheet (or a fifth)

1. Share the new Sheet with the script's Google account.
2. Add the Sheet in the CRM and turn it on.

The next run picks it up. No code changes.

## Running it

**The Google Sheets page** shows, for each Sheet:

- its lead file;
- whether it is on, and when the script last checked it. A warning appears if a Sheet that is on has not been checked for 20 minutes;
- new leads, repeat inquiries, and leads waiting for an agent;
- the last successful sync: the last complete pass;
- rejected rows, with each row number and reason;
- the latest error.

**Nothing needs retrying by hand.** Every run sends again the rejected and failed rows and any rows not yet imported. To run at once instead of waiting up to five minutes, run `syncLeads` in the Apps Script editor.

| Latest error                                       | What to do                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The script cannot open the spreadsheet             | Share it with the script's Google account.                                                                                                                          |
| No tab with this name                              | Correct the tab name in the CRM (Edit).                                                                                                                             |
| The first row needs id, phone_number and full_name | Restore Meta's heading row.                                                                                                                                         |
| Some rows could not be saved                       | Tried again on the next run. If it stays, check the CRM's error log.                                                                                                |
| More than 50,000 rows                              | Move older rows to another tab; they are already imported.                                                                                                          |
| The lead file was deleted                          | Restore the file from Deleted leads, or choose **Start a new lead file**. A new file is never started on its own, and rows already imported are not imported again. |

**Logs.** The Apps Script log (Executions) shows Sheet names, counts and row numbers only, never names, phone numbers, emails or the key. The CRM's audit history records each Sheet change, each key change, and each import that added leads, under "Facebook and Google Sheets leads".

## Security

- **Its own endpoint and key.** `/api/integrations/sheets-sync` takes only the integration key (`Authorization: Bearer hdcrm_sheets_…`).
  - It is separate from CRM sign-in: a user's session is not accepted there, and the key is not accepted anywhere else.
  - The key acts as the administrator who created it. A request can never choose who it acts as or which file it writes to: the database maps the Sheet to its file.
- **HTTPS only.** Production refuses the key over plain HTTP (Nginx reports the scheme), and the script refuses a non-HTTPS address.
- **Limits:**
  - refused keys: 30 per 15 minutes per address (`RATE_LIMIT_SHEETS_SYNC_REFUSED_PER_15_MIN`);
  - an accepted key: 900 requests per 15 minutes (`RATE_LIMIT_SHEETS_SYNC_PER_15_MIN`);
  - per request: 100 rows, 100 columns, 1 MB; 10,000 IDs per pending check;
  - per cell: 5,000 characters, after which the row is rejected.
  - The body is read only after the key is accepted.
- **The database checks everything again.**
  - The functions are for the server's API role only. Browsers cannot call them or read the tables.
  - The two helpers cannot be called even by the API role.
  - Only administrators manage Sheets and the key. Agents and staff get 403.
  - The lead page's inquiries are for administrators and the lead's agent.
- **No service-role credential** ever leaves the server; Google holds only the integration key.

## Limits and decisions

The owner's decisions (2026-11-09):

- **Lead source:** Meta.
- **Phone numbers:** valid Pakistani mobiles are normalized, including 10-digit numbers beginning with 3. This rule applies only to Sheets imports; the CRM's other imports are unchanged.
- **Phone numbers from any country (2026-11-13, update 064):** checked with each country's rules and stored in E.164. A number without a country code is read for a clear `country` column, otherwise as Pakistani; another country is never guessed. Existing numbers were not rewritten.
- **Interest and budget** are kept as the original text. They are not parsed into the numeric budget fields.
- **No automatic assignment:**
  - imported leads wait for an administrator, even in a file assigned to an agent;
  - the page counts them as "waiting for an agent".
- **No "import again from the start" button.** Rows already imported are never imported again.
- **Repeat inquiries** notify the lead's current agent, once per lead and day.
- **The Apps Script runs under a company-controlled Google account.**
- **The historical import needs explicit confirmation** before it is turned on.

Limits:

- **A Sheet's tab has at most 50,000 rows.**
- **Run time:** Apps Script stops a run at 6 minutes, and a free Google account allows about 90 minutes of triggers a day. A normal run takes a few seconds.
- **Local development.** Google cannot reach a local CRM, so locally the script runs in a test sandbox (`server/tests/google-sheets-apps-script.test.js`). No real Sheet is ever pointed at development.
