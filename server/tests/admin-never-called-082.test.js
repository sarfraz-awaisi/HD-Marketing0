import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 082: All leads "Never called": no call outcome saved by the lead's
// agent since receiving it, for one agent, several or all of them; and
// Assign to agents from that list, which keeps with their agent the leads
// called since. Calls go through the real call log, so who logged each one
// is recorded as in production. Only administrators get in, in the server
// and the database.
const admin = "82000000-0000-4000-8000-000000000001",
  abru = "82000000-0000-4000-8000-000000000002",
  alisha = "82000000-0000-4000-8000-000000000003",
  owais = "82000000-0000-4000-8000-000000000004";
const migration = new URL(
  "../../supabase/migrations/082_admin_never_called.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-called-082.sql",
  import.meta.url,
);
let main,
  cur,
  phone = 0;
beforeAll(async () => {
  main = await startCrmDatabase();
}, 60000);
afterAll(async () => {
  await main?.pg.close();
});
async function people(pg) {
  await resetPeople(pg, [admin, abru, alisha]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owais@gmail.com',now())",
    [owais],
  );
  await pg.query(
    "update profiles set active=true,role='agent',name=case id when $1 then 'Abru' when $2 then 'Alisha' when $3 then 'Owais' end where id=any($4::uuid[])",
    [abru, alisha, owais, [abru, alisha, owais]],
  );
}
beforeEach(async () => {
  cur = main;
  await people(main.pg);
});
const app = () => createApp(trustedMfaFixture(cur.db));
const as = (user) => ({ Authorization: "Bearer " + user });
// n new leads, given to an agent (none: unassigned), in creation order.
async function leads(n, agent = null) {
  const ids = (
    await cur.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||($3::int+i)),'+92302'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  if (agent) await move(ids, agent);
  return ids;
}
const move = (ids, agent) =>
  cur.pg.query("select admin_assign_leads($1,$2,$3,'t')", [ids, admin, agent]);
// A call saved with its outcome through the call log, by an agent or an
// administrator.
const call = (lead, by, outcome = "No answer") =>
  cur.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    by,
    JSON.stringify({
      answered: !["No answer", "Busy", "Number off"].includes(outcome),
      started_at: new Date(Date.now() - 600000).toISOString(),
      duration_seconds: 60,
      outcome,
      notes: "Called",
      deal_tags: [],
    }),
  ]);
const list = async (query = {}, user = admin, status = 200) =>
  (
    await request(app())
      .get("/api/leads/all?" + new URLSearchParams(query))
      .set(as(user))
      .expect(status)
  ).body;
const never = (agents, extra = {}) =>
  list({
    call: "never_called",
    ...(agents ? { agent: agents.join(",") } : {}),
    ...extra,
  });
const ids = (body) => body.data.map((l) => l.id).sort();
const selected = async (query) =>
  (
    await request(app())
      .get("/api/leads/all/selection?" + new URLSearchParams(query))
      .set(as(admin))
      .expect(200)
  ).body.ids.sort();
const distribute = (path, body, user = admin) =>
  request(app())
    .post("/api/leads/distribute" + path)
    .set(as(user))
    .send(body);
const owners = async (leadIds) =>
  (
    await cur.all(
      "select coalesce(p.name,'none') agent from unnest($1::uuid[]) with ordinality x(id,n) join leads l on l.id=x.id left join profiles p on p.id=l.assigned_agent order by x.n",
      [leadIds],
    )
  ).map((r) => r.agent);

describe("Never called (update 082)", () => {
  it("an agent with 100 assigned leads who called 70 has 30 never called, paged and selected exactly", async () => {
    const all = await leads(100, abru);
    const outcomes = [
      "No answer",
      "Busy",
      "Number off",
      "Wrong number",
      "Interested",
      "Not interested",
      "Closed lost",
    ];
    for (const [i, lead] of all.slice(0, 70).entries())
      await call(lead, abru, outcomes[i % outcomes.length]);
    const uncalled = all.slice(70).sort();
    const first = await never([abru]);
    expect(first.count).toBe(30);
    const second = await never([abru], { page: 2 });
    expect([first.data.length, second.data.length]).toEqual([20, 10]);
    expect([...ids(first), ...ids(second)].sort()).toEqual(uncalled);
    expect(await selected({ call: "never_called", agent: abru })).toEqual(
      uncalled,
    );
    // Every call stays in the history.
    expect(
      (
        await cur.one(
          "select count(*)::int n from calls where lead_id=any($1)",
          [all],
        )
      ).n,
    ).toBe(70);
  });

  it("any saved outcome counts as called (No answer, Busy, Number off); an unsaved dial, an administrator's call, the first-call time or the deadline do not", async () => {
    const [noAnswer, busy, off, dialled, byAdmin, stamped] = await leads(
      6,
      abru,
    );
    await call(noAnswer, abru, "No answer");
    await call(busy, abru, "Busy");
    await call(off, abru, "Number off");
    // A dial with no outcome saved yet.
    await cur.pg.query(
      "insert into calls(lead_id,agent_id,provider_call_id,status) values($1,$2,'dial-082','initiated')",
      [dialled, abru],
    );
    // An administrator logs a call on Abru's lead: it is the administrator's.
    await call(byAdmin, admin, "Interested");
    // A first-call time and a passed deadline prove nothing.
    await cur.pg.query(
      "update leads set first_call_at=now(),call_due_at=now()-interval '2 days' where id=$1",
      [stamped],
    );
    expect(ids(await never([abru]))).toEqual(
      [dialled, byAdmin, stamped].sort(),
    );
  });

  it("a reassigned lead is judged by its new agent's assignment; the earlier agent's call stays theirs", async () => {
    const [lead] = await leads(1, abru);
    await call(lead, abru, "Busy");
    expect((await never([abru])).count).toBe(0);
    await move([lead], alisha);
    expect(ids(await never([alisha]))).toEqual([lead]);
    expect((await never([abru])).count).toBe(0);
    const history = await cur.all(
      "select c.agent_id,report_recorded_by('calls',c.id) recorded_by,c.outcome from calls c where c.lead_id=$1",
      [lead],
    );
    expect(history).toEqual([
      { agent_id: abru, recorded_by: abru, outcome: "Busy" },
    ]);
    await call(lead, alisha, "No answer");
    expect((await never([alisha])).count).toBe(0);
    // Back to Abru: his earlier call came before this assignment.
    await move([lead], abru);
    expect(ids(await never([abru]))).toEqual([lead]);
  });

  it("several agents together, or every agent; unassigned and deleted leads never show", async () => {
    const a = await leads(3, abru),
      b = await leads(2, alisha),
      c = await leads(2, owais);
    await call(a[0], abru);
    for (const lead of c) await call(lead, owais, "Interested");
    await leads(1);
    const [gone] = await leads(1, abru);
    await cur.pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const expected = [a[1], a[2], ...b].sort();
    expect(ids(await never([abru, alisha, owais]))).toEqual(expected);
    expect(ids(await never([abru, alisha]))).toEqual(expected);
    expect((await never([owais])).count).toBe(0);
    expect(ids(await never(null))).toEqual(expected);
    expect(
      await selected({ call: "never_called", agent: `${abru},${alisha}` }),
    ).toEqual(expected);
    // Several agents without Never called: all their leads.
    expect(ids(await list({ agent: `${abru},${owais}` }))).toEqual(
      [...a, ...c].sort(),
    );
    // One agent goes to the database as before.
    expect(ids(await list({ agent: owais }))).toEqual([...c].sort());
  });

  it("works with search, source, lead file, latest outcome, temperature and Lead Usage", async () => {
    const [x, y] = await leads(2, abru);
    await call(x, admin, "Interested");
    const name = (await cur.one("select name from leads where id=$1", [y]))
      .name;
    expect(ids(await never([abru], { search: name }))).toEqual([y]);
    expect(ids(await never([abru], { source: "manual" }))).toEqual(
      [x, y].sort(),
    );
    expect(ids(await never([abru], { outcome: "Interested" }))).toEqual([x]);
    expect(ids(await never([abru], { temperature: "none" }))).toEqual(
      [x, y].sort(),
    );
    await move([y], alisha);
    expect(ids(await never([alisha], { usage: "2" }))).toEqual([y]);
    const body = await never([abru, alisha]);
    expect(body.usage).toMatchObject({ all: 2, 2: 1 });
    const file = (
      await cur.one(
        "insert into lead_imports(file_name,file_format,total_rows,imported_count) values('Never called.csv','csv',1,1) returning id",
      )
    ).id;
    await cur.pg.query("update leads set import_id=$2 where id=$1", [x, file]);
    expect(ids(await never([abru, alisha], { import_id: file }))).toEqual([x]);
  });

  it("refuses unknown, repeated or too many agents, and agents with Unassigned", async () => {
    for (const agent of [
      "not-an-id",
      `${abru},${abru}`,
      Array.from(
        { length: 101 },
        (_, i) => `82000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ).join(","),
    ])
      await list({ agent }, admin, 400);
    await list(
      { agent: `${abru},${alisha}`, assignment: "unassigned" },
      admin,
      400,
    );
    await list({ call: "never_calls" }, admin, 400);
  });
});

describe("Won and Lost leads (update 082)", () => {
  it("as in New and Missed first call: Won and Lost leads wait for no call, unless Lost before reaching their agent", async () => {
    const [won, lost, open] = await leads(3, abru);
    await cur.pg.query("update leads set status='won' where id=$1", [won]);
    await cur.pg.query(
      "update leads set status='lost',lost_reason='other' where id=$1",
      [lost],
    );
    expect(ids(await never([abru]))).toEqual([open]);
    await move([won, lost], alisha);
    expect(ids(await never([alisha]))).toEqual([lost]);
  });
});

describe("Assign to agents from a Never called list (update 082)", () => {
  it("keeps a lead marked Won after the preview with its agent", async () => {
    const [one, two] = await leads(2, abru);
    const body = {
      lead_ids: [one, two],
      agent_ids: [alisha],
      never_called: true,
    };
    const plan = (await distribute("/preview", body).expect(200)).body;
    await cur.pg.query("update leads set status='won' where id=$1", [two]);
    const stale = (
      await distribute("", { ...body, token: plan.token }).expect(200)
    ).body;
    expect(stale).toMatchObject({ applied: false, stale: true, kept: 1 });
    expect(stale.results.find((r) => r.id === two).reason).toBe(
      "Marked Won: stays with Abru",
    );
    expect(await owners([one, two])).toEqual(["Abru", "Abru"]);
  });

  it("keeps a lead its agent called after the preview: nothing moves, the new plan comes back, then the rest move", async () => {
    const [one, two, three] = await leads(3, abru);
    const body = {
      lead_ids: [one, two, three],
      agent_ids: [alisha],
      never_called: true,
    };
    const plan = (await distribute("/preview", body).expect(200)).body;
    expect(plan).toMatchObject({ applied: false, reassigned: 3, kept: 0 });
    await call(two, abru, "No answer");
    const stale = (
      await distribute("", { ...body, token: plan.token }).expect(200)
    ).body;
    expect(stale).toMatchObject({
      applied: false,
      stale: true,
      reassigned: 2,
      kept: 1,
    });
    expect(stale.results.find((r) => r.id === two)).toMatchObject({
      result: "kept",
      reason: "Called by Abru since receiving it: stays with Abru",
    });
    expect(await owners([one, two, three])).toEqual(["Abru", "Abru", "Abru"]);
    const done = (
      await distribute("", { ...body, token: stale.token }).expect(200)
    ).body;
    expect(done).toMatchObject({ applied: true, reassigned: 2, kept: 1 });
    expect(await owners([one, two, three])).toEqual([
      "Alisha",
      "Abru",
      "Alisha",
    ]);
    // The usual assignment history and audit.
    expect(
      await cur.one(
        "select (select count(*)::int from assignments where lead_id=any($1) and agent_id=$2) moves,(select count(*)::int from audit_log where action='lead.bulk_distributed' and (metadata->>'reassigned')::int=2) bulk",
        [[one, three], alisha],
      ),
    ).toEqual({ moves: 2, bulk: 1 });
  });

  it("a lead moved by someone else after the preview stops the move, as before", async () => {
    const [one, two] = await leads(2, abru);
    const body = {
      lead_ids: [one, two],
      agent_ids: [alisha],
      never_called: true,
    };
    const plan = (await distribute("/preview", body).expect(200)).body;
    await move([one], owais);
    const stale = (
      await distribute("", { ...body, token: plan.token }).expect(200)
    ).body;
    expect(stale).toMatchObject({ applied: false, stale: true });
    expect(await owners([one, two])).toEqual(["Owais", "Abru"]);
    expect(stale.results.find((r) => r.id === one).reason).toBe(
      "Moved from Owais to Alisha",
    );
  });

  it("says so when every selected lead was called; without Never called the move is unchanged", async () => {
    const [lead] = await leads(1, abru);
    await call(lead, abru, "Busy");
    const refused = await distribute("/preview", {
      lead_ids: [lead],
      agent_ids: [alisha],
      never_called: true,
    }).expect(400);
    expect(refused.body.error).toMatch(
      /^Choose other leads: every selected lead has been called by its agent/,
    );
    const plain = (
      await distribute("/preview", {
        lead_ids: [lead],
        agent_ids: [alisha],
      }).expect(200)
    ).body;
    expect(plain).toMatchObject({ reassigned: 1 });
    expect(plain.kept).toBeUndefined();
  });

  it("is for administrators only, in the server and the database", async () => {
    const [lead] = await leads(1, abru);
    await list({ call: "never_called" }, abru, 403);
    await distribute(
      "/preview",
      { lead_ids: [lead], agent_ids: [alisha], never_called: true },
      abru,
    ).expect(403);
    const { error } = await cur.db.rpc("admin_distribute_never_called", {
      p_actor: abru,
      p_lead_ids: [lead],
      p_agents: [alisha],
      p_apply: true,
      p_token: null,
      p_request: "t",
    });
    expect(error.code).toBe("42501");
    expect(await owners([lead])).toEqual(["Abru"]);
    for (const role of ["anon", "authenticated"])
      expect(
        await cur.one(
          "select has_function_privilege($1,'public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)','execute') d,has_function_privilege($1,'public.lead_never_called(uuid)','execute') h",
          [role],
        ),
      ).toEqual({ d: false, h: false });
  });
});

describe("update 082 on a database at 081, as production is", () => {
  let at081;
  beforeAll(async () => {
    at081 = await startCrmDatabase({ before: "082" });
  }, 60000);
  afterAll(async () => {
    await at081?.pg.close();
  });
  // Everything 081 answers, for the filters it already had.
  const queries = [
    {},
    { page: 2 },
    { assignment: "unassigned" },
    { assignment: "assigned" },
    { agent: abru },
    { call: "uncalled" },
    { call: "missed" },
    { call: "not_connected" },
    { outcome: "No answer" },
    { temperature: "none" },
    { usage: 2 },
    { search: "Buyer" },
    { ids: true, assignment: "assigned" },
  ];
  const snapshot = async () => ({
    rows: (
      await cur.one(
        "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
      )
    ).s,
    functions: (
      await cur.one(
        "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not in ('admin_lead_list','lead_never_called','admin_distribute_never_called')",
      )
    ).s,
    triggers: (
      await cur.one(
        "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
      )
    ).s,
    lists: await Promise.all(
      queries.map(
        async (q) =>
          (
            await cur.one("select admin_lead_list($1,$2::jsonb) r", [
              admin,
              JSON.stringify(q),
            ])
          ).r,
      ),
    ),
  });
  const stage = async () =>
    (await cur.one(await readFile(checkFile, "utf8"))).release_stage;

  it("needs update 082 for the new filters; one agent and the usual move still work", async () => {
    cur = at081;
    await people(cur.pg);
    const [lead] = await leads(1, abru);
    await list({ call: "never_called" }, admin, 503).then((b) =>
      expect(b.error).toBe(
        "This filter needs CRM database update 082 after 081.",
      ),
    );
    await list({ agent: `${abru},${alisha}` }, admin, 503);
    expect(ids(await list({ agent: abru }))).toEqual([lead]);
    const refused = await distribute("/preview", {
      lead_ids: [lead],
      agent_ids: [alisha],
      never_called: true,
    }).expect(503);
    expect(refused.body.error).toBe(
      "This feature needs CRM database update 082 after 081.",
    );
    await distribute("/preview", {
      lead_ids: [lead],
      agent_ids: [alisha],
    }).expect(200);
  });

  it("changes no record, trigger or other function, answers every earlier query as before, and reruns without change", async () => {
    cur = at081;
    await people(cur.pg);
    const a = await leads(23, abru);
    await leads(3);
    await leads(2, alisha);
    await call(a[0], abru, "No answer");
    await call(a[1], admin, "Interested");
    await move([a[2]], alisha);
    await cur.pg.query(
      "update leads set call_due_at=now()-interval '1 day' where id=any($1)",
      [a.slice(3, 6)],
    );
    expect(await stage()).toBe("at 081, ready for 082");
    const before = await snapshot();
    const sql = await readFile(migration, "utf8");
    await cur.pg.exec(sql);
    expect(await stage()).toBe("at 082");
    expect(await snapshot()).toEqual(before);
    const list082 = (
      await cur.one(
        "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) f",
      )
    ).f;
    await cur.pg.exec(sql);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await cur.one(
          "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) f",
        )
      ).f,
    ).toBe(list082);
    const check = await cur.one(await readFile(checkFile, "utf8"));
    expect(check).toMatchObject({
      release_stage: "at 082",
      browser_can_use_it: false,
      // Abru's 23 but the one he called (the moved one is Alisha's), and
      // Alisha's 2.
      never_called_now: 24,
      transactions_open_over_1_min: 0,
    });
  });
});

describe("update 082 before 081", () => {
  it("refuses to run and changes nothing", async () => {
    const at080 = await startCrmDatabase({ before: "081" });
    try {
      await expect(
        at080.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow(/Apply CRM updates up to 081 before update 082/);
      await at080.pg.exec("rollback");
      expect(
        (
          await at080.one(
            "select to_regprocedure('public.lead_never_called(uuid)') is null gone",
          )
        ).gone,
      ).toBe(true);
    } finally {
      await at080.pg.close();
    }
  }, 60000);
});
