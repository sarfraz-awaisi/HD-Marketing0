import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 052 on a database at 051: every existing row, every other function
// and trigger and every report's output must be unchanged; existing file
// leads get their numbers in import order; applying it again changes
// nothing; new imports are numbered; and 052 refuses to run before 051.
const admin = "52100000-0000-4000-8000-000000000001",
  ali = "52100000-0000-4000-8000-000000000002",
  sara = "52100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "052_agent_lead_pipeline.sql";
const added = ["agent_lead_list", "number_file_lead"];
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const range = [hoursFromNow(-24 * 15), hoursFromNow(24 * 15)];
let db,
  phoneNo = 0;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const rpc = async (name, args) =>
  (
    await one(
      `select to_jsonb(public.${name}(${Object.keys(args)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(",")})) v`,
      Object.values(args),
    )
  ).v;
// Each table's row count and a hash of its rows (the new numbers table
// aside); every other function and trigger; and every report's output.
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'lead_file_rows') s",
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
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal and tgname<>'number_file_lead'",
    )
  ).s,
  reports: await Promise.all(
    [admin, ali].map((actor) =>
      one(
        "select crm_metrics($1,$2,$3,null,null) summary,report_sources($1,$2,$3,null) sources,report_agents($1,$2,$3) agents,report_funnel($1,$2,$3,null,null) funnel,call_activity($1)->'agents' today",
        [actor, ...range],
      ),
    ),
  ),
});
// The read-only release check, as it is run in the SQL Editor.
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-agent-lead-pipeline-052.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const numbers = async () =>
  (
    await one(
      "select coalesce(jsonb_object_agg(l.name,r.file_row),'{}') s from crm_private.lead_file_rows r join leads l on l.id=r.lead_id",
    )
  ).s;
async function importFile(name, people, agent = ali) {
  const result = await rpc("import_leads", {
    p_file_name: name,
    p_format: "csv",
    p_worksheet: null,
    p_rows: JSON.stringify(
      people.map((person, i) => ({
        row: i + 2,
        data: { name: person, source: "CSV" },
        phone: "+9230066" + String(++phoneNo).padStart(5, "0"),
      })),
    ),
    p_actor: admin,
    p_request: "t",
  });
  await rpc("assign_lead_import", {
    p_import: result.import_id,
    p_agent: agent,
    p_actor: admin,
    p_request: "t",
  });
  return result.import_id;
}
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "052") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  await importFile("Lahore.csv", ["Asad", "Bilal", "Chand"]);
  await importFile("Karachi.csv", ["Danish", "Ehsan"], sara);
  await one("select (create_lead($1::jsonb,'+923007700001',$2,'t')).id", [
    JSON.stringify({ name: "Walk-in", assigned_agent: ali }),
    admin,
  ]);
  const bilal = (await one("select id from leads where name='Bilal'")).id;
  await rpc("delete_leads", {
    p_lead_ids: `{${bilal}}`,
    p_actor: admin,
    p_reason: "Duplicate customer",
    p_request: "t",
  });
  const asad = (await one("select id from leads where name='Asad'")).id;
  await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    asad,
    ali,
    JSON.stringify({
      answered: true,
      started_at: hoursFromNow(-1),
      duration_seconds: 60,
      outcome: "Interested",
      deal_tags: ["Hot lead"],
    }),
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 052 on a database at 051", () => {
  it("numbers existing file leads in import order and changes nothing else", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 051, ready for 052",
      file_leads: 5,
      numbered_file_leads: null,
      number_trigger: 0,
      server_functions: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 052",
      existing_leads: 6,
      file_leads: 5,
      numbered_file_leads: 5,
      number_trigger: 1,
      browser_function_access_must_be_0: 0,
      server_functions: 1,
      stable_api_function_must_be_0: 0,
    });
    // Bilal is in the bin and keeps #2, so Chand stays #3 if he returns.
    expect(await numbers()).toEqual({
      Asad: 1,
      Bilal: 2,
      Chand: 3,
      Danish: 1,
      Ehsan: 2,
    });
    const pipeline = await rpc("agent_lead_list", {
      p_actor: ali,
      p_query: JSON.stringify({ view: "pipeline" }),
    });
    expect(
      pipeline.data.map((r) => [r.name, r.file_row, r.temperature]),
    ).toEqual([["Asad", 1, "hot"]]);
  });
  it("changes nothing when applied again, and numbers new imports", async () => {
    const before = { snapshot: await snapshot(), numbers: await numbers() };
    await db.exec(await migration(file));
    expect({ snapshot: await snapshot(), numbers: await numbers() }).toEqual(
      before,
    );
    await importFile("Multan.csv", ["Fahad", "Ghazal"]);
    expect(await numbers()).toMatchObject({ Fahad: 1, Ghazal: 2, Asad: 1 });
  });
  it("refuses to run before update 051", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "051") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 051 before update 052.",
      );
      // The failed update leaves its transaction open; the session ends it.
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select to_regclass('crm_private.lead_file_rows') t,to_regprocedure('public.agent_lead_list(uuid,jsonb)') f",
          )
        ).rows[0],
      ).toEqual({ t: null, f: null });
    } finally {
      await early.close();
    }
  }, 120000);
});
