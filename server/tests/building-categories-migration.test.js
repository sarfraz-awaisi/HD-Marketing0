import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 046 in the normal forward-only order: a database at 045 holding
// inventory made by the 041 and 044 functions (agent and company listings,
// pictures, owner contacts and an admin copy), then 046.
const admin = "46100000-0000-4000-8000-000000000001",
  agent = "46100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (file) =>
  (await readFile(new URL(file, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
let db, source, copy, company;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const all = async (text, args = []) => (await db.query(text, args)).rows;
const save = async (actor, id, data) =>
  (
    await one("select public.inventory_save($1,$2,$3::jsonb,'t') r", [
      actor,
      id,
      JSON.stringify(data),
    ])
  ).r;
async function promote(id) {
  const target = randomUUID();
  const plan = (
    await one("select public.inventory_promote_prepare($1,$2,$3) r", [
      admin,
      id,
      target,
    ])
  ).r;
  return (
    await one("select public.inventory_promote($1,$2,$3,$4,'t') r", [
      admin,
      id,
      target,
      plan.photos.map((p) => p.to),
    ])
  ).r;
}
const listing = {
  title: "Gulberg tower",
  type: "Building",
  purpose: "sale",
  price: 90000000,
  area: 2,
  area_unit: "kanal",
  city: "Lahore",
  bedrooms: 2,
  amenities: ["lift", "security"],
};
// Everything 046 must leave as it was.
const snapshot = async () => ({
  properties: await all(
    "select to_jsonb(p)-'building_categories' row from properties p order by id",
  ),
  photos: await all("select * from property_photos order by id"),
  contacts: await all(
    "select * from property_owner_contacts order by property_id",
  ),
  promotions: await all("select * from property_promotions order by id"),
  audit: (await one("select count(*)::int n from audit_log")).n,
  notifications: await all("select * from notifications order by id"),
});
let before;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    if (file < "046") await db.exec(await migration(file));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, agent],
  );
  await db.query(
    "update profiles set active=true,name=case when id=$1 then 'Owner' else 'Ali Agent' end,role=case when id=$1 then 'admin' else 'agent' end where id in ($1,$2)",
    [admin, agent],
  );
  source = await save(agent, null, {
    ...listing,
    owner_contact: { owner_name: "Mr Khan", owner_phone: "+923001234567" },
  });
  for (let i = 0; i < 2; i++)
    await db.query("select public.inventory_photo_add($1,$2,$3,'t')", [
      agent,
      source.id,
      `${source.id}/${randomUUID()}`,
    ]);
  copy = await promote(source.id);
  company = await save(admin, null, { ...listing, title: "Company plaza" });
  await save(agent, null, {
    ...listing,
    title: "Plot",
    type: "Residential Plot",
  });
  await db.query(
    "insert into properties(title,location,price,type,area,area_unit) values('Old listing','Lahore',100,'Plot',5,'marla')",
  );
  before = await snapshot();
  await db.exec(await migration("046_building_property_categories.sql"));
}, 90000);
afterAll(async () => {
  await db?.close();
});

describe("update 046 after 041–045", () => {
  it("keeps every existing property, picture, contact, promotion and notice", async () => {
    expect(before.properties).toHaveLength(5);
    expect(before.promotions).toHaveLength(1);
    expect(before.photos).toHaveLength(4);
    expect(await snapshot()).toEqual(before);
    expect(
      (await all("select distinct building_categories c from properties")).map(
        (r) => r.c,
      ),
    ).toEqual([[]]);
  });
  it("changes nothing when applied again", async () => {
    const now = await snapshot();
    await db.exec(await migration("046_building_property_categories.sql"));
    expect(await snapshot()).toEqual(now);
  });
  it("then lets owners set categories while the existing copy stays independent", async () => {
    await save(agent, source.id, { building_categories: ["workspace"] });
    expect(
      (
        await one("select building_categories c from properties where id=$1", [
          copy.id,
        ])
      ).c,
    ).toEqual([]);
    expect(
      (
        await one(
          "select body from notifications where user_id=$1 and type='property_source_updated'",
          [admin],
        )
      ).body,
    ).toContain("Building categories: added Office Spaces / Workspaces.");
    expect(
      (
        await save(admin, company.id, {
          building_categories: ["commercial_outlet"],
        })
      ).building_categories,
    ).toEqual(["commercial_outlet"]);
  });
});

// The supported process applies each missing migration once, in order, and
// never reapplies an older one. If 044 were run again anyway, these are the
// effects documented in docs/PROPERTY_INVENTORY.md; running 046 again after it
// restores everything.
describe("running 044 again after 046 (unsupported)", () => {
  it("refuses category saves loudly, drops them from new copies, and 046 restores both", async () => {
    const listingWith = await save(agent, null, {
      ...listing,
      title: "Second tower",
      building_categories: ["residential_1_bed", "workspace"],
    });
    await db.exec(await migration("044_admin_property_promotion.sql"));
    // Saved categories stay in the table.
    expect(
      (
        await one("select building_categories c from properties where id=$1", [
          listingWith.id,
        ])
      ).c,
    ).toEqual(["residential_1_bed", "workspace"]);
    await expect(
      save(agent, listingWith.id, { building_categories: ["workspace"] }),
    ).rejects.toMatchObject({ message: "Unsupported property details" });
    const staleCopy = await promote(listingWith.id);
    expect(
      (
        await one("select building_categories c from properties where id=$1", [
          staleCopy.id,
        ])
      ).c,
    ).toEqual([]);
    await db.exec(await migration("046_building_property_categories.sql"));
    expect(
      (
        await save(agent, listingWith.id, {
          building_categories: ["workspace"],
        })
      ).building_categories,
    ).toEqual(["workspace"]);
    const third = await save(agent, null, {
      ...listing,
      title: "Third tower",
      building_categories: ["hotel_apartment_3_bed"],
    });
    expect((await promote(third.id)).building_categories).toEqual([
      "hotel_apartment_3_bed",
    ]);
  });
});
