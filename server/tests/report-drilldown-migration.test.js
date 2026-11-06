import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 050 on a database at 048, without the dealer update 049: the two can
// be released in either order. Every existing row, every report's output and
// every existing function must be unchanged, and 050 must refuse to run
// before 048.
const admin = "50100000-0000-4000-8000-000000000001",
  agent = "50100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "050_report_drilldown.sql";
const added = [
  "report_person",
  "report_recorded_by",
  "report_call_json",
  "report_records",
  "report_metric_value",
  "report_drill_row",
  "report_drilldown",
];
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
// Times relative to now: an administrator may log a call only within the last
// 30 days.
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const range = [hoursFromNow(-24 * 15), hoursFromNow(24 * 15)];
// The read-only release check, as it is run in the SQL Editor.
const check = async () =>
  (
    await db.query(
      await readFile(
        new URL(
          "../../supabase/check-report-drilldown-050.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
// Each table's row count and a hash of its rows; each existing function's
// definition; and what every report returns.
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1)",
      [added],
    )
  ).s,
  reports: await one(
    "select crm_metrics($1,$2,$3,null,null) summary,report_sources($1,$2,$3,null) sources,report_agents($1,$2,$3) agents,report_funnel($1,$2,$3,null,null) funnel,report_lost($1,$2,$3,null,null) lost",
    [admin, ...range],
  ),
});
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "049") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, agent],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  const lead = (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name: "Existing buyer", assigned_agent: agent }),
      "+923001234567",
      admin,
    ])
  ).id;
  await db.query("update leads set created_at=$1", [hoursFromNow(-72)]);
  await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    admin,
    JSON.stringify({
      answered: true,
      started_at: hoursFromNow(-1),
      duration_seconds: 60,
      outcome: "Interested",
    }),
  ]);
  await db.query("select crm_mutate('followups',null,$1::jsonb,$2,'t')", [
    JSON.stringify({ lead_id: lead, due_at: hoursFromNow(96) }),
    agent,
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 050 on a database at 048", () => {
  it("adds the drill-down and leaves every row, report and existing function unchanged", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 048 or 049, ready for 050",
      update_049_installed: false,
      existing_leads: 1,
      existing_calls: 1,
      calls_without_recorded_caller: 0,
      activity_index: 0,
    });
    // None of the new names exists yet, so nothing existing is replaced.
    expect(
      (
        await one(
          "select count(*)::int n from pg_proc where proname=any($1) or proname in (select indexname from pg_indexes where indexname='audit_log_activity_records')",
          [added],
        )
      ).n,
    ).toBe(0);
    const before = await snapshot();
    await db.exec(await migration(file));
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 050",
      existing_leads: 1,
      existing_calls: 1,
      activity_index: 1,
      browser_function_access_must_be_0: 0,
      server_functions: 1,
      stable_api_function_must_be_0: 0,
    });
    expect(
      (
        await one(
          "select count(*)::int n from pg_indexes where indexname='audit_log_activity_records'",
        )
      ).n,
    ).toBe(1);
  });
  it("works at once, and applying it again changes nothing", async () => {
    const result = (
      await one("select report_drilldown($1,$2::jsonb) r", [
        admin,
        JSON.stringify({
          report: "summary",
          metric: "completed_calls",
          from: range[0],
          to: range[1],
        }),
      ])
    ).r;
    expect(result).toMatchObject({ count: 1, report_value: 1 });
    expect(result.data[0].record).toMatchObject({
      recorded_agent: { id: agent },
      caller: { id: admin, role: "admin" },
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before update 048", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "048") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 048 before update 050.",
      );
      // The failed update leaves its transaction open; the session ends it.
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select to_regprocedure('public.report_drilldown(uuid,jsonb)') f",
          )
        ).rows[0].f,
      ).toBe(null);
    } finally {
      await early.close();
    }
  }, 120000);
});
