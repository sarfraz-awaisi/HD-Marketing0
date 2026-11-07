import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 053 on a database at 052: every existing row, every other function
// and trigger and every report's output must be unchanged; the call rules
// accept Number off only for a call that did not connect; applying it again
// changes nothing; and 053 refuses to run before 052.
const admin = "53100000-0000-4000-8000-000000000001",
  ali = "53100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "053_number_off_and_agent_notes.sql";
const replaced = ["log_manual_call", "agent_lead_list"];
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
      new URL("../../supabase/check-number-off-053.sql", import.meta.url),
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
      [replaced],
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
});
const logCall = (lead, data) =>
  db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    ali,
    JSON.stringify({
      answered: false,
      started_at: hoursFromNow(-1),
      duration_seconds: 0,
      outcome: "Number off",
      ...data,
    }),
  ]);
let lead;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "053") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  lead = (
    await one("select (create_lead($1::jsonb,'+923008800001',$2,'t')).id", [
      JSON.stringify({ name: "Existing buyer", assigned_agent: ali }),
      admin,
    ])
  ).id;
  await logCall(lead, {
    answered: true,
    duration_seconds: 60,
    outcome: "Interested",
    notes: "Wants a 10 marla house",
    deal_tags: ["Warm lead"],
  });
  await logCall(lead, { outcome: "No answer" });
  // Written as the server writes notes, so the audit log names Ali.
  await db.query(
    "select crm_mutate('notes',null,jsonb_build_object('lead_id',$1::uuid,'body','Prefers DHA'),$2,'t')",
    [lead, ali],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 053 on a database at 052", () => {
  it("accepts Number off and changes no row, other function, trigger or report", async () => {
    expect(await check()).toMatchObject({
      update_052_installed: true,
      release_stage: "at 052, ready for 053",
      existing_calls: 2,
      number_off_calls: 0,
    });
    await expect(logCall(lead, {})).rejects.toThrow();
    // The failed call ran in its own statement; nothing was written.
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 053",
      existing_leads: 1,
      existing_calls: 2,
      existing_notes: 1,
      answered_number_off_must_be_0: 0,
      browser_function_access_must_be_0: 0,
      server_functions: 2,
      stable_api_function_must_be_0: 0,
    });
    await logCall(lead, {});
    await expect(
      logCall(lead, { answered: true, duration_seconds: 60 }),
    ).rejects.toThrow("Choose a valid duration and outcome");
    expect(
      await one(
        "select status,answered,outcome from calls where outcome='Number off'",
      ),
    ).toEqual({ status: "failed", answered: false, outcome: "Number off" });
    const [row] = (
      await one("select agent_lead_list($1,$2::jsonb)->'data' d", [
        ali,
        JSON.stringify({ view: "pipeline" }),
      ])
    ).d;
    expect(row).toMatchObject({
      name: "Existing buyer",
      temperature: "warm",
      last_call_outcome: "Number off",
      last_call_connected: false,
      note: "Prefers DHA",
    });
  });
  it("changes nothing when applied again", async () => {
    const before = {
      snapshot: await snapshot(),
      functions: (
        await one(
          "select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.proname) s from pg_proc p where p.proname=any($1)",
          [replaced],
        )
      ).s,
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      functions: (
        await one(
          "select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.proname) s from pg_proc p where p.proname=any($1)",
          [replaced],
        )
      ).s,
    }).toEqual(before);
  });
  it("refuses to run before update 052", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "052") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 052 before update 053.",
      );
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select pg_get_constraintdef(oid) d from pg_constraint where conname='calls_outcome_check'",
          )
        ).rows[0].d,
      ).not.toContain("Number off");
    } finally {
      await early.close();
    }
  }, 120000);
});
