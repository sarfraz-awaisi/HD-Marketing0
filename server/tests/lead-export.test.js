import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { CFB, read, utils, write } from "xlsx";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import {
  exportFileName,
  exportLeads,
  exportMax,
} from "../src/services/leadExport.js";
import {
  pipelineExportHeadings,
  pkDateTime,
} from "../src/services/pipelineExport.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Lead export (updates 073 and 074), against every migration: an
// administrator chooses one lead file (a Google Sheet, told apart by its
// spreadsheet ID and tab; an imported CSV or Excel file; or No file) and
// downloads every lead of it that is assigned to an agent now, called or
// not, each once, on one worksheet called Leads in exactly the Lead pipeline
// export's 37 columns, filled as the Lead pipeline export fills them.
// Agent, temperature, status, the agent's last call, contacted and worked
// can narrow the list; by default nothing does. Leads in Deleted leads and
// erased leads never appear.
const admin = "74000000-0000-4000-8000-000000000001",
  ali = "74000000-0000-4000-8000-000000000002",
  sara = "74000000-0000-4000-8000-000000000003";
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
const preview = (filters, server = app(), user = admin) =>
  request(server)
    .post("/api/leads/export/preview")
    .set(as(user))
    .send({ filters });
const counts = async (filters, server) => {
  const res = await preview(filters, server);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const exported = (filters, user = admin, server = app()) =>
  request(server)
    .post("/api/leads/export")
    .set(as(user))
    .send({ filters })
    .buffer(true)
    .parse(binary);
const workbook = async (filters, server) => {
  const res = await exported(filters, admin, server);
  expect(res.status, res.body.toString().slice(0, 200)).toBe(200);
  return { res, book: read(res.body, { type: "buffer", cellFormula: true }) };
};
const leadsOf = (book) =>
  utils.sheet_to_json(book.Sheets.Leads, { defval: "" });
const byName = (book) =>
  Object.fromEntries(leadsOf(book).map((r) => [r.Name, r]));
const names = async (filters, server) =>
  leadsOf((await workbook(filters, server)).book)
    .map((r) => r.Name)
    .sort();
async function newLead(name, owner = null, extra = {}) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({
        name,
        ...(owner ? { assigned_agent: owner } : {}),
        ...extra,
      }),
      "+92300074" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
const unanswered = ["No answer", "Busy", "Wrong number", "Number off"];
// A call logged as the server logs it, so the audit log names the caller.
const call = (lead, actor, outcome, minutesAgo = 30, tags = [], notes) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: !unanswered.includes(outcome),
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: unanswered.includes(outcome) ? 0 : 75,
      outcome,
      ...(notes ? { notes } : {}),
      deal_tags: tags,
    }),
  ]);
// A lead note as the server saves it: the note, then its audit entry.
async function note(lead, author, body, minutesAgo = 5) {
  const { id } = await one(
    "insert into notes(lead_id,agent_id,body,created_at) values($1,$2,$3,now()-make_interval(mins=>$4)) returning id",
    [lead, author, body, minutesAgo],
  );
  await pg.query(
    "insert into audit_log(actor_id,action,entity,entity_id) values($1,'create','notes',$2)",
    [author, id],
  );
}
const assign = (leads, agent) =>
  pg.query("select admin_assign_leads($1,$2,$3,'t')", [leads, admin, agent]);
const leadIds = async () =>
  Object.fromEntries(
    (await all("select id,name from leads")).map((l) => [l.name, l.id]),
  );
// Google Sheets as update 056 imports them: the key, the Sheets, the rows.
const sheetId = (n) => `1FileExportSpreadsheet00000000000000_${n}`;
const submission = (n, extra = {}) => ({
  id: `l:${7400000000000000 + n}`,
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
async function sheets(server, list) {
  const key = (
    await request(server)
      .post("/api/integrations/sheets/key")
      .set(as(admin))
      .send({})
      .expect(201)
  ).body.key;
  const sources = [];
  for (const [i, name] of list.entries())
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
  const rows = (source, values, first = 2) =>
    request(server)
      .post(`/api/integrations/sheets-sync/sources/${source}/rows`)
      .set(as(key))
      .send({ rows: values.map((v, i) => ({ row: first + i, values: v })) })
      .expect(200);
  const fileOf = async (source) =>
    (await one("select import_id from sheet_sources where id=$1", [source]))
      .import_id;
  return { sources, rows, fileOf };
}
const importFile = async (server, rows, name = "leads.xlsx") => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Leads");
  return (
    await request(server)
      .post("/api/leads/import")
      .set(as(admin))
      .attach("file", write(book, { type: "buffer", bookType: "xlsx" }), name)
      .expect((res) => {
        if (res.status !== 200) throw new Error(JSON.stringify(res.body));
      })
  ).body;
};
// The file's parts, as Excel reads them.
const part = (buffer, path) =>
  CFB.find(CFB.read(buffer, { type: "buffer" }), "/" + path).content.toString(
    "utf8",
  );

describe("lead export: one file's assigned leads in the Lead pipeline's columns (update 074)", () => {
  it("exports one Google Sheet's assigned leads, called or not, each once, on one worksheet called Leads", async () => {
    const server = app();
    // Two Sheets with the same name: told apart by their spreadsheet IDs.
    const { sources, rows, fileOf } = await sheets(server, [
      "General Form Leads",
      "General Form Leads",
    ]);
    await rows(
      sources[0],
      [1, 2, 3, 4, 5].map((n) => submission(n)),
    );
    // The second Sheet: its own customers, and customer 1 again, which is a
    // repeat inquiry on customer 1's lead, not a lead of this Sheet.
    await rows(sources[1], [
      submission(6),
      submission(7),
      submission(8, {
        phone_number: submission(1).phone_number,
        created_time: "2026-11-05T09:00:00+0500",
        ad_name: "Bahria Town plots",
      }),
    ]);
    const first = await fileOf(sources[0]);
    const second = await fileOf(sources[1]);
    const lead = await leadIds();
    await assign(
      [lead["Sheet buyer 1"], lead["Sheet buyer 2"], lead["Sheet buyer 4"]],
      ali,
    );
    await assign([lead["Sheet buyer 3"], lead["Sheet buyer 6"]], sara);
    await call(lead["Sheet buyer 1"], ali, "Interested", 40, ["Hot lead"]);
    await call(lead["Sheet buyer 2"], ali, "No answer", 30);
    await call(lead["Sheet buyer 4"], ali, "Busy", 20);
    // Buyer 3: never called. Buyer 5: no agent.
    expect(await counts({ file: first }, server)).toMatchObject({
      count: 4,
      in_file: 5,
      assigned: 4,
      file: { id: first, name: "General Form Leads", format: "sheets" },
      max: 10000,
    });
    const { res, book } = await workbook({ file: first }, server);
    expect(book.SheetNames).toEqual(["Leads"]);
    expect(book.Sheets.Leads.A1.v).toBe("Lead #");
    const grid = utils.sheet_to_json(book.Sheets.Leads, {
      header: 1,
      defval: "",
    });
    expect(grid[0]).toEqual(pipelineExportHeadings);
    expect(grid[0]).toHaveLength(37);
    // Data from row 2, in the Sheet's order, each lead once.
    expect(grid.slice(1).map((r) => r[1])).toEqual([
      "Sheet buyer 1",
      "Sheet buyer 2",
      "Sheet buyer 3",
      "Sheet buyer 4",
    ]);
    expect(new Set(grid.slice(1).map((r) => r[0])).size).toBe(4);
    const row = byName(book);
    expect(row["Sheet buyer 1"]).toMatchObject({
      Agent: "Ali Agent",
      "Last call outcome": "Interested",
      "Last contact outcome": "Interested",
      Temperature: "Hot",
      // Its own inquiry and the repeat from the other Sheet, latest first.
      "Ad inquiries": 2,
      Advertisement: "Bahria Town plots",
    });
    expect(row["Sheet buyer 2"]).toMatchObject({
      "Last call outcome": "No answer",
      "Agent's last contact": "",
      "Last contact outcome": "",
    });
    expect(row["Sheet buyer 3"]).toMatchObject({
      Agent: "Sara Agent",
      "Last call": "",
      "Last call outcome": "",
      Temperature: "",
      Campaign: "November plots",
    });
    expect(row["Sheet buyer 4"]["Last call outcome"]).toBe("Busy");
    expect(res.headers["content-disposition"]).toContain(
      `filename="${exportFileName("General Form Leads")}"`,
    );
    // The other Sheet of that name: its one assigned lead, nothing else.
    expect(await counts({ file: second }, server)).toMatchObject({
      count: 1,
      in_file: 2,
      assigned: 1,
    });
    expect(await names({ file: second }, server)).toEqual(["Sheet buyer 6"]);
  });

  it("fills every column exactly as the Lead pipeline export does, for the same lead", async () => {
    const server = app();
    const { sources, rows, fileOf } = await sheets(server, ["Plots form"]);
    const answers = {
      "what_are_you_interested_in?": "5_marla_plot",
      "what_is_your_budget?": "50_lakh_to_1_crore",
      "when_do_you_want_to_buy?": "within_3_months",
    };
    await rows(sources[0], [
      submission(11, answers),
      submission(12, answers),
      submission(13),
      submission(14),
    ]);
    const file = await fileOf(sources[0]);
    const lead = await leadIds();
    const [asad, bilal, chand, daud] = [11, 12, 13, 14].map(
      (n) => lead[`Sheet buyer ${n}`],
    );
    await assign([asad, bilal, daud], ali);
    await assign([chand], sara);
    await pg.query(
      "update leads set budget_min=5000000,budget_max=9000000,preferred_location='DHA Phase 6' where id=$1",
      [asad],
    );
    await call(asad, ali, "No answer", 300);
    await call(asad, ali, "Interested", 200, ["Hot lead"], "Wants a corner");
    // Notes now, after the call's own note: the agent's is the latest of
    // the agent's; the administrator's is never the agent's.
    await note(asad, ali, "Visit planned for Sunday", 0);
    await note(asad, admin, "Administrator's note", 0);
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()+interval '2 days','pending'),($1,$2,now()+interval '1 day','pending')",
      [asad, ali],
    );
    await call(bilal, ali, "Not interested", 120, ["Warm lead"]);
    await pg.query(
      "update leads set status='lost',lost_reason='budget',lost_note='Budget too low for DHA',lost_at=now()-interval '1 hour' where id=$1",
      [bilal],
    );
    await call(chand, sara, "Follow-up required", 90, ["Cold lead"]);
    // An administrator's later call is never the agent's.
    await call(chand, admin, "Interested", 60);
    // Daud: Ali called, no answer: not in Ali's pipeline.
    await call(daud, ali, "No answer", 50);
    const ours = Object.fromEntries(
      leadsOf((await workbook({ file }, server)).book).map((r) => [
        r["Lead #"],
        r,
      ]),
    );
    expect(Object.keys(ours)).toHaveLength(4);
    const pipeline = {};
    for (const temperature of ["hot", "warm", "cold"]) {
      const res = await request(server)
        .get(`/api/pipeline/export?temperature=${temperature}&format=xlsx`)
        .set(as(admin))
        .buffer(true)
        .parse(binary)
        .expect(200);
      for (const r of utils.sheet_to_json(
        read(res.body, { type: "buffer" }).Sheets[
          `${temperature[0].toUpperCase()}${temperature.slice(1)} leads`
        ],
        { defval: "" },
      ))
        pipeline[r["Lead #"]] = r;
    }
    // Every lead in the pipeline (all but Daud, whom Ali has not reached):
    // every one of the 37 values the same, of the same type.
    expect(Object.keys(pipeline).sort()).toEqual(
      Object.keys(ours)
        .filter((no) => ours[no].Name !== "Sheet buyer 14")
        .sort(),
    );
    for (const no of Object.keys(pipeline))
      for (const heading of pipelineExportHeadings)
        expect(ours[no][heading], `${no} ${heading}`).toEqual(
          pipeline[no][heading],
        );
    const asadRow = Object.values(ours).find(
      (r) => r.Name === "Sheet buyer 11",
    );
    expect(asadRow).toMatchObject({
      "Preferred location": "DHA Phase 6",
      "Budget from (PKR)": 5000000,
      "Budget up to (PKR)": 9000000,
      "Agent's latest note": "Visit planned for Sunday",
      "Ad property interest": "5 marla plot",
      "Ad budget": "50 lakh to 1 crore",
      "Ad city": "Lahore",
      "Other ad answers": "when do you want to buy: within 3 months",
    });
    expect(asadRow["Next follow-up"]).toBe(
      pkDateTime(
        (
          await one(
            "select min(due_at) d from followups where lead_id=$1 and status='pending'",
            [asad],
          )
        ).d,
      ),
    );
    expect(
      Object.values(ours).find((r) => r.Name === "Sheet buyer 12"),
    ).toMatchObject({
      Status: "Lost",
      "Lost reason": "Budget",
      "Lost note": "Budget too low for DHA",
      Temperature: "Warm",
    });
    expect(
      Object.values(ours).find((r) => r.Name === "Sheet buyer 13"),
    ).toMatchObject({
      "Last call outcome": "Follow-up required",
      "Last contact outcome": "Follow-up required",
    });
  });

  it("credits an agent with only their own calls and notes, never an administrator's or an earlier agent's", async () => {
    const server = app();
    const xenia = await newLead("Xenia Shah", ali);
    await call(xenia, ali, "No answer", 90);
    await note(xenia, ali, "Called, no answer; try in the evening", 85);
    // An administrator's later answered call and note, filed under Ali.
    await call(xenia, admin, "Interested", 30);
    await note(xenia, admin, "Customer rang the office", 10);
    const yasir = await newLead("Yasir Ali", ali);
    await call(yasir, ali, "Interested", 120, ["Hot lead"]);
    await note(yasir, ali, "Spoke to him about Phase 9", 110);
    await assign([yasir], sara);
    const zara = await newLead("Zara Butt", sara);
    const row = byName((await workbook({ no_file: true }, server)).book);
    const aliCall = await one(
      "select started_at from calls where lead_id=$1 and outcome='No answer'",
      [xenia],
    );
    expect(row["Xenia Shah"]).toMatchObject({
      Agent: "Ali Agent",
      "Last call": pkDateTime(aliCall.started_at),
      "Last call outcome": "No answer",
      "Agent's last contact": "",
      "Last contact outcome": "",
      "Agent's latest note": "Called, no answer; try in the evening",
    });
    // Moved to Sara, who has not called yet: nothing of Ali's.
    expect(row["Yasir Ali"]).toMatchObject({
      Agent: "Sara Agent",
      "Last call": "",
      "Last call outcome": "",
      "Agent's last contact": "",
      "Agent's latest note": "",
      Temperature: "",
    });
    expect(row["Zara Butt"]).toMatchObject({
      Agent: "Sara Agent",
      "Last call": "",
      "Agent's latest note": "",
    });
    expect(zara).toBeTruthy();
  });

  it("narrows by agent, temperature, status, the agent's last call, contacted and worked, and by default by nothing", async () => {
    const server = app();
    const a = await newLead("Amna Hot", ali);
    await call(a, ali, "Interested", 60, ["Hot lead"]);
    const b = await newLead("Basit No answer", ali);
    await call(b, ali, "No answer", 50);
    await newLead("Chanda Uncalled", sara);
    const d = await newLead("Dua Warm", sara);
    await call(d, sara, "Follow-up required", 40, ["Warm lead"]);
    const e = await newLead("Ehsan Cold then busy", ali);
    await call(e, ali, "Interested", 90, ["Cold lead"]);
    await call(e, ali, "Busy", 20);
    await newLead("Fiza No agent");
    const n = async (extra) =>
      (await counts({ no_file: true, ...extra }, server)).count;
    expect(await counts({ no_file: true }, server)).toMatchObject({
      count: 5,
      in_file: 6,
      assigned: 5,
    });
    expect(await names({ no_file: true }, server)).toEqual([
      "Amna Hot",
      "Basit No answer",
      "Chanda Uncalled",
      "Dua Warm",
      "Ehsan Cold then busy",
    ]);
    expect(await n({ agent: ali })).toBe(3);
    expect(await n({ agent: sara })).toBe(2);
    expect(await n({ temperature: "hot" })).toBe(1);
    expect(await n({ temperature: "warm" })).toBe(1);
    expect(await n({ temperature: "cold" })).toBe(1);
    expect(await n({ temperature: "none" })).toBe(2);
    expect(await n({ outcome: "Interested" })).toBe(1);
    expect(await n({ outcome: "No answer" })).toBe(1);
    expect(await n({ outcome: "Busy" })).toBe(1);
    expect(await n({ outcome: "Follow-up required" })).toBe(1);
    expect(await n({ contacted: "yes" })).toBe(3);
    expect(await n({ contacted: "no" })).toBe(2);
    expect(await n({ worked: "yes" })).toBe(4);
    expect(await n({ worked: "no" })).toBe(1);
    expect(await n({ agent: ali, contacted: "no" })).toBe(1);
    for (const status of ["new", "contacted", "interested"])
      expect(await n({ status })).toBe(
        Number(
          (
            await one(
              "select count(*) n from leads where status=$1 and import_id is null and assigned_agent is not null and deleted_at is null",
              [status],
            )
          ).n,
        ),
      );
    expect(await names({ no_file: true, worked: "no" }, server)).toEqual([
      "Chanda Uncalled",
    ]);
    expect(await names({ no_file: true, temperature: "cold" }, server)).toEqual(
      ["Ehsan Cold then busy"],
    );
    // One lead file, always.
    expect((await preview({}, server)).status).toBe(400);
    expect((await preview({ no_file: true, file: a }, server)).status).toBe(
      400,
    );
    expect(
      (await preview({ file: "74000000-0000-4000-8000-0000000000ff" }, server))
        .status,
    ).toBe(404);
  });

  it("follows each lead's file through deletion, restoring, erasure and reassignment; CSV and Excel files too", async () => {
    const server = app();
    const file = (
      await importFile(server, [
        ["name", "phone", "agent name"],
        ["Csv one", "03021000001", "Ali Agent"],
        ["Csv two", "03021000002", "Ali Agent"],
        ["Csv three", "03021000003", "Sara Agent"],
        ["Csv four", "03021000004", ""],
      ])
    ).import_id;
    await importFile(
      server,
      [
        ["name", "phone", "agent name"],
        ["Other file", "03021000005", "Ali Agent"],
      ],
      "other.xlsx",
    );
    await newLead("Hand lead", ali);
    const lead = await leadIds();
    expect(await counts({ file }, server)).toMatchObject({
      count: 3,
      in_file: 4,
      assigned: 3,
    });
    expect(await names({ file }, server)).toEqual([
      "Csv one",
      "Csv three",
      "Csv two",
    ]);
    expect(await names({ no_file: true }, server)).toEqual(["Hand lead"]);
    // Deleted: gone from the export.
    await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
      [lead["Csv two"]],
      admin,
    ]);
    expect(await counts({ file }, server)).toMatchObject({
      count: 2,
      in_file: 3,
    });
    // Restored: back in its file with no agent, so not yet exported.
    await pg.query("select restore_leads($1,$2,'t')", [
      [lead["Csv two"]],
      admin,
    ]);
    expect(await counts({ file }, server)).toMatchObject({
      count: 2,
      in_file: 4,
      assigned: 2,
    });
    // Given to Sara: exported again, with Sara.
    await assign([lead["Csv two"]], sara);
    expect(
      byName((await workbook({ file }, server)).book)["Csv two"].Agent,
    ).toBe("Sara Agent");
    // Moved between agents: still this file's lead.
    await assign([lead["Csv one"]], sara);
    expect(await names({ file, agent: sara }, server)).toEqual([
      "Csv one",
      "Csv three",
      "Csv two",
    ]);
    // Erased for good: no longer exists anywhere.
    await pg.query("select delete_leads($1,$2,'Erase test','t')", [
      [lead["Csv three"]],
      admin,
    ]);
    await pg.query("select erase_deleted_leads($1,$2,'t')", [
      [lead["Csv three"]],
      admin,
    ]);
    expect(await counts({ file }, server)).toMatchObject({
      count: 2,
      in_file: 3,
    });
    expect(await names({ file }, server)).toEqual(["Csv one", "Csv two"]);
  });

  it("lets only administrators export, records each export, and never writes a formula", async () => {
    const server = app();
    const lead = await newLead('=HYPERLINK("http://evil.example","Open")', ali);
    await call(lead, ali, "Interested", 30, [], "+1 call me back");
    await note(lead, ali, "=1+2", 0);
    for (const res of [
      await request(server).get("/api/leads/export/sources").set(as(ali)),
      await preview({ no_file: true }, server, ali),
      await exported({ no_file: true }, ali, server),
    ])
      expect(res.status).toBe(403);
    const { res, book } = await workbook({ no_file: true }, server);
    const sheet = part(res.body, "xl/worksheets/sheet1.xml");
    expect(sheet).not.toMatch(/<f[ >]/);
    const cells = Object.entries(book.Sheets.Leads)
      .filter(([k]) => !k.startsWith("!"))
      .map(([, c]) => c);
    expect(cells.some((c) => c.f)).toBe(false);
    expect(book.Sheets.Leads.B2).toMatchObject({
      t: "s",
      v: '=HYPERLINK("http://evil.example","Open")',
    });
    expect(
      byName(book)['=HYPERLINK("http://evil.example","Open")'][
        "Agent's latest note"
      ],
    ).toBe("=1+2");
    const entries = await all(
      "select actor_id,action,entity,metadata from audit_log where action='leads.exported'",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toEqual({
      format: "xlsx",
      layout: "pipeline_columns",
      filters: { no_file: true },
      leads: 1,
    });
    expect(presentAuditEntry(entries[0]).description).toBe(
      "Exported 1 assigned lead with no lead file as an Excel file, with their phone numbers.",
    );
    expect(
      presentAuditEntry({
        action: "leads.exported",
        entity: "leads",
        metadata: {
          format: "xlsx",
          layout: "pipeline_columns",
          files: 1,
          leads: 128,
        },
      }).description,
    ).toBe(
      "Exported 128 assigned leads of one lead file as an Excel file, with their phone numbers.",
    );
    // Each number in the file is recorded as viewed.
    expect(
      Number(
        (
          await one(
            "select count(*) n from audit_log where action='lead.phone_revealed' and entity_id=$1",
            [lead],
          )
        ).n,
      ),
    ).toBe(1);
  });

  it("lays the worksheet out for work: frozen heading row, AutoFilter, widths, wrapped notes, IDs and phones as text, budgets as numbers", async () => {
    const server = app();
    const lead = await newLead("Hina Ahmed", ali, {
      email: "hina@example.com",
      preferred_location: "Bahria Town",
      budget_min: 5000000,
      budget_max: 7500000,
    });
    await call(lead, ali, "Interested", 30, ["Hot lead"]);
    await note(lead, ali, "Long note. ".repeat(30).trim(), 0);
    const { res, book } = await workbook({ no_file: true }, server);
    const sheet = part(res.body, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain('<autoFilter ref="A1:AK2"/>');
    expect(sheet.match(/<col /g)).toHaveLength(37);
    // The heading row: bold (style 1), every cell.
    expect(sheet.match(/<c r="[A-Z]+1" s="1" t="s">/g)).toHaveLength(37);
    // Phone and Agent UID text, budgets numbers, the note wrapped, and the
    // row tall enough for it.
    expect(sheet).toMatch(/<c r="C2" s="2" t="s">/);
    expect(sheet).toMatch(/<c r="N2" s="2" t="s">/);
    expect(sheet).toContain('<c r="K2" s="4"><v>5000000</v></c>');
    expect(sheet).toMatch(/<c r="AA2" s="3" t="s">/);
    expect(sheet).toMatch(/<row r="2" ht="\d+" customHeight="1">/);
    expect(part(res.body, "xl/styles.xml")).toMatch(/<b\/>.*wrapText="1"/s);
    expect(part(res.body, "xl/workbook.xml")).toContain(
      '<workbookView activeTab="0"/>',
    );
    const cells = book.Sheets.Leads;
    expect(cells.C2).toMatchObject({ t: "s" });
    expect(cells.C2.v).toMatch(/^\+92300074\d{4}$/);
    expect(cells.K2).toMatchObject({ t: "n", v: 5000000 });
    expect(cells.N2.t).toBe("s");
    expect(book.Sheets.Leads["!ref"]).toBe("A1:AK2");
  });

  it("exports more than one batch of leads, each once, in the file's order", async () => {
    const server = app();
    const bulk = Array.from({ length: 600 }, (_, i) => [
      `Bulk buyer ${i + 1}`,
      "0302" + String(2000000 + i).slice(-7),
      "Ali Agent",
    ]);
    const { import_id: file, rows } = await importFile(server, [
      ["name", "phone", "agent name"],
      ...bulk,
    ]);
    expect(rows.filter((r) => r.success)).toHaveLength(600);
    expect((await counts({ file }, server)).count).toBe(600);
    const list = leadsOf((await workbook({ file }, server)).book);
    expect(list).toHaveLength(600);
    expect(new Set(list.map((r) => r["Lead #"])).size).toBe(600);
    expect(list.slice(0, 3).map((r) => r.Name)).toEqual([
      "Bulk buyer 1",
      "Bulk buyer 2",
      "Bulk buyer 3",
    ]);
    expect(list.every((r) => /^\+92302\d{7}$/.test(r.Phone))).toBe(true);
  }, 120000);

  it("names the file after the lead file, safely, and stops if the leads change meanwhile", async () => {
    expect(exportMax).toBe(10000);
    expect(exportFileName("General Form Leads", "2026-11-19")).toBe(
      "General-Form-Leads-Assigned-2026-11-19.xlsx",
    );
    expect(exportFileName('Lahore "DHA" / Phase 6', "2026-11-19")).toBe(
      "Lahore-DHA-Phase-6-Assigned-2026-11-19.xlsx",
    );
    expect(exportFileName("../../etc/passwd", "2026-11-19")).toBe(
      "etc-passwd-Assigned-2026-11-19.xlsx",
    );
    expect(exportFileName("لیڈز", "2026-11-19")).toBe(
      "Leads-Assigned-2026-11-19.xlsx",
    );
    // A lead left the file's assigned leads between the count and the file.
    await expect(
      exportLeads(
        { rpc: async () => ({ data: [] }) },
        { user: { id: admin } },
        [admin],
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
