import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  readSheetRow,
  sheetPhone,
  spreadsheetId,
  submittedAt,
} from "../src/services/sheetsImport.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 056: leads from Meta Lead Ads' Google Sheets. One Sheet is one lead
// file for good; the database's record of each Sheet's Meta lead IDs keeps a
// retry, an overlapping run or a reordered Sheet from importing a row twice;
// bad rows are rejected one by one; a number the CRM already has becomes a
// repeat inquiry and the lead is left as it is; only the integration key gets
// in, and only administrators manage it.
const admin = "56000000-0000-4000-8000-000000000001",
  ali = "56000000-0000-4000-8000-000000000002",
  sara = "56000000-0000-4000-8000-000000000003",
  staff = "56000000-0000-4000-8000-000000000004";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@gmail.com',now())",
    [staff],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name='Sam Staff' where id=$1",
    [staff],
  );
});
afterEach(() => vi.unstubAllEnvs());
const app = (options) => createApp(trustedMfaFixture(db), options);
const as = (user) => ({ Authorization: "Bearer " + user });
const sheetId = (n) => `1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_${n}`;
// A row as Meta Lead Ads write it to a Sheet.
const submission = (n, extra = {}) => ({
  id: `l:${7100000000000000 + n}`,
  created_time: "2026-11-01T10:15:30+0500",
  ad_id: "ag:120200000000001",
  ad_name: "DHA Phase 9 plots",
  adset_id: "as:120200000000002",
  adset_name: "Lahore 25-45",
  campaign_id: "c:120200000000003",
  campaign_name: "November plots",
  form_id: "f:120200000000004",
  form_name: "Plot inquiry",
  is_organic: "false",
  platform: "fb",
  "what_are_you_interested_in?_": "residential_plot",
  "what_is_your_preferred_investment_budget?_": "50_lakh_to_1_crore",
  full_name: `Buyer ${n}`,
  phone_number: `p:+92300${String(n).padStart(7, "0")}`,
  email: `buyer${n}@example.com`,
  city: "Lahore",
  lead_status: "CREATED",
  ...extra,
});
const sheetRows = (list, first = 2) =>
  list.map((values, i) => ({ row: first + i, values }));
async function setUp(server, names = ["Ad 1", "Ad 2", "Ad 3"]) {
  const key = (
    await request(server)
      .post("/api/integrations/sheets/key")
      .set(as(admin))
      .send({})
      .expect(201)
  ).body.key;
  const sources = [];
  for (const [i, name] of names.entries())
    sources.push(
      (
        await request(server)
          .post("/api/integrations/sheets/sources")
          .set(as(admin))
          .send({
            name,
            spreadsheet: `https://docs.google.com/spreadsheets/d/${sheetId(i)}/edit#gid=0`,
            worksheet: "Sheet1",
            enabled: true,
            confirm_history: true,
          })
          .expect(201)
      ).body.id,
    );
  return { key, sources };
}
const sync = (server, key) => ({
  sources: () =>
    request(server).get("/api/integrations/sheets-sync/sources").set(as(key)),
  pending: (source, ids) =>
    request(server)
      .post(`/api/integrations/sheets-sync/sources/${source}/pending`)
      .set(as(key))
      .send({ ids }),
  rows: (source, rows) =>
    request(server)
      .post(`/api/integrations/sheets-sync/sources/${source}/rows`)
      .set(as(key))
      .send({ rows }),
  report: (source, report) =>
    request(server)
      .post(`/api/integrations/sheets-sync/sources/${source}/report`)
      .set(as(key))
      .send(report),
});
const statuses = (body) => body.rows.map((r) => r.status);
const leadsOf = (importId) =>
  all(
    "select l.name,l.source,l.assigned_agent,l.meta_pending_assignment,r.file_row from leads l join crm_private.lead_file_rows r on r.lead_id=l.id where l.import_id=$1 order by r.file_row",
    [importId],
  );
const overview = async (server) =>
  (
    await request(server)
      .get("/api/integrations/sheets")
      .set(as(admin))
      .expect(200)
  ).body;

describe("reading a Sheet row", () => {
  it("reads Meta's columns by heading, in any order, with numbers kept as text", () => {
    const row = readSheetRow({
      row: 5,
      values: {
        "Phone Number": "923001234567",
        "Full Name": "  Ayesha   Khan ",
        city: "Karachi",
        "what_are_you_interested_in?_": "apartment",
        ID: "71000000001",
        preferred_contact_time: "evening",
        platform: "ig",
      },
    });
    expect(row).toMatchObject({
      row: 5,
      meta_lead_id: "71000000001",
      phone: "+923001234567",
      lead: { name: "Ayesha Khan", email: null, preferred_location: "Karachi" },
      inquiry: {
        platform: "instagram",
        interest: "apartment",
        budget: null,
        submitted_at: null,
        extra: { preferred_contact_time: "evening" },
      },
    });
    // The phone number stays out of the kept values.
    expect(JSON.stringify(row.inquiry)).not.toContain("923001234567");
    expect(row.inquiry.answers).toMatchObject({ "Full Name": "Ayesha   Khan" });
  });
  it("reads Meta's phone and time formats", () => {
    expect(sheetPhone("p:+923001234567")).toBe("+923001234567");
    expect(sheetPhone("03001234567")).toBe("+923001234567");
    // A Pakistani mobile whose leading zero the number cell dropped.
    expect(sheetPhone("3001234567")).toBe("+923001234567");
    expect(sheetPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(() => sheetPhone("not given")).toThrow();
    expect(submittedAt("2026-11-01T10:15:30+0500")).toBe(
      "2026-11-01T05:15:30.000Z",
    );
    expect(submittedAt("2026-11-01T05:15:30.000Z")).toBe(
      "2026-11-01T05:15:30.000Z",
    );
    expect(submittedAt("2026-11-01 10:15")).toBe("2026-11-01T05:15:00.000Z");
    expect(submittedAt("11/01/2026")).toBeNull();
    expect(
      spreadsheetId(
        `https://docs.google.com/spreadsheets/d/${sheetId(1)}/edit`,
      ),
    ).toBe(sheetId(1));
    expect(spreadsheetId("https://example.com/")).toBeNull();
  });
  it("rejects a row that cannot be a lead, with the reason", () => {
    const read = (values) => readSheetRow({ row: 2, values });
    expect(read({ ...submission(1), id: "" })).toEqual({
      row: 2,
      meta_lead_id: null,
      error: "id_invalid",
    });
    expect(read({ ...submission(1), full_name: " " }).error).toBe(
      "name_missing",
    );
    expect(read({ ...submission(1), phone_number: "p:12" }).error).toBe(
      "phone_invalid",
    );
    expect(read({ ...submission(1), email: "not an email" }).lead.email).toBe(
      null,
    );
  });
});

describe("Google Sheets import (update 056)", () => {
  it("imports three Sheets into three lead files, and a fourth Sheet the same way", async () => {
    const server = app();
    const { key, sources } = await setUp(server);
    const crm = sync(server, key);
    for (const [i, source] of sources.entries()) {
      const body = (
        await crm
          .rows(
            source,
            sheetRows([submission(i * 10 + 1), submission(i * 10 + 2)]),
          )
          .expect(200)
      ).body;
      expect(body.summary).toMatchObject({ inserted: 2, failed: 0 });
    }
    const files = await all(
      "select s.name,s.import_id,f.file_name,f.file_format,f.imported_count from sheet_sources s join lead_imports f on f.id=s.import_id order by s.created_at",
    );
    expect(
      files.map((f) => [f.file_name, f.file_format, f.imported_count]),
    ).toEqual([
      ["Ad 1", "sheets", 2],
      ["Ad 2", "sheets", 2],
      ["Ad 3", "sheets", 2],
    ]);
    expect(new Set(files.map((f) => f.import_id)).size).toBe(3);
    // Meta leads in the Sheet's file, numbered by row, waiting for an
    // administrator to assign them.
    expect(await leadsOf(files[1].import_id)).toEqual([
      {
        name: "Buyer 11",
        source: "Meta",
        assigned_agent: null,
        meta_pending_assignment: false,
        file_row: 1,
      },
      {
        name: "Buyer 12",
        source: "Meta",
        assigned_agent: null,
        meta_pending_assignment: false,
        file_row: 2,
      },
    ]);
    // A fourth Sheet is configuration only.
    const fourth = (
      await request(server)
        .post("/api/integrations/sheets/sources")
        .set(as(admin))
        .send({
          name: "Ad 4",
          spreadsheet: sheetId(4),
          worksheet: "Leads",
          enabled: true,
          confirm_history: true,
        })
        .expect(201)
    ).body.id;
    expect(
      (await crm.sources().expect(200)).body.sources.map((s) => s.name),
    ).toEqual(["Ad 1", "Ad 2", "Ad 3", "Ad 4"]);
    expect(
      (await crm.rows(fourth, sheetRows([submission(41)])).expect(200)).body
        .summary.inserted,
    ).toBe(1);
    expect(
      (await one("select count(distinct import_id)::int n from sheet_sources"))
        .n,
    ).toBe(4);
    // Renaming the Sheet renames its file; it is still the same file.
    await request(server)
      .patch(`/api/integrations/sheets/sources/${sources[0]}`)
      .set(as(admin))
      .send({ name: "DHA plots (November)" })
      .expect(200);
    expect(
      await one(
        "select f.id=$1 same,f.file_name from sheet_sources s join lead_imports f on f.id=s.import_id where s.id=$2",
        [files[0].import_id, sources[0]],
      ),
    ).toEqual({ same: true, file_name: "DHA plots (November)" });
    // The same tab twice would split one Sheet over two files.
    expect(
      (
        await request(server)
          .post("/api/integrations/sheets/sources")
          .set(as(admin))
          .send({ name: "Copy", spreadsheet: sheetId(0), worksheet: "sheet1" })
          .expect(409)
      ).body.error,
    ).toBe("This tab of this spreadsheet is already a Sheet in the CRM");
  });

  it("never imports a row twice: repeated syncs, retries and repeated IDs", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    const first = sheetRows([submission(1), submission(2), submission(3)]);
    expect(
      statuses((await crm.rows(sources[0], first).expect(200)).body),
    ).toEqual(["inserted", "inserted", "inserted"]);
    // The reply was lost and the script sends the same rows again.
    expect(
      statuses((await crm.rows(sources[0], first).expect(200)).body),
    ).toEqual(["duplicate", "duplicate", "duplicate"]);
    // New rows at the bottom: only they are pending.
    const ids = [1, 2, 3, 4, 5].map((n) => submission(n).id);
    expect(
      (await crm.pending(sources[0], ids).expect(200)).body.pending,
    ).toEqual([3, 4]);
    // One Meta lead ID twice in the Sheet: imported once.
    const next = sheetRows(
      [submission(4), submission(5), submission(4, { full_name: "Copy" })],
      5,
    );
    expect(
      statuses((await crm.rows(sources[0], next).expect(200)).body),
    ).toEqual(["inserted", "inserted", "duplicate"]);
    // Two runs at once.
    const later = sheetRows([submission(6), submission(7)], 8);
    const [a, b] = await Promise.all([
      crm.rows(sources[0], later),
      crm.rows(sources[0], later),
    ]);
    expect([...statuses(a.body), ...statuses(b.body)].sort()).toEqual([
      "duplicate",
      "duplicate",
      "inserted",
      "inserted",
    ]);
    expect((await one("select count(*)::int n from leads")).n).toBe(7);
    expect(
      (await one("select count(*)::int n from crm_private.sheet_lead_receipts"))
        .n,
    ).toBe(7);
    expect(
      (await crm.pending(sources[0], ids).expect(200)).body.pending,
    ).toEqual([]);
  });

  it("rejects bad rows one by one, imports the rest, and imports a row once it is fixed", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    const batch = sheetRows([
      submission(1),
      { ...submission(2), id: "" },
      { ...submission(3), phone_number: "p:" },
      { ...submission(4), full_name: "" },
      // Reordered, with a column the CRM does not map and no email or city.
      {
        preferred_contact_time: "after 6 pm",
        phone_number: "3005550005",
        full_name: "Buyer 5",
        id: submission(5).id,
      },
    ]);
    const body = (await crm.rows(sources[0], batch).expect(200)).body;
    expect(body.rows).toEqual([
      { row: 2, status: "inserted" },
      { row: 3, status: "rejected", reason: "id_invalid" },
      { row: 4, status: "rejected", reason: "phone_missing" },
      { row: 5, status: "rejected", reason: "name_missing" },
      { row: 6, status: "inserted" },
    ]);
    const [source] = (await overview(server)).sources;
    expect(source).toMatchObject({ new_leads: 2, rejected: 3, unassigned: 2 });
    expect(
      (
        await request(server)
          .get(`/api/integrations/sheets/sources/${sources[0]}/rejections`)
          .set(as(admin))
          .expect(200)
      ).body.map((r) => [r.row, r.reason]),
    ).toEqual([
      [3, "id_invalid"],
      [4, "phone_missing"],
      [5, "name_missing"],
    ]);
    expect(
      await one(
        "select imported_count,rejected_count,total_rows from lead_imports where id=$1",
        [source.import_id],
      ),
    ).toEqual({ imported_count: 2, rejected_count: 3, total_rows: 5 });
    // The next pass: row 4 was fixed in the Sheet and row 5 deleted from it.
    const since = (await crm.sources().expect(200)).body.now;
    await crm
      .rows(sources[0], [
        { row: 4, values: submission(3) },
        { row: 3, values: { ...submission(2), id: "" } },
      ])
      .expect(200);
    await crm
      .report(sources[0], { ok: true, complete: true, rows: 4, since })
      .expect(200);
    expect(
      (
        await request(server)
          .get(`/api/integrations/sheets/sources/${sources[0]}/rejections`)
          .set(as(admin))
      ).body.map((r) => r.row),
    ).toEqual([3]);
    expect((await overview(server)).sources[0]).toMatchObject({
      new_leads: 3,
      rejected: 1,
      sheet_rows: 4,
      last_error_code: null,
    });
    const fifth = await one(
      "select l.email,l.preferred_location,i.extra,i.answers from leads l join crm_private.sheet_lead_inquiries i on i.lead_id=l.id where l.name='Buyer 5'",
    );
    expect(fifth).toEqual({
      email: null,
      preferred_location: null,
      extra: { preferred_contact_time: "after 6 pm" },
      answers: {
        preferred_contact_time: "after 6 pm",
        full_name: "Buyer 5",
        id: submission(5).id,
      },
    });
  });

  it("saves nothing from a failed batch, so it can be sent again", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const keyHash = (
      await one(
        "select key_hash from crm_private.sheet_sync_keys where revoked_at is null",
      )
    ).key_hash;
    const good = sheetRows([submission(1), submission(2)]).map(readSheetRow);
    // The batch fails part-way (a row the database refuses): none of it stays.
    const { error } = await db.rpc("sheet_sync_import", {
      p_key_hash: keyHash,
      p_source: sources[0],
      p_rows: [
        ...good,
        { row: 9, meta_lead_id: "7100", phone: "12", lead: {}, inquiry: {} },
      ],
      p_request: "test",
    });
    expect(error.code).toBe("22023");
    expect(
      await one(
        "select (select count(*)::int from leads) leads,(select count(*)::int from crm_private.sheet_lead_receipts) receipts,(select count(*)::int from lead_imports) files",
      ),
    ).toEqual({ leads: 0, receipts: 0, files: 0 });
    const crm = sync(server, key);
    expect(
      statuses(
        (
          await crm
            .rows(sources[0], sheetRows([submission(1), submission(2)]))
            .expect(200)
        ).body,
      ),
    ).toEqual(["inserted", "inserted"]);
  });

  it("keeps a number the CRM already has as a repeat inquiry and leaves the lead as it is", async () => {
    const server = app();
    const lead = (
      await one("select (create_lead($1::jsonb,'+923000000001',$2,'t')).id", [
        JSON.stringify({ name: "Bilal (corrected)", assigned_agent: ali }),
        admin,
      ])
    ).id;
    await pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      lead,
      ali,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 3600e3).toISOString(),
        duration_seconds: 60,
        outcome: "Interested",
        notes: "Wants a corner plot",
        deal_tags: ["Hot lead"],
      }),
    ]);
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Call after Friday')",
      [lead, ali],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 day')",
      [lead, ali],
    );
    await pg.query("update leads set status='interested' where id=$1", [lead]);
    const snapshot = () =>
      one(
        "select to_jsonb(l) lead,(select jsonb_agg(to_jsonb(c) order by c.id) from calls c where c.lead_id=l.id) calls,(select jsonb_agg(to_jsonb(n) order by n.id) from notes n where n.lead_id=l.id) notes,(select jsonb_agg(to_jsonb(f) order by f.id) from followups f where f.lead_id=l.id) followups,(select jsonb_agg(to_jsonb(a) order by a.id) from assignments a where a.lead_id=l.id) assignments,(select jsonb_agg(to_jsonb(h) order by h.id) from lead_status_history h where h.lead_id=l.id) history,(select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.entity_id=l.id::text) audit from leads l where l.id=$1",
        [lead],
      );
    const before = await snapshot();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const body = (
      await sync(server, key)
        .rows(
          sources[0],
          sheetRows([submission(1, { full_name: "Bilal" }), submission(2)]),
        )
        .expect(200)
    ).body;
    expect(statuses(body)).toEqual(["existing", "inserted"]);
    expect(await snapshot()).toEqual(before);
    // On the lead page, for the administrator and the lead's agent.
    for (const user of [admin, ali]) {
      const inquiries = (
        await request(server)
          .get(`/api/leads/${lead}/inquiries`)
          .set(as(user))
          .expect(200)
      ).body;
      expect(inquiries).toEqual([
        expect.objectContaining({
          source: "Ad 1",
          repeat: true,
          full_name: "Bilal",
          platform: "facebook",
          ad_name: "DHA Phase 9 plots",
          campaign_name: "November plots",
          interest: "residential_plot",
          budget: "50_lakh_to_1_crore",
          city: "Lahore",
        }),
      ]);
      expect(new Date(inquiries[0].submitted_at).toISOString()).toBe(
        "2026-11-01T05:15:30.000Z",
      );
      expect(JSON.stringify(inquiries)).not.toMatch(
        /3000000001|lead_status|CREATED/,
      );
    }
    await request(server)
      .get(`/api/leads/${lead}/inquiries`)
      .set(as(sara))
      .expect(404);
    await request(server)
      .get(`/api/leads/${lead}/inquiries`)
      .set(as(staff))
      .expect(403);
    expect((await overview(server)).sources[0]).toMatchObject({
      new_leads: 1,
      repeat_inquiries: 1,
    });
    // A number in Deleted leads waits until the lead is restored.
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    const deleted = (
      await sync(server, key)
        .rows(sources[0], sheetRows([submission(1, { id: "l:7199" })], 9))
        .expect(200)
    ).body.rows[0];
    expect(deleted).toMatchObject({
      row: 9,
      status: "rejected",
      reason: "lead_deleted",
    });
    expect(deleted.lead_no).toMatch(/^HD-\d{6}$/);
  });

  it("leaves out rows submitted before the Sheet's start date", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    await request(server)
      .patch(`/api/integrations/sheets/sources/${sources[0]}`)
      .set(as(admin))
      .send({ import_from: "2026-11-01" })
      .expect(200);
    const from = (await sync(server, key).sources().expect(200)).body.sources[0]
      .import_from;
    expect(new Date(from).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    const body = (
      await sync(server, key)
        .rows(
          sources[0],
          sheetRows([
            submission(1, { created_time: "2026-10-31T23:59:00+0500" }),
            submission(2, { created_time: "2026-11-01T00:00:00+0500" }),
            submission(3, { created_time: "" }),
          ]),
        )
        .expect(200)
    ).body;
    expect(body.rows).toEqual([
      { row: 2, status: "skipped" },
      { row: 3, status: "inserted" },
      { row: 4, status: "rejected", reason: "date_missing" },
    ]);
  });

  it("never replaces a deleted lead file on its own", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    await crm.rows(sources[0], sheetRows([submission(1)])).expect(200);
    const file = (await overview(server)).sources[0].import_id;
    await pg.query(
      "select delete_lead_import($1,$2,'file_and_leads','Wrong advertisement','t')",
      [file, admin],
    );
    expect(
      (await crm.rows(sources[0], sheetRows([submission(2)], 3)).expect(409))
        .body.code,
    ).toBe("SHEETS_FILE_DELETED");
    expect((await overview(server)).sources[0]).toMatchObject({
      import_id: file,
      file_deleted: true,
      last_error_code: "file_deleted",
    });
    expect((await one("select count(*)::int n from lead_imports")).n).toBe(1);
    // The administrator chooses a new file; imported rows stay imported.
    await request(server)
      .post(`/api/integrations/sheets/sources/${sources[0]}/new-file`)
      .set(as(admin))
      .send({})
      .expect(200);
    expect(
      statuses(
        (
          await crm
            .rows(sources[0], sheetRows([submission(1), submission(2)]))
            .expect(200)
        ).body,
      ),
    ).toEqual(["duplicate", "inserted"]);
    const now = (await overview(server)).sources[0];
    expect(now.import_id).not.toBe(file);
    expect(now).toMatchObject({ file_deleted: false, last_error_code: null });
  });

  it("never imports a lead deleted for good again, and erases what the customer submitted", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    await crm.rows(sources[0], sheetRows([submission(1)])).expect(200);
    const lead = (await one("select id from leads")).id;
    await pg.query(
      "select delete_leads($1,$2,'Customer asked to be removed','t')",
      [[lead], admin],
    );
    await pg.query(
      "update leads set deleted_at=now()-interval '31 days' where id=$1",
      [lead],
    );
    await pg.query("delete from crm_private.lead_purge_runs");
    expect((await one("select purge_deleted_leads(30) r")).r).toEqual({
      purged: 1,
    });
    expect(
      await one(
        "select (select count(*)::int from crm_private.sheet_lead_inquiries) inquiries,(select count(*)::int from crm_private.sheet_lead_receipts where lead_id is null) receipts",
      ),
    ).toEqual({ inquiries: 0, receipts: 1 });
    expect(
      statuses(
        (await crm.rows(sources[0], sheetRows([submission(1)])).expect(200))
          .body,
      ),
    ).toEqual(["duplicate"]);
  });

  it("lets in only the integration key, over HTTPS", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    for (const header of [
      {},
      as("not-a-key"),
      as(admin),
      as("hdcrm_sheets_" + "A".repeat(43)),
    ]) {
      const response = await request(server)
        .post(`/api/integrations/sheets-sync/sources/${sources[0]}/rows`)
        .set(header)
        .send({ rows: sheetRows([submission(1)]) })
        .expect(401);
      expect(response.body).toMatchObject({
        error: "Invalid integration key.",
        code: "SHEETS_INVALID_KEY",
      });
    }
    // A user's sign-in is not an integration key, and the key is not a
    // sign-in.
    await request(server).get("/api/me").set(as(key)).expect(401);
    // A turned-off Sheet takes nothing.
    await request(server)
      .patch(`/api/integrations/sheets/sources/${sources[0]}`)
      .set(as(admin))
      .send({ enabled: false })
      .expect(200);
    expect(
      (
        await sync(server, key)
          .rows(sources[0], sheetRows([submission(1)]))
          .expect(409)
      ).body.code,
    ).toBe("SHEETS_SOURCE_UNAVAILABLE");
    expect(
      (await sync(server, key).sources().expect(200)).body.sources,
    ).toEqual([]);
    await request(server)
      .patch(`/api/integrations/sheets/sources/${sources[0]}`)
      .set(as(admin))
      .send({ enabled: true })
      .expect(200);
    // HTTPS only in production (Nginx reports the scheme).
    vi.stubEnv("NODE_ENV", "production");
    expect((await sync(server, key).sources().expect(403)).body.code).toBe(
      "SHEETS_HTTPS_REQUIRED",
    );
    await sync(server, key)
      .sources()
      .set("X-Forwarded-Proto", "https")
      .expect(200);
    vi.unstubAllEnvs();
    // A new key replaces the old one at once; revoking stops everything.
    const replaced = (
      await request(server)
        .post("/api/integrations/sheets/key")
        .set(as(admin))
        .send({})
        .expect(201)
    ).body;
    expect(replaced).toMatchObject({
      replaced: true,
      hint: replaced.key.slice(-4),
    });
    await sync(server, key).sources().expect(401);
    await sync(server, replaced.key).sources().expect(200);
    // The key acts as the administrator who created it, while they are one.
    await pg.query("update profiles set role='agent' where id=$1", [admin]);
    expect(
      (await sync(server, replaced.key).sources().expect(403)).body.code,
    ).toBe("SHEETS_KEY_OWNER_INACTIVE");
    await pg.query("update profiles set role='admin' where id=$1", [admin]);
    await request(server)
      .delete("/api/integrations/sheets/key")
      .set(as(admin))
      .expect(200);
    await sync(server, replaced.key).sources().expect(401);
    expect((await overview(server)).key).toBeNull();
    // Only the hash is kept.
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.sheet_sync_keys where key_hash in ($1,$2)",
          [key, replaced.key],
        )
      ).n,
    ).toBe(0);
  });

  it("limits refused keys per address", async () => {
    const server = app({ rateLimits: { sheetsSyncAuth: 3 } });
    for (let n = 0; n < 3; n++)
      await request(server)
        .get("/api/integrations/sheets-sync/sources")
        .set(as("wrong"))
        .expect(401);
    await request(server)
      .get("/api/integrations/sheets-sync/sources")
      .set(as("wrong"))
      .expect(429);
  });

  it("lets only administrators manage Google Sheets", async () => {
    const server = app();
    for (const user of [ali, staff]) {
      await request(server)
        .get("/api/integrations/sheets")
        .set(as(user))
        .expect(403);
      await request(server)
        .post("/api/integrations/sheets/sources")
        .set(as(user))
        .send({ name: "Mine", spreadsheet: sheetId(9), worksheet: "Sheet1" })
        .expect(403);
      await request(server)
        .post("/api/integrations/sheets/key")
        .set(as(user))
        .send({})
        .expect(403);
      await request(server)
        .delete("/api/integrations/sheets/key")
        .set(as(user))
        .expect(403);
    }
    // And in the database.
    for (const [name, args] of [
      ["sheet_sources_overview", { p_actor: ali }],
      [
        "sheet_source_save",
        {
          p_actor: ali,
          p_source: null,
          p_data: { name: "x", spreadsheet_id: sheetId(9), worksheet: "a" },
          p_request: "t",
        },
      ],
      [
        "sheet_sync_key_create",
        {
          p_actor: ali,
          p_hash: "a".repeat(64),
          p_hint: "abcd",
          p_request: "t",
        },
      ],
    ])
      expect((await db.rpc(name, args)).error.code).toBe("42501");
    expect((await one("select count(*)::int n from sheet_sources")).n).toBe(0);
    // The overview never shows the key or its hash.
    await request(server)
      .post("/api/integrations/sheets/key")
      .set(as(admin))
      .send({})
      .expect(201);
    const view = await overview(server);
    expect(Object.keys(view.key).sort()).toEqual([
      "created_at",
      "created_by",
      "hint",
      "last_used_at",
      "owner_active",
    ]);
    // The server's own helpers are reached only through the functions.
    expect(
      (
        await one(
          "select count(*)::int n from pg_proc where proname in ('sheet_sync_owner','sheet_file_counts') and has_function_privilege('service_role',oid,'execute')",
        )
      ).n,
    ).toBe(0);
  });

  it("gives agents the imported leads through the usual assignment", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    await sync(server, key)
      .rows(sources[0], sheetRows([submission(1), submission(2)]))
      .expect(200);
    const file = (await overview(server)).sources[0].import_id;
    await request(server)
      .post(`/api/lead-imports/${file}/assign`)
      .set(as(admin))
      .send({ agent_id: ali })
      .expect(200);
    const assigned = (
      await request(server)
        .get(`/api/my-leads?import_id=${file}`)
        .set(as(ali))
        .expect(200)
    ).body;
    expect(assigned.data.map((l) => l.name).sort()).toEqual([
      "Buyer 1",
      "Buyer 2",
    ]);
    await request(server)
      .get("/api/my-leads?view=pipeline")
      .set(as(ali))
      .expect(200);
    expect(
      (
        await request(server)
          .get(`/api/my-leads?import_id=${file}`)
          .set(as(sara))
          .expect(404)
      ).body,
    ).toBeTruthy();
    // A row arriving after the file was assigned waits for an administrator.
    await sync(server, key)
      .rows(sources[0], sheetRows([submission(3)], 4))
      .expect(200);
    expect((await overview(server)).sources[0].unassigned).toBe(1);
    const lead = (await one("select id from leads where name='Buyer 1'")).id;
    expect(
      (
        await request(server)
          .get(`/api/leads/${lead}/inquiries`)
          .set(as(ali))
          .expect(200)
      ).body,
    ).toHaveLength(1);
  });

  it("records what the script reports about a Sheet", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    await crm
      .report(sources[0], { ok: false, error: "worksheet_missing" })
      .expect(200);
    expect((await overview(server)).sources[0]).toMatchObject({
      last_error_code: "worksheet_missing",
      last_sync_at: null,
    });
    await crm
      .report(sources[0], { ok: true, complete: false, rows: 10 })
      .expect(200);
    expect((await overview(server)).sources[0]).toMatchObject({
      last_error_code: "worksheet_missing",
      sheet_rows: 10,
    });
    await crm
      .report(sources[0], { ok: true, complete: true, rows: 10 })
      .expect(200);
    const after = (await overview(server)).sources[0];
    expect(after.last_error_code).toBeNull();
    expect(after.last_sync_at).toBeTruthy();
    await crm
      .report(sources[0], { ok: true, error: "read_failed" })
      .expect(400);
    await crm
      .report(sources[0], { ok: false, error: "something else" })
      .expect(400);
  });

  it("writes the audit history in plain English, with no key or customer details", async () => {
    const server = app();
    const { key, sources } = await setUp(server, ["Ad 1"]);
    await sync(server, key)
      .rows(sources[0], sheetRows([submission(1)]))
      .expect(200);
    await request(server)
      .patch(`/api/integrations/sheets/sources/${sources[0]}`)
      .set(as(admin))
      .send({ enabled: false })
      .expect(200);
    await request(server)
      .delete("/api/integrations/sheets/key")
      .set(as(admin))
      .expect(200);
    const { body } = await request(server)
      .get("/api/audit")
      .set(as(admin))
      .expect(200);
    const sheets = body.data
      .filter((e) => e.module.key === "integrations")
      .map((e) => [e.title, e.description]);
    expect(sheets).toEqual(
      expect.arrayContaining([
        [
          "Turned off the Google Sheets key",
          "Turned off the Google Sheets integration key.",
        ],
        ["Changed a Google Sheet", "Turned off the Google Sheet “Ad 1”."],
        [
          "Imported leads from a Google Sheet",
          "Imported 1 new lead from the Google Sheet “Ad 1” into the file “Ad 1”.",
        ],
        [
          "Created a lead file for a Google Sheet",
          "Created the file “Ad 1” for the Google Sheet “Ad 1”.",
        ],
        [
          "Added a Google Sheet",
          "Added the Google Sheet “Ad 1” and turned it on, confirming the import of every row already in it.",
        ],
        [
          "Created the Google Sheets key",
          "Created the Google Sheets integration key.",
        ],
      ]),
    );
    expect(JSON.stringify(body)).not.toMatch(
      /hdcrm_sheets_|key_hash|\+92300|buyer1@/,
    );
  });

  it("asks an administrator to confirm before importing rows from before the Sheet was added", async () => {
    const server = app();
    const add = (body) =>
      request(server)
        .post("/api/integrations/sheets/sources")
        .set(as(admin))
        .send({ worksheet: "Sheet1", ...body });
    const change = (id, body) =>
      request(server)
        .patch(`/api/integrations/sheets/sources/${id}`)
        .set(as(admin))
        .send(body);
    // On at once, with every row: refused without the confirmation.
    expect(
      (
        await add({
          name: "Ad 1",
          spreadsheet: sheetId(1),
          enabled: true,
        }).expect(409)
      ).body,
    ).toMatchObject({ code: "SHEETS_CONFIRM_HISTORY" });
    expect((await one("select count(*)::int n from sheet_sources")).n).toBe(0);
    // Added off, then turned on.
    const a = (await add({ name: "Ad 1", spreadsheet: sheetId(1) }).expect(201))
      .body.id;
    expect((await change(a, { enabled: true }).expect(409)).body.code).toBe(
      "SHEETS_CONFIRM_HISTORY",
    );
    expect((await overview(server)).sources[0]).toMatchObject({
      enabled: false,
      history_pending: true,
    });
    await change(a, { enabled: true, confirm_history: true }).expect(200);
    expect((await overview(server)).sources[0]).toMatchObject({
      enabled: true,
      history_pending: false,
      history_confirmed_by: "Owner",
      history_confirmed_from: null,
    });
    // Off and on again: the confirmation still covers it.
    await change(a, { enabled: false }).expect(200);
    await change(a, { enabled: true }).expect(200);
    // A start date before the Sheet was added is confirmed for that date;
    // a later date is covered, an earlier one is asked again.
    const b = (
      await add({
        name: "Ad 2",
        spreadsheet: sheetId(2),
        import_from: "2026-11-01",
        enabled: true,
        confirm_history: true,
      }).expect(201)
    ).body.id;
    await change(b, { import_from: "2026-11-05" }).expect(200);
    expect(
      (await change(b, { import_from: "2026-10-01" }).expect(409)).body.code,
    ).toBe("SHEETS_CONFIRM_HISTORY");
    await change(b, {
      import_from: "2026-10-01",
      confirm_history: true,
    }).expect(200);
    // Only new submissions (a start date after the Sheet was added): no
    // historical import to confirm.
    const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    await add({
      name: "Ad 3",
      spreadsheet: sheetId(3),
      import_from: tomorrow,
      enabled: true,
    }).expect(201);
    const audit = await all(
      "select metadata->>'history_confirmed' confirmed from audit_log where action in ('sheets.source_created','sheets.source_updated') and metadata->>'history_confirmed'='true'",
    );
    expect(audit).toHaveLength(3);
    // A Sheet turned on without the confirmation (directly in the database)
    // is never offered to the script nor imported.
    const key = (
      await request(server)
        .post("/api/integrations/sheets/key")
        .set(as(admin))
        .send({})
        .expect(201)
    ).body.key;
    const c = (await add({ name: "Ad 4", spreadsheet: sheetId(4) }).expect(201))
      .body.id;
    await pg.query("update sheet_sources set enabled=true where id=$1", [c]);
    expect(
      (await sync(server, key).sources().expect(200)).body.sources.map(
        (s) => s.name,
      ),
    ).toEqual(["Ad 1", "Ad 2", "Ad 3"]);
    expect(
      (
        await sync(server, key)
          .rows(c, sheetRows([submission(1)]))
          .expect(409)
      ).body.code,
    ).toBe("SHEETS_SOURCE_UNAVAILABLE");
    expect(
      (
        await sync(server, key)
          .pending(c, [submission(1).id])
          .expect(409)
      ).body.code,
    ).toBe("SHEETS_SOURCE_UNAVAILABLE");
  });

  it("tells the lead's agent about a repeat inquiry once, and changes nothing on the lead", async () => {
    const server = app();
    const lead = (
      await one("select (create_lead($1::jsonb,'+923000000001',$2,'t')).id", [
        JSON.stringify({ name: "Bilal Khan", assigned_agent: ali }),
        admin,
      ])
    ).id;
    const unassigned = (
      await one("select (create_lead($1::jsonb,'+923000000009',$2,'t')).id", [
        JSON.stringify({ name: "Nobody's" }),
        admin,
      ])
    ).id;
    const before = await one("select to_jsonb(l) l from leads l where id=$1", [
      lead,
    ]);
    await pg.query("delete from notifications");
    const { key, sources } = await setUp(server, ["Ad 1"]);
    const crm = sync(server, key);
    const first = sheetRows([
      submission(1, { full_name: "Bilal" }),
      submission(9),
    ]);
    expect(
      statuses((await crm.rows(sources[0], first).expect(200)).body),
    ).toEqual(["existing", "existing"]);
    const notices = () =>
      all(
        "select user_id,type,title,body,link,lead_id,item_count,read_at from notifications where type='ad_inquiry'",
      );
    const number = (
      await one("select format_lead_no(lead_no) n from leads where id=$1", [
        lead,
      ])
    ).n;
    expect(await notices()).toEqual([
      {
        user_id: ali,
        type: "ad_inquiry",
        title: `New advertisement inquiry: ${number}`,
        body: "Bilal Khan · DHA Phase 9 plots",
        link: `/leads/${lead}`,
        lead_id: lead,
        item_count: 1,
        read_at: null,
      },
    ]);
    // A retry, or the same row again, tells no one again.
    await crm.rows(sources[0], first).expect(200);
    expect((await notices())[0].item_count).toBe(1);
    // Another inquiry the same day is counted in the same notice, unread again.
    await pg.query(
      "update notifications set read_at=now() where type='ad_inquiry'",
    );
    await crm
      .rows(
        sources[0],
        sheetRows([submission(1, { id: "l:7199000000000001" })], 4),
      )
      .expect(200);
    expect(await notices()).toEqual([
      expect.objectContaining({
        title: `2 new advertisement inquiries: ${number}`,
        item_count: 2,
        read_at: null,
        lead_id: lead,
      }),
    ]);
    // The lead, its agent and status included, is unchanged; no one else is told.
    expect(
      (await one("select to_jsonb(l) l from leads l where id=$1", [lead])).l,
    ).toEqual(before.l);
    expect(
      (
        await one(
          "select count(*)::int n from notifications where lead_id=$1",
          [unassigned],
        )
      ).n,
    ).toBe(0);
    // The notice is erased with the lead.
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    await pg.query(
      "update leads set deleted_at=now()-interval '31 days' where id=$1",
      [lead],
    );
    await pg.query("delete from crm_private.lead_purge_runs");
    await pg.query("select purge_deleted_leads(30)");
    expect(await notices()).toEqual([]);
  });
});
