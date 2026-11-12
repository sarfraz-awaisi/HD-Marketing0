import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 062 on a database at 061: it only adds admin_distribute_leads. No
// row, other function, grant or trigger changes; applying it again changes
// nothing; and 062 refuses to run before 061.
const admin = "62100000-0000-4000-8000-000000000001",
  ali = "62100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "062_admin_lead_distribution.sql";
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
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-admin-lead-distribution-062.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>'admin_distribute_leads'",
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
beforeAll(async () => {
  db = await database("062");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (let n = 1; n <= 4; n++)
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({
        name: `Buyer ${n}`,
        assigned_agent: n % 2 ? ali : null,
      }),
      "+9230012200" + n,
      admin,
    ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 062 on a database at 061", () => {
  it("adds only the server's function and changes no record", async () => {
    const counts = {
      leads_not_deleted: 4,
      assigned_leads: 2,
      existing_assignments: 2,
    };
    expect(await check()).toMatchObject({
      release_stage: "at 061, ready for 062",
      active_agents: 1,
      ...counts,
      server_functions: 2,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 062",
      ...counts,
      browser_function_access_must_be_0: 0,
      server_functions: 3,
    });
  });
  it("changes nothing when applied again", async () => {
    const definition = async () =>
      (
        await one(
          "select md5(pg_get_functiondef('public.admin_distribute_leads(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure)) d",
        )
      ).d;
    const before = {
      snapshot: await snapshot(),
      definition: await definition(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      definition: await definition(),
    }).toEqual(before);
  });
  it("refuses to run before 061", async () => {
    const old = await database("061");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 061 before update 062.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
});
