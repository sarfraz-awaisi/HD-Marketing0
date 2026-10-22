import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 041 against a database at 040 with existing properties, photos and
// linked leads, visits and deals, as the production database is today.
const admin = "1f000000-0000-4000-8000-000000000001",
  agent = "1f000000-0000-4000-8000-000000000002";
const root = new URL("../../supabase/", import.meta.url);
const sql = (name) => readFile(new URL(name, root), "utf8");
let db, property, sold, lead;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const migration = () => sql("migrations/041_property_inventory.sql");
const check = async () => one(await sql("check-property-inventory.sql"));
async function databaseAt040() {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("migrations/", root);
  for (const file of (await readdir(dir)).sort())
    if (file < "041")
      await pg.exec(
        (await readFile(new URL(file, dir), "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );
  return pg;
}
// Every column that existed before 041, for each existing row.
const snapshot = async () =>
  (
    await db.query(
      "select id,title,description,location,price,type,area,area_unit,availability,created_at,updated_at from properties order by id",
    )
  ).rows;
beforeAll(async () => {
  db = await databaseAt040();
  await db.query(
    "insert into auth.users(id,email) values($1,'a@x.pk'),($2,'b@x.pk')",
    [admin, agent],
  );
  await db.query("update profiles set active=true,role='admin' where id=$1", [
    admin,
  ]);
  await db.query("update profiles set active=true where id=$1", [agent]);
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Old listing','Lahore',100,'Plot',5,'marla') returning id",
    )
  ).id;
  sold = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit,availability) values('Sold house','Karachi',900,'House',1,'kanal','sold') returning id",
    )
  ).id;
  await db.query(
    "insert into property_photos(property_id,storage_path) values($1::uuid,$1::text||'/a'),($1::uuid,$1::text||'/b')",
    [property],
  );
  lead = (
    await one(
      "insert into leads(name,masked_phone,assigned_agent,property_id) values('Buyer','******123',$1,$2) returning id",
      [agent, property],
    )
  ).id;
  await db.query(
    "insert into visits(lead_id,agent_id,property_id,scheduled_at) values($1,$2,$3,now())",
    [lead, agent, property],
  );
  await db.query(
    "insert into deals(lead_id,agent_id,property_id,stage,expected_value) values($1,$2,$3,'discussion',100)",
    [lead, agent, sold],
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe("update 041 on an existing database", () => {
  it("reports a ready database before the update", async () => {
    expect(await check()).toMatchObject({
      postgres_14_or_newer: true,
      update_013_installed: true,
      update_028_installed: true,
      update_036_installed: true,
      update_040_installed: true,
      properties_touch_trigger: true,
      properties_checks_as_expected: true,
      update_041_installed: false,
      properties: 2,
      property_photos: 2,
      leads: 1,
      visits: 1,
      deals: 1,
      properties_outside_rules: 0,
      agent_owned_properties: null,
      browser_executable_functions: 0,
      browser_can_read_properties: false,
      photo_bucket_exists: true,
      photo_bucket_public: false,
      photo_bucket_types: ["image/jpeg", "image/png", "image/webp"],
    });
  });
  it("refuses a database with unexpected property rules and changes nothing", async () => {
    await db.exec(
      "alter table properties add constraint properties_custom_rule check(price<1e15)",
    );
    try {
      await expect(db.exec(await migration())).rejects.toThrow(
        /unexpected check constraints/,
      );
      await db.exec("rollback");
      expect((await check()).update_041_installed).toBe(false);
    } finally {
      await db.exec(
        "alter table properties drop constraint properties_custom_rule",
      );
    }
  });
  it("keeps every existing property, photo and link unchanged", async () => {
    const before = await snapshot();
    const links = await one(
      "select (select property_id from leads where id=$1) lead,(select property_id from visits where lead_id=$1) visit,(select property_id from deals where lead_id=$1) deal",
      [lead],
    );
    await db.exec(await migration());
    expect(await snapshot()).toEqual(before);
    expect(
      await one(
        "select (select property_id from leads where id=$1) lead,(select property_id from visits where lead_id=$1) visit,(select property_id from deals where lead_id=$1) deal",
        [lead],
      ),
    ).toEqual(links);
    const rows = (
      await db.query(
        "select owner_agent_id,purpose,category,property_no,created_by from properties order by property_no",
      )
    ).rows;
    expect(rows.map((r) => r.owner_agent_id)).toEqual([null, null]);
    expect(rows.map((r) => r.purpose)).toEqual(["sale", "sale"]);
    expect(new Set(rows.map((r) => r.property_no)).size).toBe(2);
    expect(
      (await db.query("select position from property_photos")).rows,
    ).toEqual([{ position: 0 }, { position: 0 }]);
    expect(await check()).toMatchObject({
      update_041_installed: true,
      properties: 2,
      property_photos: 2,
      agent_owned_properties: 0,
      inventory_functions: 17,
      browser_executable_functions: 0,
      browser_can_read_properties: false,
      owner_contacts_rls: true,
    });
    for (const role of ["anon", "authenticated"])
      expect(
        await one(
          "select has_sequence_privilege($1,pg_get_serial_sequence('public.properties','property_no'),'usage') u",
          [role],
        ),
      ).toEqual({ u: false });
  });
  it("still serves the previous API's property calls", async () => {
    // The release before 041 writes properties through crm_mutate and
    // deletes them through delete_property(property, actor, request).
    const created = (
      await one(
        "select crm_mutate('properties',null,$1::jsonb,$2,'old-api') r",
        [
          JSON.stringify({
            title: "Added by old API",
            location: "Multan",
            price: 50,
            type: "Commercial",
            area: 2,
            area_unit: "marla",
            availability: "available",
          }),
          admin,
        ],
      )
    ).r;
    expect(created).toMatchObject({ owner_agent_id: null, purpose: "sale" });
    await one(
      "select crm_mutate('properties',$1,'{\"availability\":\"archived\"}'::jsonb,$2,'old-api')",
      [property, admin],
    );
    await db.query(
      "insert into property_photos(property_id,storage_path) values($1::uuid,$1::text||'/old')",
      [property],
    );
    await db.query("select delete_property($1,$2,'old-api')", [
      created.id,
      admin,
    ]);
    await expect(
      db.query("select delete_property($1,$2,'old-api')", [property, admin]),
    ).rejects.toMatchObject({ code: "23503" });
    await db.query(
      "insert into visits(lead_id,agent_id,property_id,scheduled_at) values($1,$2,$3,now())",
      [lead, agent, sold],
    );
  });
  it("can be applied again without changes", async () => {
    const before = await snapshot();
    const numbers = (
      await db.query("select id,property_no from properties order by id")
    ).rows;
    await db.exec(await migration());
    expect(await snapshot()).toEqual(before);
    expect(
      (await db.query("select id,property_no from properties order by id"))
        .rows,
    ).toEqual(numbers);
  });
});
