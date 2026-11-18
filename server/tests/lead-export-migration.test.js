import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 073 on a database at 072: read-only functions only. Every table,
// row, existing function and trigger stays as it was; the new functions are
// closed to browsers, and only the export functions are open to the CRM's
// server. Applying it again changes nothing; it refuses to run before 072.
const admin = "73100000-0000-4000-8000-000000000001",
  ali = "73100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "073_lead_export.sql";
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
// The read-only check the owner runs in production before and after 073.
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL("../../supabase/check-lead-export-073.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not like 'lead_export%'",
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
beforeAll(async () => {
  db = await database("073");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,role=case id when $1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' else 'Ali Agent' end",
    [admin],
  );
  await db.query(
    "select create_lead('{\"name\":\"Existing buyer\"}'::jsonb,'+923001731000',$1,'fixture')",
    [admin],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 073 on a database at 072", () => {
  it("adds read-only functions and changes nothing else", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 072, ready for 073",
      export_functions: 0,
      leads_with_no_file: 1,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 073",
      export_functions: 6,
    });
    const fns = (
      await db.query(
        "select proname,has_function_privilege('service_role',oid,'execute') server,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('anon',oid,'execute') anon from pg_proc where pronamespace='public'::regnamespace and proname like 'lead_export%' order by proname",
      )
    ).rows;
    expect(fns.map((f) => [f.proname, f.server, f.browser, f.anon])).toEqual([
      ["lead_export_assignments", true, false, false],
      ["lead_export_author", false, false, false],
      ["lead_export_calls", true, false, false],
      ["lead_export_ids", true, false, false],
      ["lead_export_match", false, false, false],
      ["lead_export_notes", true, false, false],
      ["lead_export_person", false, false, false],
      ["lead_export_rows", true, false, false],
      ["lead_export_sources", true, false, false],
      ["lead_export_temperature", false, false, false],
    ]);
    // The database API runs stable functions read-only, and the
    // administrator check locks a row: the functions it calls are volatile.
    expect(
      (
        await db.query(
          "select proname,provolatile from pg_proc where pronamespace='public'::regnamespace and proname in ('lead_export_sources','lead_export_ids','lead_export_rows','lead_export_calls','lead_export_notes','lead_export_assignments') order by proname",
        )
      ).rows.every((f) => f.provolatile === "v"),
    ).toBe(true);
    expect(
      (await one("select public.lead_export_ids($1,'{}'::jsonb) r", [admin])).r,
    ).toMatchObject({ count: 1, files: { none: 1 } });
    await expect(
      one("select public.lead_export_ids($1,'{}'::jsonb)", [ali]),
    ).rejects.toThrow();
  });

  it("changes nothing when applied again", async () => {
    const before = {
      ...(await snapshot()),
      exports: (
        await one(
          "select md5(string_agg(pg_get_functiondef(oid),'|' order by oid::regprocedure::text)) h from pg_proc where pronamespace='public'::regnamespace and proname like 'lead_export%'",
        )
      ).h,
    };
    await db.exec(await migration(file));
    expect({
      ...(await snapshot()),
      exports: (
        await one(
          "select md5(string_agg(pg_get_functiondef(oid),'|' order by oid::regprocedure::text)) h from pg_proc where pronamespace='public'::regnamespace and proname like 'lead_export%'",
        )
      ).h,
    }).toEqual(before);
  });

  it("refuses to run before 072", async () => {
    const old = await database("072");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 072 before update 073.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
});
