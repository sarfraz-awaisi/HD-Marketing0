import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 088: Never assigned leaves out the leads whose latest saved call
// outcome shows an agent working on them, in its rows, counts, pages, Select
// all and Assign to agents, and filters by any of the other outcomes. All
// leads is unchanged.
const admin = "88000000-0000-4000-8000-000000000001",
  abru = "88000000-0000-4000-8000-000000000002",
  alisha = "88000000-0000-4000-8000-000000000003";
const working = [
  "Interested",
  "Follow-up required",
  "Site visit scheduled",
  "Deal discussion",
  "Closed lost",
];
const others = [
  "No answer",
  "Busy",
  "Wrong number",
  "Number off",
  "Not interested",
];
const migration = new URL(
  "../../supabase/migrations/088_never_assigned_outcomes.sql",
  import.meta.url,
);
const m084 = new URL(
  "../../supabase/migrations/084_admin_never_assigned.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-assigned-outcomes-088.sql",
  import.meta.url,
);
let t,
  phone = 0;
const app = () => createApp(trustedMfaFixture(t.db));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (path, status = 200) =>
  request(app()).get(path).set(as(admin)).expect(status);
const list = async (query = {}, status = 200) =>
  (await get("/api/leads/all?" + new URLSearchParams(query), status)).body;
const never = (query = {}, status) =>
  list({ reassignable: "true", ...query }, status);
const selection = async (query) =>
  (
    await get("/api/leads/all/selection?" + new URLSearchParams(query))
  ).body.ids.sort();
const ids = (body) => body.data.map((l) => l.id).sort();
const sorted = (a) => [...a].sort();
async function leads(n) {
  const made = (
    await t.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||($3::int+i)),'+92304'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  return made;
}
const move = (leadIds, agent) =>
  t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
    leadIds,
    admin,
    agent,
  ]);
// A call with this outcome, minutes ago (later calls: fewer minutes).
const call = (lead, outcome, minutes = 10) => {
  const answered = !others.slice(0, 4).includes(outcome);
  return t.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    admin,
    JSON.stringify({
      answered,
      started_at: new Date(Date.now() - minutes * 60000).toISOString(),
      duration_seconds: answered ? 60 : 0,
      outcome,
      notes: "Called",
      deal_tags: [],
    }),
  ]);
};
const distribute = (path, body) =>
  request(app())
    .post("/api/leads/distribute" + path)
    .set(as(admin))
    .send({ never_assigned: true, ...body });
const owner = async (lead) =>
  (
    await t.one(
      "select coalesce(p.name,'none') n from leads l left join profiles p on p.id=l.assigned_agent where l.id=$1",
      [lead],
    )
  ).n;

describe("Never assigned by the latest saved call outcome (update 088)", () => {
  // w: one lead per working outcome; o: one per other outcome; none: no
  // call; later: Interested, then No answer; pending: Interested, then a
  // call with no outcome saved yet; plain: 20 more with no call.
  let w, o, none, later, pending, plain, eligible;
  beforeAll(async () => {
    t = await startCrmDatabase();
  }, 60000);
  afterAll(async () => {
    await t?.pg.close();
  });
  beforeEach(async () => {
    await resetPeople(t.pg, [admin, abru, alisha]);
    await t.pg.query(
      "update profiles set active=true,role='agent',name=case id when $1 then 'Abru' else 'Alisha' end where id=any($2::uuid[])",
      [abru, [abru, alisha]],
    );
    const made = await leads(13);
    w = made.slice(0, 5);
    o = made.slice(5, 10);
    [none, later, pending] = made.slice(10);
    plain = await leads(20);
    for (const [i, lead] of w.entries()) await call(lead, working[i]);
    for (const [i, lead] of o.entries()) await call(lead, others[i]);
    await call(later, "Interested", 30);
    await call(later, "No answer", 5);
    await call(pending, "Interested", 30);
    await t.pg.query(
      "insert into calls(lead_id,agent_id,started_at) values($1,$2,now()-interval '1 minute')",
      [pending, admin],
    );
    eligible = sorted([...o, none, later, ...plain]);
  });

  it("leaves the five working outcomes out of rows, counts, pages and Select all; leads with no outcome stay", async () => {
    await move([o[0], none], abru);
    const page1 = await never();
    expect(page1.count).toBe(27);
    expect(page1.totals).toEqual({ total: 27, assigned: 2, unassigned: 25 });
    const page2 = await never({ page: 2 });
    const shown = sorted([...ids(page1), ...ids(page2)]);
    expect(shown).toEqual(eligible);
    expect(await selection({ reassignable: "true" })).toEqual(eligible);
    const top = await selection({ reassignable: "true", first: 5 });
    expect(top).toHaveLength(5);
    expect(top.every((id) => eligible.includes(id))).toBe(true);
    // With agents chosen too, whatever the client asks.
    const withAlisha = await list({ never_assigned: alisha });
    expect(withAlisha.count).toBe(27);
    expect([...w, pending].some((id) => ids(withAlisha).includes(id))).toBe(
      false,
    );
    expect(
      (await list({ never_assigned: alisha, outcome: "Interested" })).count,
    ).toBe(0);
  });

  it("outcomes: any of those chosen, with one agent or several; none chosen is every eligible lead", async () => {
    expect(ids(await never({ outcomes: "No answer,Busy" }))).toEqual(
      sorted([o[0], o[1], later]),
    );
    expect(ids(await never({ outcomes: "Not interested" }))).toEqual([o[4]]);
    expect((await never({ outcomes: others.join(",") })).count).toBe(6);
    await move([o[0]], abru);
    await move([later], alisha);
    const one = await never({
      never_assigned: abru,
      outcomes: "No answer,Busy",
    });
    expect(ids(one)).toEqual(sorted([o[1], later]));
    expect(one.totals).toEqual({ total: 2, assigned: 1, unassigned: 1 });
    expect(
      ids(
        await never({
          never_assigned: `${abru},${alisha}`,
          outcomes: "No answer,Busy",
        }),
      ),
    ).toEqual([o[1]]);
    expect(
      await selection({
        reassignable: "true",
        never_assigned: `${abru},${alisha}`,
        outcomes: "No answer,Busy",
      }),
    ).toEqual([o[1]]);
    // None chosen again: every eligible lead.
    expect((await never()).count).toBe(27);
    // Only the five others, once each, and not with outcome.
    for (const query of [
      { outcomes: "Interested" },
      { outcomes: "Busy,Busy" },
      { outcomes: "" },
      { outcomes: "Busy", outcome: "Busy" },
      { reassignable: "yes" },
    ])
      await never(query, 400);
    await expect(
      t.pg.query("select admin_lead_list($1,$2)", [
        admin,
        { reassignable: true, outcomes: ["Closed lost"] },
      ]),
    ).rejects.toThrow("Choose valid lead filters");
  });

  it("All leads is unchanged", async () => {
    const all = await list();
    expect(all.count).toBe(33);
    expect(ids(await list({ outcome: "Interested" }))).toEqual([w[0]]);
    expect(ids(await list({ outcome: "Closed lost" }))).toEqual([w[4]]);
    expect((await selection({})).length).toBe(33);
  });

  it("Assign to agents keeps leads an agent is working on, checked again when confirmed", async () => {
    const plan = (
      await distribute("/preview", {
        lead_ids: [o[0], w[0], w[4], none],
        agent_ids: [abru],
      }).expect(200)
    ).body;
    expect(plan).toMatchObject({ assigned: 2, kept: 2, failed: 0 });
    expect(
      plan.results
        .filter((r) => r.result === "kept")
        .map((r) => r.reason)
        .sort(),
    ).toEqual([
      "Latest call outcome is Closed lost: stays unassigned",
      "Latest call outcome is Interested: stays unassigned",
    ]);
    // An outcome saved after the preview: nothing moves, a new plan.
    const before = (
      await distribute("/preview", {
        lead_ids: [o[1], none],
        agent_ids: [abru],
      }).expect(200)
    ).body;
    expect(before).toMatchObject({ assigned: 2, kept: 0 });
    await call(o[1], "Deal discussion", 1);
    const stale = (
      await distribute("", {
        lead_ids: [o[1], none],
        agent_ids: [abru],
        token: before.token,
      }).expect(200)
    ).body;
    expect(stale).toMatchObject({ applied: false, stale: true, kept: 1 });
    expect([await owner(o[1]), await owner(none)]).toEqual(["none", "none"]);
    const done = (
      await distribute("", {
        lead_ids: [o[1], none],
        agent_ids: [abru],
        token: stale.token,
      }).expect(200)
    ).body;
    expect(done).toMatchObject({ applied: true, assigned: 1, kept: 1 });
    expect([await owner(o[1]), await owner(none)]).toEqual(["none", "Abru"]);
    // Any change of the latest saved outcome, the stage unchanged, also
    // needs a new preview.
    const status = async () =>
      (await t.one("select status from leads where id=$1", [o[2]])).status;
    const was = await status();
    const plan2 = (
      await distribute("/preview", { lead_ids: [o[2]], agent_ids: [abru] })
    ).body;
    await call(o[2], "No answer", 1);
    expect(await status()).toBe(was);
    expect(
      (
        await distribute("", {
          lead_ids: [o[2]],
          agent_ids: [abru],
          token: plan2.token,
        }).expect(200)
      ).body,
    ).toMatchObject({ applied: false, stale: true, assigned: 1 });
    expect(await owner(o[2])).toBe("none");
  });
});

describe("update 088 on a database at 087, as production is", () => {
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "088" });
    await resetPeople(t.pg, [admin, abru, alisha]);
    const [a] = await leads(2);
    await call(a, "Interested");
  }, 120000);
  afterAll(async () => {
    await t?.pg.close();
  });
  const fns = async () =>
    (
      await t.one(
        "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure))||md5(pg_get_functiondef('public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure)) f",
      )
    ).f;
  const check = async () => t.one(await readFile(checkFile, "utf8"));

  it("asks for 088 first, applies once, reruns as a no-op and refuses before 087", async () => {
    expect((await never({}, 503)).error).toBe(
      "Never Worked needs CRM database update 088 after 087.",
    );
    expect((await list()).count).toBe(2);
    expect(await check()).toMatchObject({
      release_stage: "at 087, ready for 088",
      edits_fit: true,
      active_leads: 2,
      left_out: 1,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 088",
      edits_fit: null,
      left_out: 1,
    });
    expect((await never()).count).toBe(1);
    const after = await fns();
    await t.pg.exec(sql);
    expect(await fns()).toBe(after);
    // Update 084 now stops with its own message and changes nothing.
    await expect(t.pg.exec(await readFile(m084, "utf8"))).rejects.toThrow(
      "Update 084 found an unexpected version of admin_lead_list",
    );
    await t.pg.exec("rollback");
    expect(await fns()).toBe(after);
    const at086 = await startCrmDatabase({ before: "087" });
    try {
      await expect(at086.pg.exec(sql)).rejects.toThrow(
        "Apply CRM updates up to 087 before update 088.",
      );
    } finally {
      await at086.pg.close();
    }
  }, 180000);
});
