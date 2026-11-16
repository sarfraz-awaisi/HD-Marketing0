import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 069 on a database at 068: no record or trigger changes. Five
// functions are edited and four added, service-only; a lead deleted 20 days
// ago can no longer be restored, one deleted 10 days ago still can. Applying
// it again changes nothing; it refuses to run before 068 or on a function it
// does not expect, changing nothing.
const admin = "69100000-0000-4000-8000-000000000001";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "069_delete_leads_instantly.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = [
  "purge_deleted_leads",
  "deleted_leads_page",
  "restore_leads",
  "deleted_imports_page",
  "restore_lead_import",
];
const added = [
  "erase_lead",
  "lead_erasure_alert",
  "erase_deleted_leads",
  "erase_deleted_import",
];
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
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'lead_imports') s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [[...changed, ...added]],
    )
  ).s,
  grants: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)",
      [changed],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
let tenDays, twentyDays;
beforeAll(async () => {
  db = await database("069");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now())",
    [admin],
  );
  await db.query(
    "update profiles set active=true,role='admin',name='Owner' where id=$1",
    [admin],
  );
  const binned = async (name, days) =>
    (
      await one(
        "insert into leads(name,masked_phone,deleted_at,deleted_by,delete_reason,deleted_batch) values($1,'+92******000',now()-make_interval(days=>$2),$3,'Junk',gen_random_uuid()) returning id",
        [name, days, admin],
      )
    ).id;
  tenDays = await binned("Ten days", 10);
  twentyDays = await binned("Twenty days", 20);
}, 120000);
afterAll(async () => {
  await db?.close();
});
const bin = async (on = db) =>
  Object.fromEntries(
    (
      await one("select deleted_leads_page($1,1,100,'')->'data' d", [admin], on)
    ).d.map((r) => [r.name, r.days_left]),
  );

describe("update 069 on a database at 068", () => {
  it("changes no record, trigger or other function; 14 days to restore", async () => {
    expect(await bin()).toEqual({ "Ten days": 20, "Twenty days": 10 });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await bin()).toEqual({ "Ten days": 4, "Twenty days": 0 });
    for (const name of added) {
      const service = name.startsWith("erase_deleted");
      for (const role of ["anon", "authenticated", "service_role"])
        expect(
          (
            await one(
              "select bool_or(has_function_privilege($1,p.oid,'execute')) allowed from pg_proc p where p.proname=$2",
              [role, name],
            )
          ).allowed,
          `${role} on ${name}`,
        ).toBe(role === "service_role" && service);
    }
    expect(
      (
        await one(
          "select pg_get_function_arguments('public.purge_deleted_leads(integer)'::regprocedure) a",
        )
      ).a,
    ).toBe("p_retention integer DEFAULT 14");
  });
  it("restores a lead deleted 10 days ago, not one deleted 20 days ago", async () => {
    const result = (
      await one("select restore_leads($1,$2,'t') r", [
        [tenDays, twentyDays],
        admin,
      ])
    ).r;
    expect(
      Object.fromEntries(result.results.map((r) => [r.id, r.result])),
    ).toEqual({ [tenDays]: "restored", [twentyDays]: "failed" });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 068", async () => {
    const old = await database("068");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 068 before update 069.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("069");
    try {
      const body = (
        await one(
          "select pg_get_functiondef('public.restore_leads(uuid[],uuid,text)'::regprocedure) d",
          [],
          other,
        )
      ).d;
      await other.exec(
        body.replace("interval '30 days';", () => "interval '45 days';"),
      );
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 069 found an unexpected version of public.restore_leads",
      );
      await other.exec("rollback");
      expect(
        await one(
          "select to_regprocedure('public.erase_deleted_leads(uuid[],uuid,text)') f,pg_get_function_arguments('public.purge_deleted_leads(integer)'::regprocedure) a",
          [],
          other,
        ),
      ).toEqual({ f: null, a: "p_retention integer DEFAULT 30" });
    } finally {
      await other.close();
    }
  }, 120000);
});
