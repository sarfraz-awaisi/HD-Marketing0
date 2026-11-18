import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { read, utils, write } from "xlsx";
import { createApp } from "../src/app.js";
import { exportSize } from "../src/services/leadExport.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 073: administrators export leads file by file (a Google Sheet, a
// CSV or Excel file, or leads with no file) with every call, note and
// assignment, and the advertisement each came from, against every
// migration. A Sheet is told apart by its spreadsheet ID; a repeat inquiry
// is counted, never exported as the Sheet's lead; nothing is guessed for a
// lead with no file or advertisement; leads in Deleted leads never appear.
const admin = "73000000-0000-4000-8000-000000000001",
  ali = "73000000-0000-4000-8000-000000000002",
  sara = "73000000-0000-4000-8000-000000000003";
let pg, db, one, all, phone;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  phone = 100;
  await resetPeople(pg, [admin, ali, sara]);
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const binary = (res, done) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};
const preview = async (filters, server = app()) =>
  (
    await request(server)
      .post("/api/leads/export/preview")
      .set(as(admin))
      .send({ filters })
      .expect(200)
  ).body;
const exported = (body, user = admin, server = app()) =>
  request(server)
    .post("/api/leads/export")
    .set(as(user))
    .send(body)
    .buffer(true)
    .parse(binary);
const workbook = async (
  filters,
  sheets = ["summary", "calls", "notes", "assignments", "ad_quality", "files"],
  extra = {},
) => {
  const res = await exported({ filters, format: "xlsx", sheets, ...extra });
  expect(res.status, res.body.toString().slice(0, 200)).toBe(200);
  return read(res.body, { type: "buffer" });
};
const rowsOf = (book, title) =>
  utils.sheet_to_json(book.Sheets[title], { defval: "" });
const ids = (book) => rowsOf(book, "Lead summary").map((r) => r["CRM lead ID"]);
async function newLead(name, owner = null, extra = {}) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({
        name,
        ...(owner ? { assigned_agent: owner } : {}),
        ...extra,
      }),
      "+92300073" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
const call = (lead, actor, outcome, minutesAgo = 30, tags = []) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: !["No answer", "Busy", "Wrong number", "Number off"].includes(
        outcome,
      ),
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: [
        "No answer",
        "Busy",
        "Wrong number",
        "Number off",
      ].includes(outcome)
        ? 0
        : 75,
      outcome,
      notes: `${outcome} call`,
      deal_tags: tags,
    }),
  ]);
// Google Sheets as update 056 imports them: the key, the Sheets, the rows.
const sheetId = (n) => `1ExportTestSpreadsheet0000000000000_${n}`;
const submission = (n, extra = {}) => ({
  id: `l:${7300000000000000 + n}`,
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
  full_name: `Sheet buyer ${n}`,
  phone_number: `p:+92301${String(n).padStart(7, "0")}`,
  email: `buyer${n}@example.com`,
  city: "Lahore",
  ...extra,
});
async function sheets(server, names) {
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
  const rows = (source, list, first = 2) =>
    request(server)
      .post(`/api/integrations/sheets-sync/sources/${source}/rows`)
      .set(as(key))
      .send({ rows: list.map((values, i) => ({ row: first + i, values })) })
      .expect(200);
  const fileOf = async (source) =>
    (await one("select import_id from sheet_sources where id=$1", [source]))
      .import_id;
  return { key, sources, rows, fileOf };
}
const importFile = async (server, rows, name = "leads.xlsx") => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Leads");
  return (
    await request(server)
      .post("/api/leads/import")
      .set(as(admin))
      .attach("file", write(book, { type: "buffer", bookType: "xlsx" }), name)
      .expect(200)
  ).body;
};

describe("lead export by file (update 073)", () => {
  it("exports only the leads a Google Sheet created, told apart by spreadsheet ID, with its figures", async () => {
    const server = app();
    // Two Sheets with the same name, and a third.
    const s = await sheets(server, [
      "General Form Leads",
      "General Form Leads",
      "Plots",
    ]);
    const [a, b, c] = s.sources;
    await s.rows(a, [
      submission(1),
      submission(2),
      submission(3),
      { ...submission(4), phone_number: "p:12" },
    ]);
    // In Sheet b: two new customers and a repeat inquiry from customer 1.
    await s.rows(b, [
      submission(11),
      submission(12),
      submission(21, { phone_number: submission(1).phone_number }),
    ]);
    await s.rows(c, [submission(31)]);
    const [fa, fb, fc] = [
      await s.fileOf(a),
      await s.fileOf(b),
      await s.fileOf(c),
    ];
    const files = (
      await request(server)
        .get("/api/leads/export/sources")
        .set(as(admin))
        .expect(200)
    ).body.files;
    const fig = (id) => files.find((f) => f.id === id);
    expect(fig(fa)).toMatchObject({
      name: "General Form Leads",
      created: 3,
      rejected: 1,
      repeat: 0,
      in_crm: 3,
    });
    expect(fig(fb)).toMatchObject({
      name: "General Form Leads",
      created: 2,
      repeat: 1,
      rejected: 0,
      in_crm: 2,
    });
    expect([
      fig(fa).sheet.spreadsheet_id,
      fig(fb).sheet.spreadsheet_id,
    ]).toEqual([sheetId(0), sheetId(1)]);
    // One Sheet, two, and the third.
    expect((await preview({ files: [fa] })).count).toBe(3);
    expect((await preview({ files: [fb] })).count).toBe(2);
    expect((await preview({ files: [fa, fb] })).count).toBe(5);
    expect((await preview({ files: [fc] })).count).toBe(1);
    const book = await workbook({ files: [fb] });
    const summary = rowsOf(book, "Lead summary");
    expect(summary.map((r) => r.Name).sort()).toEqual([
      "Sheet buyer 11",
      "Sheet buyer 12",
    ]);
    expect(summary[0]).toMatchObject({
      File: "General Form Leads",
      "File type": "Google Sheet",
      "File ID": fb,
      "Google spreadsheet ID": sheetId(1),
      "Sheet tab": "Sheet1",
      "Ad attribution": "Google Sheet row",
      Campaign: "November plots",
      "Campaign ID": "120200000000003",
      "Ad set ID": "120200000000002",
      Advertisement: "DHA Phase 9 plots",
      "Ad ID": "120200000000001",
      "Lead form": "Plot inquiry",
      Contacted: "No",
      "Call attempts": 0,
    });
    expect(summary.map((r) => r["Google Sheet row"]).sort()).toEqual([2, 3]);
    // The repeat inquiry is counted under Files, not exported as a lead.
    expect(rowsOf(book, "Files")).toEqual([
      expect.objectContaining({
        "File ID": fb,
        "Google spreadsheet ID": sheetId(1),
        "New leads created": 2,
        "Repeat inquiries (existing leads)": 1,
        "Rows rejected": 0,
        "Leads in the CRM now": 2,
        "Leads in this export": 2,
      }),
    ]);
    expect(new Set(ids(book)).size).toBe(2);
    expect(rowsOf(book, "Ad quality")).toEqual([
      expect.objectContaining({
        "Ad attribution": "Google Sheet row",
        Campaign: "November plots",
        Leads: 2,
        Contacted: 0,
        "Not contacted": 2,
      }),
      expect.objectContaining({
        "Ad attribution": "All exported leads",
        Leads: 2,
      }),
    ]);
  });

  it("exports a CSV or Excel file's leads, and leads with no file, guessing nothing", async () => {
    const server = app();
    const file = await importFile(server, [
      ["name", "phone", "ad name"],
      ["Filed with ad", "03001730001", "Gulberg flats"],
      ["Filed without ad", "03001730002", ""],
    ]);
    const manual = await newLead("Added by hand");
    expect((await preview({ files: [file.import_id] })).count).toBe(2);
    expect((await preview({ no_file: true })).count).toBe(1);
    const book = await workbook({ files: [file.import_id], no_file: true });
    const summary = rowsOf(book, "Lead summary");
    const by = Object.fromEntries(summary.map((r) => [r.Name, r]));
    expect(by["Filed with ad"]).toMatchObject({
      "File type": "Excel file",
      "Row in file": 1,
      "Ad attribution": "Ad name in the file",
      Advertisement: "Gulberg flats",
      "Ad ID": "",
    });
    expect(by["Filed without ad"]).toMatchObject({
      "Ad attribution": "None recorded",
      Advertisement: "",
      Campaign: "",
    });
    expect(by["Added by hand"]).toMatchObject({
      File: "No file",
      "File ID": "",
      "Ad attribution": "None recorded",
      "CRM lead ID": manual,
    });
    expect(
      rowsOf(book, "Ad quality").map((r) => [
        r["Ad attribution"],
        r.Advertisement,
        r.Leads,
      ]),
    ).toEqual([
      ["None recorded", "", 2],
      ["Ad name in the file", "Gulberg flats", 1],
      ["All exported leads", "", 3],
    ]);
    expect(
      rowsOf(book, "Files").map((r) => [
        r.File,
        r["Rows in the source"],
        r["New leads created"],
        r["Leads in this export"],
      ]),
    ).toEqual([
      ["leads.xlsx", 2, 2, 2],
      ["No file (added by hand, Meta Lead Ads, WhatsApp, other)", "", "", 1],
    ]);
  });

  it("counts contacted leads by answered calls, with every call, note and assignment in its own worksheet", async () => {
    const tried = await newLead("Tried three times", ali);
    const untouched = await newLead("Never called", ali);
    const moved = await newLead("Moved to Sara", ali);
    await call(tried, ali, "No answer", 90);
    await call(tried, ali, "Busy", 60);
    await call(tried, ali, "Interested", 30, ["Hot lead"]);
    await pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [moved],
      admin,
      sara,
    ]);
    await call(moved, sara, "Not interested", 20);
    const note = await one(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Wants a corner plot') returning id",
      [tried, ali],
    );
    await pg.query(
      "insert into audit_log(actor_id,action,entity,entity_id) values($1,'create','notes',$2)",
      [ali, note.id],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,notes,status) values($1,$2,now()+interval '1 day','Call after Friday prayers','pending')",
      [tried, ali],
    );
    expect((await preview({ contacted: "yes" })).count).toBe(2);
    expect((await preview({ contacted: "no" })).count).toBe(1);
    const book = await workbook(
      { contacted: "yes" },
      ["summary", "calls", "notes", "assignments"],
      { preset: "contacted" },
    );
    const summary = Object.fromEntries(
      rowsOf(book, "Lead summary").map((r) => [r.Name, r]),
    );
    expect(summary["Tried three times"]).toMatchObject({
      "Call attempts": 3,
      "Answered calls": 1,
      Contacted: "Yes",
      "Showed interest": "Yes",
      Temperature: "Hot",
      // The note came after the calls.
      "Latest comment": "Wants a corner plot",
      "Follow-up": "Pending",
      "Follow-ups": 1,
    });
    expect(summary["Never called"]).toBeUndefined();
    const calls = rowsOf(book, "Call history");
    expect(
      calls.map((c) => [
        c["CRM lead ID"],
        c.Outcome,
        c.Answered,
        c["Duration (seconds)"],
        c["Made by"],
      ]),
    ).toEqual([
      [tried, "No answer", "No", 0, "Ali Agent"],
      [tried, "Busy", "No", 0, "Ali Agent"],
      [tried, "Interested", "Yes", 75, "Ali Agent"],
      [moved, "Not interested", "Yes", 75, "Sara Agent"],
    ]);
    expect(calls[2]["Temperature saved"]).toBe("Hot");
    expect(rowsOf(book, "Notes").map((n) => [n.Type, n.By, n.Note])).toEqual([
      ["Lead note", "Ali Agent", "Wants a corner plot"],
      ["Follow-up note", "Ali Agent", "Call after Friday prayers"],
    ]);
    expect(
      rowsOf(book, "Assignment history")
        .filter((a) => a["CRM lead ID"] === moved)
        .map((a) => [a.From, a.To, a.By]),
    ).toEqual([
      ["", "Ali Agent", "Owner"],
      ["Ali Agent", "Sara Agent", "Owner"],
    ]);
    expect(new Set(ids(book)).size).toBe(2);
    expect(untouched).toBeTruthy();
  });

  it("filters temperature and the latest outcome as All leads does, and outcomes in the call history", async () => {
    const server = app();
    const warm = await newLead("Warm then no answer", ali);
    await call(warm, ali, "Interested", 60, ["Warm lead"]);
    await call(warm, ali, "No answer", 30);
    const hot = await newLead("Hot", ali);
    await call(hot, ali, "Site visit scheduled", 30, ["Hot lead"]);
    await newLead("Cold-less", ali);
    for (const [filters, list] of [
      [{ temperature: "warm" }, "temperature=warm"],
      [{ temperature: "hot" }, "temperature=hot"],
      [{ temperature: "none" }, "temperature=none"],
      [{ outcome: "No answer" }, "outcome=No%20answer"],
      [{ outcome: "Interested" }, "outcome=Interested"],
    ]) {
      const listed = (
        await request(server)
          .get("/api/leads/all?" + list)
          .set(as(admin))
          .expect(200)
      ).body.count;
      expect((await preview(filters, server)).count, list).toBe(listed);
    }
    expect((await preview({ outcome: "Interested" }, server)).count).toBe(0);
    expect((await preview({ had_outcome: "Interested" }, server)).count).toBe(
      1,
    );
    const book = await workbook({ temperature: "warm" }, ["summary"]);
    expect(
      rowsOf(book, "Lead summary").map((r) => [
        r.Name,
        r.Temperature,
        r["Latest call outcome"],
        r["Showed interest"],
      ]),
    ).toEqual([["Warm then no answer", "Warm", "No answer", "Yes"]]);
  });

  it("reads creation and call periods as Pakistan days", async () => {
    const late = await newLead("Late on the 9th");
    const early = await newLead("Early on the 10th");
    await pg.query("update leads set created_at=$2 where id=$1", [
      late,
      "2026-11-09T23:30:00+05:00",
    ]);
    await pg.query("update leads set created_at=$2 where id=$1", [
      early,
      "2026-11-10T00:30:00+05:00",
    ]);
    expect(
      (await preview({ created_from: "2026-11-10", created_to: "2026-11-10" }))
        .count,
    ).toBe(1);
    expect(
      (await preview({ created_from: "2026-11-09", created_to: "2026-11-09" }))
        .count,
    ).toBe(1);
    expect(
      (await preview({ created_from: "2026-11-09", created_to: "2026-11-10" }))
        .count,
    ).toBe(2);
    const called = await newLead("Called at midnight", ali);
    await call(called, ali, "Interested", 30);
    await call(called, ali, "Busy", 20);
    const [first, second] = (
      await all("select id from calls where lead_id=$1 order by started_at", [
        called,
      ])
    ).map((c) => c.id);
    const move = (id, at) =>
      pg.query(
        "update calls set started_at=$2,ended_at=$2::timestamptz+make_interval(secs=>duration_seconds) where id=$1",
        [id, at],
      );
    await move(first, "2026-11-11T23:59:00+05:00");
    await move(second, "2026-11-12T00:01:00+05:00");
    expect(
      (await preview({ calls_from: "2026-11-12", calls_to: "2026-11-12" }))
        .count,
    ).toBe(1);
    expect(
      (
        await preview({
          calls_from: "2026-11-12",
          calls_to: "2026-11-12",
          had_outcome: "Interested",
        })
      ).count,
    ).toBe(0);
    expect(
      (
        await preview({
          calls_from: "2026-11-11",
          calls_to: "2026-11-11",
          had_outcome: "Interested",
        })
      ).count,
    ).toBe(1);
    // The call period also limits Call history.
    const book = await workbook(
      { calls_from: "2026-11-12", calls_to: "2026-11-12" },
      ["calls"],
    );
    expect(
      rowsOf(book, "Call history").map((c) => [c.Outcome, c["Call time"]]),
    ).toEqual([["Busy", "2026-11-12 00:01"]]);
    await expect(
      preview({ created_from: "2026-11-10", created_to: "2026-11-09" }),
    ).rejects.toThrow();
  });

  it("never exports leads in Deleted leads; restored ones come back, erased ones are gone", async () => {
    const server = app();
    const file = await importFile(server, [
      ["name", "phone"],
      ["Kept buyer", "03001731001"],
      ["Deleted buyer", "03001731002"],
      ["Erased buyer", "03001731003"],
    ]);
    const [, deleted, erased] = file.rows.map((r) => r.id);
    const f = { files: [file.import_id] };
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [deleted, erased],
      admin,
    ]);
    expect((await preview(f, server)).count).toBe(1);
    let book = await workbook(f);
    const text = JSON.stringify(Object.values(book.Sheets));
    expect(text).not.toMatch(/Deleted buyer|Erased buyer|1731002|1731003/);
    await pg.query("select restore_leads($1,$2,'t')", [[deleted], admin]);
    await pg.query("select erase_deleted_leads($1,$2,'t')", [[erased], admin]);
    expect((await preview(f, server)).count).toBe(2);
    book = await workbook(f);
    expect(
      rowsOf(book, "Lead summary")
        .map((r) => r.Name)
        .sort(),
    ).toEqual(["Deleted buyer", "Kept buyer"]);
    expect(rowsOf(book, "Files")[0]).toMatchObject({
      "Rows in the source": 3,
      "New leads created": 3,
      "Leads in the CRM now": 2,
      "In Deleted leads": 0,
      "No longer in the CRM": 1,
    });
    expect(JSON.stringify(Object.values(book.Sheets))).not.toMatch(
      /Erased buyer/,
    );
  });

  it("lets only administrators export, and records each export without a customer's details", async () => {
    const server = app();
    const lead = await newLead("Recorded buyer", ali);
    for (const [method, path, body] of [
      ["get", "/api/leads/export/sources"],
      ["post", "/api/leads/export/preview", { filters: {} }],
      [
        "post",
        "/api/leads/export",
        { filters: {}, format: "xlsx", sheets: ["summary"] },
      ],
    ])
      expect(
        (await request(server)[method](path).set(as(ali)).send(body)).status,
        path,
      ).toBe(403);
    // The database refuses an agent too, whatever the server let through.
    const { error } = await db.rpc("lead_export_rows", {
      p_actor: ali,
      p_ids: [lead],
    });
    expect(error?.code).toBe("42501");
    const res = await exported({
      filters: { agent: ali },
      format: "xlsx",
      sheets: ["summary"],
      preset: "file",
    });
    expect(res.status).toBe(200);
    const phoneCell = rowsOf(
      read(res.body, { type: "buffer" }),
      "Lead summary",
    )[0].Phone;
    expect(phoneCell).toMatch(/^\+92300073\d{4}$/);
    const logged = await one(
      "select metadata from audit_log where action='leads.exported'",
    );
    expect(logged.metadata).toMatchObject({
      preset: "file",
      format: "xlsx",
      sheets: ["summary"],
      filters: { agent: ali },
      leads: 1,
    });
    expect(JSON.stringify(logged.metadata)).not.toMatch(/Recorded buyer|\+92/);
    // The number shown in the file is recorded as viewed, as in every list.
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='lead.phone_revealed' and entity_id=$1",
          [lead],
        )
      ).n,
    ).toBe(1);
    // Without the Lead summary no number is read.
    await exported({
      filters: { agent: ali },
      format: "csv",
      sheet: "ad_quality",
    }).expect(200);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='lead.phone_revealed'",
        )
      ).n,
    ).toBe(1);
  });

  it("keeps formulas out of CSV and Excel files", async () => {
    const lead = await newLead('=HYPERLINK("http://evil.example","Open")', ali);
    await call(lead, ali, "Interested", 30);
    await pg.query("update calls set notes='@SUM(1+1)' where lead_id=$1", [
      lead,
    ]);
    const csv = await exported({
      filters: {},
      format: "csv",
      sheet: "summary",
    });
    expect(csv.status).toBe(200);
    const text = csv.body.toString();
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""Open"")"`);
    expect(text).toMatch(/"'\+92300073\d{4}"/);
    const calls = (
      await exported({ filters: {}, format: "csv", sheet: "calls" })
    ).body.toString();
    expect(calls).toContain(`"'@SUM(1+1)"`);
    const book = await workbook({}, ["summary", "calls"]);
    const cells = [
      ...Object.values(book.Sheets["Lead summary"]),
      ...Object.values(book.Sheets["Call history"]),
    ].filter((c) => c && c.t);
    expect(
      cells.some(
        (c) =>
          c.v === '=HYPERLINK("http://evil.example","Open")' && c.t === "s",
      ),
    ).toBe(true);
    expect(cells.some((c) => c.f)).toBe(false);
  });

  it("exports more than one batch of leads, each once, and refuses a file too large", async () => {
    const server = app();
    // Two files (an import takes up to 1,000 rows): 600 and 450 leads.
    const bulk = (from, n) =>
      Array.from({ length: n }, (_, i) => [
        `Bulk buyer ${from + i}`,
        "0302" + String(1000000 + from + i).slice(-7),
      ]);
    const first = await importFile(
      server,
      [["name", "phone"], ...bulk(1, 600)],
      "bulk-1.xlsx",
    );
    const second = await importFile(
      server,
      [["name", "phone"], ...bulk(601, 450)],
      "bulk-2.xlsx",
    );
    expect(first.rows.filter((r) => r.success)).toHaveLength(600);
    expect(second.rows.filter((r) => r.success)).toHaveLength(450);
    const filters = { files: [first.import_id, second.import_id] };
    expect((await preview(filters, server)).count).toBe(1050);
    const book = await workbook(filters, ["summary", "files"]);
    const summary = rowsOf(book, "Lead summary");
    expect(summary).toHaveLength(1050);
    expect(new Set(ids(book)).size).toBe(1050);
    expect(summary.every((r) => /^\+92302\d{7}$/.test(r.Phone))).toBe(true);
    // File by file, in each file's order.
    expect(summary.slice(0, 3).map((r) => r["Row in file"])).toEqual([1, 2, 3]);
    expect(new Set(summary.slice(0, 600).map((r) => r.File)).size).toBe(1);
    expect(
      rowsOf(book, "Files")
        .map((r) => r["Leads in this export"])
        .sort(),
    ).toEqual([450, 600]);
    // One CSV worksheet, written a batch at a time.
    const csv = (
      await exported({ filters, format: "csv", sheet: "summary" })
    ).body
      .toString()
      .trim()
      .split("\r\n");
    expect(csv).toHaveLength(1051);
    // Too large for one Excel file, or at all.
    expect(
      exportSize({ count: 10001, calls: 0, notes: 0, assignments: 0 }, "xlsx", [
        "summary",
      ]),
    ).toMatch(/More than 10,000 leads/);
    expect(
      exportSize(
        { count: 10, calls: 70000, notes: 0, assignments: 0 },
        "xlsx",
        ["summary", "calls"],
      ),
    ).toMatch(/more than 60,000/);
    expect(
      exportSize({ count: 10, calls: 70000, notes: 0, assignments: 0 }, "csv", [
        "calls",
      ]),
    ).toBeNull();
    expect(
      exportSize(
        { count: 10, calls: 70000, notes: 0, assignments: 0 },
        "xlsx",
        ["summary"],
      ),
    ).toBeNull();
    const none = await exported({
      filters: { status: "won" },
      format: "xlsx",
      sheets: ["summary"],
    });
    expect([none.status, JSON.parse(none.body.toString()).error]).toEqual([
      404,
      "No leads match these filters.",
    ]);
    const invalid = await request(server)
      .post("/api/leads/export/preview")
      .set(as(admin))
      .send({ filters: { files: ["not-a-file"] } });
    expect(invalid.status).toBe(400);
  }, 120000);
});
