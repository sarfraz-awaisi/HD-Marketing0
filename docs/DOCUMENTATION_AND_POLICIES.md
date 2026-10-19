# Documentation and policies

**Documentation & policies** is available in both portals. Active administrators can create, update and delete entries and attachments. Active agents can read shared categories and **Client KYC linked to their currently assigned leads**. Older unlinked KYC is administrator-only. Ownership checks cover lists, search, counts, detail, attachment lists and downloads; unauthorized KYC returns 404. New requests follow current ownership, while previously downloaded copies cannot be recalled.

## Existing Supabase setup

Migration `015_documentation_and_policies.sql` creates the entry/attachment tables, private `knowledge-files` bucket, cleanup queue and protected audited mutations. It must be installed after migration 014. Install migration `016_accounts_and_security.sql` next if it has not already been applied.

For an existing installation with migrations 015 and 016 already applied, install `017_document_categories.sql` once to enable the categories, property names, keywords and expanded search. Existing entries, attachments and categories are retained. Existing policies are displayed as **Agency Policy**; general documentation stays under **Documentation**.

In the project terminal on macOS:

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
pbcopy < supabase/migrations/017_document_categories.sql
```

Open the existing project's **Supabase → SQL Editor → New query**, paste and click **Run**. `Success. No rows returned` is expected. Refresh the CRM afterward. If migrations 015 or 016 are missing, copy and run those files first in order. The latest ownership rules also require **022_agent_offboarding_and_kyc_access.sql**, after completing earlier migrations through 021. [Back up first and follow the current upgrade guide](../CHANGES_OFFBOARDING_AND_KYC.md). Do not run the fresh-install setup against an existing database. New projects use the regenerated `supabase/setup.sql`, which contains all 22 migrations.

## Administrator workflow

1. Open **Documentation & policies → Add entry**.
2. Enter a title and choose **Property Deeds, Legal & NOC, Agency Policy, Client KYC, Tenancy Agreements** or **Documentation**. Enter the written content; for a file-oriented entry, write a brief description in Content. Optionally add **Property name** and **Keywords** so the team can find it through search.
3. Optionally click **Add files** and select one or more `.pdf`, `.doc` or `.docx` files, up to **10 MB each**. Remove unwanted selections before saving.
4. Click **Save entry**. The written entry is saved before sequential attachment uploads. Selecting files or closing an unsaved form does not create an entry.
5. Use **Edit** to update the title, category, property name, keywords, content or add files. Use the reading page's **Delete file** to remove an existing attachment. **Delete** removes the whole entry and its attachments after confirmation.

Titles and property names allow 200 characters, keywords allow 500, and content allows 50,000. Property name is an optional text label and does not require linking an existing CRM property. Content preserves paragraphs and line breaks and is displayed as text. Uploaded file contents are not extracted for search or rendered as HTML. PDF and Word attachments download in their original file format.

**Client KYC requires Client (lead).** Search by customer name and choose the correct CRM lead; the picker shows masked phone numbers only. Saved KYC displays the linked client's name. For old records, check **KYC not linked to a client**, edit each entry and select its client. New attachments also require that link. Other categories retain their team-wide behavior.

A failed entry save retains inputs and selections and uploads nothing. A later file failure reports that the entry already exists and retains only pending files; saving again updates that same entry and retries remaining attachments. Existing successfully attached files remain available. Pending saves and deletions prevent repeated submission and modal dismissal. Closing after a partial failure discards pending selections while preserving the saved entry and completed files.

## Agent workflow

Open the sidebar section and use **All, Property Deeds, Legal & NOC, Agency Policy, Client KYC, Tenancy Agreements** or **Documentation** to filter entries. Search matches the title, property name, keywords and written content, without regard to case. Search and the selected category work together across all entries before pagination. Click a title or **Read entry**, then use **Download** for attachments. Agents have no create/edit/delete controls, and direct API attempts to mutate entries or files return 403. Disabled or unauthenticated accounts cannot read or download.

An agent sees Client KYC only for their currently assigned customers, including in search/counts. The client profile also has a **KYC documents** section with linked entries and file downloads. Losing assignment removes access on the next request. Non-KYC guidance remains available to the active team.

## Storage and permissions

- Entry and attachment changes and their safe audit records commit in the same SQL transaction. Functions independently recheck the active administrator; failures roll back metadata, updates and deletion queues.
- Browser roles have no direct table/RPC grants or bucket policies. The server handles authenticated reads and downloads. Downloads are audited before Storage is read, force attachment disposition and use no-store responses; Storage paths are not included in page metadata.
- Uploads validate the extension, MIME type, size and format structure: PDF header/end marker, legacy Word's OLE WordDocument stream, or a bounded DOCX ZIP directory containing Word parts. DOCX directories are inspected without decompression; encrypted packages, malformed directories, excessive expansion declarations, unsafe paths and DOCX macro packages are rejected. These format checks are not a malware scanning service.
- A durable reservation is written before an upload. Successful attachment transactions remove it; failed or interrupted work remains eligible for cleanup. Stale reservations expire after one hour. Deleting entries or files queues Storage removal immediately. The request attempts cleanup, and `npm run jobs` retries remaining queue rows if Storage is unavailable.

## API and implementation

- `GET /api/documents`: bounded pagination, literal search and category filtering after ownership scope; optional `lead_id` and administrator-only `unlinked_kyc=true`. List results omit content and Storage paths.
- `GET /api/documents/clients`: administrator-only name search or selected-ID lookup; returns only IDs, names and masked phones for the picker.
- `GET /api/documents/:id`: authorized written entry and safe attachment metadata; unauthorized KYC is 404.
- `POST /api/documents` and `PATCH /api/documents/:id`: administrator-only strict `{title, category, content}` with optional `property_name`, `keywords` and `lead_id`. Client KYC requires an existing lead; updates can retain their existing link. Other categories clear the link.
- `DELETE /api/documents/:id`: administrator-only transactional deletion and attachment cleanup queueing.
- `POST /api/documents/:id/files`: administrator-only multipart `file`, maximum 10 MB.
- `DELETE /api/documents/:id/files/:file`: administrator-only attachment removal.
- `GET /api/documents/:id/files/:file/download`: authorized binary download; verifies the entry/file relationship and current KYC owner, atomically audits before Storage access and checks ownership again before returning bytes.

API category values are `property_deeds`, `legal_noc`, `policy` (displayed as Agency Policy), `client_kyc`, `tenancy_agreements` and `documentation`. The existing `policy` value is retained for compatibility.

The shared page is `client/src/pages/shared/Documentation.jsx`, with category labels in `client/src/lib/documentCategories.js`. Routes are in `server/src/routes/documents.routes.js`; format checks are in `server/src/services/documentFiles.js`; durable cleanup is `server/src/jobs/cleanupKnowledgeFiles.js`. No new dependency was required; legacy Word container validation reuses the existing spreadsheet package's CFB reader.

SQL/API and UI tests cover permissions, private access, strict inputs, rollback, real file formats, search/pagination, downloads, cleanup retries, cancellation, pending controls, safe text rendering and partial uploads. Browser verification uses actual local API/SQL with isolated Auth and Storage, and does not read or mutate hosted CRM records. Real-account Storage acceptance and separate-connection concurrency remain deployment checks.
