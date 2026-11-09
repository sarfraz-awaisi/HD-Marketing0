import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 057 on a database at 056: every existing row, function, trigger and
// the agent's own lists stay as they were; applying it again changes
// nothing; and 057 refuses to run before 056.
const admin = "57100000-0000-4000-8000-000000000001",
  ali = "57100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "057_admin_all_leads.sql";
const added = ["admin_lead_list", "assign_unassigned_leads"];
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
      new URL("../../supabase/check-admin-all-leads-057.sql", import.meta.url),
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
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1)",
      [added],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
  agent: await one(
    "select agent_lead_list($1,'{}'::jsonb) assigned,agent_lead_list($1,'{\"view\":\"pipeline\"}'::jsonb) pipeline",
    [ali],
  ),
});
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "057") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (const [name, phone, agent] of [
    ["Existing buyer", "+923008800001", ali],
    ["Waiting buyer", "+923008800002", null],
  ])
    await db.query("select create_lead($1::jsonb,$2,$3,'t')", [
      JSON.stringify({ name, assigned_agent: agent }),
      phone,
      admin,
    ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 057 on a database at 056", () => {
  it("adds the two server functions and changes nothing else", async () => {
    expect(await check()).toMatchObject({
      update_056_installed: true,
      release_stage: "at 056, ready for 057",
      existing_leads: 2,
      assigned_leads: 1,
      unassigned_leads: 1,
      server_functions: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 057",
      existing_leads: 2,
      assigned_leads: 1,
      unassigned_leads: 1,
      browser_function_access_must_be_0: 0,
      server_functions: 2,
    });
    expect(
      (await one("select admin_lead_list($1,'{}'::jsonb) r", [admin])).r,
    ).toMatchObject({
      count: 2,
      totals: { total: 2, assigned: 1, unassigned: 1 },
    });
  });
  it("changes nothing when applied again", async () => {
    const definitions = async () =>
      (
        await one(
          "select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.proname) s from pg_proc p where p.proname=any($1)",
          [added],
        )
      ).s;
    const before = {
      snapshot: await snapshot(),
      functions: await definitions(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      functions: await definitions(),
    }).toEqual(before);
  });
  it("refuses to run before update 056", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "056") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 056 before update 057.",
      );
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select count(*)::int n from pg_proc where proname=any($1)",
            [added],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await early.close();
    }
  });
});
