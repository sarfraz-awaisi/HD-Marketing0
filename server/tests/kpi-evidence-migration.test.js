import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentDay, kpiReport, kpiRpc } from "../src/services/kpis.js";
// Update 072 on a database at 071 with update 070's five KPIs: every
// existing row and every other function stays as it was; the KPIs the CRM
// can fill in switch over, now when no one answered under their current
// rules, otherwise from the next period, so answers already given stay as
// they are; a KPI an administrator reworded is left as it is. Two new
// tables, closed to browsers, and a private bucket are added. Applying it
// again changes nothing; it refuses to run before 071, or over functions
// that differ from 070's.
const admin = "72100000-0000-4000-8000-000000000001",
  ali = "72100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "072_kpi_evidence.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = ["kpis", "kpi_versions", "audit_log", "buckets"];
const added = ["kpi_evidence", "property_verifications"];
const helpers = ["inventory_owner_details"];
async function database(upTo) {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await pg.exec(await migration(name));
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await pg.query(
    "update profiles set active=true,role=case id when $1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' else 'Ali Agent' end",
    [admin],
  );
  return pg;
}
let db;
const one = async (text, args = [], on = db) =>
  (await on.query(text, args)).rows[0];
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>all($1)) s",
      [[...changed, ...added]],
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not like 'kpi%' and p.proname<>all($1)",
      [helpers],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
// The read-only check the owner runs in production before and after 072.
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL("../../supabase/check-kpi-evidence-072.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
const kpis = async (on = db) =>
  (
    await on.query(
      "select k.title,k.question,v.version,v.effective_from::text e,v.frequency,v.target,v.measure from kpis k join kpi_versions v on v.kpi_id=k.id order by k.position,v.version",
    )
  ).rows;
let today, monday;
beforeAll(async () => {
  db = await database("072");
  ({ today, monday } = await one(
    "select public.kpi_today(now())::text today,public.kpi_week_start(public.kpi_today(now()))::text monday",
  ));
  const id = async (title) =>
    (await one("select id from kpis where title=$1", [title])).id;
  // Ali answered the social media KPI today, under 070's rules.
  await db.query("select public.kpi_submit($1,$2,$3::jsonb,'t',now())", [
    ali,
    today,
    JSON.stringify([
      { kpi_id: await id("Social media activity"), answer: true },
    ]),
  ]);
  // An administrator reworded the video KPI.
  await db.query("select public.kpi_save($1,$2,$3::jsonb,'t',now())", [
    admin,
    await id("HD Marketing video"),
    JSON.stringify({ question: "How many HD videos did you post?" }),
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});
const plusDays = (day, n) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

describe("update 072 on a database at 071", () => {
  it("keeps every existing record and function, and switches the KPIs the CRM can fill in", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 071, ready for 072",
      edits_ready: 7,
      edits_applied: 0,
      edits_unexpected: 0,
      // The reworded video KPI is not found.
      kpis_found: 4,
      kpis_measured: 0,
      measured_from: null,
      answers_this_period:
        "Assigned calls answered: 0, Project visits: 0, Social media activity: 1, Verified inventory with owner details: 0",
      kpi_evidence: 0,
      evidence_bucket_private: null,
    });
    const before = await snapshot();
    const answers = await one(
      "select md5(string_agg(s::text,'|')) h from kpi_submissions s",
    );
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 072",
      edits_ready: 0,
      edits_applied: 7,
      edits_unexpected: 0,
      kpis_found: 4,
      kpis_measured: 4,
      measured_from: `calls from ${today}, inventory from ${today}, social from ${plusDays(today, 1)}, visits from ${monday}`,
      kpi_evidence: 0,
      evidence_bucket_private: true,
    });
    expect(
      await one("select md5(string_agg(s::text,'|')) h from kpi_submissions s"),
    ).toEqual(answers);
    expect(
      (await kpis()).map((k) => [
        k.title,
        k.question,
        k.version,
        k.e,
        k.measure,
      ]),
    ).toEqual([
      // Nobody answered under the current rules: filled in from now.
      [
        "Assigned calls answered",
        "Did you answer your assigned calls today?",
        1,
        today,
        "calls",
      ],
      // Answered today: today stays as answered, the CRM from tomorrow.
      [
        "Social media activity",
        "Did you complete your social media activity today?",
        1,
        today,
        "self",
      ],
      [
        "Social media activity",
        "Did you complete your social media activity today?",
        2,
        plusDays(today, 1),
        "social",
      ],
      // Weekly: "today" is gone from the question.
      [
        "Project visits",
        "How many project visits did you complete?",
        1,
        monday,
        "visits",
      ],
      [
        "Verified inventory with owner details",
        "How many verified property inventories with owner details did you complete today?",
        1,
        today,
        "inventory",
      ],
      // Reworded by an administrator: left as it is.
      [
        "HD Marketing video",
        "How many HD videos did you post?",
        1,
        monday,
        "self",
      ],
    ]);
    expect(
      (
        await db.query(
          "select metadata->>'measure' m from audit_log where action='kpi.measured_by_crm' order by id",
        )
      ).rows.map((r) => r.m),
    ).toEqual(["calls", "social", "visits", "inventory"]);
    // A private bucket for visit photos: images up to 5 MB.
    expect(
      await one(
        "select public,file_size_limit::int size,allowed_mime_types t from storage.buckets where id='kpi-evidence'",
      ),
    ).toEqual({
      public: false,
      size: 5242880,
      t: ["image/jpeg", "image/png", "image/webp"],
    });
    // Closed to browsers; only the server's functions use them.
    for (const table of added) {
      expect(
        (
          await one(
            "select relrowsecurity rls from pg_class where oid=$1::regclass",
            ["public." + table],
          )
        ).rls,
      ).toBe(true);
      for (const role of ["anon", "authenticated"])
        expect(
          (
            await one("select has_table_privilege($1,$2,'select') ok", [
              role,
              "public." + table,
            ])
          ).ok,
        ).toBe(false);
    }
    for (const role of ["anon", "authenticated"])
      expect(
        (
          await one(
            "select bool_or(has_function_privilege($1,p.oid,'execute')) ok from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'kpi%' or p.proname=any($2))",
            [role, helpers],
          )
        ).ok,
      ).toBe(false);
    // The helpers only from the CRM's own functions.
    expect(
      (
        await one(
          "select bool_or(has_function_privilege('service_role',p.oid,'execute')) ok from pg_proc p where p.proname in ('kpi_measures','kpi_evidence_json','inventory_owner_details')",
        )
      ).ok,
    ).toBe(false);
  });

  it("changes nothing when applied again", async () => {
    const state = async () => ({
      ...(await snapshot()),
      kpis: await kpis(),
      audit: (await one("select count(*)::int n from audit_log")).n,
      functions: (
        await one(
          "select md5(string_agg(pg_get_functiondef(oid),'|' order by oid::regprocedure::text)) h from pg_proc where pronamespace='public'::regnamespace and proname like 'kpi%'",
        )
      ).h,
    });
    const before = await state();
    await db.exec(await migration(file));
    expect(await state()).toEqual(before);
  });

  it("the new code works on a database still at 071", async () => {
    const old = await database("072");
    try {
      const facts = (
        await one(
          "select public.kpi_facts($1,$2,$2,null,now()) r",
          [admin, today],
          old,
        )
      ).r;
      expect(facts.measures).toBeUndefined();
      // Every KPI reads as answered by the agent, as before 072.
      expect(
        agentDay(facts, ali, today).kpis.map((k) => [k.measure, k.editable]),
      ).toEqual(Array(5).fill(["self", true]));
      expect(kpiReport(facts, today, today).kpis).toHaveLength(5);
      // The evidence pages say which update they need.
      await expect(
        kpiRpc(
          {
            rpc: async () => ({
              error: { code: "PGRST202", message: "not found" },
            }),
          },
          "kpi_evidence_list",
          {},
        ),
      ).rejects.toMatchObject({
        status: 503,
        message: "Daily KPIs need CRM database update 072.",
      });
    } finally {
      await old.close();
    }
  }, 120000);

  it("refuses to run before 071", async () => {
    const old = await database("071");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 071 before update 072.",
      );
    } finally {
      await old.close();
    }
  }, 120000);

  it("stops, changing nothing, when a function it edits differs from 070's", async () => {
    const other = await database("072");
    try {
      await other.exec(
        "do $$ begin execute replace(pg_get_functiondef('public.kpi_submit(uuid,date,jsonb,text,timestamptz)'::regprocedure),'Daily KPIs can only be answered on the day','Answer daily KPIs on the day'); end $$;",
      );
      expect(await check(other)).toMatchObject({
        release_stage: expect.stringMatching(/^NOT READY/),
        edits_ready: 6,
        edits_unexpected: 1,
      });
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 072 found an unexpected version of public.kpi_submit",
      );
      await other.exec("rollback");
      expect(
        await one(
          "select to_regclass('public.kpi_evidence') t,(select count(*)::int from information_schema.columns where table_name='kpi_versions' and column_name='measure') m",
          [],
          other,
        ),
      ).toEqual({ t: null, m: 0 });
    } finally {
      await other.close();
    }
  }, 120000);
});
