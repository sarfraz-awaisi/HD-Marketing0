import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { buildingCategories } from "../src/utils/validators.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
import * as clientInventory from "../../client/src/lib/inventory.js";
// Update 046: building categories. Requests run against every real migration
// in PGlite; only Supabase Storage is replaced, by an in-memory bucket.
const admin = "46000000-0000-4000-8000-000000000001",
  agent = "46000000-0000-4000-8000-000000000002",
  other = "46000000-0000-4000-8000-000000000003";
const ALL = [
  "residential_1_bed",
  "residential_2_bed",
  "residential_3_bed",
  "hotel_apartment_1_bed",
  "hotel_apartment_2_bed",
  "hotel_apartment_3_bed",
  "commercial_outlet",
  "workspace",
];
let pg, db, one, all, files;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  files = new Map();
});
const bucket = {
  upload: async (path, body) => {
    files.set(path, Buffer.from(body));
    return { data: { path } };
  },
  copy: async (from, to) => {
    files.set(to, Buffer.from(files.get(from) || ""));
    return { data: { path: to } };
  },
  remove: async (paths) => {
    for (const path of paths) files.delete(path);
    return { data: [] };
  },
  createSignedUrls: async (paths) => ({
    data: paths.map((path) => ({
      path,
      signedUrl: `https://storage.test/${path}`,
    })),
  }),
};
const app = () =>
  createApp(trustedMfaFixture({ ...db, storage: { from: () => bucket } }));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (user, path) =>
  request(app())
    .get("/api" + path)
    .set(as(user));
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
const listing = {
  title: "Main Boulevard Plaza",
  type: "Building",
  purpose: "sale",
  price: 250000000,
  area: 2,
  area_unit: "kanal",
  city: "Lahore",
  area_society: "Gulberg",
  bedrooms: 2,
};
async function create(user, extra = {}) {
  const res = await send(user, "post", "/properties", { ...listing, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const edit = (user, id, body) => send(user, "patch", `/properties/${id}`, body);
const stored = async (id) =>
  (await one("select building_categories c from properties where id=$1", [id]))
    .c;
const ref = (no) => "PR-" + String(no).padStart(6, "0");
const save = (actor, id, data) =>
  one("select public.inventory_save($1,$2,$3::jsonb,'t') r", [
    actor,
    id,
    JSON.stringify(data),
  ]);

describe("choosing building categories", () => {
  it("saves one, several or every category in one property, in the standard order", async () => {
    const single = await create(agent, {
      building_categories: ["commercial_outlet"],
    });
    expect(single.building_categories).toEqual(["commercial_outlet"]);
    const mixed = await create(agent, {
      building_categories: [
        "workspace",
        "hotel_apartment_2_bed",
        "residential_3_bed",
        "residential_1_bed",
        "commercial_outlet",
      ],
    });
    expect(mixed.building_categories).toEqual([
      "residential_1_bed",
      "residential_3_bed",
      "hotel_apartment_2_bed",
      "commercial_outlet",
      "workspace",
    ]);
    const every = await create(admin, {
      building_categories: [...ALL].reverse(),
    });
    expect(await stored(every.id)).toEqual(ALL);
    expect((await get(admin, `/properties/${every.id}`)).body).toMatchObject({
      building_categories: ALL,
    });
    // Lists carry them for the property cards.
    const mine = await get(agent, "/properties?scope=mine");
    expect(
      mine.body.data.find((p) => p.id === mixed.id).building_categories,
    ).toHaveLength(5);
  });
  it("keeps residential and hotel bedroom categories apart", async () => {
    const homes = await create(agent, {
      building_categories: ["residential_1_bed"],
    });
    const hotel = await create(agent, {
      building_categories: ["hotel_apartment_1_bed"],
    });
    expect(await stored(homes.id)).toEqual(["residential_1_bed"]);
    expect(await stored(hotel.id)).toEqual(["hotel_apartment_1_bed"]);
  });
  it("leaves new properties without categories and older properties empty", async () => {
    const plain = await create(agent);
    expect(plain.building_categories).toEqual([]);
    const { id } = await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Old listing','Lahore',100,'House',5,'marla') returning id",
    );
    expect(await stored(id)).toEqual([]);
    expect(
      (await get(admin, `/properties/${id}`)).body.building_categories,
    ).toEqual([]);
  });
  it("refuses unknown, malformed or repeated values, through the API and the database", async () => {
    for (const bad of [["penthouse"], "residential_1_bed", [1], null])
      expect(
        (
          await send(agent, "post", "/properties", {
            ...listing,
            building_categories: bad,
          })
        ).status,
      ).toBe(400);
    const twice = await send(agent, "post", "/properties", {
      ...listing,
      building_categories: ["workspace", "workspace"],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toBe("Invalid input: building_categories");
    await expect(
      save(agent, null, { ...listing, building_categories: ["penthouse"] }),
    ).rejects.toMatchObject({
      code: "HA400",
      message: "Choose building categories from the list",
    });
    await expect(
      save(agent, null, {
        ...listing,
        building_categories: ["workspace", "workspace"],
      }),
    ).rejects.toMatchObject({
      code: "HA400",
      message: "Choose each building category once",
    });
    await expect(
      save(agent, null, { ...listing, building_categories: "workspace" }),
    ).rejects.toMatchObject({ code: "HA400" });
    // The column itself accepts only listed values, once, in order.
    const { id } = await create(agent);
    for (const value of [
      "{penthouse}",
      "{workspace,workspace}",
      "{workspace,residential_1_bed}",
    ])
      await expect(
        pg.query("update properties set building_categories=$1 where id=$2", [
          value,
          id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    expect(await stored(id)).toEqual([]);
  });
});

describe("editing building categories", () => {
  it("adds and removes categories and keeps them through unrelated edits", async () => {
    const p = await create(agent, {
      building_categories: ["residential_1_bed", "commercial_outlet"],
    });
    const added = await edit(agent, p.id, {
      building_categories: [
        "residential_1_bed",
        "commercial_outlet",
        "workspace",
      ],
      expected_updated_at: p.updated_at,
    });
    expect(added.status).toBe(200);
    expect(added.body.building_categories).toEqual([
      "residential_1_bed",
      "commercial_outlet",
      "workspace",
    ]);
    const removed = await edit(agent, p.id, {
      building_categories: ["workspace"],
    });
    expect(removed.body.building_categories).toEqual(["workspace"]);
    // Other fields, sent or not, leave the categories alone.
    const priced = await edit(agent, p.id, {
      price: 260000000,
      amenities: ["lift"],
    });
    expect(priced.body).toMatchObject({
      price: 260000000,
      building_categories: ["workspace"],
    });
    expect(await stored(p.id)).toEqual(["workspace"]);
  });
  it("changes nothing when an edit is refused", async () => {
    const p = await create(agent, {
      building_categories: ["residential_2_bed"],
    });
    await edit(agent, p.id, { title: "Renamed plaza" });
    // A stale editor and an invalid edit both leave the record as it was.
    expect(
      (
        await edit(agent, p.id, {
          building_categories: ["workspace"],
          expected_updated_at: p.updated_at,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await edit(agent, p.id, {
          title: "Another name",
          building_categories: ["workspace", "penthouse"],
        })
      ).status,
    ).toBe(400);
    expect(
      await one(
        "select title,building_categories c from properties where id=$1",
        [p.id],
      ),
    ).toEqual({ title: "Renamed plaza", c: ["residential_2_bed"] });
  });
  it("clears them for plots and land, like the other building details", async () => {
    const p = await create(agent, {
      building_categories: ["residential_1_bed"],
    });
    const plot = await edit(agent, p.id, { type: "Residential Plot" });
    expect(plot.body).toMatchObject({
      building_categories: [],
      bedrooms: null,
    });
    const land = await create(agent, {
      type: "Land",
      building_categories: ["workspace"],
    });
    expect(land.building_categories).toEqual([]);
  });
});

describe("Admin Property Promotion", () => {
  it("copies the categories, then each record changes on its own", async () => {
    const source = await create(agent, {
      building_categories: [
        "residential_1_bed",
        "residential_2_bed",
        "commercial_outlet",
      ],
    });
    const before = (await get(admin, "/inventory/summary")).body;
    const promoted = await send(
      admin,
      "post",
      `/properties/${source.id}/promote`,
      {},
    );
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(201);
    const copy = promoted.body;
    expect(copy.building_categories).toEqual([
      "residential_1_bed",
      "residential_2_bed",
      "commercial_outlet",
    ]);
    // The agent removes one: the original changes, the copy does not, and
    // administrators are told what changed.
    expect(
      (
        await edit(agent, source.id, {
          building_categories: ["residential_2_bed", "commercial_outlet"],
        })
      ).status,
    ).toBe(200);
    expect(await stored(copy.id)).toEqual([
      "residential_1_bed",
      "residential_2_bed",
      "commercial_outlet",
    ]);
    const uid = (await one("select uid from profiles where id=$1", [agent]))
      .uid;
    const updates = await all(
      "select title,body from notifications where user_id=$1 and type='property_source_updated'",
      [admin],
    );
    expect(updates).toEqual([
      {
        title: `Original property updated: ${ref(source.property_no)}`,
        body: `Ali Agent (UID ${uid}) updated ${ref(source.property_no)}. Building categories: removed Residential — 1 Bedroom. Admin copy ${ref(copy.property_no)} has not been changed.`,
      },
    ]);
    // The same categories in another order are no change: no notice.
    await edit(agent, source.id, {
      building_categories: ["commercial_outlet", "residential_2_bed"],
    });
    expect(
      (
        await one(
          "select count(*)::int n from notifications where type='property_source_updated'",
        )
      ).n,
    ).toBe(1);
    // The administrator edits the copy: the original stays as the agent left it.
    const adminEdit = await edit(admin, copy.id, {
      building_categories: ["residential_1_bed", "workspace"],
    });
    expect(adminEdit.status).toBe(200);
    expect(await stored(source.id)).toEqual([
      "residential_2_bed",
      "commercial_outlet",
    ]);
    expect(await stored(copy.id)).toEqual(["residential_1_bed", "workspace"]);
    // The pair still counts once.
    const after = (await get(admin, "/inventory/summary")).body;
    expect(after.unique.total).toBe(before.unique.total);
    expect(after.all.total).toBe(before.all.total + 1);
    expect(after.promoted).toBe(before.promoted + 1);
  });
  it("tells administrators about added and removed categories together", async () => {
    const source = await create(agent, {
      building_categories: ["residential_1_bed"],
    });
    const copy = (
      await send(admin, "post", `/properties/${source.id}/promote`, {})
    ).body;
    await edit(agent, source.id, {
      building_categories: ["hotel_apartment_2_bed", "workspace"],
      price: 255000000,
    });
    const { body } = await one(
      "select body from notifications where user_id=$1 and type='property_source_updated'",
      [admin],
    );
    expect(body).toContain(
      "Price: PKR 250,000,000 → PKR 255,000,000. Building categories: added Hotel Apartments — 2 Bedrooms, Office Spaces / Workspaces; removed Residential — 1 Bedroom.",
    );
    expect(body).toContain(
      `Admin copy ${ref(copy.property_no)} has not been changed.`,
    );
  });
});

describe("form saves", () => {
  // What the property form sends: every field, every time.
  const form = (p, categories) => ({
    title: p.title,
    type: p.type,
    purpose: p.purpose,
    availability: p.availability,
    description: p.description,
    city: p.city,
    area_society: p.area_society,
    block_sector: p.block_sector,
    province: p.province,
    street: p.street,
    plot_number: p.plot_number,
    address: p.address,
    map_url: p.map_url,
    area: Number(p.area),
    area_unit: p.area_unit,
    price: Number(p.price),
    price_negotiable: p.price_negotiable,
    price_notes: p.price_notes,
    amenities: p.amenities,
    owner_contact: {
      owner_name: p.owner_contact?.owner_name ?? null,
      owner_phone: p.owner_contact?.owner_phone ?? null,
      owner_alt_phone: p.owner_contact?.owner_alt_phone ?? null,
      owner_notes: p.owner_contact?.owner_notes ?? null,
      share_with_agents: false,
    },
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    kitchens: p.kitchens,
    floors: p.floors,
    parking_spaces: p.parking_spaces,
    property_age: p.property_age,
    furnishing: p.furnishing,
    construction_status: p.construction_status,
    building_categories: categories ?? p.building_categories,
    expected_updated_at: p.updated_at,
  });
  const updates = async () =>
    all(
      "select body from notifications where user_id=$1 and type='property_source_updated' order by created_at,id",
      [admin],
    );
  it("announce a category-only change once and an unchanged save not at all", async () => {
    const source = await create(agent, {
      building_categories: ["residential_1_bed", "commercial_outlet"],
      owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 1234567" },
      amenities: ["lift"],
    });
    const copy = (
      await send(admin, "post", `/properties/${source.id}/promote`, {})
    ).body;
    const loaded = (await get(agent, `/properties/${source.id}`)).body;
    // Only the categories differ from what was loaded.
    const changed = await edit(
      agent,
      source.id,
      form(loaded, ["residential_1_bed", "commercial_outlet", "workspace"]),
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const uid = (await one("select uid from profiles where id=$1", [agent]))
      .uid;
    expect(await updates()).toEqual([
      {
        body: `Ali Agent (UID ${uid}) updated ${ref(source.property_no)}. Building categories: added Office Spaces / Workspaces. Admin copy ${ref(copy.property_no)} has not been changed.`,
      },
    ]);
    // The same form saved again: nothing changed, nobody is told.
    const again = await edit(agent, source.id, form(changed.body));
    expect(again.status).toBe(200);
    expect(await updates()).toHaveLength(1);
    const [noop, update] = (await get(admin, "/audit?module=properties")).body
      .data;
    expect(update).toMatchObject({
      title: "Updated property building categories",
      description: `Updated “Main Boulevard Plaza” (${ref(source.property_no)}): building categories. Added Office Spaces / Workspaces.`,
    });
    expect(noop).toMatchObject({
      title: "Updated a property listing",
      description: `Saved “Main Boulevard Plaza” (${ref(source.property_no)}) without changes.`,
    });
    expect(await stored(copy.id)).toEqual([
      "residential_1_bed",
      "commercial_outlet",
    ]);
  });
});

describe("permissions", () => {
  it("lets only the owner change a property's categories", async () => {
    const mine = await create(agent, {
      building_categories: ["residential_1_bed"],
    });
    const company = await create(admin, {
      building_categories: ["workspace"],
    });
    const change = { building_categories: ["commercial_outlet"] };
    expect((await edit(other, mine.id, change)).status).toBe(404);
    expect((await edit(admin, mine.id, change)).status).toBe(403);
    expect((await edit(agent, company.id, change)).status).toBe(403);
    expect(
      (await request(app()).patch(`/api/properties/${mine.id}`).send(change))
        .status,
    ).toBe(401);
    expect(await stored(mine.id)).toEqual(["residential_1_bed"]);
    expect(await stored(company.id)).toEqual(["workspace"]);
    await expect(save(agent, company.id, change)).rejects.toMatchObject({
      code: "HA403",
    });
  });
  it("gives browser roles nothing new", async () => {
    const fns = await all(
      "select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') api from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('property_category_list','property_categories_sorted','property_category_label','promotion_change_text','inventory_save','inventory_promote')",
    );
    expect(fns).toHaveLength(6);
    expect(fns.filter((f) => f.anon || f.browser)).toEqual([]);
    expect(fns.filter((f) => !f.api).map((f) => f.proname)).toEqual([
      "promotion_change_text",
    ]);
    expect(
      (
        await one(
          "select count(*)::int n from information_schema.role_table_grants where table_name='properties' and grantee in ('anon','authenticated')",
        )
      ).n,
    ).toBe(0);
  });
});

describe("Audit History", () => {
  it("shows the categories added and removed, and only changes that happened", async () => {
    const p = await create(agent, {
      building_categories: ["residential_1_bed"],
    });
    await edit(agent, p.id, {
      building_categories: ["hotel_apartment_2_bed"],
    });
    await edit(agent, p.id, { building_categories: ["hotel_apartment_2_bed"] });
    const res = await get(admin, "/audit?module=properties");
    expect(res.status).toBe(200);
    const [noop, update, created] = res.body.data;
    expect(created).toMatchObject({
      title: "Created a property listing",
      description: `Created “Main Boulevard Plaza” (${ref(p.property_no)}) in an agent's inventory. Building categories: Residential — 1 Bedroom.`,
    });
    expect(update).toMatchObject({
      title: "Updated property building categories",
      description: `Updated “Main Boulevard Plaza” (${ref(p.property_no)}): building categories. Added Hotel Apartments — 2 Bedrooms. Removed Residential — 1 Bedroom.`,
      changes: [
        {
          label: "Building categories",
          before: "Residential — 1 Bedroom",
          after: "Hotel Apartments — 2 Bedrooms",
        },
      ],
    });
    expect(update.actor.name).toBe("Ali Agent");
    expect(noop).toMatchObject({
      title: "Updated a property listing",
      description: `Saved “Main Boulevard Plaza” (${ref(p.property_no)}) without changes.`,
    });
  });
  it("names other actual changes and keeps owner contact values out", async () => {
    const p = await create(agent, {
      owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 1234567" },
    });
    await edit(agent, p.id, {
      title: "Main Boulevard Plaza",
      price: 1,
      owner_contact: { owner_name: "Mr Malik", owner_phone: "0300 7654321" },
    });
    const meta = (
      await one(
        "select metadata from audit_log where action='update' and entity_id=$1",
        [p.id],
      )
    ).metadata;
    expect(meta.changed).toEqual(["price", "owner_contact"]);
    expect(JSON.stringify(meta)).not.toMatch(/Malik|7654321|Khan/);
    const entry = (await get(admin, "/audit?module=properties")).body.data[0];
    expect(entry.description).toBe(
      `Updated “Main Boulevard Plaza” (${ref(p.property_no)}): price and owner contact.`,
    );
  });
});

describe("one list of categories", () => {
  it("matches across the database, the API and the screens", async () => {
    const sql = await one(
      "select public.property_category_list() list,array(select public.property_category_label(c) from unnest(public.property_category_list()) c) labels",
    );
    expect(sql.list).toEqual(ALL);
    expect(buildingCategories.map((c) => c.value)).toEqual(ALL);
    expect(clientInventory.buildingCategories.map((c) => c.value)).toEqual(ALL);
    expect(buildingCategories.map((c) => c.label)).toEqual(sql.labels);
    expect(clientInventory.buildingCategories.map((c) => c.label)).toEqual(
      sql.labels,
    );
  });
});

describe("update 046", () => {
  it("can be applied again, also after 041, without changing saved categories", async () => {
    const p = await create(agent, {
      building_categories: ["residential_1_bed", "workspace"],
    });
    const migration = (name) =>
      readFile(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      );
    await pg.exec(await migration("046_building_property_categories.sql"));
    await pg.exec(await migration("041_property_inventory.sql"));
    expect(await stored(p.id)).toEqual(["residential_1_bed", "workspace"]);
    // 041's own save still works on the new column; then 046 is reapplied.
    expect((await create(agent)).building_categories).toEqual([]);
    await pg.exec(await migration("046_building_property_categories.sql"));
    expect(
      (await edit(agent, p.id, { building_categories: ["workspace"] })).body
        .building_categories,
    ).toEqual(["workspace"]);
  });
});
