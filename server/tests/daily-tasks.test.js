import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 045: daily tasks, reports and checkout requests. Rules that depend
// on the date or time use the *_at functions with explicit Pakistan times
// (Monday 2 November 2026, shift 10:00–18:00); permissions and ownership are
// checked through the API.
const admin = "4a000000-0000-4000-8000-000000000001",
  agent = "4a000000-0000-4000-8000-000000000002",
  other = "4a000000-0000-4000-8000-000000000003",
  second = "4a000000-0000-4000-8000-000000000004",
  gone = "4a000000-0000-4000-8000-000000000005";
const MON = "2026-11-02",
  TUE = "2026-11-03";
let pg, db, one, all, installedRulesFrom;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
  // As installed by the migrations, before any test changes it.
  installedRulesFrom = (
    await one("select task_rules_from from crm_settings limit 1")
  ).task_rules_from;
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'second@gmail.com',now()),($2,'gone@gmail.com',now())",
    [second, gone],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=case when id=$1 then 'Second Admin' else 'Gone Agent' end where id in ($1,$2)",
    [second, gone],
  );
  await pg.query("update profiles set active=false where id=$1", [gone]);
  await pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-01');update attendance_periods set starts_on='2026-10-01';update crm_settings set task_rules_from=null;",
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const pk = (day, time) => `${day}T${time}:00+05:00`;
const sql = async (text, args = []) => {
  try {
    return (await one(text, args)).r;
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: e.code });
  }
};
const fails = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
};
const create = (data, at = pk(MON, "09:00"), actor = admin) =>
  sql("select public.task_create_at($1,$2::jsonb,'t',$3) r", [
    actor,
    JSON.stringify({ client_key: randomUUID(), task_date: MON, ...data }),
    at,
  ]);
const measurable = (extra = {}) => ({
  scope: "team",
  title: "Contact potential buyers",
  kind: "measurable",
  target_quantity: 50,
  unit: "calls",
  ...extra,
});
const simple = (extra = {}) => ({
  scope: "individual",
  title: "Prepare a marketing presentation",
  kind: "simple",
  assignees: [agent],
  ...extra,
});
const assignmentOf = (task, user = agent) =>
  task.assignments.find((a) => a.user_id === user);
const progress = (user, id, data, at = pk(MON, "12:00")) =>
  sql("select public.task_progress_at($1,$2,$3::jsonb,'t',$4) r", [
    user,
    id,
    JSON.stringify(data),
    at,
  ]);
const report = (user, day, at, amend = false, remarks = "Honest report") =>
  sql("select public.task_report_submit_at($1,$2,$3,$4,'t',$5) r", [
    user,
    day,
    remarks,
    amend,
    at,
  ]);
const ask = (user, kind, at, reason = null) =>
  sql("select public.task_checkout_request_at($1,$2,$3,'t',$4) r", [
    user,
    kind,
    reason,
    at,
  ]);
const decide = (actor, id, decision, at, waive = false, note = null) =>
  sql("select public.task_checkout_decide_at($1,$2,$3,$4,$5,'t',$6) r", [
    actor,
    id,
    decision,
    note,
    waive,
    at,
  ]);
const state = (user, at) =>
  sql("select public.task_checkout_state_at($1,$2) r", [user, at]);
const checkIn = (user, day, time) =>
  sql("select public.attendance_check_in_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]);
const checkOut = (user, day, time) =>
  sql("select public.attendance_check_out_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]);
const rulesFrom = (day) =>
  pg.query("update crm_settings set task_rules_from=$1", [day]);
const notices = (user) =>
  all(
    "select type,title,body,link,item_count from notifications where user_id=$1 order by created_at,id",
    [user],
  );
// Agent with every task due Monday done and the report submitted.
async function readyForEarly(user = agent) {
  const t = await create(simple({ assignees: [user] }));
  await progress(user, assignmentOf(t, user).id, { status: "completed" });
  await checkIn(user, MON, "09:55");
  await report(user, MON, pk(MON, "15:50"));
  return t;
}

describe("assigning tasks", () => {
  it("gives every active agent their own copy of a team task", async () => {
    const t = await create(measurable({ all_agents: true }));
    expect(t).toMatchObject({
      scope: "team",
      kind: "measurable",
      target_quantity: 50,
      unit: "calls",
      task_date: MON,
      due_on: MON,
    });
    expect(t.assignments.map((a) => a.user_id).sort()).toEqual(
      [agent, other].sort(),
    );
    expect(
      t.assignments.every(
        (a) => a.status === "pending" && a.completed_quantity === 0,
      ),
    ).toBe(true);
    // Each agent's progress is their own.
    await progress(agent, assignmentOf(t).id, { quantity: 50 });
    const after = await sql("select public.task_detail($1,$2) r", [
      admin,
      t.id,
    ]);
    expect(assignmentOf(after).status).toBe("completed");
    expect(assignmentOf(after, other)).toMatchObject({
      status: "pending",
      completed_quantity: 0,
      percent: 0,
    });
    expect((await notices(agent)).map((n) => n.title)).toEqual([
      "New task: Contact potential buyers",
    ]);
    expect(await notices(gone)).toEqual([]);
    const audit = await one(
      "select metadata from audit_log where action='task.create'",
    );
    expect(audit.metadata).toMatchObject({ assignee_count: 2, scope: "team" });
  });
  it("assigns individual tasks and several tasks to one agent", async () => {
    await create(simple());
    await create(
      measurable({
        scope: "individual",
        title: "Follow up with interested leads",
        target_quantity: 20,
        unit: "follow-ups",
        assignees: [agent],
        priority: "high",
      }),
    );
    const mine = await sql("select public.task_my_at($1,$2) r", [
      agent,
      pk(MON, "10:00"),
    ]);
    expect(mine.today.map((x) => x.title)).toEqual([
      "Follow up with interested leads",
      "Prepare a marketing presentation",
    ]);
    expect(
      (
        await sql("select public.task_my_at($1,$2) r", [
          other,
          pk(MON, "10:00"),
        ])
      ).today,
    ).toEqual([]);
  });
  it("prevents accidental duplicates and refuses inactive agents", async () => {
    const key = randomUUID();
    const data = JSON.stringify({
      ...measurable({ assignees: [agent] }),
      client_key: key,
      task_date: MON,
    });
    const first = await sql(
      "select public.task_create_at($1,$2::jsonb,'t',$3) r",
      [admin, data, pk(MON, "09:00")],
    );
    const again = await sql(
      "select public.task_create_at($1,$2::jsonb,'t',$3) r",
      [admin, data, pk(MON, "09:00")],
    );
    expect(again.id).toBe(first.id);
    expect((await one("select count(*)::int n from task_assignments")).n).toBe(
      1,
    );
    const dup = await fails(create(measurable({ assignees: [agent] })));
    expect(dup).toMatchObject({ code: "HA409" });
    expect(dup.message).toContain(
      "Ali Agent already has “Contact potential buyers” on November 2, 2026",
    );
    await create(measurable({ assignees: [agent], allow_duplicate: true }));
    const inactive = await fails(create(measurable({ assignees: [gone] })));
    expect(inactive.message).toBe(
      "Gone Agent is not an active agent and can't be given tasks",
    );
    expect(
      (await fails(create(measurable({ assignees: [second] })))).code,
    ).toBe("HA400");
  });
  it("validates targets and dates", async () => {
    expect(
      (
        await fails(
          create(measurable({ all_agents: true, target_quantity: null })),
        )
      ).message,
    ).toContain("needs a target and a unit");
    expect(
      (
        await fails(
          create(measurable({ all_agents: true, task_date: "2026-11-01" })),
        )
      ).message,
    ).toContain("today or a date up to 60 days ahead");
    expect(
      (
        await fails(
          create(measurable({ all_agents: true, due_on: "2026-12-10" })),
        )
      ).code,
    ).toBe("HA400");
    expect(
      (await fails(create(simple({ assignees: [agent, other] })))).message,
    ).toBe("An individual task is for one person");
  });
  it("is for administrators only", async () => {
    expect((await fails(create(simple(), pk(MON, "09:00"), agent))).code).toBe(
      "HA403",
    );
    const res = await request(app())
      .post("/api/admin/tasks")
      .set(as(agent))
      .send({ ...simple(), client_key: randomUUID() });
    expect(res.status).toBe(403);
    expect(
      (await request(app()).get("/api/admin/tasks/overview").set(as(agent)))
        .status,
    ).toBe(403);
  });
  it("applies an edited target to every open assignment and notifies them", async () => {
    const t = await create(measurable({ all_agents: true }));
    await progress(agent, assignmentOf(t).id, { quantity: 50 });
    const edited = await sql(
      "select public.task_update_at($1,$2,$3::jsonb,'t',$4) r",
      [admin, t.id, JSON.stringify({ target_quantity: 60 }), pk(MON, "11:00")],
    );
    expect(assignmentOf(edited)).toMatchObject({
      status: "in_progress",
      completed_quantity: 50,
      remaining_quantity: 10,
    });
    expect((await notices(other)).map((n) => n.type)).toEqual([
      "task_assigned",
      "task_updated",
    ]);
    const cancelled = await sql(
      "select public.task_cancel($1,$2,'No longer needed','t') r",
      [admin, t.id],
    );
    expect(cancelled.assignments.every((a) => a.status === "cancelled")).toBe(
      true,
    );
    expect(assignmentOf(cancelled).completed_quantity).toBe(50);
    expect(
      (await fails(progress(agent, assignmentOf(t).id, { quantity: 55 })))
        .message,
    ).toBe("This task was cancelled");
  });
});

describe("progress", () => {
  it("calculates completion, caps it at 100% and keeps the excess", async () => {
    const t = await create(
      measurable({ assignees: [agent], scope: "individual" }),
    );
    const a = assignmentOf(t).id;
    expect(await progress(agent, a, { quantity: 40 })).toMatchObject({
      status: "in_progress",
      percent: 80,
      remaining_quantity: 10,
      excess_quantity: 0,
    });
    expect(await progress(agent, a, { quantity: 60 })).toMatchObject({
      status: "completed",
      percent: 100,
      completed_quantity: 60,
      excess_quantity: 10,
    });
    const s = await create(simple({ title: "Review a property agreement" }));
    expect(
      await progress(agent, assignmentOf(s).id, { status: "in_progress" }),
    ).toMatchObject({ percent: 0 });
    expect(
      await progress(agent, assignmentOf(s).id, { status: "completed" }),
    ).toMatchObject({ percent: 100 });
  });
  it("averages tasks equally for the day", async () => {
    for (const [title, q] of [
      ["Calls A", 50],
      ["Calls B", 40],
      ["Calls C", 30],
    ]) {
      const t = await create(
        measurable({ title, assignees: [agent], scope: "individual" }),
      );
      await progress(agent, assignmentOf(t).id, { quantity: q });
    }
    const day = await sql("select public.task_day($1,$2) r", [agent, MON]);
    // (100 + 80 + 60) / 3
    expect(day).toMatchObject({
      task_count: 3,
      completed: 1,
      completion_percent: 80,
    });
  });
  it("lets agents change only their own tasks, and only before verification", async () => {
    const t = await create(measurable({ all_agents: true }));
    const mine = assignmentOf(t).id;
    expect((await fails(progress(other, mine, { quantity: 5 }))).code).toBe(
      "HA404",
    );
    const api = await request(app())
      .post(`/api/tasks/assignments/${mine}/progress`)
      .set(as(other))
      .send({ quantity: 5 });
    expect(api.status).toBe(404);
    await progress(agent, mine, { quantity: 40 });
    const checked = await sql(
      "select public.task_verify($1,$2,$3::jsonb,'t') r",
      [
        admin,
        mine,
        JSON.stringify({
          status: "adjusted",
          quantity: 35,
          note: "Two calls unanswered",
        }),
      ],
    );
    expect(checked).toMatchObject({
      completed_quantity: 40,
      percent: 80,
      verified_status: "adjusted",
      verified_quantity: 35,
      verified_percent: 70,
    });
    expect(
      (await fails(progress(agent, mine, { quantity: 50 }))).message,
    ).toContain("verified this task");
    // Agents can never verify.
    const forged = await request(app())
      .post(`/api/admin/tasks/assignments/${mine}/verify`)
      .set(as(agent))
      .send({ status: "confirmed" });
    expect(forged.status).toBe(403);
  });
});

describe("daily reports", () => {
  it("records an honest incomplete report once, with explicit amendments", async () => {
    const t = await create(
      measurable({ assignees: [agent], scope: "individual" }),
    );
    await progress(agent, assignmentOf(t).id, { quantity: 30 });
    const r = await report(agent, MON, pk(MON, "17:50"));
    expect(r).toMatchObject({
      work_date: MON,
      status: "submitted",
      task_count: 1,
      completion_percent: 60,
      amendment_count: 0,
    });
    expect(r.tasks[0]).toMatchObject({
      title: "Contact potential buyers",
      completed_quantity: 30,
      target_quantity: 50,
      percent: 60,
    });
    expect(
      (await fails(report(agent, MON, pk(MON, "17:55")))).message,
    ).toContain("Choose Amend report");
    await progress(agent, assignmentOf(t).id, { quantity: 35 });
    const amended = await report(agent, MON, pk(MON, "17:58"), true);
    expect(amended).toMatchObject({
      completion_percent: 70,
      amendment_count: 1,
    });
    const audit = await one(
      "select metadata from audit_log where action='task.report_amend'",
    );
    expect(audit.metadata.before).toMatchObject({ completion_percent: 60 });
    // Reviewed reports and their tasks are closed to the agent.
    await sql("select public.task_report_review($1,$2,'Thanks','t') r", [
      admin,
      r.id,
    ]);
    expect(
      (await fails(report(agent, MON, pk(MON, "18:10"), true))).message,
    ).toContain("reviewed by an administrator");
    expect(
      (
        await fails(
          progress(
            agent,
            assignmentOf(t).id,
            { quantity: 50 },
            pk(MON, "18:10"),
          ),
        )
      ).message,
    ).toContain("was reviewed");
    expect((await notices(agent)).at(-1)).toMatchObject({
      type: "task_report_reviewed",
      link: "/my-tasks?tab=reports",
    });
  });
  it("accepts a report for a day with no tasks, within the allowed days only", async () => {
    expect(await report(agent, MON, pk(MON, "17:00"))).toMatchObject({
      task_count: 0,
      completion_percent: null,
    });
    expect((await fails(report(agent, TUE, pk(MON, "17:00")))).code).toBe(
      "HA400",
    );
    expect(
      (await fails(report(agent, "2026-10-20", pk(MON, "17:00")))).code,
    ).toBe("HA400");
    expect((await fails(report(admin, MON, pk(MON, "17:00")))).code).toBe(
      "HA403",
    );
  });
  it("keeps reports private and groups the administrators' notices per day", async () => {
    const mine = await report(agent, MON, pk(MON, "17:00"));
    await report(other, MON, pk(MON, "17:05"));
    expect(
      (
        await fails(
          sql("select public.task_report_detail($1,$2) r", [other, mine.id]),
        )
      ).code,
    ).toBe("HA404");
    expect(
      (await request(app()).get(`/api/tasks/reports/${mine.id}`).set(as(other)))
        .status,
    ).toBe(404);
    const adminNotices = (await notices(admin)).filter(
      (n) => n.type === "task_report",
    );
    expect(adminNotices).toHaveLength(1);
    expect(adminNotices[0]).toMatchObject({
      item_count: 2,
      title: "2 daily reports for November 2, 2026",
    });
  });
});

describe("checkout rules", () => {
  it("are installed off and start only from a date an administrator sets", async () => {
    expect(installedRulesFrom).toBeNull();
    expect(
      (
        await one(
          "select column_default from information_schema.columns where table_name='crm_settings' and column_name='task_rules_from'",
        )
      ).column_default,
    ).toBeNull();
    await checkIn(agent, MON, "10:00");
    expect(await state(agent, pk(MON, "15:00"))).toMatchObject({
      rules_active: false,
      required: false,
      can_request_early: false,
      can_request_emergency: false,
    });
    expect(
      (
        await fails(
          sql("select public.task_settings_save($1,$2,'t') r", [agent, TUE]),
        )
      ).code,
    ).toBe("HA403");
    await sql("select public.task_settings_save($1,$2,'t') r", [admin, TUE]);
    expect(await checkOut(agent, MON, "15:00")).toMatchObject({
      state: "checked_out",
    });
    await checkIn(agent, TUE, "10:00");
    expect(await state(agent, pk(TUE, "15:00"))).toMatchObject({
      rules_active: true,
      required: true,
      can_check_out: false,
    });
  });
  it("change nothing while off or before their start date", async () => {
    await checkIn(agent, MON, "10:00");
    await rulesFrom(TUE);
    expect(await checkOut(agent, MON, "16:00")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 120,
    });
  });
  it("need the daily report before a normal checkout", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    expect((await fails(checkOut(agent, MON, "18:05"))).message).toBe(
      "Please submit your daily work report before checking out.",
    );
    await report(agent, MON, pk(MON, "18:06"));
    expect(await checkOut(agent, MON, "18:07")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 0,
    });
  });
  it("need approval to leave before the shift ends, and never apply to administrators", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    await report(agent, MON, pk(MON, "15:00"));
    expect((await fails(checkOut(agent, MON, "15:30"))).message).toBe(
      "Checking out before your shift ends at 6:00 PM needs an approved early or emergency checkout request.",
    );
    await checkIn(admin, MON, "10:00");
    expect(await checkOut(admin, MON, "15:30")).toMatchObject({
      state: "checked_out",
    });
  });
});

describe("agents with no tasks", () => {
  it("submit a no-tasks report and check out normally at the shift end", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    const s = await state(agent, pk(MON, "17:00"));
    expect(s.tasks).toMatchObject({ task_count: 0, due_count: 0 });
    expect(s).toMatchObject({
      required: true,
      report_submitted: false,
      can_check_out: false,
    });
    expect((await fails(checkOut(agent, MON, "18:00"))).message).toBe(
      "Please submit your daily work report before checking out.",
    );
    expect(
      await report(agent, MON, pk(MON, "18:01"), false, "No tasks today"),
    ).toMatchObject({ task_count: 0, completion_percent: null });
    expect((await state(agent, pk(MON, "18:02"))).can_check_out).toBe(true);
    expect(await checkOut(agent, MON, "18:02")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 0,
    });
  });
  it("never get a completion-based early checkout", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    await report(agent, MON, pk(MON, "15:00"));
    const s = await state(agent, pk(MON, "15:30"));
    expect(s).toMatchObject({
      report_submitted: true,
      can_request_early: false,
      can_check_out: false,
      can_request_emergency: true,
    });
    expect(s.early_blockers).toEqual([
      "You have no tasks due today. Check out at the end of your shift, or ask for an emergency checkout.",
    ]);
    expect(
      await fails(ask(agent, "early", pk(MON, "15:30"), "Everything done")),
    ).toMatchObject({ code: "HA409", message: s.early_blockers[0] });
    expect((await fails(checkOut(agent, MON, "15:31"))).code).toBe("HA409");
    expect(
      (await one("select count(*)::int n from task_checkout_requests")).n,
    ).toBe(0);
    expect(
      (
        await one("select state from attendance_records where user_id=$1", [
          agent,
        ])
      ).state,
    ).toBe("checked_in");
  });
});

describe("early checkout", () => {
  it("runs from request to approval to the normal check-out", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const s = await state(agent, pk(MON, "16:00"));
    expect(s).toMatchObject({
      required: true,
      can_request_early: true,
      report_submitted: true,
      can_check_out: false,
      before_shift_end: true,
    });
    const req = await ask(agent, "early", pk(MON, "16:00"), "All calls done");
    expect(req).toMatchObject({
      kind: "early",
      status: "pending",
      completion_percent: 100,
      report_submitted: true,
      shift_end: "18:00:00",
    });
    const n = (await notices(admin)).find((x) => x.type === "checkout_request");
    expect(n.body).toBe(
      "Ali Agent has completed all required daily tasks and requested checkout at 4:00 PM. Normal shift end: 6:00 PM. Task completion: 100.0%. Report: submitted.",
    );
    // Not checked out automatically.
    expect(
      (
        await one("select state from attendance_records where user_id=$1", [
          agent,
        ])
      ).state,
    ).toBe("checked_in");
    const approved = await decide(admin, req.id, "approve", pk(MON, "16:02"));
    expect(approved).toMatchObject({
      status: "approved",
      decided_by_name: "Owner",
    });
    expect((await notices(agent)).at(-1)).toMatchObject({
      type: "checkout_decision",
      title: "Early checkout approved",
      link: "/attendance",
    });
    const out = await checkOut(agent, MON, "16:05");
    expect(out).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 115,
    });
    expect(
      (
        await one("select used_at from task_checkout_requests where id=$1", [
          req.id,
        ])
      ).used_at,
    ).toBeTruthy();
    const audit = await one(
      "select metadata from audit_log where action='attendance.check_out'",
    );
    expect(audit.metadata).toMatchObject({
      checkout_kind: "early",
      checkout_request_id: req.id,
    });
  });
  it("is refused until every condition holds", async () => {
    await rulesFrom(MON);
    const reason = async (at = pk(MON, "16:00")) =>
      (await fails(ask(agent, "early", at))).message;
    expect(await reason()).toBe("Check in first");
    await checkIn(agent, MON, "10:00");
    expect(await reason()).toBe(
      "You have no tasks due today. Check out at the end of your shift, or ask for an emergency checkout.",
    );
    const t = await create(
      measurable({ assignees: [agent], scope: "individual" }),
    );
    await create(simple());
    await progress(agent, assignmentOf(t).id, { quantity: 50 });
    expect(await reason()).toBe(
      "Complete every task due today first (1 of 2 done).",
    );
    const s = await sql("select public.task_my_at($1,$2) r", [
      agent,
      pk(MON, "16:00"),
    ]);
    await progress(agent, s.today.find((x) => x.kind === "simple").id, {
      status: "completed",
    });
    expect(await reason()).toBe("Submit your daily report first.");
    await report(agent, MON, pk(MON, "16:00"));
    expect(await reason(pk(MON, "18:00"))).toBe(
      "Your shift has ended; check out normally.",
    );
    await ask(agent, "early", pk(MON, "16:01"));
    expect(await reason(pk(MON, "16:02"))).toBe(
      "You already have a request waiting for an administrator",
    );
  });
  it("leaves the rules in place when rejected", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await decide(
      admin,
      req.id,
      "reject",
      pk(MON, "16:05"),
      false,
      "Busy afternoon",
    );
    expect((await fails(checkOut(agent, MON, "16:10"))).message).toContain(
      "needs an approved early or emergency checkout request",
    );
    expect((await notices(agent)).at(-1)).toMatchObject({
      title: "Early checkout rejected",
    });
    expect(await checkOut(agent, MON, "18:01")).toMatchObject({
      state: "checked_out",
    });
  });
  it("can be asked again after a rejection, with a new explanation and a short wait", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const first = await ask(agent, "early", pk(MON, "16:00"), "All calls done");
    await decide(
      admin,
      first.id,
      "reject",
      pk(MON, "16:05"),
      false,
      "Busy afternoon",
    );
    const s = await state(agent, pk(MON, "16:10"));
    expect(s.can_request_early).toBe(false);
    expect(s.early_blockers).toEqual([
      "You can ask again from 4:20 PM, 15 minutes after your last request was rejected.",
    ]);
    expect(s.early_resubmission).toMatchObject({
      count: 1,
      limit: 3,
      rejected: 1,
      explanation_required: true,
      last_rejected_by: "Owner",
      last_rejection_note: "Busy afternoon",
      waiting: true,
    });
    expect(s.early_resubmission.reasons).toBeUndefined();
    const again = (time, reason) =>
      fails(ask(agent, "early", pk(MON, time), reason));
    expect((await again("16:21", null)).message).toBe(
      "Your last early checkout request was rejected. Explain what has changed (at least 10 characters).",
    );
    expect((await again("16:21", "ok now")).code).toBe("HA400");
    // Case and spacing don't make an explanation new.
    expect(await again("16:21", "  all calls   DONE ")).toMatchObject({
      code: "HA409",
      message:
        "This explanation repeats an earlier request. Explain what has changed since then.",
    });
    expect(
      await again("16:10", "The site visit moved to tomorrow"),
    ).toMatchObject({
      code: "HA429",
      message:
        "You can ask again from 4:20 PM, 15 minutes after your last request was rejected.",
    });
    expect((await state(agent, pk(MON, "16:20"))).can_request_early).toBe(true);
    const second = await ask(
      agent,
      "early",
      pk(MON, "16:20"),
      "The site visit moved to tomorrow",
    );
    expect(second.status).toBe("pending");
    const attempts = await all(
      "select metadata->>'attempt' n from audit_log where action='checkout.request'",
    );
    expect(attempts.map((a) => a.n).sort()).toEqual(["1", "2"]);
    const res = await request(app())
      .get("/api/audit?module=tasks")
      .set(as(admin));
    expect(
      res.body.data
        .filter((e) => e.title === "Requested early checkout")
        .map((e) => e.description.endsWith(" Request 2 of the day."))
        .sort(),
    ).toEqual([false, true]);
    await decide(admin, second.id, "approve", pk(MON, "16:22"));
    expect(await checkOut(agent, MON, "16:25")).toMatchObject({
      state: "checked_out",
    });
  });
  it("allows at most three requests of each kind a day, cancelled ones included", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const cancel = (id) =>
      sql("select public.task_checkout_cancel($1,$2,'t') r", [agent, id]);
    for (const time of ["16:00", "16:01", "16:02"])
      await cancel((await ask(agent, "early", pk(MON, time))).id);
    expect(await fails(ask(agent, "early", pk(MON, "16:03")))).toMatchObject({
      code: "HA429",
      message:
        "You have reached today's limit of 3 early checkout requests. Please speak to an administrator.",
    });
    const s = await state(agent, pk(MON, "16:03"));
    expect(s).toMatchObject({
      can_request_early: false,
      can_request_emergency: true,
    });
    expect(s.early_blockers).toContain(
      "You have reached today's limit of 3 early checkout requests.",
    );
    // Emergencies count separately and have no wait after a rejection.
    const e1 = await ask(
      agent,
      "emergency",
      pk(MON, "16:04"),
      "Child unwell at school",
    );
    await decide(admin, e1.id, "reject", pk(MON, "16:05"));
    expect(
      (
        await fails(
          ask(agent, "emergency", pk(MON, "16:06"), "child unwell at school"),
        )
      ).code,
    ).toBe("HA409");
    const e2 = await ask(
      agent,
      "emergency",
      pk(MON, "16:06"),
      "School called again: the fever is worse",
    );
    expect(e2.status).toBe("pending");
    await decide(admin, e2.id, "reject", pk(MON, "16:07"));
    await cancel(
      (
        await ask(
          agent,
          "emergency",
          pk(MON, "16:08"),
          "Nobody else can collect the child",
        )
      ).id,
    );
    expect(
      (
        await fails(
          ask(agent, "emergency", pk(MON, "16:09"), "A completely new reason"),
        )
      ).code,
    ).toBe("HA429");
    expect((await state(agent, pk(MON, "16:09"))).can_request_emergency).toBe(
      false,
    );
    expect(
      (await one("select count(*)::int n from task_checkout_requests")).n,
    ).toBe(6);
    // The normal end-of-shift checkout is unaffected.
    expect(await checkOut(agent, MON, "18:00")).toMatchObject({
      state: "checked_out",
    });
  });
  it("never checks anyone out automatically", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await decide(admin, req.id, "approve", pk(MON, "16:01"));
    // Tasks complete, report in, approval granted: still checked in.
    expect(
      await one(
        "select state,check_out_at from attendance_records where user_id=$1",
        [agent],
      ),
    ).toEqual({ state: "checked_in", check_out_at: null });
    // Only the attendance check-out itself writes attendance records.
    const writers = await all(
      "select proname from pg_proc where pronamespace='public'::regnamespace and (proname like 'task\\_%' or proname='attendance_check_out_at') and prosrc ~* '(update|insert\\s+into)\\s+public\\.attendance_records'",
    );
    expect(writers).toEqual([{ proname: "attendance_check_out_at" }]);
  });
  it("authorizes only that agent on that day", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    await readyForEarly(other);
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await decide(admin, req.id, "approve", pk(MON, "16:01"));
    expect((await fails(checkOut(other, MON, "16:10"))).message).toContain(
      "needs an approved",
    );
    // Unused on Monday; Tuesday needs a new request.
    expect(await checkOut(agent, MON, "18:30")).toMatchObject({
      state: "checked_out",
    });
    const tue = await create(
      simple({ title: "Tuesday task", task_date: TUE }),
      pk(MON, "18:40"),
    );
    await checkIn(agent, TUE, "10:00");
    await progress(
      agent,
      assignmentOf(tue).id,
      { status: "completed" },
      pk(TUE, "11:00"),
    );
    await report(agent, TUE, pk(TUE, "15:00"));
    expect((await fails(checkOut(agent, TUE, "15:10"))).message).toContain(
      "needs an approved",
    );
  });
  it("expires at the end of its day and is re-checked when tasks change", async () => {
    await rulesFrom(MON);
    const t = await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    expect(
      (await fails(decide(admin, req.id, "approve", pk(TUE, "09:00")))).message,
    ).toBe(
      "This early checkout request has expired; it was for November 2, 2026",
    );
    const extra = await create(
      simple({ title: "Late extra task" }),
      pk(MON, "16:01"),
    );
    expect(extra.assignments).toHaveLength(1);
    expect(
      (await fails(decide(admin, req.id, "approve", pk(MON, "16:02")))).message,
    ).toContain(
      "Tasks changed since the request: 1 of 2 tasks due today are now done",
    );
    expect(t.id).toBeTruthy();
  });
  it("lets only the first of two administrators decide", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await decide(admin, req.id, "approve", pk(MON, "16:01"));
    expect(
      (await fails(decide(second, req.id, "reject", pk(MON, "16:01")))).message,
    ).toBe("This request was already approved");
    expect(
      (await fails(decide(second, req.id, "approve", pk(MON, "16:01")))).code,
    ).toBe("HA409");
    expect(
      (
        await one(
          "select count(*)::int n from task_checkout_requests where status='approved'",
        )
      ).n,
    ).toBe(1);
  });
  it("can't be approved after the agent checked out", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await pg.query("update crm_settings set task_rules_from=null");
    await checkOut(agent, MON, "16:30");
    await rulesFrom(MON);
    expect(
      (await fails(decide(admin, req.id, "approve", pk(MON, "16:40")))).message,
    ).toBe("Ali Agent has already checked out today");
  });
});

describe("emergency checkout", () => {
  it("allows leaving without the report when explicitly waived, without completing tasks", async () => {
    await rulesFrom(MON);
    const t = await create(
      measurable({ assignees: [agent], scope: "individual" }),
    );
    await progress(agent, assignmentOf(t).id, { quantity: 15 });
    await checkIn(agent, MON, "10:00");
    expect(
      (await fails(ask(agent, "emergency", pk(MON, "13:00"), "no"))).code,
    ).toBe("HA400");
    const req = await ask(
      agent,
      "emergency",
      pk(MON, "13:00"),
      "Family emergency at home",
    );
    expect(req).toMatchObject({
      kind: "emergency",
      completion_percent: 30,
      report_submitted: false,
    });
    // The reason stays in the request, out of notifications and the audit.
    const n = (await notices(admin)).find((x) => x.type === "checkout_request");
    expect(n.body).not.toContain("Family");
    expect(
      JSON.stringify(
        (
          await one(
            "select metadata from audit_log where action='checkout.request'",
          )
        ).metadata,
      ),
    ).not.toContain("Family");
    await decide(admin, req.id, "approve", pk(MON, "13:05"), true);
    const out = await checkOut(agent, MON, "13:10");
    expect(out).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 290,
    });
    expect(
      await one(
        "select status,completed_quantity from task_assignments where user_id=$1",
        [agent],
      ),
    ).toMatchObject({ status: "in_progress", completed_quantity: 15 });
    expect(
      (await one("select count(*)::int n from task_daily_reports")).n,
    ).toBe(0);
    // The missing report is still owed afterwards.
    const tue = await sql("select public.task_my_at($1,$2) r", [
      agent,
      pk(TUE, "10:00"),
    ]);
    expect(tue.missing_reports).toEqual([MON]);
  });
  it("still needs the report when it wasn't waived", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    const req = await ask(
      agent,
      "emergency",
      pk(MON, "13:00"),
      "Doctor appointment",
    );
    await decide(admin, req.id, "approve", pk(MON, "13:05"));
    expect((await fails(checkOut(agent, MON, "13:10"))).message).toBe(
      "Submit your daily work report before checking out. Your emergency approval did not waive the report.",
    );
    await report(agent, MON, pk(MON, "13:11"));
    expect(await checkOut(agent, MON, "13:12")).toMatchObject({
      state: "checked_out",
    });
  });
  it("keeps the restrictions when rejected, and can be approved afterwards for the record", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    const req = await ask(
      agent,
      "emergency",
      pk(MON, "13:00"),
      "Child unwell at school",
    );
    await decide(admin, req.id, "reject", pk(MON, "13:05"));
    expect((await fails(checkOut(agent, MON, "13:10"))).code).toBe("HA409");
    expect((await notices(agent)).at(-1)).toMatchObject({
      title: "Emergency checkout rejected",
    });
    // An emergency with no administrator available: approved the next day.
    await checkIn(other, MON, "10:00");
    const late = await ask(
      other,
      "emergency",
      pk(MON, "14:00"),
      "Road accident nearby",
    );
    const later = await decide(admin, late.id, "approve", pk(TUE, "09:00"));
    expect(later.status).toBe("approved");
    expect((await notices(other)).at(-1).body).toContain(
      "request a check-out correction for the time you left",
    );
    const audit = await one(
      "select metadata from audit_log where action='checkout.approve'",
    );
    expect(audit.metadata).toMatchObject({
      retrospective: true,
      kind: "emergency",
    });
  });
});

describe("emergency with no administrator available", () => {
  it("records the departure without inventing a time, then fixes the day afterwards", async () => {
    await rulesFrom(MON);
    const t = await create(
      measurable({ assignees: [agent], scope: "individual" }),
    );
    await progress(agent, assignmentOf(t).id, { quantity: 10 });
    await checkIn(agent, MON, "10:00");
    const req = await ask(
      agent,
      "emergency",
      pk(MON, "14:00"),
      "Father taken to hospital",
    );
    // Nobody answers; checking out stays blocked and the agent leaves.
    expect((await fails(checkOut(agent, MON, "14:10"))).code).toBe("HA409");
    const left = await one(
      "select id,state,check_out_at,corrected from attendance_records where user_id=$1",
      [agent],
    );
    expect(left).toMatchObject({
      state: "checked_in",
      check_out_at: null,
      corrected: false,
    });
    // The next morning an administrator approves it for the record.
    expect(
      await decide(admin, req.id, "approve", pk(TUE, "09:00"), true),
    ).toMatchObject({ status: "approved", waive_report: true, used_at: null });
    expect(
      await one(
        "select state,check_out_at from attendance_records where id=$1",
        [left.id],
      ),
    ).toEqual({ state: "checked_in", check_out_at: null });
    // The day is fixed with the agent's own check-out correction.
    const c = await one(
      "insert into attendance_corrections(user_id,attendance_date,record_id,correction_type,original_check_in_at,original_check_out_at,requested_check_out_at,reason) select user_id,attendance_date,id,'missing_check_out',check_in_at,check_out_at,$2,'Left for the hospital' from attendance_records where id=$1 returning id",
      [left.id, pk(MON, "14:10")],
    );
    await sql(
      "select public.attendance_correction_review($1,$2,'approved',null,'t') r",
      [admin, c.id],
    );
    const fixed = await one(
      "select state,check_out_at,early_departure_minutes,corrected from attendance_records where id=$1",
      [left.id],
    );
    expect(fixed).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 230,
      corrected: true,
    });
    expect(new Date(fixed.check_out_at).toISOString()).toBe(
      new Date(pk(MON, "14:10")).toISOString(),
    );
    expect(
      (
        await one("select used_at from task_checkout_requests where id=$1", [
          req.id,
        ])
      ).used_at,
    ).toBeNull();
    // The waived report shows as waived, not just missing.
    const owed = await sql(
      "select public.task_missing_reports_at($1,$2,$3,$4) r",
      [admin, MON, MON, pk(TUE, "10:00")],
    );
    expect(owed.data).toEqual([
      expect.objectContaining({
        user_id: agent,
        work_date: MON,
        report_waived: true,
        can_still_submit: true,
      }),
    ]);
  });
});

describe("security", () => {
  it("lets only administrators decide, through the API and the database", async () => {
    await rulesFrom(MON);
    await checkIn(agent, MON, "10:00");
    const req = await ask(
      agent,
      "emergency",
      pk(MON, "13:00"),
      "Family emergency",
    );
    expect(
      (await fails(decide(other, req.id, "approve", pk(MON, "13:01")))).code,
    ).toBe("HA403");
    const api = await request(app())
      .post(`/api/admin/tasks/checkout-requests/${req.id}/decide`)
      .set(as(agent))
      .send({ decision: "approve" });
    expect(api.status).toBe(403);
    expect(
      (
        await request(app())
          .post(`/api/tasks/checkout-requests/${req.id}/cancel`)
          .set(as(other))
          .send({})
      ).status,
    ).toBe(404);
  });
  it("keeps every table and function away from browser roles and the time-travel functions from the API", async () => {
    const tables = await all(
      "select relname,relrowsecurity from pg_class where relname in ('tasks','task_assignments','task_daily_reports','task_checkout_requests')",
    );
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    const grants = await all(
      "select count(*)::int n from information_schema.role_table_grants where table_name like 'task%' and grantee in ('anon','authenticated')",
    );
    expect(grants[0].n).toBe(0);
    const fns = await all(
      "select p.proname,has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') api from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'task\\_%' or p.proname='attendance_check_out_at')",
    );
    expect(fns.filter((f) => f.browser)).toEqual([]);
    const api = new Set(fns.filter((f) => f.api).map((f) => f.proname));
    for (const owner of [
      "task_create_at",
      "task_checkout_decide_at",
      "task_checkout_request_at",
      "task_report_submit_at",
      "task_progress_at",
      "task_checkout_check",
      "task_checkout_state_at",
      "task_missing_reports_at",
      "task_request_limits",
      "attendance_check_out_at",
    ])
      expect(api.has(owner)).toBe(false);
    for (const callable of [
      "task_create",
      "task_checkout_decide",
      "task_my",
      "task_checkout_state",
      "task_missing_reports",
    ])
      expect(api.has(callable)).toBe(true);
  });
  it("shows agents only their own tasks through the API", async () => {
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    const created = await request(app())
      .post("/api/admin/tasks")
      .set(as(admin))
      .send({
        scope: "individual",
        title: "Call new leads",
        kind: "simple",
        assignees: [agent],
        task_date: today,
        client_key: randomUUID(),
      });
    expect(created.status).toBe(201);
    const mine = await request(app()).get("/api/tasks/my").set(as(agent));
    expect(mine.body.today.map((t) => t.title)).toEqual(["Call new leads"]);
    const theirs = await request(app()).get("/api/tasks/my").set(as(other));
    expect(theirs.body.today).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain("Call new leads");
  });
});

describe("administrator views", () => {
  it("summarizes the day and performance from the actual work", async () => {
    await rulesFrom(MON);
    const team = await create(measurable({ all_agents: true }));
    await progress(agent, assignmentOf(team).id, { quantity: 50 });
    await progress(other, assignmentOf(team, other).id, { quantity: 20 });
    await report(agent, MON, pk(MON, "17:00"));
    const overview = await sql("select public.task_admin_overview($1,$2) r", [
      admin,
      MON,
    ]);
    expect(overview).toMatchObject({
      active_tasks: 1,
      assignments: 2,
      completed: 1,
      reports_submitted: 1,
      average_percent: 70,
    });
    expect(overview.missing_reports.map((p) => p.name)).toEqual(["Sara Agent"]);
    const perf = await sql("select public.task_performance($1,$2,$3,null) r", [
      admin,
      MON,
      MON,
    ]);
    expect(perf.totals).toMatchObject({
      assignments: 2,
      completed: 1,
      average_percent: 70,
      reports: 1,
    });
    expect(perf.employees.find((e) => e.id === agent)).toMatchObject({
      assignments: 1,
      average_percent: 100,
      reports: 1,
    });
    expect(perf.days).toEqual([
      {
        date: MON,
        assignments: 2,
        completed: 1,
        average_percent: 70,
        reports: 1,
      },
    ]);
  });
  it("lists overdue daily reports for administrators", async () => {
    const team = await create(measurable({ all_agents: true }));
    await progress(agent, assignmentOf(team).id, { quantity: 25 });
    await report(agent, MON, pk(MON, "18:00"));
    const owed = (at, actor = admin, to = TUE) =>
      sql("select public.task_missing_reports_at($1,$2,$3,$4) r", [
        actor,
        MON,
        to,
        at,
      ]);
    const tue = await owed(pk(TUE, "10:00"));
    expect(tue.count).toBe(1);
    expect(tue.data[0]).toMatchObject({
      user_id: other,
      name: "Sara Agent",
      active: true,
      work_date: MON,
      tasks: 1,
      completion_percent: 0,
      can_still_submit: true,
      submit_until: "2026-11-09",
      report_waived: false,
    });
    // The day itself isn't overdue yet; after 7 days it can't be submitted.
    expect((await owed(pk(MON, "20:00"))).count).toBe(0);
    expect((await owed(pk("2026-11-12", "10:00"))).data[0]).toMatchObject({
      work_date: MON,
      can_still_submit: false,
    });
    await report(other, MON, pk(TUE, "10:30"));
    expect((await owed(pk(TUE, "11:00"))).count).toBe(0);
    expect((await fails(owed(pk(TUE, "11:00"), agent))).code).toBe("HA403");
    expect(
      (await fails(owed(pk(TUE, "11:00"), admin, "2027-03-01"))).code,
    ).toBe("HA400");
  });
  it("writes readable Audit History entries", async () => {
    await rulesFrom(MON);
    await readyForEarly();
    const req = await ask(agent, "early", pk(MON, "16:00"));
    await decide(admin, req.id, "approve", pk(MON, "16:01"));
    await checkOut(agent, MON, "16:05");
    const res = await request(app())
      .get("/api/audit?module=tasks")
      .set(as(admin));
    const titles = res.body.data.map((e) => e.title);
    for (const t of [
      "Assigned a task",
      "Updated task progress",
      "Submitted a daily report",
      "Requested early checkout",
      "Approved early checkout",
    ])
      expect(titles).toContain(t);
    const approval = res.body.data.find(
      (e) => e.title === "Approved early checkout",
    );
    expect(approval.description).toBe(
      "Approved Ali Agent's early checkout request for November 2, 2026.",
    );
    expect(approval.actor.name).toBe("Owner");
    expect(approval.record.label).toBe("Ali Agent");
  });
});

describe("API routes", () => {
  it("serves every administrator and agent route", async () => {
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    const api = (user, method, path, body) =>
      request(app())
        [method]("/api" + path)
        .set(as(user))
        .send(body);
    const created = await api(admin, "post", "/admin/tasks", {
      scope: "team",
      title: "Visit the new project",
      kind: "measurable",
      target_quantity: 3,
      unit: "visits",
      all_agents: true,
      task_date: today,
      client_key: randomUUID(),
    });
    expect(created.status).toBe(201);
    const id = created.body.id,
      mine = assignmentOf(created.body).id;
    for (const path of [
      "/admin/tasks",
      `/admin/tasks?scope=team&status=open&from=${today}&to=${today}`,
      `/admin/tasks/${id}`,
      "/admin/tasks/overview",
      "/admin/tasks/reports",
      "/admin/tasks/checkout-requests?status=pending",
      `/admin/tasks/performance?from=${today}&to=${today}`,
      "/admin/tasks/settings",
      "/admin/tasks/missing-reports",
      `/admin/tasks/missing-reports?from=${today}&to=${today}`,
    ]) {
      const res = await api(admin, "get", path);
      expect(res.status, path + " " + JSON.stringify(res.body)).toBe(200);
    }
    expect(
      (await api(admin, "get", "/admin/tasks")).body.data[0],
    ).toMatchObject({ title: "Visit the new project", assignees: 2 });
    expect(
      typeof (await api(admin, "get", "/admin/tasks/overview")).body
        .overdue_reports,
    ).toBe("number");
    expect(
      (await api(agent, "get", "/admin/tasks/missing-reports")).status,
    ).toBe(403);
    expect(
      (await api(admin, "get", "/admin/tasks/missing-reports?from=x")).status,
    ).toBe(400);
    expect(
      (
        await api(admin, "patch", `/admin/tasks/${id}`, {
          title: "Visit the new projects",
          expected_updated_at: created.body.updated_at,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(agent, "post", `/tasks/assignments/${mine}/progress`, {
          quantity: 1,
          note: "First visit done",
        })
      ).body,
    ).toMatchObject({ status: "in_progress", completed_quantity: 1 });
    const filed = await api(agent, "post", "/tasks/reports", {
      remarks: "Two visits left",
    });
    expect(filed.status).toBe(201);
    expect(
      (await api(agent, "post", "/tasks/reports", { remarks: "Again" })).status,
    ).toBe(409);
    expect(
      (await api(admin, "get", `/admin/tasks/reports/${filed.body.id}`)).body
        .assignments,
    ).toHaveLength(1);
    expect(
      (await api(agent, "get", `/tasks/reports/${filed.body.id}`)).status,
    ).toBe(200);
    expect(
      (
        await api(
          admin,
          "post",
          `/admin/tasks/reports/${filed.body.id}/review`,
          { note: "Good" },
        )
      ).body.status,
    ).toBe("reviewed");
    expect(
      (
        await api(
          admin,
          "post",
          `/admin/tasks/assignments/${assignmentOf(created.body, other).id}/verify`,
          { status: "not_done" },
        )
      ).body.verified_status,
    ).toBe("not_done");
    expect((await api(agent, "get", "/tasks/checkout")).body).toMatchObject({
      required: false,
      rules_active: false,
    });
    // Rules off: a request is refused with a reason, never a server error.
    const refused = await api(agent, "post", "/tasks/checkout-requests", {
      kind: "early",
    });
    expect(refused.status).toBe(409);
    expect(
      (
        await api(agent, "post", "/tasks/checkout-requests", {
          kind: "emergency",
          reason: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(admin, "patch", "/admin/tasks/settings", {
          rules_from: today,
        })
      ).body,
    ).toMatchObject({ rules_from: today, rules_active_today: true });
    expect(
      (
        await api(admin, "patch", "/admin/tasks/settings", {
          rules_from: "2020-01-01",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(admin, "patch", "/admin/tasks/settings", { rules_from: null }))
        .body.rules_from,
    ).toBeNull();
    expect(
      (
        await api(admin, "post", `/admin/tasks/assignments/${mine}/cancel`, {
          reason: "Moved to Sara",
        })
      ).body.assignments.find((a) => a.id === mine).status,
    ).toBe("cancelled");
    expect(
      (await api(admin, "post", `/admin/tasks/${id}/cancel`, {})).body
        .cancelled_at,
    ).toBeTruthy();
    expect(
      (
        await api(admin, "post", "/admin/tasks", {
          scope: "team",
          title: "x",
          kind: "simple",
          all_agents: true,
          client_key: randomUUID(),
        })
      ).status,
    ).toBe(400);
    for (const [method, path] of [
      ["get", "/admin/tasks"],
      ["get", `/admin/tasks/${id}`],
      ["post", "/admin/tasks/settings"],
      ["get", "/admin/tasks/performance?from=2026-11-01&to=2026-11-02"],
    ])
      expect((await api(agent, method, path, {})).status).toBe(403);
  });
});
