import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 071: Team performance's eight columns, against every migration.
// Dated checks move records to fixed Pakistan times in early November 2026
// (Monday 2 November is a working day), so a period that has ended is read
// from the assignment history; "now" checks use the database clock.
const admin = "71000000-0000-4000-8000-000000000001",
  ali = "71000000-0000-4000-8000-000000000002",
  sara = "71000000-0000-4000-8000-000000000003",
  omar = "71000000-0000-4000-8000-000000000004";
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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'omar@gmail.com',now())",
    [omar],
  );
  await pg.query(
    "update profiles set active=true,role='agent',name='Omar Agent' where id=$1",
    [omar],
  );
  await pg.exec(
    "delete from attendance_records;delete from attendance_policies;insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-01');update attendance_periods set starts_on='2026-10-01';",
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
const pk = (day, time = "00:00") => `${day}T${time}:00+05:00`;
// Pakistan days, first to last inclusive, as the Reports page sends them.
const days = (first, last = first) => ({
  from: new Date(pk(first)).toISOString(),
  to: new Date(Date.parse(pk(last)) + 86400000).toISOString(),
});
// Two days either side of now: a period still running.
const running = () => ({
  from: new Date(Date.now() - 2 * 86400000).toISOString(),
  to: new Date(Date.now() + 2 * 86400000).toISOString(),
});
async function newLead(name, owner = null) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...(owner ? { assigned_agent: owner } : {}) }),
      "+92300071" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
const move = (lead, agent) =>
  pg.query("select admin_assign_leads($1,$2,$3,'t')", [[lead], admin, agent]);
// Straight to the database: to no agent, or to the agent who has it.
const handover = (lead, agent) =>
  pg.query("select handover_lead($1,$2,$3,'t')", [lead, admin, agent]);
const call = async (lead, actor, outcome) =>
  (
    await one("select (log_manual_call($1,$2,$3::jsonb,'t'))->>'id' id", [
      lead,
      actor,
      JSON.stringify({
        answered: !["No answer", "Busy", "Number off"].includes(outcome),
        started_at: new Date(Date.now() - 60000).toISOString(),
        duration_seconds: ["No answer", "Busy", "Number off"].includes(outcome)
          ? 0
          : 60,
        outcome,
        notes: "",
        deal_tags: [],
      }),
    ])
  ).id;
// Records moved back in time: the latest assignment of a lead (to an agent,
// or to no one), and a call (started and saved then).
const assignedAt = (lead, at) =>
  pg.query(
    "update assignments set created_at=$2 where id=(select id from assignments where lead_id=$1 order by created_at desc,id desc limit 1)",
    [lead, at],
  );
const calledAt = (id, at) =>
  pg.query(
    "update calls set started_at=$2,ended_at=$2::timestamptz+make_interval(secs=>duration_seconds),created_at=$2 where id=$1",
    [id, at],
  );
const team = (range) =>
  rpc("report_team", { p_actor: admin, p_from: range.from, p_to: range.to });
const row = (report, agent) => report.agents.find((a) => a.agent_id === agent);
const eight = (report, agent) => {
  const r = row(report, agent);
  return [
    r.received,
    r.received_first_time,
    r.received_reassigned,
    r.moved_away,
    r.calls,
    r.followup_leads,
  ];
};
// The export's cells (the server quotes every one).
const csvRows = (text) =>
  text
    .split("\r\n")
    .map((line) => line.split(",").map((c) => c.replace(/^"|"$/g, "")));
const records = (metric, agent, range) =>
  rpc("report_team_drilldown", {
    p_actor: admin,
    p_query: { metric, ...(agent ? { agent } : {}), ...range, limit: 50 },
  });

describe("Team performance: assignments (update 071)", () => {
  it("counts each lead once however often it moves, and moved away only to another agent", async () => {
    const l1 = await newLead("Moved four times", ali);
    await move(l1, sara);
    await move(l1, ali);
    await move(l1, sara);
    // To the administrators: not moved to another agent.
    const l2 = await newLead("Back to the team", ali);
    await handover(l2, null);
    const r = await team(running());
    // [received, new, from another agent, moved away, calls, follow-ups]
    expect(eight(r, ali)).toEqual([2, 2, 0, 1, 0, 0]);
    expect(eight(r, sara)).toEqual([1, 0, 1, 1, 0, 0]);
    // The records behind the numbers are the same leads.
    const away = await records("moved_away", ali, running());
    expect(away.count).toBe(1);
    expect(away.data[0].lead.name).toBe("Moved four times");
    // Assignment history keeps every move, the one to the team included:
    // four of the first lead's, two of the second's.
    expect((await records("assignment_events", ali, running())).count).toBe(6);
  });

  it("does not count a lead given again to the agent who already had it", async () => {
    const lead = await newLead("Same agent again", ali);
    await assignedAt(lead, pk("2026-11-02", "11:00"));
    await handover(lead, ali);
    await assignedAt(lead, pk("2026-11-03", "11:00"));
    expect(eight(await team(days("2026-11-02")), ali)).toEqual([
      1, 1, 0, 0, 0, 0,
    ]);
    expect(eight(await team(days("2026-11-03")), ali)).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    // Received in the two days together: once.
    expect(eight(await team(days("2026-11-02", "2026-11-03")), ali)[0]).toBe(1);
  });

  it("splits Pakistan days at midnight: Today, Yesterday, Last 7 days, a month and a custom range", async () => {
    const late = await newLead("Late on the 2nd", ali);
    await assignedAt(late, pk("2026-11-02", "23:59"));
    const early = await newLead("Early on the 3rd", ali);
    await assignedAt(early, pk("2026-11-03", "00:01"));
    const received = async (range) => row(await team(range), ali).received;
    expect(await received(days("2026-11-02"))).toBe(1);
    expect(await received(days("2026-11-03"))).toBe(1);
    // Seven days ending on the 3rd: today and the six before it.
    expect(await received(days("2026-10-28", "2026-11-03"))).toBe(2);
    expect(await received(days("2026-11-01", "2026-11-30"))).toBe(2);
    expect(await received(days("2026-11-03", "2026-11-04"))).toBe(1);
    // In UTC both are on the 2nd: a Pakistan day starts at 19:00Z.
    expect(new Date(pk("2026-11-03", "00:01")).toISOString()).toBe(
      "2026-11-02T19:01:00.000Z",
    );
  });

  it("leaves a deleted lead out of every number without a move, and counts it again once restored", async () => {
    const lead = await newLead("Deleted then restored", ali);
    await call(lead, ali, "Interested");
    await move(lead, sara);
    const before = await team(running());
    expect(eight(before, ali)).toEqual([1, 1, 0, 1, 1, 0]);
    expect(eight(before, sara)).toEqual([1, 0, 1, 0, 0, 0]);
    const rows = await one("select count(*)::int n from assignments");
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    // Deleting writes no assignment: nothing moved away.
    expect((await one("select count(*)::int n from assignments")).n).toBe(
      rows.n,
    );
    const gone = await team(running());
    expect(eight(gone, ali)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(eight(gone, sara)).toEqual([0, 0, 0, 0, 0, 0]);
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    const back = await team(running());
    expect(eight(back, ali)).toEqual(eight(before, ali));
    expect(eight(back, sara)).toEqual(eight(before, sara));
    // Restoring again changes nothing and adds no record.
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    expect(eight(await team(running()), ali)).toEqual(eight(before, ali));
    expect(
      await one(
        "select (select count(*)::int from calls where lead_id=$1) calls,(select count(*)::int from assignments where lead_id=$1) moves",
        [lead],
      ),
    ).toEqual({ calls: 1, moves: 2 });
  });

  it("keeps an inactive agent's history", async () => {
    const lead = await newLead("Omar's lead", omar);
    await call(lead, omar, "Interested");
    await pg.query("update profiles set active=false where id=$1", [omar]);
    const r = row(await team(running()), omar);
    expect(r).toMatchObject({ active: false, received: 1, calls: 1 });
  });
});

describe("Team performance: Total calls (update 071)", () => {
  it("counts every call the agent recorded, never an administrator's", async () => {
    const lead = await newLead("Called often", ali);
    await call(lead, ali, "No answer");
    await call(lead, ali, "Busy");
    await call(lead, ali, "Interested");
    const other = await newLead("Admin called", ali);
    await call(other, admin, "Interested");
    const r = row(await team(running()), ali);
    expect([r.calls, r.leads_called, r.admin_calls]).toEqual([3, 1, 1]);
    const list = await records("calls", ali, running());
    expect(list.count).toBe(3);
    expect(list.data.every((x) => x.record.caller?.name === "Ali Agent")).toBe(
      true,
    );
    // An administrator's call is not filed as the agent's own anywhere.
    expect((await records("calls", null, running())).count).toBe(3);
  });

  it("leaves out calls on a lead in Deleted leads", async () => {
    const lead = await newLead("Deleted with calls", ali);
    await call(lead, ali, "Interested");
    await call(lead, ali, "Interested");
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    expect(row(await team(running()), ali).calls).toBe(0);
  });
});

describe("Team performance: Follow-ups (update 071)", () => {
  it("counts each lead whose latest call ended Follow-up required, once", async () => {
    const twice = await newLead("Two follow-up calls", ali);
    await call(twice, ali, "Follow-up required");
    await call(twice, ali, "Follow-up required");
    const changed = await newLead("Now interested", ali);
    await call(changed, ali, "Follow-up required");
    await call(changed, ali, "Interested");
    const ended = await newLead("Administrator called last", ali);
    await call(ended, ali, "Follow-up required");
    await call(ended, admin, "Not interested");
    const r = row(await team(running()), ali);
    expect(r.followup_leads).toBe(1);
    // The calls with that outcome are still counted apart: four of them.
    expect(r.followup_required).toBe(4);
    const list = await records("followup_leads", ali, running());
    expect(list.count).toBe(1);
    expect(list.data.map((x) => x.lead.name)).toEqual(["Two follow-up calls"]);
    expect(list.data[0].record.outcome).toBe("Follow-up required");
  });

  it("never counts a moved lead for two agents; the new agent starts fresh", async () => {
    const lead = await newLead("Moved after a follow-up", ali);
    await call(lead, ali, "Follow-up required");
    await move(lead, sara);
    let r = await team(running());
    expect([row(r, ali).followup_leads, row(r, sara).followup_leads]).toEqual([
      0, 0,
    ]);
    await call(lead, sara, "Follow-up required");
    r = await team(running());
    expect([row(r, ali).followup_leads, row(r, sara).followup_leads]).toEqual([
      0, 1,
    ]);
    expect(r.total.followup_leads).toBe(1);
  });

  it("reads a period that has ended at its end, from the assignment history", async () => {
    // Ali's follow-up on the 2nd; on the 3rd the lead goes to Sara.
    const moved = await newLead("Moved on the 3rd", ali);
    await assignedAt(moved, pk("2026-11-02", "10:00"));
    await calledAt(
      await call(moved, ali, "Follow-up required"),
      pk("2026-11-02", "12:00"),
    );
    await move(moved, sara);
    await assignedAt(moved, pk("2026-11-03", "09:00"));
    // Ali's follow-up on the 2nd, answered Interested on the 3rd.
    const answered = await newLead("Interested on the 3rd", ali);
    await assignedAt(answered, pk("2026-11-02", "10:00"));
    await calledAt(
      await call(answered, ali, "Follow-up required"),
      pk("2026-11-02", "12:00"),
    );
    await calledAt(
      await call(answered, ali, "Interested"),
      pk("2026-11-03", "12:00"),
    );
    const second = await team(days("2026-11-02"));
    expect(row(second, ali).followup_leads).toBe(2);
    expect(
      (await records("followup_leads", ali, days("2026-11-02"))).data
        .map((x) => x.lead.name)
        .sort(),
    ).toEqual(["Interested on the 3rd", "Moved on the 3rd"]);
    const third = await team(days("2026-11-03"));
    expect([
      row(third, ali).followup_leads,
      row(third, sara).followup_leads,
    ]).toEqual([0, 0]);
    // A period running now reads today's state: neither lead.
    expect(row(await team(running()), ali).followup_leads).toBe(0);
  });

  it("leaves out a deleted lead's follow-up and brings it back for the earlier period once restored", async () => {
    const lead = await newLead("Deleted follow-up", ali);
    await assignedAt(lead, pk("2026-11-02", "10:00"));
    await calledAt(
      await call(lead, ali, "Follow-up required"),
      pk("2026-11-02", "12:00"),
    );
    expect(row(await team(days("2026-11-02")), ali).followup_leads).toBe(1);
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [lead],
      admin,
    ]);
    expect(row(await team(days("2026-11-02")), ali).followup_leads).toBe(0);
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    // Ali had it on the 2nd; restored leads have no agent now.
    expect(row(await team(days("2026-11-02")), ali).followup_leads).toBe(1);
    expect(row(await team(running()), ali).followup_leads).toBe(0);
  });
});

describe("Team performance: Time (update 071)", () => {
  const checkIn = (user, day, time) =>
    one("select public.attendance_check_in_at($1,$2,'t') r", [
      user,
      pk(day, time),
    ]);
  const checkOut = (user, day, time) =>
    one("select public.attendance_check_out_at($1,$2,'t') r", [
      user,
      pk(day, time),
    ]);
  it("adds up checked-out days, counts a missing checkout apart, and follows administrators' corrections", async () => {
    await checkIn(ali, "2026-11-02", "10:00");
    await checkOut(ali, "2026-11-02", "17:45");
    await checkIn(ali, "2026-11-03", "09:55");
    await checkOut(ali, "2026-11-03", "18:25");
    // Checked in on the 4th, never checked out.
    await checkIn(ali, "2026-11-04", "10:10");
    let r = row(await team(days("2026-11-02", "2026-11-05")), ali);
    // 7h 45m + 8h 30m; the 4th adds nothing.
    expect(r).toMatchObject({
      worked_minutes: 975,
      incomplete_days: 1,
      open_days: 0,
      attendance_tracked: true,
    });
    // An administrator records the 5th: 10:00 to 14:00.
    await one(
      "select public.attendance_admin_set_at($1,$2,$3::jsonb,null,false,false,'t',$4) r",
      [
        admin,
        ali,
        JSON.stringify([
          {
            date: "2026-11-05",
            status: "present",
            check_in: "10:00",
            check_out: "14:00",
          },
        ]),
        pk("2026-11-06", "09:00"),
      ],
    );
    r = row(await team(days("2026-11-02", "2026-11-05")), ali);
    expect(r.worked_minutes).toBe(975 + 240);
    // One day is one day; a single day's time is its own.
    expect(row(await team(days("2026-11-02")), ali).worked_minutes).toBe(465);
    // The total adds the agents' time.
    expect((await team(days("2026-11-02"))).total.worked_minutes).toBe(465);
  });

  it("gives no time to an agent who did not check in", async () => {
    expect(row(await team(days("2026-11-02")), sara)).toMatchObject({
      worked_minutes: 0,
      incomplete_days: 0,
    });
  });
});

describe("Team performance API (update 071)", () => {
  it("serves the eight columns, the follow-up leads and a CSV of the table as filtered", async () => {
    const lead = await newLead("CSV lead", ali);
    await call(lead, ali, "Follow-up required");
    await newLead("Sara's lead", sara);
    const range = running();
    const report = await request(app())
      .get("/api/reports/team")
      .query(range)
      .set(as(admin))
      .expect(200);
    expect(row(report.body, ali)).toMatchObject({
      received: 1,
      calls: 1,
      followup_leads: 1,
      worked_minutes: 0,
    });
    const list = await request(app())
      .get("/api/reports/team/records")
      .query({ ...range, metric: "followup_leads", agent: ali })
      .set(as(admin))
      .expect(200);
    expect(list.body.count).toBe(1);
    const csv = await request(app())
      .get("/api/reports/team/export")
      .query(range)
      .set(as(admin))
      .expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csvRows(csv.text).map((cells) => cells.join(","));
    expect(lines[0]).toBe(
      "Agent,Status,Leads received,New,From another agent,Moved away,Total calls,Follow-ups,Time,Time (minutes),Days without checkout",
    );
    expect(lines).toContain("Ali Agent,Active,1,1,0,0,1,1,0h 0m,0,0");
    expect(lines.at(-1)).toMatch(/^All agents shown,,2,2,0,0,1,1,/);
    // One agent, or a name search: only those rows, and their total.
    const one = await request(app())
      .get("/api/reports/team/export")
      .query({ ...range, agent: sara })
      .set(as(admin))
      .expect(200);
    expect(csvRows(one.text).map((cells) => cells[0])).toEqual([
      "Agent",
      "Sara Agent",
      "All agents shown",
    ]);
    const searched = await request(app())
      .get("/api/reports/team/export")
      .query({ ...range, search: "ali" })
      .set(as(admin))
      .expect(200);
    expect(csvRows(searched.text).map((cells) => cells[0])).toEqual([
      "Agent",
      "Ali Agent",
      "All agents shown",
    ]);
  });

  it("is for administrators only", async () => {
    const range = running();
    for (const path of [
      "/api/reports/team",
      "/api/reports/team/export",
      "/api/reports/team/records?metric=followup_leads",
    ])
      await request(app()).get(path).query(range).set(as(ali)).expect(403);
    await request(app())
      .get("/api/reports/team/export")
      .query({ ...range, extra: "1" })
      .set(as(admin))
      .expect(400);
  });
});
