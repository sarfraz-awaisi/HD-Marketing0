# Property inventory (update 041)

Implemented 22 October 2026. Every agent keeps a private property inventory. Administrators keep the **company inventory**: every agent can browse it, and only administrators can change it. Administrators can open any agent's inventory to read it, but they cannot change an agent's properties.

The sidebar item **Properties** is now **Inventory**, in the same Resources section with the same icon. Old `/properties` links redirect to `/inventory`.

## Who can do what

The database functions enforce these rules for every request, so hiding a button is never the only protection.

| Operation                                    | Admin                   | Agent                      |
| -------------------------------------------- | ----------------------- | -------------------------- |
| Add a company property                       | Yes                     | No                         |
| View company properties                      | Yes                     | Yes                        |
| Edit, delete, change status of company items | Yes                     | No                         |
| Add, edit, delete own private property       | Not applicable          | Yes                        |
| View an agent's private properties           | Yes, read-only          | Only their own             |
| Edit or delete an agent's property           | No                      | Only their own             |
| Upload, reorder, delete pictures             | Company properties only | Own properties only        |
| Agent directory with property counts         | Yes                     | No                         |
| Change who owns a property                   | No                      | No                         |
| Owner name and phone of a company property   | Yes                     | Only if an admin shared it |
| Owner notes of a company property            | Yes                     | No                         |
| Owner contact of an agent's property         | Yes                     | Owning agent only          |

Another agent's property is answered as **not found** (404), so its existence is not revealed. Owner identity always comes from the signed-in account; a request that names an owner is rejected.

## Screens

**Agent → Inventory**

- **My properties**: add, view, edit, delete, change status, archive, upload and order pictures. Only the agent and administrators can see these.
- **Admin inventory**: the company listings, read-only. Agents see owner contact details only when an administrator ticked **Share owner name and phone with agents**.

**Admin → Inventory**

- **Admin properties**: the company inventory with full management.
- **Agent inventories**: every agent with email, account status, total, available and sold/rented counts and last update. **Open inventory** shows that agent's properties read-only. Disabled and deleted accounts stay listed while they still have properties.

Both portals show summary tiles. Agents see their own counts and the company total; administrators see company, agent and overall totals. Every list has search (title, area, city or a reference such as `PR-000012`), filters for type, sale or rent, status, city or area and price range, sorting, and 20 properties per page. The tab and selected agent are kept in the address (`?tab=agents&agent=…`), so they survive a refresh.

## Property details

- **Basic**: title, type (House, Apartment, Residential Plot, Portion, Farmhouse, Shop, Office, Commercial Plot, Warehouse, Building, Land, Other), category (derived from the type), sale or rent, status, description and an automatic reference number (`PR-000012`).
- **Status**: Available, Reserved, Sold (sale only), Rented (rent only), Inactive. Inactive is stored as the existing `archived` value.
- **Location**: country (Pakistan), province, city (required), area or society, block, sector or phase, street, plot or house number, full address and a map link (`https://` only). The card's location line is built from block, area and city.
- **Size and price**: size with Marla, Kanal, square feet, square yards or acres, stored as entered and never converted. Price in PKR (monthly rent for rentals), negotiable, price notes.
- **Building details** (hidden and cleared for plots and land): bedrooms, bathrooms, kitchens, floors, parking, age, furnishing, construction condition, and the [building categories](#building-categories-update-046) on offer.
- **Utilities and features**: electricity, gas, water, sewerage, internet, boundary wall, security, corner, park facing, main road, lift, backup power, solar, servant quarter, basement, lawn, drawing room, store room.
- **Owner contact (private)**: name, phone, alternate phone, notes. Phone numbers are normalized to `+92…`.
- **Pictures**: optional, up to 20 per property, JPEG, PNG or WebP up to 5 MB. The first picture is the cover; **Make cover** moves another to the front.
- **Record**: who added and last updated the property, and when.

Older properties keep their data. Their type may be an old free-text value such as "Plot"; the edit form shows it and asks for a type from the new list. If an older property has no city, the form shows the previously recorded location as a hint.

If two administrators edit the same company property at once, the second save is refused with "Someone else changed this property…" instead of overwriting the first.

## Building categories (update 046)

Added 29 October 2026. One property or building often offers several kinds of units or spaces at once, for example residential and hotel apartments of different sizes, shops and offices. Building categories record all of them on a single listing, so a mixed-use building needs one listing, not one per kind of unit.

| Group            | Options                           | Stored as                                                                 |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Residential      | 1 Bedroom, 2 Bedrooms, 3 Bedrooms | `residential_1_bed`, `residential_2_bed`, `residential_3_bed`             |
| Hotel Apartments | 1 Bedroom, 2 Bedrooms, 3 Bedrooms | `hotel_apartment_1_bed`, `hotel_apartment_2_bed`, `hotel_apartment_3_bed` |
| Commercial       | Commercial Outlets / Retail Shops | `commercial_outlet`                                                       |
| Workspaces       | Office Spaces / Workspaces        | `workspace`                                                               |

### Choosing and editing

- **Add property** and **Edit property** show a **Building categories** part inside **Building details**, with one box per option, grouped as above. Tick any combination, from one category to all eight. Every box is independent: Residential 1 Bedroom and Hotel Apartments 1 Bedroom are separate choices. Untick a box to remove that category.
- Categories are optional. Properties added before update 046 have none until someone edits them.
- They describe what the building offers. **Bedrooms** still describes the listed unit, so a building can offer 1-, 2- and 3-bedroom apartments while the listing itself has 2 bedrooms.
- Like the other building details, they are hidden for Residential Plot, Commercial Plot and Land. Changing a property to one of those types clears its categories.
- **Edit property** opens with the saved categories ticked. Saving changes only what was changed: saving other details keeps the categories. Closing the form without saving, or a save that is refused (someone else changed the property meanwhile, or an invalid value), leaves them as they were.
- Who can change them is the same as for every other detail (see [Who can do what](#who-can-do-what)): the owning agent for their own listings and administrators for Admin Properties. Agents cannot change another agent's listing (404) or an Admin Property (403), and administrators cannot change an agent's listing (403).

### Where they appear

- **Property details** shows a **Building categories** section: each group with its chosen options, in words. It is left out when a property has none.
- **Property cards** show one short line, for example "Residential 1, 2, 3 bed · Hotel apartments 1, 2 bed · Retail shops · Workspaces".
- The inventory lists cannot be filtered or searched by category yet.

### Admin Property Promotion copies

An administrator can add an agent's available or reserved listing to Admin Properties with **Add to Admin List** (update 044). This creates an independent copy with its own reference number and its own pictures; the original stays the agent's.

- The copy starts with the original's building categories, along with its other details.
- After that the two records are independent. When the agent changes the original's categories, the admin copy keeps its own; when an administrator changes the copy's categories, the agent's original is not changed. Nothing is synchronized either way.
- When the agent changes the categories of a listing that has a copy, every active administrator receives the existing in-CRM notice **Original property updated**, saying what was added and removed, for example "Ali Agent (UID 123456) updated PR-000015. Building categories: added Office Spaces / Workspaces. Admin copy PR-000016 has not been changed." A save that changes nothing sends no notice; the same categories in another order are not a change. A very long change is summarized as counts ("added 3, removed 2") so the notice stays within its 500 characters.
- Promotion keeps counting the pair once in the overall unique total, keeps showing who originally listed the copy, and keeps separate pictures, exactly as before.

### Audit History

- Creating a property with categories adds "Building categories: …" to the entry.
- An update that changes categories says what was added and removed, and **What changed** shows the categories before and after. When the categories are the only change, the entry is titled **Updated property building categories**.
- From update 046, property updates record the names of the fields that actually changed (never their values, except the categories, which are not private). A save that changed nothing reads "Saved … without changes." Entries recorded before 046 still name the fields that were sent.

### API and validation

- `POST` and `PATCH /api/properties` accept `building_categories`, an array of the identifiers above. Unknown values, anything other than an array, and repeated values are refused with 400. The order sent does not matter: categories are always stored and returned in the order of the table above.
- A `PATCH` without `building_categories` leaves them unchanged. Every property response, including the lists, returns them; older properties return `[]`.
- The identifiers, their order and their labels are defined in three places that must agree: the database (046), `server/src/utils/validators.js` and `client/src/lib/inventory.js`. A server test fails if they ever differ.

### Database changes (`supabase/migrations/046_building_property_categories.sql`)

The update is additive and can be applied again safely. Existing properties, owners, pictures, owner contacts, promotions and permissions are unchanged; existing properties get an empty list.

- **`properties.building_categories`**: not null, empty by default. Its type, `property_building_categories`, accepts only the listed identifiers, each once, in the standard order, so even a direct database write cannot store anything else. The check sits on the type rather than on the table, so 041's preflight and rerun still work.
- **Helpers** `property_category_list`, `property_categories_sorted` and `property_category_label`: available to the API's service role (the column's type uses them on every write), not to browser roles.
- **Restated functions**, each as in 044 plus categories: `inventory_save` (checks, orders and clears categories; records the fields that actually changed), `promotion_change_text` (describes added and removed categories) and `inventory_promote` (copies them).
- Runs as one transaction in a few seconds. `properties` is rewritten once to add the column (it is small) and is locked meanwhile; if a lock is not available within 5 seconds, nothing changes and it can be run again.

### Applying update 046

- **Existing database (the supported process):** take and verify a backup, then apply each missing numbered migration once, in order. 046 follows 045. Production migrations are applied in the SQL Editor as part of an approved release; the GitHub workflows never run migrations. Locally, `npx supabase@2.122.0 migration up --local` applies only migrations it has not recorded, so it never reapplies an older one.
- **Never reapply older migrations.** 041 and 044 restate the inventory functions. If either were run again after 046, saved categories would stay in the table, but saves that include categories would be refused with "Unsupported property details" until 046 was applied again. After a rerun of 044, **Add to Admin List** would also stop copying categories, without any error. Running 046 again restores both (tested).
- **Brand-new project:** `supabase/setup.sql` combines migrations 001–041 and has not been regenerated since. After running it, apply 042 to 046 in order (tested in PGlite). Never run `setup.sql` against an existing project.

### Tests

- `server/tests/building-categories.test.js`: one, several and all categories, the standard order, residential versus hotel, older and new properties without categories, invalid and repeated values through the API and directly in the database, adding and removing, unrelated and refused edits, plots and land, promotion copies and their independence, the unique count, notices for category changes and none for unchanged form saves, Audit History wording, permissions, browser-role privileges, the three category lists agreeing, and rerunning 046 and 041.
- `server/tests/building-categories-migration.test.js`: 046 on a database at 045 holding agent and company listings, pictures, owner contacts and an admin copy made by the 041 and 044 functions. Everything stays unchanged, a rerun changes nothing, and it documents what rerunning 044 would do.
- `client/tests/building-categories.test.jsx`: the boxes inside Building details, several and all categories, plots and land, the details section, editing with saved categories ticked, closing an edit without saving, and the card summary.

## Database changes (`supabase/migrations/041_property_inventory.sql`)

The update is additive and can be applied again safely. It deletes nothing and moves no lead, visit, deal or picture. Existing properties become company inventory.

- **`properties`**, new columns: `owner_agent_id` (null means company), `property_no` (identity, unique), `purpose`, `country`, `province`, `city`, `area_society`, `block_sector`, `street`, `plot_number`, `address`, `map_url`, `currency`, `price_negotiable`, `price_notes`, `bedrooms`, `bathrooms`, `kitchens`, `floors`, `parking_spaces`, `furnishing`, `construction_status`, `property_age`, `amenities`, `created_by`, `updated_by`, and a generated `category`.
- **Widened checks**: status adds `rented`; size units add `sq yd` and `acre`. New checks cover purpose and status, Pakistan and PKR, provinces, text lengths, the map link, room counts and the amenity list.
- **Indexes**: owner plus created date, owner plus status and purpose, and lower-case city. Picture order uses `property_photos(property_id, position, …)`.
- **`property_owner_contacts`**: a new table, one row per property, removed with the property. Row-level security is on and browser roles have no access.
- **`property_photos.position`**: picture order; the lowest is the cover.
- **Triggers**: `guard_property_owner` makes the owner and creator unchangeable and allows only agents to own private property. `guard_property_link` allows only company properties on leads, visits and deals, so a private listing never appears to whoever owns a lead next.
- **Functions** (service role only): `inventory_page`, `inventory_property`, `inventory_summary`, `inventory_agents`, `inventory_save`, `inventory_access`, `inventory_photos`, `inventory_photo_add`, `inventory_photo_remove`, `inventory_photo_order`, plus internal helpers. `delete_property` (013) is replaced with the same linked-record, photo-queue and audit behavior, now ownership-aware.

Audit history records `create`, `update`, `delete`, `upload_photo`, `delete_photo` and `reorder_photos` with field names only, never prices, addresses or owner contact details.

## API

All routes need a signed-in, active account and use the per-user rate limits. Saves, deletions and picture reordering or removal also use the existing 30-changes-per-minute limit. Picture uploads use only the general per-user limit, as before, so a save with many pictures is not cut off.

| Method and path                              | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/properties?scope=company`          | Company inventory (the default; also used by lead, visit and deal forms) |
| `GET /api/properties?scope=mine`             | The signed-in agent's inventory                                          |
| `GET /api/properties?scope=agent&agent=<id>` | One agent's inventory (administrators)                                   |
| `GET /api/properties/:id`                    | Full record, owner contact where allowed, and `can_edit`                 |
| `POST /api/properties`                       | Create: company for administrators, private for agents                   |
| `PATCH /api/properties/:id`                  | Change sent fields; optional `expected_updated_at` refuses overwriting   |
| `DELETE /api/properties/:id`                 | Delete if unlinked (409 when leads, visits or deals use it)              |
| `GET /api/properties/:id/photos`             | Signed 60-second picture links                                           |
| `POST /api/properties/:id/photos`            | Upload one picture (ownership checked before Storage)                    |
| `PUT /api/properties/:id/photos/order`       | `{ "photo_ids": [...] }`, cover first                                    |
| `DELETE /api/properties/:id/photos/:photo`   | Remove a picture; the file is queued and removed                         |
| `GET /api/inventory/summary`                 | Counts for the signed-in account                                         |
| `GET /api/inventory/agents?search=&page=`    | Agent directory with counts (administrators)                             |

List filters: `search`, `type`, `purpose`, `status`, `city`, `min_price`, `max_price`, `sort` (`newest`, `oldest`, `price_low`, `price_high`, `updated`, `title`), `page`, `limit` (up to 100) and `covers=true` for card pictures.

Status codes: 400 for invalid input, 403 for a read-only property, 404 for a missing or another agent's property, 409 for linked records, a stale edit or the picture limit, and 503 with "Inventory needs CRM database update 041 after 040." until the migration is applied.

## Security notes

- The browser still has no direct table access (migration 009). The API's service-role client calls functions that check the signed-in actor themselves, so a forgotten route check cannot expose another agent's data.
- Agent responses keep the CRM's phone masking for free text. Owner phone fields are returned unmasked only where the database allowed them.
- Pictures stay in the existing private `property-photos` bucket, under `<property id>/<random id>`. Uploads check the file's real image signature, and deleted pictures go through the existing durable cleanup queue, which `npm run jobs` retries.
- A deleted agent's private properties stay readable by administrators. Ownership is never transferred automatically.

## Applying the update and deploying

Nothing has been applied to the hosted Supabase project. Follow the production-only runbook, [PROPERTY_INVENTORY_RELEASE.md](PROPERTY_INVENTORY_RELEASE.md): read-only preflight (`supabase/check-property-inventory.sql`), verified backup, migration 041 in the SQL Editor, then the application release, the production smoke checklist and the rollback rules.

Apply 041 **before** the new application goes live: the current release keeps working on the 041 schema, but the new release answers property requests with "Inventory needs CRM database update 041 after 040." until 041 is installed. No new environment variable, Storage bucket, Storage policy or dependency is needed. For a brand-new project, the regenerated `supabase/setup.sql` includes 041; never run it against the existing project.

## Tests

- `server/tests/inventory.test.js` runs API requests against all 41 migrations in PGlite (real Postgres). It covers creation and ownership, cross-agent isolation (404), read-only company and agent inventories (403), owner spoofing, stale edits, filters, sorting, paging, owner-contact sharing, phone masking, linking rules, the directory, statistics, deleted agents, pictures (upload, order, cover, removal queue, rejected files), browser-role privileges, inactive accounts and running the migration twice. Only Supabase Storage is an in-memory stand-in.
- `server/tests/property-deletion.test.js` was updated: agents now reach the database, which refuses deleting company properties.
- `client/tests/inventory.test.jsx` covers tabs per role, statistics, the agent directory and read-only agent view, filters reaching the API, plot and purpose rules in the form, owner contact sharing and conflict-safe editing. `properties.test.jsx` and `property-pictures.test.jsx` now run against the Inventory page.
- `server/tests/inventory-migration.test.js` applies 041 to a database at 040 holding existing properties, pictures and linked leads, visits and deals. Every existing row and link stays unchanged, the previous release's property calls keep working, a rerun changes nothing, and a database with unexpected property rules is refused with nothing changed. It also checks the preflight script's results before and after.
- Hosted Supabase behavior is **not yet verified**. It is checked by the production smoke checklist in the runbook after the approved migration.

## Not included in this version

- Administrators cannot edit or delete agent-owned properties, and ownership cannot be transferred.
- If an agent with properties is made an administrator, those properties stay in that person's agent inventory, visible under Agent inventories and read-only.
- Agent-owned properties cannot be linked to leads, visits or deals.
- Supporting documents per property (the Documentation & policies module's Property Deeds category remains the place for deeds).
- No exports of inventory yet.
- Filtering or searching the inventory by building category (update 046).
- Currencies other than PKR and countries other than Pakistan.
- `server/src/services/propertyCovers.js` and SQL `property_cover_photos` (027) are no longer used by the API (list covers come from `inventory_page`). They are kept with their existing tests and can be removed later.
