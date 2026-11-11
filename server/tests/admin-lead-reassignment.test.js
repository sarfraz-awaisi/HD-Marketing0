import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 060: All leads' Assign to agent moves the selected leads to one
// agent, whoever has them and whatever their calls, as the single-lead
// Reassign does. Each lead is reported as assigned, reassigned, not changed
// (already that agent's) or failed. Round-robin unassigned still never
// takes a lead from an agent.
const admin = "60000000-0000-4000-8000-000000000001",
  ali = "60000000-0000-4000-8000-000000000002",
  sara = "60000000-0000-4000-8000-000000000003",
  staff = "60000000-0000-4000-8000-000000000004";
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
const call = (lead, minutes, outcome) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    ali,
    JSON.stringify({
      answered: !["No answer", "Busy", "Number off"].includes(outcome),
      started_at: minutesAgo(minutes),
      duration_seconds: 60,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);
const move = (lead_ids, agent_id = sara, user = admin) =>
  request(app())
    .post("/api/leads/assign-selected")
    .set(as(user))
    .send({ lead_ids, agent_id });
const report = (body) =>
  body.results.map((r) => [r.name, r.result, r.reason || null]).sort();

describe("moving selected leads to one agent (update 060)", () => {
  it("moves leads from another agent, whatever their calls, keeping their history", async () => {
    const leads = {};
    for (const [name, outcome] of [
      ["No answer lead", "No answer"],
      ["Busy lead", "Busy"],
      ["Number off lead", "Number off"],
      ["Answered lead", "Interested"],
    ]) {
      leads[name] = await newLead(
        name,
        "+9230000001" + String(Object.keys(leads).length).padStart(2, "0"),
        { assigned_agent: ali },
      );
      await call(leads[name], 30, outcome);
    }
    const answered = leads["Answered lead"];
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Wants a corner plot')",
      [answered, ali],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 day')",
      [answered, ali],
    );
    const free = await newLead("New customer", "+923000000120");
    const saras = await newLead("Sara's customer", "+923000000121", {
      assigned_agent: sara,
    });
    const gone = await newLead("Deleted lead", "+923000000122");
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const moved = Object.values(leads);
    const history = () =>
      one(
        "select (select jsonb_agg(to_jsonb(c) order by c.id) from calls c where lead_id=any($1)) calls,(select jsonb_agg(to_jsonb(n) order by n.id) from notes n where lead_id=any($1)) notes",
        [moved],
      );
    const before = await history();
    const saraBefore = (
      await one("select to_jsonb(l) l from leads l where id=$1", [saras])
    ).l;
    const { body } = await move([...moved, free, saras, gone]).expect(200);
    expect(body).toMatchObject({
      assigned: 1,
      reassigned: 4,
      skipped: 1,
      failed: 1,
    });
    expect(report(body)).toEqual(
      [
        ["No answer lead", "reassigned", "Moved from Ali Agent"],
        ["Busy lead", "reassigned", "Moved from Ali Agent"],
        ["Number off lead", "reassigned", "Moved from Ali Agent"],
        ["Answered lead", "reassigned", "Moved from Ali Agent"],
        ["New customer", "assigned", null],
        ["Sara's customer", "skipped", "Already assigned to Sara Agent"],
        ["Deleted lead", "failed", "Lead not found or in Deleted leads"],
      ].sort(),
    );
    expect(
      (
        await one(
          "select count(*)::int n from leads where id=any($1) and assigned_agent=$2",
          [[...moved, free], sara],
        )
      ).n,
    ).toBe(5);
    // Calls (still filed under Ali, who made them) and notes are untouched;
    // the pending follow-up is now Sara's.
    expect(await history()).toEqual(before);
    expect(
      await all("select agent_id,status from followups where lead_id=$1", [
        answered,
      ]),
    ).toEqual([{ agent_id: sara, status: "pending" }]);
    // Sara's own lead is exactly as it was.
    expect(
      (await one("select to_jsonb(l) l from leads l where id=$1", [saras])).l,
    ).toEqual(saraBefore);
    // Each move is audited and recorded as an assignment.
    expect(
      await one(
        "select (select count(*)::int from audit_log where action='assign' and entity_id=any($1) and metadata->>'agent_id'=$2::text) leads,(select count(*)::int from audit_log where action='lead.bulk_assigned') bulk,(select count(*)::int from assignments where lead_id=any($3) and agent_id=$2::uuid) assignments",
        [[...moved, free].map(String), sara, [...moved, free]],
      ),
    ).toEqual({ leads: 5, bulk: 1, assignments: 5 });
    // Sara now has the leads in her list; Ali no longer does and is told.
    const myLeads = async (user) =>
      (
        await request(app()).get("/api/my-leads").set(as(user)).expect(200)
      ).body.data
        .map((l) => l.name)
        .sort();
    expect(await myLeads(sara)).toEqual(
      [...Object.keys(leads), "New customer", "Sara's customer"].sort(),
    );
    expect(await myLeads(ali)).toEqual([]);
    expect(
      (
        await one(
          "select count(*)::int n from notifications where user_id=$1 and type='lead_moved_away'",
          [ali],
        )
      ).n,
    ).toBeGreaterThan(0);
  });

  it("moves one lead, even from an inactive agent, and leaves a lead already with the agent unchanged", async () => {
    const lead = await newLead("Single lead", "+923000000130", {
      assigned_agent: ali,
    });
    await call(lead, 20, "Number off");
    await pg.query("update profiles set active=false where id=$1", [ali]);
    expect((await move([lead]).expect(200)).body).toMatchObject({
      assigned: 0,
      reassigned: 1,
      skipped: 0,
      failed: 0,
      results: [{ name: "Single lead", result: "reassigned" }],
    });
    const after = (
      await one("select to_jsonb(l) l from leads l where id=$1", [lead])
    ).l;
    const again = (await move([lead]).expect(200)).body;
    expect(again).toMatchObject({ assigned: 0, reassigned: 0, skipped: 1 });
    expect(report(again)).toEqual([
      ["Single lead", "skipped", "Already assigned to Sara Agent"],
    ]);
    expect(
      (await one("select to_jsonb(l) l from leads l where id=$1", [lead])).l,
    ).toEqual(after);
    // Round-robin unassigned still never takes a lead from an agent, and the
    // single-lead Reassign is unchanged.
    expect(
      (
        await request(app())
          .post("/api/leads/assign-unassigned")
          .set(as(admin))
          .send({ lead_ids: [lead], mode: "round_robin" })
          .expect(200)
      ).body,
    ).toMatchObject({ assigned: 0, skipped: 1, failed: 0 });
    await pg.query("update profiles set active=true where id=$1", [ali]);
    expect(
      (
        await request(app())
          .post("/api/leads/assign-bulk")
          .set(as(admin))
          .send({ lead_ids: [lead], mode: "agent", agent_id: ali })
          .expect(200)
      ).body,
    ).toMatchObject({ assigned: 1, skipped: 0, failed: 0 });
  });

  it("is for administrators only, to an active agent, and changes nothing when refused", async () => {
    const lead = await newLead("Somebody", "+923000000140", {
      assigned_agent: ali,
    });
    const before = (
      await one("select to_jsonb(l) l from leads l where id=$1", [lead])
    ).l;
    for (const user of [ali, sara, staff])
      await move([lead], sara, user).expect(403);
    expect(
      (
        await db.rpc("admin_assign_leads", {
          p_lead_ids: [lead],
          p_actor: ali,
          p_agent: sara,
          p_request: "t",
        })
      ).error.code,
    ).toBe("42501");
    for (const agent of [staff, admin])
      expect((await move([lead], agent).expect(400)).body.error).toBe(
        "Choose an active agent",
      );
    await pg.query("update profiles set active=false where id=$1", [sara]);
    expect((await move([lead]).expect(400)).body.error).toBe(
      "Choose an active agent",
    );
    for (const send of [
      { lead_ids: [lead] },
      { lead_ids: [], agent_id: sara },
      { lead_ids: [lead, lead], agent_id: sara },
      { lead_ids: [lead], agent_id: sara, mode: "agent" },
    ])
      await request(app())
        .post("/api/leads/assign-selected")
        .set(as(admin))
        .send(send)
        .expect(400);
    expect(
      (await one("select to_jsonb(l) l from leads l where id=$1", [lead])).l,
    ).toEqual(before);
  });
});
