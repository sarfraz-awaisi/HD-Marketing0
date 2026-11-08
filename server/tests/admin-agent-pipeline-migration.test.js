import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 055 on a database at 054: every existing row, every existing
// function and trigger and every report's output must be unchanged, the
// agent's own pipeline included; applying it again changes nothing; and 055
// refuses to run before 053.
const admin = "55100000-0000-4000-8000-000000000001",
  ali = "55100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "055_admin_agent_pipeline.sql";
const added = [
  "agent_spoken_leads",
  "agent_pipeline_numbers",
  "admin_pipeline_agents",
  "admin_agent_pipeline",
  "agent_pipeline_attribution",
];
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const range = [hoursFromNow(-24 * 15), hoursFromNow(24 * 15)];
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
// The read-only release check, as it is run in the SQL Editor.
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-admin-agent-pipeline-055.sql",
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
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1)",
      [added],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
  reports: await Promise.all(
    [admin, ali].map((actor) =>
      one(
        "select crm_metrics($1,$2,$3,null,null) summary,report_agents($1,$2,$3) agents,report_funnel($1,$2,$3,null,null) funnel,call_activity($1)->'agents' today",
        [actor, ...range],
      ),
    ),
  ),
  pipeline: (
    await one("select agent_lead_list($1,$2::jsonb) p", [
      ali,
      JSON.stringify({ view: "pipeline" }),
    ])
  ).p,
});
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "055") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  const lead = (
    await one("select (create_lead($1::jsonb,'+923008800001',$2,'t')).id", [
      JSON.stringify({ name: "Existing buyer", assigned_agent: ali }),
      admin,
    ])
  ).id;
  await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    ali,
    JSON.stringify({
      answered: true,
      started_at: hoursFromNow(-1),
      duration_seconds: 60,
      outcome: "Interested",
      notes: "Wants a 10 marla house",
      deal_tags: ["Warm lead"],
    }),
  ]);
  await db.query(
    "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()-interval '1 hour')",
    [lead, ali],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 055 on a database at 054", () => {
  it("adds the three server functions and changes no row, other function, trigger or report", async () => {
    expect(await check()).toMatchObject({
      update_053_installed: true,
      release_stage: "at 053 or 054, ready for 055",
      existing_leads: 1,
      existing_calls: 1,
      existing_followups: 1,
      agents: 1,
      answered_calls_without_recorder: 0,
      server_functions: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 055",
      existing_leads: 1,
      existing_calls: 1,
      existing_notes: 0,
      existing_followups: 1,
      browser_function_access_must_be_0: 0,
      server_helper_access_must_be_0: 0,
      server_functions: 3,
    });
    expect(
      (
        await one(
          "select count(*)::int n from pg_proc where proname=any($1) and provolatile='v' and proname like 'admin_%'",
          [added],
        )
      ).n,
    ).toBe(2);
    const result = (
      await one("select admin_agent_pipeline($1,$2,'{}'::jsonb) r", [
        admin,
        ali,
      ])
    ).r;
    expect(result.summary).toMatchObject({
      contacted: 1,
      warm: 1,
      followups_due: 1,
      followups_overdue: 1,
    });
    expect(result.data[0]).toMatchObject({
      name: "Existing buyer",
      temperature: "warm",
      note: "Wants a 10 marla house",
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
  it("refuses to run before update 053", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "053") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 053 before update 055.",
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
  }, 120000);
});
