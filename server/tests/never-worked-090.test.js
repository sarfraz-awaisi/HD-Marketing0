import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 090: Never Worked. Assigned but Never Called lists the leads whose
// current agent has saved no call outcome on them since receiving them, and
// Assign to agents there and in Never Assigned to Selected Agent takes as
// many leads as asked from each current agent (unassigned leads as a group
// of their own), newest first. Calls go through the real call log, so who
// logged each one is recorded as in production.
const admin = "90000000-0000-4000-8000-000000000001",
  shiza = "90000000-0000-4000-8000-000000000002",
  azhar = "90000000-0000-4000-8000-000000000003",
  alisha = "90000000-0000-4000-8000-000000000004",
  owais = "90000000-0000-4000-8000-000000000005";
const migration = new URL(
  "../../supabase/migrations/090_never_worked.sql",
  import.meta.url,
);
const m088 = new URL(
  "../../supabase/migrations/088_never_assigned_outcomes.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-worked-090.sql",
  import.meta.url,
);
const others = [
  "No answer",
  "Busy",
  "Wrong number",
  "Number off",
  "Not interested",
];
let t,
  phone = 0;
async function people(pg) {
  await resetPeople(pg, [admin, shiza, azhar]);
  for (const [id, email] of [
    [alisha, "alisha@gmail.com"],
    [owais, "owais@gmail.com"],
  ])
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()) on conflict do nothing",
      [id, email],
    );
  await pg.query(
    "update profiles set active=true,role='agent',name=case id when $1 then 'Shiza' when $2 then 'Azhar' when $3 then 'Alisha' when $4 then 'Owais' end where id=any($5::uuid[])",
    [shiza, azhar, alisha, owais, [shiza, azhar, alisha, owais]],
  );
}
const app = () => createApp(trustedMfaFixture(t.db));
const as = (user) => ({ Authorization: "Bearer " + user });
// n new leads (in HD-number order), given to an agent (none: unassigned).
async function leads(n, agent = null) {
  const ids = (
    await t.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||($3::int+i)),'+92305'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  if (agent) await move(ids, agent);
  return ids;
}
async function move(ids, agent) {
  for (let i = 0; i < ids.length; i += 500)
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      ids.slice(i, i + 500),
      admin,
      agent,
    ]);
}
// Calls saved with their outcomes through the call log, by an agent or an
// administrator, one statement for many leads (outcomes in turn).
const call = (leadIds, by, outcomes = ["No answer"]) =>
  t.pg.query(
    `select log_manual_call(x.id,$2,jsonb_build_object('answered',o.v not in ('No answer','Busy','Wrong number','Number off'),
      'started_at',now()-interval '10 minutes','duration_seconds',case when o.v in ('No answer','Busy','Wrong number','Number off') then 0 else 60 end,
      'outcome',o.v,'notes','Called','deal_tags','[]'::jsonb),'t')
     from unnest($1::uuid[]) with ordinality x(id,n)
     cross join lateral (select ($3::text[])[1+((x.n-1)%cardinality($3::text[]))::int] v) o`,
    [[leadIds].flat(), by, outcomes],
  );
const list = async (query = {}, user = admin, status = 200) =>
  (
    await request(app())
      .get("/api/leads/all?" + new URLSearchParams(query))
      .set(as(user))
      .expect(status)
  ).body;
const uncalled = (agents, extra = {}) =>
  list({
    reassignable: "true",
    agent_uncalled: "true",
    ...(agents ? { agent: agents.join(",") } : {}),
    ...extra,
  });
const selected = async (query) =>
  (
    await request(app())
      .get("/api/leads/all/selection?" + new URLSearchParams(query))
      .set(as(admin))
      .expect(200)
  ).body.ids.sort();
const ids = (body) => body.data.map((l) => l.id).sort();
const sorted = (a) => [...a].sort();
const distribute = (path, body, user = admin) =>
  request(app())
    .post("/api/leads/distribute" + path)
    .set(as(user))
    .send({ never_assigned: true, ...body });
const preview = async (body) =>
  (await distribute("/preview", body).expect(200)).body;
const confirm = async (body) => (await distribute("", body).expect(200)).body;
const owners = async (leadIds) =>
  (
    await t.all(
      "select coalesce(p.name,'none') agent from unnest($1::uuid[]) with ordinality x(id,n) join leads l on l.id=x.id left join profiles p on p.id=l.assigned_agent order by x.n",
      [leadIds],
    )
  ).map((r) => r.agent);
const moved = (plan) =>
  sorted(
    plan.results
      .filter((r) => ["assigned", "reassigned"].includes(r.result))
      .map((r) => r.id),
  );

describe("Never Worked (update 090)", () => {
  beforeAll(async () => {
    t = await startCrmDatabase();
  }, 60000);
  afterAll(async () => {
    await t?.pg.close();
  });
  beforeEach(async () => {
    await people(t.pg);
  });

  it("600 assigned to Shiza, 450 called by her: 150 Assigned but Never Called, paged and selected exactly; 510 taken in parts of 500", async () => {
    const all = await leads(600, shiza);
    const worked = all.slice(0, 450);
    await call(worked, shiza, others);
    // Repeated calls to one lead count once; a dial with no outcome saved
    // does not count.
    await call(worked.slice(0, 50), shiza, ["Busy"]);
    await t.pg.query(
      "insert into calls(lead_id,agent_id,started_at) select x,$2,now() from unnest($1::uuid[]) x",
      [all.slice(450, 470), shiza],
    );
    const rest = sorted(all.slice(450));
    const first = await uncalled([shiza]);
    expect(first.count).toBe(150);
    const last = await uncalled([shiza], { page: 8 });
    expect(last.data).toHaveLength(10);
    expect(
      await selected({
        reassignable: "true",
        agent_uncalled: "true",
        agent: shiza,
      }),
    ).toEqual(rest);
    // Never Assigned to Selected Agent is unchanged: all 600 were never
    // Owais's. Taking 510 of them moves exactly the newest 510, in parts.
    expect(
      (await list({ reassignable: "true", never_assigned: owais })).count,
    ).toBe(600);
    const body = {
      lead_ids: all,
      agent_ids: [owais],
      quotas: [{ from: shiza, take: 510 }],
    };
    const plan = await preview(body);
    expect(plan).toMatchObject({ reassigned: 510, over: false });
    expect(plan.sources).toEqual([
      { id: shiza, name: "Shiza", available: 600, take: 510 },
    ]);
    const newest = sorted(all.slice(90));
    expect(moved(plan)).toEqual(newest);
    const done = await confirm({ ...body, token: plan.token });
    expect(done).toMatchObject({ applied: true, reassigned: 510 });
    expect(done.partial).toBeUndefined();
    const now = await owners(all);
    expect(now.slice(0, 90).every((n) => n === "Shiza")).toBe(true);
    expect(now.slice(90).every((n) => n === "Owais")).toBe(true);
  }, 180000);

  it("counts only saved outcomes of the current agent since receiving the lead; leaves out Won, Lost and leads an agent is working on", async () => {
    const [noAnswer, busy, dialled, byAdmin, earlier, again, plain] =
      await leads(7, shiza);
    await call(noAnswer, shiza, ["No answer"]);
    await call(busy, shiza, ["Busy"]);
    await t.pg.query(
      "insert into calls(lead_id,agent_id,started_at) values($1,$2,now())",
      [dialled, shiza],
    );
    // An administrator's call does not count for the agent.
    await call(byAdmin, admin, ["Not interested"]);
    // The earlier agent's calls do not count for the current agent.
    const [fromAzhar] = await leads(1, azhar);
    await call(fromAzhar, azhar, ["Busy"]);
    await move([fromAzhar], shiza);
    // A new assignment starts a new window, even back to the same agent.
    await call(earlier, shiza, ["No answer"]);
    await move([earlier], azhar);
    await move([earlier], shiza);
    await call(again, shiza, ["Number off"]);
    // Working outcomes, Won and deleted leads are left out.
    const [working, won, gone] = await leads(3, shiza);
    await call(working, admin, ["Interested"]);
    await t.pg.query("update leads set status='won' where id=$1", [won]);
    await t.pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const mine = sorted([dialled, byAdmin, fromAzhar, earlier, plain]);
    expect(ids(await uncalled([shiza]))).toEqual(mine);
    // Several current agents: their uncalled leads together; none chosen:
    // every agent's.
    const [azhars] = await leads(1, azhar);
    expect(ids(await uncalled([shiza, azhar]))).toEqual(
      sorted([...mine, azhars]),
    );
    const any = await uncalled(null);
    expect(ids(any)).toEqual(sorted([...mine, azhars]));
    expect(any.totals).toEqual({ total: 6, assigned: 6, unassigned: 0 });
    // The call outcome filter still applies, to the latest saved outcome.
    expect(
      ids(await uncalled([shiza], { outcomes: "Not interested" })),
    ).toEqual([byAdmin]);
    // Not with Never assigned's agents, a first-call filter or Unassigned.
    for (const extra of [
      { never_assigned: azhar },
      { call: "never_called" },
      { assignment: "unassigned" },
      { agent_uncalled: "yes" },
    ])
      await list(
        { reassignable: "true", agent_uncalled: "true", ...extra },
        admin,
        400,
      );
    // All leads' Never called (anyone's call, update 083) is unchanged.
    expect(ids(await list({ call: "never_called", agent: shiza }))).toEqual(
      sorted([dialled, plain]),
    );
  });

  it("takes as many as asked from each current agent and unassigned leads, newest first; 0 or none takes nothing; above what a group can give takes nothing", async () => {
    const s = await leads(5, shiza);
    const z = await leads(4, azhar);
    const u = await leads(3);
    const [a] = await leads(1, alisha);
    // s[0] had Owais before; z[3] is being worked on.
    await move([s[0]], owais);
    await move([s[0]], shiza);
    await call(z[3], azhar, ["Interested"]);
    const all = [...s, ...z, ...u, a];
    const ask = (quotas, agents = [owais]) => ({
      lead_ids: all,
      agent_ids: agents,
      quotas,
    });
    const none = await preview(ask([]));
    expect(none).toMatchObject({
      assigned: 0,
      reassigned: 0,
      kept: 2,
      over: false,
    });
    expect(none.sources).toEqual([
      { id: shiza, name: "Shiza", available: 4, take: 0 },
      { id: azhar, name: "Azhar", available: 3, take: 0 },
      { id: alisha, name: "Alisha", available: 1, take: 0 },
      { id: null, name: "Unassigned leads", available: 3, take: 0 },
    ]);
    expect(none.results.map((r) => [r.id, r.result, r.reason]).sort()).toEqual(
      [
        [s[0], "kept", "Assigned to Owais before: stays with Shiza"],
        [z[3], "kept", "Latest call outcome is Interested: stays with Azhar"],
      ].sort(),
    );
    // Zero is none, the same as leaving a group out.
    const one = await preview(
      ask([
        { from: shiza, take: 0 },
        { from: azhar, take: 1 },
      ]),
    );
    expect(moved(one)).toEqual([z[2]]);
    const quotas = [
      { from: shiza, take: 2 },
      { from: azhar, take: 1 },
      { from: null, take: 2 },
    ];
    const plan = await preview(ask(quotas));
    expect(plan).toMatchObject({ assigned: 2, reassigned: 3, over: false });
    const taken = sorted([s[4], s[3], z[2], u[2], u[1]]);
    expect(moved(plan)).toEqual(taken);
    expect(plan.sources.map((x) => [x.name, x.available, x.take])).toEqual([
      ["Shiza", 4, 2],
      ["Azhar", 3, 1],
      ["Alisha", 1, 0],
      ["Unassigned leads", 3, 2],
    ]);
    // The same numbers give the same plan.
    expect((await preview(ask(quotas))).token).toBe(plan.token);
    // More than a group can give, or a number for a group with nothing to
    // give: nothing is taken, and confirming moves nothing.
    const over = await preview(
      ask([{ from: alisha, take: 2 }, ...quotas.slice(1)]),
    );
    expect(over).toMatchObject({ over: true, assigned: 0, reassigned: 0 });
    expect(over.sources.find((x) => x.id === alisha)).toEqual({
      id: alisha,
      name: "Alisha",
      available: 1,
      take: 2,
    });
    expect(
      await confirm({ ...ask([{ from: alisha, take: 2 }]), token: over.token }),
    ).toMatchObject({ applied: false, assigned: 0, reassigned: 0 });
    const absent = await preview(ask([{ from: owais, take: 1 }]));
    expect(absent.over).toBe(true);
    expect(absent.sources.find((x) => x.id === owais)).toEqual({
      id: owais,
      name: null,
      available: 0,
      take: 1,
    });
    const before = await owners(all);
    expect(before.filter((n) => n === "Owais")).toEqual([]);
    // Confirmed: exactly the leads previewed move, the rest stay.
    const done = await confirm({ ...ask(quotas), token: plan.token });
    expect(done).toMatchObject({ applied: true, assigned: 2, reassigned: 3 });
    expect(done.sources.map((x) => x.take)).toEqual([2, 1, 0, 2]);
    const after = await owners(all);
    all.forEach((id, i) =>
      expect(after[i]).toBe(taken.includes(id) ? "Owais" : before[i]),
    );
    expect(
      (
        await t.one(
          "select count(*)::int n from audit_log where action='lead.bulk_distributed' and metadata->>'never_assigned'='true'",
        )
      ).n,
    ).toBe(1);
    // Sent twice: the second finds the plan changed and moves nothing.
    const twice = await confirm({ ...ask(quotas), token: plan.token });
    expect(twice).toMatchObject({ applied: false, stale: true });
    expect(await owners(all)).toEqual(after);
    // Several receivers: each lead only to a chosen agent it never had.
    const shared = await preview(
      ask(
        [
          { from: alisha, take: 1 },
          { from: null, take: 1 },
        ],
        [alisha, owais],
      ),
    );
    expect(moved(shared)).toEqual(sorted([a, u[0]]));
    expect(shared.results.find((r) => r.id === a).agent).toBe(owais);
    expect(shared.results.find((r) => r.id === u[0]).agent).toBe(alisha);
  });

  it("refuses numbers that are not whole, repeated, or outside Never Worked", async () => {
    const [lead] = await leads(1, shiza);
    for (const body of [
      { quotas: [{ from: shiza, take: -1 }] },
      { quotas: [{ from: shiza, take: 1.5 }] },
      { quotas: [{ from: shiza, take: "2" }] },
      {
        quotas: [
          { from: shiza, take: 1 },
          { from: shiza, take: 1 },
        ],
      },
      { quotas: [{ from: "someone", take: 1 }] },
      { quotas: [{ from: shiza, take: 1, extra: true }] },
      { never_assigned: false, quotas: [] },
      { never_assigned: false, uncalled: true },
    ])
      await distribute("/preview", {
        lead_ids: [lead],
        agent_ids: [owais],
        ...body,
      }).expect(400);
    expect(await owners([lead])).toEqual(["Shiza"]);
  });

  it("confirming checks again: a lead called meanwhile, moved meanwhile, given again, marked Won, or new numbers move nothing, and the new plan comes back", async () => {
    // Azhar's leads, called by him (No answer), now Shiza's, not called by
    // her.
    const x = await leads(3, azhar);
    await call(x, azhar, ["No answer"]);
    await move(x, shiza);
    const body = {
      lead_ids: x,
      agent_ids: [owais],
      uncalled: true,
      quotas: [{ from: shiza, take: 2 }],
    };
    const plan = await preview(body);
    expect(moved(plan)).toEqual(sorted([x[2], x[1]]));
    // Shiza saves the same outcome the lead already had.
    await call(x[2], shiza, ["No answer"]);
    const stale = await confirm({ ...body, token: plan.token });
    expect(stale).toMatchObject({ applied: false, stale: true, reassigned: 2 });
    expect(await owners(x)).toEqual(["Shiza", "Shiza", "Shiza"]);
    expect(stale.sources).toEqual([
      { id: shiza, name: "Shiza", available: 2, take: 2 },
    ]);
    expect(stale.results.find((r) => r.id === x[2])).toMatchObject({
      result: "kept",
      reason: "Called by Shiza since receiving it: stays with Shiza",
    });
    expect(moved(stale)).toEqual(sorted([x[1], x[0]]));
    const done = await confirm({ ...body, token: stale.token });
    expect(done).toMatchObject({ applied: true, reassigned: 2 });
    expect(await owners(x)).toEqual(["Owais", "Owais", "Shiza"]);

    // Moved to another agent meanwhile: its group changes.
    const y = await leads(2, shiza);
    const ask = (take, extra = {}) => ({
      lead_ids: y,
      agent_ids: [owais],
      quotas: [{ from: shiza, take }],
      ...extra,
    });
    const p1 = await preview(ask(2));
    await move([y[0]], azhar);
    const s1 = await confirm({ ...ask(2), token: p1.token });
    expect(s1).toMatchObject({ applied: false, stale: true, over: true });
    expect(await owners(y)).toEqual(["Azhar", "Shiza"]);
    // Given again to the same agent meanwhile (a new assignment).
    const p2 = await preview(ask(1));
    await request(app())
      .post("/api/leads/assign-bulk")
      .set(as(admin))
      .send({ lead_ids: [y[1]], mode: "unassign" })
      .expect(200);
    await move([y[1]], shiza);
    expect(await confirm({ ...ask(1), token: p2.token })).toMatchObject({
      applied: false,
      stale: true,
    });
    expect(await owners(y)).toEqual(["Azhar", "Shiza"]);
    // A number changed after the preview.
    const p3 = await preview(ask(0));
    expect(await confirm({ ...ask(1), token: p3.token })).toMatchObject({
      applied: false,
      stale: true,
      reassigned: 1,
    });
    // Marked Won after the preview.
    const p4 = await preview(ask(1));
    await t.pg.query("update leads set status='won' where id=$1", [y[1]]);
    const s4 = await confirm({ ...ask(1), token: p4.token });
    expect(s4).toMatchObject({ applied: false, stale: true, over: true });
    expect(await owners(y)).toEqual(["Azhar", "Shiza"]);
  });

  it("is for administrators only, in the server and the database", async () => {
    const [lead] = await leads(1, shiza);
    const body = {
      lead_ids: [lead],
      agent_ids: [owais],
      uncalled: true,
      quotas: [{ from: shiza, take: 1 }],
    };
    for (const path of ["/preview", ""])
      await distribute(path, body, shiza).expect(403);
    await request(app())
      .post("/api/leads/distribute/preview")
      .send({ never_assigned: true, ...body })
      .expect(401);
    await list({ reassignable: "true", agent_uncalled: "true" }, shiza, 403);
    await expect(
      t.pg.query(
        "select admin_distribute_agent_uncalled($1,$2,$3,false,null,'t')",
        [shiza, [lead], [owais]],
      ),
    ).rejects.toThrow();
    expect(await owners([lead])).toEqual(["Shiza"]);
  });
});

describe("update 090 on a database at 089, as production is", () => {
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "090" });
    await people(t.pg);
    const [a] = await leads(2, shiza);
    await call(a, shiza, ["Busy"]);
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

  it("asks for 090 first, applies once, reruns as a no-op (088 too) and refuses before 089", async () => {
    const leadIds = (await t.all("select id from leads order by lead_no")).map(
      (r) => r.id,
    );
    expect(
      (await list({ reassignable: "true", agent_uncalled: "true" }, admin, 503))
        .error,
    ).toBe("Never Worked needs CRM database update 090 after 089.");
    const body = {
      lead_ids: leadIds,
      agent_ids: [owais],
      quotas: [{ from: shiza, take: 1 }],
    };
    expect((await distribute("/preview", body).expect(503)).body.error).toBe(
      "Never Worked needs CRM database update 090 after 089.",
    );
    expect(
      (await distribute("/preview", { ...body, uncalled: true }).expect(503))
        .body.error,
    ).toBe("This feature needs CRM database update 090 after 089.");
    // Without numbers, Never assigned works as before.
    expect(
      await preview({ lead_ids: leadIds, agent_ids: [owais] }),
    ).toMatchObject({ reassigned: 2 });
    expect(await check()).toMatchObject({
      release_stage: "at 089, ready for 090",
      edits_fit: true,
      active_leads: 2,
      assigned_uncalled: 1,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 090",
      edits_fit: null,
      assigned_uncalled: 1,
    });
    expect(
      (await list({ reassignable: "true", agent_uncalled: "true" })).count,
    ).toBe(1);
    expect((await preview(body)).sources).toEqual([
      { id: shiza, name: "Shiza", available: 2, take: 1 },
    ]);
    const after = await fns();
    await t.pg.exec(sql);
    expect(await fns()).toBe(after);
    await t.pg.exec(await readFile(m088, "utf8"));
    expect(await fns()).toBe(after);
    const at088 = await startCrmDatabase({ before: "089" });
    try {
      await expect(at088.pg.exec(sql)).rejects.toThrow(
        "Apply CRM updates up to 089 before update 090.",
      );
    } finally {
      await at088.pg.close();
    }
  }, 180000);
});
