import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 063 on a database at 062: no row or trigger changes; only its own
// functions, the ones it replaces and the checked edits; existing report
// numbers stay; applying it again changes nothing; it refuses to run before
// 062 or on a function it does not expect.
const admin = "63100000-0000-4000-8000-000000000001",
  ali = "63100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "063_admin_reports.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
// New (the first five), replaced and edited by 063; every other function
// must not change.
const changed = [
  "lead_not_connected",
  "report_team_records",
  "report_team",
  "report_team_days",
  "report_team_drilldown",
  "record_first_call",
  "call_activity",
  "crm_metrics",
  "admin_lead_list",
  "report_today_records",
  "report_agents",
  "report_records",
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
const check = async () =>
  one(
    await readFile(
      new URL("../../supabase/check-admin-reports-063.sql", import.meta.url),
      "utf8",
    ),
  );
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
      [changed.slice(5)],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
// Existing reports an administrator reads, for a month around now.
const reports = async () => {
  const from = new Date(Date.now() - 30 * 86400000).toISOString(),
    to = new Date(Date.now() + 86400000).toISOString();
  const read = async (sql, args) => (await one(sql, args)).v;
  return {
    metrics: await read("select crm_metrics($1,$2,$3) v", [admin, from, to]),
    leaderboard: await read("select crm_leaderboard($1,$2,$3) v", [
      admin,
      from,
      to,
    ]),
    sources: await read("select report_sources($1,$2,$3) v", [admin, from, to]),
    agents: await read("select report_agents($1,$2,$3) v", [admin, from, to]),
    funnel: await read("select report_funnel($1,$2,$3) v", [admin, from, to]),
    lost: await read("select report_lost($1,$2,$3) v", [admin, from, to]),
  };
};
beforeAll(async () => {
  db = await database("063");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (let n = 1; n <= 4; n++) {
    const lead = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({
          name: `Buyer ${n}`,
          assigned_agent: n % 2 ? ali : null,
        }),
        "+9230012300" + n,
        admin,
      ])
    ).id;
    if (n % 2)
      await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
        lead,
        ali,
        JSON.stringify({
          answered: true,
          started_at: new Date(Date.now() - n * 60000).toISOString(),
          duration_seconds: 60,
          outcome: "Interested",
          notes: "",
          deal_tags: [],
        }),
      ]);
  }
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 063 on a database at 062", () => {
  it("changes no record, trigger, grant or other function, and keeps existing report numbers", async () => {
    const counts = {
      leads_not_deleted: 4,
      existing_calls: 2,
      existing_assignments: 2,
    };
    expect(await check()).toMatchObject({
      release_stage: "at 062, ready for 063",
      ...counts,
      server_functions: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot(changed);
    const reported = await reports();
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    // The same numbers, plus the open pipeline for the dashboard.
    const now = await reports();
    expect(now.metrics.open_by_status).toEqual({ contacted: 2, new: 2 });
    delete now.metrics.open_by_status;
    expect(now).toEqual(reported);
    expect(await check()).toMatchObject({
      release_stage: "at 063",
      ...counts,
      browser_function_access_must_be_0: 0,
      server_functions: 3,
    });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 062", async () => {
    const old = await database("062");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 062 before update 063.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("063");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.report_today_records(text,uuid)'::regprocedure) d",
        )
      ).rows[0].d;
      await other.exec(
        body.replace(
          "where c.agent_id=p_agent and c.started_at>=v_start",
          "where c.agent_id=p_agent and c.started_at>v_start",
        ),
      );
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 063 found an unexpected version of public.report_today_records(text,uuid)",
      );
      await other.exec("rollback");
      expect(
        (
          await other.query(
            "select to_regprocedure('public.report_team(uuid,timestamptz,timestamptz)') f",
          )
        ).rows[0].f,
      ).toBeNull();
    } finally {
      await other.close();
    }
  }, 120000);
});
