import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 063: team reports and the dashboard numbers, against every
// migration. Each counting rule is checked on records made for it, and every
// number against the records behind it.
const admin = "63000000-0000-4000-8000-000000000001",
  ali = "63000000-0000-4000-8000-000000000002",
  sara = "63000000-0000-4000-8000-000000000003",
  omar = "63000000-0000-4000-8000-000000000004";
let pg, db, one, all, phone;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  phone = 100;
  // Removing the accounts removes everything recorded with them.
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'omar@gmail.com',now())",
    [omar],
  );
  await pg.query(
    "update profiles set active=true,role='agent',name='Omar Agent' where id=$1",
    [omar],
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
// Two days either side of now: wide enough for everything made in a test,
// whatever the time of day it runs.
const range = async () => ({
  f: new Date(Date.now() - 2 * 86400000).toISOString(),
  t: new Date(Date.now() + 2 * 86400000).toISOString(),
});
async function newLead(name, owner = null) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...(owner ? { assigned_agent: owner } : {}) }),
      "+92300063" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
const move = (lead, agent) =>
  pg.query("select admin_assign_leads($1,$2,$3,'t')", [[lead], admin, agent]);
const call = (lead, actor, outcome, minutesAgo = 5) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: !["No answer", "Busy", "Number off"].includes(outcome),
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: 60,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);
const team = async () => {
  const { f, t } = await range();
  return rpc("report_team", { p_actor: admin, p_from: f, p_to: t });
};
const row = (report, agent) => report.agents.find((a) => a.agent_id === agent);
const records = async (metric, agent, limit = 50) => {
  const { f, t } = await range();
  return rpc("report_team_drilldown", {
    p_actor: admin,
    p_query: { metric, ...(agent ? { agent } : {}), from: f, to: t, limit },
  });
};

describe("team reports (update 063)", () => {
  it("counts unique leads received, first time or from another agent, and every move in the history", async () => {
    const l1 = await newLead("Moved twice", ali);
    await move(l1, sara);
    await move(l1, ali);
    const l2 = await newLead("Omar's new lead");
    await move(l2, omar);
    const gone = await newLead("Deleted lead", ali);
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const r = await team();
    // [received, first time, from another agent, moved away]
    const shape = (a) => [
      row(r, a).received,
      row(r, a).received_first_time,
      row(r, a).received_reassigned,
      row(r, a).moved_away,
    ];
    expect(shape(ali)).toEqual([1, 1, 0, 1]);
    expect(shape(sara)).toEqual([1, 0, 1, 1]);
    expect(shape(omar)).toEqual([1, 1, 0, 0]);
    // The all-agents row adds the agents up.
    expect(r.total.received).toBe(3);
    // Ali's history: in, out to Sara, back in.
    const events = await records("assignment_events", ali);
    expect(events.count).toBe(3);
    expect(
      events.data
        .map((e) => [e.record.from?.name ?? null, e.record.agent?.name ?? null])
        .sort(),
    ).toEqual(
      [
        [null, "Ali Agent"],
        ["Ali Agent", "Sara Agent"],
        ["Sara Agent", "Ali Agent"],
      ].sort(),
    );
    expect(events.data.every((e) => e.lead.name === "Moved twice")).toBe(true);
    expect(events.data.some((e) => e.record.how === "lead.bulk_assigned")).toBe(
      true,
    );
  });

  it("credits calls to whoever recorded them, with administrators' calls apart", async () => {
    const lead = await newLead("Caller test", ali);
    await call(lead, ali, "Interested", 9);
    await call(lead, ali, "Not interested", 8);
    await call(lead, ali, "No answer", 7);
    const other = await newLead("Omar's lead", omar);
    await call(other, admin, "Interested", 6);
    const r = await team();
    const ali_ = row(r, ali);
    expect([
      ali_.calls,
      ali_.answered,
      ali_.not_answered,
      ali_.leads_called,
      ali_.leads_answered,
      ali_.interested,
      ali_.not_interested,
      ali_.admin_calls,
    ]).toEqual([3, 2, 1, 1, 1, 1, 1, 0]);
    expect(ali_.talk_minutes).toBe(2);
    const omar_ = row(r, omar);
    expect([omar_.calls, omar_.admin_calls, omar_.first_calls]).toEqual([
      0, 1, 0,
    ]);
    // The administrator's call is a connection, not Omar's first call.
    expect(
      await one("select first_call_at from leads where id=$1", [other]),
    ).toEqual({ first_call_at: null });
    await pg.query(
      "update leads set call_due_at=now()-interval '1 minute' where id=$1",
      [other],
    );
    const later = await team();
    expect([
      row(later, omar).missed_now,
      row(later, omar).not_connected_now,
    ]).toEqual([1, 0]);
    // Omar's own call is his first call.
    await call(other, omar, "Busy", 1);
    expect(
      (
        await one("select first_call_at is not null f from leads where id=$1", [
          other,
        ])
      ).f,
    ).toBe(true);
  });

  it("works out missed first-call deadlines from each assignment, without the background job", async () => {
    const missed = await newLead("Deadline missed", ali);
    const late = await newLead("Called late", ali);
    const moved = await newLead("Moved before its deadline", ali);
    const onTime = await newLead("Called on time", ali);
    await call(onTime, ali, "Busy", 1);
    await call(late, ali, "Busy", 1);
    // Deadlines: two passed this morning; the moved lead's passes after it
    // moved; one is still ahead of the call.
    await pg.query(
      "update assignments set call_due_at=now()-interval '30 minutes' where lead_id=any($1)",
      [[missed, late]],
    );
    await pg.query(
      "update assignments set call_due_at=now()-interval '1 minute',created_at=now()-interval '2 hours' where lead_id=$1",
      [moved],
    );
    await move(moved, sara);
    // Sara took the lead half an hour before Ali's deadline.
    await pg.query(
      "update assignments set created_at=now()-interval '30 minutes' where lead_id=$1 and agent_id=$2",
      [moved, sara],
    );
    await pg.query(
      "update assignments set call_due_at=now()+interval '1 hour' where lead_id=$1 and agent_id=$2",
      [onTime, ali],
    );
    const r = await team();
    expect(row(r, ali).deadlines_missed).toBe(2);
    expect(row(r, ali).first_calls).toBe(2);
    expect(row(r, ali).on_time).toBe(1);
    expect(
      (await records("deadlines_missed", ali)).data
        .map((d) => d.lead.name)
        .sort(),
    ).toEqual(["Called late", "Deadline missed"]);
    // No stamp was needed: the job never ran.
    expect(
      (
        await one(
          "select count(*)::int n from assignments where missed_at is not null",
        )
      ).n,
    ).toBe(0);
  });

  it("counts by Pakistan day, and the days add up to the period", async () => {
    const lead = await newLead("Midnight lead", ali);
    // Calls just before and at Pakistan midnight on 12/13 November 2026.
    for (const at of ["2026-11-12 23:59:59+05", "2026-11-13 00:00:00+05"]) {
      const id = (
        await one(
          "insert into calls(lead_id,agent_id,status,started_at,ended_at,duration_seconds,outcome) values($1,$2,'completed',$3,$3::timestamptz+interval '1 minute',60,'Interested') returning id",
          [lead, ali, at],
        )
      ).id;
      await pg.query(
        "insert into audit_log(actor_id,action,entity,entity_id) values($1,'call.manual_logged','calls',$2)",
        [ali, id],
      );
    }
    const day = await rpc("report_team", {
      p_actor: admin,
      p_from: "2026-11-12T00:00:00+05:00",
      p_to: "2026-11-13T00:00:00+05:00",
    });
    expect(row(day, ali).calls).toBe(1);
    const days = await rpc("report_team_days", {
      p_actor: admin,
      p_from: "2026-11-12T00:00:00+05:00",
      p_to: "2026-11-14T00:00:00+05:00",
      p_agent: ali,
    });
    expect(days.days.map((d) => [d.day, d.calls])).toEqual([
      ["2026-11-12", 1],
      ["2026-11-13", 1],
    ]);
  });

  it("matches every number with the records behind it", async () => {
    const a = await newLead("Lead A", ali);
    const b = await newLead("Lead B", sara);
    await call(a, ali, "Interested", 9);
    await call(b, sara, "Follow-up required", 8);
    await call(b, admin, "No answer", 7);
    await move(a, omar);
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()-interval '1 hour','pending')",
      [b, sara],
    );
    const f = (
      await one(
        "select crm_mutate('followups',null,$1::jsonb,$2,'t')->>'id' id",
        [
          JSON.stringify({
            lead_id: b,
            due_at: new Date(Date.now() + 3600000).toISOString(),
          }),
          sara,
        ],
      )
    ).id;
    await pg.query(
      "select crm_mutate('followups',$1,'{\"status\":\"completed\"}'::jsonb,$2,'t')",
      [f, sara],
    );
    await pg.query("select crm_mutate('notes',null,$1::jsonb,$2,'t')", [
      JSON.stringify({ lead_id: b, body: "Sara's note" }),
      sara,
    ]);
    const r = await team();
    for (const metric of r.metrics) {
      for (const agent of [ali, sara, omar]) {
        const shown = row(r, agent)[metric];
        const behind = (await records(metric, agent)).count;
        expect([metric, agent, behind]).toEqual([metric, agent, shown]);
      }
      expect([metric, (await records(metric)).count]).toEqual([
        metric,
        r.total[metric],
      ]);
    }
    expect(row(r, sara)).toMatchObject({
      followups_created: 1,
      followups_completed: 1,
      followups_overdue_now: 1,
      notes: 1,
      admin_calls: 1,
      followup_required: 1,
    });
  });

  it("puts Today's calling on the same rules, and the dashboard pipeline on every open lead", async () => {
    const lead = await newLead("Today lead", ali);
    await call(lead, ali, "Interested", 3);
    const other = await newLead("Admin-called lead", ali);
    await call(other, admin, "Interested", 2);
    const won = await newLead("Won lead", sara);
    await pg.query("update leads set status='won' where id=$1", [won]);
    const today = (await rpc("call_activity", { p_actor: admin })).agents.find(
      (a) => a.agent_id === ali,
    );
    expect(today).toMatchObject({
      received_today: 2,
      calls_today: 1,
      connected_today: 1,
      leads_called_today: 1,
      admin_calls_today: 1,
    });
    const metrics = await rpc("crm_metrics", {
      p_actor: admin,
      p_from: "2000-01-01T00:00:00Z",
      p_to: "2000-02-01T00:00:00Z",
      p_agent: null,
      p_source: null,
    });
    // Nothing was created in that month, yet the pipeline shows every open
    // lead; won and lost ones are not open.
    expect(metrics.leads).toBe(0);
    expect(metrics.open_by_status).toEqual({ contacted: 2 });
  });

  it("lists overdue leads not connected in their current assignment, and marks a last call from an earlier one", async () => {
    const earlier = await newLead("Answered before the move", ali);
    await call(earlier, ali, "Interested", 9);
    await move(earlier, sara);
    const tried = await newLead("Tried, not reached", sara);
    await call(tried, sara, "No answer", 8);
    const reached = await newLead("Reached", sara);
    await call(reached, sara, "Interested", 7);
    await pg.query(
      "update leads set call_due_at=now()-interval '1 minute' where id=any($1)",
      [[earlier, tried, reached]],
    );
    const list = async (call) =>
      (
        await request(app())
          .get(`/api/leads/all?call=${call}`)
          .set(as(admin))
          .expect(200)
      ).body.data;
    expect((await list("not_connected")).map((l) => l.name).sort()).toEqual([
      "Answered before the move",
      "Tried, not reached",
    ]);
    const missed = await list("missed");
    expect(missed.map((l) => l.name)).toEqual(["Answered before the move"]);
    expect(missed[0]).toMatchObject({
      last_call_outcome: "Interested",
      last_call_earlier: true,
    });
  });

  it("is for administrators only, with checked ranges and metrics", async () => {
    const { f, t } = await range();
    for (const user of [ali])
      for (const path of [
        `/api/reports/team?from=${f}&to=${t}`,
        `/api/reports/team/days?from=${f}&to=${t}`,
        `/api/reports/team/records?metric=calls&from=${f}&to=${t}`,
      ])
        await request(app()).get(encodeURI(path)).set(as(user)).expect(403);
    await request(app())
      .get(encodeURI(`/api/reports/team?from=${t}&to=${f}`))
      .set(as(admin))
      .expect(400);
    await request(app())
      .get(
        encodeURI(
          `/api/reports/team/records?metric=everything&from=${f}&to=${t}`,
        ),
      )
      .set(as(admin))
      .expect(400);
    const ok = await request(app())
      .get(encodeURI(`/api/reports/team?from=${f}&to=${t}`))
      .set(as(admin))
      .expect(200);
    expect(ok.body.agents.map((a) => a.name)).toEqual([
      "Ali Agent",
      "Omar Agent",
      "Sara Agent",
    ]);
    await expect(
      rpc("report_team", { p_actor: ali, p_from: f, p_to: t }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
