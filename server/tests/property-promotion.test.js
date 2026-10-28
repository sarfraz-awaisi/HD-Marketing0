import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { cleanupPropertyPhotos } from "../src/jobs/cleanupPropertyPhotos.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 044: administrators add an agent's listing to Admin Properties as an
// independent copy. Requests run against every real migration in PGlite;
// only Supabase Storage is replaced, by an in-memory bucket that also copies,
// so the tests can see exactly which files exist.
const admin = "4e000000-0000-4000-8000-000000000001",
  agent = "4e000000-0000-4000-8000-000000000002",
  other = "4e000000-0000-4000-8000-000000000003",
  secondAdmin = "4e000000-0000-4000-8000-000000000004";
let pg, db, one, all, files, copyHook;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  files = new Map();
  copyHook = null;
});
const notFound = {
  status: 400,
  statusCode: "404",
  message: "Object not found",
};
const bucket = {
  upload: async (path, body) => {
    files.set(path, Buffer.from(body));
    return { data: { path } };
  },
  copy: async (from, to) => {
    const hooked = copyHook && (await copyHook(from, to));
    if (hooked) return hooked;
    if (!files.has(from)) return { data: null, error: notFound };
    files.set(to, Buffer.from(files.get(from)));
    return { data: { path: to } };
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
const promote = (user, id) =>
  send(user, "post", `/properties/${id}/promote`, {});
const listing = {
  title: "Garden villa",
  type: "House",
  purpose: "sale",
  price: 25000000,
  price_negotiable: true,
  price_notes: "Token 10%",
  area: 10,
  area_unit: "marla",
  province: "Punjab",
  city: "Lahore",
  area_society: "DHA Phase 6",
  block_sector: "Block C",
  street: "Street 4",
  plot_number: "112",
  address: "112 Street 4, Block C, DHA Phase 6, Lahore",
  map_url: "https://maps.example.com/112",
  bedrooms: 5,
  bathrooms: 4,
  kitchens: 2,
  floors: 2,
  parking_spaces: 2,
  furnishing: "semi_furnished",
  construction_status: "ready",
  property_age: 3,
  amenities: ["gas", "electricity", "corner"],
  description: "Corner house facing the park.",
};
async function create(user, extra = {}) {
  const res = await send(user, "post", "/properties", { ...listing, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const png = () =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    randomBytes(16),
  ]);
async function upload(user, id) {
  const res = await request(app())
    .post(`/api/properties/${id}/photos`)
    .set(as(user))
    .attach("file", png(), { filename: "front.png", contentType: "image/png" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
const photoRows = (id) =>
  all(
    "select id,storage_path,position from property_photos where property_id=$1 order by position",
    [id],
  );
const notices = () =>
  all(
    "select user_id,type,title,body,link,item_count from notifications order by created_at,id",
  );
const uidOf = async (id) =>
  (await one("select uid from profiles where id=$1", [id])).uid;
// An agent listing with two pictures, ready to be promoted.
async function agentListing(extra) {
  const source = await create(agent, {
    owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 1234567" },
    ...extra,
  });
  await upload(agent, source.id);
  await upload(agent, source.id);
  return source;
}
const listingFields = Object.keys(listing);
const pick = (row) => Object.fromEntries(listingFields.map((k) => [k, row[k]]));

describe("adding an agent listing to Admin Properties", () => {
  it("creates an independent company copy and leaves the original unchanged", async () => {
    const source = await agentListing();
    const before = await one(
      "select to_jsonb(p) row from properties p where id=$1",
      [source.id],
    );
    const sourcePhotos = await photoRows(source.id);
    const res = await promote(admin, source.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copy = res.body;
    expect(copy.id).not.toBe(source.id);
    expect(copy.property_no).not.toBe(source.property_no);
    expect(copy).toMatchObject({
      ownership: "company",
      owner_agent_id: null,
      created_by: admin,
      updated_by: admin,
      location: source.location,
      category: "residential",
      can_edit: true,
      photos_missing: 0,
      promoted_from: {
        agent_name: "Ali Agent",
        agent_uid: await uidOf(agent),
        agent_status: "active",
        source_id: source.id,
        source_property_no: source.property_no,
        source_removed: false,
      },
    });
    expect(pick(copy)).toEqual(pick(source));
    expect(new Date(copy.created_at) >= new Date(source.created_at)).toBe(true);
    // The seller's contact is copied for administrators only.
    expect(copy.owner_contact).toMatchObject({
      owner_name: "Mr Khan",
      owner_phone: "+923001234567",
      share_with_agents: false,
    });
    // The original record and its pictures are exactly as before.
    expect(
      (
        await one("select to_jsonb(p) row from properties p where id=$1", [
          source.id,
        ])
      ).row,
    ).toEqual(before.row);
    expect(await photoRows(source.id)).toEqual(sourcePhotos);
    // The copy has its own files, in the same order, with the same content.
    const copyPhotos = await photoRows(copy.id);
    expect(copyPhotos.map((p) => p.position)).toEqual([0, 1]);
    copyPhotos.forEach((p, i) => {
      expect(p.storage_path.startsWith(copy.id + "/")).toBe(true);
      expect(p.storage_path).not.toBe(sourcePhotos[i].storage_path);
      expect(files.get(p.storage_path)).toEqual(
        files.get(sourcePhotos[i].storage_path),
      );
    });
    // Reservations for the kept pictures are released; nothing is queued
    // for removal under the copy.
    expect(
      await all(
        "select storage_path from property_photo_cleanup where property_id=$1",
        [copy.id],
      ),
    ).toEqual([]);
    // The administrator's view of the original links to its copy.
    const original = (await get(admin, "/properties/" + source.id)).body;
    expect(original).toMatchObject({
      can_promote: false,
      admin_copy: { id: copy.id, property_no: copy.property_no },
    });
    // The promotion is recorded once, in plain English.
    const audit = await get(admin, "/audit?module=properties&kind=create");
    const entry = audit.body.data.find(
      (e) => e.title === "Added an agent property to Admin Properties",
    );
    expect(entry.actor.name).toBe("Owner");
    expect(entry.description).toBe(
      `Added “Garden villa” (PR-${String(copy.property_no).padStart(6, "0")}) to Admin Properties as an independent copy of PR-${String(source.property_no).padStart(6, "0")}, originally listed by Ali Agent (UID ${await uidOf(agent)}), with 2 photos.`,
    );
    expect(entry.record).toMatchObject({ label: "Garden villa" });
    expect(
      (await all("select 1 from audit_log where action='promote'")).length,
    ).toBe(1);
  });

  it("is for administrators only", async () => {
    const source = await agentListing();
    expect((await promote(agent, source.id)).status).toBe(403);
    expect((await promote(other, source.id)).status).toBe(403);
    // Calling the database directly is refused too.
    const direct = await db.rpc("inventory_promote_prepare", {
      p_actor: agent,
      p_property: source.id,
      p_copy: "4e000000-0000-4000-8000-0000000000aa",
    });
    expect(direct.error.code).toBe("HA403");
    expect(await all("select 1 from property_promotions")).toEqual([]);
    expect(
      await all("select 1 from properties where owner_agent_id is null"),
    ).toEqual([]);
  });

  it("refuses company properties, closed listings, missing ones and a second copy", async () => {
    const company = await create(admin);
    expect((await promote(admin, company.id)).status).toBe(400);
    const sold = await create(agent, { availability: "sold" });
    const archived = await create(agent, { availability: "archived" });
    for (const p of [sold, archived]) {
      const res = await promote(admin, p.id);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Only available or reserved listings/);
    }
    expect(
      (await promote(admin, "4e000000-0000-4000-8000-0000000000ff")).status,
    ).toBe(404);
    const source = await agentListing({ availability: "reserved" });
    const first = await promote(admin, source.id);
    expect(first.status).toBe(201);
    const again = await promote(admin, source.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(
      `This property is already in the Admin list as PR-${String(first.body.property_no).padStart(6, "0")}`,
    );
    // The copy itself is company inventory and cannot be promoted.
    expect((await promote(admin, first.body.id)).status).toBe(400);
    expect(await all("select 1 from property_promotions")).toHaveLength(1);
    // A refused attempt leaves no reserved or copied files behind.
    expect([...files.keys()].filter((p) => !p.startsWith(source.id))).toEqual(
      (await photoRows(first.body.id)).map((p) => p.storage_path),
    );
  });

  it("creates one copy when two administrators add the same listing at once", async () => {
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'second@gmail.com',now())",
      [secondAdmin],
    );
    await pg.query(
      "update profiles set active=true,name='Second Admin',role='admin' where id=$1",
      [secondAdmin],
    );
    const source = await agentListing();
    const results = await Promise.all([
      promote(admin, source.id),
      promote(secondAdmin, source.id),
      promote(admin, source.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const copies = await all(
      "select id from properties where owner_agent_id is null",
    );
    expect(copies).toHaveLength(1);
    // Only the source files and the winning copy's files remain.
    const kept = (await photoRows(copies[0].id)).map((p) => p.storage_path);
    const sourceFiles = (await photoRows(source.id)).map((p) => p.storage_path);
    expect([...files.keys()].sort()).toEqual([...sourceFiles, ...kept].sort());
    expect(
      await all(
        "select 1 from property_photo_cleanup where property_id<>$1 and not_before>now()",
        [source.id],
      ),
    ).toEqual([]);
  });

  it("skips a picture missing from Storage and still adds the listing", async () => {
    const source = await agentListing();
    const [missing] = await photoRows(source.id);
    files.delete(missing.storage_path);
    const res = await promote(admin, source.id);
    expect(res.status).toBe(201);
    expect(res.body.photos_missing).toBe(1);
    expect(await photoRows(res.body.id)).toHaveLength(1);
    const audit = await one(
      "select metadata from audit_log where action='promote'",
    );
    expect(audit.metadata).toMatchObject({ photo_count: 1, photos_missing: 1 });
  });

  it("leaves no listing or copied files when copying fails part-way", async () => {
    const source = await agentListing();
    let copies = 0;
    copyHook = async () =>
      ++copies === 2
        ? { data: null, error: { status: 503, message: "Storage unavailable" } }
        : null;
    const res = await promote(admin, source.id);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      "The pictures could not be copied. Please try again.",
    );
    expect(
      await all("select 1 from properties where owner_agent_id is null"),
    ).toEqual([]);
    expect(await all("select 1 from property_promotions")).toEqual([]);
    // The first picture had been copied: it is removed again, the source's
    // files are untouched, and its reservation is due for the clean-up job.
    const sourceFiles = (await photoRows(source.id)).map((p) => p.storage_path);
    expect([...files.keys()].sort()).toEqual(sourceFiles.sort());
    expect(
      await all(
        "select 1 from property_photo_cleanup where property_id<>$1 and not_before>now()",
        [source.id],
      ),
    ).toEqual([]);
    // Trying again works.
    copyHook = null;
    expect((await promote(admin, source.id)).status).toBe(201);
  });

  it("refuses to keep pictures whose reservation was released meanwhile", async () => {
    const source = await agentListing();
    // As if a clean-up worker had already processed the reservation.
    copyHook = async (from, to) => {
      await pg.query(
        "delete from property_photo_cleanup where storage_path=$1",
        [to],
      );
      return null;
    };
    const res = await promote(admin, source.id);
    expect(res.status).toBe(409);
    expect(
      await all("select 1 from properties where owner_agent_id is null"),
    ).toEqual([]);
    const sourceFiles = (await photoRows(source.id)).map((p) => p.storage_path);
    expect([...files.keys()].sort()).toEqual(sourceFiles.sort());
  });

  it("never removes reserved pictures before they are due", async () => {
    const source = await agentListing();
    const copyId = "4e000000-0000-4000-8000-0000000000c1";
    const plan = await db.rpc("inventory_promote_prepare", {
      p_actor: admin,
      p_property: source.id,
      p_copy: copyId,
    });
    expect(plan.data.photos).toHaveLength(2);
    for (const p of plan.data.photos) await bucket.copy(p.from, p.to);
    // A query builder over the real queue, for the clean-up job.
    const removed = [];
    const jobDb = {
      from: () => {
        const where = [],
          args = [];
        let deleting = false;
        const q = {
          select: () => q,
          order: () => q,
          limit: () => q,
          lte: (k, v) => (args.push(v), where.push(`${k}<=$${args.length}`), q),
          eq: (k, v) => (args.push(v), where.push(`${k}=$${args.length}`), q),
          delete: () => ((deleting = true), q),
          in: (k, v) => (
            args.push(v),
            where.push(`${k}=any($${args.length})`),
            q
          ),
          then: (resolve, reject) =>
            pg
              .query(
                `${deleting ? "delete" : "select id,storage_path"} from property_photo_cleanup where ${where.join(" and ")}`,
                args,
              )
              .then((r) => ({ data: r.rows }))
              .then(resolve, reject),
        };
        return q;
      },
      storage: {
        from: () => ({
          remove: async (paths) => {
            removed.push(...paths);
            return bucket.remove(paths);
          },
        }),
      },
    };
    await cleanupPropertyPhotos(jobDb, copyId);
    expect(removed).toEqual([]);
    expect(plan.data.photos.every((p) => files.has(p.to))).toBe(true);
    // Released: the job now removes the copies, never the originals.
    await db.rpc("inventory_promote_release", {
      p_actor: admin,
      p_copy: copyId,
    });
    await cleanupPropertyPhotos(jobDb, copyId);
    expect(removed.sort()).toEqual(plan.data.photos.map((p) => p.to).sort());
    expect(plan.data.photos.every((p) => files.has(p.from))).toBe(true);
  });
});

describe("independent records", () => {
  it("never synchronizes edits, pictures or deletion", async () => {
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    // The agent changes the original: the copy stays as it was.
    const agentEdit = await send(agent, "patch", "/properties/" + source.id, {
      price: 26000000,
      title: "Garden villa (new paint)",
      expected_updated_at: source.updated_at,
    });
    expect(agentEdit.status).toBe(200);
    let adminCopy = (await get(admin, "/properties/" + copy.id)).body;
    expect(adminCopy).toMatchObject({ price: 25000000, title: "Garden villa" });
    // The administrator changes the copy: the original stays as it was.
    const adminEdit = await send(admin, "patch", "/properties/" + copy.id, {
      price: 24000000,
      availability: "reserved",
    });
    expect(adminEdit.status).toBe(200);
    const original = (await get(agent, "/properties/" + source.id)).body;
    expect(original).toMatchObject({
      price: 26000000,
      availability: "available",
    });
    // Pictures: removing one on either side leaves the other's files.
    const [sourcePhoto] = await photoRows(source.id);
    const [copyPhoto, secondCopyPhoto] = await photoRows(copy.id);
    expect(
      (
        await send(
          agent,
          "delete",
          `/properties/${source.id}/photos/${sourcePhoto.id}`,
        )
      ).status,
    ).toBe(204);
    expect(await photoRows(copy.id)).toHaveLength(2);
    expect(
      (
        await send(
          admin,
          "delete",
          `/properties/${copy.id}/photos/${copyPhoto.id}`,
        )
      ).status,
    ).toBe(204);
    expect(await photoRows(source.id)).toHaveLength(1);
    await upload(agent, source.id);
    expect(await photoRows(copy.id)).toEqual([secondCopyPhoto]);
    // Agents can read the copy but never change it.
    expect((await get(agent, "/properties/" + copy.id)).body.can_edit).toBe(
      false,
    );
    expect(
      (await send(agent, "patch", "/properties/" + copy.id, { price: 1 }))
        .status,
    ).toBe(403);
    expect((await send(agent, "delete", "/properties/" + copy.id)).status).toBe(
      403,
    );
    expect(
      (
        await send(
          agent,
          "delete",
          `/properties/${copy.id}/photos/${secondCopyPhoto.id}`,
        )
      ).status,
    ).toBe(403);
    // Deleting the original keeps the copy and its provenance.
    expect(
      (await send(agent, "delete", "/properties/" + source.id)).status,
    ).toBe(204);
    adminCopy = (await get(admin, "/properties/" + copy.id)).body;
    expect(adminCopy).toMatchObject({
      price: 24000000,
      promoted_from: {
        agent_name: "Ali Agent",
        source_id: null,
        source_property_no: source.property_no,
        source_removed: true,
      },
    });
    expect(await photoRows(copy.id)).toHaveLength(1);
    expect(files.has(secondCopyPhoto.storage_path)).toBe(true);
    const link = await one("select * from property_promotions");
    expect(link).toMatchObject({ source_id: null, copy_id: copy.id });
    expect(link.source_deleted_at).toBeTruthy();
  });

  it("keeps the original when the copy is deleted, which can then be added again", async () => {
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    expect((await send(admin, "delete", "/properties/" + copy.id)).status).toBe(
      204,
    );
    const original = (await get(admin, "/properties/" + source.id)).body;
    expect(original).toMatchObject({ can_promote: true, admin_copy: null });
    expect(await photoRows(source.id)).toHaveLength(2);
    const link = await one("select * from property_promotions");
    expect(link).toMatchObject({ source_id: source.id, copy_id: null });
    expect(link.copy_deleted_at).toBeTruthy();
    expect((await promote(admin, source.id)).status).toBe(201);
    expect(await all("select 1 from property_promotions")).toHaveLength(2);
  });

  it("shows agents who listed a copy, but not the original's details", async () => {
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    const list = (await get(other, "/properties?scope=company")).body.data;
    expect(list[0].promoted_from).toEqual({
      agent_name: "Ali Agent",
      agent_uid: await uidOf(agent),
      agent_status: "active",
      promoted_at: expect.any(String),
    });
    const seen = (await get(other, "/properties/" + copy.id)).body;
    expect(seen.can_edit).toBe(false);
    expect(seen).not.toHaveProperty("admin_copy");
    expect(seen.owner_contact ?? null).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(source.id);
    // The other agent still cannot open the original.
    expect((await get(other, "/properties/" + source.id)).status).toBe(404);
    // The listing agent keeps managing their own listing as before.
    const mine = (await get(agent, "/properties/" + source.id)).body;
    expect(mine.can_edit).toBe(true);
    expect(mine).not.toHaveProperty("admin_copy");
    // A renamed or disabled account is still identified by UID.
    await pg.query(
      "update profiles set name='Ali Raza',active=false where id=$1",
      [agent],
    );
    expect(
      (await get(other, "/properties/" + copy.id)).body.promoted_from,
    ).toMatchObject({
      agent_name: "Ali Raza",
      agent_uid: await uidOf(agent),
      agent_status: "inactive",
    });
    // Admin-created properties never claim an original agent.
    const own = await create(admin);
    expect((await get(other, "/properties/" + own.id)).body).not.toHaveProperty(
      "promoted_from",
    );
  });
});

describe("notifying administrators", () => {
  it("describes an agent's change to the original once per save", async () => {
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'second@gmail.com',now())",
      [secondAdmin],
    );
    await pg.query(
      "update profiles set active=false,name='Disabled Admin',role='admin' where id=$1",
      [secondAdmin],
    );
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    const ref = (n) => "PR-" + String(n).padStart(6, "0");
    await pg.exec("truncate notifications");
    const edit = await send(agent, "patch", "/properties/" + source.id, {
      price: 26000000,
      description: "Freshly painted.",
      owner_contact: { owner_name: "Mr Khan", owner_phone: "0300 7654321" },
    });
    expect(edit.status).toBe(200);
    const sent = await notices();
    // Active administrators only; never agents or a disabled administrator.
    expect(sent.map((n) => n.user_id)).toEqual([admin]);
    expect(sent[0]).toMatchObject({
      type: "property_source_updated",
      title: `Original property updated: ${ref(source.property_no)}`,
      body: `Ali Agent (UID ${await uidOf(agent)}) updated ${ref(source.property_no)}. Price: PKR 25,000,000 → PKR 26,000,000. Also changed: Description, Owner contact. Admin copy ${ref(copy.property_no)} has not been changed.`,
      link: `/inventory?tab=agents&agent=${agent}&property=${source.id}`,
      item_count: 1,
    });
    // The new owner number is never put in a notification.
    expect(sent[0].body).not.toMatch(/0300|7654321/);
    // A second save is a second notice; a save that changes nothing, none.
    await send(agent, "patch", "/properties/" + source.id, {
      availability: "reserved",
    });
    await send(agent, "patch", "/properties/" + source.id, {
      availability: "reserved",
      price: 26000000,
    });
    const after = await notices();
    expect(after).toHaveLength(2);
    expect(after[1].body).toContain("Status: Available → Reserved.");
  });

  it("stays quiet for listings without a copy and for administrators' own edits", async () => {
    const plain = await agentListing();
    await send(agent, "patch", "/properties/" + plain.id, { price: 1000 });
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    await pg.exec("truncate notifications");
    await send(admin, "patch", "/properties/" + copy.id, { price: 1000 });
    await upload(admin, copy.id);
    expect(await notices()).toEqual([]);
  });

  it("groups picture changes per listing per day", async () => {
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    await pg.exec("truncate notifications");
    const [photo] = await photoRows(source.id);
    await upload(agent, source.id);
    await send(agent, "delete", `/properties/${source.id}/photos/${photo.id}`);
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "property_source_updated",
      item_count: 2,
    });
    expect(sent[0].title).toMatch(
      /^2 picture changes on original property PR-/,
    );
    expect(sent[0].body).toContain(
      `Admin copy PR-${String(copy.property_no).padStart(6, "0")} keeps its own pictures.`,
    );
  });

  it("reports the deletion of the original and links to the copy", async () => {
    const source = await agentListing();
    const copy = (await promote(admin, source.id)).body;
    await pg.exec("truncate notifications");
    expect(
      (await send(agent, "delete", "/properties/" + source.id)).status,
    ).toBe(204);
    const [notice] = await notices();
    expect(notice).toMatchObject({
      user_id: admin,
      type: "property_source_removed",
      link: `/inventory?tab=company&property=${copy.id}`,
    });
    expect(notice.body).toContain("is unchanged and stays in Admin Properties");
    const audit = await get(admin, "/audit?module=properties&kind=delete");
    expect(audit.body.data[0].description).toContain(
      `Its copy in Admin Properties (PR-${String(copy.property_no).padStart(6, "0")}) was kept.`,
    );
  });
});

describe("counting properties", () => {
  const summary = async () => (await get(admin, "/inventory/summary")).body;
  it("counts a promoted listing once overall and once per inventory", async () => {
    await create(admin);
    const a = await agentListing();
    const b = await agentListing();
    await create(other);
    const before = await summary();
    expect(before).toMatchObject({
      company: { total: 1 },
      agents: { total: 3 },
      all: { total: 4 },
      unique: { total: 4, available: 4 },
      promoted: 0,
    });
    const copyA = (await promote(admin, a.id)).body;
    await promote(admin, b.id);
    await promote(admin, b.id);
    const after = await summary();
    expect(after).toMatchObject({
      company: { total: 3 },
      agents: { total: 3 },
      all: { total: 6 },
      unique: { total: 4, available: 4 },
      promoted: 2,
      agents_with_properties: 2,
    });
    // An agent's own counts do not change.
    const directory = (await get(admin, "/inventory/agents")).body.data;
    expect(directory.find((r) => r.id === agent).total).toBe(2);
    // Statuses are counted once, from the original listing.
    await send(admin, "patch", "/properties/" + copyA.id, {
      availability: "reserved",
    });
    expect((await summary()).unique).toMatchObject({
      total: 4,
      available: 4,
      reserved: 0,
    });
    // Deleting the original leaves the copy as the one listing; deleting a
    // copy leaves the original.
    await send(agent, "delete", "/properties/" + a.id);
    expect((await summary()).unique).toMatchObject({ total: 4, reserved: 1 });
    const copyB = await one(
      "select copy_id from property_promotions where source_id=$1",
      [b.id],
    );
    await send(admin, "delete", "/properties/" + copyB.copy_id);
    expect(await summary()).toMatchObject({
      company: { total: 2 },
      agents: { total: 2 },
      unique: { total: 4 },
      promoted: 1,
    });
    // Archiving keeps the listing in the totals, as before, counted once.
    await send(agent, "patch", "/properties/" + b.id, {
      availability: "archived",
    });
    expect((await summary()).unique).toMatchObject({ total: 4, inactive: 1 });
  });
});
