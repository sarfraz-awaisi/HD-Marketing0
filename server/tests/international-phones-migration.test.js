import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 064 on a database at 063: no row or trigger changes; only the
// rejection reasons' check and one checked edit (sheet_sync_import's list of
// reasons); existing numbers and rejections stay, and numbers are read as
// before; applying it again changes nothing; it refuses to run before 063 or
// on a function it does not expect, changing nothing.
const admin = "64100000-0000-4000-8000-000000000001",
  ali = "64100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "064_international_phones.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = ["sheet_sync_import"];
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
          "../../supabase/check-international-phones-064.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
const reasons = async (on = db) =>
  (
    await on.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname='sheet_row_rejections_reason_check'",
    )
  ).rows[0].d;
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
  constraints: (
    await one(
      "select jsonb_object_agg(conrelid::regclass::text||'.'||conname,pg_get_constraintdef(oid)) s from pg_constraint where connamespace in ('public'::regnamespace,'crm_private'::regnamespace) and conname<>all($1)",
      [except.length ? ["sheet_row_rejections_reason_check"] : []],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
beforeAll(async () => {
  db = await database("064");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  // Leads with Pakistani and other numbers, and a Sheet with a rejected row.
  for (const [n, phone] of [
    [1, "03001234567"],
    [2, "+971501234567"],
    [3, "+447911123456"],
  ])
    await db.query("select create_lead($1::jsonb,$2,$3,'t')", [
      JSON.stringify({ name: `Buyer ${n}` }),
      phone,
      admin,
    ]);
  const source = (
    await one(
      "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Ad 1','1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_1','Sheet1',$1) returning id",
      [admin],
    )
  ).id;
  await db.query(
    "insert into crm_private.sheet_row_rejections(source_id,sheet_row,meta_lead_id,reason) values($1,4,'7100000000000004','phone_invalid')",
    [source],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 064 on a database at 063", () => {
  it("changes no record, trigger, grant or other function, and keeps every number and rejection", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 063, ready for 064",
      lead_numbers: 3,
      pakistani_numbers: 1,
      other_country_numbers: 2,
      numbers_with_0_after_92: 0,
      numbers_not_in_e164_form: 0,
      sheet_rows_rejected: 1,
      phone_rejections_now: 1,
      new_reasons_accepted: false,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot(changed);
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    expect(await reasons()).toContain("phone_needs_country");
    expect(await reasons()).toContain("phone_missing");
    expect(await check()).toMatchObject({
      release_stage: "at 064",
      lead_numbers: 3,
      sheet_rows_rejected: 1,
      new_reasons_accepted: true,
      browser_function_access_must_be_0: 0,
    });
    // Numbers are stored by the same rule as before: 10 to 15 digits.
    expect((await one("select normalize_lead_phone('03001234567') p")).p).toBe(
      "+923001234567",
    );
    await expect(
      db.query("select normalize_lead_phone('+6837290')"),
    ).rejects.toThrow("Use a valid international phone number");
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 063", async () => {
    const old = await database("063");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 063 before update 064.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("064");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.sheet_sync_import(text,uuid,jsonb,text)'::regprocedure) d",
        )
      ).rows[0].d;
      // A function replacement: "$'" in a replacement string means "the text
      // after the match".
      await other.exec(
        body.replace(
          "'date_missing','value_too_long') then",
          () => "'date_missing') then",
        ),
      );
      const reasonsBefore = await reasons(other);
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 064 found an unexpected version of public.sheet_sync_import(text,uuid,jsonb,text)",
      );
      await other.exec("rollback");
      expect(await reasons(other)).toBe(reasonsBefore);
      expect((await check(other)).release_stage).toBe("at 063, ready for 064");
    } finally {
      await other.close();
    }
  }, 120000);
});
