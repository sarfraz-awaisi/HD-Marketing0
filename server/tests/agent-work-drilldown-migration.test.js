import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 051 on a database at 050: every existing row, every report's output
// and every other function must be unchanged; administrators' drill-downs
// return what they did; re-running 050 is the rollback; and 051 refuses to
// run before 050.
const admin = "51100000-0000-4000-8000-000000000001",
  ali = "51100000-0000-4000-8000-000000000002",
  sara = "51100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "051_agent_work_drilldown.sql";
const replaced = [
  "report_drilldown",
  "report_today_records",
  "report_today_value",
];
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
// Times relative to now: an agent may log a call only within the last 48 hours.
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const range = [hoursFromNow(-24 * 15), hoursFromNow(24 * 15)];
// The read-only release check, as it is run in the SQL Editor.
const check = async () =>
  (
    await db.query(
      await readFile(
        new URL("../../supabase/check-agent-work-051.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const drill = async (actor, query) =>
  (
    await one("select report_drilldown($1,$2::jsonb) r", [
      actor,
      JSON.stringify({ from: range[0], to: range[1], ...query }),
    ])
  ).r;
const definition = async () =>
  (
    await one(
      "select md5(pg_get_functiondef('public.report_drilldown(uuid,jsonb)'::regprocedure)) h",
    )
  ).h;
// Each table's row count and a hash of its rows; every other function's
// definition; and what every report returns to an administrator and an agent.
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1)",
      [replaced],
    )
  ).s,
  reports: await Promise.all(
    [admin, ali].map((actor) =>
      one(
        "select crm_metrics($1,$2,$3,null,null) summary,report_sources($1,$2,$3,null) sources,report_agents($1,$2,$3) agents,report_funnel($1,$2,$3,null,null) funnel,report_lost($1,$2,$3,null,null) lost,call_activity($1)->'agents' today",
        [actor, ...range],
      ),
    ),
  ),
});
// What administrators' drill-downs return, apart from 051's new "scope".
const adminDrills = async () =>
  Promise.all(
    [
      { report: "summary", metric: "completed_calls" },
      { report: "summary", metric: "leads", search: "buyer" },
      { report: "agents", metric: "calls", key: ali },
      { report: "funnel", metric: "stage", key: "new" },
    ].map(async (q) => {
      const { scope: _scope, ...rest } = await drill(admin, q);
      return rest;
    }),
  );
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "051") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  const lead = async (name) =>
    (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name, assigned_agent: ali }),
        "+92300123456" + name.length,
        admin,
      ])
    ).id;
  const kept = await lead("Existing buyer");
  const moved = await lead("Moved buyer");
  await db.query("update leads set created_at=$1", [hoursFromNow(-72)]);
  for (const [id, actor] of [
    [kept, admin],
    [moved, ali],
  ])
    await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      id,
      actor,
      JSON.stringify({
        answered: true,
        started_at: hoursFromNow(-1),
        duration_seconds: 60,
        outcome: "Interested",
      }),
    ]);
  await db.query("select assign_lead($1,$2,$3,'t')", [moved, admin, sara]);
  await db.query("select crm_mutate('followups',null,$1::jsonb,$2,'t')", [
    JSON.stringify({ lead_id: kept, due_at: hoursFromNow(96) }),
    ali,
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 051 on a database at 050", () => {
  let before050;
  it("lets agents open their numbers and changes no row, report or other function", async () => {
    expect(await check()).toMatchObject({
      update_050_installed: true,
      update_051_helpers_installed: false,
      release_stage: "at 050, ready for 051",
      existing_leads: 2,
      existing_calls: 2,
      active_agents: 2,
    });
    await expect(
      drill(ali, { report: "summary", metric: "leads" }),
    ).rejects.toThrow("Administrator access required");
    before050 = await definition();
    const before = await snapshot();
    const drills = await adminDrills();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await adminDrills()).toEqual(drills);
    expect(await check()).toMatchObject({
      release_stage: "at 051",
      update_051_helpers_installed: true,
      existing_leads: 2,
      existing_calls: 2,
      browser_function_access_must_be_0: 0,
      server_functions: 1,
      stable_api_function_must_be_0: 0,
    });
    const mine = await drill(ali, { report: "summary", metric: "leads" });
    expect(mine).toMatchObject({ scope: "own", count: 1, report_value: 1 });
    expect(mine.data[0].lead.name).toBe("Existing buyer");
  });
  it("works at once, and applying it again changes nothing", async () => {
    const calls = await drill(ali, {
      report: "agents",
      metric: "calls",
      key: ali,
    });
    expect(calls).toMatchObject({ count: 2, report_value: 2 });
    expect(calls.data.filter((r) => r.hidden)).toHaveLength(1);
    const today = await drill(admin, {
      report: "today",
      metric: "waiting",
      key: ali,
    });
    expect(today.count).toBe(Number(today.report_value));
    const before = {
      snapshot: await snapshot(),
      drilldown: await definition(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      drilldown: await definition(),
    }).toEqual(before);
  });
  it("is rolled back by applying 050 again", async () => {
    const before = await snapshot();
    await db.exec(await migration("050_report_drilldown.sql"));
    expect(await definition()).toBe(before050);
    expect(await snapshot()).toEqual(before);
    expect((await check()).release_stage).toBe("at 050, ready for 051");
    await expect(
      drill(ali, { report: "summary", metric: "leads" }),
    ).rejects.toThrow("Administrator access required");
    await db.exec(await migration(file));
    expect((await check()).release_stage).toBe("at 051");
  });
  it("refuses to run before update 050", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "050") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 050 before update 051.",
      );
      // The failed update leaves its transaction open; the session ends it.
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select to_regprocedure('public.report_today_records(text,uuid)') f",
          )
        ).rows[0].f,
      ).toBe(null);
    } finally {
      await early.close();
    }
  }, 120000);
});
