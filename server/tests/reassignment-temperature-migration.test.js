import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 066 on a database at 065: no record, trigger, grant or other
// function changes; a lead never given to another agent keeps its
// classification everywhere; a reassigned one loses the earlier agent's in
// All leads and report drill-downs, its calls untouched; applying it again
// changes nothing; it refuses to run before 065 or on a function it does
// not expect, changing nothing.
const admin = "66100000-0000-4000-8000-000000000001",
  ali = "66100000-0000-4000-8000-000000000002",
  sara = "66100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "066_reassignment_temperature.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = ["admin_lead_list", "report_drill_row"];
async function database(upTo) {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await pg.exec(await migration(name));
  return pg;
}
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL(
          "../../supabase/check-reassignment-temperature-066.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async (except = []) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [except],
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
// The classification All leads and a report drill-down give a lead.
const seen = async (lead, name) => {
  let filter = "missing";
  for (const t of ["hot", "warm", "cold", "none"])
    if (
      (
        await one("select admin_lead_list($1,$2::jsonb)->>'count' n", [
          admin,
          JSON.stringify({ search: name, temperature: t }),
        ])
      ).n === "1"
    )
      filter = t;
  const drill = (
    await one(
      "select public.report_drill_row($1,'lead',null,now(),null,null,null)->>'temperature' t",
      [lead],
    )
  ).t;
  return { filter, drill };
};
const ids = {};
beforeAll(async () => {
  db = await database("066");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  for (const [key, n] of [
    ["kept", 1],
    ["moved", 2],
  ]) {
    ids[key] = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: `Buyer ${key}`, assigned_agent: ali }),
        "+9230006610" + n,
        admin,
      ])
    ).id;
    await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      ids[key],
      ali,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 60000).toISOString(),
        duration_seconds: 60,
        outcome: "Interested",
        notes: "",
        deal_tags: ["Hot lead"],
      }),
    ]);
  }
  await db.query("select admin_assign_leads($1::uuid[],$2,$3,'t')", [
    [ids.moved],
    admin,
    sara,
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 066 on a database at 065", () => {
  it("changes no record, trigger, grant or other function; only the reassigned lead loses the earlier agent's classification", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 065, ready for 066",
      calls_with_hot_warm_cold: 2,
      reassigned_leads_classified_by_earlier_agent: 1,
      transactions_open_over_1_min: 0,
    });
    expect(await seen(ids.kept, "Buyer kept")).toEqual({
      filter: "hot",
      drill: "Hot lead",
    });
    expect(await seen(ids.moved, "Buyer moved")).toEqual({
      filter: "hot",
      drill: "Hot lead",
    });
    const before = await snapshot(changed);
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    expect(await seen(ids.kept, "Buyer kept")).toEqual({
      filter: "hot",
      drill: "Hot lead",
    });
    expect(await seen(ids.moved, "Buyer moved")).toEqual({
      filter: "none",
      drill: null,
    });
    expect(await check()).toMatchObject({
      release_stage: "at 066",
      calls_with_hot_warm_cold: 2,
      reassigned_leads_classified_by_earlier_agent: 1,
    });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 065", async () => {
    const old = await database("065");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 065 before update 066.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("066");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.report_drill_row(uuid,text,uuid,timestamptz,numeric,text,integer)'::regprocedure) d",
        )
      ).rows[0].d;
      await other.exec(
        body.replace(
          "t.tag in ('Hot lead','Warm lead','Cold lead')",
          () => "t.tag in ('Hot lead','Warm lead')",
        ),
      );
      const list = (
        await other.query(
          "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) h",
        )
      ).rows[0].h;
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 066 found an unexpected version of public.report_drill_row",
      );
      await other.exec("rollback");
      expect(
        (
          await other.query(
            "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) h",
          )
        ).rows[0].h,
      ).toBe(list);
      expect((await check(other)).release_stage).toBe("at 065, ready for 066");
    } finally {
      await other.close();
    }
  }, 120000);
});
