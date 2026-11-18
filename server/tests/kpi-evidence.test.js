import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  agentDay,
  kpiReport,
  pkToday,
  weekStart,
} from "../src/services/kpis.js";
import { evidenceLink } from "../src/services/kpiEvidence.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 072: KPIs the CRM fills in, against every migration. Assigned calls
// come from the leads' first-call deadlines and the agent's calls; social
// links, visit photos and videos count once an administrator approves them;
// inventory counts an agent's listings verified with the owner's details on
// the day they were added. Only Supabase Storage is replaced, by an
// in-memory bucket. Fixed times are passed to the SQL functions (p_now);
// calls use the real clock, as the call log only takes recent calls.
const admin = "72000000-0000-4000-8000-000000000001",
  ali = "72000000-0000-4000-8000-000000000002",
  sara = "72000000-0000-4000-8000-000000000003";
let pg, db, one, all, files, uploads, phone;
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
    "update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])",
    [[admin, ali, sara]],
  );
  files = new Map();
  uploads = [];
});
const bucket = {
  upload: async (path, body) => {
    uploads.push(path);
    files.set(path, body);
    return { data: { path } };
  },
  remove: async (paths) => {
    for (const path of paths) files.delete(path);
    return { data: [] };
  },
  createSignedUrl: async (path) => ({
    data: { signedUrl: `https://storage.test/${path}?token=t` },
  }),
};
const app = () =>
  createApp(trustedMfaFixture({ ...db, storage: { from: () => bucket } }));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (user, path) =>
  request(app())
    .get("/api" + path)
    .set(as(user));
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
const at = (day, time = "10:00") => `${day}T${time}:00+05:00`;
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const save = async (data, now, id = null) =>
  (
    await one("select public.kpi_save($1,$2,$3::jsonb,'t',$4) r", [
      admin,
      id,
      JSON.stringify(data),
      now,
    ])
  ).r;
const facts = async (from, to, now = new Date().toISOString()) =>
  (
    await one("select public.kpi_facts($1,$2,$3,null,$4) r", [
      admin,
      from,
      to,
      now,
    ])
  ).r;
const dayOf = async (agent, day, now) =>
  agentDay(await facts(day, day, now), agent, day);
const item = (day, kpi) => day.kpis.find((i) => i.id === kpi);
const cell = (r, agent, kpi) =>
  r.agents.find((a) => a.id === agent)?.cells[kpi];
// The five KPIs as update 072 measures them, from Monday 26 October 2026.
async function measuredKpis(now = at("2026-10-26", "09:00")) {
  const make = async (title, frequency, answer_type, target, measure) => {
    const k = await save(
      {
        title,
        question: `${title}?`,
        frequency,
        answer_type,
        ...(answer_type === "number" ? { target } : {}),
      },
      now,
    );
    await pg.query("update kpi_versions set measure=$2 where kpi_id=$1", [
      k.id,
      measure,
    ]);
    return k.id;
  };
  return {
    calls: await make("Assigned calls answered", "day", "yes_no", 1, "calls"),
    social: await make("Social media activity", "day", "yes_no", 1, "social"),
    visits: await make("Project visits", "week", "number", 3, "visits"),
    inventory: await make(
      "Verified inventory",
      "day",
      "number",
      1,
      "inventory",
    ),
    video: await make("HD Marketing video", "week", "number", 1, "video"),
  };
}
const addLink = (agent, kind, url, now) =>
  one("select public.kpi_evidence_add($1,$2::jsonb,'t',$3) r", [
    agent,
    JSON.stringify({ kind, ...evidenceLink(url) }),
    now,
  ]).then((x) => x.r);
const hash = (n) => String(n).padStart(64, "0");
const addPhoto = (agent, project, visit_date, now, n) =>
  one("select public.kpi_evidence_add($1,$2::jsonb,'t',$3) r", [
    agent,
    JSON.stringify({
      kind: "visit",
      project,
      visit_date,
      storage_path: `${agent}/${randomUUID()}`,
      file_hash: hash(n),
      mime_type: "image/png",
      size_bytes: 100,
    }),
    now,
  ]).then((x) => x.r);
const review = (id, status, reason = null, actor = admin) =>
  one("select public.kpi_evidence_review($1,$2,$3,$4,'t') r", [
    actor,
    id,
    status,
    reason,
  ]).then((x) => x.r);

// Leads and calls on the real clock: assigned some hours ago, with the
// first-call deadline moved to a chosen time.
async function newLead(name, owner) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+92300072" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
async function holding(lead, agent, assignedAgo, dueAgo) {
  const assigned = iso(Date.now() - assignedAgo * H),
    due = Date.now() - dueAgo * H;
  await pg.query(
    "update leads set assigned_at=$2,call_due_at=$3 where id=$1 and assigned_agent=$4",
    [lead, assigned, iso(due), agent],
  );
  await pg.query(
    "update assignments set created_at=$3,call_due_at=$4 where id=(select id from assignments where lead_id=$1 and agent_id=$2 order by created_at desc,id desc limit 1)",
    [lead, agent, assigned, iso(due)],
  );
  return pkToday(due);
}
async function dueLead(name, agent, assignedAgo = 5, dueAgo = 1) {
  const id = await newLead(name, agent);
  return { id, day: await holding(id, agent, assignedAgo, dueAgo) };
}
const call = (lead, actor, outcome, minutesAgo) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: !["No answer", "Busy", "Wrong number", "Number off"].includes(
        outcome,
      ),
      started_at: iso(Date.now() - minutesAgo * 60000),
      duration_seconds: 60,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);

describe("assigned calls, filled in by the CRM (update 072)", () => {
  it("says Yes only when every lead due that day got the agent's first call by its deadline, whatever the outcome", async () => {
    const k = await measuredKpis();
    // Ali: three leads due an hour ago. One answered at the second try, one
    // busy, one not called.
    const a1 = await dueLead("Two tries", ali);
    const a2 = await dueLead("Busy line", ali);
    const a3 = await dueLead("Never called", ali);
    await call(a1.id, ali, "No answer", 180);
    await call(a1.id, ali, "Interested", 150);
    await call(a2.id, ali, "Busy", 120);
    let day = await dayOf(ali, a1.day);
    expect(item(day, k.calls)).toMatchObject({
      measure: "calls",
      editable: false,
      answer: false,
      met: false,
      state: "answered",
      detail: {
        due: 3,
        on_time: 2,
        late: 0,
        not_called: 1,
        waiting: 0,
        attempts: 3,
        answered: 1,
      },
    });
    // A call after the deadline is late: still No.
    await call(a3.id, ali, "Not interested", 2);
    day = await dayOf(ali, a1.day);
    expect(item(day, k.calls)).toMatchObject({
      answer: false,
      detail: { due: 3, on_time: 2, late: 1, not_called: 0, attempts: 3 },
    });
    // Sara: both leads called on time, neither a conversation: Yes.
    const s1 = await dueLead("Wrong number", sara);
    const s2 = await dueLead("No answer", sara);
    await call(s1.id, sara, "Wrong number", 120);
    await call(s2.id, sara, "No answer", 100);
    day = await dayOf(sara, s1.day);
    expect(item(day, k.calls)).toMatchObject({
      answer: true,
      met: true,
      detail: { due: 2, on_time: 2, answered: 0, attempts: 2 },
    });
    // The same leads, as Team performance counts missed deadlines.
    const r = kpiReport(await facts(a1.day, a1.day), a1.day, a1.day);
    expect(cell(r, ali, k.calls).daily).toMatchObject({
      days: 1,
      met: 0,
      below: 1,
      detail: { due: 3, late: 1 },
    });
    expect(cell(r, sara, k.calls).daily).toMatchObject({ days: 1, met: 1 });
  });

  it("is pending while a deadline is ahead, and a day with nothing due is not missed", async () => {
    const k = await measuredKpis();
    const ahead = await dueLead("Due later", ali, 1, -2);
    const day = await dayOf(ali, ahead.day);
    expect(item(day, k.calls)).toMatchObject({
      answer: null,
      met: null,
      state: "pending",
      detail: { due: 1, waiting: 1, not_called: 1 },
    });
    // Monday 2 and Tuesday 3 November: no first call was due.
    const quiet = await facts("2026-11-02", "2026-11-03");
    expect(item(agentDay(quiet, ali, "2026-11-03"), k.calls)).toMatchObject({
      answer: null,
      state: "not_due",
      detail: null,
    });
    const r = kpiReport(quiet, "2026-11-02", "2026-11-03");
    expect(cell(r, ali, k.calls).daily).toMatchObject({
      days: 0,
      not_due: 2,
      missed: 0,
    });
  });

  it("gives a lead's call to the agent holding it at the deadline; an administrator's call does not count", async () => {
    const k = await measuredKpis();
    // Ali had it from 5 hours ago; Sara from 3 hours ago, due 30 minutes ago.
    const moved = await dueLead("Moved", ali);
    await pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [moved.id],
      admin,
      sara,
    ]);
    const sarasDay = await holding(moved.id, sara, 3, 0.5);
    await call(moved.id, sara, "Follow-up required", 60);
    // An administrator calls one of Ali's leads.
    const helped = await dueLead("Helped", ali);
    await call(helped.id, admin, "Interested", 120);
    const aliDay = await dayOf(ali, moved.day);
    expect(item(aliDay, k.calls)).toMatchObject({
      answer: false,
      detail: { due: 1, on_time: 0, not_called: 1, attempts: 0 },
    });
    expect(item(await dayOf(sara, sarasDay), k.calls)).toMatchObject({
      answer: true,
      detail: { due: 1, on_time: 1, answered: 1 },
    });
  });
});

describe("social media links (update 072)", () => {
  it("takes 1 to 5 links a day and says Yes once an administrator approves one", async () => {
    const k = await measuredKpis();
    const mon = "2026-11-02";
    const first = await addLink(
      ali,
      "social",
      "https://www.facebook.com/hd/posts/1",
      at(mon, "10:00"),
    );
    expect(first).toMatchObject({
      kind: "social",
      day: mon,
      platform: "facebook",
      status: "pending",
      reviewed_by: null,
    });
    // Pending: not Yes yet, waiting for review.
    expect(
      item(await dayOf(ali, mon, at(mon, "12:00")), k.social),
    ).toMatchObject({
      answer: null,
      met: null,
      state: "review",
      detail: { submitted: 1, pending: 1 },
    });
    await review(first.id, "approved");
    expect(
      item(await dayOf(ali, mon, at(mon, "12:00")), k.social),
    ).toMatchObject({ answer: true, met: true, detail: { approved: 1 } });
    // Tuesday: two links, both rejected; Wednesday nothing; Thursday five.
    const tue = await Promise.all(
      ["https://instagram.com/p/A1", "https://www.tiktok.com/@hd/video/7"].map(
        (u) => addLink(ali, "social", u, at("2026-11-03")),
      ),
    );
    for (const e of tue) await review(e.id, "rejected", "Not our page");
    for (const n of [1, 2, 3, 4, 5])
      await addLink(
        ali,
        "social",
        `https://youtu.be/abcdef${n}`,
        at("2026-11-05", `1${n}:00`),
      );
    await expect(
      addLink(ali, "social", "https://youtu.be/abcdef6", at("2026-11-05")),
    ).rejects.toThrow("up to 5 social media links a day");
    // The same link again that day is refused, in another form too.
    await expect(
      addLink(
        sara,
        "social",
        "https://facebook.com/hd/posts/9",
        at("2026-11-05"),
      ).then(() =>
        addLink(
          sara,
          "social",
          "https://m.facebook.com/hd/posts/9/?fbclid=x",
          at("2026-11-05"),
        ),
      ),
    ).rejects.toThrow("already added");
    const r = kpiReport(
      await facts("2026-11-02", "2026-11-05", at("2026-11-06")),
      "2026-11-02",
      "2026-11-05",
    );
    expect(cell(r, ali, k.social).daily).toMatchObject({
      days: 4,
      met: 1,
      below: 1,
      missed: 1,
      review: 1,
      detail: { submitted: 8, approved: 1, rejected: 2, pending: 5 },
    });
    // Every link and decision is in the audit log, with who decided.
    const log = await all(
      "select action,actor_id from audit_log where entity='kpi_evidence' order by id",
    );
    expect(log.filter((l) => l.action === "kpi.evidence_added")).toHaveLength(
      9,
    );
    expect(log.filter((l) => l.action !== "kpi.evidence_added")).toEqual([
      { action: "kpi.evidence_approved", actor_id: admin },
      { action: "kpi.evidence_rejected", actor_id: admin },
      { action: "kpi.evidence_rejected", actor_id: admin },
    ]);
  });

  it("lets agents add and see only their own links, and only administrators review them", async () => {
    const k = await measuredKpis();
    const added = await send(ali, "post", "/kpis/evidence", {
      kind: "social",
      url: "www.facebook.com/hdmarketing/posts/123",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      url: "https://www.facebook.com/hdmarketing/posts/123",
      status: "pending",
    });
    // Unsafe or unsupported links are refused.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://evil.example/facebook.com/x",
      "https://facebook.com.evil.example/x",
      "https://user:pass@facebook.com/x",
      "https://facebook.com/",
      "ftp://youtube.com/watch?v=abcdefg",
    ])
      expect(
        (await send(ali, "post", "/kpis/evidence", { kind: "social", url }))
          .status,
        url,
      ).toBe(400);
    expect(
      (
        await send(admin, "post", "/kpis/evidence", {
          kind: "social",
          url: "https://facebook.com/x/1",
        })
      ).status,
    ).toBe(403);
    await send(sara, "post", "/kpis/evidence", {
      kind: "social",
      url: "https://instagram.com/p/Sara1",
    }).expect(201);
    // The same link again, in another form: refused in words.
    const again = await send(ali, "post", "/kpis/evidence", {
      kind: "social",
      url: "https://m.facebook.com/hdmarketing/posts/123/?fbclid=x",
    });
    expect([again.status, again.body.error]).toEqual([
      409,
      "This link was already added",
    ]);
    // Agents: only their own; never another agent's.
    const mine = await get(ali, "/kpis/evidence").expect(200);
    expect(mine.body.data.map((e) => e.agent.id)).toEqual([ali]);
    expect((await get(ali, `/kpis/evidence?agent=${sara}`)).status).toBe(403);
    expect((await get(admin, "/kpis/evidence?status=pending")).body.count).toBe(
      2,
    );
    // Agents cannot review, their own or anyone's.
    expect(
      (
        await send(ali, "post", `/kpis/evidence/${added.body.id}/review`, {
          status: "approved",
        })
      ).status,
    ).toBe(403);
    const rejected = await send(
      admin,
      "post",
      `/kpis/evidence/${added.body.id}/review`,
      { status: "rejected", reason: "Link is private" },
    ).expect(200);
    expect(rejected.body).toMatchObject({
      status: "rejected",
      reason: "Link is private",
      reviewed_by: { id: admin, name: "Owner" },
    });
    expect(rejected.body.reviewed_at).toBeTruthy();
    // The agent sees the decision on My KPIs; the CRM fills the KPI in.
    const my = await get(ali, "/kpis/my").expect(200);
    expect(item(my.body, k.social)).toMatchObject({ editable: false });
    expect(my.body.evidence.map((e) => [e.status, e.reason])).toEqual([
      ["rejected", "Link is private"],
    ]);
    // A decision can be changed; both stay in the audit log.
    await send(admin, "post", `/kpis/evidence/${added.body.id}/review`, {
      status: "approved",
    }).expect(200);
    expect(
      (
        await all(
          "select action,metadata->>'before' b from audit_log where entity_id=$1 and action like 'kpi.evidence_%' order by id",
          [added.body.id],
        )
      ).map((x) => [x.action, x.b]),
    ).toEqual([
      ["kpi.evidence_added", null],
      ["kpi.evidence_rejected", "pending"],
      ["kpi.evidence_approved", "rejected"],
    ]);
  });
});

describe("verified inventory, from the CRM's listings (update 072)", () => {
  const house = (extra = {}) => ({
    title: "Corner house",
    type: "House",
    purpose: "sale",
    price: 25000000,
    area: 10,
    area_unit: "marla",
    city: "Lahore",
    area_society: "DHA Phase 6",
    ...extra,
  });
  const create = async (user, extra) => {
    const res = await send(user, "post", "/properties", house(extra));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const verify = (id, status, reason, user = admin) =>
    send(user, "post", `/kpis/inventory/${id}/review`, { status, reason });

  it("counts listings verified with the owner's name and phone on the day they were added, also when verified later", async () => {
    const k = await measuredKpis();
    const owner = { owner_name: "Mr Khan", owner_phone: "0300 1234567" };
    const full = await create(ali, { owner_contact: owner });
    const noPhone = await create(ali, {
      owner_contact: { owner_name: "Mr Butt" },
    });
    const today = await create(ali, { owner_contact: owner });
    // The first two were added yesterday.
    const yesterday = pkToday(Date.now() - 24 * H);
    await pg.query(
      "update properties set created_at=created_at-interval '1 day' where id=any($1::uuid[])",
      [[full.id, noPhone.id]],
    );
    // Never the owner's contact in the KPI list.
    const list = await get(admin, `/kpis/inventory?agent=${ali}`).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/1234567|Mr Khan/);
    expect(
      list.body.data.map((p) => [p.id, p.status, p.owner_details]),
    ).toEqual([
      [today.id, "pending", true],
      [noPhone.id, "pending", false],
      [full.id, "pending", true],
    ]);
    // Verifying needs the owner's details; verified later, it counts for
    // the day the listing was added.
    expect((await verify(noPhone.id, "verified")).status).toBe(400);
    await verify(full.id, "verified").expect(200);
    await verify(today.id, "rejected", "Price missing").expect(200);
    let day = await dayOf(ali, yesterday);
    expect(item(day, k.inventory)).toMatchObject({
      answer: 1,
      met: true,
      detail: { uploaded: 2, verified: 1, pending: 1, rejected: 0 },
    });
    day = await dayOf(ali, pkToday());
    expect(item(day, k.inventory)).toMatchObject({
      answer: 0,
      met: null,
      state: "pending",
      detail: { uploaded: 1, verified: 0, rejected: 1 },
    });
    // Editing a listing does not count it again.
    await send(ali, "patch", `/properties/${today.id}`, {
      title: "Corner house, renovated",
    }).expect(200);
    expect(item(await dayOf(ali, pkToday()), k.inventory).detail.uploaded).toBe(
      1,
    );
    // A decision can be reversed; the audit log keeps every one.
    await verify(full.id, "pending").expect(200);
    expect(item(await dayOf(ali, yesterday), k.inventory)).toMatchObject({
      answer: 0,
      state: "review",
    });
    expect(
      (
        await all(
          "select action,metadata->>'before' b,actor_id from audit_log where entity='properties' and action like 'inventory.%' and entity_id=$1 order by id",
          [full.id],
        )
      ).map((x) => [x.action, x.b, x.actor_id]),
    ).toEqual([
      ["inventory.verified", null, admin],
      ["inventory.verification_cleared", "verified", admin],
    ]);
  });

  it("lets only administrators verify, only agents' listings, and agents see only their own", async () => {
    await measuredKpis();
    const mine = await create(ali, {});
    await create(sara, {});
    const company = await create(admin, {});
    expect((await verify(mine.id, "rejected", null, ali)).status).toBe(403);
    expect((await verify(company.id, "rejected")).status).toBe(404);
    const list = await get(ali, "/kpis/inventory").expect(200);
    expect(list.body.data.map((p) => p.id)).toEqual([mine.id]);
    expect((await get(ali, `/kpis/inventory?agent=${sara}`)).status).toBe(403);
    expect((await get(admin, "/kpis/inventory")).body.count).toBe(2);
  });
});

describe("project visit photos (update 072)", () => {
  const png = (n) =>
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([n]),
      Buffer.alloc(16),
    ]);
  const upload = (user, file, fields, type = "image/png") =>
    request(app())
      .post("/api/kpis/evidence/photo")
      .set(as(user))
      .field(fields)
      .attach("file", file, { filename: "visit.png", contentType: type });

  it("counts distinct approved project-and-date visits over the week, approved late too", async () => {
    const k = await measuredKpis();
    const now = at("2026-11-04", "18:00");
    const photos = [
      await addPhoto(ali, "DHA Phase 6", "2026-11-02", now, 1),
      await addPhoto(ali, "DHA Phase 6", "2026-11-02", now, 2),
      await addPhoto(ali, "Bahria Town", "2026-11-03", now, 3),
      await addPhoto(ali, "dha  phase 6", "2026-11-04", now, 4),
    ];
    // The same image file again, by anyone, is refused.
    await expect(
      addPhoto(sara, "Gulberg", "2026-11-04", now, 3),
    ).rejects.toThrow("already uploaded");
    // A visit date outside this week, or ahead of today, is refused.
    for (const d of ["2026-11-01", "2026-11-05"])
      await expect(addPhoto(ali, "Gulberg", d, now, 9)).rejects.toThrow(
        "this week, up to today",
      );
    // Nothing approved yet; the week ended with photos waiting: review.
    const later = at("2026-11-10");
    let r = kpiReport(
      await facts("2026-11-02", "2026-11-08", later),
      "2026-11-02",
      "2026-11-08",
    );
    expect(cell(r, ali, k.visits).weekly.weeks[0]).toMatchObject({
      total: 0,
      status: "review",
      detail: { submitted: 4, pending: 4 },
    });
    // Approved after the week: two photos of one visit count once.
    for (const p of photos) await review(p.id, "approved");
    r = kpiReport(
      await facts("2026-11-02", "2026-11-08", later),
      "2026-11-02",
      "2026-11-08",
    );
    expect(cell(r, ali, k.visits).weekly).toMatchObject({
      met: 1,
      weeks: [{ start: "2026-11-02", total: 3, target: 3, status: "met" }],
    });
    await review(photos[2].id, "rejected", "Not a project photo");
    r = kpiReport(
      await facts("2026-11-02", "2026-11-08", later),
      "2026-11-02",
      "2026-11-08",
    );
    expect(cell(r, ali, k.visits).weekly.weeks[0]).toMatchObject({
      total: 2,
      status: "missed",
    });
  });

  it("keeps photos private, checks the file and removes a refused upload", async () => {
    await measuredKpis();
    const today = pkToday();
    const fields = { project: "DHA Phase 6", visit_date: today };
    const res = await upload(ali, png(1), fields);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      kind: "visit",
      project: "DHA Phase 6",
      day: today,
      has_photo: true,
      status: "pending",
    });
    expect(JSON.stringify(res.body)).not.toContain("storage_path");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].startsWith(ali + "/")).toBe(true);
    // Only its agent and administrators get a (short-lived) link.
    const path = `/kpis/evidence/${res.body.id}/photo`;
    expect((await get(ali, path).expect(200)).body.url).toContain(uploads[0]);
    expect((await get(admin, path).expect(200)).body.url).toBeTruthy();
    expect((await get(sara, path)).status).toBe(404);
    // The same file again: refused, and its copy removed from Storage.
    const again = await upload(ali, png(1), fields);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("This photo was already uploaded");
    expect(uploads).toHaveLength(2);
    expect(files.has(uploads[1])).toBe(false);
    // A visit date ahead of today: refused and removed too.
    const ahead = await upload(ali, png(2), {
      ...fields,
      visit_date: "2099-01-04",
    });
    expect(ahead.status).toBe(400);
    expect(files.size).toBe(1);
    // Not an image, a GIF, a mislabelled file, too large, or no project.
    const gif = Buffer.from("GIF89a" + "x".repeat(20));
    for (const [file, type, extra] of [
      [Buffer.from("hello, not a picture"), "image/png", {}],
      [gif, "image/gif", {}],
      [png(3), "image/jpeg", {}],
      [png(4), "image/png", { project: "" }],
    ])
      expect(
        (await upload(ali, file, { ...fields, ...extra }, type)).status,
      ).toBe(400);
    const big = Buffer.concat([png(5), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(ali, big, fields)).status).toBe(413);
    expect(files.size).toBe(1);
    // Administrators review but never upload.
    expect((await upload(admin, png(6), fields)).status).toBe(403);
  });
});

describe("HD Marketing videos (update 072)", () => {
  it("counts approved videos in the week they were added, Pakistan time, and refuses the same video twice", async () => {
    const k = await measuredKpis();
    // Sunday 8 November 23:30 and Monday 9 November 00:10, Pakistan time.
    const sunday = await addLink(
      ali,
      "video",
      "https://www.youtube.com/watch?v=hdvideo01",
      at("2026-11-08", "23:30"),
    );
    const monday = await addLink(
      ali,
      "video",
      "https://www.tiktok.com/@hd/video/1",
      at("2026-11-09", "00:10"),
    );
    const second = await addLink(
      ali,
      "video",
      "https://www.instagram.com/reel/XYZ",
      at("2026-11-09", "12:00"),
    );
    expect([sunday.week, monday.week]).toEqual(["2026-11-02", "2026-11-09"]);
    // The same video in another form, by anyone, is refused.
    await expect(
      addLink(sara, "video", "https://youtu.be/hdvideo01", at("2026-11-10")),
    ).rejects.toThrow("already added");
    await review(sunday.id, "approved");
    await review(monday.id, "rejected", "Not finished");
    const r = kpiReport(
      await facts("2026-11-02", "2026-11-15", at("2026-11-11")),
      "2026-11-02",
      "2026-11-15",
    );
    expect(
      cell(r, ali, k.video).weekly.weeks.map((w) => [
        w.start,
        w.total,
        w.status,
        w.detail,
      ]),
    ).toEqual([
      [
        "2026-11-02",
        1,
        "met",
        { submitted: 1, pending: 0, approved: 1, rejected: 0, visits: 0 },
      ],
      [
        "2026-11-09",
        0,
        "in_progress",
        { submitted: 2, pending: 1, approved: 0, rejected: 1, visits: 0 },
      ],
    ]);
    await review(second.id, "approved");
    const week = agentDay(
      await facts("2026-11-11", "2026-11-11", at("2026-11-11")),
      ali,
      "2026-11-11",
    );
    expect(item(week, k.video).week).toMatchObject({
      total: 1,
      status: "met",
      measure: "video",
    });
  });
});

describe("history and rules (update 072)", () => {
  it("keeps earlier answers, refuses answers for KPIs the CRM fills in, and keeps the measure through rule changes", async () => {
    const make = (title, frequency, answer_type, target) =>
      save(
        {
          title,
          question: `${title}?`,
          frequency,
          answer_type,
          ...(answer_type === "number" ? { target } : {}),
        },
        at("2026-10-26", "09:00"),
      ).then((x) => x.id);
    const social = await make("Social media activity", "day", "yes_no", 1);
    const inventory = await make("Verified inventory", "day", "number", 1);
    // Ali answered for himself on Monday 2 November.
    await one("select public.kpi_submit($1,$2,$3::jsonb,'t',$4)", [
      ali,
      "2026-11-02",
      JSON.stringify([
        { kpi_id: social, answer: true },
        { kpi_id: inventory, answer: 2 },
      ]),
      at("2026-11-02", "17:00"),
    ]);
    // From Wednesday 4 November the CRM fills both in.
    await pg.query(
      "insert into kpi_versions(kpi_id,version,effective_from,frequency,answer_type,target,measure) values($1,2,'2026-11-04','day','yes_no',1,'social'),($2,2,'2026-11-04','day','number',1,'inventory')",
      [social, inventory],
    );
    const f = await facts("2026-11-02", "2026-11-04", at("2026-11-05"));
    expect(item(agentDay(f, ali, "2026-11-02"), social)).toMatchObject({
      measure: "self",
      answer: true,
      met: true,
    });
    expect(item(agentDay(f, ali, "2026-11-02"), inventory).answer).toBe(2);
    expect(item(agentDay(f, ali, "2026-11-04"), social)).toMatchObject({
      measure: "social",
      answer: null,
      state: "missed",
    });
    await expect(
      one("select public.kpi_submit($1,$2,$3::jsonb,'t',$4)", [
        ali,
        "2026-11-04",
        JSON.stringify([{ kpi_id: social, answer: true }]),
        at("2026-11-04", "17:00"),
      ]),
    ).rejects.toThrow("filled in by the CRM");
    // Its frequency and answer type stay; other rules change as before
    // (from the next day) and keep the measure.
    await expect(
      save({ answer_type: "number", target: 2 }, at("2026-11-05"), social),
    ).rejects.toThrow("filled in by the CRM");
    await save({ target: 2 }, at("2026-11-05"), inventory);
    // Saving the same rules with a new title changes nothing else.
    await save(
      {
        title: "Verified listings",
        frequency: "day",
        answer_type: "number",
        target: 2,
        active: true,
      },
      at("2026-11-05", "11:00"),
      inventory,
    );
    expect(
      (
        await all(
          "select version,effective_from::text e,target,measure from kpi_versions where kpi_id=$1 order by version",
          [inventory],
        )
      ).map((v) => [v.version, v.e, v.target, v.measure]),
    ).toEqual([
      [1, "2026-10-26", 1, "self"],
      [2, "2026-11-04", 1, "inventory"],
      [3, "2026-11-06", 2, "inventory"],
    ]);
  });
});

// Week boundaries in the services: a Sunday belongs to the week before.
it("starts weeks on Monday", () => {
  expect(weekStart("2026-11-08")).toBe("2026-11-02");
  expect(weekStart("2026-11-09")).toBe("2026-11-09");
});
