import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { agentDay, kpiReport } from "../src/services/kpis.js";
import { evidenceLink } from "../src/services/kpiEvidence.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 076: administrators manage every KPI's rules, including the KPIs
// the CRM fills in, against every migration. Wording changes at once; rules
// from the next Pakistan day, or the next Monday for a weekly KPI or a
// change between daily and weekly, and never in place for a KPI the CRM
// fills in. Earlier days and weeks keep their rules. Each CRM count can be a
// number or a Yes/No; assigned calls stay a daily Yes/No, and targets the
// evidence limits make impossible are refused with the reason. Fixed times
// are passed to the SQL functions (p_now).
const admin = "76000000-0000-4000-8000-000000000001",
  ali = "76000000-0000-4000-8000-000000000002",
  sara = "76000000-0000-4000-8000-000000000003";
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
    "update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])",
    [[admin, ali, sara]],
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
// Pakistan time.
const at = (day, time = "10:00") => `${day}T${time}:00+05:00`;
const save = async (data, now, id = null, actor = admin) =>
  (
    await one("select public.kpi_save($1,$2,$3::jsonb,'t',$4) r", [
      actor,
      id,
      JSON.stringify(data),
      now,
    ])
  ).r;
const facts = async (from, to, now) =>
  (
    await one("select public.kpi_facts($1,$2,$3,null,$4) r", [
      admin,
      from,
      to,
      now,
    ])
  ).r;
const versions = (kpi) =>
  all(
    "select version,effective_from::text e,frequency,answer_type,target,expect_yes,measure from kpi_versions where kpi_id=$1 order by version",
    [kpi],
  ).then((rows) =>
    rows.map((v) => [
      v.e,
      v.frequency,
      v.answer_type,
      v.target,
      v.expect_yes,
      v.measure,
    ]),
  );
const cell = (r, agent, kpi) =>
  r.agents.find((a) => a.id === agent)?.cells[kpi];
const item = (day, kpi) => day.kpis.find((i) => i.id === kpi);
// A KPI the CRM fills in, as update 072 made them, from Monday 26 October.
async function measuredKpi(title, frequency, answer_type, target, measure) {
  const k = await save(
    {
      title,
      question: `${title}?`,
      frequency,
      answer_type,
      ...(answer_type === "number" ? { target } : {}),
    },
    at("2026-10-26", "09:00"),
  );
  await pg.query("update kpi_versions set measure=$2 where kpi_id=$1", [
    k.id,
    measure,
  ]);
  return k.id;
}
const house = (extra = {}) => ({
  title: "Corner house",
  type: "House",
  purpose: "sale",
  price: 25000000,
  area: 10,
  area_unit: "marla",
  city: "Lahore",
  area_society: "DHA Phase 6",
  owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 1234567" },
  ...extra,
});
// A listing an agent added on a given Pakistan day.
async function listing(agent, day, extra) {
  const res = await send(agent, "post", "/properties", house(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await pg.query("update properties set created_at=$2 where id=$1", [
    res.body.id,
    at(day, "12:00"),
  ]);
  return res.body.id;
}
const verify = (id, status = "verified") =>
  send(admin, "post", `/kpis/inventory/${id}/review`, { status }).expect(200);

describe("changing a KPI's rules (update 076)", () => {
  it("changes wording at once and rules from the next period, keeping one waiting change and every change in Audit history", async () => {
    const k = await measuredKpi(
      "Verified inventory with owner details",
      "day",
      "number",
      1,
      "inventory",
    );
    // Wednesday 4 November: new wording only.
    let r = await save(
      {
        question:
          "How many verified property inventories with owner details did you complete?",
        description: "Counted from Inventory once verified.",
      },
      at("2026-11-04"),
      k,
    );
    expect(r).toMatchObject({
      question:
        "How many verified property inventories with owner details did you complete?",
      description: "Counted from Inventory once verified.",
      rules_from: null,
    });
    // Daily to weekly, 3 a week: from Monday 9 November, never this week.
    r = await save(
      { frequency: "week", answer_type: "number", target: 3 },
      at("2026-11-04", "16:00"),
      k,
    );
    expect(r.rules_from).toBe("2026-11-09");
    // 3 becomes 2 before it starts: still one waiting change, same Monday.
    r = await save({ target: 2 }, at("2026-11-06"), k);
    expect(r.rules_from).toBe("2026-11-09");
    expect(await versions(k)).toEqual([
      ["2026-10-26", "day", "number", 1, true, "inventory"],
      ["2026-11-09", "week", "number", 2, true, "inventory"],
    ]);
    // Weekly now: 2 becomes 5 from the Monday after, this week keeps 2.
    r = await save({ target: 5 }, at("2026-11-10"), k);
    expect(r.rules_from).toBe("2026-11-16");
    expect(await versions(k)).toEqual([
      ["2026-10-26", "day", "number", 1, true, "inventory"],
      ["2026-11-09", "week", "number", 2, true, "inventory"],
      ["2026-11-16", "week", "number", 5, true, "inventory"],
    ]);
    // Changing it back before it starts removes the waiting change.
    r = await save({ target: 2 }, at("2026-11-11"), k);
    expect(r.rules_from).toBeNull();
    expect((await versions(k)).length).toBe(2);
    // Audit history: who, when, and the rules before and after.
    const entries = await all(
      "select action,entity,actor_id,created_at,metadata from audit_log where entity='kpis' and entity_id=$1 and action='kpi.updated' order by id",
      [k],
    );
    expect(entries.every((e) => e.actor_id === admin && e.created_at)).toBe(
      true,
    );
    const text = entries.map(
      (e) => presentAuditEntry({ ...e, actor: { id: admin } }).description,
    );
    expect(text[0]).toBe(
      "Changed the KPI “Verified inventory with owner details”. Its question was reworded.",
    );
    expect(text[1]).toBe(
      "Changed the KPI “Verified inventory with owner details”. Its rules change from November 9, 2026: Daily → Weekly; target 1 a day → 3 a week.",
    );
    // A change to a waiting change is from those waiting rules.
    expect(text[2]).toMatch(/: target 3 a week → 2 a week\.$/);
    expect(text[3]).toMatch(/target 2 a week → 5 a week\.$/);
    // Going back to today's rules cancels the waiting change, on record.
    expect(text[4]).toBe(
      "Changed the KPI “Verified inventory with owner details”. The rules change waiting from November 16, 2026 was cancelled.",
    );
  });

  it("starts daily rules at the next Pakistan midnight and weekly rules on the next Monday", async () => {
    const k = await measuredKpi("Video", "week", "number", 1, "video");
    const s = await measuredKpi("Social", "day", "number", 1, "social");
    // 23:59:59 on Wednesday 4 November in Pakistan (18:59:59 UTC) is still
    // Wednesday; a second later it is Thursday.
    expect(
      (await save({ target: 2 }, "2026-11-04T18:59:59Z", s)).rules_from,
    ).toBe("2026-11-05");
    expect(
      (await save({ target: 3 }, "2026-11-04T19:00:00Z", s)).rules_from,
    ).toBe("2026-11-06");
    // Sunday 8 November 23:59 is still that week; Monday 00:00 is the next.
    expect(
      (await save({ target: 2 }, at("2026-11-08", "23:59"), k)).rules_from,
    ).toBe("2026-11-09");
    expect(
      (await save({ target: 3 }, at("2026-11-09", "00:00"), k)).rules_from,
    ).toBe("2026-11-16");
    // Weekly to daily waits for the week to end too.
    expect(
      (
        await save(
          { frequency: "day", answer_type: "number", target: 1 },
          at("2026-11-11"),
          k,
        )
      ).rules_from,
    ).toBe("2026-11-16");
  });

  it("refuses rules a CRM source cannot measure, with the reason, and changes nothing", async () => {
    const calls = await measuredKpi("Calls", "day", "yes_no", 1, "calls");
    const social = await measuredKpi("Social", "day", "yes_no", 1, "social");
    const video = await measuredKpi("Video", "week", "number", 1, "video");
    const before = await all(
      "select * from kpi_versions order by kpi_id,version",
    );
    for (const [kpi, body, reason] of [
      [calls, { frequency: "week" }, "There is no rule for a whole week"],
      [calls, { answer_type: "number", target: 3 }, "no number to reach"],
      [social, { answer_type: "number", target: 6 }, "at most 5 a day"],
      [
        social,
        { frequency: "week", answer_type: "number", target: 36 },
        "35 a week",
      ],
      [video, { target: 21 }, "at most 2 a day"],
      [video, { frequency: "day", target: 3 }, "at most 2 a day"],
      [social, { expected: "no" }, "expects Yes"],
    ]) {
      const res = await send(admin, "patch", `/kpis/${kpi}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toContain(reason);
    }
    expect(
      await all("select * from kpi_versions order by kpi_id,version"),
    ).toEqual(before);
    // What is possible is accepted.
    for (const body of [
      { answer_type: "number", target: 5 },
      { frequency: "week", answer_type: "number", target: 35 },
    ])
      expect((await send(admin, "patch", `/kpis/${social}`, body)).status).toBe(
        200,
      );
    expect(
      (await send(admin, "patch", `/kpis/${video}`, { target: 20 })).status,
    ).toBe(200);
    // The list says what each source can do and when a change starts.
    const list = (await send(admin, "get", "/kpis/manage")).body;
    expect(list.sources.calls).toMatchObject({
      frequencies: ["day"],
      answer_types: ["yes_no"],
    });
    expect(list.sources.social.max).toEqual({ day: 5, week: 35 });
    expect(list.next_monday > list.today && list.next_day > list.today).toBe(
      true,
    );
    expect(list.kpis.every((x) => x.corrects_now === false)).toBe(true);
  });
});

describe("what the CRM measures under the new rules (update 076)", () => {
  it("counts verified inventory by the week each listing was added, also when verified the week after", async () => {
    const k = await measuredKpi(
      "Verified inventory",
      "day",
      "number",
      1,
      "inventory",
    );
    expect(
      (
        await save(
          { frequency: "week", answer_type: "number", target: 3 },
          at("2026-11-04"),
          k,
        )
      ).rules_from,
    ).toBe("2026-11-09");
    // Week of Monday 9 November: two on Tuesday, one on Sunday; one more
    // on Monday 16 November. One has no owner phone; one is rejected.
    const tue1 = await listing(ali, "2026-11-10");
    const tue2 = await listing(ali, "2026-11-10");
    const sun = await listing(ali, "2026-11-15");
    const noPhone = await listing(ali, "2026-11-15", {
      owner_contact: { owner_name: "Mr Butt" },
    });
    const next = await listing(ali, "2026-11-16");
    const rejected = await listing(ali, "2026-11-11");
    await verify(tue1);
    await verify(next);
    await verify(rejected, "rejected");
    // Seen on Tuesday 17 November: the week ended at 2 of 3 with listings
    // still waiting, so it awaits review rather than being missed.
    const now = at("2026-11-17", "11:00");
    let r = kpiReport(
      await facts("2026-11-09", "2026-11-15", now),
      "2026-11-09",
      "2026-11-15",
    );
    expect(cell(r, ali, k).weekly.weeks).toEqual([
      expect.objectContaining({
        start: "2026-11-09",
        total: 1,
        target: 3,
        status: "review",
        detail: expect.objectContaining({
          uploaded: 5,
          verified: 1,
          rejected: 1,
        }),
      }),
    ]);
    // Verified a week late, they count for the week they were added; the
    // next week's listing never does.
    await verify(tue2);
    await verify(sun);
    // Without the owner's phone it cannot be verified, so never counts.
    expect(
      (
        await send(admin, "post", `/kpis/inventory/${noPhone}/review`, {
          status: "verified",
        })
      ).status,
    ).toBe(400);
    r = kpiReport(
      await facts("2026-11-09", "2026-11-15", now),
      "2026-11-09",
      "2026-11-15",
    );
    expect(cell(r, ali, k).weekly.weeks[0]).toMatchObject({
      total: 3,
      target: 3,
      status: "met",
    });
    // The listing without the owner's phone stays uncounted.
    expect(cell(r, ali, k).weekly.weeks[0].detail.verified).toBe(3);
    const day = agentDay(
      await facts("2026-11-16", "2026-11-17", now),
      ali,
      "2026-11-17",
    );
    expect(item(day, k)).toMatchObject({
      frequency: "week",
      answer_type: "number",
      target: 3,
      measure: "inventory",
      week: expect.objectContaining({
        start: "2026-11-16",
        total: 1,
        status: "in_progress",
      }),
    });
  });

  it("reads approved social links as a weekly number, and visits as a daily Yes/No", async () => {
    const social = await measuredKpi("Social", "day", "yes_no", 1, "social");
    const visits = await measuredKpi("Visits", "week", "number", 3, "visits");
    await save(
      { frequency: "week", answer_type: "number", target: 3 },
      at("2026-11-04"),
      social,
    );
    await save(
      { frequency: "day", answer_type: "yes_no" },
      at("2026-11-04"),
      visits,
    );
    const link = (url, day) =>
      one("select public.kpi_evidence_add($1,$2::jsonb,'t',$3) r", [
        ali,
        JSON.stringify({ kind: "social", ...evidenceLink(url) }),
        at(day, "12:00"),
      ]).then((x) => x.r.id);
    const photo = (project, visit_date, n) =>
      one("select public.kpi_evidence_add($1,$2::jsonb,'t',$3) r", [
        ali,
        JSON.stringify({
          kind: "visit",
          project,
          visit_date,
          storage_path: `${ali}/${randomUUID()}`,
          file_hash: String(n).padStart(64, "0"),
          mime_type: "image/png",
          size_bytes: 100,
        }),
        at(visit_date, "18:00"),
      ]).then((x) => x.r.id);
    const review = (id, status) =>
      one("select public.kpi_evidence_review($1,$2,$3,null,'t')", [
        admin,
        id,
        status,
      ]);
    const a = await link("https://www.facebook.com/hd/posts/1", "2026-11-09");
    const b = await link("https://www.instagram.com/p/abc/", "2026-11-09");
    const c = await link("https://www.tiktok.com/@hd/video/3", "2026-11-11");
    const d = await link("https://www.facebook.com/hd/posts/4", "2026-11-12");
    for (const id of [a, b, c]) await review(id, "approved");
    await review(d, "rejected");
    const p1 = await photo("Bahria Town", "2026-11-10", 1);
    await review(p1, "approved");
    const f = await facts("2026-11-09", "2026-11-15", at("2026-11-16"));
    const r = kpiReport(f, "2026-11-09", "2026-11-15");
    // Three approved links in the week: met; the rejected one never counts.
    expect(cell(r, ali, social).weekly.weeks[0]).toMatchObject({
      total: 3,
      target: 3,
      status: "met",
    });
    // Visits, now daily Yes/No: Yes on Tuesday, missed on the other
    // working days without a visit.
    expect(cell(r, ali, visits).daily).toMatchObject({
      answer_type: "yes_no",
      met: 1,
    });
    expect(item(agentDay(f, ali, "2026-11-10"), visits)).toMatchObject({
      answer: true,
      met: true,
      expected: "yes",
    });
  });
});

describe("history, Yes/No expectations and permissions (update 076)", () => {
  it("keeps earlier days' and weeks' results and targets after a change, and after archiving", async () => {
    const k = await measuredKpi("Inventory", "day", "number", 1, "inventory");
    await listing(ali, "2026-11-03");
    const l2 = await listing(ali, "2026-11-04");
    await verify(l2);
    const now = at("2026-11-06");
    const earlier = kpiReport(
      await facts("2026-11-02", "2026-11-05", now),
      "2026-11-02",
      "2026-11-05",
    );
    // Daily 1 → daily 2 from tomorrow, then archived.
    expect((await save({ target: 2 }, now, k)).rules_from).toBe("2026-11-07");
    expect(
      kpiReport(
        await facts("2026-11-02", "2026-11-05", now),
        "2026-11-02",
        "2026-11-05",
      ),
    ).toEqual(earlier);
    await send(admin, "post", `/kpis/${k}/archive`, { archived: true }).expect(
      200,
    );
    const later = kpiReport(
      await facts("2026-11-02", "2026-11-05", now),
      "2026-11-02",
      "2026-11-05",
    );
    expect(cell(later, ali, k)).toEqual(cell(earlier, ali, k));
    expect(later.kpis.find((x) => x.id === k).archived).toBe(true);
    // A range across the change shows each target with the days it judged.
    await send(admin, "post", `/kpis/${k}/archive`, { archived: false }).expect(
      200,
    );
    const across = kpiReport(
      await facts("2026-11-05", "2026-11-09", at("2026-11-10")),
      "2026-11-05",
      "2026-11-09",
    );
    expect(cell(across, ali, k).daily.rules).toEqual([
      { from: "2026-11-05", answer_type: "number", target: 1, expected: null },
      { from: "2026-11-07", answer_type: "number", target: 2, expected: null },
    ]);
  });

  it("lets an agents' own Yes/No KPI expect No, daily and weekly", async () => {
    const day = await save(
      {
        title: "Missed a callback",
        question: "Did you miss a promised callback?",
        frequency: "day",
        answer_type: "yes_no",
        expected: "no",
      },
      at("2026-11-02", "09:00"),
    );
    const week = await save(
      {
        title: "Complaint",
        question: "Did a customer complain?",
        frequency: "week",
        answer_type: "yes_no",
        expected: "no",
      },
      at("2026-11-02", "09:00"),
    );
    const answer = (d, answers) =>
      one("select public.kpi_submit($1,$2,$3::jsonb,'t',$4)", [
        ali,
        d,
        JSON.stringify(answers),
        at(d, "17:00"),
      ]);
    await answer("2026-11-02", [
      { kpi_id: day.id, answer: false },
      { kpi_id: week.id, answer: true },
    ]);
    await answer("2026-11-03", [
      { kpi_id: day.id, answer: true },
      { kpi_id: week.id, answer: false },
    ]);
    const f = await facts("2026-11-02", "2026-11-08", at("2026-11-09"));
    expect(item(agentDay(f, ali, "2026-11-02"), day.id)).toMatchObject({
      answer: false,
      met: true,
      expected: "no",
    });
    expect(item(agentDay(f, ali, "2026-11-03"), day.id).met).toBe(false);
    // The week is met once a day had the expected answer.
    const r = kpiReport(f, "2026-11-02", "2026-11-08");
    expect(cell(r, ali, week.id).weekly.weeks[0]).toMatchObject({
      total: 1,
      status: "met",
    });
    expect(r.kpis.find((x) => x.id === week.id).expected).toBe("no");
    // Switched to expect Yes from tomorrow, recorded with the change.
    expect(
      (await save({ expected: "yes" }, at("2026-11-04"), day.id)).rules_from,
    ).toBe("2026-11-05");
  });

  it("is for administrators only, and agents never change what the CRM fills in", async () => {
    const k = await measuredKpi("Inventory", "day", "number", 1, "inventory");
    for (const [method, path, body] of [
      ["patch", `/kpis/${k}`, { target: 3 }],
      [
        "post",
        "/kpis",
        { title: "x", question: "y?", frequency: "day", answer_type: "yes_no" },
      ],
      ["post", `/kpis/${k}/archive`, { archived: true }],
      ["get", "/kpis/manage"],
    ])
      expect((await send(ali, method, path, body)).status, path).toBe(403);
    await expect(
      save({ target: 3 }, at("2026-11-04"), k, ali),
    ).rejects.toThrow();
    await expect(
      one("select public.kpi_submit($1,$2,$3::jsonb,'t',$4)", [
        ali,
        "2026-11-04",
        JSON.stringify([{ kpi_id: k, answer: 5 }]),
        at("2026-11-04", "17:00"),
      ]),
    ).rejects.toThrow("filled in by the CRM");
    // Invalid values never reach the database.
    for (const body of [
      { target: 0 },
      { target: 10001 },
      { target: 2.5 },
      { expected: "maybe" },
      { frequency: "month" },
    ])
      expect((await send(admin, "patch", `/kpis/${k}`, body)).status).toBe(400);
    expect((await versions(k)).length).toBe(1);
  });
});
