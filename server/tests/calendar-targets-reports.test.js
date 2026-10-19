import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 039: visit calendar, daily/weekly/monthly targets and reports.
const admin = "a9000000-0000-4000-8000-000000000001",
  agent = "a9000000-0000-4000-8000-000000000002",
  other = "a9000000-0000-4000-8000-000000000003";
let pg,
  db,
  one,
  all,
  property,
  phone = 0;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Gulberg House','Lahore',1,'House',5,'marla') returning id",
    )
  ).id;
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
async function newLead(owner = agent, name = "Customer", source = "manual") {
  phone += 1;
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({
        name,
        source,
        ...(owner ? { assigned_agent: owner } : {}),
      }),
      "+9230022" + String(phone).padStart(5, "0"),
      admin,
    ])
  ).id;
}
const visit = (lead, at, owner = agent, status = "scheduled") =>
  one(
    "insert into visits(lead_id,property_id,agent_id,scheduled_at,status) values($1,$2,$3,$4,$5) returning id",
    [lead, property, owner, at, status],
  );
const day = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString();
const range = { p_from: day(-1), p_to: day(1) };

describe("visit calendar", () => {
  it("returns visits in range with names and no contact numbers, scoped by role", async () => {
    const mine = await newLead(agent, "Ayesha Khan");
    const theirs = await newLead(other, "Bilal Ahmed");
    const deleted = await newLead(agent, "Removed Lead");
    await visit(mine, "2026-10-20T06:00:00Z");
    await visit(theirs, "2026-10-21T06:00:00Z", other);
    await visit(mine, "2026-12-20T06:00:00Z");
    await visit(deleted, "2026-10-20T07:00:00Z");
    await one("select public.delete_leads($1,$2,'Duplicate entry','x')", [
      [deleted],
      admin,
    ]);
    const window = {
      p_from: "2026-10-18T19:00:00Z",
      p_to: "2026-10-25T19:00:00Z",
    };
    const all = await rpc("visit_calendar", { p_actor: admin, ...window });
    expect(all.map((v) => v.lead_name)).toEqual(["Ayesha Khan", "Bilal Ahmed"]);
    expect(all[0]).toMatchObject({
      property_title: "Gulberg House",
      agent_name: "Ali Agent",
      status: "scheduled",
    });
    expect(JSON.stringify(all)).not.toMatch(/phone|\+92/);
    expect(
      (
        await rpc("visit_calendar", {
          p_actor: admin,
          ...window,
          p_agent: other,
        })
      ).map((v) => v.lead_name),
    ).toEqual(["Bilal Ahmed"]);
    // Agents see their own leads' visits even when asking for another agent.
    expect(
      (
        await rpc("visit_calendar", {
          p_actor: agent,
          ...window,
          p_agent: other,
        })
      ).map((v) => v.lead_name),
    ).toEqual(["Ayesha Khan"]);
    await expect(
      rpc("visit_calendar", {
        p_actor: admin,
        p_from: "2026-10-01T00:00:00Z",
        p_to: "2026-12-15T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "22023" });
    const api = await request(app())
      .get(
        "/api/visits/calendar?from=2026-10-18T19:00:00Z&to=2026-10-25T19:00:00Z",
      )
      .set(as(agent));
    expect(api.status).toBe(200);
    expect(api.body).toHaveLength(1);
    expect(
      (
        await request(app())
          .get(
            "/api/visits/calendar?from=2026-10-01T00:00:00Z&to=2026-12-15T00:00:00Z",
          )
          .set(as(admin))
      ).status,
    ).toBe(400);
  });
  it("warns about the same agent's visits within an hour", async () => {
    const lead = await newLead(agent, "Ayesha Khan");
    const second = await newLead(agent, "Second Lead");
    const elsewhere = await newLead(other);
    const near = await visit(lead, "2026-10-20T06:30:00Z");
    await visit(lead, "2026-10-20T08:00:00Z");
    await visit(lead, "2026-10-20T06:10:00Z", agent, "cancelled");
    await visit(elsewhere, "2026-10-20T06:15:00Z", other);
    const result = await rpc("visit_conflicts", {
      p_actor: agent,
      p_lead: second,
      p_at: "2026-10-20T07:00:00Z",
    });
    expect(result.agent_id).toBe(agent);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ id: near.id, lead_name: "Ayesha Khan" }),
    ]);
    expect(
      (
        await rpc("visit_conflicts", {
          p_actor: agent,
          p_lead: second,
          p_at: "2026-10-20T07:00:00Z",
          p_exclude: near.id,
        })
      ).conflicts,
    ).toEqual([]);
    const r = await request(app())
      .get(`/api/visits/conflicts?lead_id=${elsewhere}&at=2026-10-20T06:00:00Z`)
      .set(as(agent));
    expect(r.status).toBe(404);
  });
});

describe("daily, weekly and monthly targets", () => {
  it("keeps older monthly targets working and validates new periods", async () => {
    const legacy = (
      await one(
        "select public.crm_mutate('targets',null,$1::jsonb,$2,'legacy') r",
        [
          JSON.stringify({
            agent_id: agent,
            month: "2026-10-01",
            calls: 40,
            visits: 4,
            deals: 1,
            revenue: 0,
          }),
          admin,
        ],
      )
    ).r;
    expect(legacy).toMatchObject({
      period: "month",
      period_start: "2026-10-01",
    });
    const week = await rpc("save_target", {
      p_actor: admin,
      p_id: null,
      p_data: {
        agent_id: agent,
        period: "week",
        period_start: "2026-10-19",
        calls: 10,
        leads_contacted: 25,
        followups_completed: 5,
      },
      p_request: "t",
    });
    expect(week).toMatchObject({
      period: "week",
      period_start: "2026-10-19",
      month: "2026-10-01",
      leads_contacted: 25,
    });
    await expect(
      rpc("save_target", {
        p_actor: admin,
        p_id: null,
        p_data: { agent_id: agent, period: "week", period_start: "2026-10-20" },
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      rpc("save_target", {
        p_actor: admin,
        p_id: null,
        p_data: { agent_id: agent, period: "week", period_start: "2026-10-19" },
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      rpc("save_target", {
        p_actor: agent,
        p_id: week.id,
        p_data: { calls: 1 },
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "42501" });
    const edited = await rpc("save_target", {
      p_actor: admin,
      p_id: week.id,
      p_data: { calls: 12 },
      p_request: "t",
    });
    expect(edited).toMatchObject({ calls: 12, leads_contacted: 25 });
    expect(
      (await all("select action from audit_log where entity='targets'")).map(
        (r) => r.action,
      ),
    ).toEqual(expect.arrayContaining(["create", "update"]));
  });
  it("copies last period's targets for active agents without overwriting", async () => {
    for (const [owner, calls] of [
      [agent, 20],
      [other, 30],
    ])
      await rpc("save_target", {
        p_actor: admin,
        p_id: null,
        p_data: {
          agent_id: owner,
          period: "week",
          period_start: "2026-10-12",
          calls,
        },
        p_request: "t",
      });
    await rpc("save_target", {
      p_actor: admin,
      p_id: null,
      p_data: {
        agent_id: agent,
        period: "week",
        period_start: "2026-10-19",
        calls: 99,
      },
      p_request: "t",
    });
    expect(
      await rpc("copy_targets", {
        p_actor: admin,
        p_period: "week",
        p_start: "2026-10-19",
        p_request: "copy",
      }),
    ).toEqual({ copied: 1, skipped: 1, from: "2026-10-12" });
    expect(
      await all(
        "select agent_id,calls from targets where period='week' and period_start='2026-10-19' order by calls",
      ),
    ).toEqual([
      { agent_id: other, calls: 30 },
      { agent_id: agent, calls: 99 },
    ]);
    const r = await request(app())
      .post("/api/targets/copy")
      .set(as(admin))
      .send({ period: "week", start: "2026-10-20" });
    expect(r.status).toBe(400);
  });
  it("lists each user's targets and those running today", async () => {
    const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    const monday = new Date(Date.parse(today + "T00:00:00Z"));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    for (const [owner, period, start] of [
      [agent, "day", today],
      [agent, "week", monday.toISOString().slice(0, 10)],
      [agent, "month", today.slice(0, 8) + "01"],
      [agent, "day", "2026-01-05"],
      [other, "day", today],
    ])
      await rpc("save_target", {
        p_actor: admin,
        p_id: null,
        p_data: { agent_id: owner, period, period_start: start, calls: 5 },
        p_request: "t",
      });
    const current = await request(app())
      .get("/api/targets?current=true")
      .set(as(agent));
    expect(current.body.data.map((t) => t.period).sort()).toEqual([
      "day",
      "month",
      "week",
    ]);
    expect(current.body.data[0]).toMatchObject({ agent_name: "Ali Agent" });
    expect(
      (await request(app()).get("/api/targets?period=day").set(as(admin))).body
        .count,
    ).toBe(3);
    expect(
      (await request(app()).get("/api/targets?period=day").set(as(agent))).body
        .count,
    ).toBe(2);
    expect(
      (
        await request(app())
          .post("/api/targets")
          .set(as(agent))
          .send({ agent_id: agent, period: "day", period_start: today })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .post("/api/targets")
          .set(as(admin))
          .send({ agent_id: agent, period: "day", period_start: today })
      ).status,
    ).toBe(409);
    const created = await request(app())
      .post("/api/targets")
      .set(as(admin))
      .send({
        agent_id: other,
        period: "month",
        period_start: "2026-11-01",
        calls: 50,
        revenue: 5000000,
      });
    expect(created.status).toBe(201);
    const patched = await request(app())
      .patch("/api/targets/" + created.body.id)
      .set(as(admin))
      .send({ calls: 60 });
    expect(patched.body).toMatchObject({ calls: 60, revenue: 5000000 });
  });
  it("measures leads contacted and follow-ups completed", async () => {
    const a = await newLead(agent),
      b = await newLead(agent);
    await pg.query(
      "insert into calls(lead_id,agent_id,status) values($1,$2,'initiated'),($1,$2,'failed'),($3,$2,'completed')",
      [a, agent, b],
    );
    const f = await one(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()) returning id",
      [a, agent],
    );
    await pg.query("update followups set status='completed' where id=$1", [
      f.id,
    ]);
    const stamped = (
      await one("select completed_at from followups where id=$1", [f.id])
    ).completed_at;
    expect(stamped).not.toBeNull();
    await pg.query(
      "update followups set notes='x',status='completed' where id=$1",
      [f.id],
    );
    expect(
      (await one("select completed_at from followups where id=$1", [f.id]))
        .completed_at,
    ).toEqual(stamped);
    const metrics = await rpc("crm_metrics", {
      p_actor: admin,
      ...range,
      p_agent: agent,
    });
    expect(metrics).toMatchObject({
      leads_contacted: 2,
      followups_completed: 1,
    });
    await pg.query("update followups set status='pending' where id=$1", [f.id]);
    expect(
      (await one("select completed_at from followups where id=$1", [f.id]))
        .completed_at,
    ).toBeNull();
  });
});

describe("reports", () => {
  async function scenario() {
    const won = await newLead(agent, "Won Lead", "CSV");
    const lost = await newLead(agent, "Lost Lead", "CSV");
    const fresh = await newLead(other, "Fresh Lead", "Meta");
    await pg.query(
      "insert into calls(lead_id,agent_id,status,started_at,ended_at,duration_seconds) values($1,$2,'completed',now(),now(),300),($3,$2,'failed',now(),now(),0)",
      [won, agent, lost],
    );
    for (const status of [
      "contacted",
      "interested",
      "visit_scheduled",
      "visit_done",
      "negotiation",
      "won",
    ])
      await pg.query("update leads set status=$1 where id=$2", [status, won]);
    await pg.query("update leads set status='interested' where id=$1", [lost]);
    await pg.query(
      "update leads set status='lost',lost_reason='price' where id=$1",
      [lost],
    );
    await visit(won, new Date().toISOString(), agent, "completed");
    await pg.query(
      "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',7500000,(now() at time zone 'Asia/Karachi')::date)",
      [won, property, agent],
    );
    return { won, lost, fresh };
  }
  it("reports sources, agents, funnel and lost reasons consistently", async () => {
    await scenario();
    const sources = await rpc("report_sources", { p_actor: admin, ...range });
    expect(sources).toEqual([
      {
        source: "CSV",
        leads: 2,
        contacted: 2,
        visited: 1,
        won: 1,
        lost: 1,
        revenue: 7500000,
      },
      {
        source: "Meta",
        leads: 1,
        contacted: 0,
        visited: 0,
        won: 0,
        lost: 0,
        revenue: 0,
      },
    ]);
    const agents = await rpc("report_agents", { p_actor: admin, ...range });
    expect(agents.map((a) => a.name)).toEqual(["Ali Agent", "Sara Agent"]);
    expect(agents[0]).toMatchObject({
      assigned: 2,
      first_calls: 2,
      calls: 2,
      connected_calls: 1,
      talk_minutes: 5,
      visits_completed: 1,
      won_deals: 1,
      revenue: 7500000,
      lost: 1,
    });
    expect(agents[1]).toMatchObject({ assigned: 1, first_calls: 0, calls: 0 });
    const own = await rpc("report_agents", { p_actor: agent, ...range });
    expect(own.map((a) => a.name)).toEqual(["Ali Agent"]);
    const funnel = await rpc("report_funnel", { p_actor: admin, ...range });
    expect(funnel.total).toBe(3);
    expect(funnel.lost).toBe(1);
    expect(
      Object.fromEntries(funnel.stages.map((s) => [s.stage, s.reached])),
    ).toEqual({
      new: 3,
      contacted: 2,
      interested: 2,
      visit_scheduled: 1,
      visit_done: 1,
      negotiation: 1,
      won: 1,
    });
    const lost = await rpc("report_lost", { p_actor: admin, ...range });
    expect(lost).toEqual({
      total: 1,
      by_reason: [{ reason: "price", count: 1 }],
      by_source: [{ source: "CSV", count: 1 }],
      by_agent: [{ agent_id: agent, name: "Ali Agent", count: 1 }],
    });
    const metrics = await rpc("crm_metrics", { p_actor: admin, ...range });
    expect(metrics.leads).toBe(funnel.total);
    expect(metrics.won_deals).toBe(agents[0].won_deals + agents[1].won_deals);
  });
  it("serves reports and admin-only CSV exports over the API", async () => {
    await scenario();
    const q = `from=${encodeURIComponent(day(-1))}&to=${encodeURIComponent(day(1))}`;
    const funnel = await request(app())
      .get("/api/reports/funnel?" + q)
      .set(as(admin));
    expect(funnel.status).toBe(200);
    expect(funnel.body.total).toBe(3);
    const csv = await request(app())
      .get("/api/reports/sources/export?" + q)
      .set(as(admin));
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\r\n")[0]).toBe(
      '"Source","Leads","Contacted","Visited","Won","Lost","Conversion %","Won revenue (PKR)"',
    );
    expect(csv.text).toContain(
      '"CSV / Excel","2","2","1","1","1","50","7500000"',
    );
    expect(
      (
        await request(app())
          .get("/api/reports/agents/export?" + q)
          .set(as(agent))
      ).status,
    ).toBe(403);
    // The existing summary export is unchanged.
    const summary = await request(app())
      .get("/api/reports/export?" + q)
      .set(as(admin));
    expect(summary.status).not.toBe(404);
    expect(
      (
        await request(app())
          .get("/api/reports/unknown?" + q)
          .set(as(admin))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app())
          .get(
            `/api/reports/lost?from=${encodeURIComponent(day(1))}&to=${encodeURIComponent(day(-1))}`,
          )
          .set(as(admin))
      ).status,
    ).toBe(400);
  });
});
