import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 084: Never assigned, the leads none of the chosen agents has ever
// had by the assignment history, and Assign to agents from it, which sends
// a lead only to a chosen agent it has never had. Only administrators get
// in, in the server and the database.
const admin = "84000000-0000-4000-8000-000000000001",
  abru = "84000000-0000-4000-8000-000000000002",
  alisha = "84000000-0000-4000-8000-000000000003",
  owais = "84000000-0000-4000-8000-000000000004";
const migration = new URL(
  "../../supabase/migrations/084_admin_never_assigned.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-assigned-084.sql",
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
async function leads(n, agent = null) {
  const ids = (
    await cur.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||($3::int+i)),'+92303'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  if (agent) await move(ids, agent);
  return ids;
}
const move = (ids, agent) =>
  cur.pg.query("select admin_assign_leads($1,$2,$3,'t')", [ids, admin, agent]);
const unassign = (ids) =>
  cur.pg.query("select assign_leads_bulk($1,$2,'unassign',null,'t')", [
    ids,
    admin,
  ]);
const list = async (query = {}, user = admin, status = 200) =>
  (
    await request(app())
      .get("/api/leads/all?" + new URLSearchParams(query))
      .set(as(user))
      .expect(status)
  ).body;
const never = (agents, extra = {}) =>
  list({ ...(agents ? { never_assigned: agents.join(",") } : {}), ...extra });
const ids = (body) => body.data.map((l) => l.id).sort();
const sorted = (a) => [...a].sort();
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
    .send({ never_assigned: true, ...body });
const owners = async (leadIds) =>
  (
    await cur.all(
      "select coalesce(p.name,'none') agent from unnest($1::uuid[]) with ordinality x(id,n) join leads l on l.id=x.id left join profiles p on p.id=l.assigned_agent order by x.n",
      [leadIds],
    )
  ).map((r) => r.agent);
const history = async (lead) =>
  (
    await cur.all(
      "select coalesce(p.name,'none') agent from assignments a left join profiles p on p.id=a.agent_id where a.lead_id=$1 order by a.created_at,a.id",
      [lead],
    )
  ).map((r) => r.agent);

describe("Never assigned list (update 084)", () => {
  it("one agent: excludes leads the agent has now or had before, however often; calls play no part", async () => {
    const [withAbru, hadAbru, twice, withAlisha, none] = await leads(5);
    await move([withAbru], abru);
    await move([hadAbru], abru);
    await move([hadAbru], alisha);
    await move([twice], abru);
    await move([twice], alisha);
    await move([twice], abru);
    await unassign([twice]);
    await move([withAlisha], alisha);
    const body = await never([abru]);
    expect(ids(body)).toEqual(sorted([withAlisha, none]));
    expect(body.totals).toEqual({ total: 2, assigned: 1, unassigned: 1 });
    // Lead Usage counts as in All leads: Abru, Alisha, Abru again is 2.
    const all = await list();
    const usage = Object.fromEntries(
      all.data.map((l) => [l.id, l.agents_used]),
    );
    expect([
      usage[withAbru],
      usage[hadAbru],
      usage[twice],
      usage[none],
    ]).toEqual([1, 2, 2, 0]);
    expect(sorted(all.data.find((l) => l.id === twice).agents_had)).toEqual(
      sorted([abru, alisha]),
    );
    expect(all.data.find((l) => l.id === withAlisha).agents_had).toEqual([
      alisha,
    ]);
  });

  it("several agents: only leads none of them has had; any agent: every lead, as All leads", async () => {
    const [a, b, c, d] = await leads(4);
    await move([a], abru);
    await move([b], alisha);
    await move([c], owais);
    expect(ids(await never([abru, alisha]))).toEqual(sorted([c, d]));
    expect(ids(await never([abru, alisha, owais]))).toEqual([d]);
    const any = await never(null);
    expect(any).toEqual(await list());
    expect(any.count).toBe(4);
  });

  it("search by name or phone and the latest call outcome narrow it, with the same canonical outcomes", async () => {
    const [a, b, c] = await leads(3);
    await move([a], alisha);
    await cur.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      a,
      alisha,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 600000).toISOString(),
        duration_seconds: 60,
        outcome: "Not interested",
        notes: "Called",
        deal_tags: [],
      }),
    ]);
    const name = (await cur.one("select name from leads where id=$1", [b]))
      .name;
    expect(ids(await never([abru], { search: name }))).toEqual([b]);
    const number = (
      await cur.one(
        "select phone from crm_private.lead_phones where lead_id=$1",
        [c],
      )
    ).phone;
    expect(ids(await never([abru], { search: number.slice(-7) }))).toEqual([c]);
    expect(ids(await never([abru], { outcome: "Not interested" }))).toEqual([
      a,
    ]);
    expect(ids(await never([alisha], { outcome: "Not interested" }))).toEqual(
      [],
    );
    // Update 088: a lead an agent is working on is left out.
    expect(ids(await never([abru], { outcome: "Interested" }))).toEqual([]);
    await list({ never_assigned: abru, outcome: "Maybe" }, admin, 400);
  });

  it("pages and Select all follow it; deleted leads never appear", async () => {
    const all = await leads(27);
    await move(all.slice(0, 2), abru);
    await cur.pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [all[2]],
      admin,
    ]);
    const left = sorted(all.slice(3));
    const first = await never([abru]);
    const second = await never([abru], { page: 2 });
    expect(first.count).toBe(24);
    expect([first.data.length, second.data.length]).toEqual([20, 4]);
    expect(sorted([...ids(first), ...ids(second)])).toEqual(left);
    expect(await selected({ never_assigned: abru })).toEqual(left);
  });

  it("is for administrators only; bad agent lists are refused", async () => {
    await list({ never_assigned: abru }, abru, 403);
    await list({ never_assigned: "x" }, admin, 400);
    await list({ never_assigned: `${abru},${abru}` }, admin, 400);
    const [lead] = await leads(1);
    await distribute(
      "/preview",
      { lead_ids: [lead], agent_ids: [abru] },
      abru,
    ).expect(403);
    await distribute("/preview", {
      lead_ids: [lead],
      agent_ids: [abru],
      never_called: true,
    }).expect(400);
    const denied = await cur.one(
      "select has_function_privilege('authenticated','public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)','execute') a, has_function_privilege('anon','public.admin_distribute_never_assigned(uuid,uuid[],uuid[],boolean,text,text)','execute') b",
    );
    expect(denied).toEqual({ a: false, b: false });
  });
});

describe("Assign to agents from Never assigned (update 084)", () => {
  it("shares leads only among agents each has never had, keeps those that had them all, and records each move", async () => {
    const [a, b, c, d, e] = await leads(5);
    await move([a], abru); // can go to Alisha or Owais
    await move([b], alisha);
    await move([b], owais); // had Alisha and Owais: only Abru
    await move([c], abru);
    await move([c], alisha);
    await move([c], owais); // had all three: stays with Owais
    const body = {
      lead_ids: [a, b, c, d, e],
      agent_ids: [abru, alisha, owais],
    };
    const plan = (await distribute("/preview", body).expect(200)).body;
    expect(plan).toMatchObject({ applied: false, kept: 1, failed: 0 });
    expect(await owners([a, b, c, d, e])).toEqual([
      "Abru",
      "Owais",
      "Owais",
      "none",
      "none",
    ]);
    const done = (
      await distribute("", { ...body, token: plan.token }).expect(200)
    ).body;
    expect(done).toMatchObject({
      applied: true,
      stale: false,
      assigned: 2,
      reassigned: 2,
      kept: 1,
    });
    const after = await owners([a, b, c, d, e]);
    expect(after[1]).toBe("Abru");
    expect(after[2]).toBe("Owais");
    expect(["Alisha", "Owais"]).toContain(after[0]);
    for (const lead of [a, b, c, d, e]) {
      const had = await history(lead);
      // No lead was given back to an agent it had before this move.
      expect(new Set(had).size).toBe(had.length);
    }
    expect(done.results.find((r) => r.id === c).reason).toBe(
      "Assigned before to every chosen agent: stays with Owais",
    );
    const audit = await cur.one(
      "select metadata from audit_log where action='lead.bulk_distributed' order by created_at desc limit 1",
    );
    expect(audit.metadata).toMatchObject({
      never_assigned: true,
      assigned: 2,
      reassigned: 2,
    });
  });

  it("one lead, one agent: moves it once; an agent it had is refused; Won and Lost leads stay", async () => {
    const [lead, won, lost] = await leads(3, abru);
    await cur.pg.query("update leads set status='won' where id=$1", [won]);
    await cur.pg.query(
      "update leads set status='lost',lost_reason='price' where id=$1",
      [lost],
    );
    const one = { lead_ids: [lead], agent_ids: [alisha] };
    const plan = (await distribute("/preview", one).expect(200)).body;
    expect(plan.results[0]).toMatchObject({
      result: "reassigned",
      from: abru,
      agent: alisha,
    });
    await distribute("", { ...one, token: plan.token }).expect(200);
    expect(await owners([lead])).toEqual(["Alisha"]);
    const back = (
      await distribute("/preview", { lead_ids: [lead], agent_ids: [abru] })
    ).body;
    expect(back.results[0]).toMatchObject({
      result: "kept",
      reason: "Assigned to Abru before: stays with Alisha",
    });
    const closed = (
      await distribute("/preview", {
        lead_ids: [won, lost],
        agent_ids: [owais],
      })
    ).body;
    expect(closed.results.map((r) => r.reason).sort()).toEqual([
      "Marked Lost: stays with Abru",
      "Marked Won: stays with Abru",
    ]);
  });

  it("a change between preview and confirmation moves nothing and returns the new plan", async () => {
    const [x, y] = await leads(2);
    const body = { lead_ids: [x, y], agent_ids: [abru] };
    const plan = (await distribute("/preview", body)).body;
    expect(plan.assigned).toBe(2);
    // Meanwhile x goes to Abru and back to no agent: same owner, new
    // history.
    await move([x], abru);
    await unassign([x]);
    const stale = (await distribute("", { ...body, token: plan.token })).body;
    expect(stale).toMatchObject({ applied: false, stale: true, assigned: 1 });
    expect(await owners([x, y])).toEqual(["none", "none"]);
    expect(await history(y)).toEqual([]);
    const done = (await distribute("", { ...body, token: stale.token })).body;
    expect(done).toMatchObject({ applied: true, assigned: 1, kept: 1 });
    expect(await owners([x, y])).toEqual(["none", "Abru"]);
  });
});

describe("update 084 on a database at 083, as production is", () => {
  let at083;
  beforeAll(async () => {
    at083 = await startCrmDatabase({ before: "084" });
  }, 60000);
  afterAll(async () => {
    await at083?.pg.close();
  });

  it("needs 084 for the page; All leads still works; 084 changes no record and reruns as a no-op", async () => {
    cur = at083;
    await people(cur.pg);
    const [a] = await leads(2, abru);
    expect((await list({ never_assigned: abru }, admin, 503)).error).toBe(
      "Never assigned needs CRM database update 084 after 083.",
    );
    await distribute("/preview", { lead_ids: [a], agent_ids: [alisha] }).expect(
      503,
    );
    const before083 = await list();
    expect(await cur.one(await readFile(checkFile, "utf8"))).toMatchObject({
      release_stage: "at 083, ready for 084",
      list_edits_fit: true,
      browser_can_use_it: null,
      history_gaps: 0,
      owner_not_latest_record: 0,
    });
    const rows = async () =>
      (
        await cur.one(
          "select md5(string_agg(t,'|' order by t)) s from (select format('%s:%s',c.relname,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',n.nspname,c.relname),false,true,'')))[1]::text) t from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','auth','crm_private')) x",
        )
      ).s;
    const functions = async () =>
      (
        await cur.one(
          "select md5(string_agg(p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)),'|' order by 1)) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not in ('admin_lead_list','admin_distribute_never_assigned')",
        )
      ).s;
    const [r0, f0] = [await rows(), await functions()];
    const sql = await readFile(migration, "utf8");
    await cur.pg.exec(sql);
    const def = async () =>
      (
        await cur.one(
          "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) f",
        )
      ).f;
    const once = await def();
    await cur.pg.exec(sql);
    expect(await def()).toBe(once);
    expect([await rows(), await functions()]).toEqual([r0, f0]);
    expect(await cur.one(await readFile(checkFile, "utf8"))).toMatchObject({
      release_stage: "at 084",
      list_edits_fit: null,
      browser_can_use_it: false,
      history_gaps: 0,
      owner_not_latest_record: 0,
    });
    // All leads answers as before, with each lead's agents added.
    const after = await list();
    expect(
      after.data.map(({ agents_had, ...rest }) => (void agents_had, rest)),
    ).toEqual(before083.data);
    expect(ids(await list({ never_assigned: abru }))).toEqual([]);
  });

  it("refuses to run before 083", async () => {
    const at082 = await startCrmDatabase({ before: "083" });
    try {
      await expect(
        at082.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow("Apply CRM updates up to 083 before update 084.");
    } finally {
      await at082.pg.close();
    }
  });
});
