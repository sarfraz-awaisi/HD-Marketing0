import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 057: administrators' All leads. The database searches every lead by
// name, contact number (any common format or part of it) or HD number,
// applies the filters together, counts Total, Assigned and Unassigned, and
// pages the result; bulk assignment takes only leads with no agent. Only
// administrators get in, in the server and the database.
const admin = "57000000-0000-4000-8000-000000000001",
  ali = "57000000-0000-4000-8000-000000000002",
  sara = "57000000-0000-4000-8000-000000000003",
  staff = "57000000-0000-4000-8000-000000000004";
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
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
async function newLead(name, phone, data = {}) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...data }),
      phone,
      admin,
    ])
  ).id;
}
const list = async (query = {}, user = admin) =>
  (
    await request(app())
      .get("/api/leads/all?" + new URLSearchParams(query))
      .set(as(user))
      .expect(200)
  ).body;
const names = (body) => body.data.map((l) => l.name);
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};

describe("administrators' All leads (update 057)", () => {
  it("finds a customer by name, by any common form of their number or part of it, or by HD number", async () => {
    await newLead("Ayesha Khan", "+923001234567");
    await newLead("Bilal Ahmed", "+923339876543");
    await newLead("Khan Traders", "+442079460958");
    const number = (
      await one("select lead_no from leads where name='Bilal Ahmed'")
    ).lead_no;
    const find = async (search) => names(await list({ search })).sort();
    expect(await find("khan")).toEqual(["Ayesha Khan", "Khan Traders"]);
    for (const typed of [
      "+92 300 1234567",
      "03001234567",
      "0300-1234567",
      "923001234567",
      "3001234567",
      "00923001234567",
      "1234567",
      "4567",
    ])
      expect(await find(typed), typed).toEqual(["Ayesha Khan"]);
    expect(await find("+44 20 7946 0958")).toEqual(["Khan Traders"]);
    expect(await find(`HD-${String(number).padStart(6, "0")}`)).toEqual([
      "Bilal Ahmed",
    ]);
    expect(await find("hd" + number)).toEqual(["Bilal Ahmed"]);
    // Too few digits for a number: a name search.
    expect(await find("45")).toEqual([]);
    // Never the number itself in the database's answer; the server adds the
    // numbers administrators may see.
    const body = await list({ search: "4567" });
    expect(body.data[0].phone).toBe("+923001234567");
    expect(
      JSON.stringify(
        await rpc("admin_lead_list", {
          p_actor: admin,
          p_query: { search: "4567" },
        }),
      ),
    ).not.toContain("1234567");
  });

  it("filters by assignment, first call, status, lost reason, source and lead file, together, with counts", async () => {
    const a = await newLead("Assigned to Ali", "+923000000001", {
      assigned_agent: ali,
    });
    const b = await newLead("Assigned to Sara", "+923000000002", {
      assigned_agent: sara,
      source: "Meta",
    });
    await newLead("Unassigned one", "+923000000003", { source: "Meta" });
    await newLead("Unassigned two", "+923000000004");
    const gone = await newLead("Deleted lead", "+923000000005");
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    // A Google Sheets file with one lead of each kind.
    const file = (
      await one(
        "insert into lead_imports(file_name,file_format,total_rows,imported_count,created_by) values('DHA plots','sheets',2,2,$1) returning id",
        [admin],
      )
    ).id;
    await pg.query(
      "update leads set import_id=$1 where name in ('Assigned to Sara','Unassigned one')",
      [file],
    );
    await pg.query(
      "update leads set call_due_at=$1,first_call_at=null where id=$2",
      [minutesAgo(30), a],
    );
    await pg.query(
      "update leads set call_due_at=$1,first_call_at=null where id=$2",
      [minutesAgo(-30), b],
    );
    await pg.query(
      "update leads set status='lost',lost_reason='budget' where name='Unassigned two'",
    );
    const all4 = await list();
    expect(all4).toMatchObject({
      count: 4,
      page: 1,
      limit: 20,
      totals: { total: 4, assigned: 2, unassigned: 2 },
    });
    // Newest first.
    expect(names(all4)).toEqual([
      "Unassigned two",
      "Unassigned one",
      "Assigned to Sara",
      "Assigned to Ali",
    ]);
    // The counts are of the leads matching everything but assignment.
    expect(await list({ assignment: "unassigned" })).toMatchObject({
      count: 2,
      totals: { total: 4, assigned: 2, unassigned: 2 },
    });
    expect(names(await list({ assignment: "assigned" }))).toEqual([
      "Assigned to Sara",
      "Assigned to Ali",
    ]);
    expect(names(await list({ agent: ali }))).toEqual(["Assigned to Ali"]);
    expect(names(await list({ call: "missed" }))).toEqual(["Assigned to Ali"]);
    expect(names(await list({ call: "uncalled" }))).toEqual([
      "Assigned to Sara",
    ]);
    expect(
      names(await list({ status: "lost", lost_reason: "budget" })),
    ).toEqual(["Unassigned two"]);
    expect(await list({ source: "Meta", import_id: file })).toMatchObject({
      count: 2,
      totals: { total: 2, assigned: 1, unassigned: 1 },
    });
    expect(
      names(
        await list({
          source: "Meta",
          import_id: file,
          assignment: "unassigned",
        }),
      ),
    ).toEqual(["Unassigned one"]);
    expect(
      await list({ search: "nobody", assignment: "assigned" }),
    ).toMatchObject({
      count: 0,
      data: [],
      totals: { total: 0, assigned: 0, unassigned: 0 },
    });
    // What each row shows.
    expect((await list({ agent: sara })).data[0]).toMatchObject({
      name: "Assigned to Sara",
      assigned_agent: sara,
      assigned_name: "Sara Agent",
      assigned_active: true,
      import_id: file,
      last_call_at: null,
    });
    // An agent's leads are assigned leads.
    await request(app())
      .get(`/api/leads/all?agent=${ali}&assignment=unassigned`)
      .set(as(admin))
      .expect(400);
  });

  it("pages every lead consistently and shows each one's latest call", async () => {
    for (let n = 1; n <= 23; n++)
      await newLead(
        `Buyer ${String(n).padStart(2, "0")}`,
        `+9230000001${String(n).padStart(2, "0")}`,
        {
          assigned_agent: ali,
        },
      );
    const lead = (await one("select id from leads where name='Buyer 05'")).id;
    await pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      lead,
      ali,
      JSON.stringify({
        answered: false,
        started_at: minutesAgo(10),
        duration_seconds: 0,
        outcome: "Number off",
        notes: "",
        deal_tags: [],
      }),
    ]);
    const first = await list();
    const second = await list({ page: 2 });
    expect(first.data).toHaveLength(20);
    expect(second).toMatchObject({ page: 2, count: 23 });
    expect(second.data.map((l) => l.name)).toEqual([
      "Buyer 03",
      "Buyer 02",
      "Buyer 01",
    ]);
    expect(new Set([...names(first), ...names(second)]).size).toBe(23);
    expect(first.data.find((l) => l.name === "Buyer 05")).toMatchObject({
      last_call_outcome: "Number off",
      last_call_connected: false,
    });
  });

  it("selects up to 500 matching leads", async () => {
    await newLead("Pick me", "+923000000010");
    await newLead("Pick me too", "+923000000011", { assigned_agent: ali });
    const { body } = await request(app())
      .get("/api/leads/all/selection?assignment=unassigned&search=pick")
      .set(as(admin))
      .expect(200);
    expect(body.ids).toEqual([
      (await one("select id from leads where name='Pick me'")).id,
    ]);
    await pg.query(
      "do $$ begin for n in 1..500 loop perform public.create_lead(jsonb_build_object('name','Bulk '||n),'+92311'||lpad(n::text,7,'0'),'" +
        admin +
        "','t'); end loop; end $$",
    );
    expect(
      (
        await request(app())
          .get("/api/leads/all/selection")
          .set(as(admin))
          .expect(400)
      ).body.error,
    ).toBe("Choose filters that match 500 leads or fewer to select them all.");
  });

  it("assigns only the selected leads that have no agent, reporting each one", async () => {
    const free1 = await newLead("Free one", "+923000000021");
    const free2 = await newLead("Free two", "+923000000022");
    const taken = await newLead("Ali's customer", "+923000000023", {
      assigned_agent: ali,
    });
    const gone = await newLead("Deleted lead", "+923000000024");
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const before = await one("select to_jsonb(l) l from leads l where id=$1", [
      taken,
    ]);
    const { body } = await request(app())
      .post("/api/leads/assign-unassigned")
      .set(as(admin))
      .send({
        lead_ids: [free1, free2, taken, gone],
        mode: "agent",
        agent_id: sara,
      })
      .expect(200);
    expect(body).toMatchObject({ assigned: 2, skipped: 1, failed: 1 });
    expect(
      body.results.map((r) => [r.name, r.result, r.reason || null]).sort(),
    ).toEqual(
      [
        ["Free one", "assigned", null],
        ["Free two", "assigned", null],
        ["Ali's customer", "skipped", "Already assigned to Ali Agent"],
        ["Deleted lead", "failed", "Lead not found or in Deleted leads"],
      ].sort(),
    );
    expect(
      await all(
        "select name,assigned_agent from leads where id=any($1) order by name",
        [[free1, free2, taken]],
      ),
    ).toEqual([
      { name: "Ali's customer", assigned_agent: ali },
      { name: "Free one", assigned_agent: sara },
      { name: "Free two", assigned_agent: sara },
    ]);
    // Ali's lead is exactly as it was.
    expect(
      (await one("select to_jsonb(l) l from leads l where id=$1", [taken])).l,
    ).toEqual(before.l);
    // Audited: the bulk action and each lead's assignment.
    expect(
      await one(
        "select (select count(*)::int from audit_log where action='lead.bulk_assigned') bulk,(select count(*)::int from audit_log where action='assign' and entity_id = any($1)) leads",
        [[free1, free2]],
      ),
    ).toMatchObject({ bulk: 1 });
    expect(
      (
        await all(
          "select count(*)::int n from assignments where lead_id=any($1) and agent_id=$2",
          [[free1, free2], sara],
        )
      )[0].n,
    ).toBe(2);
    // Round-robin shares new leads among active agents; nothing to do when
    // every lead has an agent.
    const r1 = await newLead("Round one", "+923000000025");
    const r2 = await newLead("Round two", "+923000000026");
    const rr = (
      await request(app())
        .post("/api/leads/assign-unassigned")
        .set(as(admin))
        .send({ lead_ids: [r1, r2], mode: "round_robin" })
        .expect(200)
    ).body;
    expect(rr).toMatchObject({ assigned: 2, skipped: 0, failed: 0 });
    expect(
      new Set(
        (
          await all("select assigned_agent from leads where id=any($1)", [
            [r1, r2],
          ])
        ).map((r) => r.assigned_agent),
      ),
    ).toEqual(new Set([ali, sara]));
    expect(
      (
        await request(app())
          .post("/api/leads/assign-unassigned")
          .set(as(admin))
          .send({ lead_ids: [taken], mode: "agent", agent_id: sara })
          .expect(200)
      ).body,
    ).toMatchObject({ assigned: 0, skipped: 1, failed: 0 });
    // Never unassigning or taking a lead; a valid choice only.
    for (const send of [
      { lead_ids: [free1], mode: "unassign" },
      { lead_ids: [free1], mode: "agent" },
      { lead_ids: [free1], mode: "round_robin", agent_id: ali },
    ])
      await request(app())
        .post("/api/leads/assign-unassigned")
        .set(as(admin))
        .send(send)
        .expect(400);
    await pg.query("update profiles set active=false where id=$1", [ali]);
    const r3 = await newLead("Round three", "+923000000027");
    expect(
      (
        await request(app())
          .post("/api/leads/assign-unassigned")
          .set(as(admin))
          .send({ lead_ids: [r3], mode: "agent", agent_id: ali })
          .expect(400)
      ).body.error,
    ).toBe("Choose an active agent");
  });

  it("is for administrators only, in the server and the database", async () => {
    const lead = await newLead("Somebody", "+923000000031", {
      assigned_agent: ali,
    });
    for (const user of [ali, staff]) {
      await request(app()).get("/api/leads/all").set(as(user)).expect(403);
      await request(app())
        .get("/api/leads/all/selection")
        .set(as(user))
        .expect(403);
      await request(app())
        .post("/api/leads/assign-unassigned")
        .set(as(user))
        .send({ lead_ids: [lead], mode: "round_robin" })
        .expect(403);
    }
    for (const [name, args] of [
      ["admin_lead_list", { p_actor: ali, p_query: {} }],
      [
        "assign_unassigned_leads",
        {
          p_lead_ids: [lead],
          p_actor: ali,
          p_mode: "round_robin",
          p_agent: null,
          p_request: "t",
        },
      ],
    ])
      expect((await db.rpc(name, args)).error.code).toBe("42501");
    // The agent's own lists are as before.
    await request(app()).get("/api/my-leads").set(as(ali)).expect(200);
    await request(app())
      .get("/api/my-leads?view=pipeline")
      .set(as(ali))
      .expect(200);
    for (const query of [
      "page=0",
      "status=unknown",
      "assignment=everyone",
      "import_id=x",
      "sort=name",
    ])
      await request(app())
        .get("/api/leads/all?" + query)
        .set(as(admin))
        .expect(400);
  });
});
