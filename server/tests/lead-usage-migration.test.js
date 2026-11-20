import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 075 on a database at 074: All leads' list is edited and one
// read-only function is added. Every table, row, trigger and other function
// stays as it was; the new function is closed to browsers and open only to
// the CRM's server. Applying it again changes nothing; it refuses to run
// before 074 or on an All leads list it does not know, and then changes
// nothing.
const admin = "75100000-0000-4000-8000-000000000001",
  ali = "75100000-0000-4000-8000-000000000002",
  sara = "75100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "075_lead_usage_history.sql";
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
// The read-only check the owner runs in production before and after 075.
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL("../../supabase/check-lead-usage-075.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async (on = db) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
      [],
      on,
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace in ('public'::regnamespace,'crm_private'::regnamespace) and p.prokind='f' and p.proname not in ('admin_lead_list','admin_lead_agent_history')",
      [],
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
const edited = async (on = db) =>
  (
    await one(
      "select md5(string_agg(pg_get_functiondef(oid),'|' order by oid::regprocedure::text)) h,count(*)::int n from pg_proc where pronamespace='public'::regnamespace and proname in ('admin_lead_list','admin_lead_agent_history')",
      [],
      on,
    )
  ).h;
const list = async (query, on = db) =>
  (
    await one(
      "select public.admin_lead_list($1,$2::jsonb) r",
      [admin, JSON.stringify(query)],
      on,
    )
  ).r;
async function people(on) {
  await on.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await on.query(
    "update profiles set active=true,role=case id when $1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end",
    [admin, ali],
  );
}
beforeAll(async () => {
  db = await database("075");
  await people(db);
  // Ali, then Sara: used 2 times. Ali only: used once.
  const moved = (
    await one(
      "select (create_lead(jsonb_build_object('name','Moved buyer','assigned_agent',$2::text),'+923001751000',$1,'fixture')).id",
      [admin, ali],
    )
  ).id;
  await db.query("select assign_lead($1,$2,$3,'fixture')", [
    moved,
    admin,
    sara,
  ]);
  await db.query(
    "select create_lead(jsonb_build_object('name','Kept buyer','assigned_agent',$2::text),'+923001751001',$1,'fixture')",
    [admin, ali],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 075 on a database at 074", () => {
  it("edits All leads and adds the history function, and changes nothing else", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 074, ready for 075",
      history_function: 0,
      live_leads: 2,
      used_by_2: 1,
      used_by_3: 0,
      agents_removed_without_record: 0,
      agent_without_assignment_record: 0,
      transactions_open_over_1_min: 0,
    });
    // Before 075, the list refuses usage.
    await expect(list({ usage: 2 })).rejects.toThrow(
      "Choose valid lead filters",
    );
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 075",
      history_function: 1,
      used_by_2: 1,
    });
    const fn = await one(
      "select provolatile,has_function_privilege('service_role',oid,'execute') server,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('anon',oid,'execute') anon from pg_proc where oid='public.admin_lead_agent_history(uuid,uuid)'::regprocedure",
    );
    // The database API runs stable functions read-only, and the
    // administrator check locks a row: it is volatile.
    expect(fn).toEqual({
      provolatile: "v",
      server: true,
      browser: false,
      anon: false,
    });
    expect(
      await one(
        "select has_function_privilege('authenticated','public.admin_lead_list(uuid,jsonb)','execute') browser,has_function_privilege('service_role','public.admin_lead_list(uuid,jsonb)','execute') server",
      ),
    ).toEqual({ browser: false, server: true });
    const all = await list({});
    expect(all.usage).toEqual({ all: 2, 2: 1, 3: 0, 4: 0, 5: 0 });
    expect(all.data.map((l) => [l.name, l.agents_used])).toEqual([
      ["Kept buyer", 1],
      ["Moved buyer", 2],
    ]);
    expect((await list({ usage: 2 })).data.map((l) => l.name)).toEqual([
      "Moved buyer",
    ]);
    // Agents never get either.
    await expect(
      one("select public.admin_lead_list($1,'{}'::jsonb)", [ali]),
    ).rejects.toThrow();
    await expect(
      one(
        "select public.admin_lead_agent_history($1,(select id from leads where name='Moved buyer'))",
        [ali],
      ),
    ).rejects.toThrow();
  });

  it("changes nothing when applied again", async () => {
    const before = { ...(await snapshot()), edited: await edited() };
    await db.exec(await migration(file));
    expect({ ...(await snapshot()), edited: await edited() }).toEqual(before);
  });

  it("refuses to run before 074", async () => {
    const old = await database("074");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 074 before update 075.",
      );
    } finally {
      await old.close();
    }
  }, 120000);

  it("refuses an All leads list it does not know, and changes nothing", async () => {
    const other = await database("075");
    try {
      // A list changed by hand: one of the texts 075 edits is gone.
      const body = (
        await one(
          "select pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure) b",
          [],
          other,
        )
      ).b;
      await other.exec(body.replace("select o.rn,l.*,", "select o.rn, l.*,"));
      expect((await check(other)).release_stage).toBe(
        "NOT READY: admin_lead_list is not the version 075 edits",
      );
      const before = {
        ...(await snapshot(other)),
        edited: await edited(other),
      };
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 075 found an unexpected version of admin_lead_list",
      );
      await other.exec("rollback");
      expect({
        ...(await snapshot(other)),
        edited: await edited(other),
      }).toEqual(before);
      expect(
        await one(
          "select to_regprocedure('public.admin_lead_agent_history(uuid,uuid)') f",
          [],
          other,
        ),
      ).toEqual({ f: null });
    } finally {
      await other.close();
    }
  }, 120000);
});
