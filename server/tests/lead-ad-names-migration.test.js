import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 068 on a database at 067: leads gain ad_name, and the leads a
// Google Sheet brought in take their first inquiry's advertisement. No other
// record, trigger, grant or function changes. Applying it again changes
// nothing; it refuses to run before 067 or on a function it does not expect,
// changing nothing.
const admin = "68100000-0000-4000-8000-000000000001";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "068_lead_ad_names.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = [
  "create_lead_031",
  "sheet_sync_import",
  "agent_lead_list",
  "admin_lead_list",
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
const one = async (text, args = [], on = db) =>
  (await on.query(text, args)).rows[0];
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL("../../supabase/check-lead-ad-names-068.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows[0];
// Every table but leads, every function but the ones 068 edits, their
// grants and every trigger; leads apart from ad_name and updated_at.
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'leads') s",
    )
  ).s,
  leads: (
    await db.query(
      "select to_jsonb(l)-'ad_name'-'updated_at' l from leads l order by id",
    )
  ).rows,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [changed],
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
const lead = async (name, phone) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name }),
      phone,
      admin,
    ])
  ).id;
const ads = async () =>
  Object.fromEntries(
    (
      await db.query(
        "select name,to_jsonb(l)->>'ad_name' ad from leads l order by name",
      )
    ).rows.map((r) => [r.name, r.ad]),
  );
beforeAll(async () => {
  db = await database("068");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now())",
    [admin],
  );
  await db.query(
    "update profiles set active=true,role='admin',name='Owner' where id=$1",
    [admin],
  );
  const source = (
    await one(
      "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Ads','1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_68','Sheet1',$1) returning id",
      [admin],
    )
  ).id;
  const twice = await lead("Asked twice", "+923000068001");
  const blank = await lead("Ad left blank", "+923000068002");
  await lead("Added by hand", "+923000068003");
  // Asked twice: first from "DHA Phase 9 plots", then from "Gulberg flats",
  // imported in the other order.
  const inquiries = [
    ["101", twice, "2026-11-05", " Gulberg flats "],
    ["102", twice, "2026-11-01", " DHA Phase 9 plots "],
    ["103", blank, "2026-11-02", "  "],
  ];
  for (const [id, customer, at, ad] of inquiries) {
    await db.query(
      "insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,sheet_row) values($1,$2,'created',$3,$4)",
      [source, id, customer, Number(id) - 99],
    );
    await db.query(
      "insert into crm_private.sheet_lead_inquiries(source_id,meta_lead_id,lead_id,submitted_at,ad_name) values($1,$2,$3,$4,$5)",
      [source, id, customer, at, ad],
    );
  }
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 068 on a database at 067", () => {
  it("gives Sheet leads their first inquiry's advertisement and changes nothing else", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 067, ready for 068",
      sheet_inquiries: 3,
      sheet_inquiries_with_ad_name: 2,
      sheet_leads_with_ad_name: 1,
      leads_with_ad_name: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await ads()).toEqual({
      "Ad left blank": null,
      "Added by hand": null,
      "Asked twice": "DHA Phase 9 plots",
    });
    expect(await check()).toMatchObject({
      release_stage: "at 068",
      sheet_leads_with_ad_name: 1,
      leads_with_ad_name: 1,
    });
    // New leads take theirs from now on.
    const created = (
      await one(
        "select to_jsonb(create_lead($1::jsonb,'+923000068004',$2,'t')) l",
        [JSON.stringify({ name: "After 068", ad_name: " Expo stand " }), admin],
      )
    ).l;
    expect(created.ad_name).toBe("Expo stand");
  });
  it("changes nothing when applied again", async () => {
    const before = { ...(await snapshot()), ads: await ads() };
    await db.exec(await migration(file));
    expect({ ...(await snapshot()), ads: await ads() }).toEqual(before);
  });
  it("refuses to run before 067", async () => {
    const old = await database("067");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 067 before update 068.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("068");
    try {
      const body = (
        await one(
          "select pg_get_functiondef('public.admin_agent_pipeline(uuid,uuid,jsonb)'::regprocedure) d",
          [],
          other,
        )
      ).d;
      await other.exec(
        body.replace("'source',o.source,", () => "'origin',o.source,"),
      );
      const create = (
        await one(
          "select md5(pg_get_functiondef('public.create_lead_031(jsonb,text,uuid,text)'::regprocedure)) h",
          [],
          other,
        )
      ).h;
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 068 found an unexpected version of public.admin_agent_pipeline",
      );
      await other.exec("rollback");
      expect(
        (
          await one(
            "select md5(pg_get_functiondef('public.create_lead_031(jsonb,text,uuid,text)'::regprocedure)) h",
            [],
            other,
          )
        ).h,
      ).toBe(create);
      expect((await check(other)).release_stage).toBe("at 067, ready for 068");
      expect(
        (
          await one(
            "select count(*)::int n from information_schema.columns where table_name='leads' and column_name='ad_name'",
            [],
            other,
          )
        ).n,
      ).toBe(0);
    } finally {
      await other.close();
    }
  }, 120000);
});
