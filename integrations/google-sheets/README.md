# Google Sheets lead sync (Google Apps Script)

These two files are pasted into a Google Apps Script project. They are not part of the CRM build.

- `Code.gs`: the script. It reads the Meta Lead Ads Sheets that are turned on in the CRM and sends their new rows.
- `appsscript.json`: its manifest. It asks only to read Sheets, connect to the CRM and run on a timer.

Setup, operation and security are covered in [docs/GOOGLE_SHEETS_IMPORT.md](../../docs/GOOGLE_SHEETS_IMPORT.md).

- **Script Properties, never in the code:**
  - `CRM_BASE_URL`: `https://` only;
  - `CRM_SHEETS_KEY`: from Administration › Integrations › Google Sheets.
- **Tests:** `server/tests/google-sheets-apps-script.test.js` runs this script against the CRM API.
