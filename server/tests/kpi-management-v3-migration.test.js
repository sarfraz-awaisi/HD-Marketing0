import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kpiSources, rulesProblem } from "../src/services/kpis.js";
// Update 076 on a database at 075 with the five KPIs of updates 070 and
// 072, an agents' own KPI and an answer: every KPI, version, answer and other row stays as
// it was (the versions gain an expected answer, Yes); only the KPI
// functions it edits change, and the new check is closed to everyone but
// the database itself. Applying it again changes nothing; it refuses to run
// before 075, or on a KPI function it does not know, and then changes
// nothing.
const admin = "76100000-0000-4000-8000-000000000001",
  ali = "76100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "076_kpi_management_v3.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
async function database(upTo) {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await pg.exec(await migration(name));
  return pg;
}
let db;
const one = async (text, args = [], on = db) =>
  (await on.query(text, args)).rows[0];
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL("../../supabase/check-kpi-management-076.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
const edited = [
  "kpi_version_json",
  "kpi_check",
  "kpi_save",
  "kpi_apply_rules",
  "kpi_admin_list",
  "kpi_rules_problem",
];
// Every row (the KPI versions as they were before 076), function and
// trigger.
const snapshot = async (on = db) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'kpi_versions') s",
      [],
      on,
    )
  ).s,
  versions: (
    await on.query(
      "select kpi_id,version,effective_from::text,frequency,answer_type,target,active,agent_ids,measure,created_by,created_at::text from kpi_versions order by kpi_id,version",
    )
  ).rows,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace in ('public'::regnamespace,'crm_private'::regnamespace) and p.prokind='f' and p.proname<>all($1)",
      [edited],
      on,
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
      [],
      on,
    )
  ).s,
});
const definitions = async (on = db) =>
  (
    await one(
      "select md5(string_agg(pg_get_functiondef(oid),'|' order by oid::regprocedure::text)) h from pg_proc where pronamespace='public'::regnamespace and proname=any($1)",
      [edited],
      on,
    )
  ).h;
async function seed(on) {
  await on.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await on.query(
    "update profiles set active=true,role=case id when $1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' else 'Ali Agent' end",
    [admin],
  );
  // The five KPIs are update 070's own (made CRM-filled by 072); one more
  // that agents answer, with an answer.
  const { own } = await one(
    "select public.kpi_save($1,null,$2::jsonb,'t',$3)->>'id' own",
    [
      admin,
      JSON.stringify({
        title: "Brochures shared",
        question: "How many brochures did you share?",
        frequency: "day",
        answer_type: "number",
        target: 2,
      }),
      "2026-11-02T09:00:00+05:00",
    ],
    on,
  );
  await on.query("select public.kpi_submit($1,'2026-11-02',$2::jsonb,'t',$3)", [
    ali,
    JSON.stringify([{ kpi_id: own, answer: 3 }]),
    "2026-11-02T17:00:00+05:00",
  ]);
}
beforeAll(async () => {
  db = await database("076");
  await seed(db);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 076 on a database at 075", () => {
  it("changes no KPI, answer or other row, and only the KPI functions it edits", async () => {
    const before = await check();
    expect(before).toMatchObject({
      release_stage: "at 075, ready for 076",
      rules_check_function: 0,
      kpis: 6,
      kpi_answers: 1,
      versions_expecting_no: null,
      transactions_open_over_1_min: 0,
    });
    const snap = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(snap);
    const after = await check();
    expect(after).toMatchObject({
      release_stage: "at 076",
      rules_check_function: 1,
      versions_expecting_no: 0,
      kpis_now: before.kpis_now,
      changes_waiting: before.changes_waiting,
    });
    // Every version expects Yes, as before.
    expect(
      (await one("select bool_and(expect_yes) yes from kpi_versions")).yes,
    ).toBe(true);
    // The check is the database's own; the server reaches it only through
    // the KPI functions, which stay closed to browsers.
    expect(
      await one(
        "select has_function_privilege('service_role','public.kpi_rules_problem(text,text,text,integer,boolean)','execute') server,has_function_privilege('authenticated','public.kpi_rules_problem(text,text,text,integer,boolean)','execute') browser,has_function_privilege('authenticated','public.kpi_save(uuid,uuid,jsonb,text,timestamp with time zone)','execute') save",
      ),
    ).toEqual({ server: false, browser: false, save: false });
  });

  it("changes nothing when applied again", async () => {
    const before = { ...(await snapshot()), defs: await definitions() };
    await db.exec(await migration(file));
    expect({ ...(await snapshot()), defs: await definitions() }).toEqual(
      before,
    );
  });

  it("refuses the same rules as the server, with the same reasons", async () => {
    const seen = new Set();
    for (const measure of Object.keys(kpiSources))
      for (const frequency of ["day", "week"])
        for (const answer_type of ["yes_no", "number"])
          for (const target of answer_type === "number"
            ? [1, 2, 3, 5, 6, 20, 21, 35, 36, 10000]
            : [1])
            for (const expected of ["yes", "no"]) {
              const js = rulesProblem(measure, {
                frequency,
                answer_type,
                target,
                expected,
              });
              const { p } = await one(
                "select public.kpi_rules_problem($1,$2,$3,$4,$5) p",
                [
                  measure,
                  frequency,
                  answer_type,
                  target,
                  answer_type === "number" || expected === "yes",
                ],
              );
              expect(
                p,
                `${measure} ${frequency} ${answer_type} ${target} ${expected}`,
              ).toBe(js);
              if (p) seen.add(p);
            }
    // Each reason was reached.
    expect(seen.size).toBe(5);
  });

  it("refuses to run before 075", async () => {
    const old = await database("075");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 075 before update 076.",
      );
    } finally {
      await old.close();
    }
  }, 120000);

  it("refuses a KPI function it does not know, and changes nothing", async () => {
    const other = await database("076");
    try {
      await seed(other);
      // A rules function changed by hand.
      const body = (
        await one(
          "select pg_get_functiondef('public.kpi_apply_rules(uuid,jsonb,uuid,date)'::regprocedure) b",
          [],
          other,
        )
      ).b;
      await other.exec(
        body.replace(
          " nxt.active=coalesce((p_rules->>'active')::boolean,latest.active);",
          " nxt.active=coalesce((p_rules->>'active')::boolean, latest.active);",
        ),
      );
      expect((await check(other)).release_stage).toBe(
        "NOT READY: a KPI function is not the version 076 edits",
      );
      const before = {
        ...(await snapshot(other)),
        defs: await definitions(other),
      };
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 076 found an unexpected version of public.kpi_apply_rules",
      );
      await other.exec("rollback");
      expect({
        ...(await snapshot(other)),
        defs: await definitions(other),
      }).toEqual(before);
      expect(
        await one(
          "select count(*)::int n from information_schema.columns where table_name='kpi_versions' and column_name='expect_yes'",
          [],
          other,
        ),
      ).toEqual({ n: 0 });
    } finally {
      await other.close();
    }
  }, 120000);
});
