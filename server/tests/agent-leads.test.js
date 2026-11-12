import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { callOutcome, manualCall } from "../src/utils/validators.js";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Updates 052 and 053: an agent's Assigned leads and Lead pipeline. Search,
// filters, counts and pages are worked out in the database; agents see only
// the leads assigned to them now, and only their own notes. File leads keep
// their import order.
const admin = "52000000-0000-4000-8000-000000000001",
  ali = "52000000-0000-4000-8000-000000000002",
  sara = "52000000-0000-4000-8000-000000000003",
  staff = "52000000-0000-4000-8000-000000000004";
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
const list = (query, actor = ali) =>
  rpc("agent_lead_list", { p_actor: actor, p_query: query });
// Every page of a list, as rows.
async function everything(query, actor = ali) {
  const rows = [];
  for (let page = 1; ; page++) {
    const r = await list({ ...query, page }, actor);
    rows.push(...r.data);
    if (r.data.length < r.limit) return { rows, count: r.count };
  }
}
const nextPhone = () => "+9230055" + String(++phoneNo).padStart(5, "0");
async function newLead({
  owner = ali,
  name = "Customer",
  source = "manual",
} = {}) {
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({
        name,
        source,
        ...(owner ? { assigned_agent: owner } : {}),
      }),
      nextPhone(),
      admin,
    ])
  ).id;
}
// Imports a file as an administrator would, then assigns it to an agent.
// A row given as null repeats the first row's number, so it is rejected.
async function importFile(fileName, names, agent = ali) {
  let first;
  const rows = names.map((name, index) => {
    const phone = name === null ? first : nextPhone();
    first ||= phone;
    return {
      row: index + 2,
      data: { name: name ?? "Duplicate", source: "CSV" },
      phone,
    };
  });
  const result = await rpc("import_leads", {
    p_file_name: fileName,
    p_format: "csv",
    p_worksheet: null,
    p_rows: rows,
    p_actor: admin,
    p_request: "fixture",
  });
  if (agent)
    await rpc("assign_lead_import", {
      p_import: result.import_id,
      p_agent: agent,
      p_actor: admin,
      p_request: "fixture",
    });
  return {
    id: result.import_id,
    leads: result.rows.filter((r) => r.success).map((r) => r.id),
  };
}
async function call(
  lead,
  {
    status = "completed",
    at,
    tags = [],
    outcome = "Interested",
    agent = ali,
  } = {},
) {
  await pg.query(
    "insert into calls(lead_id,agent_id,status,started_at,ended_at,duration_seconds,outcome,deal_tags) values($1,$2,$3,$4,$4::timestamptz+interval '2 minutes',120,$5,$6)",
    [lead, agent, status, at || new Date().toISOString(), outcome, tags],
  );
}
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const fileRows = async () =>
  Object.fromEntries(
    (await all("select lead_id,file_row from crm_private.lead_file_rows")).map(
      (r) => [r.lead_id, r.file_row],
    ),
  );

describe("file numbers (#)", () => {
  it("numbers each file 1, 2, 3 in import order, skipping rejected rows", async () => {
    const a = await importFile("Lahore.csv", [
      "Asad",
      "Bilal",
      null,
      "Danish",
      "Ehsan",
    ]);
    const b = await importFile("Karachi.csv", ["Fahad", "Ghazal"]);
    const rows = await fileRows();
    expect(a.leads.map((id) => rows[id])).toEqual([1, 2, 3, 4]);
    expect(b.leads.map((id) => rows[id])).toEqual([1, 2]);
    const inFile = await list({ import: a.id });
    expect(inFile.sort).toBe("file");
    expect(inFile.data.map((r) => [r.file_row, r.name, r.file_name])).toEqual([
      [1, "Asad", "Lahore.csv"],
      [2, "Bilal", "Lahore.csv"],
      [3, "Danish", "Lahore.csv"],
      [4, "Ehsan", "Lahore.csv"],
    ]);
  });
  it("keeps every number through reassignment, deletion and the purge", async () => {
    const a = await importFile("Lahore.csv", [
      "Asad",
      "Bilal",
      "Chand",
      "Danish",
    ]);
    const before = await fileRows();
    await pg.query("update leads set assigned_agent=$2 where id=$1", [
      a.leads[2],
      sara,
    ]);
    await rpc("delete_leads", {
      p_lead_ids: [a.leads[1]],
      p_actor: admin,
      p_reason: "Duplicate customer",
      p_request: "fixture",
    });
    await pg.query(
      "update leads set deleted_at=now()-interval '40 days' where id=$1",
      [a.leads[1]],
    );
    expect((await rpc("purge_deleted_leads", { p_retention: 30 })).purged).toBe(
      1,
    );
    const after = await fileRows();
    expect(after[a.leads[1]]).toBeUndefined();
    for (const id of [a.leads[0], a.leads[2], a.leads[3]])
      expect(after[id]).toBe(before[id]);
    // The file order stays: Ali's leads come as #1 and #4, Sara's as #3.
    expect((await list({ import: a.id })).data.map((r) => r.file_row)).toEqual([
      1, 4,
    ]);
    const saras = await list({ import: a.id }, sara);
    expect(saras.data.map((r) => [r.file_row, r.name])).toEqual([[3, "Chand"]]);
  });
  it("gives no number to a lead added without a file", async () => {
    await newLead({ name: "Walk-in buyer" });
    const [row] = (await list({})).data;
    expect(row).toMatchObject({
      name: "Walk-in buyer",
      file_row: null,
      file_name: null,
    });
  });
});

describe("Assigned leads", () => {
  it("searches every page by name or contact number only (update 053)", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Customer ${i + 1}`);
    const file = await importFile("Big file.csv", names);
    const page2 = await list({ import: file.id, page: 2 });
    expect(page2.count).toBe(25);
    expect(page2.data.map((r) => r.name)).toEqual([
      "Customer 21",
      "Customer 22",
      "Customer 23",
      "Customer 24",
      "Customer 25",
    ]);
    // Customer 22 has +923005500022: found on page 1 in any common format,
    // or by its last digits.
    for (const search of [
      "03005500022",
      "0300-5500022",
      "+92 300 5500022",
      "00923005500022",
      "3005500022",
      "5500022",
      "0022",
    ]) {
      const r = await list({ search });
      expect(
        r.data.map((row) => row.name),
        search,
      ).toEqual(["Customer 22"]);
    }
    expect((await list({ search: "customer 1" })).count).toBe(11);
    expect((await list({ search: "CUSTOMER 2" })).count).toBe(7);
    // No more # or HD numbers: they are only names that match nobody.
    const lead = await one("select lead_no from leads where name='Customer 7'");
    for (const search of [
      "#22",
      "# 22",
      `HD-${String(lead.lead_no).padStart(6, "0")}`,
    ])
      expect((await list({ search })).count, search).toBe(0);
    expect((await list({ search: "nobody" })).count).toBe(0);
    expect((await list({ search: "100%_\\" })).count).toBe(0);
  });
  it("shows only the agent's own leads, whatever the search", async () => {
    await importFile("Sara's file.csv", ["Shared name"], sara);
    await newLead({ owner: sara, name: "Shared name" });
    await newLead({ name: "Shared name" });
    const mine = await list({ search: "Shared" });
    expect(mine.count).toBe(1);
    expect(mine.data[0].assigned_agent).toBe(ali);
    for (const search of ["+923005500001", "5500001"])
      expect((await list({ search })).count, search).toBe(0);
  });
  it("keeps the source and first-call filters, and tells contacted, attempted and never contacted apart", async () => {
    const waiting = await newLead({ name: "Waiting", source: "Meta" });
    const missed = await newLead({ name: "Missed", source: "Meta" });
    const tried = await newLead({ name: "Tried" });
    const spoke = await newLead({ name: "Spoke" });
    await pg.query(
      "update leads set call_due_at=case id when $1 then now()+interval '1 hour' when $2 then now()-interval '1 hour' end,first_call_at=null where id in ($1,$2)",
      [waiting, missed],
    );
    await call(tried, { status: "failed", outcome: "No answer" });
    await call(spoke);
    expect((await list({ source: "Meta" })).count).toBe(2);
    expect((await list({ call: "uncalled" })).data.map((r) => r.name)).toEqual([
      "Waiting",
    ]);
    const late = await list({ call: "missed" });
    expect([late.sort, late.data.map((r) => r.name)]).toEqual([
      "call_due",
      ["Missed"],
    ]);
    const contact = Object.fromEntries(
      (await list({})).data.map((r) => [r.name, r.contact]),
    );
    expect(contact).toMatchObject({
      Tried: "attempted",
      Spoke: "contacted",
      Waiting: "none",
    });
  });
});

describe("Lead pipeline", () => {
  it("lists only the agent's leads with an answered call, whatever their status now", async () => {
    const never = await newLead({ name: "Never called" });
    const unanswered = await newLead({ name: "Unanswered" });
    const spoke = await newLead({ name: "Spoke" });
    const lost = await newLead({ name: "Spoke, then lost" });
    const moved = await newLead({ name: "Moved to Sara" });
    await call(unanswered, { status: "failed", outcome: "No answer" });
    await call(unanswered, { status: "initiated", outcome: null });
    for (const id of [spoke, lost, moved]) await call(id);
    await pg.query(
      "update leads set status='lost',lost_reason='price' where id=$1",
      [lost],
    );
    await pg.query("update leads set assigned_agent=$2 where id=$1", [
      moved,
      sara,
    ]);
    const names = (await list({ view: "pipeline" })).data
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["Spoke", "Spoke, then lost"]);
    // Update 061: the call before the move was Ali's, so the lead joins
    // Sara's pipeline only once she speaks to the customer herself.
    expect((await list({ view: "pipeline" }, sara)).data).toEqual([]);
    await call(moved, { agent: sara });
    expect(
      (await list({ view: "pipeline" }, sara)).data.map((r) => r.name),
    ).toEqual(["Moved to Sara"]);
    expect(never).toBeTruthy();
  });
  it("filters by status and temperature together, with exact counts on every page", async () => {
    const statuses = [
      "contacted",
      "interested",
      "visit_scheduled",
      "negotiation",
      "won",
      "lost",
    ];
    const temps = [["Hot lead"], ["Warm lead"], ["Cold lead"], []];
    const expected = [];
    for (let i = 0; i < 48; i++) {
      const id = await newLead({ name: `Buyer ${i}` });
      await call(id, { at: ago(1000 - i), tags: temps[i % 4] });
      const status = statuses[i % 6];
      await pg.query(
        "update leads set status=$2,lost_reason=case when $2='lost' then 'price' end where id=$1",
        [id, status],
      );
      expected.push({
        id,
        status,
        temperature: ["hot", "warm", "cold", "none"][i % 4],
      });
    }
    await newLead({ name: "Not contacted" });
    for (const status of [undefined, ...statuses])
      for (const temperature of [undefined, "hot", "warm", "cold", "none"]) {
        const want = expected
          .filter(
            (e) =>
              (!status || e.status === status) &&
              (!temperature || e.temperature === temperature),
          )
          .map((e) => e.id)
          .sort();
        const { rows, count } = await everything({
          view: "pipeline",
          ...(status ? { status } : {}),
          ...(temperature ? { temperature } : {}),
        });
        const label = `${status || "all"}/${temperature || "all"}`;
        expect(count, label).toBe(want.length);
        expect(rows.map((r) => r.id).sort(), label).toEqual(want);
      }
    const all48 = await list({ view: "pipeline" });
    expect(all48.temperatures).toEqual({
      hot: 12,
      warm: 12,
      cold: 12,
      none: 12,
    });
    // Latest contact first by default.
    expect(all48.data[0].name).toBe("Buyer 47");
    const hotFirst = await list({ view: "pipeline", sort: "temperature" });
    expect(
      hotFirst.data.slice(0, 12).every((r) => r.temperature === "hot"),
    ).toBe(true);
    const interested = await list({
      view: "pipeline",
      status: "interested",
      search: "Buyer 1",
    });
    // Interested are Buyer 1, 7, 13, 19 … of which three contain "Buyer 1".
    expect(interested.data.map((r) => r.name).sort()).toEqual([
      "Buyer 1",
      "Buyer 13",
      "Buyer 19",
    ]);
  });
  it("shows the latest temperature, latest answered call and next follow-up", async () => {
    const id = await newLead({ name: "Hassan" });
    await call(id, { at: ago(300), tags: ["Hot lead", "Budget mismatch"] });
    await call(id, { at: ago(200), outcome: "Follow-up required" });
    await call(id, { at: ago(100), status: "failed", outcome: "Busy" });
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()+interval '2 days','pending'),($1,$2,now()-interval '1 day','pending'),($1,$2,now()-interval '3 days','completed')",
      [id, ali],
    );
    let [row] = (await list({ view: "pipeline" })).data;
    expect(row).toMatchObject({
      temperature: "hot",
      last_contact_outcome: "Follow-up required",
      contact: "contacted",
    });
    expect(
      Math.abs(Date.parse(row.last_contact_at) - Date.parse(ago(200))),
    ).toBeLessThan(5000);
    expect(Date.parse(row.next_followup_at)).toBeLessThan(Date.now());
    await call(id, { at: ago(50), tags: ["Cold lead"] });
    [row] = (await list({ view: "pipeline", temperature: "cold" })).data;
    expect(row.name).toBe("Hassan");
    expect((await list({ view: "pipeline", temperature: "hot" })).count).toBe(
      0,
    );
  });
});

describe("call outcomes and agents' notes (update 053)", () => {
  const names = async (query) =>
    (await everything(query)).rows.map((r) => r.name).sort();
  it("filters by the latest call's outcome, and Number off never puts a lead in the pipeline", async () => {
    const off = await newLead({ name: "Never reached" });
    const later = await newLead({ name: "Spoke, then off" });
    const spoke = await newLead({ name: "Spoke" });
    await call(off, { status: "failed", outcome: "Number off", at: ago(30) });
    await call(later, { at: ago(60), tags: ["Hot lead"] });
    await call(later, { status: "failed", outcome: "Number off", at: ago(20) });
    await call(spoke, { at: ago(10), outcome: "Not interested" });
    expect(await names({ view: "pipeline" })).toEqual([
      "Spoke",
      "Spoke, then off",
    ]);
    expect(await names({ view: "pipeline", outcome: "Number off" })).toEqual([
      "Spoke, then off",
    ]);
    expect(
      await names({
        view: "pipeline",
        outcome: "Number off",
        temperature: "hot",
      }),
    ).toEqual(["Spoke, then off"]);
    expect(
      await names({ view: "pipeline", outcome: "Not interested" }),
    ).toEqual(["Spoke"]);
    // Assigned leads finds every lead whose latest call found the number off.
    expect(await names({ outcome: "Number off" })).toEqual([
      "Never reached",
      "Spoke, then off",
    ]);
    expect((await list({ search: "Never reached" })).data[0]).toMatchObject({
      contact: "attempted",
      last_call_outcome: "Number off",
      last_call_connected: false,
      last_contact_at: null,
    });
    expect((await list({ outcome: "Off" }).catch((e) => e)).code).toBe("22023");
  });
  it("records Number off only for a call that did not connect", async () => {
    const lead = await newLead({ name: "Switched off" });
    const data = (change) => ({
      answered: false,
      started_at: ago(5),
      duration_seconds: 0,
      outcome: "Number off",
      notes: "",
      deal_tags: [],
      ...change,
    });
    expect(manualCall("agent").safeParse(data()).success).toBe(true);
    expect(
      manualCall("agent").safeParse(
        data({ answered: true, duration_seconds: 60 }),
      ).error.issues[0].message,
    ).toBe("Number off is for a call that did not connect");
    const saved = await rpc("log_manual_call", {
      p_lead: lead,
      p_actor: ali,
      p_data: data(),
      p_request: "fixture",
    });
    expect(saved).toMatchObject({
      outcome: "Number off",
      status: "failed",
      answered: false,
    });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("new");
    await expect(
      rpc("log_manual_call", {
        p_lead: lead,
        p_actor: ali,
        p_data: data({ answered: true, duration_seconds: 60 }),
        p_request: "fixture",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pg.query(
        "update calls set answered=true,status='completed',duration_seconds=60,ended_at=started_at+interval '60 seconds' where id=$1",
        [saved.id],
      ),
    ).rejects.toThrow(/calls_manual_values_check/);
    expect((await list({ view: "pipeline" })).count).toBe(0);
  });
  it("shows only notes the agent wrote, by the audit log, from a lead note or a call", async () => {
    const lead = await newLead({ name: "Noted" });
    await newLead({ name: "Quiet" });
    const mutate = (actor, data) =>
      rpc("crm_mutate", {
        p_table: "notes",
        p_id: null,
        p_data: data,
        p_actor: actor,
        p_request: "fixture",
      });
    // A note or call is written now, then dated back, as if written then.
    const note = async (actor, body, minutes, on = lead) => {
      const saved = await mutate(actor, { lead_id: on, body });
      await pg.query(
        "update notes set created_at=now()-make_interval(mins=>$2) where id=$1",
        [saved.id, minutes],
      );
    };
    const callNote = async (actor, notes, minutes) => {
      const saved = await rpc("log_manual_call", {
        p_lead: lead,
        p_actor: actor,
        p_data: {
          answered: true,
          started_at: ago(minutes),
          duration_seconds: 60,
          outcome: "Interested",
          notes,
          deal_tags: [],
        },
        p_request: "fixture",
      });
      await pg.query(
        "update calls set created_at=now()-make_interval(mins=>$2) where id=$1",
        [saved.id, minutes],
      );
    };
    const noteOf = async (name) => (await list({ search: name })).data[0];
    expect(await noteOf("Quiet")).toMatchObject({ note: null, note_at: null });
    await note(ali, "Wants a corner plot", 90);
    expect((await noteOf("Noted")).note).toBe("Wants a corner plot");
    await callNote(ali, "Call back after Friday prayers", 60);
    await callNote(ali, "   ", 50);
    expect((await noteOf("Noted")).note).toBe("Call back after Friday prayers");
    // An administrator's note and call on Ali's lead are filed under Ali,
    // but Ali wrote neither, so neither shows in his list.
    await note(admin, "Owner's private remark", 10);
    await callNote(admin, "Owner's call note", 5);
    const row = await noteOf("Noted");
    expect(row.note).toBe("Call back after Friday prayers");
    expect(Date.parse(row.note_at)).toBeLessThan(Date.now() - 55 * 60000);
    // Sara's note from before the lead became Ali's stays hers.
    const moved = await newLead({ owner: sara, name: "Handed over" });
    await note(sara, "Sara's private remark", 30, moved);
    await pg.query("update leads set assigned_agent=$2 where id=$1", [
      moved,
      ali,
    ]);
    expect(await noteOf("Handed over")).toMatchObject({ note: null });
    await note(ali, "Visit booked for Sunday", 2);
    expect((await noteOf("Noted")).note).toBe("Visit booked for Sunday");
    expect(
      (await list({ view: "pipeline" })).data.map((r) => [r.name, r.note]),
    ).toEqual([["Noted", "Visit booked for Sunday"]]);
  });
});

describe("the my-leads API", () => {
  it("shows an agent's own numbers as the leads list does", async () => {
    const file = await importFile("Lahore.csv", ["Asad", "Bilal"]);
    const res = await request(app())
      .get(`/api/my-leads?import_id=${file.id}&search=%2B92%20300%205500002`)
      .set(as(ali));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data.map((r) => [r.file_row, r.name, r.phone])).toEqual([
      [2, "Bilal", "+923005500002"],
    ]);
    const pipeline = await request(app())
      .get("/api/my-leads?view=pipeline&temperature=none")
      .set(as(ali));
    expect([pipeline.status, pipeline.body.count]).toEqual([200, 0]);
  });
  it("refuses administrators, staff, other agents' files and filters a view does not use", async () => {
    const saras = await importFile("Sara.csv", ["Shared"], sara);
    for (const [user, status] of [
      [admin, 403],
      [staff, 403],
    ])
      expect(
        (await request(app()).get("/api/my-leads").set(as(user))).status,
      ).toBe(status);
    expect(
      (
        await request(app())
          .get(`/api/my-leads?import_id=${saras.id}`)
          .set(as(ali))
      ).status,
    ).toBe(404);
    for (const query of [
      "view=pipeline&source=CSV",
      "view=pipeline&call=missed",
      "view=assigned&status=won",
      "view=assigned&temperature=hot",
      "view=assigned&sort=temperature",
      "view=pipeline&sort=file",
      "status=booked",
      "temperature=boiling",
      "agent=" + sara,
      "search=" + encodeURIComponent("a;drop"),
    ]) {
      const res = await request(app())
        .get("/api/my-leads?" + query)
        .set(as(ali));
      expect(res.status, query).toBe(400);
    }
    await expect(
      list({ view: "pipeline", import: saras.id }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(list({}, admin)).rejects.toMatchObject({ code: "42501" });
    await expect(list({ page: 0 })).rejects.toMatchObject({ code: "22023" });
    await expect(list({ extra: "x" })).rejects.toMatchObject({ code: "22023" });
  });
});

describe("a call's temperature", () => {
  const manual = (body) =>
    manualCall("agent").safeParse({
      answered: true,
      started_at: new Date(Date.now() - 60000).toISOString(),
      duration_seconds: 90,
      outcome: "Interested",
      notes: "",
      ...body,
    });
  it("takes one temperature, only after speaking to the customer, and keeps other tags", async () => {
    const issue = (result) => result.error?.issues[0]?.message;
    expect(issue(manual({ deal_tags: ["Hot lead", "Cold lead"] }))).toMatch(
      /one lead temperature/,
    );
    expect(
      issue(
        manual({
          answered: false,
          duration_seconds: 0,
          outcome: "No answer",
          deal_tags: ["Warm lead"],
        }),
      ),
    ).toMatch(/after speaking/);
    expect(
      issue(
        callOutcome.safeParse({ outcome: "Busy", deal_tags: ["Hot lead"] }),
      ),
    ).toMatch(/after speaking/);
    expect(
      issue(
        callOutcome.safeParse({
          outcome: "Interested",
          deal_tags: ["Hot lead", "Warm lead"],
        }),
      ),
    ).toMatch(/one lead temperature/);
    const ok = manual({ deal_tags: ["Warm lead", "Ready to visit"] });
    expect(ok.success).toBe(true);
    // Saved as an agent's call is saved: the other tag stays with it.
    const lead = await newLead({ name: "Iqra" });
    const { follow_up_at: _none, ...data } = ok.data;
    const saved = await rpc("log_manual_call", {
      p_lead: lead,
      p_actor: ali,
      p_data: data,
      p_request: "fixture",
    });
    expect(saved.deal_tags).toEqual(["Warm lead", "Ready to visit"]);
    const [row] = (await list({ view: "pipeline" })).data;
    expect(row).toMatchObject({
      name: "Iqra",
      temperature: "warm",
      status: "contacted",
    });
  });
});
