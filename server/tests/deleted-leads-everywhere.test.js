import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 071, deleted leads: a lead gets real work (calls with outcomes, a
// note, follow-ups, site visits and a deal), then an administrator deletes
// it. Every report, dashboard, list and Team performance number is read
// before the lead existed, with its work, once deleted, once restored, and
// after a second restore. Deleted, nothing of it counts (Deleted today
// apart); restored, its records count again, once. Attendance and KPI answers
// never change. Against every migration; nothing here changes the rules.
const admin = "71200000-0000-4000-8000-000000000001",
  ali = "71200000-0000-4000-8000-000000000002",
  sara = "71200000-0000-4000-8000-000000000003";
let pg, one;
beforeAll(async () => {
  ({ pg, one } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
let property, kpi;
beforeEach(async () => {
  f = new Date(Date.now() - 86400000).toISOString();
  t = new Date(Date.now() + 2 * 86400000).toISOString();
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])",
    [[admin, ali, sara]],
  );
  await pg.exec(
    "delete from attendance_records;delete from attendance_policies;insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','00:00','23:59','{1,2,3,4,5,6,7}',15,'2026-01-01');",
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  // A daily KPI from today, for an answer that must not change.
  kpi = (
    await one(
      "select (kpi_save($1,null,$2::jsonb,'t',now())->>'id')::uuid id",
      [
        admin,
        JSON.stringify({
          title: "Verified inventory",
          question: "How many verified inventories today?",
          frequency: "day",
          answer_type: "number",
          target: 1,
        }),
      ],
    )
  ).id;
});
const value = async (sql, args) => (await one(sql, args)).v;
// Every number, as text, for the test's period around now.
let f, t;
async function numbers() {
  const read = (sql, args = []) => value(sql, args);
  const out = {
    // Deleted today is meant to change; it is read apart.
    "crm_metrics admin": await read(
      "select (crm_metrics($1,$2,$3)-'deleted_today')::text v",
      [admin, f, t],
    ),
    "crm_metrics agent": await read(
      "select (crm_metrics($1,$2,$3)-'deleted_today')::text v",
      [ali, f, t],
    ),
    "dashboard admin": await read(
      "select (jsonb_set(dashboard_snapshot($1,$2,$3),'{metrics}',(dashboard_snapshot($1,$2,$3)->'metrics')-'deleted_today'))::text v",
      [admin, f, t],
    ),
    "dashboard agent": await read(
      "select (jsonb_set(dashboard_snapshot($1,$2,$3),'{metrics}',(dashboard_snapshot($1,$2,$3)->'metrics')-'deleted_today'))::text v",
      [ali, f, t],
    ),
    leaderboard: await read("select crm_leaderboard($1,$2,$3)::text v", [
      admin,
      f,
      t,
    ]),
    "report agents": await read("select report_agents($1,$2,$3)::text v", [
      admin,
      f,
      t,
    ]),
    "report funnel (conversion)": await read(
      "select report_funnel($1,$2,$3)::text v",
      [admin, f, t],
    ),
    "report sources": await read("select report_sources($1,$2,$3)::text v", [
      admin,
      f,
      t,
    ]),
    "report lost": await read("select report_lost($1,$2,$3)::text v", [
      admin,
      f,
      t,
    ]),
    "team performance": await read("select report_team($1,$2,$3)::text v", [
      admin,
      f,
      t,
    ]),
    "team day by day": await read(
      "select report_team_days($1,$2,$3,$4)::text v",
      [admin, f, t, ali],
    ),
    "agent pipeline": await read("select agent_pipeline_numbers($1)::text v", [
      ali,
    ]),
    "admin pipeline agents": await read(
      "select admin_pipeline_agents($1,'{}')::text v",
      [admin],
    ),
    "admin agent pipeline": await read(
      "select (admin_agent_pipeline($1,$2,'{}')->>'count') v",
      [admin, ali],
    ),
    "visit calendar": await read(
      "select visit_calendar($1,$2,$3,null)::text v",
      [admin, f, t],
    ),
    "All leads": await read("select (admin_lead_list($1,'{}')->>'count') v", [
      admin,
    ]),
    "All leads, Follow-up required": await read(
      "select (admin_lead_list($1,'{\"outcome\":\"Follow-up required\"}')->>'count') v",
      [admin],
    ),
    "Assigned leads": await read(
      "select (agent_lead_list($1,'{}')->>'count') v",
      [ali],
    ),
    "Lead pipeline": await read(
      "select (agent_lead_list($1,'{\"view\":\"pipeline\"}')->>'count') v",
      [ali],
    ),
    "Call review: missed": await read(
      "select (lead_review_page($1,'missed',1,100)->>'count') v",
      [admin],
    ),
    "drill-down: completed calls": await read(
      "select (report_drilldown($1,$2::jsonb)->>'count') v",
      [
        admin,
        JSON.stringify({
          report: "summary",
          metric: "completed_calls",
          from: f,
          to: t,
        }),
      ],
    ),
    // Independent of leads.
    attendance: await read(
      "select (select to_jsonb(x) from attendance_totals(current_date-1,current_date+1,$1,now()) x)::text v",
      [ali],
    ),
    "KPI answers": await read(
      "select (select count(*) from kpi_submissions)||':'||kpi_facts($1,current_date,current_date,null)::text v",
      [admin],
    ),
  };
  for (const metric of [
    "received",
    "received_first_time",
    "received_reassigned",
    "moved_away",
    "assignment_events",
    "calls",
    "answered",
    "interested",
    "followup_required",
    "followup_leads",
    "admin_calls",
    "first_calls",
    "followups_created",
    "followups_completed",
    "notes",
  ])
    out["team: " + metric] = await read(
      "select count(*)::text v from report_team_records($1,null,$2,$3)",
      [metric, f, t],
    );
  return out;
}
const mutate = async (table, id, data, actor = ali) =>
  value("select crm_mutate($1,$2,$3::jsonb,$4,'t') v", [
    table,
    id,
    JSON.stringify(data),
    actor,
  ]);
const call = (lead, actor, outcome, minutesAgo) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: outcome !== "No answer",
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: outcome === "No answer" ? 0 : 120,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);
const stored = (lead) =>
  one(
    "select (select count(*)::int from calls where lead_id=$1) calls,(select count(*)::int from notes where lead_id=$1) notes,(select count(*)::int from followups where lead_id=$1) followups,(select count(*)::int from visits where lead_id=$1) visits,(select count(*)::int from deals where lead_id=$1) deals,(select count(*)::int from assignments where lead_id=$1) assignments",
    [lead],
  );
const deletedToday = () =>
  value(
    "select (crm_metrics($1,now()-interval '1 day',now())->>'deleted_today')::int v",
    [admin],
  );
// Team performance without the numbers read from a lead's agent now.
const recordsOnly = (text) => {
  const report = JSON.parse(text);
  const strip = (r) =>
    Object.fromEntries(
      Object.entries(r).filter(
        ([k]) => k !== "followup_leads" && !k.endsWith("_now"),
      ),
    );
  return { total: strip(report.total), agents: report.agents.map(strip) };
};
// Two snapshots' differences, as { number: [a, b] }.
const differences = (a, b) =>
  Object.fromEntries(
    Object.keys(a)
      .filter((k) => a[k] !== b[k])
      .map((k) => [k, [a[k], b[k]]]),
  );

describe("deleted leads count nowhere (update 071)", () => {
  it("leaves every number as before the lead existed, and restores its records once", async () => {
    // Independent work: attendance and a KPI answer.
    await one("select attendance_check_in($1,'t') r", [ali]);
    await one(
      "select kpi_submit($1,(now() at time zone 'Asia/Karachi')::date,$2::jsonb,'t',now()) r",
      [ali, JSON.stringify([{ kpi_id: kpi, answer: 2 }])],
    );
    const s0 = await numbers();
    const lead = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: "Bin check", assigned_agent: ali }),
        "+923007120001",
        admin,
      ])
    ).id;
    await call(lead, ali, "Interested", 30);
    await call(lead, ali, "No answer", 20);
    await call(lead, admin, "Follow-up required", 10);
    await mutate("notes", null, { lead_id: lead, body: "Agent note" });
    await mutate("followups", null, {
      lead_id: lead,
      due_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const done = (
      await mutate("followups", null, {
        lead_id: lead,
        due_at: new Date(Date.now() - 3600000).toISOString(),
      })
    ).id;
    await mutate("followups", done, { status: "completed" });
    const visit = (
      await mutate("visits", null, {
        lead_id: lead,
        property_id: property,
        scheduled_at: new Date(Date.now() + 3 * 3600000).toISOString(),
      })
    ).id;
    await mutate("visits", visit, { status: "completed" });
    await mutate("visits", null, {
      lead_id: lead,
      property_id: property,
      scheduled_at: new Date(Date.now() + 26 * 3600000).toISOString(),
    });
    await mutate("deals", null, {
      lead_id: lead,
      property_id: property,
      stage: "negotiation",
      expected_value: 2500000,
    });
    const s1 = await numbers();
    const records = await stored(lead);
    expect(records).toEqual({
      calls: 3,
      notes: 1,
      followups: 2,
      visits: 2,
      deals: 1,
      assignments: 1,
    });
    // The work shows everywhere it belongs.
    const shown = Object.keys(differences(s0, s1));
    for (const name of [
      "crm_metrics admin",
      "crm_metrics agent",
      "dashboard admin",
      "dashboard agent",
      "leaderboard",
      "report agents",
      "report funnel (conversion)",
      "report sources",
      "team performance",
      "team day by day",
      "agent pipeline",
      "visit calendar",
      "All leads",
      "All leads, Follow-up required",
      "Assigned leads",
      "drill-down: completed calls",
      "team: received",
      "team: calls",
      "team: admin_calls",
      "team: followup_leads",
      "team: notes",
      "team: followups_created",
      "team: followups_completed",
    ])
      expect(shown).toContain(name);
    const deletedBefore = await deletedToday();
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    // Deleted: every number is as before the lead existed.
    expect(differences(s0, await numbers())).toEqual({});
    expect(await deletedToday()).toBe(deletedBefore + 1);
    // Its records stay, for the restore window.
    expect(await stored(lead)).toEqual(records);
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    const s3 = await numbers();
    // Restored: the records count again, once, and no record was made.
    expect(await stored(lead)).toEqual(records);
    for (const name of [
      "leaderboard",
      "report agents",
      "report funnel (conversion)",
      "report sources",
      "team day by day",
      "All leads",
      "All leads, Follow-up required",
      "drill-down: completed calls",
      "team: received",
      "team: calls",
      "team: answered",
      "team: interested",
      "team: admin_calls",
      "team: first_calls",
      "team: notes",
      "team: followups_created",
      "team: followups_completed",
      "team: assignment_events",
    ])
      expect([name, s3[name]]).toEqual([name, s1[name]]);
    // The calendar shows both visits again; the one still scheduled when the
    // lead was deleted was cancelled then.
    const visits = (text) => JSON.parse(text).map((v) => [v.id, v.status]);
    expect(visits(s3["visit calendar"])).toEqual(
      visits(s1["visit calendar"]).map(([id, status]) => [
        id,
        status === "scheduled" ? "cancelled" : status,
      ]),
    );
    // Team performance: every number counted from records is back; those
    // read from the lead's agent now (Follow-ups, waiting, missed) are not.
    expect(recordsOnly(s3["team performance"])).toEqual(
      recordsOnly(s1["team performance"]),
    );
    // As update 032 decided: a restored lead has no agent, so it is in no
    // agent's lists or current follow-ups; deleting cancelled its pending
    // follow-up and scheduled visit, and restoring does not reschedule them.
    expect([s3["Assigned leads"], s3["team: followup_leads"]]).toEqual([
      s0["Assigned leads"],
      s0["team: followup_leads"],
    ]);
    expect(
      await one(
        "select (select array_agg(status order by status) from followups where lead_id=$1) followups,(select array_agg(status order by status) from visits where lead_id=$1) visits,(select assigned_agent from leads where id=$1) agent",
        [lead],
      ),
    ).toEqual({
      followups: ["cancelled", "completed"],
      visits: ["cancelled", "completed"],
      agent: null,
    });
    // A second restore changes nothing.
    const again = await value(
      "select restore_leads($1,$2,'t')->>'restored' v",
      [[lead], admin],
    );
    expect(again).toBe("0");
    expect(differences(s3, await numbers())).toEqual({});
    expect(await stored(lead)).toEqual(records);
    // Attendance and the KPI answer never moved.
    for (const s of [s1, s3])
      expect([s.attendance, s["KPI answers"]]).toEqual([
        s0.attendance,
        s0["KPI answers"],
      ]);
  });

  it("restored and given back to an agent, the lead and its history count for them again", async () => {
    const lead = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: "Back to Sara", assigned_agent: sara }),
        "+923007120002",
        admin,
      ])
    ).id;
    await call(lead, sara, "Interested", 5);
    const before = await numbers();
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    await pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [lead],
      admin,
      sara,
    ]);
    const after = await numbers();
    // Calls, the leaderboard and Team performance's calls are as before.
    for (const name of ["leaderboard", "team: calls", "team: answered"])
      expect([name, after[name]]).toEqual([name, before[name]]);
    // Given back to the agent who had it: not received a second time.
    expect(after["team: received"]).toBe(before["team: received"]);
    expect(await stored(lead)).toMatchObject({ calls: 1, assignments: 2 });
  });
});
