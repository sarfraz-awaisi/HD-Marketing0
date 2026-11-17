import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 070 on a database at 069 that has sales targets: every existing
// table, row, function and trigger stays as it was (sales targets included);
// three new tables, closed to browsers, and the five KPIs are added. Applying
// it again changes nothing; it refuses to run before 069.
const admin = "70100000-0000-4000-8000-000000000001",
  ali = "70100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "070_daily_kpis.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const added = ["kpis", "kpi_versions", "kpi_submissions"];
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
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>all($1)) s",
      [added],
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not like 'kpi%'",
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
beforeAll(async () => {
  db = await database("070");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,role=case id when $1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' else 'Ali Agent' end",
    [admin],
  );
  // Sales targets set before 070.
  await db.query(
    "insert into targets(agent_id,period,period_start,month,calls,visits) values($1,'month','2026-11-01','2026-11-01',100,8),($1,'week','2026-11-09','2026-11-01',25,2)",
    [ali],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 070 on a database at 069", () => {
  it("keeps every existing record (sales targets too) and adds the KPI tables and five KPIs", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await db.query(
          "select calls,visits,period from targets order by period_start",
        )
      ).rows,
    ).toEqual([
      { calls: 100, visits: 8, period: "month" },
      { calls: 25, visits: 2, period: "week" },
    ]);
    expect(
      (
        await db.query(
          "select k.position,k.title,v.frequency,v.answer_type,v.target,v.active,v.agent_ids,extract(isodow from v.effective_from)::int dow,v.effective_from<=(now() at time zone 'Asia/Karachi')::date started from kpis k join kpi_versions v on v.kpi_id=k.id order by k.position",
        )
      ).rows.map((r) => [
        r.position,
        r.title,
        r.frequency,
        r.answer_type,
        r.target,
        r.active,
        r.agent_ids,
        r.frequency === "week" ? r.dow : "any",
        r.started,
      ]),
    ).toEqual([
      [
        1,
        "Assigned calls answered",
        "day",
        "yes_no",
        1,
        true,
        null,
        "any",
        true,
      ],
      [2, "Social media activity", "day", "yes_no", 1, true, null, "any", true],
      [3, "Project visits", "week", "number", 3, true, null, 1, true],
      [
        4,
        "Verified inventory with owner details",
        "day",
        "number",
        1,
        true,
        null,
        "any",
        true,
      ],
      [5, "HD Marketing video", "week", "number", 1, true, null, 1, true],
    ]);
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
            "select bool_or(has_function_privilege($1,p.oid,'execute')) ok from pg_proc p where p.proname like 'kpi%'",
            [role],
          )
        ).ok,
      ).toBe(false);
  });
  it("changes nothing when applied again", async () => {
    const before = {
      ...(await snapshot()),
      kpis: (
        await one(
          "select md5(string_agg(k::text||v::text,'|' order by k.position)) h from kpis k join kpi_versions v on v.kpi_id=k.id",
        )
      ).h,
    };
    await db.exec(await migration(file));
    expect({
      ...(await snapshot()),
      kpis: (
        await one(
          "select md5(string_agg(k::text||v::text,'|' order by k.position)) h from kpis k join kpi_versions v on v.kpi_id=k.id",
        )
      ).h,
    }).toEqual(before);
  });
  it("refuses to run before 069", async () => {
    const old = await database("069");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 069 before update 070.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
});
