import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { autoAssignLeads } from "../src/jobs/autoAssignLeads.js";
import { createJobRunner } from "../src/jobs/maintenance.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 091: automatic lead distribution. Administrators set the batch
// size, the agents and their percentages; the worker's job (or Run now)
// shares each complete batch of eligible unassigned leads, oldest first,
// through the usual assignment. Everything below uses synthetic leads.
const admin = "91000000-0000-4000-8000-000000000001",
  abru = "91000000-0000-4000-8000-000000000002",
  shiza = "91000000-0000-4000-8000-000000000003",
  alisha = "91000000-0000-4000-8000-000000000004",
  boss = "91000000-0000-4000-8000-000000000005";
const migration = new URL(
  "../../supabase/migrations/091_auto_assign.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-auto-assign-091.sql",
  import.meta.url,
);
let t,
  phone = 0;
async function people(pg) {
  await resetPeople(pg, [admin, abru, shiza]);
  for (const [id, email] of [
    [alisha, "alisha@gmail.com"],
    [boss, "boss@gmail.com"],
  ])
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()) on conflict do nothing",
      [id, email],
    );
  await pg.query(
    "update profiles set active=true,role='agent',name=case id when $1 then 'Abru' when $2 then 'Shiza' else 'Alisha' end where id=any($3::uuid[])",
    [abru, shiza, [abru, shiza, alisha]],
  );
  await pg.query(
    "update profiles set active=true,role='admin',name='Boss' where id=$1",
    [boss],
  );
}
const app = () => createApp(trustedMfaFixture(t.db));
const as = (user) => ({ Authorization: "Bearer " + user });
const api = (method, path, body, user = admin) =>
  request(app())
    [method]("/api/leads/auto-assign" + path)
    .set(as(user))
    .send(body);
// n leads, oldest first, added `ago` before now (the backlog) or now.
async function leads(n, { ago = "1 day", agent = null } = {}) {
  const ids = (
    await t.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||($3::int+i)),'+92306'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  // In the order made, just before now (minus `ago`).
  await t.pg.query(
    "update leads l set created_at=now()-$2::interval-((cardinality($1::uuid[])-x.n)*interval '1 microsecond') from unnest($1::uuid[]) with ordinality x(id,n) where l.id=x.id",
    [ids, ago],
  );
  if (agent)
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      ids,
      admin,
      agent,
    ]);
  return ids;
}
const owners = async (ids) =>
  (
    await t.all(
      "select coalesce(p.name,'none') n from unnest($1::uuid[]) with ordinality x(id,o) join leads l on l.id=x.id left join profiles p on p.id=l.assigned_agent order by x.o",
      [ids],
    )
  ).map((r) => r.n);
const tally = (names) =>
  names.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {});
const shares = (list) =>
  list.map(([agent_id, percent]) => ({ agent_id, percent }));
const split = shares([
  [abru, 20],
  [shiza, 30],
  [alisha, 50],
]);
const status = async (user = admin) => (await api("get", "").expect(200)).body;
async function save(values, expect = 200) {
  const s = await status();
  return (
    await api("put", "", {
      version: s.version,
      state: "on",
      batch_size: 20,
      scope: "backlog",
      agents: split,
      ...values,
    }).expect(expect)
  ).body;
}
const job = () => autoAssignLeads(t.db);
const plan = async (n, rules) =>
  (await t.one("select auto_assign_plan($1,$2) p", [n, JSON.stringify(rules)]))
    .p;

describe("automatic lead distribution (update 091)", () => {
  beforeAll(async () => {
    t = await startCrmDatabase();
  }, 60000);
  afterAll(async () => {
    await t?.pg.close();
  });
  beforeEach(async () => {
    await people(t.pg);
    // resetPeople empties the accounts with CASCADE, which empties the
    // settings too; the update made its one row, as for crm_settings.
    await t.pg.query(
      "insert into crm_private.auto_assign_settings(id) values(true) on conflict do nothing",
    );
    await t.pg.query(
      "update crm_private.auto_assign_settings set version=0,state='off',batch_size=20,scope='new',active_since=null,updated_by=null,failures=0,last_error=null,last_error_at=null,last_batch_at=null",
    );
    await t.pg.query("delete from crm_private.auto_assign_rules");
    await t.pg.query("delete from crm_private.auto_assign_batches");
    // Each test starts with no unassigned lead waiting.
    await t.pg.query(
      "update leads set deleted_at=now(),deleted_by=$1,delete_reason='Earlier test',deleted_batch=gen_random_uuid() where deleted_at is null and assigned_agent is null",
      [admin],
    );
  });

  it("shares a batch exactly: 20 → 4/6/10, 23 → 5/7/11, one agent takes all, and small batches add up to the percentages", async () => {
    const rules = split.map((r) => ({ ...r }));
    const counts = (p) => p.agents.map((a) => a.count);
    expect(counts(await plan(20, rules))).toEqual([4, 6, 10]);
    expect(counts(await plan(23, rules))).toEqual([5, 7, 11]);
    expect(counts(await plan(7, [{ agent_id: abru, percent: 100 }]))).toEqual([
      7,
    ]);
    // Equal remainders go to the agent listed first.
    expect(
      counts(
        await plan(
          1,
          shares([
            [abru, 50],
            [shiza, 50],
          ]),
        ),
      ),
    ).toEqual([1, 0]);
    // Batches of 3 carry the remainder: after ten, exactly 6/9/15, never
    // a negative count, every batch exactly 3, each agent spread out.
    let carried = rules,
      totals = [0, 0, 0];
    for (let i = 0; i < 10; i++) {
      const p = await plan(3, carried);
      expect(p.agents.reduce((n, a) => n + a.count, 0)).toBe(3);
      expect(p.agents.every((a) => a.count >= 0)).toBe(true);
      totals = totals.map((n, j) => n + p.agents[j].count);
      carried = rules.map((r, j) => ({ ...r, balance: p.agents[j].balance }));
    }
    expect(totals).toEqual([6, 9, 15]);
    // Within a batch the agents take turns.
    const seq = (await plan(20, rules)).sequence;
    expect(seq).toHaveLength(20);
    expect(seq.slice(0, 3).sort()).toEqual([abru, shiza, alisha].sort());
  });

  it("refuses settings that do not add up, in the server and the database; a setting changed meanwhile asks to check again", async () => {
    const s = await status();
    expect(s).toMatchObject({ state: "off", version: 0, rules: [] });
    const base = {
      version: 0,
      state: "on",
      batch_size: 20,
      scope: "new",
      agents: split,
    };
    for (const bad of [
      {
        agents: shares([
          [abru, 20],
          [shiza, 30],
          [alisha, 30],
        ]),
      },
      {
        agents: shares([
          [abru, 20],
          [shiza, 30],
          [alisha, 70],
        ]),
      },
      {
        agents: shares([
          [abru, 0],
          [shiza, 50],
          [alisha, 50],
        ]),
      },
      {
        agents: shares([
          [abru, -10],
          [shiza, 60],
          [alisha, 50],
        ]),
      },
      {
        agents: shares([
          [abru, 33.333],
          [shiza, 33.333],
          [alisha, 33.334],
        ]),
      },
      {
        agents: shares([
          [abru, 50],
          [abru, 50],
        ]),
      },
      { agents: [] },
      { batch_size: 0 },
      { batch_size: -5 },
      { batch_size: 501 },
      { batch_size: 2.5 },
      { scope: "everything" },
      { state: "error" },
    ])
      await api("put", "", { ...base, ...bad }).expect(400);
    // An account that is not an active agent: the database says who.
    const res = await api("put", "", {
      ...base,
      agents: shares([
        [abru, 50],
        [boss, 50],
      ]),
    }).expect(400);
    expect(res.body.error).toBe(
      "Choose valid settings: Not an active agent: Boss",
    );
    // Two decimals that add up exactly are fine.
    const ok = await api("put", "", {
      ...base,
      agents: shares([
        [abru, 33.33],
        [shiza, 33.33],
        [alisha, 33.34],
      ]),
    }).expect(200);
    expect(ok.body).toMatchObject({ version: 1, state: "on" });
    // Another administrator's save in between.
    const stale = await api("put", "", { ...base, version: 0 }).expect(409);
    expect(stale.body.error).toMatch(/^Another administrator changed/);
    // Nothing was assigned by saving.
    expect(
      (
        await t.one(
          "select count(*)::int n from crm_private.auto_assign_batches",
        )
      ).n,
    ).toBe(0);
  });

  it("waits for a complete batch: 12 → nothing, 20 → one batch, 65 → three batches and 5 wait; oldest first; history, audit, deadlines and KPIs as for any assignment", async () => {
    const first = await leads(12);
    await save({ batch_size: 20, scope: "backlog" });
    expect(await job()).toMatchObject({ status: "waiting", waiting: 12 });
    expect(await owners(first)).toEqual(Array(12).fill("none"));
    const more = await leads(8);
    // Through the worker's job runner, which also records its heartbeat.
    await createJobRunner(t.db, [["autoAssignLeads", autoAssignLeads]], {
      log() {},
      error() {},
    })();
    const twenty = [...first, ...more];
    expect(tally(await owners(twenty))).toEqual({
      Abru: 4,
      Shiza: 6,
      Alisha: 10,
    });
    expect(
      await t.one(
        "select last_status from job_heartbeats where job='autoAssignLeads'",
      ),
    ).toEqual({ last_status: "success" });
    const [batch] = await t.all(
      "select id,trigger,status,assigned,allocation,lead_ids from crm_private.auto_assign_batches",
    );
    expect(batch).toMatchObject({
      trigger: "automatic",
      status: "assigned",
      assigned: 20,
    });
    expect(batch.lead_ids.sort()).toEqual([...twenty].sort());
    expect(batch.allocation.map((a) => [a.agent_id, a.count])).toEqual([
      [abru, 4],
      [shiza, 6],
      [alisha, 10],
    ]);
    // The usual assignment: history, one audit entry per lead, the batch's
    // own entry, the first-call deadline, the administrator who saved it.
    const rows = await t.all(
      "select a.actor_id,a.agent_id,l.assigned_at is not null at,l.call_due_at is not null due from assignments a join leads l on l.id=a.lead_id where a.lead_id=any($1)",
      [twenty],
    );
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.actor_id === admin && r.at && r.due)).toBe(true);
    expect(
      (
        await t.one(
          "select count(*)::int n from audit_log where action='assign' and request_id=$1",
          ["job:auto-assign:" + batch.id],
        )
      ).n,
    ).toBe(20);
    expect(
      await t.one(
        "select actor_id,metadata->>'trigger' trigger from audit_log where action='lead.auto_assigned'",
      ),
    ).toEqual({ actor_id: admin, trigger: "automatic" });
    // Daily KPIs count them as assigned, with no call made.
    const kpi = (
      await t.one(
        "select kpi_measures((now() at time zone 'Asia/Karachi')::date,(now() at time zone 'Asia/Karachi')::date,$1,now()) k",
        [alisha],
      )
    ).k;
    expect(kpi[0].call_activity).toEqual({ assigned: 10, completed: 0 });
    expect(
      (
        await t.one("select count(*)::int n from calls where lead_id=any($1)", [
          twenty,
        ])
      ).n,
    ).toBe(0);
    // 65 more: three batches in one run, the newest five wait.
    const next = await leads(65);
    expect(await job()).toMatchObject({ status: "assigned", assigned: 60 });
    const after = await owners(next);
    expect(after.slice(60)).toEqual(Array(5).fill("none"));
    expect(after.slice(0, 60).includes("none")).toBe(false);
    expect(tally(after.slice(0, 60))).toEqual({
      Abru: 12,
      Shiza: 18,
      Alisha: 30,
    });
    expect((await status()).counts).toMatchObject({
      waiting: 5,
      batches: 0,
      leftover: 5,
    });
    expect((await status()).today).toBe(80);
    // A smaller batch from now on: 5 wait, 5 more make a batch of 10.
    await save({ batch_size: 10 });
    expect(await job()).toMatchObject({ status: "waiting", waiting: 5 });
    const last = await leads(5);
    expect(await job()).toMatchObject({ status: "assigned", assigned: 10 });
    expect([
      ...(await owners(next.slice(60))),
      ...(await owners(last)),
    ]).not.toContain("none");
  });

  it("off and paused assign nothing; new leads only leaves the backlog; leads assigned before are never shared again", async () => {
    const backlog = await leads(30);
    await save({ scope: "new" });
    const s = await status();
    expect(s.counts).toMatchObject({
      eligible: 30,
      backlog: 30,
      new: 0,
      waiting: 0,
    });
    expect(await job()).toMatchObject({ status: "waiting", waiting: 0 });
    const fresh = await leads(20, { ago: "0 seconds" });
    expect(await job()).toMatchObject({ status: "assigned", assigned: 20 });
    expect(await owners(backlog)).toEqual(Array(30).fill("none"));
    expect((await owners(fresh)).includes("none")).toBe(false);
    // Paused: nothing; resumed: the waiting batch.
    await api("post", "/state", { state: "paused" }).expect(200);
    const during = await leads(20, { ago: "0 seconds" });
    expect(await job()).toEqual(expect.objectContaining({ status: "paused" }));
    expect(await owners(during)).toEqual(Array(20).fill("none"));
    await api("post", "/state", { state: "on" }).expect(200);
    expect(await job()).toMatchObject({ assigned: 20 });
    // Off, then on again: new leads count from the new start.
    await api("post", "/state", { state: "off" }).expect(200);
    const whileOff = await leads(20, { ago: "0 seconds" });
    expect(await job()).toEqual(expect.objectContaining({ status: "off" }));
    await save({ scope: "new" });
    expect(await job()).toMatchObject({ status: "waiting", waiting: 0 });
    expect(await owners(whileOff)).toEqual(Array(20).fill("none"));
    // A lead that had an agent and lost it is never shared again, even
    // with the backlog included.
    await request(app())
      .post("/api/leads/assign-bulk")
      .set(as(admin))
      .send({ lead_ids: [fresh[0]], mode: "unassign" })
      .expect(200);
    await save({ scope: "backlog", batch_size: 50 });
    expect((await status()).counts.eligible).toBe(50);
    expect(await job()).toMatchObject({ assigned: 50 });
    expect(await owners([fresh[0]])).toEqual(["none"]);
  });

  it("leaves out leads an agent is working on, Won and Lost, deleted and incoming social leads; leads from every source count", async () => {
    const [working, won, gone, social, answered, csv, sheet, manual] =
      await leads(8);
    await t.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      working,
      admin,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 600000).toISOString(),
        duration_seconds: 60,
        outcome: "Interested",
        notes: "Called",
        deal_tags: [],
      }),
    ]);
    await t.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      answered,
      admin,
      JSON.stringify({
        answered: false,
        started_at: new Date(Date.now() - 600000).toISOString(),
        duration_seconds: 0,
        outcome: "No answer",
        notes: "Called",
        deal_tags: [],
      }),
    ]);
    await t.pg.query("update leads set status='won' where id=$1", [won]);
    await t.pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    await t.pg.query(
      "update leads set meta_pending_assignment=true,source='Meta' where id=$1",
      [social],
    );
    await t.pg.query(
      "update leads set source=x.s from (values($1::uuid,'CSV'),($2::uuid,'other'),($3::uuid,'manual')) x(id,s) where leads.id=x.id",
      [csv, sheet, manual],
    );
    await save({ batch_size: 4 });
    expect((await status()).counts.eligible).toBe(4);
    expect(await job()).toMatchObject({ assigned: 4 });
    expect(await owners([working, won, gone, social])).toEqual([
      "none",
      "none",
      "none",
      "none",
    ]);
    expect(
      (await owners([answered, csv, sheet, manual])).includes("none"),
    ).toBe(false);
  });

  it("assigns a whole batch or none of it; a setting that no longer works stops at once; three failed batches stop it", async () => {
    const batch = await leads(10);
    await save({ batch_size: 10 });
    // A lead that cannot be assigned in the middle of the batch.
    await t.pg
      .exec(`create function test_refuse() returns trigger language plpgsql as $$
      begin if new.assigned_agent is not null and new.name='Buyer ${phone - 5}' then
       raise exception 'refused for the test'; end if; return new; end $$;
      create trigger test_refuse before update of assigned_agent on leads for each row execute function test_refuse();`);
    try {
      for (let i = 1; i <= 3; i++) {
        await expect(job()).rejects.toThrow("Automatic batch failed");
        expect(await owners(batch)).toEqual(Array(10).fill("none"));
        expect((await status()).failures).toBe(i);
      }
    } finally {
      await t.pg.exec(
        "drop trigger test_refuse on leads; drop function test_refuse();",
      );
    }
    const s = await status();
    expect(s).toMatchObject({ state: "error", failures: 3 });
    expect(s.last_error).toBe(
      "The CRM could not assign the batch (code P0001)",
    );
    expect(s.batches.map((b) => b.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(await job()).toEqual(expect.objectContaining({ status: "error" }));
    // Resumed: the batch goes, all of it.
    await api("post", "/state", { state: "on" }).expect(200);
    expect(await job()).toMatchObject({ assigned: 10 });
    // An agent no longer active: stopped at once, nothing assigned, and
    // resuming is refused until the settings are changed.
    const more = await leads(10);
    await t.pg.query("update profiles set active=false where id=$1", [shiza]);
    const failed = await t.db.rpc("auto_assign_run", {
      p_actor: null,
      p_request: "t",
    });
    expect(failed.data).toMatchObject({
      status: "failed",
      reason: "Not an active agent: Shiza",
    });
    expect(await owners(more)).toEqual(Array(10).fill("none"));
    expect((await status()).state).toBe("error");
    const refused = await api("post", "/state", { state: "on" }).expect(400);
    expect(refused.body.error).toBe(
      "Choose valid settings: Not an active agent: Shiza",
    );
    await save({
      batch_size: 10,
      agents: shares([
        [abru, 40],
        [alisha, 60],
      ]),
    });
    expect(tally(await owners(more))).toEqual({ none: 10 });
    expect(await job()).toMatchObject({ assigned: 10 });
    expect(tally(await owners(more))).toEqual({ Abru: 4, Alisha: 6 });
    // The administrator who saved the settings no longer active.
    await leads(10);
    await t.pg.query("update profiles set active=false where id=$1", [admin]);
    const noAdmin = await t.db.rpc("auto_assign_run", {
      p_actor: null,
      p_request: "t",
    });
    await t.pg.query("update profiles set active=true where id=$1", [admin]);
    expect(noAdmin.data.reason).toMatch(
      /^The administrator who saved the settings is no longer active/,
    );
  });

  it("Run now and the worker never assign a lead twice; a confirmed batch stays; the balance carries on until saved again", async () => {
    const all = await leads(45);
    await save({ batch_size: 20 });
    const run = await api("post", "/run", {}).expect(200);
    expect(run.body).toMatchObject({ status: "assigned", assigned: 40 });
    expect(run.body.batches).toHaveLength(2);
    // Run again at once, then the worker: the five left are not a batch.
    expect((await api("post", "/run", {}).expect(200)).body).toMatchObject({
      status: "waiting",
      waiting: 5,
    });
    expect(await job()).toMatchObject({ status: "waiting" });
    expect(
      await t.one(
        "select count(*)::int n,count(distinct lead_id)::int d from assignments where lead_id=any($1) and agent_id is not null",
        [all],
      ),
    ).toEqual({ n: 40, d: 40 });
    const s = await status();
    expect(s.batches[0]).toMatchObject({
      trigger: "manual",
      actor_name: expect.any(String),
    });
    // Batches of 3 keep a carried balance: ten batches give 6/9/15.
    await t.pg.query(
      "update leads set deleted_at=now(),deleted_by=$1,delete_reason='Earlier test',deleted_batch=gen_random_uuid() where id=any($2)",
      [admin, all.slice(40)],
    );
    await save({ batch_size: 3 });
    const thirty = await leads(30);
    await job();
    expect(tally(await owners(thirty))).toEqual({
      Abru: 6,
      Shiza: 9,
      Alisha: 15,
    });
    // Saving starts the balance again.
    await leads(1);
    await save({ batch_size: 3 });
    expect(
      (await t.all("select balance from crm_private.auto_assign_rules")).every(
        (r) => Number(r.balance) === 0,
      ),
    ).toBe(true);
  });

  it("is for administrators only, in the server and the database", async () => {
    for (const [method, path, body] of [
      ["get", "", undefined],
      ["post", "/preview", { batch_size: 20, scope: "new", agents: split }],
      [
        "put",
        "",
        {
          version: 0,
          state: "on",
          batch_size: 20,
          scope: "new",
          agents: split,
        },
      ],
      ["post", "/state", { state: "paused" }],
      ["post", "/run", {}],
    ]) {
      await api(method, path, body, abru).expect(403);
      await request(app())
        [method]("/api/leads/auto-assign" + path)
        .send(body)
        .expect(401);
    }
    const grants = await t.one(
      "select has_function_privilege('authenticated','public.auto_assign_run(uuid,text)','execute') a,has_function_privilege('anon','public.auto_assign_status(uuid)','execute') b,has_function_privilege('service_role','public.auto_assign_pool(timestamptz)','execute') c",
    );
    expect(grants).toEqual({ a: false, b: false, c: false });
    await expect(
      t.pg.query("select auto_assign_run($1,'t')", [abru]),
    ).rejects.toThrow("Administrator access required");
    // The preview: a fresh batch's shares and what waits.
    await leads(25);
    const preview = (
      await api("post", "/preview", {
        batch_size: 20,
        scope: "backlog",
        agents: split,
      }).expect(200)
    ).body;
    expect(preview.agents.map((a) => a.count)).toEqual([4, 6, 10]);
    expect(preview.counts).toMatchObject({
      waiting: 25,
      batches: 1,
      leftover: 5,
    });
  });
});

describe("update 091 on a database at 090, as production is", () => {
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "091" });
    await people(t.pg);
  }, 120000);
  afterAll(async () => {
    await t?.pg.close();
  });
  const fns = async () =>
    (
      await t.one(
        "select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.proname)) f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'auto_assign%'",
      )
    ).f;
  const check = async () => t.one(await readFile(checkFile, "utf8"));

  it("asks for 091 first, applies once, reruns as a no-op and refuses before 090", async () => {
    expect((await api("get", "").expect(503)).body.error).toBe(
      "This feature needs CRM database update 091 after 090.",
    );
    expect(await check()).toMatchObject({
      release_stage: "at 090, ready for 091",
      unassigned_leads: 0,
      eligible_now: 0,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({ release_stage: "at 091" });
    expect((await status()).state).toBe("off");
    const after = await fns();
    await t.pg.exec(sql);
    expect(await fns()).toBe(after);
    const at089 = await startCrmDatabase({ before: "090" });
    try {
      await expect(at089.pg.exec(sql)).rejects.toThrow(
        "Apply CRM updates up to 090 before update 091.",
      );
    } finally {
      await at089.pg.close();
    }
  }, 180000);
});
