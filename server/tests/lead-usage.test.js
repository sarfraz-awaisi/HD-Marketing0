import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 075: Lead Usage on administrators' All leads, and each lead's agent
// history. A lead's usage is the number of different agents it has been
// assigned to, by account ID: the admin team is no agent, an agent given the
// lead again is not counted again, and a former agent still counts. The
// choices are exact (Used 3 times is 3 agents, never 4), follow every other
// filter and leave out Deleted leads. The history shows each assignment
// period with what was saved in it and who recorded it. Administrators only,
// in the server and the database.
const admin = "75000000-0000-4000-8000-000000000001",
  ali = "75000000-0000-4000-8000-000000000002",
  sara = "75000000-0000-4000-8000-000000000003",
  usman = "75000000-0000-4000-8000-000000000004",
  hina = "75000000-0000-4000-8000-000000000005",
  zain = "75000000-0000-4000-8000-000000000006",
  nida = "75000000-0000-4000-8000-000000000007",
  staff = "75000000-0000-4000-8000-000000000008";
const extra = [
  [usman, "Usman Agent", "agent"],
  [hina, "Hina Agent", "agent"],
  [zain, "Zain Agent", "agent"],
  [nida, "Nida Agent", "agent"],
  [staff, "Sam Staff", "staff"],
];
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
let phone = 0;
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  for (const [id, name, role] of extra) {
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [id, name.split(" ")[0].toLowerCase() + "@gmail.com"],
    );
    await pg.query(
      "update profiles set active=true,role=$3,name=$2 where id=$1",
      [id, name, role],
    );
  }
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
async function newLead(name, data = {}) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...data }),
      "+92300075" + String(phone++).padStart(4, "0"),
      admin,
    ])
  ).id;
}
// Each step: an agent, or null for the admin team (no agent).
async function route(lead, ...steps) {
  for (const agent of steps)
    await pg.query("select handover_lead($1,$2,$3,'t')", [lead, admin, agent]);
}
const unanswered = ["No answer", "Busy", "Wrong number", "Number off"];
// A call logged as the server logs it, so the audit log names the caller.
const call = (lead, actor, outcome, tags = [], notes) =>
  pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: !unanswered.includes(outcome),
      started_at: new Date(Date.now() - 60000).toISOString(),
      duration_seconds: unanswered.includes(outcome) ? 0 : 75,
      outcome,
      ...(notes ? { notes } : {}),
      deal_tags: tags,
    }),
  ]);
const mutate = (table, data, actor) =>
  pg.query("select crm_mutate($1,null,$2::jsonb,$3,'t')", [
    table,
    JSON.stringify(data),
    actor,
  ]);
const list = async (query = {}, user = admin) =>
  (
    await request(app())
      .get("/api/leads/all?" + new URLSearchParams(query))
      .set(as(user))
      .expect(200)
  ).body;
const names = (body) => body.data.map((l) => l.name).sort();
const history = async (lead, user = admin, status = 200) =>
  (
    await request(app())
      .get(`/api/leads/${lead}/agent-history`)
      .set(as(user))
      .expect(status)
  ).body;

describe("Lead Usage on All leads (update 075)", () => {
  it("counts each lead's different agents exactly, by account, never the admin team or a repeat", async () => {
    const lead = {};
    for (const [name, ...steps] of [
      ["Once", ali],
      ["Two agents", ali, sara],
      ["Three agents", ali, sara, usman],
      ["Four agents", ali, sara, usman, hina],
      ["Five agents", ali, sara, usman, hina, zain],
      ["Six agents", ali, sara, usman, hina, zain, nida],
      // A, then B, then A again: 2.
      ["Back to Ali", ali, sara, ali],
      // A, then the admin team, then B: 2.
      ["Through the admin team", ali, null, sara],
      // One agent five times over, with the admin team between: 1.
      ["Ali again and again", ali, null, ali, null, ali],
    ]) {
      lead[name] = await newLead(name);
      await route(lead[name], ...steps);
    }
    lead.Never = await newLead("Never");
    const body = await list();
    expect(body.usage).toEqual({ all: 10, 2: 3, 3: 1, 4: 1, 5: 1 });
    expect(
      Object.fromEntries(body.data.map((l) => [l.name, l.agents_used])),
    ).toEqual({
      Once: 1,
      "Two agents": 2,
      "Three agents": 3,
      "Four agents": 4,
      "Five agents": 5,
      "Six agents": 6,
      "Back to Ali": 2,
      "Through the admin team": 2,
      "Ali again and again": 1,
      Never: 0,
    });
    const shown = {};
    for (const usage of [2, 3, 4, 5]) {
      const found = await list({ usage });
      shown[usage] = names(found);
      // Exactly that many: the count, the page and the usage choice agree.
      expect(found.count).toBe(body.usage[usage]);
      expect(found.totals.total).toBe(body.usage[usage]);
      expect(found.data.every((l) => l.agents_used === usage)).toBe(true);
    }
    expect(shown).toEqual({
      2: ["Back to Ali", "Through the admin team", "Two agents"],
      3: ["Three agents"],
      4: ["Four agents"],
      5: ["Five agents"],
    });
    // A disabled agent still counts, by account, not by name.
    await pg.query("update profiles set active=false where id=$1", [usman]);
    await pg.query("update profiles set name='Sara Renamed' where id=$1", [
      sara,
    ]);
    expect(names(await list({ usage: 3 }))).toEqual(["Three agents"]);
    expect((await list()).usage).toEqual({ all: 10, 2: 3, 3: 1, 4: 1, 5: 1 });
    // A new assignment changes the counts at once.
    await route(lead.Once, sara);
    expect((await list()).usage).toMatchObject({ 2: 4 });
  });

  it("follows every other filter, leaves out Deleted leads, keeps a restored lead's history and pages across all matches", async () => {
    const paged = [];
    for (let i = 1; i <= 23; i++) {
      const id = await newLead(`Paged buyer ${String(i).padStart(2, "0")}`);
      await route(id, ali, sara);
      paged.push(id);
    }
    const kept = await newLead("Kept by Ali");
    await route(kept, ali);
    const whatsapp = await newLead("WhatsApp buyer", { source: "WhatsApp" });
    await route(whatsapp, sara, ali);
    // Imported from a file, then moved: used 2 times.
    const imported = await one(
      "select import_leads('Expo visitors.csv','csv',null,$1::jsonb,$2,'t') r",
      [
        JSON.stringify([
          { row: 2, phone: "+923001759001", data: { name: "File buyer" } },
        ]),
        admin,
      ],
    );
    expect(imported.r).toBeTruthy();
    const file = await one(
      "select l.id lead,l.import_id from leads l where l.name='File buyer'",
    );
    await route(file.lead, hina, zain);

    expect((await list()).usage).toEqual({ all: 26, 2: 25, 3: 0, 4: 0, 5: 0 });
    // Pages: 23 + 2 matching leads, 20 a page, each once.
    const first = await list({ usage: 2 });
    const second = await list({ usage: 2, page: 2 });
    expect([first.count, first.data.length, second.data.length]).toEqual([
      25, 20, 5,
    ]);
    expect(new Set([...first.data, ...second.data].map((l) => l.id)).size).toBe(
      25,
    );
    expect(first.totals).toEqual({ total: 25, assigned: 25, unassigned: 0 });
    const selection = (
      await request(app())
        .get("/api/leads/all/selection?usage=2")
        .set(as(admin))
        .expect(200)
    ).body.ids;
    expect(selection.length).toBe(25);
    // Search, agent, source, lead file, temperature and outcome.
    expect((await list({ search: "buyer 2" })).usage).toEqual({
      all: 4,
      2: 4,
      3: 0,
      4: 0,
      5: 0,
    });
    expect((await list({ agent: ali })).usage).toMatchObject({ all: 2, 2: 1 });
    expect((await list({ source: "WhatsApp" })).usage).toMatchObject({
      all: 1,
      2: 1,
    });
    expect((await list({ import_id: file.import_id, usage: 2 })).data).toEqual([
      expect.objectContaining({ name: "File buyer", agents_used: 2 }),
    ]);
    await call(paged[0], sara, "Interested", ["Hot lead"]);
    expect((await list({ temperature: "hot" })).usage).toMatchObject({
      all: 1,
      2: 1,
    });
    expect((await list({ outcome: "Interested", usage: 2 })).count).toBe(1);
    expect((await list({ outcome: "Interested", usage: 3 })).count).toBe(0);
    // Deleted leads are not counted; a restored lead keeps its history
    // (with no agent now, as every restore does).
    await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
      [paged[1]],
      admin,
    ]);
    expect((await list({ usage: 2 })).count).toBe(24);
    expect((await list()).usage.all).toBe(25);
    await pg.query("select restore_leads($1,$2,'t')", [[paged[1]], admin]);
    const restored = await list({ usage: 2, assignment: "unassigned" });
    expect(restored.data).toEqual([
      expect.objectContaining({
        id: paged[1],
        agents_used: 2,
        assigned_agent: null,
      }),
    ]);
    expect((await list({ usage: 2 })).totals).toEqual({
      total: 25,
      assigned: 24,
      unassigned: 1,
    });
    // Erased for good: gone from every count.
    await pg.query("select delete_leads($1,$2,'Erase test','t')", [
      [paged[2]],
      admin,
    ]);
    await pg.query("select erase_deleted_leads($1,$2,'t')", [
      [paged[2]],
      admin,
    ]);
    expect((await list()).usage).toMatchObject({ all: 25, 2: 24 });
  });

  it("keeps a lead with more than five agents under All Leads only, with its whole history untouched", async () => {
    const five = await newLead("Five so far");
    await route(five, ali, sara, usman, hina, zain);
    expect((await list({ usage: 5 })).data.map((l) => l.name)).toEqual([
      "Five so far",
    ]);
    // A sixth agent: out of Used 5 Times, still under All Leads.
    await route(five, nida);
    const history = () =>
      one(
        "select md5(coalesce(string_agg(a::text,'|' order by a.created_at,a.id),'')) h,count(*)::int n from assignments a where a.lead_id=$1",
        [five],
      );
    const before = await history();
    const all = await list();
    expect(all.usage).toEqual({ all: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(all.data).toEqual([
      expect.objectContaining({ name: "Five so far", agents_used: 6 }),
    ]);
    expect((await list({ usage: 5 })).count).toBe(0);
    // No choice beyond 5, in the server or the database.
    for (const usage of ["6", "7", "10"])
      await request(app())
        .get("/api/leads/all?usage=" + usage)
        .set(as(admin))
        .expect(400);
    await expect(
      one("select admin_lead_list($1,'{\"usage\":6}'::jsonb)", [admin]),
    ).rejects.toThrow("Choose valid lead filters");
    const agentHistory = async () =>
      (
        await request(app())
          .get(`/api/leads/${five}/agent-history`)
          .set(as(admin))
          .expect(200)
      ).body;
    // Every agent's period stays in its history, in order.
    let h = await agentHistory();
    expect(h.agents_used).toBe(6);
    expect(h.periods.map((p) => p.agent_id)).toEqual([
      ali,
      sara,
      usman,
      hina,
      zain,
      nida,
    ]);
    // Reading the list and the history never changes the assignment rows.
    expect(await history()).toEqual(before);
    expect(before.n).toBe(6);
    // Back to the first agent: a seventh period, still six agents.
    await route(five, ali);
    h = await agentHistory();
    expect([
      h.agents_used,
      h.periods.length,
      h.periods.at(-1).agent_id,
    ]).toEqual([6, 7, ali]);
    expect((await list()).data[0].agents_used).toBe(6);
    expect((await list({ usage: 5 })).count).toBe(0);
  });
});

describe("a lead's agent history (update 075)", () => {
  it("lists each assignment period in order, with what was saved in it and who recorded it", async () => {
    const lead = await newLead("Story buyer", { assigned_agent: ali });
    await call(lead, ali, "No answer");
    await call(
      lead,
      ali,
      "Interested",
      ["Warm lead"],
      "Customer requested the payment plan.",
    );
    await mutate("notes", { lead_id: lead, body: "Prefers Bahria Town." }, ali);
    // An administrator's call: filed under Ali, recorded by the owner.
    await call(
      lead,
      admin,
      "Follow-up required",
      [],
      "Owner checked the budget.",
    );
    await pg.query("select advance_lead_status($1,'negotiation',$2,'t')", [
      lead,
      ali,
    ]);
    await mutate(
      "followups",
      {
        lead_id: lead,
        due_at: new Date(Date.now() + 86400000).toISOString(),
        notes: "Call back about the plan",
      },
      ali,
    );
    // Sara gets it and does nothing; then the admin team; then Usman; then
    // Ali again.
    await route(lead, sara, null, usman);
    await call(
      lead,
      usman,
      "Site visit scheduled",
      ["Hot lead"],
      "Customer requested a site visit.",
    );
    await route(lead, ali);

    const h = await history(lead);
    expect(h.lead).toMatchObject({
      id: lead,
      name: "Story buyer",
      assigned_agent: ali,
    });
    expect(h.agents_used).toBe(3);
    expect(h.current_recorded).toBe(true);
    expect(h.periods.map((p) => [p.kind, p.agent_id, p.end])).toEqual([
      ["agent", ali, "next"],
      ["agent", sara, "next"],
      ["admin_team", null, "next"],
      ["agent", usman, "next"],
      ["agent", ali, "current"],
    ]);
    // Periods meet: each ends when the next starts; the current one has no
    // end yet.
    for (let i = 0; i < h.periods.length - 1; i++)
      expect(h.periods[i].ended_at).toBe(h.periods[i + 1].started_at);
    expect(h.periods.at(-1).ended_at).toBeNull();
    expect(h.periods.every((p) => p.assigned_by === admin)).toBe(true);

    const [first, saraPeriod, adminTeam, usmanPeriod, again] = h.periods;
    // Ali's calls and the owner's, each as recorded.
    expect(
      first.calls.map((c) => [c.outcome, c.recorded_by, c.filed_under]),
    ).toEqual([
      ["No answer", ali, ali],
      ["Interested", ali, ali],
      ["Follow-up required", admin, ali],
    ]);
    expect(first.calls.map((c) => c.connected)).toEqual([false, true, true]);
    expect(first.calls[1].tags).toEqual(["Warm lead"]);
    // Outcomes and comments exactly as saved.
    const saved = await all(
      "select outcome,notes from calls where lead_id=$1 order by created_at",
      [lead],
    );
    expect(
      h.periods
        .flatMap((p) => p.calls)
        .map((c) => ({ outcome: c.outcome, notes: c.notes })),
    ).toEqual(saved);
    expect(first.notes).toEqual([
      expect.objectContaining({
        body: "Prefers Bahria Town.",
        written_by: ali,
      }),
    ]);
    expect(first.status_changes).toContainEqual(
      expect.objectContaining({ to: "negotiation", by: ali }),
    );
    // Ali's follow-up was cancelled when the lead went to Sara (update 067).
    expect(first.followups).toEqual([
      expect.objectContaining({
        notes: "Call back about the plan",
        created_by: ali,
        status: "cancelled",
        cancelled_on_reassignment: true,
      }),
    ]);
    // Sara and the admin team saved nothing.
    for (const p of [saraPeriod, adminTeam])
      for (const kind of [
        "calls",
        "notes",
        "status_changes",
        "followups",
        "visits",
        "deals",
      ])
        expect(p[kind], kind).toEqual([]);
    expect(usmanPeriod.calls).toEqual([
      expect.objectContaining({
        outcome: "Site visit scheduled",
        notes: "Customer requested a site visit.",
        tags: ["Hot lead"],
        recorded_by: usman,
      }),
    ]);
    expect(again.calls).toEqual([]);
    // Every account named, with role; no phone number anywhere.
    expect(h.people[ali]).toMatchObject({ name: "Ali Agent", role: "agent" });
    expect(h.people[admin]).toMatchObject({ name: "Owner", role: "admin" });
    expect(h.people[usman]).toMatchObject({ name: "Usman Agent" });
    const number = (
      await one(
        "select phone from crm_private.lead_phones where lead_id=$1 limit 1",
        [lead],
      )
    ).phone;
    expect(JSON.stringify(h)).not.toContain(number.slice(3));
  });

  it("says when an assignment's end was never recorded, and never guesses it", async () => {
    // Deleted leads removes the agent with no assignment row; a restored
    // lead's last agent therefore has no recorded end.
    const restored = await newLead("Restored buyer");
    await route(restored, ali);
    await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
      [restored],
      admin,
    ]);
    await pg.query("select restore_leads($1,$2,'t')", [[restored], admin]);
    const r = await history(restored);
    expect(r.periods.map((p) => [p.agent_id, p.end, p.ended_at])).toEqual([
      [ali, "not_recorded", null],
    ]);
    expect(r.lead.assigned_agent).toBeNull();
    // Never assigned: only the time before a first assignment.
    const fresh = await history(await newLead("Fresh buyer"));
    expect(fresh.agents_used).toBe(0);
    expect(fresh.periods.map((p) => [p.kind, p.end])).toEqual([
      ["before", "current"],
    ]);
    // Given to the same agent again with no one between: one period.
    const again = await newLead("Again buyer");
    await route(again, ali, ali);
    const a = await history(again);
    expect(a.periods.length).toBe(1);
    expect(a.periods[0].assigned_again).toEqual([
      expect.objectContaining({ by: admin }),
    ]);
    // An administrator's call before any agent: in the time before.
    const early = await newLead("Early buyer");
    await call(early, admin, "Busy");
    await route(early, sara);
    const e = await history(early);
    expect(e.periods.map((p) => [p.kind, p.calls.length])).toEqual([
      ["before", 1],
      ["agent", 0],
    ]);
    expect(e.periods[0].calls[0].recorded_by).toBe(admin);
  });

  it("is for administrators only, in the server and the database", async () => {
    const lead = await newLead("Private buyer", { assigned_agent: ali });
    await route(lead, sara);
    for (const user of [ali, sara, staff]) {
      await history(lead, user, 403);
      await request(app())
        .get("/api/leads/all?usage=2")
        .set(as(user))
        .expect(403);
    }
    const { error } = await db.rpc("admin_lead_agent_history", {
      p_actor: sara,
      p_lead: lead,
    });
    expect(error.code).toBe("42501");
    for (const usage of ["1", "6", "abc", "2.5"])
      await request(app())
        .get("/api/leads/all?usage=" + usage)
        .set(as(admin))
        .expect(400);
    await history("not-a-lead", admin, 400);
    await history("75000000-0000-4000-8000-0000000000ff", admin, 404);
    await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
      [lead],
      admin,
    ]);
    await history(lead, admin, 404);
  });
});
