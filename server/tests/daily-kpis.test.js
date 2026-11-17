import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { agentDay, agentHistory, kpiReport } from "../src/services/kpis.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 070: Daily KPIs. Administrators define daily or weekly KPIs (Yes/No
// or a number, with a target); agents answer them for each Pakistan day;
// administrators see daily, weekly and monthly results. Rule changes start
// from the next period, so results are never recalculated; an answer saved
// again replaces the day's answer; a working day without an answer is
// missed, apart from an explicit No or 0. Times below are passed to the SQL
// functions (p_now) so days, weeks and months can be tested exactly.
const admin = "70000000-0000-4000-8000-000000000001",
  ali = "70000000-0000-4000-8000-000000000002",
  sara = "70000000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  // Employed all year, so every past test day is a working day (Monday to
  // Saturday, the company default).
  await pg.query(
    "update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])",
    [[admin, ali, sara]],
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const at = (day, time = "10:00") => `${day}T${time}:00+05:00`;
const save = async (data, now, id = null) =>
  (
    await one("select public.kpi_save($1,$2,$3::jsonb,'t',$4) r", [
      admin,
      id,
      JSON.stringify(data),
      now,
    ])
  ).r;
const submit = (agent, day, answers, now) =>
  one("select public.kpi_submit($1,$2,$3::jsonb,'t',$4) r", [
    agent,
    day,
    JSON.stringify(answers.map(([kpi_id, answer]) => ({ kpi_id, answer }))),
    now,
  ]).then((x) => x.r);
const facts = async (from, to, now, agent = null, actor = admin) =>
  (
    await one("select public.kpi_facts($1,$2,$3,$4,$5) r", [
      actor,
      from,
      to,
      agent,
      now,
    ])
  ).r;
const report = async (from, to, now, agent = null) =>
  kpiReport(await facts(from, to, now, agent), from, to);
const cell = (r, agent, kpi) =>
  r.agents.find((a) => a.id === agent)?.cells[kpi];
// The five KPIs, created on Monday 26 October 2026.
async function fiveKpis(now = at("2026-10-26", "09:00")) {
  const make = (title, frequency, answer_type, target) =>
    save(
      {
        title,
        question: `${title}?`,
        frequency,
        answer_type,
        ...(answer_type === "number" ? { target } : {}),
      },
      now,
    ).then((k) => k.id);
  return {
    calls: await make("Assigned calls answered", "day", "yes_no"),
    social: await make("Social media activity", "day", "yes_no"),
    visits: await make("Project visits", "week", "number", 3),
    inventory: await make("Verified inventory", "day", "number", 1),
    video: await make("HD Marketing video", "week", "number", 1),
  };
}

describe("KPI definitions", () => {
  it("lets an administrator create, change, switch off, archive and delete KPIs; rules change from the next period", async () => {
    const server = app();
    const created = await request(server)
      .post("/api/kpis")
      .set(as(admin))
      .send({
        title: "Verified inventory",
        question: "How many verified inventories today?",
        frequency: "day",
        answer_type: "number",
        target: 1,
      })
      .expect(201);
    const listed = (
      await request(server).get("/api/kpis/manage").set(as(admin)).expect(200)
    ).body.kpis.find((k) => k.id === created.body.id);
    expect(listed.rules).toMatchObject({
      frequency: "day",
      answer_type: "number",
      target: 1,
      active: true,
      agent_ids: null,
    });
    // Before anyone has answered it, a change applies at once.
    const today = listed.rules.effective_from;
    const first = (
      await request(server)
        .patch("/api/kpis/" + created.body.id)
        .set(as(admin))
        .send({ target: 2 })
        .expect(200)
    ).body;
    expect(first.rules_from).toBe(today);
    const manage = async () =>
      (
        await request(server).get("/api/kpis/manage").set(as(admin)).expect(200)
      ).body.kpis.find((k) => k.id === created.body.id);
    expect((await manage()).rules.target).toBe(2);
    // Once answered, rules (target, on/off) wait for the next period, and
    // wording changes at once.
    await request(server)
      .put(`/api/kpis/my/${today}`)
      .set(as(ali))
      .send({ answers: [{ kpi_id: created.body.id, answer: 1 }] })
      .expect(200);
    const changed = (
      await request(server)
        .patch("/api/kpis/" + created.body.id)
        .set(as(admin))
        .send({ title: "Verified inventories", target: 3 })
        .expect(200)
    ).body;
    expect(changed.title).toBe("Verified inventories");
    expect(changed.rules_from > today).toBe(true);
    let after = await manage();
    expect(after.rules.target).toBe(2);
    expect(after.scheduled).toMatchObject({
      target: 3,
      effective_from: changed.rules_from,
    });
    // Setting the rules back cancels the waiting change.
    await request(server)
      .patch("/api/kpis/" + created.body.id)
      .set(as(admin))
      .send({ target: 2 })
      .expect(200);
    expect((await manage()).scheduled).toBeNull();
    // Switch off, archive (nothing can be changed while archived), restore.
    await request(server)
      .patch("/api/kpis/" + created.body.id)
      .set(as(admin))
      .send({ active: false })
      .expect(200);
    expect((await manage()).scheduled.active).toBe(false);
    await request(server)
      .post(`/api/kpis/${created.body.id}/archive`)
      .set(as(admin))
      .send({ archived: true })
      .expect(200);
    after = await manage();
    expect(after.archived_at).not.toBeNull();
    expect(after.scheduled.active).toBe(false);
    await request(server)
      .patch("/api/kpis/" + created.body.id)
      .set(as(admin))
      .send({ target: 3 })
      .expect(400);
    await request(server)
      .post(`/api/kpis/${created.body.id}/archive`)
      .set(as(admin))
      .send({ archived: false })
      .expect(200);
    expect((await manage()).archived_at).toBeNull();
    // A KPI with answers cannot be deleted; one no one answered can.
    expect(
      (
        await request(server)
          .delete("/api/kpis/" + created.body.id)
          .set(as(admin))
          .expect(400)
      ).body.error,
    ).toBe("This KPI has answers. Archive it instead, so its history stays.");
    const spare = (
      await request(server)
        .post("/api/kpis")
        .set(as(admin))
        .send({
          title: "Spare",
          question: "Spare?",
          frequency: "week",
          answer_type: "yes_no",
        })
        .expect(201)
    ).body.id;
    await request(server)
      .delete("/api/kpis/" + spare)
      .set(as(admin))
      .expect(200);
    expect(
      (await one("select count(*)::int n from kpis where id=$1", [spare])).n,
    ).toBe(0);
    expect(
      (
        await all(
          "select action from audit_log where entity='kpis' order by id",
        )
      ).map((a) => a.action),
    ).toEqual([
      "kpi.created",
      "kpi.updated",
      "kpi.updated",
      "kpi.updated",
      "kpi.updated",
      "kpi.archived",
      "kpi.restored",
      "kpi.created",
      "kpi.deleted",
    ]);
    // Invalid definitions are refused by the server and the database.
    for (const body of [
      {
        title: "X",
        question: "Y?",
        frequency: "month",
        answer_type: "number",
        target: 1,
      },
      { title: "X", question: "Y?", frequency: "day", answer_type: "number" },
      {
        title: "X",
        question: "Y?",
        frequency: "day",
        answer_type: "yes_no",
        target: 2,
      },
      { title: "", question: "Y?", frequency: "day", answer_type: "yes_no" },
      {
        title: "X",
        question: "Y?",
        frequency: "day",
        answer_type: "number",
        target: 0,
      },
    ])
      await request(server)
        .post("/api/kpis")
        .set(as(admin))
        .send(body)
        .expect(400);
    await expect(
      save(
        {
          title: "X",
          question: "Y?",
          frequency: "day",
          answer_type: "number",
          target: "1",
        },
        at("2026-11-02"),
      ),
    ).rejects.toThrow("Choose a target from 1 to 10,000");
  });

  it("never lets an agent create, change, archive, delete or list KPI definitions", async () => {
    const server = app();
    const { calls } = await fiveKpis();
    for (const user of [ali, sara]) {
      await request(server)
        .post("/api/kpis")
        .set(as(user))
        .send({
          title: "Mine",
          question: "Q?",
          frequency: "day",
          answer_type: "yes_no",
        })
        .expect(403);
      await request(server)
        .patch("/api/kpis/" + calls)
        .set(as(user))
        .send({ target: 5 })
        .expect(403);
      await request(server)
        .post(`/api/kpis/${calls}/archive`)
        .set(as(user))
        .send({ archived: true })
        .expect(403);
      await request(server)
        .delete("/api/kpis/" + calls)
        .set(as(user))
        .expect(403);
      await request(server).get("/api/kpis/manage").set(as(user)).expect(403);
      await request(server)
        .get("/api/kpis/report?from=2026-11-02&to=2026-11-02")
        .set(as(user))
        .expect(403);
    }
    await expect(
      one("select public.kpi_save($1,null,$2::jsonb,'t') r", [
        ali,
        JSON.stringify({
          title: "Mine",
          question: "Q?",
          frequency: "day",
          answer_type: "yes_no",
        }),
      ]),
    ).rejects.toThrow("Administrator access required");
    expect((await one("select count(*)::int n from kpis")).n).toBe(5);
  });

  it("keeps history: earlier days and weeks keep their rules and the wording the agent answered", async () => {
    const k = await fiveKpis();
    // Monday 2 Nov: 2 inventories (target 1), 3 visits (target 3).
    await submit(
      ali,
      "2026-11-02",
      [
        [k.inventory, 2],
        [k.visits, 3],
      ],
      at("2026-11-02"),
    );
    // Tuesday: the administrator raises both targets and renames one.
    const inv = await save(
      { target: 3, question: "How many inventories, with owner details?" },
      at("2026-11-03"),
      k.inventory,
    );
    const vis = await save({ target: 5 }, at("2026-11-03"), k.visits);
    expect(inv.rules_from).toBe("2026-11-04");
    expect(vis.rules_from).toBe("2026-11-09");
    await submit(ali, "2026-11-04", [[k.inventory, 2]], at("2026-11-04"));
    const week = await report(
      "2026-11-02",
      "2026-11-08",
      at("2026-11-10"),
      ali,
    );
    // Monday met its target of 1; Wednesday missed the new target of 3.
    expect(cell(week, ali, k.inventory).daily).toMatchObject({
      met: 1,
      below: 1,
      total: 4,
    });
    // The week of 2 November was measured against 3 visits, and stays met.
    expect(cell(week, ali, k.visits).weekly.weeks[0]).toMatchObject({
      total: 3,
      target: 3,
      status: "met",
    });
    const next = await report(
      "2026-11-09",
      "2026-11-15",
      at("2026-11-16"),
      ali,
    );
    expect(cell(next, ali, k.visits).weekly.weeks[0]).toMatchObject({
      target: 5,
      status: "missed",
    });
    // Each answer keeps the question it was given.
    expect(
      await all(
        "select activity_date::text d,question from kpi_submissions where kpi_id=$1 order by 1",
        [k.inventory],
      ),
    ).toEqual([
      { d: "2026-11-02", question: "Verified inventory?" },
      {
        d: "2026-11-04",
        question: "How many inventories, with owner details?",
      },
    ]);
  });
});

describe("answers", () => {
  it("needs an explicit Yes or No, takes 0 as an answer, and leaves the rest pending", async () => {
    const server = app();
    const k = await fiveKpis(new Date().toISOString());
    const day = (
      await request(server).get("/api/kpis/my").set(as(ali)).expect(200)
    ).body;
    expect(day.kpis.map((i) => [i.title, i.answer])).toEqual([
      ["Assigned calls answered", null],
      ["Social media activity", null],
      ["Project visits", null],
      ["Verified inventory", null],
      ["HD Marketing video", null],
    ]);
    // Wrong kinds of answer are refused.
    for (const answers of [
      [{ kpi_id: k.calls, answer: "yes" }],
      [{ kpi_id: k.calls, answer: 1 }],
      [{ kpi_id: k.inventory, answer: -1 }],
      [{ kpi_id: k.inventory, answer: 1.5 }],
      [{ kpi_id: k.inventory, answer: true }],
      [{ kpi_id: k.inventory, answer: null }],
      [],
    ])
      await request(server)
        .put(`/api/kpis/my/${day.today}`)
        .set(as(ali))
        .send({ answers })
        .expect(400);
    const saved = (
      await request(server)
        .put(`/api/kpis/my/${day.today}`)
        .set(as(ali))
        .send({
          answers: [
            { kpi_id: k.calls, answer: false },
            { kpi_id: k.inventory, answer: 0 },
          ],
        })
        .expect(200)
    ).body;
    expect(saved.saved).toBe(2);
    expect(
      Object.fromEntries(saved.kpis.map((i) => [i.title, i.answer])),
    ).toMatchObject({
      "Assigned calls answered": false,
      "Verified inventory": 0,
      "Social media activity": null,
    });
    const today = (
      await request(server)
        .get(`/api/kpis/report?from=${day.today}&to=${day.today}`)
        .set(as(admin))
        .expect(200)
    ).body;
    const mine = today.agents.find((a) => a.id === ali);
    if (day.day_status === "work") {
      expect(mine.cells[k.calls].day).toMatchObject({
        state: "answered",
        value: false,
        met: false,
      });
      expect(mine.cells[k.inventory].day).toMatchObject({
        state: "answered",
        value: 0,
        met: false,
      });
      expect(mine.cells[k.social].day.state).toBe("pending");
      expect(mine.entries).toMatchObject({
        answered: 2,
        missing: 0,
        pending: 3,
      });
    }
  });

  it("replaces a day's count when it is changed, and never adds a repeat twice", async () => {
    const k = await fiveKpis();
    await submit(ali, "2026-11-02", [[k.visits, 2]], at("2026-11-02"));
    await submit(ali, "2026-11-02", [[k.visits, 1]], at("2026-11-03"));
    expect(
      await submit(ali, "2026-11-02", [[k.visits, 1]], at("2026-11-03")),
    ).toMatchObject({ saved: 0 });
    await submit(ali, "2026-11-02", [[k.visits, 1]], at("2026-11-04"));
    expect(
      await one(
        "select count(*)::int n,sum(answer_count)::int s from kpi_submissions where kpi_id=$1",
        [k.visits],
      ),
    ).toEqual({ n: 1, s: 1 });
    const r = await report("2026-11-02", "2026-11-08", at("2026-11-04"), ali);
    expect(cell(r, ali, k.visits).weekly.weeks[0]).toMatchObject({
      total: 1,
      target: 3,
      status: "in_progress",
    });
    // Every change is in the audit log, with before and after.
    expect(
      (
        await all(
          "select metadata->'answers'->0->>'before' b,metadata->'answers'->0->>'after' a from audit_log where action='kpi.answers_saved' order by id",
        )
      ).map((x) => [x.b, x.a]),
    ).toEqual([
      [null, "2"],
      ["2", "1"],
    ]);
  });

  it("adds visits and videos up over the week and keeps a week met once reached; daily KPIs stay daily", async () => {
    const k = await fiveKpis();
    // Monday 1 visit, Tuesday 1 video, Wednesday 2 visits, Thursday 1 more.
    await submit(
      ali,
      "2026-11-02",
      [
        [k.visits, 1],
        [k.calls, true],
        [k.video, 0],
      ],
      at("2026-11-02"),
    );
    await submit(ali, "2026-11-03", [[k.video, 1]], at("2026-11-03"));
    const tuesday = agentDay(
      await facts("2026-11-02", "2026-11-03", at("2026-11-03"), ali, ali),
      ali,
      "2026-11-03",
    );
    expect(tuesday.kpis.find((i) => i.id === k.visits).week).toMatchObject({
      total: 1,
      target: 3,
      status: "in_progress",
    });
    await submit(ali, "2026-11-04", [[k.visits, 2]], at("2026-11-04"));
    let r = await report("2026-11-02", "2026-11-08", at("2026-11-04"), ali);
    expect(cell(r, ali, k.visits).weekly.weeks[0]).toMatchObject({
      total: 3,
      target: 3,
      status: "met",
    });
    expect(cell(r, ali, k.video).weekly.weeks[0]).toMatchObject({
      total: 1,
      target: 1,
      status: "met",
    });
    await submit(ali, "2026-11-05", [[k.visits, 1]], at("2026-11-05"));
    // Exceeded: still met. No more videos needed for the rest of the week.
    r = await report("2026-11-02", "2026-11-08", at("2026-11-12"), ali);
    expect(cell(r, ali, k.visits).weekly).toMatchObject({
      met: 1,
      missed: 0,
      total: 4,
    });
    expect(cell(r, ali, k.video).weekly).toMatchObject({ met: 1, missed: 0 });
    // One Yes on Monday is one day, not the week: Tuesday to Saturday missed.
    expect(cell(r, ali, k.calls).daily).toMatchObject({
      days: 6,
      met: 1,
      missed: 5,
    });
  });

  it("takes daily KPIs only on their day, weekly entries only this week, never the future", async () => {
    const k = await fiveKpis();
    const now = at("2026-11-04");
    await expect(
      submit(ali, "2026-11-03", [[k.calls, true]], now),
    ).rejects.toThrow("Daily KPIs can only be answered on the day");
    expect(await submit(ali, "2026-11-03", [[k.visits, 2]], now)).toMatchObject(
      { saved: 1 },
    );
    await expect(
      submit(ali, "2026-11-01", [[k.visits, 2]], now),
    ).rejects.toThrow("Choose a day of this week, up to today");
    await expect(
      submit(ali, "2026-11-05", [[k.visits, 2]], now),
    ).rejects.toThrow("Choose a day of this week, up to today");
    // All or nothing: one bad answer saves none.
    await expect(
      submit(
        ali,
        "2026-11-04",
        [
          [k.social, true],
          [k.inventory, -1],
        ],
        now,
      ),
    ).rejects.toThrow("whole number");
    expect(
      (
        await one(
          "select count(*)::int n from kpi_submissions where kpi_id=$1",
          [k.social],
        )
      ).n,
    ).toBe(0);
  });

  it("uses Pakistan days: 23:59 and 00:01 are different days, whatever the UTC date", async () => {
    const k = await fiveKpis();
    await submit(
      ali,
      "2026-11-04",
      [[k.calls, true]],
      "2026-11-04T23:59:00+05:00",
    );
    // 00:01 Pakistan time is still 4 November in UTC.
    const after = "2026-11-04T19:01:00Z";
    await expect(
      submit(ali, "2026-11-04", [[k.social, true]], after),
    ).rejects.toThrow("Daily KPIs can only be answered on the day");
    await submit(ali, "2026-11-05", [[k.social, true]], after);
    expect(
      await all(
        "select activity_date::text d from kpi_submissions where agent_id=$1 order by 1",
        [ali],
      ),
    ).toEqual([{ d: "2026-11-04" }, { d: "2026-11-05" }]);
    // Sunday 8 November 23:30 is in the week of 2 November; 00:30 Monday is not.
    expect(
      await submit(
        ali,
        "2026-11-02",
        [[k.visits, 1]],
        "2026-11-08T23:30:00+05:00",
      ),
    ).toMatchObject({ saved: 1 });
    await expect(
      submit(ali, "2026-11-02", [[k.visits, 2]], "2026-11-09T00:30:00+05:00"),
    ).rejects.toThrow("Choose a day of this week");
  });

  it("never lets an agent answer for, or read, someone else", async () => {
    const server = app();
    const k = await fiveKpis(new Date().toISOString());
    const only = (
      await request(server)
        .post("/api/kpis")
        .set(as(admin))
        .send({
          title: "Sara only",
          question: "Q?",
          frequency: "day",
          answer_type: "yes_no",
          agent_ids: [sara],
        })
        .expect(201)
    ).body.id;
    const today = (
      await request(server).get("/api/kpis/my").set(as(ali)).expect(200)
    ).body.today;
    // No way to name another agent in a request.
    await request(server)
      .put(`/api/kpis/my/${today}`)
      .set(as(ali))
      .send({ agent_id: sara, answers: [{ kpi_id: k.calls, answer: true }] })
      .expect(400);
    await request(server)
      .put(`/api/kpis/my/${today}`)
      .set(as(ali))
      .send({ answers: [{ kpi_id: k.calls, answer: true, agent_id: sara }] })
      .expect(400);
    // A KPI for Sara only is not Ali's to answer.
    await request(server)
      .put(`/api/kpis/my/${today}`)
      .set(as(ali))
      .send({ answers: [{ kpi_id: only, answer: true }] })
      .expect(400);
    // Only agents answer; administrators read, never answer as an agent.
    await request(server)
      .put(`/api/kpis/my/${today}`)
      .set(as(admin))
      .send({ answers: [{ kpi_id: k.calls, answer: true }] })
      .expect(403);
    await request(server)
      .get(`/api/kpis/history?agent=${sara}&from=${today}&to=${today}`)
      .set(as(ali))
      .expect(403);
    await expect(
      facts(today, today, new Date().toISOString(), sara, ali),
    ).rejects.toThrow("You can only see your own KPIs");
    await expect(
      facts(today, today, new Date().toISOString(), null, ali),
    ).rejects.toThrow("You can only see your own KPIs");
    expect(
      (
        await one(
          "select count(*)::int n from kpi_submissions where agent_id=$1",
          [sara],
        )
      ).n,
    ).toBe(0);
    // The tables are closed to browsers.
    for (const role of ["anon", "authenticated"])
      for (const table of ["kpis", "kpi_versions", "kpi_submissions"])
        expect(
          (
            await one("select has_table_privilege($1,$2,'select') ok", [
              role,
              "public." + table,
            ])
          ).ok,
        ).toBe(false);
  });
});

describe("reports", () => {
  it("shows every agent, disabled ones included, for Today, Yesterday, a week, a month and a custom range", async () => {
    const k = await fiveKpis();
    await submit(
      ali,
      "2026-11-11",
      [
        [k.calls, true],
        [k.social, false],
        [k.inventory, 2],
        [k.visits, 1],
        [k.video, 0],
      ],
      at("2026-11-11"),
    );
    await submit(sara, "2026-11-11", [[k.calls, true]], at("2026-11-11"));
    await submit(ali, "2026-11-12", [[k.calls, true]], at("2026-11-12"));
    await pg.query("update profiles set active=false where id=$1", [sara]);
    const now = at("2026-11-12", "15:00");
    const ranges = {
      today: ["2026-11-12", "2026-11-12"],
      yesterday: ["2026-11-11", "2026-11-11"],
      this_week: ["2026-11-09", "2026-11-12"],
      last_week: ["2026-11-02", "2026-11-08"],
      this_month: ["2026-11-01", "2026-11-12"],
      custom: ["2026-11-10", "2026-11-11"],
    };
    const results = {};
    for (const [name, [from, to]] of Object.entries(ranges))
      results[name] = await report(from, to, now);
    for (const r of Object.values(results))
      expect(r.agents.map((a) => [a.id, a.active]).sort()).toEqual(
        [
          [ali, true],
          [sara, false],
        ].sort(),
      );
    // Yesterday: Ali answered all five, one of them No; Sara one of five:
    // her two daily ones are missed, her two weekly ones can still be
    // entered this week.
    const y = results.yesterday;
    expect(cell(y, ali, k.calls).day).toMatchObject({
      state: "answered",
      value: true,
      met: true,
    });
    expect(cell(y, ali, k.social).day).toMatchObject({
      value: false,
      met: false,
    });
    expect(cell(y, ali, k.inventory).day).toMatchObject({
      value: 2,
      met: true,
    });
    expect(cell(y, ali, k.visits).weekly.weeks[0]).toMatchObject({
      start: "2026-11-09",
      total: 1,
      status: "in_progress",
    });
    expect(y.agents.find((a) => a.id === ali).entries).toMatchObject({
      expected: 5,
      answered: 5,
      missing: 0,
    });
    expect(y.agents.find((a) => a.id === sara).entries).toMatchObject({
      expected: 5,
      answered: 1,
      missing: 2,
      pending: 2,
    });
    // Today: Ali's other four are pending, not missed.
    expect(
      results.today.agents.find((a) => a.id === ali).entries,
    ).toMatchObject({ answered: 1, pending: 4, missing: 0 });
    // This week, Monday to Thursday: Monday and Tuesday missed.
    expect(cell(results.this_week, ali, k.calls).daily).toMatchObject({
      days: 4,
      met: 2,
      missed: 2,
    });
    // The custom range covers Tuesday and Wednesday only.
    expect(cell(results.custom, ali, k.calls).daily).toMatchObject({
      days: 2,
      met: 1,
      missed: 1,
    });
    // One agent only.
    const one_ = await report("2026-11-11", "2026-11-11", now, ali);
    expect(one_.agents.map((a) => a.id)).toEqual([ali]);
  });

  it("counts a month's weeks once each, by their Thursday, and never fails the running week", async () => {
    const k = await fiveKpis();
    // Week 26 Oct - 1 Nov (Thursday 29 Oct, so October): 3 visits, two on 1 Nov.
    await submit(ali, "2026-10-28", [[k.visits, 1]], at("2026-10-28"));
    await submit(ali, "2026-11-01", [[k.visits, 2]], at("2026-11-01"));
    // Week 2-8 Nov: 1 visit (missed). Week 9-15 Nov: 2 so far (running).
    await submit(ali, "2026-11-03", [[k.visits, 1]], at("2026-11-03"));
    await submit(ali, "2026-11-10", [[k.visits, 2]], at("2026-11-10"));
    const now = at("2026-11-12");
    const november = await report("2026-11-01", "2026-11-12", now, ali);
    expect(november.weeks.map((w) => w.start)).toEqual([
      "2026-11-02",
      "2026-11-09",
    ]);
    expect(cell(november, ali, k.visits).weekly).toMatchObject({
      met: 0,
      missed: 1,
      in_progress: 1,
      total: 3,
    });
    const october = await report("2026-10-01", "2026-10-31", now, ali);
    expect(cell(october, ali, k.visits).weekly).toMatchObject({
      met: 1,
      missed: 0,
      in_progress: 0,
      total: 3,
    });
    // A weekly target is per week: 1 video a week is 2 due over two finished
    // weeks, not one per day.
    const overall = november.agents.find((a) => a.id === ali).overall;
    const video = cell(november, ali, k.video).weekly;
    expect(video).toMatchObject({ met: 0, missed: 1, in_progress: 1 });
    expect(overall.pending).toBeGreaterThanOrEqual(2);
    // The agent's own history shows the same weeks.
    const history = agentHistory(
      await facts("2026-11-02", "2026-11-12", now, ali, ali),
      ali,
      "2026-11-02",
      "2026-11-12",
    );
    expect(
      history.weeks.map((w) => [
        w.start,
        w.kpis[k.visits].total,
        w.kpis[k.visits].status,
      ]),
    ).toEqual([
      ["2026-11-09", 2, "in_progress"],
      ["2026-11-02", 1, "missed"],
    ]);
  });

  it("does not count days off, holidays or leave as missed", async () => {
    const k = await fiveKpis();
    await pg.query(
      "insert into attendance_holidays(holiday_date,name,created_by) values('2026-11-09','Iqbal Day',$1)",
      [admin],
    );
    const r = await report("2026-11-08", "2026-11-10", at("2026-11-11"), ali);
    // Sunday 8 off, Monday 9 a holiday, Tuesday 10 missed.
    expect(cell(r, ali, k.calls).daily).toMatchObject({ days: 1, missed: 1 });
    const day = await report("2026-11-09", "2026-11-09", at("2026-11-11"), ali);
    expect(cell(day, ali, k.calls).day.state).toBe("holiday");
  });

  it("serves the report and an agent's history to administrators", async () => {
    const server = app();
    await fiveKpis(new Date().toISOString());
    const today = (
      await request(server).get("/api/kpis/my").set(as(ali)).expect(200)
    ).body.today;
    const r = (
      await request(server)
        .get(`/api/kpis/report?from=${today}&to=${today}`)
        .set(as(admin))
        .expect(200)
    ).body;
    expect(r.kpis.map((k) => k.title)).toEqual([
      "Assigned calls answered",
      "Social media activity",
      "Project visits",
      "Verified inventory",
      "HD Marketing video",
    ]);
    const h = (
      await request(server)
        .get(`/api/kpis/history?agent=${ali}&from=${today}&to=${today}`)
        .set(as(admin))
        .expect(200)
    ).body;
    expect(h.agent.id).toBe(ali);
    await request(server)
      .get(`/api/kpis/report?from=${today}&to=2020-01-01`)
      .set(as(admin))
      .expect(400);
    await request(server)
      .get(`/api/kpis/report?from=2024-01-01&to=${today}`)
      .set(as(admin))
      .expect(400);
  });
});
