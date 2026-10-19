# Import leads from CSV or Excel

Sign in as an administrator, open **Leads**, click **Import CSV / Excel**, and choose a `.csv`, `.xlsx` or `.xls` file. An import results dialog shows how many leads were imported or rejected, with a result for each file row. Agents cannot upload lead imports.

Each processed upload retains its filename and accepted leads in **Task assign**. Choose an active agent there to assign the entire file. Agents open assigned files from **My leads** to see their customer list. Existing installations must apply migration **014** first; see [file assignment setup and workflow](FILE_ASSIGNMENTS.md).

The file must be no larger than **5 MB** and contain no more than **1,000 lead rows** and **32 columns**. Excel uses the first worksheet only. Put the headers in row 1 and keep the data within rows 2–1001; remove unused worksheet rows and columns before saving if Excel reports a larger used range. CSV must use UTF-8 and comma separators.

## Columns

| Header               | Required | Contents                                                                                                           |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `name`               | Yes      | Customer name, up to 200 characters.                                                                               |
| `phone`              | Yes      | Phone number as Text, including its leading zero or international country code.                                    |
| `email`              | No       | A valid email address or blank.                                                                                    |
| `budget_min`         | No       | A number, zero or greater; defaults to 0.                                                                          |
| `budget_max`         | No       | A number greater than or equal to `budget_min`, or blank.                                                          |
| `preferred_location` | No       | Location text.                                                                                                     |
| `property_id`        | No       | An existing property's UUID, or blank.                                                                             |
| `assigned_agent`     | No       | An active agent's exact name or UUID, or blank. Unknown/ambiguous agents leave the lead unassigned with a warning. |
| `source`             | No       | Accepted for compatibility; imports always use the existing `CSV` database category.                               |

Common headings are matched automatically, ignoring capitalization, spaces and punctuation. For example, `Full Name`, `Customer Name` and `Client Name` match `name`; `Mobile Number`, `Contact No.` and `Phone Number` match `phone`; `E-mail Address` matches `email`; `Min Budget` / `budget_min_pkr` and `Max Budget` / `budget_max_pkr` match their respective budget fields. `Agent Name` and `Assigned Agent` match the agent reference. Empty optional cells and completely blank data rows are ignored.

## Match unfamiliar columns

If a file has extra, unusual, missing or ambiguous headings, the same import action opens **Match file columns** before creating any leads. You do not need to rename those columns or choose the file again.

1. Check the suggested matches for the headings in your file.
2. Match one column to **Customer name (required)** and one to **Phone number (required)**.
3. Match optional columns such as email, budget and location. A generic `Budget` heading requires choosing Minimum budget or Maximum budget. Property columns require existing CRM property IDs. Agent columns accept an active agent's exact name or CRM ID.
4. Leave unrelated columns such as serial numbers or unsupported notes as **Skip column**. These values will not be saved. The results dialog lists the skipped headings.
5. Click **Import leads**. Cancel closes the matching screen without creating leads.

Each CRM field can be matched once. Already matched fields are disabled in other dropdowns and identify the column using them. To move a match, set its current column to **Skip column**, then select the field in the intended column. Skip column can be used for any number of columns. Correcting a selection clears the previous warning.

If two headings both look like phone numbers, neither is selected automatically; choose the intended column. Column positions distinguish repeated or blank headings. Errors retain your matching choices so you can retry without selecting the file again. Excel still requires the actual header row in row 1.

The server returns only bounded header labels and match suggestions for this step, without the customer rows. It revalidates the selected fields and column indices before processing the file. Extra columns are omitted only after an explicit mapped import, and spreadsheet formulas in matched columns remain rejected.

Excel imports appear alongside CSV imports under the **CSV / Excel** source filter. The source value remains `CSV`; the separate file history records the actual CSV, XLSX or XLS format.

## Phone numbers and budgets

Set the Excel phone column's number format to **Text before entering or pasting phone numbers**. This preserves `0300…`, `+92300…`, and `0092300…`; those equivalent Pakistani formats normalize to the same number. Other countries' numbers need a country code. Changing a numeric cell to Text after Excel has removed a leading zero does not restore the missing digit: correct the value before importing.

Existing Excel zero-padding phone formats are preserved. Numeric phone cells with country codes are accepted when their value is an exact integer. Ambiguous numeric values that may have lost a leading zero are rejected with instructions to correct the phone column. Phone numbers are stored through the existing protected transactional import path; result messages never echo full phone numbers.

Text placeholders such as `TEST-PHONE-0001` are not phone numbers and must be replaced with valid customer numbers for a real lead import. The importer reports this explicitly and does not generate replacement numbers.

Budget cells can be ordinary Excel numbers with currency or thousands-separator display formatting; the importer reads the underlying numeric amount. For CSV or text budget cells, use plain numbers without currency symbols or thousands separators. Blank optional budgets remain unspecified.

## Agent names and IDs

Agent names are matched against active CRM agents after normalizing capitalization and surrounding/repeated spaces. A unique exact match or a valid active agent ID assigns the lead through the existing transactional assignment function. Admin and disabled profiles are excluded. Agent names do not create new accounts.

An unknown name/ID or a name shared by multiple active agents leaves the lead unassigned and adds a warning to its successful import result. Assign these leads from the Leads page. Blank, `Unassigned`, `None`, or `N/A` means no assignment and produces no warning. The matching screen explains this behavior before the mapped import. If the active-agent lookup fails, the file is stopped before any leads are created so an outage cannot silently change assignments.

## Results and errors

- **Duplicate phone:** the normalized number already exists, including another accepted row in this import. The existing lead is preserved.
- **Field-specific validation messages:** the row result identifies the invalid name, phone, email, property ID or budget. Correct that field or its column match, then retry the rejected rows. Error messages do not echo customer cell values.
- **Imported with agent warnings:** the lead was saved without an assigned agent because the name/ID did not uniquely match an active agent. Review the warning and assign the lead from Leads.
- **Replace text placeholders with a valid phone number:** the matched phone cell contains a test label or invalid number. A real lead needs a valid phone number; changing the matched agent column alone will not correct placeholder phones.
- **Match file columns:** select the name and phone columns, match optional fields or choose Skip column for extras, then click Import leads. No leads are created while matching is required.
- **Replace formulas with values:** copy formula cells and use Excel's Paste Special → Values. Formula cells are rejected even when the workbook contains a cached result.
- **Invalid or unreadable Excel file:** save a genuine, unencrypted Excel workbook as `.xlsx` or `.xls`. Renaming CSV, HTML, or PDF files does not convert them to Excel.
- **Maximum 1,000 rows / 5 MB:** split the file into smaller batches. Remove unused formatted rows or columns from Excel's used range if necessary.

The `import_leads` transaction records file metadata and calls `create_lead` in a separate subtransaction for each valid row, retaining the existing permissions, normalized-phone uniqueness and audit handling. Invalid or duplicate rows do not undo accepted rows. File metadata, accepted leads, private phones and the summary audit commit together; a failed summary audit rolls them all back. Retry only rejected rows; re-uploading accepted rows reports duplicate phone numbers. Excel results retain worksheet row numbers, including gaps from blank rows. CSV results identify each record's ending line, including blank lines or quoted multiline values.

Matching, parsing or agent-lookup failures before processing create no file record. A processed file with zero accepted rows remains visible to administrators with its rejection count, and cannot be assigned. Only supported mapped fields are saved; original spreadsheet bytes and skipped values are not retained.

The picker disables during an upload, resets after completion or failure, and supports selecting the same file again. Its button works with a mouse, touch or keyboard. The existing responsive dialog and scrolling results table are used.

## Local development

The server reads Excel files with SheetJS CE 0.20.3 from the [official distribution](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/), pinned in the workspace lockfile. The spreadsheet reader stays on the server and is not included in the client bundle. Run `npm install` when setting up another checkout, then `npm run dev`; restart an already running development process after pulling this dependency change.

Automated checks generate real XLSX and binary XLS workbooks and exercise the actual upload route. They also cover CSV compatibility, common heading aliases, explicit column matching and skipping, duplicate heading choices, invalid or privileged mapping fields, no writes before matching, blank optional cells, phone formatting and placeholder errors, numeric/PKR budgets, agent name/ID resolution and ambiguity, disabled/admin exclusion, lookup failure before writes, warning results, field-specific errors, formulas, first-sheet selection, row and upload-size limits, partial success, duplicate handling, authentication and role restrictions, and the client picker/pending/error/results behavior. These checks use isolated database/Auth fixtures; no hosted leads are created by the tests.
