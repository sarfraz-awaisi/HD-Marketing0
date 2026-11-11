import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 060 on a database at 059: it only adds admin_assign_leads. No row,
// other function, grant or trigger changes; applying it again changes
// nothing; and 060 refuses to run before 059.
const admin = "60100000-0000-4000-8000-000000000001",
  ali = "60100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "060_admin_lead_reassignment.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-admin-lead-reassignment-060.sql",
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
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>'admin_assign_leads'",
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "060") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (let n = 1; n <= 6; n++) {
    const lead = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: `Buyer ${n}`, assigned_agent: n % 2 ? ali : null }),
        "+9230012000" + String(n).padStart(2, "0"),
        admin,
      ])
    ).id;
    if (n % 2)
      await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
        lead,
        ali,
        JSON.stringify({
          answered: false,
          started_at: new Date(Date.now() - n * 60000).toISOString(),
          duration_seconds: 0,
          outcome: "Number off",
          notes: "",
          deal_tags: [],
        }),
      ]);
  }
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 060 on a database at 059", () => {
  it("adds only the server's function and changes no record", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 059, ready for 060",
      leads_not_deleted: 6,
      assigned_leads: 3,
      existing_calls: 3,
      server_functions: 2,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 060",
      leads_not_deleted: 6,
      assigned_leads: 3,
      existing_calls: 3,
      browser_function_access_must_be_0: 0,
      server_functions: 3,
    });
  });
  it("changes nothing when applied again", async () => {
    const definition = async () =>
      (
        await one(
          "select md5(pg_get_functiondef('public.admin_assign_leads(uuid[],uuid,uuid,text)'::regprocedure)) d",
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
  it("refuses to run before update 059", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "059") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 059 before update 060.",
      );
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select to_regprocedure('public.admin_assign_leads(uuid[],uuid,uuid,text)') is null missing",
          )
        ).rows[0].missing,
      ).toBe(true);
    } finally {
      await early.close();
    }
  });
});
