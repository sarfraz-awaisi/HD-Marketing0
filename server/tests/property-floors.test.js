import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 054: the floor of an apartment, portion, shop or office, through the
// API to every real migration in PGlite.
const admin = "54300000-0000-4000-8000-000000000001",
  ali = "54300000-0000-4000-8000-000000000002",
  sara = "54300000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
});
const storage = {
  from: () => ({
    copy: async () => ({ data: {} }),
    remove: async () => ({ data: [] }),
    createSignedUrls: async (paths) => ({ data: paths.map(() => ({})) }),
  }),
};
const app = () => createApp(trustedMfaFixture({ ...db, storage }));
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set({ Authorization: "Bearer " + user })
    .send(body);
const flat = (extra = {}) => ({
  title: "Flat for rent",
  type: "Apartment",
  purpose: "rent",
  price: 45000,
  area: 1100,
  area_unit: "sq ft",
  city: "Karachi",
  floors: 20,
  floor_level: 7,
  ...extra,
});
const create = async (user, extra) => {
  const res = await send(user, "post", "/properties", flat(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
const edit = (user, p, body) =>
  send(user, "patch", `/properties/${p.id}`, {
    ...body,
    expected_updated_at: p.updated_at,
  });

describe("property floors (update 054)", () => {
  it("records any floor up to the building's total, for sale and rent", async () => {
    expect(await create(ali)).toMatchObject({ floor_level: 7, floors: 20 });
    for (const [type, purpose, floor_level, floors] of [
      ["Apartment", "sale", 25, 40],
      ["Office", "rent", 12, null],
      ["Office", "sale", 100, 120],
      ["Shop", "rent", 0, 3],
      ["Portion", "rent", -1, 2],
      ["Apartment", "rent", -2, null],
      ["Apartment", "sale", 200, null],
    ])
      expect(
        await create(ali, { type, purpose, floor_level, floors }),
      ).toMatchObject({ type, purpose, floor_level, floors });
    for (const floor_level of [-3, 201, 1.5, "7"]) {
      const res = await send(ali, "post", "/properties", flat({ floor_level }));
      expect(res.status, String(floor_level)).toBe(400);
    }
    const above = await send(
      ali,
      "post",
      "/properties",
      flat({ floor_level: 21 }),
    );
    expect(above.status).toBe(400);
    expect(above.body.error).toContain("floor_level");
    // The database checks the record as saved: lowering the total floors
    // below the floor is refused too.
    const p = await create(ali);
    const lower = await edit(ali, p, { floors: 5 });
    expect(lower.status).toBe(400);
    expect(lower.body.error).toBe(
      "The floor cannot be above the building's total floors",
    );
    await expect(
      pg.query("select inventory_save($1,null,$2::jsonb,'t')", [
        ali,
        JSON.stringify({ ...flat(), floor_level: 30 }),
      ]),
    ).rejects.toMatchObject({ code: "HA400" });
  });
  it("clears the floor for types without one and keeps older properties valid", async () => {
    // Houses, plots and land are not on a floor.
    expect(
      await create(ali, {
        type: "House",
        purpose: "sale",
        floors: 2,
        floor_level: 1,
      }),
    ).toMatchObject({ floor_level: null, floors: 2 });
    const p = await create(ali);
    const house = await edit(ali, p, { type: "House" });
    expect(house.body).toMatchObject({
      type: "House",
      floor_level: null,
      floors: 20,
    });
    const back = await edit(ali, house.body, {
      type: "Apartment",
      floor_level: 3,
    });
    const plot = await edit(ali, back.body, { type: "Residential Plot" });
    expect(plot.body).toMatchObject({ floor_level: null, floors: null });
    // A property saved before 054 has no floor and saves as before.
    const old = await create(ali, {
      floor_level: undefined,
      floors: undefined,
    });
    expect(old.floor_level).toBeNull();
    const status = await edit(ali, old, { availability: "rented" });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      availability: "rented",
      floor_level: null,
    });
    expect(
      (
        await one(
          "select metadata->'changed' c from audit_log where action='update' and entity_id=$1 order by created_at desc limit 1",
          [old.id],
        )
      ).c,
    ).toEqual(["availability"]);
  });
  it("copies the floor to Admin Properties and tells administrators when it changes", async () => {
    const p = await create(ali);
    const copy = await send(admin, "post", `/properties/${p.id}/promote`, {});
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body).toMatchObject({ floor_level: 7, floors: 20 });
    await edit(ali, p, { floor_level: 9 });
    const notice = await one(
      "select body from notifications where user_id=$1 and type='property_source_updated' order by created_at desc limit 1",
      [admin],
    );
    expect(notice.body).toContain("Changed: Floor.");
    expect(
      (
        await one("select floor_level from properties where id=$1", [
          copy.body.id,
        ])
      ).floor_level,
    ).toBe(7);
  });
});
