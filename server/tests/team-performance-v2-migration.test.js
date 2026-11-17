import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 071 on a database at 070: no row, trigger, table or policy changes;
// only its three new functions and the checked edits of the team report;
// other report numbers stay; applying it again changes nothing; it refuses
// to run before 070 or on a function it does not expect; and its read-only
// check says where the database is.
const admin = "71100000-0000-4000-8000-000000000001",
  ali = "71100000-0000-4000-8000-000000000002",
  sara = "71100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "071_team_performance_v2.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
// New in 071 (the first three) and edited by it; every other function must
// not change.
const changed = [
  "team_owner_at",
  "deleted_lead_ids",
  "erase_deleted_leads_preview",
  "report_team_records",
  "report_team",
  "report_team_drilldown",
];
async function database(upTo) {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await pg.exec(await migration(name));
  return pg;
}
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL(
          "../../supabase/check-team-performance-071.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async (except = []) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [except],
    )
  ).s,
  grants: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)",
      [changed.slice(3)],
    )
  ).s,
  schema: (
    await one(
      "select md5(string_agg(x,'|' order by x)) s from (select c.relname||':'||c.relkind::text||':'||c.relrowsecurity x from pg_class c where c.relnamespace in ('public'::regnamespace,'crm_private'::regnamespace) union all select tgrelid::regclass::text||'.'||tgname from pg_trigger where not tgisinternal union all select polrelid::regclass::text||'.'||polname from pg_policy) t",
    )
  ).s,
});
// Reports 071 does not change, for a month around now, and the team
// report's numbers 071 keeps.
const reports = async () => {
  const from = new Date(Date.now() - 30 * 86400000).toISOString(),
    to = new Date(Date.now() + 86400000).toISOString();
  const read = async (sql, args) => (await one(sql, args)).v;
  const team = await read("select report_team($1,$2,$3) v", [admin, from, to]);
  const keep = ({ agent_id, received_first_time, calls, admin_calls }) => ({
    agent_id,
    received_first_time,
    calls,
    admin_calls,
  });
  return {
    metrics: await read("select crm_metrics($1,$2,$3) v", [admin, from, to]),
    agents: await read("select report_agents($1,$2,$3) v", [admin, from, to]),
    funnel: await read("select report_funnel($1,$2,$3) v", [admin, from, to]),
    team: team.agents.map(keep),
  };
};
const call = (lead, actor, outcome) =>
  db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    actor,
    JSON.stringify({
      answered: true,
      started_at: new Date(Date.now() - 60000).toISOString(),
      duration_seconds: 60,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);
let moved;
beforeAll(async () => {
  db = await database("071");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  const lead = async (n, owner) =>
    (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: `Buyer ${n}`, assigned_agent: owner }),
        "+9230071100" + n,
        admin,
      ])
    ).id;
  moved = await lead(1, ali);
  await call(moved, ali, "Follow-up required");
  await db.query("select admin_assign_leads($1,$2,$3,'t')", [
    [moved],
    admin,
    sara,
  ]);
  await db.query("select admin_assign_leads($1,$2,$3,'t')", [
    [moved],
    admin,
    ali,
  ]);
  await db.query("select admin_assign_leads($1,$2,$3,'t')", [
    [moved],
    admin,
    sara,
  ]);
  const twice = await lead(2, ali);
  await call(twice, ali, "Follow-up required");
  await call(twice, admin, "Interested");
  // Given again to the agent who has it: a second row, the same agent.
  await db.query("select handover_lead($1,$2,$3,'t')", [twice, admin, ali]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 071 on a database at 070", () => {
  it("changes no record, table, trigger, policy, grant or other function, and keeps other report numbers", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 070, ready for 071",
      edits_ready: 9,
      edits_applied: 0,
      edits_unexpected: 0,
      same_agent_reassignments: 1,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot(changed);
    const reported = await reports();
    const range = [
      admin,
      new Date(Date.now() - 86400000).toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
    ];
    const old = (await one("select report_team($1,$2,$3) v", range)).v;
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    expect(await reports()).toEqual(reported);
    const now = (await one("select report_team($1,$2,$3) v", range)).v;
    const ali_ = (r) => r.agents.find((a) => a.agent_id === ali);
    // Moved away: three moves of one lead were three; now one lead.
    expect([ali_(old).moved_away, ali_(now).moved_away]).toEqual([2, 1]);
    // Received: the second row to the same agent was a second arrival only
    // for the same lead in another period; in one period, once either way.
    expect([ali_(old).received, ali_(now).received]).toEqual([2, 2]);
    // New numbers: Follow-ups and Time.
    expect(ali_(now)).toMatchObject({
      followup_leads: 0,
      worked_minutes: 0,
      open_days: 0,
      incomplete_days: 0,
    });
    expect(now.metrics).toContain("followup_leads");
    expect(await check()).toMatchObject({
      release_stage: "at 071",
      edits_ready: 0,
      edits_applied: 9,
      edits_unexpected: 0,
    });
  });
  it("lets only the CRM's server call the new functions", async () => {
    const access = (
      await db.query(
        "select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') server from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1) order by 1",
        [changed.slice(0, 3)],
      )
    ).rows;
    expect(access).toEqual([
      {
        proname: "deleted_lead_ids",
        anon: false,
        authenticated: false,
        server: true,
      },
      {
        proname: "erase_deleted_leads_preview",
        anon: false,
        authenticated: false,
        server: true,
      },
      {
        proname: "team_owner_at",
        anon: false,
        authenticated: false,
        server: false,
      },
    ]);
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 070", async () => {
    const old = await database("070");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 070 before update 071.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("071");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.report_team_drilldown(uuid,jsonb)'::regprocedure) d",
        )
      ).rows[0].d;
      await other.exec(
        body.replace(
          "'followups_overdue_now','idle_now') then",
          "'idle_now','followups_overdue_now') then",
        ),
      );
      expect(await check(other)).toMatchObject({
        release_stage: expect.stringMatching(/^NOT READY/),
        edits_unexpected: 1,
      });
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 071 found an unexpected version of public.report_team_drilldown(uuid,jsonb)",
      );
      await other.exec("rollback");
      expect(
        (
          await other.query(
            "select to_regprocedure('public.deleted_lead_ids(uuid,text)') f",
          )
        ).rows[0].f,
      ).toBeNull();
    } finally {
      await other.close();
    }
  }, 120000);
});
