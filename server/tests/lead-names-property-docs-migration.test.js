import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 054 on a database at 053: every existing row (apart from the new
// empty floor column) and every function and trigger it does not replace
// stay unchanged; the code already deployed keeps saving properties;
// applying it again changes nothing; and it refuses to run before 053.
const admin = "54400000-0000-4000-8000-000000000001",
  ali = "54400000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "054_lead_names_property_documents.sql";
const replaced = [
  "inventory_save",
  "inventory_promote",
  "inventory_promote_prepare",
  "inventory_promote_release",
  "promotion_change_text",
];
const added = [
  "lead_rename",
  "queue_property_document_file",
  "property_document_json",
  "inventory_documents",
  "inventory_document_file",
  "inventory_document_reserve",
  "inventory_document_add",
  "inventory_document_release",
  "inventory_document_remove",
];
const newTables = [
  "public.property_documents",
  "public.property_document_cleanup",
];
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
      new URL(
        "../../supabase/check-lead-names-property-docs-054.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
// Every table's rows, without the new floor column, which is empty.
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg((to_jsonb(x)-''floor_level'')::text,''|'' order by (to_jsonb(x)-''floor_level'')::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and format('%I.%I',schemaname,tablename)<>all($1)) s",
      [newTables],
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1)",
      [[...replaced, ...added]],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal and tgname<>'queue_property_document_file'",
    )
  ).s,
});
const save = (data, property = null) =>
  one("select inventory_save($1,$2,$3::jsonb,'t') r", [
    ali,
    property,
    JSON.stringify(data),
  ]);
const flat = {
  title: "Flat for rent",
  type: "Apartment",
  purpose: "rent",
  price: 45000,
  area: 1100,
  area_unit: "sq ft",
  city: "Karachi",
  floors: 12,
};
let lead, property;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "054") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  lead = (
    await one("select (create_lead($1::jsonb,'+923008800054',$2,'t')).id", [
      JSON.stringify({ name: "Unknown", assigned_agent: ali }),
      admin,
    ])
  ).id;
  property = (await save(flat)).r;
  await db.query(
    "insert into property_photos(property_id,storage_path) values($1::uuid,$1::text||'/00000000-0000-4000-8000-000000000001')",
    [property.id],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 054 on a database at 053", () => {
  it("adds names, floors and documents and changes no existing row, function or trigger", async () => {
    expect(await check()).toMatchObject({
      update_053_installed: true,
      release_stage: "at 053, ready for 054",
      existing_leads: 1,
      existing_properties: 1,
      existing_property_photos: 1,
      document_bucket: "missing",
      properties_with_floor: 0,
    });
    const before = await snapshot();
    const buckets = (
      await db.query("select * from storage.buckets order by id")
    ).rows;
    await db.exec(await migration(file));
    const after = await snapshot();
    // Only storage.buckets gains its new row.
    const changed = Object.keys(before.rows).filter(
      (t) => before.rows[t] !== after.rows[t],
    );
    expect(changed).toEqual(["storage.buckets"]);
    expect({ ...after, rows: null }).toEqual({ ...before, rows: null });
    expect(
      (
        await db.query(
          "select * from storage.buckets where id<>'property-documents' order by id",
        )
      ).rows,
    ).toEqual(buckets);
    expect(await check()).toMatchObject({
      release_stage: "at 054",
      existing_leads: 1,
      existing_properties: 1,
      existing_property_photos: 1,
      document_bucket: "private, PDF only, 25 MB",
      document_storage_policies_must_be_0: 0,
      tables_without_rls_must_be_0: 0,
      browser_table_access_must_be_0: 0,
      browser_function_access_must_be_0: 0,
      server_functions: 9,
      properties_with_floor: 0,
    });
    // The code already deployed saves properties without a floor as before.
    const kept = await save(
      { availability: "rented", expected_updated_at: property.updated_at },
      property.id,
    );
    expect(kept.r).toMatchObject({
      availability: "rented",
      floors: 12,
      floor_level: null,
    });
    // The new parts work.
    expect(
      (await one("select lead_rename($1,$2,'Ayesha Malik','t') r", [lead, ali]))
        .r,
    ).toMatchObject({ name: "Ayesha Malik", changed: true });
    expect((await save({ ...flat, floor_level: 7 })).r.floor_level).toBe(7);
    const path = `${property.id}/00000000-0000-4000-8000-0000000000d1`;
    await db.query("select inventory_document_reserve($1,$2,$3)", [
      ali,
      property.id,
      path,
    ]);
    expect(
      (
        await one(
          "select inventory_document_add($1,$2,$3,'Brochure.pdf',2048,'t') r",
          [ali, property.id, path],
        )
      ).r,
    ).toMatchObject({ file_name: "Brochure.pdf", size_bytes: 2048 });
  });
  it("changes nothing when applied again", async () => {
    const functions = () =>
      one(
        "select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.proname) s from pg_proc p where p.proname=any($1)",
        [[...replaced, ...added]],
      );
    const rows = () =>
      one(
        "select (select jsonb_agg(to_jsonb(d) order by id) from property_documents d) docs,(select jsonb_agg(to_jsonb(b) order by id) from storage.buckets b) buckets,(select count(*)::int from properties where floor_level is not null) floors",
      );
    const before = {
      snapshot: await snapshot(),
      f: await functions(),
      r: await rows(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      f: await functions(),
      r: await rows(),
    }).toEqual(before);
  });
  it("refuses to run before update 053", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "053") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 053 before update 054.",
      );
      await early.exec("rollback");
      expect(
        (await early.query("select to_regclass('public.property_documents') t"))
          .rows[0].t,
      ).toBeNull();
    } finally {
      await early.close();
    }
  }, 120000);
});
