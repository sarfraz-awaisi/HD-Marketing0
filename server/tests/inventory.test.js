import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 041: property inventory. API requests run against every real
// migration in PGlite. Only Supabase Storage is replaced, by an in-memory
// bucket, so picture tests can check what reaches Storage.
const admin = "1e000000-0000-4000-8000-000000000001",
  agent = "1e000000-0000-4000-8000-000000000002",
  other = "1e000000-0000-4000-8000-000000000003";
let pg, db, one, all, files, uploads;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  files = new Map();
  uploads = [];
});
const bucket = {
  upload: async (path, body) => {
    uploads.push(path);
    files.set(path, body);
    return { data: { path } };
  },
  remove: async (paths) => {
    for (const path of paths) files.delete(path);
    return { data: [] };
  },
  createSignedUrls: async (paths) => ({
    data: paths.map((path) => ({
      path,
      signedUrl: `https://storage.test/${path}?token=t`,
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
const house = (extra = {}) => ({
  title: "Corner house",
  type: "House",
  purpose: "sale",
  price: 25000000,
  area: 10,
  area_unit: "marla",
  city: "Lahore",
  area_society: "DHA Phase 6",
  block_sector: "Block C",
  bedrooms: 4,
  ...extra,
});
async function create(user, extra) {
  const res = await send(user, "post", "/properties", house(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(16),
]);
const upload = (user, id) =>
  request(app())
    .post(`/api/properties/${id}/photos`)
    .set(as(user))
    .attach("file", png, { filename: "front.png", contentType: "image/png" });

describe("agent inventory", () => {
  it("creates a private property owned by the signed-in agent", async () => {
    const created = await create(agent, {
      owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 1234567" },
    });
    expect(created).toMatchObject({
      ownership: "agent",
      owner_agent_id: agent,
      created_by: agent,
      category: "residential",
      location: "Block C, DHA Phase 6, Lahore",
      can_edit: true,
    });
    // The agent's own owner number is returned unmasked and normalized.
    expect(created.owner_contact).toMatchObject({
      owner_name: "Mr Khan",
      owner_phone: "+923001234567",
      share_with_agents: false,
    });
    const mine = await get(agent, "/properties?scope=mine");
    expect(mine.body.data.map((p) => p.id)).toEqual([created.id]);
    expect(mine.body.data[0]).not.toHaveProperty("owner_contact");
    expect(mine.body.data[0]).not.toHaveProperty("cover_path");
  });
  it("edits and deletes only its own property", async () => {
    const { id, updated_at } = await create(agent);
    const edited = await send(agent, "patch", "/properties/" + id, {
      price: 26000000,
      availability: "reserved",
      expected_updated_at: updated_at,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      price: 26000000,
      availability: "reserved",
      updated_by: agent,
    });
    // A save based on the older copy is refused instead of overwriting.
    const stale = await send(agent, "patch", "/properties/" + id, {
      price: 1,
      expected_updated_at: updated_at,
    });
    expect(stale.status).toBe(409);
    expect((await send(agent, "delete", "/properties/" + id)).status).toBe(204);
    expect((await get(agent, "/properties/" + id)).status).toBe(404);
  });
  it("searches, filters and sorts its own properties", async () => {
    const first = await create(agent, { title: "Garden villa", price: 9e6 });
    await create(agent, {
      title: "Flat",
      type: "Apartment",
      purpose: "rent",
      price: 80000,
      city: "Karachi",
      area_society: "Clifton",
      availability: "rented",
    });
    const ids = async (query) =>
      (await get(agent, "/properties?scope=mine&" + query)).body.data.map(
        (p) => p.title,
      );
    expect(await ids("purpose=rent")).toEqual(["Flat"]);
    expect(await ids("status=rented")).toEqual(["Flat"]);
    expect(await ids("type=House")).toEqual(["Garden villa"]);
    expect(await ids("city=clifton")).toEqual(["Flat"]);
    expect(await ids("search=garden")).toEqual(["Garden villa"]);
    expect(await ids("search=PR-" + first.property_no)).toEqual([
      "Garden villa",
    ]);
    expect(await ids("min_price=100000&max_price=10000000")).toEqual([
      "Garden villa",
    ]);
    expect(await ids("sort=price_low")).toEqual(["Flat", "Garden villa"]);
    const paged = await get(agent, "/properties?scope=mine&limit=1&page=2");
    expect(paged.body).toMatchObject({ count: 2, page: 2, limit: 1 });
    expect(paged.body.data).toHaveLength(1);
    expect(
      (await get(agent, "/properties?scope=mine&min_price=5&max_price=1"))
        .status,
    ).toBe(400);
  });
  it("cannot see, change or delete another agent's property", async () => {
    const { id } = await create(agent);
    expect((await get(other, "/properties?scope=mine")).body.count).toBe(0);
    expect((await get(other, "/properties")).body.count).toBe(0);
    for (const res of [
      await get(other, "/properties/" + id),
      await get(other, `/properties/${id}/photos`),
      await send(other, "patch", "/properties/" + id, { price: 1 }),
      await send(other, "delete", "/properties/" + id),
      await upload(other, id),
    ])
      expect(res.status).toBe(404);
    expect(uploads).toEqual([]);
    // Counts and the directory are not available to agents.
    expect(
      (await get(other, `/properties?scope=agent&agent=${agent}`)).status,
    ).toBe(403);
    expect((await get(other, "/inventory/agents")).status).toBe(403);
    const summary = (await get(other, "/inventory/summary")).body;
    expect(summary).toMatchObject({ role: "agent", mine: { total: 0 } });
    expect(summary).not.toHaveProperty("agents");
    expect(summary).not.toHaveProperty("all");
  });
  it("cannot choose or change the owner", async () => {
    const forged = await send(agent, "post", "/properties", {
      ...house(),
      owner_agent_id: other,
    });
    expect(forged.status).toBe(400);
    const { id } = await create(agent);
    for (const body of [
      { owner_agent_id: other },
      { created_by: other },
      { ownership: "company" },
    ])
      expect(
        (await send(agent, "patch", "/properties/" + id, body)).status,
      ).toBe(400);
    expect(
      (await one("select owner_agent_id from properties where id=$1", [id]))
        .owner_agent_id,
    ).toBe(agent);
    await expect(
      pg.query("update properties set owner_agent_id=null where id=$1", [id]),
    ).rejects.toMatchObject({ code: "HA403" });
  });
});

describe("company inventory", () => {
  it("is managed by administrators and read-only for agents", async () => {
    const created = await create(admin, {
      title: "Head office listing",
      owner_contact: {
        owner_name: "Owner",
        owner_phone: "+923009999999",
        owner_notes: "Call after 6pm",
      },
    });
    expect(created).toMatchObject({
      ownership: "company",
      owner_agent_id: null,
      created_by: admin,
    });
    const listed = await get(agent, "/properties?scope=company");
    expect(listed.body.data.map((p) => p.id)).toEqual([created.id]);
    const detail = await get(agent, "/properties/" + created.id);
    expect(detail.body).toMatchObject({ can_edit: false, owner_contact: null });
    for (const res of [
      await send(agent, "patch", "/properties/" + created.id, { price: 1 }),
      await send(agent, "patch", "/properties/" + created.id, {
        availability: "sold",
      }),
      await send(agent, "delete", "/properties/" + created.id),
      await upload(agent, created.id),
    ])
      expect(res.status).toBe(403);
    expect(uploads).toEqual([]);
    expect(
      (await send(agent, "post", "/properties", house())).body.ownership,
    ).toBe("agent");
    const edited = await send(admin, "patch", "/properties/" + created.id, {
      price: 30000000,
    });
    expect(edited.body).toMatchObject({ price: 30000000, updated_by: admin });
    expect(
      (await send(admin, "delete", "/properties/" + created.id)).status,
    ).toBe(204);
  });
  it("shares only the owner contact an administrator chose to share", async () => {
    const { id } = await create(admin, {
      description: "Owner on 0300 7654321",
      owner_contact: {
        owner_name: "Owner",
        owner_phone: "+923009999999",
        owner_notes: "Private note",
        share_with_agents: true,
      },
    });
    const detail = (await get(agent, "/properties/" + id)).body;
    expect(detail.owner_contact).toEqual({
      owner_name: "Owner",
      owner_phone: "+923009999999",
      owner_alt_phone: null,
      share_with_agents: true,
    });
    // Free text keeps the CRM's agent phone masking.
    expect(detail.description).not.toContain("7654321");
    expect(
      (await get(admin, "/properties/" + id)).body.owner_contact,
    ).toMatchObject({ owner_notes: "Private note" });
  });
  it("keeps lead, visit and deal property choices to company inventory", async () => {
    const company = await create(admin, { title: "Company" });
    const mine = await create(agent, { title: "Private" });
    const choices = await get(agent, "/properties?limit=100");
    expect(choices.body.data.map((p) => p.title)).toEqual(["Company"]);
    const lead = await one(
      "insert into leads(name,masked_phone,assigned_agent) values('Buyer','******123',$1) returning id",
      [agent],
    );
    await expect(
      pg.query(
        "insert into visits(lead_id,agent_id,property_id,scheduled_at) values($1,$2,$3,now())",
        [lead.id, agent, mine.id],
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      pg.query("update leads set property_id=$1 where id=$2", [
        mine.id,
        lead.id,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await pg.query("update leads set property_id=$1 where id=$2", [
      company.id,
      lead.id,
    ]);
    const blocked = await send(admin, "delete", "/properties/" + company.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Archive/);
  });
});

describe("administrator view of agent inventories", () => {
  it("lists agents with counts and opens a read-only agent inventory", async () => {
    const mine = await create(agent, {
      owner_contact: { owner_phone: "+923001112223" },
    });
    await create(agent, { availability: "sold" });
    await create(admin);
    const agents = (await get(admin, "/inventory/agents")).body;
    expect(agents.count).toBe(2);
    expect(agents.data[0]).toMatchObject({
      id: agent,
      name: "Ali Agent",
      email: "agent@gmail.com",
      status: "active",
      total: 2,
      available: 1,
      sold: 1,
    });
    expect(agents.data[0].last_updated).toBeTruthy();
    expect(agents.data[1]).toMatchObject({ id: other, total: 0 });
    const searched = (await get(admin, "/inventory/agents?search=sara")).body;
    expect(searched.data.map((a) => a.id)).toEqual([other]);
    const inventory = (
      await get(admin, `/properties?scope=agent&agent=${agent}&status=sold`)
    ).body;
    expect(inventory).toMatchObject({ count: 1, agent: { id: agent } });
    const detail = (await get(admin, "/properties/" + mine.id)).body;
    expect(detail).toMatchObject({
      can_edit: false,
      owner_agent_name: "Ali Agent",
    });
    expect(detail.owner_contact.owner_phone).toBe("+923001112223");
    for (const res of [
      await send(admin, "patch", "/properties/" + mine.id, { price: 1 }),
      await send(admin, "delete", "/properties/" + mine.id),
      await upload(admin, mine.id),
    ])
      expect(res.status).toBe(403);
    expect((await get(admin, "/properties?scope=mine")).status).toBe(400);
  });
  it("reports accurate inventory statistics", async () => {
    await create(admin);
    await create(admin, { purpose: "rent", availability: "rented" });
    await create(agent, { availability: "reserved" });
    await create(other, { availability: "sold" });
    const summary = (await get(admin, "/inventory/summary")).body;
    expect(summary).toMatchObject({
      role: "admin",
      company: { total: 2, available: 1, rented: 1 },
      agents: { total: 2, reserved: 1, sold: 1 },
      all: { total: 4, available: 1, reserved: 1, sold: 1, rented: 1 },
      agents_with_properties: 2,
    });
    expect((await get(agent, "/inventory/summary")).body).toMatchObject({
      mine: { total: 1, reserved: 1 },
      company: { total: 2 },
    });
  });
  it("keeps a deleted agent's inventory visible to administrators", async () => {
    await create(other);
    await pg.query(
      "update profiles set active=false,deletion_requested_at=now(),deleted_at=now() where id=$1",
      [other],
    );
    const row = (await get(admin, "/inventory/agents")).body.data.find(
      (a) => a.id === other,
    );
    expect(row).toMatchObject({ status: "deleted", total: 1 });
  });
});

describe("property pictures", () => {
  it("lets the owning agent upload, order and remove pictures", async () => {
    const { id } = await create(agent);
    const first = await upload(agent, id);
    const second = await upload(agent, id);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(uploads).toHaveLength(2);
    expect(uploads.every((path) => path.startsWith(id + "/"))).toBe(true);
    const photos = (await get(agent, `/properties/${id}/photos`)).body;
    expect(photos.map((p) => p.id)).toEqual([first.body.id, second.body.id]);
    expect(JSON.stringify(photos)).not.toContain("storage_path");
    const ordered = await send(agent, "put", `/properties/${id}/photos/order`, {
      photo_ids: [second.body.id, first.body.id],
    });
    expect(ordered.body).toEqual([
      { id: second.body.id },
      { id: first.body.id },
    ]);
    const card = (await get(agent, "/properties?scope=mine&covers=true")).body
      .data[0];
    expect(card).toMatchObject({
      photo_count: 2,
      cover_photo: { id: second.body.id },
    });
    expect(
      (await send(agent, "delete", `/properties/${id}/photos/${first.body.id}`))
        .status,
    ).toBe(204);
    expect(
      await one(
        "select storage_path from property_photo_cleanup where property_id=$1",
        [id],
      ),
    ).toBeTruthy();
    // Admins and other agents can view but never change these pictures.
    expect((await get(admin, `/properties/${id}/photos`)).body).toHaveLength(1);
    expect(
      (
        await send(
          admin,
          "delete",
          `/properties/${id}/photos/${second.body.id}`,
        )
      ).status,
    ).toBe(403);
  });
  it("lets agents view company pictures but not change them", async () => {
    const { id } = await create(admin);
    const photo = (await upload(admin, id)).body;
    expect((await get(agent, `/properties/${id}/photos`)).body).toHaveLength(1);
    expect(
      (await send(agent, "delete", `/properties/${id}/photos/${photo.id}`))
        .status,
    ).toBe(403);
    expect(
      (
        await send(agent, "put", `/properties/${id}/photos/order`, {
          photo_ids: [photo.id],
        })
      ).status,
    ).toBe(403);
  });
  it("rejects files that are not real images before Storage", async () => {
    const { id } = await create(agent);
    const res = await request(app())
      .post(`/api/properties/${id}/photos`)
      .set(as(agent))
      .attach("file", Buffer.from("not an image"), {
        filename: "x.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(400);
    expect(uploads).toEqual([]);
  });
});

describe("inventory database security", () => {
  it("gives browser roles no access to inventory functions or owner contacts", async () => {
    for (const role of ["anon", "authenticated"]) {
      const rows = await all(
        "select p.proname,has_function_privilege($1,p.oid,'execute') allowed from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'inventory%' or p.proname='delete_property')",
        [role],
      );
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.filter((r) => r.allowed)).toEqual([]);
      expect(
        (
          await one(
            "select has_table_privilege($1,'public.property_owner_contacts','select') r",
            [role],
          )
        ).r,
      ).toBe(false);
    }
    expect(
      (
        await one(
          "select relrowsecurity r from pg_class where oid='public.property_owner_contacts'::regclass",
        )
      ).r,
    ).toBe(true);
  });
  it("can be applied again without changing existing inventory", async () => {
    const { id } = await create(agent);
    await pg.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/041_property_inventory.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      await one(
        "select owner_agent_id,property_no from properties where id=$1",
        [id],
      ),
    ).toMatchObject({ owner_agent_id: agent });
  });
  it("rejects inactive accounts", async () => {
    const { id } = await create(agent);
    await pg.query("update profiles set active=false where id=$1", [agent]);
    expect((await get(agent, "/properties/" + id)).status).toBe(403);
    await expect(
      one("select inventory_page($1,'mine',null,'{}',1,20)", [agent]),
    ).rejects.toMatchObject({ code: "HA403" });
  });
});
