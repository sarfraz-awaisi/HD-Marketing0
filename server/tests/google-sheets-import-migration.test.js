import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 056 on a database at 055: every existing row, function, trigger and
// report stays as it was (the new tables start empty and the import off);
// existing lead files keep their types; applying it again changes nothing;
// and 056 refuses to run before 055.
const admin = "56100000-0000-4000-8000-000000000001",
  ali = "56100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "056_google_sheets_import.sql";
const added = [
  "sheet_sync_owner",
  "sheet_file_counts",
  "sheet_history_pending",
  "sheet_confirm_history",
  "sheet_sync_auth",
  "sheet_sync_sources",
  "sheet_sync_pending",
  "sheet_sync_import",
  "sheet_sync_report",
  "sheet_sources_overview",
  "sheet_source_rejections",
  "sheet_source_save",
  "sheet_source_new_file",
  "sheet_sync_key_create",
  "sheet_sync_key_revoke",
  "lead_ad_inquiries",
];
const tables = [
  "public.sheet_sources",
  "crm_private.sheet_lead_receipts",
  "crm_private.sheet_lead_inquiries",
  "crm_private.sheet_row_rejections",
  "crm_private.sheet_sync_keys",
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
        "../../supabase/check-google-sheets-import-056.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and not format('%s.%s',schemaname,tablename)=any($1)) s",
      [tables],
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
  files: (await one("select lead_imports_page($1,1,20,'') p", [admin])).p,
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
    if (name < "056") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  // An existing CSV file with one lead, called and followed up.
  const imported = (
    await one(
      "select import_leads('november.csv','csv',null,$1::jsonb,$2,'t') r",
      [
        JSON.stringify([
          {
            row: 2,
            data: { name: "Existing buyer", source: "CSV" },
            phone: "+923008800001",
          },
          { row: 3, error: "Phone missing" },
        ]),
        admin,
      ],
    )
  ).r;
  const lead = imported.rows[0].id;
  await db.query("select assign_lead_import($1,$2,$3,'t')", [
    imported.import_id,
    ali,
    admin,
  ]);
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

describe("update 056 on a database at 055", () => {
  it("adds the import, off and empty, and changes no existing row, function, trigger, report or file", async () => {
    expect(await check()).toMatchObject({
      update_055_installed: true,
      release_stage: "at 055, ready for 056",
      existing_leads: 1,
      existing_lead_files: 1,
      lead_file_formats: { csv: 1 },
      existing_calls: 1,
      existing_followups: 1,
      sheets_file_type_allowed: false,
      inquiry_notifications_allowed: false,
      sheets_configured: null,
      histories_confirmed: null,
      server_functions: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 056",
      existing_leads: 1,
      existing_lead_files: 1,
      lead_file_formats: { csv: 1 },
      existing_calls: 1,
      existing_followups: 1,
      sheets_file_type_allowed: true,
      inquiry_notifications_allowed: true,
      sheets_configured: 0,
      sheets_turned_on: 0,
      histories_confirmed: 0,
      active_keys: 0,
      browser_function_access_must_be_0: 0,
      browser_table_access_must_be_0: 0,
      server_helper_access_must_be_0: 0,
      server_functions: 12,
    });
    for (const table of tables)
      expect((await one(`select count(*)::int n from ${table}`)).n).toBe(0);
    // Every new function but one pure test is volatile (each checks its
    // caller, under a lock where it writes).
    expect(
      (
        await one(
          "select count(*)::int n from pg_proc where proname=any($1) and provolatile='v' and prosecdef",
          [added],
        )
      ).n,
    ).toBe(added.length - 1);
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
      check: await check(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      functions: await definitions(),
      check: await check(),
    }).toEqual(before);
  });
  it("refuses to run before update 055", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "055") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 055 before update 056.",
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
      expect(
        (await early.query("select to_regclass('public.sheet_sources') t"))
          .rows[0].t,
      ).toBeNull();
    } finally {
      await early.close();
    }
  });
});
