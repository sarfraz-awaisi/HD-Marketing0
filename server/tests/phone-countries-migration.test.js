import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 065 on a database at 064: no record, trigger or other function
// changes; the three lead lists answer exactly as before when no country is
// chosen (the administrator's agent pipeline only adds its temperatures);
// applying it again changes nothing; it refuses to run before 064 or on a
// function it does not expect, changing nothing.
const admin = "65100000-0000-4000-8000-000000000001",
  ali = "65100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "065_phone_countries.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = [
  "phone_country",
  "lead_phone_country",
  "admin_lead_list",
  "agent_lead_list",
  "admin_agent_pipeline",
];
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
          "../../supabase/check-phone-countries-065.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async (except = []) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'phone_country_rules') s",
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
      [changed.slice(2)],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
// The lists as the CRM asks for them, without a country.
const lists = async () => {
  const read = async (sql, args) => (await one(sql, args)).v;
  const pipeline = await read("select admin_agent_pipeline($1,$2,'{}') v", [
    admin,
    ali,
  ]);
  delete pipeline.temperatures;
  return {
    all: await read("select admin_lead_list($1,'{}') v", [admin]),
    allPk: await read(
      'select admin_lead_list($1,\'{"search":"Buyer","page":1}\') v',
      [admin],
    ),
    assigned: await read("select agent_lead_list($1,'{}') v", [ali]),
    agentPipeline: await read(
      'select agent_lead_list($1,\'{"view":"pipeline"}\') v',
      [ali],
    ),
    pipeline,
  };
};
beforeAll(async () => {
  db = await database("065");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (const [n, phone] of [
    [1, "+923001234567"],
    [2, "+971501234567"],
    [3, "+12025550123"],
  ]) {
    const lead = (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: `Buyer ${n}`, assigned_agent: ali }),
        phone,
        admin,
      ])
    ).id;
    await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      lead,
      ali,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - n * 60000).toISOString(),
        duration_seconds: 60,
        outcome: "Interested",
        notes: "",
        deal_tags: ["Hot lead"],
      }),
    ]);
  }
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 065 on a database at 064", () => {
  it("changes no record, trigger or other function, and the lists answer as before", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 064, ready for 065",
      lead_numbers: 3,
      country_rules: null,
      numbers_by_country: null,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot(changed);
    const answered = await lists();
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    expect(await lists()).toEqual(answered);
    expect(await check()).toMatchObject({
      release_stage: "at 065",
      lead_numbers: 3,
      country_rules: 245,
      numbers_by_country: '{"AE": 1, "PK": 1, "US": 1}',
      browser_access_must_be_0: 0,
      helper_access_must_be_0: 0,
    });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    const rules = await one(
      "select md5(string_agg(x::text,'|' order by x::text)) h from crm_private.phone_country_rules x",
    );
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(
      await one(
        "select md5(string_agg(x::text,'|' order by x::text)) h from crm_private.phone_country_rules x",
      ),
    ).toEqual(rules);
  });
  it("refuses to run before 064", async () => {
    const old = await database("064");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 064 before update 065.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("065");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.agent_lead_list(uuid,jsonb)'::regprocedure) d",
        )
      ).rows[0].d;
      // A function replacement: "$'" in a replacement string means "the text
      // after the match".
      await other.exec(
        body.replace(
          "and (v_status is null or m.ws_status=v_status)",
          () => "and (v_status is null or m.status=v_status)",
        ),
      );
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 065 found an unexpected version of public.agent_lead_list(uuid,jsonb)",
      );
      await other.exec("rollback");
      expect((await check(other)).release_stage).toBe("at 064, ready for 065");
      expect(
        (
          await other.query(
            "select to_regclass('crm_private.phone_country_rules') t",
          )
        ).rows[0].t,
      ).toBeNull();
    } finally {
      await other.close();
    }
  }, 120000);
});
