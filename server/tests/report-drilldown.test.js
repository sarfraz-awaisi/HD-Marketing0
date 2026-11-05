import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 050: report drill-down. Every report number must open exactly the
// records it counted. The sweep compares every metric of every report with
// the unchanged report functions over a varied, seeded data set; the other
// tests check particular cases whose answers are known.
const admin = "50000000-0000-4000-8000-000000000001",
  ali = "50000000-0000-4000-8000-000000000002",
  sara = "50000000-0000-4000-8000-000000000003",
  kamran = "50000000-0000-4000-8000-000000000004",
  staff = "50000000-0000-4000-8000-000000000005";
const stages = [
  "new",
  "contacted",
  "interested",
  "visit_scheduled",
  "visit_done",
  "negotiation",
  "won",
];
const sources = ["manual", "CSV", "Meta", "WhatsApp", "other"];
let pg, db, one, all, property, phoneNo;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'kamran@gmail.com',now()),($2,'staff@gmail.com',now())",
    [kamran, staff],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'agent' else 'staff' end,name=case when id=$1 then 'Kamran Agent' else 'Sam Staff' end where id in ($1,$2)",
    [kamran, staff],
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Gulberg House','Lahore',1,'House',5,'marla') returning id",
    )
  ).id;
  phoneNo = 0;
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
// Pakistan dates: "2026-11-01" is midnight in Karachi.
const pkt = (day) => new Date(day + "T00:00:00+05:00").toISOString();
const pktDay = (ms) => new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
const range = (from, through) => ({
  from: pkt(from),
  to: new Date(Date.parse(pkt(through)) + 86400000).toISOString(),
});
const drill = (query, actor = admin) =>
  rpc("report_drilldown", { p_actor: actor, p_query: { limit: 50, ...query } });
// All pages of a drill-down, as rows.
async function everything(query) {
  const rows = [];
  for (let page = 1; ; page++) {
    const r = await drill({ ...query, page });
    rows.push(...r.data);
    if (r.data.length < r.limit) return rows;
  }
}
const names = (rows) => rows.map((r) => r.lead.name).sort();
async function newLead({
  owner = ali,
  name = "Customer",
  source = "manual",
  created,
} = {}) {
  phoneNo += 1;
  const id = (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({
        name,
        source,
        ...(owner ? { assigned_agent: owner } : {}),
      }),
      "+9230055" + String(phoneNo).padStart(5, "0"),
      admin,
    ])
  ).id;
  if (created)
    await pg.query("update leads set created_at=$2 where id=$1", [id, created]);
  return id;
}
// Writes a past time that the lead triggers would otherwise replace (they
// keep the first lost_at, for example), with the triggers off for this one
// statement.
async function backdate(sql, args) {
  await pg.exec("set session_replication_role=replica");
  try {
    await pg.query(sql, args);
  } finally {
    await pg.exec("set session_replication_role=default");
  }
}
const moveTo = async (lead, ...path) => {
  for (const status of path)
    await pg.query(
      "update leads set status=$2,lost_reason=case when $2='lost' then coalesce(lost_reason,'price') end where id=$1",
      [lead, status],
    );
};
async function call(lead, agent, at, { status = "completed", actor } = {}) {
  const id = (
    await one(
      "insert into calls(lead_id,agent_id,status,started_at,ended_at,duration_seconds,outcome) values($1,$2,$3,$4,$4::timestamptz+interval '2 minutes',120,'Interested') returning id",
      [lead, agent, status, at],
    )
  ).id;
  if (actor)
    await pg.query(
      "insert into audit_log(actor_id,action,entity,entity_id,metadata) values($1,'create','calls',$2,'{}')",
      [actor, id],
    );
  return id;
}

describe("every report number opens exactly its records", () => {
  // A varied data set: owners, sources, reassignments, stage histories that
  // went back, lost leads, calls by other people, visits, deals, follow-ups,
  // missed first calls and deleted leads, spread over three weeks.
  async function seed() {
    let s = 42;
    const random = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const now = Date.now();
    const at = (days) => new Date(now + days * 86400000).toISOString();
    const leads = [];
    for (let i = 0; i < 64; i++) {
      const owner = pick([ali, ali, sara, kamran, null]);
      const lead = await newLead({
        owner,
        name: "Lead " + i,
        source: pick(sources),
        created: at(-18 + random() * 18),
      });
      leads.push(lead);
      const reached = Math.floor(random() * stages.length);
      await moveTo(lead, ...stages.slice(1, reached + 1));
      if (reached >= 3 && random() < 0.3) await moveTo(lead, "contacted");
      if (random() < 0.25) {
        await moveTo(lead, "lost");
        await backdate(
          "update leads set lost_reason=$2,lost_at=$3 where id=$1",
          [
            lead,
            pick(["price", "location", "no_response"]),
            at(-random() * 15),
          ],
        );
      }
      if (random() < 0.3)
        await rpc("assign_lead", {
          p_lead: lead,
          p_actor: admin,
          p_agent: pick([ali, sara, kamran]),
          p_request: "fixture",
        });
      for (let c = Math.floor(random() * 4); c > 0; c--)
        await call(lead, pick([ali, sara, kamran]), at(-random() * 17), {
          status: pick(["completed", "completed", "failed", "initiated"]),
          actor: pick([admin, ali, sara, null]),
        });
      if (random() < 0.5)
        await pg.query(
          "insert into visits(lead_id,property_id,agent_id,scheduled_at,status) values($1,$2,$3,$4,$5)",
          [
            lead,
            property,
            pick([ali, sara]),
            at(-12 + random() * 16),
            pick(["scheduled", "completed", "cancelled"]),
          ],
        );
      if (random() < 0.35)
        await pg.query(
          "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,$4,$5,($6::timestamptz at time zone 'Asia/Karachi')::date)",
          [
            lead,
            property,
            pick([ali, sara, kamran]),
            pick(["won", "won", "negotiation"]),
            Math.round(random() * 9e6),
            at(-random() * 16),
          ],
        );
      for (let f = Math.floor(random() * 3); f > 0; f--) {
        const done = random() < 0.4;
        const id = (
          await one(
            "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,$3,$4) returning id",
            [
              lead,
              pick([ali, sara]),
              at(-6 + random() * 8),
              done ? "completed" : "pending",
            ],
          )
        ).id;
        if (done)
          await pg.query("update followups set completed_at=$2 where id=$1", [
            id,
            at(-random() * 14),
          ]);
      }
      if (random() < 0.3)
        await pg.query(
          "update assignments set missed_at=$2,call_due_at=coalesce(call_due_at,$3) where id=(select id from assignments where lead_id=$1 order by created_at limit 1)",
          [lead, at(-random() * 10), at(-11)],
        );
      if (random() < 0.4)
        await pg.query(
          "update assignments set created_at=$2 where lead_id=$1",
          [lead, at(-random() * 17)],
        );
    }
    // Numbers that depend on "now": a call ended today, follow-ups due today
    // and overdue, a future visit, an uncalled lead and a missed first call.
    // Ended today in Pakistan, whatever the time of day the tests run.
    const today = Date.parse(pkt(pktDay(now)));
    await call(
      leads[0],
      ali,
      new Date(Math.max(today + 60000, now - 300000)).toISOString(),
      { actor: ali },
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()+interval '1 hour','pending'),($1,$2,now()-interval '3 days','pending')",
      [leads[1], ali],
    );
    await pg.query(
      "insert into visits(lead_id,property_id,agent_id,scheduled_at,status) values($1,$2,$3,now()+interval '2 days','scheduled')",
      [leads[2], property, sara],
    );
    const waiting = await newLead({ owner: sara, name: "Waiting" });
    const late = await newLead({ owner: kamran, name: "Late" });
    await pg.query(
      "update leads set call_due_at=now()-interval '2 hours' where id=$1",
      [late],
    );
    await pg.query(
      "update leads set call_due_at=now()+interval '2 hours' where id=$1",
      [waiting],
    );
    // Deleted leads drop out of every report and every drill-down. Leads
    // with a won deal cannot be deleted, so only those deleted are checked.
    const removal = await rpc("delete_leads", {
      p_lead_ids: leads.slice(-8),
      p_actor: admin,
      p_reason: "Test data removed",
      p_request: "fixture",
    });
    const deleted = removal.results
      .filter((r) => r.result === "deleted")
      .map((r) => r.id);
    expect(deleted.length).toBeGreaterThan(2);
    return { now, deleted };
  }
  const summaryMetrics = [
    "total_leads",
    "assigned_leads",
    "leads",
    "today_completed_calls",
    "completed_calls",
    "completed_visits",
    "won_deals",
    "revenue",
    "due_followups",
    "overdue_followups",
    "scheduled_visits",
    "first_calls",
    "on_time_first_calls",
    "first_calls_with_deadline",
    "avg_first_call_minutes",
    "missed_in_period",
    "uncalled_leads",
    "missed_first_calls",
    "leads_contacted",
    "followups_completed",
  ];
  const agentMetrics = [
    "assigned",
    "first_calls",
    "on_time_first_calls",
    "first_calls_with_deadline",
    "avg_first_call_minutes",
    "missed_first_calls",
    "calls",
    "connected_calls",
    "talk_minutes",
    "visits_completed",
    "won_deals",
    "revenue",
    "lost",
  ];
  it("matches every metric of every report, with and without filters", async () => {
    const { now, deleted } = await seed();
    const ranges = [
      range(pktDay(now - 20 * 86400000), pktDay(now + 86400000)),
      range(pktDay(now - 9 * 86400000), pktDay(now - 3 * 86400000)),
    ];
    const filterSets = [
      {},
      { agent: ali },
      { source: "Meta" },
      { agent: sara, source: "manual" },
    ];
    const checks = [];
    for (const r of ranges) {
      const args = (f = {}) => ({
        p_actor: admin,
        p_from: r.from,
        p_to: r.to,
        p_agent: f.agent || null,
        p_source: f.source || null,
      });
      for (const f of filterSets) {
        for (const metric of summaryMetrics)
          checks.push({ report: "summary", metric, ...r, ...f });
        for (const key of stages.concat("lost"))
          checks.push({
            report: "summary",
            metric: "by_status",
            key,
            ...r,
            ...f,
          });
        for (const key of stages)
          checks.push({ report: "funnel", metric: "stage", key, ...r, ...f });
        for (const metric of ["total", "lost"])
          checks.push({ report: "funnel", metric, ...r, ...f });
        const lost = await rpc("report_lost", args(f));
        checks.push({ report: "lost", metric: "total", ...r, ...f });
        for (const [metric, list, field] of [
          ["reason", lost.by_reason, "reason"],
          ["source", lost.by_source, "source"],
          ["agent", lost.by_agent, "agent_id"],
        ])
          for (const row of list)
            checks.push({
              report: "lost",
              metric,
              key: row[field],
              ...r,
              ...f,
            });
        if (!f.source)
          for (const row of await rpc("report_sources", {
            p_actor: admin,
            p_from: r.from,
            p_to: r.to,
            p_agent: f.agent || null,
          }))
            for (const metric of [
              "leads",
              "contacted",
              "visited",
              "won",
              "lost",
              "revenue",
            ])
              checks.push({
                report: "sources",
                metric,
                key: row.source,
                ...r,
                ...(f.agent ? { agent: f.agent } : {}),
              });
      }
      for (const row of await rpc("report_agents", {
        p_actor: admin,
        p_from: r.from,
        p_to: r.to,
      }))
        for (const metric of agentMetrics)
          checks.push({ report: "agents", metric, key: row.agent_id, ...r });
    }
    const counted = new Set();
    for (const check of checks) {
      const label = JSON.stringify({
        ...check,
        from: undefined,
        to: undefined,
      });
      const result = await drill(check);
      const value = (v) => (v == null ? null : Number(v));
      expect(value(result.value), label).toBe(value(result.report_value));
      if (result.measure === "count")
        expect(result.count, label).toBe(value(result.value));
      // A lead-based number counts each lead once.
      if (result.kind === "lead")
        expect(result.leads, label).toBe(result.count);
      expect(
        result.data.some((row) => deleted.includes(row.lead.id)),
        label,
      ).toBe(false);
      if (result.count) counted.add(`${check.report}.${check.metric}`);
    }
    // The data set reaches every kind of number.
    for (const metric of summaryMetrics.filter(
      (m) => m !== "on_time_first_calls",
    ))
      expect(counted, metric).toContain("summary." + metric);
    for (const name of [
      "summary.by_status",
      "funnel.stage",
      "funnel.lost",
      "lost.reason",
      "lost.source",
      "lost.agent",
      "sources.contacted",
      "sources.visited",
      "sources.revenue",
      "agents.assigned",
      "agents.calls",
      "agents.connected_calls",
      "agents.visits_completed",
      "agents.won_deals",
      "agents.missed_first_calls",
      "agents.lost",
    ])
      expect(counted, name).toContain(name);
    expect(checks.length).toBeGreaterThan(400);
  }, 240000);
});

describe("sales funnel stages", () => {
  // Created 1–4 November (Pakistan time); each reached a known stage.
  async function funnel() {
    const day = "2026-11-02T06:00:00Z";
    const ids = {
      fresh: await newLead({ name: "Fresh", created: day }),
      called: await newLead({ name: "Called", created: day }),
      keen: await newLead({ name: "Keen", source: "Meta", created: day }),
      backtracked: await newLead({ name: "Backtracked", created: day }),
      dropped: await newLead({ name: "Dropped", owner: sara, created: day }),
      booked: await newLead({ name: "Booked", owner: sara, created: day }),
      earlier: await newLead({
        name: "Earlier",
        created: "2026-10-20T06:00:00Z",
      }),
      removed: await newLead({ name: "Removed", created: day }),
    };
    await moveTo(ids.called, "contacted");
    await moveTo(ids.keen, "contacted", "interested");
    // Reached negotiation, then went back to contacted: still counted at
    // negotiation, because the funnel uses the furthest stage.
    await moveTo(
      ids.backtracked,
      "contacted",
      "interested",
      "visit_scheduled",
      "visit_done",
      "negotiation",
      "contacted",
    );
    await moveTo(
      ids.dropped,
      "contacted",
      "interested",
      "visit_scheduled",
      "visit_done",
      "lost",
    );
    await moveTo(ids.booked, ...stages.slice(1));
    await moveTo(ids.earlier, "contacted");
    await moveTo(ids.removed, "contacted");
    await rpc("delete_leads", {
      p_lead_ids: [ids.removed],
      p_actor: admin,
      p_reason: "Duplicate entry",
      p_request: "fixture",
    });
    return ids;
  }
  const nov = range("2026-11-01", "2026-11-04");
  it("lists the leads that reached each stage, matching the funnel's numbers", async () => {
    await funnel();
    const report = await rpc("report_funnel", {
      p_actor: admin,
      p_from: nov.from,
      p_to: nov.to,
      p_agent: null,
      p_source: null,
    });
    const expected = {
      new: ["Backtracked", "Booked", "Called", "Dropped", "Fresh", "Keen"],
      contacted: ["Backtracked", "Booked", "Called", "Dropped", "Keen"],
      interested: ["Backtracked", "Booked", "Dropped", "Keen"],
      visit_scheduled: ["Backtracked", "Booked", "Dropped"],
      visit_done: ["Backtracked", "Booked", "Dropped"],
      negotiation: ["Backtracked", "Booked"],
      won: ["Booked"],
    };
    for (const stage of stages) {
      const rows = await everything({
        report: "funnel",
        metric: "stage",
        key: stage,
        ...nov,
      });
      expect(names(rows), stage).toEqual(expected[stage]);
      expect(rows.length, stage).toBe(
        report.stages.find((s) => s.stage === stage).reached,
      );
    }
    const lost = await everything({ report: "funnel", metric: "lost", ...nov });
    expect(names(lost)).toEqual(["Dropped"]);
    expect(report.lost).toBe(1);
  });
  it("shows the furthest stage, the current status and when the stage was reached", async () => {
    await funnel();
    const rows = await everything({
      report: "funnel",
      metric: "stage",
      key: "negotiation",
      ...nov,
    });
    const back = rows.find((r) => r.lead.name === "Backtracked");
    expect(back.reason).toBe("negotiation");
    expect(back.lead.status).toBe("contacted");
    expect(back.stage_change).toMatchObject({ to: "negotiation" });
    expect(back.lead.number).toMatch(/^HD-\d{6}$/);
    const dropped = (
      await everything({ report: "funnel", metric: "lost", ...nov })
    )[0];
    expect(dropped).toMatchObject({
      reason: "visit_done",
      lead: { status: "lost", lost_reason: "price" },
    });
    expect(dropped.lost_change.at).toBeTruthy();
  });
  it("follows the funnel's agent and source filters", async () => {
    await funnel();
    expect(
      names(
        await everything({
          report: "funnel",
          metric: "stage",
          key: "contacted",
          agent: sara,
          ...nov,
        }),
      ),
    ).toEqual(["Booked", "Dropped"]);
    expect(
      names(
        await everything({
          report: "funnel",
          metric: "stage",
          key: "new",
          source: "Meta",
          ...nov,
        }),
      ),
    ).toEqual(["Keen"]);
  });
});

describe("summary, source, agent and lost-reason numbers", () => {
  it("counts each contacted lead once, however many calls it had", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const twice = await newLead({ name: "Twice" });
    const once = await newLead({ name: "Once", owner: sara });
    const outside = await newLead({ name: "Outside" });
    await call(twice, ali, "2026-11-02T08:00:00Z", { actor: ali });
    await call(twice, ali, "2026-11-03T08:00:00Z", {
      actor: ali,
      status: "failed",
    });
    await call(once, sara, "2026-11-04T10:00:00Z", { actor: sara });
    await call(outside, ali, "2026-11-06T10:00:00Z", { actor: ali });
    const result = await drill({
      report: "summary",
      metric: "leads_contacted",
      ...nov,
    });
    expect(result).toMatchObject({ count: 2, leads: 2, report_value: 2 });
    const row = result.data.find((r) => r.lead.name === "Twice");
    expect(Number(row.amount)).toBe(2);
    expect(row.calls).toBe(2);
    // Contacted by Sara: the summary's agent filter is the caller's agent id.
    expect(
      names(
        (
          await drill({
            report: "summary",
            metric: "leads_contacted",
            agent: sara,
            ...nov,
          })
        ).data,
      ),
    ).toEqual(["Once"]);
  });
  it("lists leads created in the range by current status", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const keen = await newLead({
      name: "Keen",
      created: "2026-11-02T06:00:00Z",
    });
    await newLead({ name: "Fresh", created: "2026-11-02T06:00:00Z" });
    await moveTo(keen, "contacted", "interested");
    const interested = await drill({
      report: "summary",
      metric: "by_status",
      key: "interested",
      ...nov,
    });
    expect(names(interested.data)).toEqual(["Keen"]);
    expect(Number(interested.report_value)).toBe(1);
    expect(
      names(
        (
          await drill({
            report: "summary",
            metric: "by_status",
            key: "new",
            ...nov,
          })
        ).data,
      ),
    ).toEqual(["Fresh"]);
  });
  it("lists a source's leads and a lost reason's leads", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const meta = await newLead({
      name: "From Meta",
      source: "Meta",
      created: "2026-11-03T06:00:00Z",
    });
    await newLead({ name: "Typed in", created: "2026-11-03T06:00:00Z" });
    await call(meta, ali, "2026-11-05T06:00:00Z");
    const sourced = await drill({
      report: "sources",
      metric: "contacted",
      key: "Meta",
      ...nov,
    });
    // Contacted at any time: the sources report follows each lead's progress.
    expect(names(sourced.data)).toEqual(["From Meta"]);
    expect(sourced.report_value).toBe(1);
    await moveTo(meta, "lost");
    await backdate(
      "update leads set lost_reason='location',lost_at='2026-11-04T10:00:00Z' where id=$1",
      [meta],
    );
    const reason = await drill({
      report: "lost",
      metric: "reason",
      key: "location",
      ...nov,
    });
    expect(names(reason.data)).toEqual(["From Meta"]);
    expect(reason.data[0].lead.lost_reason).toBe("location");
    expect(
      (await drill({ report: "lost", metric: "reason", key: "price", ...nov }))
        .count,
    ).toBe(0);
  });
  it("lists an agent's assignments, keeping reassigned leads under each agent", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const moved = await newLead({ name: "Moved" });
    await pg.query(
      "update assignments set created_at='2026-11-02T06:00:00Z' where lead_id=$1",
      [moved],
    );
    await rpc("assign_lead", {
      p_lead: moved,
      p_actor: admin,
      p_agent: sara,
      p_request: "test",
    });
    await pg.query(
      "update assignments set created_at='2026-11-03T06:00:00Z' where lead_id=$1 and agent_id=$2",
      [moved, sara],
    );
    for (const agent of [ali, sara]) {
      const result = await drill({
        report: "agents",
        metric: "assigned",
        key: agent,
        ...nov,
      });
      expect(names(result.data), agent).toEqual(["Moved"]);
      expect(result.data[0].record.agent.id).toBe(agent);
      expect(result.data[0].lead.assigned_agent.id).toBe(sara);
      expect(result.report_value).toBe(1);
    }
  });
});

describe("who called", () => {
  it("names the person who made the call, not the lead's agent", async () => {
    const lead = await newLead({ name: "Busy buyer" });
    // An administrator logs a call on Ali's lead: the call row keeps Ali as
    // its agent, the audit log records the administrator.
    await rpc("log_manual_call", {
      p_lead: lead,
      p_actor: admin,
      p_data: {
        answered: true,
        duration_seconds: 90,
        outcome: "Follow-up required",
        started_at: new Date(Date.now() - 3600000).toISOString(),
      },
      p_request: "test",
    });
    const result = await drill({
      report: "summary",
      metric: "completed_calls",
      ...range(pktDay(Date.now() - 86400000), pktDay(Date.now())),
    });
    const row = result.data[0];
    expect(row.record).toMatchObject({
      outcome: "Follow-up required",
      recorded_agent: { id: ali, name: "Ali Agent" },
      caller: { id: admin, name: "Owner", role: "admin" },
    });
    expect(row.last_call.caller.id).toBe(admin);
    expect(row.lead.assigned_agent.id).toBe(ali);
  });
  it("keeps the earlier caller after the lead is reassigned, and shows the latest call", async () => {
    const lead = await newLead({ name: "Handed over", owner: sara });
    await call(lead, sara, "2026-11-02T06:00:00Z", { actor: sara });
    await call(lead, sara, "2026-11-03T06:00:00Z", { actor: sara });
    await rpc("assign_lead", {
      p_lead: lead,
      p_actor: admin,
      p_agent: ali,
      p_request: "test",
    });
    const [row] = (
      await drill({
        report: "summary",
        metric: "leads",
        ...range("2026-01-01", "2027-12-31"),
      })
    ).data;
    expect(row.lead.assigned_agent.id).toBe(ali);
    expect(row.last_call.caller.id).toBe(sara);
    expect(row.last_call.started_at).toMatch(/^2026-11-03T11:00/);
    expect(row.calls).toBe(2);
  });
  it("says nothing about the caller when no record shows who called", async () => {
    const lead = await newLead({ name: "Unrecorded" });
    await call(lead, ali, "2026-11-02T06:00:00Z");
    const [row] = (
      await drill({
        report: "summary",
        metric: "leads",
        ...range("2026-01-01", "2027-12-31"),
      })
    ).data;
    expect(row.last_call.recorded_agent.id).toBe(ali);
    expect(row.last_call.caller).toBe(null);
  });
});

describe("dates, filters, paging, search and sorting", () => {
  it("uses Pakistan midnights for the range, inclusive of the last day", async () => {
    for (const [name, created] of [
      ["Before", "2026-10-31T18:59:59Z"],
      ["First minute", "2026-10-31T19:00:00Z"],
      ["Last second", "2026-11-04T18:59:59Z"],
      ["After", "2026-11-04T19:00:00Z"],
    ])
      await newLead({ name, created });
    const result = await drill({
      report: "summary",
      metric: "leads",
      ...range("2026-11-01", "2026-11-04"),
    });
    expect(names(result.data)).toEqual(["First minute", "Last second"]);
    // Deals use the Pakistan close date.
    const lead = await newLead({ name: "Deal" });
    for (const day of ["2026-11-04", "2026-11-05"])
      await pg.query(
        "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',100,$4) on conflict (lead_id) do update set close_date=excluded.close_date",
        [lead, property, ali, day],
      );
    expect(
      (
        await drill({
          report: "summary",
          metric: "won_deals",
          ...range("2026-11-01", "2026-11-04"),
        })
      ).count,
    ).toBe(0);
    expect(
      (
        await drill({
          report: "summary",
          metric: "won_deals",
          ...range("2026-11-05", "2026-11-05"),
        })
      ).count,
    ).toBe(1);
  });
  it("pages on the server and keeps the full total", async () => {
    for (let i = 0; i < 30; i++)
      await newLead({
        name: "Paged " + String(i).padStart(2, "0"),
        created: new Date(Date.UTC(2026, 10, 2, 6, i)).toISOString(),
      });
    const nov = range("2026-11-01", "2026-11-04");
    const first = await drill({
      report: "summary",
      metric: "leads",
      limit: 25,
      ...nov,
    });
    const second = await drill({
      report: "summary",
      metric: "leads",
      limit: 25,
      page: 2,
      ...nov,
    });
    expect([first.count, first.data.length, second.data.length]).toEqual([
      30, 25, 5,
    ]);
    expect(second.report_value).toBeUndefined();
    const ids = [...first.data, ...second.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(30);
    // Newest first by default.
    expect(first.data[0].lead.name).toBe("Paged 29");
  });
  it("searches by lead number, name or full contact number, within the number's records", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const target = await newLead({
      name: "Zainab Khan",
      created: "2026-11-02T06:00:00Z",
    });
    await newLead({ name: "Other Buyer", created: "2026-11-02T06:00:00Z" });
    const { lead_no, phone } = await one(
      "select l.lead_no,p.phone from leads l join crm_private.lead_phones p on p.lead_id=l.id where l.id=$1",
      [target],
    );
    const local = "0" + phone.slice(3);
    for (const search of [
      "HD-" + String(lead_no).padStart(6, "0"),
      String(lead_no),
      "zainab",
      phone,
      local,
      local.slice(0, 4) + " " + local.slice(4),
    ]) {
      const result = await drill({
        report: "summary",
        metric: "leads",
        search,
        ...nov,
      });
      expect(names(result.data), search).toEqual(["Zainab Khan"]);
      expect(result.records, search).toBe(2);
    }
    expect(
      (
        await drill({
          report: "summary",
          metric: "leads",
          search: "50%_",
          ...nov,
        })
      ).count,
    ).toBe(0);
  });
  it("narrows by current status and agent, and sorts by creation, activity and latest call", async () => {
    const nov = range("2026-11-01", "2026-11-04");
    const a = await newLead({ name: "A", created: "2026-11-01T06:00:00Z" });
    const b = await newLead({
      name: "B",
      owner: sara,
      created: "2026-11-02T06:00:00Z",
    });
    const c = await newLead({
      name: "C",
      owner: null,
      created: "2026-11-03T06:00:00Z",
    });
    await moveTo(b, "contacted");
    await call(a, ali, "2026-11-04T06:00:00Z");
    await call(b, sara, "2026-11-03T06:00:00Z");
    await pg.query("update leads set last_activity_at=$2 where id=$1", [
      c,
      "2026-11-04T09:00:00Z",
    ]);
    await pg.query("update leads set last_activity_at=$2 where id=$1", [
      a,
      "2026-11-03T09:00:00Z",
    ]);
    await pg.query("update leads set last_activity_at=$2 where id=$1", [
      b,
      "2026-11-01T09:00:00Z",
    ]);
    const order = async (sort) =>
      (
        await drill({ report: "summary", metric: "leads", sort, ...nov })
      ).data.map((r) => r.lead.name);
    expect(await order("created")).toEqual(["C", "B", "A"]);
    expect(await order("activity")).toEqual(["C", "A", "B"]);
    expect(await order("call")).toEqual(["A", "B", "C"]);
    expect(
      names(
        (
          await drill({
            report: "summary",
            metric: "leads",
            status: "contacted",
            ...nov,
          })
        ).data,
      ),
    ).toEqual(["B"]);
    expect(
      names(
        (
          await drill({
            report: "summary",
            metric: "leads",
            owner: sara,
            ...nov,
          })
        ).data,
      ),
    ).toEqual(["B"]);
    expect(
      names(
        (
          await drill({
            report: "summary",
            metric: "leads",
            owner: "none",
            ...nov,
          })
        ).data,
      ),
    ).toEqual(["C"]);
  });
});

describe("access and requests", () => {
  const nov = range("2026-11-01", "2026-11-04");
  const query = (extra = {}) =>
    "/api/reports/drilldown?" +
    new URLSearchParams({
      report: "funnel",
      metric: "stage",
      key: "new",
      ...nov,
      ...extra,
    });
  it("serves administrators masked numbers and writes nothing, however often they browse", async () => {
    const lead = await newLead({
      name: "Called Buyer",
      created: "2026-11-02T06:00:00Z",
    });
    const writes = () =>
      one(
        "select (select count(*)::int from audit_log) audit,(select count(*)::int from crm_private.phone_reveals) reveals",
      );
    const before = await writes();
    // Opening, paging, searching and sorting, as a refreshing page would.
    for (const extra of [
      {},
      {},
      { page: "2" },
      { search: "Called" },
      { sort: "call" },
    ]) {
      const res = await request(app()).get(query(extra)).set(as(admin));
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const res = await request(app()).get(query()).set(as(admin));
    expect(res.body).toMatchObject({ count: 1, report_value: 1 });
    expect(res.body.data[0].lead).toMatchObject({
      id: lead,
      masked_phone: expect.stringMatching(/^\+92\*{6}\d{3}$/),
    });
    expect(res.body.data[0].lead).not.toHaveProperty("phone");
    expect(JSON.stringify(res.body)).not.toMatch(/\+92300\d{7}/);
    expect(await writes()).toEqual(before);
  });
  it("refuses agents and staff, through the API and in the database", async () => {
    await newLead({ name: "Private", created: "2026-11-02T06:00:00Z" });
    for (const user of [ali, staff]) {
      const res = await request(app()).get(query()).set(as(user));
      expect(res.status, user).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/Private/);
    }
    await expect(
      drill({ report: "funnel", metric: "stage", key: "new", ...nov }, ali),
    ).rejects.toThrow(/Administrator access required/);
  });
  it("rejects unknown numbers, keys and filters the report does not use", async () => {
    for (const extra of [
      { metric: "everything" },
      { key: "sold" },
      { report: "agents", metric: "calls", key: ali, agent: sara },
      { report: "sources", metric: "leads", key: "Meta", source: "Meta" },
      { report: "agents", metric: "calls", key: staff },
      { report: "summary", metric: "leads", key: "new" },
      { limit: "1000" },
      { owner: "someone" },
    ]) {
      const res = await request(app()).get(query(extra)).set(as(admin));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const unknown = await request(app())
      .get(query({ metric: "everything" }))
      .set(as(admin));
    expect(unknown.body.error).toBe("Choose a report number to open");
  });
  it("reads a missing key as 'not set', for lost leads without an agent", async () => {
    const lead = await newLead({
      name: "Nobody's",
      owner: null,
      created: "2026-11-02T06:00:00Z",
    });
    await moveTo(lead, "lost");
    await backdate(
      "update leads set lost_at='2026-11-03T06:00:00Z' where id=$1",
      [lead],
    );
    const res = await request(app())
      .get(query({ report: "lost", metric: "agent", key: "none" }))
      .set(as(admin));
    expect(res.status).toBe(200);
    expect(names(res.body.data)).toEqual(["Nobody's"]);
    expect(res.body.report_value).toBe(1);
  });
  it("is reachable only by the server, never by browsers", async () => {
    const rows = await all(
      "select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') signed_in,has_function_privilege('service_role',p.oid,'execute') server,p.provolatile from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'report\\_%' and p.proname in ('report_person','report_recorded_by','report_call_json','report_records','report_metric_value','report_drill_row','report_drilldown') order by 1",
    );
    expect(rows.map((r) => r.proname)).toHaveLength(7);
    for (const r of rows) {
      expect([r.anon, r.signed_in], r.proname).toEqual([false, false]);
      expect(r.server, r.proname).toBe(r.proname === "report_drilldown");
    }
    // The API function locks the administrator's profile, so it must not be
    // stable (the API runs stable functions read-only).
    expect(rows.find((r) => r.proname === "report_drilldown").provolatile).toBe(
      "v",
    );
  });
});
