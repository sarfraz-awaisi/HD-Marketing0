import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 062: All leads shares selected leads among chosen agents in turn,
// or gives them to one agent, moving leads other agents have too. Shares
// are even (they differ by at most one), a lead already with a chosen agent
// stays while that agent's share allows, the plan is the same every time
// for the same leads and agents, and a preview changes nothing.
const admin = "62000000-0000-4000-8000-000000000001",
  ali = "62000000-0000-4000-8000-000000000002",
  sara = "62000000-0000-4000-8000-000000000003",
  omar = "62000000-0000-4000-8000-000000000004",
  zed = "62000000-0000-4000-8000-000000000005",
  staff = "62000000-0000-4000-8000-000000000006";
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
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'omar@gmail.com',now()),($2,'zed@gmail.com',now()),($3,'staff@gmail.com',now())",
    [omar, zed, staff],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$3 then 'staff' else 'agent' end,name=case id when $1 then 'Omar Agent' when $2 then 'Zed Agent' else 'Sam Staff' end where id=any($4::uuid[])",
    [omar, zed, staff, [omar, zed, staff]],
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
async function newLead(name, owner = null) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...(owner ? { assigned_agent: owner } : {}) }),
      "+92300006" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
const call = (lead, agent, outcome) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    agent,
    JSON.stringify({
      answered: !["No answer", "Busy", "Number off"].includes(outcome),
      started_at: new Date(Date.now() - 600000).toISOString(),
      duration_seconds: 60,
      outcome,
      notes: "Agent's own comment",
      deal_tags: ["Warm lead"],
    }),
  ]);
const share = (lead_ids, agent_ids, { token, user = admin } = {}) =>
  request(app())
    .post("/api/leads/distribute")
    .set(as(user))
    .send({ lead_ids, agent_ids, ...(token ? { token } : {}) });
const preview = (lead_ids, agent_ids, user = admin) =>
  request(app())
    .post("/api/leads/distribute/preview")
    .set(as(user))
    .send({ lead_ids, agent_ids });
const owners = async (ids) =>
  Object.fromEntries(
    (
      await all(
        "select l.name,coalesce(p.name,'none') agent from leads l left join profiles p on p.id=l.assigned_agent where l.id=any($1) order by l.name",
        [ids],
      )
    ).map((r) => [r.name, r.agent]),
  );
const perAgent = (body) =>
  Object.fromEntries(
    body.agents.map((a) => [
      a.name,
      [a.kept, a.assigned, a.reassigned, a.total],
    ]),
  );
// Ten leads: four with Ali, one with Sara, two with Zed (not chosen) and
// three with no agent, with calls of every kind.
async function selection() {
  const ids = [];
  for (let n = 1; n <= 10; n++)
    ids.push(
      await newLead(
        `Lead ${String(n).padStart(2, "0")}`,
        n <= 4 ? ali : n === 5 ? sara : n <= 7 ? zed : null,
      ),
    );
  const outcomes = [
    "No answer",
    "Busy",
    "Number off",
    "Interested",
    "Not interested",
  ];
  for (const [i, outcome] of outcomes.entries())
    await call(ids[i], i < 4 ? ali : sara, outcome);
  await call(ids[5], zed, "Interested");
  await pg.query(
    "insert into notes(lead_id,agent_id,body) values($1,$2,'Zed''s note')",
    [ids[5], zed],
  );
  await pg.query(
    "insert into followups(lead_id,agent_id,due_at,notes) values($1,$2,now()+interval '1 day','Zed: call back')",
    [ids[5], zed],
  );
  return ids;
}
const history = (ids) =>
  one(
    "select (select jsonb_agg(to_jsonb(x) order by x.id) from calls x where lead_id=any($1)) calls,(select jsonb_agg(to_jsonb(x) order by x.id) from notes x where lead_id=any($1)) notes,(select jsonb_agg(to_jsonb(x)-'agent_id'-'updated_at' order by x.id) from followups x where lead_id=any($1)) followups,(select jsonb_agg(to_jsonb(x) order by x.id) from lead_status_history x where lead_id=any($1)) stages",
    [ids],
  );

describe("sharing selected leads among agents (update 062)", () => {
  it("previews an even, fixed plan that moves no lead without need, then carries it out", async () => {
    const ids = await selection();
    const before = { owners: await owners(ids), history: await history(ids) };
    const audits = await one("select count(*)::int n from audit_log");
    const first = (await preview(ids, [sara, omar, ali]).expect(200)).body;
    // The same leads and agents, in any order, give the same plan.
    expect((await preview(ids, [ali, omar, sara]).expect(200)).body).toEqual(
      first,
    );
    expect(first).toMatchObject({
      applied: false,
      stale: false,
      assigned: 3,
      reassigned: 2,
      skipped: 5,
      failed: 0,
      moved_from: [{ name: "Zed Agent", count: 2 }],
    });
    // Ten leads, three agents: shares of 4, 3 and 3; the 4 goes to Ali, who
    // already has four of them. [kept, assigned, moved in, total]
    expect(perAgent(first)).toEqual({
      "Ali Agent": [4, 0, 0, 4],
      "Omar Agent": [0, 2, 1, 3],
      "Sara Agent": [1, 1, 1, 3],
    });
    // A preview changes nothing.
    expect(await owners(ids)).toEqual(before.owners);
    expect((await one("select count(*)::int n from audit_log")).n).toBe(
      audits.n,
    );

    const done = (
      await share(ids, [ali, sara, omar], { token: first.token }).expect(200)
    ).body;
    expect(done).toMatchObject({
      applied: true,
      stale: false,
      assigned: 3,
      reassigned: 2,
      skipped: 5,
    });
    expect(perAgent(done)).toEqual(perAgent(first));
    // Turns go alphabetically (Ali full, then Omar, Sara, Omar, Sara, Omar),
    // lowest lead number first.
    expect(await owners(ids)).toEqual({
      "Lead 01": "Ali Agent",
      "Lead 02": "Ali Agent",
      "Lead 03": "Ali Agent",
      "Lead 04": "Ali Agent",
      "Lead 05": "Sara Agent",
      "Lead 06": "Omar Agent",
      "Lead 07": "Sara Agent",
      "Lead 08": "Omar Agent",
      "Lead 09": "Sara Agent",
      "Lead 10": "Omar Agent",
    });
    expect(
      done.results
        .filter((r) => r.result === "reassigned")
        .map((r) => r.reason)
        .sort(),
    ).toEqual([
      "Moved from Zed Agent to Omar Agent",
      "Moved from Zed Agent to Sara Agent",
    ]);
    // Calls, notes and stage history stay; Zed's pending follow-up moved
    // with the lead.
    expect(await history(ids)).toEqual(before.history);
    expect(
      await one("select agent_id from followups where lead_id=$1", [ids[5]]),
    ).toEqual({ agent_id: omar });
    // One audit entry for the action, one per moved lead, and notices.
    expect(
      await one(
        "select (select count(*)::int from audit_log where action='lead.bulk_distributed' and (metadata->>'reassigned')::int=2 and (metadata->>'agents')::int=3) bulk,(select count(*)::int from audit_log where action='assign' and entity_id=any($1) and metadata->>'agent_id'=any($2)) moves",
        [ids.slice(5).map(String), [omar, sara]],
      ),
    ).toEqual({ bulk: 1, moves: 5 });
    expect(
      (
        await all(
          "select distinct user_id,type from notifications where type in ('lead_assigned','lead_moved_away') and user_id=any($1) order by type,user_id",
          [[omar, sara, zed]],
        )
      ).map((r) => [r.user_id, r.type]),
    ).toEqual(
      expect.arrayContaining([
        [omar, "lead_assigned"],
        [sara, "lead_assigned"],
        [zed, "lead_moved_away"],
      ]),
    );
    // Shared again: everything is already where it belongs.
    const again = (await share(ids, [ali, sara, omar]).expect(200)).body;
    expect(again).toMatchObject({
      applied: true,
      assigned: 0,
      reassigned: 0,
      skipped: 10,
    });
  });

  it("evens out a chosen agent's own leads, gives everything to one agent, and refuses social leads in turns", async () => {
    const ids = [];
    for (let n = 1; n <= 6; n++) ids.push(await newLead(`Ali lead ${n}`, ali));
    const even = (await share(ids, [ali, sara]).expect(200)).body;
    expect(perAgent(even)).toEqual({
      "Ali Agent": [3, 0, 0, 3],
      "Sara Agent": [0, 0, 3, 3],
    });
    expect(
      even.results
        .filter((r) => r.result === "reassigned")
        .map((r) => [r.name, r.reason]),
    ).toEqual([
      ["Ali lead 4", "Moved from Ali Agent to Sara Agent"],
      ["Ali lead 5", "Moved from Ali Agent to Sara Agent"],
      ["Ali lead 6", "Moved from Ali Agent to Sara Agent"],
    ]);
    // An incoming social lead waiting for its first agent: refused in turns,
    // assigned to one agent.
    const social = await newLead("Facebook lead");
    await pg.query(
      "update leads set meta_pending_assignment=true where id=$1",
      [social],
    );
    const turns = (await share([social, ids[0]], [ali, sara]).expect(200)).body;
    expect(turns.results.find((r) => r.id === social)).toMatchObject({
      result: "failed",
      reason:
        "An incoming social lead waiting for its first agent: assign it to one agent",
    });
    expect(
      (await one("select assigned_agent from leads where id=$1", [social]))
        .assigned_agent,
    ).toBeNull();
    const single = (await share([...ids, social], [omar]).expect(200)).body;
    expect(single).toMatchObject({
      assigned: 1,
      reassigned: 6,
      skipped: 0,
      failed: 0,
    });
    expect(perAgent(single)).toEqual({ "Omar Agent": [0, 1, 6, 7] });
    expect(
      await one(
        "select count(*)::int n,bool_and(not meta_pending_assignment) cleared from leads where id=any($1) and assigned_agent=$2",
        [[...ids, social], omar],
      ),
    ).toEqual({ n: 7, cleared: true });
  });

  it("keeps every share within one of the others and moves the fewest leads, whatever the mix", async () => {
    // A small fixed pseudo-random sequence, so a failure can be repeated.
    let seed = 61;
    const next = (n) => (
      (seed = (seed * 1103515245 + 12345) % 2147483648),
      seed % n
    );
    const pool = [ali, sara, omar, zed, null];
    const ids = [];
    for (let n = 0; n < 23; n++)
      ids.push(await newLead(`Mixed ${n}`, pool[next(5)]));
    for (let round = 0; round < 8; round++) {
      const agents = [ali, sara, omar, zed]
        .filter(() => next(2))
        .slice(0, 1 + next(4));
      if (!agents.length) agents.push(omar);
      const leads = ids.filter(() => next(3));
      if (!leads.length) leads.push(ids[0]);
      const plan = (await preview(leads, agents).expect(200)).body;
      const reversed = (await preview(leads, [...agents].reverse()).expect(200))
        .body;
      expect(reversed).toEqual(plan);
      const totals = plan.agents.map((a) => a.total);
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
      expect(totals.reduce((a, b) => a + b, 0)).toBe(leads.length);
      // The most leads that can stay with their agent do: each agent keeps
      // as many of their own as their share allows, and the larger shares
      // go to those who own the most.
      const owned = Object.fromEntries(agents.map((a) => [a, 0]));
      for (const row of await all(
        "select assigned_agent from leads where id=any($1)",
        [leads],
      ))
        if (row.assigned_agent in owned) owned[row.assigned_agent]++;
      const base = Math.floor(leads.length / agents.length);
      const extra = leads.length % agents.length;
      const best = Object.values(owned)
        .sort((a, b) => b - a)
        .reduce(
          (sum, n, i) => sum + Math.min(n, base + (i < extra ? 1 : 0)),
          0,
        );
      expect(plan.skipped).toBe(best);
      expect(plan.assigned + plan.reassigned + plan.skipped).toBe(leads.length);
    }
  }, 60000);

  it("returns the new plan instead of acting when something changed after the preview", async () => {
    const ids = await selection();
    const plan = (await preview(ids, [ali, sara]).expect(200)).body;
    // Meanwhile another administrator moves one of the leads.
    await request(app())
      .post("/api/leads/assign-selected")
      .set(as(admin))
      .send({ lead_ids: [ids[9]], agent_id: zed })
      .expect(200);
    const changed = await owners(ids);
    const stale = (
      await share(ids, [ali, sara], { token: plan.token }).expect(200)
    ).body;
    expect(stale).toMatchObject({ applied: false, stale: true });
    expect(stale.token).not.toBe(plan.token);
    expect(await owners(ids)).toEqual(changed);
    // Confirmed with the new plan, it is carried out; the same token cannot
    // carry it out twice.
    expect(
      (await share(ids, [ali, sara], { token: stale.token }).expect(200)).body,
    ).toMatchObject({
      applied: true,
      stale: false,
    });
    const twice = (
      await share(ids, [ali, sara], { token: stale.token }).expect(200)
    ).body;
    expect(twice).toMatchObject({ applied: false, stale: true });
  });

  it("opens a fresh workspace for each agent a lead moves to, without the previous agent's work", async () => {
    const ids = await selection();
    await share(ids, [ali, sara, omar]).expect(200);
    const rows = (
      await request(app()).get("/api/my-leads").set(as(omar)).expect(200)
    ).body.data;
    const moved = rows.find((r) => r.name === "Lead 06");
    expect(moved).toMatchObject({
      reassigned: true,
      first_call_at: null,
      last_call_at: null,
      temperature: null,
      note: null,
      status: "new",
    });
    // A lead with no agent before: Omar is its first agent.
    expect(rows.find((r) => r.name === "Lead 08")).toMatchObject({
      reassigned: false,
    });
    // Ali kept his leads: nothing changed for him.
    const kept = (
      await request(app()).get("/api/my-leads").set(as(ali)).expect(200)
    ).body.data.find((r) => r.name === "Lead 04");
    expect(kept).toMatchObject({
      reassigned: false,
      last_call_outcome: "Interested",
    });
  });

  it("refuses non-administrators, inactive or non-agent accounts and invalid choices, changing nothing", async () => {
    const ids = await selection();
    const before = await owners(ids);
    for (const user of [ali, staff]) {
      await share(ids, [sara], { user }).expect(403);
      await preview(ids, [sara], user).expect(403);
    }
    expect(
      (
        await db.rpc("admin_distribute_leads", {
          p_actor: ali,
          p_lead_ids: ids,
          p_agents: [sara],
          p_apply: true,
          p_token: null,
          p_request: "t",
        })
      ).error.code,
    ).toBe("42501");
    await pg.query("update profiles set active=false where id=$1", [zed]);
    for (const agents of [[zed, sara], [staff], [admin]]) {
      const res = await share(ids, agents).expect(400);
      expect(res.body.error).toMatch(/^Choose active agents only/);
    }
    expect((await share(ids, [zed, sara]).expect(400)).body.error).toBe(
      "Choose active agents only (not an active agent: Zed Agent)",
    );
    // No agent, or the same agent twice.
    expect((await share(ids, []).expect(400)).body.error).toBe(
      "Invalid input: agent_ids",
    );
    expect((await share(ids, [sara, sara]).expect(400)).body.error).toBe(
      "Invalid input: agent_ids",
    );
    await share([], [sara]).expect(400);
    await share([ids[0], ids[0]], [sara]).expect(400);
    await share(ids, [sara], { token: "not-a-token" }).expect(400);
    expect(await owners(ids)).toEqual(before);
    // A deleted lead is reported; the others still move.
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [ids[9]],
      admin,
    ]);
    const res = (await share(ids, [sara]).expect(200)).body;
    expect(res.results.find((r) => r.id === ids[9])).toMatchObject({
      result: "failed",
      reason: "Lead not found or in Deleted leads",
    });
    expect(res).toMatchObject({
      failed: 1,
      assigned: 2,
      reassigned: 6,
      skipped: 1,
    });
  });
});
