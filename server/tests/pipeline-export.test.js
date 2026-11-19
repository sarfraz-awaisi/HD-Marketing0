import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { CFB, read, utils } from "xlsx";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import {
  pipelineExportHeadings,
  pipelineExportLeads,
  pipelineExportMax,
} from "../src/services/pipelineExport.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Lead pipeline export: an administrator downloads every agent's Hot, Warm
// or Cold leads in one CSV or Excel file, exactly as the administrators'
// Lead pipeline counts them: leads assigned to an agent now that the agent
// personally contacted, with the latest temperature of the current
// assignment. Every number in the file is recorded as viewed, and the export
// itself in Audit history. Only administrators get in.
const admin = "67000000-0000-4000-8000-000000000001",
  ali = "67000000-0000-4000-8000-000000000002",
  sara = "67000000-0000-4000-8000-000000000003",
  staff = "67000000-0000-4000-8000-000000000004";
let pg, db, one, all, phoneNo;
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
  phoneNo = 0;
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const phoneOf = (n) => "+9230067" + String(n).padStart(5, "0");
async function newLead(owner, name) {
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      phoneOf(++phoneNo),
      admin,
    ])
  ).id;
}
// A call logged as the server logs it, so the audit log names the caller.
const call = (lead, actor, { minutes = 60, tags = [], answered = true } = {}) =>
  rpc("log_manual_call", {
    p_lead: lead,
    p_actor: actor,
    p_data: {
      answered,
      started_at: ago(minutes),
      duration_seconds: answered ? 90 : 0,
      outcome: answered ? "Interested" : "No answer",
      deal_tags: tags,
    },
    p_request: "fixture",
  });
const reassign = (lead, agent) =>
  rpc("assign_lead", {
    p_lead: lead,
    p_actor: admin,
    p_agent: agent,
    p_request: "fixture",
  });
// Ali's and Sara's leads, with every case that must or must not be exported
// as Hot. Returns the leads by name.
async function team() {
  const lead = {};
  for (const [name, owner] of [
    ["Asad", ali],
    ["Bilal", ali],
    ["Chand", ali],
    ["Danish", sara],
    ["Ehsan", ali],
    ["Faraz", ali],
    ["Ghazal", sara],
    ["Hamid", ali],
  ])
    lead[name] = await newLead(owner, name + " Khan");
  // Asad and Danish: Hot, from their own agent. Exported.
  await call(lead.Asad, ali, { minutes: 300, tags: ["Hot lead"] });
  await call(lead.Danish, sara, { minutes: 200, tags: ["Hot lead"] });
  // Bilal: Hot, then Warm later: Warm now.
  await call(lead.Bilal, ali, { minutes: 300, tags: ["Hot lead"] });
  await call(lead.Bilal, ali, { minutes: 100, tags: ["Warm lead"] });
  // Chand: Hot, but only an administrator spoke to him: not Ali's contact.
  await call(lead.Chand, admin, { minutes: 100, tags: ["Hot lead"] });
  // Ehsan: Hot with Ali, then moved to Sara: a fresh start (update 066).
  await call(lead.Ehsan, ali, { minutes: 250, tags: ["Hot lead"] });
  await reassign(lead.Ehsan, sara);
  // Faraz: Cold. Ghazal: Warm.
  await call(lead.Faraz, ali, { minutes: 90, tags: ["Cold lead"] });
  await call(lead.Ghazal, sara, { minutes: 80, tags: ["Warm lead"] });
  // Hamid: Hot, then deleted.
  await call(lead.Hamid, ali, { minutes: 70, tags: ["Hot lead"] });
  await rpc("delete_leads", {
    p_lead_ids: [lead.Hamid],
    p_actor: admin,
    p_reason: "Duplicate customer",
    p_request: "fixture",
  });
  return lead;
}
// A download, as bytes.
const fetchFile = (path, user = admin) =>
  request(app())
    .get(path)
    .set(as(user))
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
const csvRows = (body) =>
  utils.sheet_to_json(
    read(body.toString("utf8"), { type: "string" }).Sheets.Sheet1,
    {
      header: 1,
      raw: false,
    },
  );
const col = (rows, heading) => {
  const i = rows[0].indexOf(heading);
  return rows.slice(1).map((r) => r[i]);
};

describe("Lead pipeline export", () => {
  it("exports every agent's leads of one temperature, exactly as the pipeline counts them", async () => {
    const lead = await team();
    const summary = await request(app())
      .get("/api/pipeline/export/summary")
      .set(as(admin));
    expect([summary.status, summary.headers["cache-control"]]).toEqual([
      200,
      "no-store",
    ]);
    expect(summary.body).toEqual({ agents: 2, hot: 2, warm: 2, cold: 1 });
    const file = await fetchFile("/api/pipeline/export?temperature=hot");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/^text\/csv/);
    expect(file.headers["content-disposition"]).toMatch(
      /attachment; filename="hd-pipeline-hot-leads-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(file.headers["cache-control"]).toBe("no-store");
    const rows = csvRows(file.body);
    expect(rows[0]).toEqual(pipelineExportHeadings);
    // Agents in the pipeline's order, each with their own leads only.
    const pick = (...headings) =>
      rows.slice(1).map((r) => headings.map((h) => r[rows[0].indexOf(h)]));
    expect(
      pick("Name", "Agent", "Temperature", "Status", "Agent account"),
    ).toEqual([
      ["Asad Khan", "Ali Agent", "Hot", "Contacted", "Active"],
      ["Danish Khan", "Sara Agent", "Hot", "Contacted", "Active"],
    ]);
    // Full numbers, as on the pipeline's lead pages. In CSV a cell starting
    // with "+" gets an apostrophe, so no spreadsheet reads it as a formula.
    expect(col(rows, "Phone")).toEqual(["'" + phoneOf(1), "'" + phoneOf(4)]);
    expect(col(rows, "Phone country")).toEqual(["PK", "PK"]);
    expect(col(rows, "Lead #").every((n) => /^HD-\d{6}$/.test(n))).toBe(true);
    expect(
      col(rows, "Temperature set").every((t) =>
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t),
      ),
    ).toBe(true);
    // The other temperatures follow the same rules.
    const warm = csvRows(
      (await fetchFile("/api/pipeline/export?temperature=warm")).body,
    );
    expect(col(warm, "Name")).toEqual(["Bilal Khan", "Ghazal Khan"]);
    const cold = csvRows(
      (await fetchFile("/api/pipeline/export?temperature=cold")).body,
    );
    expect(col(cold, "Name")).toEqual(["Faraz Khan"]);
    // Never the leads the pipeline leaves out.
    const exported = [...col(rows, "Name"), ...col(warm, "Name")];
    for (const name of ["Chand Khan", "Ehsan Khan", "Hamid Khan"])
      expect(exported).not.toContain(name);
    expect(lead.Ehsan).toBeTruthy();
  });
  it("includes every detail of the lead's page: its record, a lost lead's reason and the latest advertisement inquiry", async () => {
    const lead = await team();
    await pg.query(
      "update leads set preferred_location='DHA Phase 6',budget_min=15000000,budget_max=25000000 where id=$1",
      [lead.Asad],
    );
    await pg.query(
      "update leads set status='lost',lost_reason='bought_elsewhere',lost_note='Bought in Bahria',lost_at=now()-interval '2 hours' where id=$1",
      [lead.Danish],
    );
    // Two Google Sheets inquiries for Asad; the later one is shown.
    const { id: source } = await one(
      "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Facebook leads','AbCdEfGhIjKlMnOpQrStUv','Leads',$1) returning id",
      [admin],
    );
    for (const [n, days, ad, extra] of [
      ["101", 3, "Old ad", {}],
      [
        "102",
        1,
        "Plots in DHA",
        { "when_do_you_plan_to_buy?": "within_3_months" },
      ],
    ]) {
      await pg.query(
        "insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,sheet_row) values($1,$2,'created',$3,2)",
        [source, n, lead.Asad],
      );
      await pg.query(
        `insert into crm_private.sheet_lead_inquiries(source_id,meta_lead_id,lead_id,submitted_at,platform,is_organic,ad_name,campaign_name,form_name,city,interest,budget,extra)
         values($1,$2,$3,now()-make_interval(days=>$4),'instagram',false,$5,'Winter campaign','Plot form','Lahore','residential_plot','50_lakh_to_1_crore',$6)`,
        [source, n, lead.Asad, days, ad, JSON.stringify(extra)],
      );
    }
    const rows = utils.sheet_to_json(
      read(
        (await fetchFile("/api/pipeline/export?temperature=hot&format=xlsx"))
          .body,
      ).Sheets["Hot leads"],
      { header: 1, raw: false },
    );
    const asad = Object.fromEntries(
      rows[0].map((h, i) => [h, rows[1][i] ?? ""]),
    );
    const danish = Object.fromEntries(
      rows[0].map((h, i) => [h, rows[2][i] ?? ""]),
    );
    expect(asad).toMatchObject({
      Name: "Asad Khan",
      "Preferred location": "DHA Phase 6",
      "Budget from (PKR)": "15000000",
      "Budget up to (PKR)": "25000000",
      "Ad inquiries": "2",
      "Ad platform": "Instagram",
      Advertisement: "Plots in DHA",
      Campaign: "Winter campaign",
      "Ad form": "Plot form",
      "Ad property interest": "residential plot",
      "Ad budget": "50 lakh to 1 crore",
      "Ad city": "Lahore",
      "Other ad answers": "when do you plan to buy: within 3 months",
      "Lost reason": "",
    });
    expect(asad["Latest ad inquiry"]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    expect(asad["Last activity"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(danish).toMatchObject({
      Name: "Danish Khan",
      Status: "Lost",
      "Lost reason": "Bought elsewhere",
      "Lost note": "Bought in Bahria",
      "Ad inquiries": "0",
      Advertisement: "",
      "Budget up to (PKR)": "",
    });
    expect(danish["Lost on"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it("writes the same rows as an Excel file, without formulas", async () => {
    await team();
    await pg.query(
      "update leads set name='=HYPERLINK(\"x\")' where name='Asad Khan'",
    );
    const file = await fetchFile(
      "/api/pipeline/export?temperature=hot&format=xlsx",
    );
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/spreadsheetml\.sheet/);
    expect(file.headers["content-disposition"]).toMatch(
      /hd-pipeline-hot-leads-\d{4}-\d{2}-\d{2}\.xlsx/,
    );
    const book = read(file.body);
    expect(book.SheetNames).toEqual(["Hot leads"]);
    const sheet = book.Sheets["Hot leads"];
    const rows = utils.sheet_to_json(sheet, { header: 1, raw: false });
    expect(rows[0]).toEqual(pipelineExportHeadings);
    expect(col(rows, "Name")).toEqual(['=HYPERLINK("x")', "Danish Khan"]);
    // Excel keeps the numbers exactly, as text.
    expect(col(rows, "Phone")).toEqual([phoneOf(1), phoneOf(4)]);
    expect(Object.values(sheet).some((cell) => cell?.f)).toBe(false);
    // Laid out as the lead export lays it out (update 074): the heading row
    // bold, frozen and filtered over every row; IDs as text.
    const xml = CFB.find(
      CFB.read(file.body, { type: "buffer" }),
      "/xl/worksheets/sheet1.xml",
    ).content.toString("utf8");
    expect(xml).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(xml).toContain(`<autoFilter ref="A1:AK${rows.length}"/>`);
    expect(xml.match(/<c r="[A-Z]+1" s="1" t="s">/g)).toHaveLength(37);
    expect(xml).not.toMatch(/<f[ >]/);
    expect(sheet.N2.t).toBe("s");
    // In CSV, a cell a spreadsheet could read as a formula is prefixed.
    const csv = (
      await fetchFile("/api/pipeline/export?temperature=hot")
    ).body.toString("utf8");
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it("records every exported number as viewed, and the export in Audit history", async () => {
    await team();
    const { last } = await one("select max(id) last from audit_log");
    const file = await fetchFile("/api/pipeline/export?temperature=hot");
    expect(file.status).toBe(200);
    const requestId = file.headers["x-request-id"];
    // Only this export's entries (the audit log also says who made each call).
    const entries = await all(
      "select actor_id,action,entity,entity_id,request_id,metadata from audit_log where id>$1 order by id",
      [last],
    );
    expect(
      entries.filter((e) => e.action === "lead.phone_revealed").length,
    ).toBe(2);
    const exported = entries.filter((e) => e.action === "pipeline.exported");
    expect(exported).toEqual([
      {
        actor_id: admin,
        action: "pipeline.exported",
        entity: "leads",
        entity_id: null,
        request_id: requestId,
        metadata: { temperature: "hot", format: "csv", leads: 2, agents: 2 },
      },
    ]);
    expect(entries.every((e) => e.request_id === requestId)).toBe(true);
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.phone_reveals where user_id=$1",
          [admin],
        )
      ).n,
    ).toBe(2);
    const shown = presentAuditEntry(exported[0]);
    expect([shown.title, shown.description]).toEqual([
      "Exported Lead pipeline leads",
      "Exported 2 hot leads of 2 agents from the Lead pipeline as a CSV file, with their phone numbers.",
    ]);
    expect(
      presentAuditEntry({
        action: "pipeline.exported",
        entity: "leads",
        metadata: { temperature: "warm", format: "xlsx", leads: 1, agents: 1 },
      }).description,
    ).toBe(
      "Exported 1 warm lead of 1 agent from the Lead pipeline as an Excel file, with their phone numbers.",
    );
    expect(
      presentAuditEntry({
        action: "pipeline.exported",
        entity: "leads",
        metadata: { temperature: "<script>", leads: "many" },
      }).description,
    ).toBe("Exported leads from the Lead pipeline.");
  });
  it("pages through every lead of every agent, more than one page each", async () => {
    for (let i = 0; i < 23; i++)
      await call(await newLead(ali, `Hot ${String(i).padStart(2, "0")}`), ali, {
        minutes: 500 - i,
        tags: ["Hot lead"],
      });
    const rows = csvRows(
      (await fetchFile("/api/pipeline/export?temperature=hot")).body,
    );
    expect(rows.length - 1).toBe(23);
    expect(new Set(col(rows, "Lead #")).size).toBe(23);
  });
  it("says so when there are no leads of that temperature, and records nothing", async () => {
    await team();
    await pg.query(
      "update calls set deal_tags=array_remove(deal_tags,'Cold lead')",
    );
    const { last } = await one("select max(id) last from audit_log");
    const res = await request(app())
      .get("/api/pipeline/export?temperature=cold&format=xlsx")
      .set(as(admin));
    expect([res.status, res.body.error]).toEqual([
      404,
      "There are no cold leads to export.",
    ]);
    expect(
      (await all("select action from audit_log where id>$1", [last])).length,
    ).toBe(0);
  });
  it("lets only administrators export, and refuses anything but a temperature and a file type", async () => {
    await team();
    for (const user of [ali, sara, staff])
      for (const path of [
        "/api/pipeline/export?temperature=hot",
        "/api/pipeline/export/summary",
      ])
        expect(
          (await request(app()).get(path).set(as(user))).status,
          `${user} ${path}`,
        ).toBe(403);
    expect(
      (await request(app()).get("/api/pipeline/export?temperature=hot")).status,
    ).toBe(401);
    for (const query of [
      "",
      "temperature=none",
      "temperature=HOT",
      "temperature=hot&format=pdf",
      "temperature=hot&agent=" + ali,
    ])
      expect(
        (
          await request(app())
            .get("/api/pipeline/export?" + query)
            .set(as(admin))
        ).status,
        query,
      ).toBe(400);
    // The database checks the administrator too.
    await expect(
      rpc("admin_pipeline_agents", { p_actor: ali, p_query: {} }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Lead pipeline export, paging and limits", () => {
  // A pipeline of many agents and leads, served 20 at a time as the
  // database serves it. shifted(agent, attempt) says whether that reading
  // of an agent's pages shifts: the first lead of page 2 repeats the last of
  // page 1 and one lead is never seen, as when a lead is contacted while the
  // file is prepared.
  function fakePipeline(agentCount, leadsPerAgent, shifted = () => false) {
    const agents = Array.from({ length: agentCount }, (_, i) => ({
      id: "agent-" + i,
      name: "Agent " + i,
      uid: 100000 + i,
      active: true,
      hot: i % 3 === 0 ? leadsPerAgent : 0,
      warm: 0,
      cold: 0,
    }));
    const calls = [],
      readings = {};
    const rpc = async (name, args) => {
      calls.push([name, args]);
      const page = args.p_query.page;
      if (name === "admin_pipeline_agents")
        return {
          count: agents.length,
          data: agents.slice((page - 1) * 20, page * 20),
        };
      if (page === 1)
        readings[args.p_agent] = (readings[args.p_agent] || 0) + 1;
      const leads = Array.from({ length: leadsPerAgent }, (_, i) => ({
        id: `${args.p_agent}-lead-${i}`,
        name: "Lead " + i,
      }));
      const list = shifted(args.p_agent, readings[args.p_agent])
        ? [...leads.slice(0, 20), leads[19], ...leads.slice(21)]
        : leads;
      return {
        count: leads.length,
        data: list.slice((page - 1) * 20, page * 20),
      };
    };
    return { agents, calls, rpc, readings };
  }
  it("reads every page of agents and of each agent's leads, and writes each lead once", async () => {
    const { agents, calls, rpc } = fakePipeline(45, 41);
    const leads = await pipelineExportLeads(rpc, "hot");
    const withHot = agents.filter((a) => a.hot);
    expect(leads.length).toBe(withHot.length * 41);
    expect(new Set(leads.map((l) => l.id)).size).toBe(leads.length);
    expect(leads[0].agent.name).toBe("Agent 0");
    // Three pages of agents; agents without hot leads are never opened.
    expect(calls.filter(([n]) => n === "admin_pipeline_agents").length).toBe(3);
    const opened = new Set(
      calls
        .filter(([n]) => n === "admin_agent_pipeline")
        .map(([, a]) => a.p_agent),
    );
    expect([...opened]).toEqual(withHot.map((a) => a.id));
    for (const [, args] of calls.filter(([n]) => n === "admin_agent_pipeline"))
      expect(args.p_query).toMatchObject({
        view: "current",
        temperature: "hot",
      });
  });
  it("reads an agent's leads again when they shift while being read, and never leaves one out", async () => {
    const { rpc, readings } = fakePipeline(
      4,
      41,
      (agent, reading) => agent === "agent-3" && reading === 1,
    );
    const leads = await pipelineExportLeads(rpc, "hot");
    const own = leads.filter((l) => l.agent.id === "agent-3");
    expect(own.length).toBe(41);
    expect(new Set(own.map((l) => l.id)).size).toBe(41);
    expect(readings).toEqual({ "agent-0": 1, "agent-3": 2 });
  });
  it("refuses with a clear message rather than send an incomplete file", async () => {
    const { rpc } = fakePipeline(1, 41, () => true);
    await expect(pipelineExportLeads(rpc, "hot")).rejects.toMatchObject({
      status: 409,
      message:
        "The pipeline changed while the file was being prepared. Export again.",
    });
  });
  it(`refuses more than ${pipelineExportMax} leads at once`, async () => {
    const rpc = async () => ({
      count: 1,
      data: [{ id: "a", name: "Agent", hot: pipelineExportMax + 1 }],
    });
    await expect(pipelineExportLeads(rpc, "hot")).rejects.toMatchObject({
      status: 413,
    });
  });
});
