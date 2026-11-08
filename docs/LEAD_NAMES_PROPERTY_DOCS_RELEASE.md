# Customer names, flexible prices, property documents and floors: update 054 release plan

Update 054 adds four things agents use every day:

- **Correct a customer's name.**
  - A pencil beside the name in a lead's details, opened from Assigned leads or the Lead pipeline.
  - Agents can rename leads assigned to them now. Administrators can rename any lead.
  - Only the name changes. The audit history shows who changed it, when, and the old and new name.
- **Prices as said in Pakistan.**
  - The price is an amount plus a unit: PKR, Thousand, Lakh or Crore. Agents can also type "2.3 Cr", "75 lac" or "45K".
  - A preview shows the exact PKR amount, and it is saved in PKR as before.
  - Prices show as "PKR 2.3 Crore", "PKR 75 Lakh" or "PKR 45,000/month". Rent is always per month.
- **Property documents.**
  - Brochures, floor plans and payment plans as PDFs, up to 10 per property and 20 MB each.
  - Actions: View, Download, WhatsApp and Remove, both in the property's details and in its form.
  - Whoever can see a property can open its documents. Whoever can change it can add and remove them, as for pictures.
  - Adding an agent's listing to Admin Properties copies its documents with its pictures, as separate files and records. The original stays unchanged.
- **Floors.**
  - Apartments, portions, shops and offices get a Floor: Basement, Lower ground, Ground, or 1 to 200.
  - For these types, "Floors" becomes "Total building floors", and the floor can't be above it.
  - Changing the type to one without a floor or building details asks before removing them.

The owner approves every step that touches production. Nothing in this plan has been run against production.

| Item            | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/054_lead_names_property_documents.sql` (one transaction, safe to rerun) |
| Read-only check | `supabase/check-lead-names-property-docs-054.sql`: one SELECT, flags and counts only      |
| Requires        | update 053 in production                                                                  |
| Storage         | new private bucket `property-documents` (PDF only, 25 MB), created by the migration      |
| Optional setting | `PROPERTY_DOCUMENT_MAX_MB` (default 20, never above 25)                                   |

## What 054 changes

- **`lead_rename`** (new) changes only `leads.name` and `updated_at`.
  - It doesn't change `last_activity_at`, because a corrected name isn't customer contact and must not delay idle-lead rules.
  - It writes one `lead.renamed` audit entry with the name before and after.
  - Another agent's lead, a deleted lead, a disabled account and a staff account are refused.
- **`properties.floor_level`** (new, empty for every existing property) is a small number checked by its type, as in update 046.
  - `inventory_save` accepts it, checks it is not above `floors`, and clears it for types without a floor.
  - `inventory_promote` copies it.
  - `promotion_change_text` names it in administrators' notices.
  - These three are otherwise as in update 046.
- **`property_documents`** and **`property_document_cleanup`** (new tables) have row-level security and no browser access.
  - Removing a document, or deleting its property, queues its file in the same transaction.
  - An upload reserves its path for an hour first, so an interrupted upload leaves no file behind.
  - Six API functions, for the server only.
- **Promotion copies documents.** `inventory_promote_prepare`, `inventory_promote` and `inventory_promote_release` keep their arguments.
  - Prepare reserves a copy of each document, as for pictures, and lists it as `documents`.
  - `inventory_promote` accepts copied picture and document paths together. It creates the document records with the copy in one transaction, and releases anything not copied.
  - Release frees document reservations too.
  - A failed attempt removes its own copied files, so no file is left without a record and no record without its file.
- **No existing row changes.** The column is added without rewriting the table; `properties` is locked briefly, with a 5 s `lock_timeout`.
- **The deployed code keeps working with 054.** It never sends a floor, the old functions' inputs are unchanged, and its promotions still copy pictures (documents only exist once the new code is deployed).

## Release

1. **Merge** the PR with CI green. Record the full new `main` SHA as `<SHA>`.
2. **Back up**, and check that the backup restores (v1.1.0 runbook step 4).
3. **Check Nginx** on the VPS (read-only): `client_max_body_size` must be at least `21m`; the example config uses `25m`. A smaller value stops large PDFs with a 413 error.
4. **Run** `check-lead-names-property-docs-054.sql`. Required:
   - `release_stage` = `at 053, ready for 054`;
   - `document_bucket` = `missing`;
   - `transactions_open_over_1_min` = 0;
   - note the `existing_*` counts.
5. **Apply 054** in the SQL Editor: paste the whole file and run it.
   - If the bucket insert is refused, nothing is applied. Create the bucket in Storage instead (name `property-documents`, private, 25 MB, allowed type `application/pdf`), then run 054 again.
6. **Run the check again.** Required:
   - `release_stage` = `at 054`;
   - `document_bucket` = `private, PDF only, 25 MB`;
   - `server_functions` = 9;
   - every `*_must_be_0` = 0;
   - `properties_with_floor` = 0;
   - the counts as before, apart from normal use.
7. **Retire the inactive slot** (server guide section 10), then **deploy `<SHA>`** with the Production workflow.

**The database comes first.** The new code sends a floor with every building save, which the database refuses before 054. Names and documents report "needs CRM database update 054".

## Smoke test

1. **Agent, a lead named Unknown:** pencil → enter the real name → Save.
   - The name changes in the details, Assigned leads and the Lead pipeline.
   - Audit history shows the old and new name.
2. **Agent, own inventory:** add an apartment for rent at "45K" on floor 7 of 20 with a PDF brochure.
   - The card shows "PKR 45,000/month · 7th floor".
   - View opens the PDF and Download saves it.
   - WhatsApp, on a phone, offers the share sheet with the file. On a computer, it downloads the file and opens WhatsApp.
3. **Another agent** cannot find that property. **An administrator** can open its documents but not remove them.
4. **Administrator, company inventory:** add a PDF. An agent can view it but has no Remove.
5. **Administrator:** add the agent's listing from step 2 to Admin Properties. The copy has its own brochure, and the agent's original keeps theirs.

## Rollback

- **Code:** roll back the application (v1.1.0 runbook step 8.2–8.4). The older code works with 054.
- **Database:** nothing needs undoing.
  - Uploaded documents stay in the private bucket, unseen by the older code.
  - Renamed leads keep their new names.
  - Floors stay recorded and unused.

## Known limits

- Production has no background worker yet. Document files are removed straight after each removal. Anything left (a failed removal, or an expired upload reservation) waits for the worker or the property's next removal.
- WhatsApp can receive the PDF itself only through a phone's or tablet's share sheet. On a computer, the agent attaches the downloaded file by hand, and the page says so.
