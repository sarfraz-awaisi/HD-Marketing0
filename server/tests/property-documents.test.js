import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 054: PDF documents of a property. API requests run against every
// real migration in PGlite; only Supabase Storage is replaced, by an
// in-memory bucket, so the tests can check what reaches Storage.
const admin = "54200000-0000-4000-8000-000000000001",
  ali = "54200000-0000-4000-8000-000000000002",
  sara = "54200000-0000-4000-8000-000000000003";
let pg, db, one, all, files, buckets, failUpload, failCopy;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.exec("truncate property_document_cleanup");
  files = new Map();
  buckets = [];
  failUpload = false;
  failCopy = () => false;
  delete process.env.PROPERTY_DOCUMENT_MAX_MB;
});
const storage = {
  from: (name) => {
    buckets.push(name);
    return {
      upload: async (path, body) => {
        if (failUpload) return { error: { message: "Storage unavailable" } };
        files.set(path, body);
        return { data: { path } };
      },
      copy: async (from, to) => {
        if (failCopy(name, from))
          return { error: { status: 500, message: "Storage unavailable" } };
        if (!files.has(from))
          return { error: { status: 404, message: "Object not found" } };
        files.set(to, files.get(from));
        return { data: { path: to } };
      },
      remove: async (paths) => {
        for (const path of paths) files.delete(path);
        return { data: [] };
      },
      download: async (path) =>
        files.has(path)
          ? { data: new Blob([files.get(path)]) }
          : { error: { status: 404, message: "Object not found" } },
      createSignedUrls: async (paths) => ({
        data: paths.map((path) => ({ path, signedUrl: "https://s.test/x" })),
      }),
    };
  },
};
const app = () => createApp(trustedMfaFixture({ ...db, storage }));
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
const pdf = (size = 64) =>
  Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.alloc(Math.max(0, size - 15), 32),
    Buffer.from("\n%%EOF"),
  ]);
const upload = (user, id, body = pdf(), filename = "DHA Brochure.pdf", type) =>
  request(app())
    .post(`/api/properties/${id}/documents`)
    .set(as(user))
    .attach("file", body, {
      filename,
      contentType: type || "application/pdf",
    });
async function property(user, extra = {}) {
  const res = await send(user, "post", "/properties", {
    title: "Sea view apartment",
    type: "Apartment",
    purpose: "rent",
    price: 45000,
    area: 1200,
    area_unit: "sq ft",
    city: "Karachi",
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(16),
]);
const photo = (user, id) =>
  request(app())
    .post(`/api/properties/${id}/photos`)
    .set(as(user))
    .attach("file", png, { filename: "front.png", contentType: "image/png" });
const promote = (id) => send(admin, "post", `/properties/${id}/promote`, {});
const docsOf = (id) =>
  all(
    "select id,storage_path,file_name,size_bytes,uploaded_by,created_at from property_documents where property_id=$1 order by created_at,id",
    [id],
  );
const queue = (id) =>
  all(
    "select storage_path,not_before<=now() due from property_document_cleanup where property_id=$1 order by storage_path",
    [id],
  );

describe("property documents (update 054)", () => {
  it("lets an agent add, list, open and remove PDFs on their own property", async () => {
    const id = await property(ali);
    const added = await upload(
      ali,
      id,
      pdf(),
      "C:\\docs\\DHA Phase 6 Brochure.pdf",
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      file_name: "DHA Phase 6 Brochure.pdf",
      size_bytes: 64,
      uploaded_by_name: "Ali Agent",
    });
    expect(added.body).not.toHaveProperty("storage_path");
    expect(buckets).toContain("property-documents");
    expect([...files.keys()]).toEqual([
      expect.stringMatching(new RegExp(`^${id}/[0-9a-f-]{36}$`)),
    ]);
    // The reservation became the document.
    expect(await queue(id)).toEqual([]);
    const listed = await get(ali, `/properties/${id}/documents`);
    expect(listed.body).toEqual([added.body]);
    expect(JSON.stringify(listed.body)).not.toContain(id + "/");
    const file = await get(
      ali,
      `/properties/${id}/documents/${added.body.id}/file`,
    ).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers).toMatchObject({
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(file.headers["content-disposition"]).toBe(
      "attachment; filename=\"document.pdf\"; filename*=UTF-8''DHA%20Phase%206%20Brochure.pdf",
    );
    expect(Buffer.compare(file.body, pdf())).toBe(0);
    const path = [...files.keys()][0];
    expect(
      (
        await send(
          ali,
          "delete",
          `/properties/${id}/documents/${added.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect((await get(ali, `/properties/${id}/documents`)).body).toEqual([]);
    // Queued in the same transaction; the in-memory Storage cannot run the
    // queue (the test client has no .lte()), the jobs runner does.
    expect(await queue(id)).toEqual([{ storage_path: path, due: true }]);
    expect(
      (
        await all(
          "select actor_id,action,metadata from audit_log where action like '%_document' order by created_at,id",
        )
      ).map((r) => [r.actor_id, r.action, r.metadata.file_name]),
    ).toEqual([
      [ali, "upload_document", "DHA Phase 6 Brochure.pdf"],
      [ali, "delete_document", "DHA Phase 6 Brochure.pdf"],
    ]);
  });
  it("keeps another agent's documents private and agent documents read-only for administrators", async () => {
    const id = await property(ali);
    const doc = (await upload(ali, id)).body;
    // Another agent: as if the property did not exist.
    for (const res of [
      await get(sara, `/properties/${id}/documents`),
      await get(sara, `/properties/${id}/documents/${doc.id}/file`),
      await upload(sara, id),
      await send(sara, "delete", `/properties/${id}/documents/${doc.id}`),
    ])
      expect(res.status).toBe(404);
    // Administrators read every inventory but change only the company one.
    expect((await get(admin, `/properties/${id}/documents`)).body).toHaveLength(
      1,
    );
    expect(
      (await get(admin, `/properties/${id}/documents/${doc.id}/file`)).status,
    ).toBe(200);
    expect((await upload(admin, id)).status).toBe(403);
    expect(
      (await send(admin, "delete", `/properties/${id}/documents/${doc.id}`))
        .status,
    ).toBe(403);
    expect(files.size).toBe(1);
    // No account at all, or a document of another property.
    expect(
      (
        await request(app()).get(
          `/api/properties/${id}/documents/${doc.id}/file`,
        )
      ).status,
    ).toBe(401);
    const second = await property(ali, { title: "Office" });
    expect(
      (await get(ali, `/properties/${second}/documents/${doc.id}/file`)).status,
    ).toBe(404);
  });
  it("lets every agent open company documents without changing them", async () => {
    const id = await property(admin, { title: "Company tower" });
    const doc = (await upload(admin, id, pdf(), "Payment Plan.pdf")).body;
    for (const agent of [ali, sara]) {
      expect(
        (await get(agent, `/properties/${id}/documents`)).body.map(
          (d) => d.file_name,
        ),
      ).toEqual(["Payment Plan.pdf"]);
      expect(
        (await get(agent, `/properties/${id}/documents/${doc.id}/file`)).status,
      ).toBe(200);
      expect((await upload(agent, id)).status).toBe(403);
      expect(
        (await send(agent, "delete", `/properties/${id}/documents/${doc.id}`))
          .status,
      ).toBe(403);
    }
  });
  it("accepts only real PDFs within the size limit, and ten per property", async () => {
    const id = await property(ali);
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(32),
    ]);
    for (const [body, name, type] of [
      [png, "plan.pdf", "application/pdf"],
      [pdf(), "plan.docx", "application/pdf"],
      [pdf(), "plan.pdf", "image/png"],
      [Buffer.from("%PDF-1.7 truncated"), "plan.pdf", "application/pdf"],
    ]) {
      const res = await upload(ali, id, body, name, type);
      expect(res.status, name).toBe(400);
      expect(res.body.error).toBe("Choose a PDF file up to 20 MB.");
    }
    process.env.PROPERTY_DOCUMENT_MAX_MB = "1";
    const big = await upload(ali, id, pdf(1048577));
    expect(big.status).toBe(413);
    expect(big.body.error).toBe("Choose a PDF file up to 1 MB.");
    expect((await upload(ali, id, pdf(1048576))).status).toBe(201);
    // The bucket's own limit is the ceiling.
    process.env.PROPERTY_DOCUMENT_MAX_MB = "500";
    expect(
      (await import("../src/routes/inventory.routes.js")).documentLimit(),
    ).toBe(25 * 1048576);
    delete process.env.PROPERTY_DOCUMENT_MAX_MB;
    for (let i = 2; i <= 10; i++)
      expect((await upload(ali, id, pdf(), `Plan ${i}.pdf`)).status).toBe(201);
    const eleventh = await upload(ali, id, pdf(), "Plan 11.pdf");
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error).toBe("A property can have up to 10 documents");
    expect(files.size).toBe(10);
    expect(await queue(id)).toEqual([]);
  });
  it("leaves no file or record behind when an upload fails", async () => {
    const id = await property(ali);
    failUpload = true;
    const res = await upload(ali, id);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      "The document could not be uploaded. Please try again.",
    );
    expect((await get(ali, `/properties/${id}/documents`)).body).toEqual([]);
    // The reservation is released at once for the clean-up queue.
    expect(await queue(id)).toEqual([
      { storage_path: expect.stringMatching(`^${id}/`), due: true },
    ]);
    // A reservation that expired (an upload left unfinished for an hour) can
    // no longer become a document; its file is removed by the queue.
    const path = `${id}/00000000-0000-4000-8000-0000000000aa`;
    await pg.query("select inventory_document_reserve($1,$2,$3)", [
      ali,
      id,
      path,
    ]);
    await pg.query(
      "update property_document_cleanup set not_before=now()-interval '1 minute' where storage_path=$1",
      [path],
    );
    await expect(
      pg.query("select inventory_document_add($1,$2,$3,'Late.pdf',10,'t')", [
        ali,
        id,
        path,
      ]),
    ).rejects.toMatchObject({ code: "HA409" });
    // Paths always belong to their own property.
    const other = await property(ali, { title: "Other" });
    await expect(
      pg.query("select inventory_document_reserve($1,$2,$3)", [
        ali,
        other,
        path,
      ]),
    ).rejects.toMatchObject({ code: "HA400" });
  });
  it("queues every document file when its property is deleted", async () => {
    const id = await property(ali);
    await upload(ali, id, pdf(), "One.pdf");
    await upload(ali, id, pdf(), "Two.pdf");
    const paths = [...files.keys()].sort();
    expect((await send(ali, "delete", `/properties/${id}`)).status).toBe(204);
    expect(
      (await one("select count(*)::int n from property_documents")).n,
    ).toBe(0);
    expect((await queue(id)).map((r) => r.storage_path)).toEqual(paths);
  });
  it("copies the documents when an administrator adds an agent's listing to Admin Properties", async () => {
    const id = await property(ali);
    expect((await photo(ali, id)).status).toBe(201);
    await upload(ali, id, pdf(100), "Brochure.pdf");
    await upload(ali, id, pdf(200), "Floor Plan.pdf");
    const originals = await docsOf(id);
    const res = await promote(id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      ownership: "company",
      photos_missing: 0,
      documents_missing: 0,
    });
    const copy = res.body.id;
    // Separate files and records, in the same order, by the same uploader.
    const copies = await docsOf(copy);
    expect(
      copies.map((d) => [d.file_name, d.size_bytes, d.uploaded_by]),
    ).toEqual(originals.map((d) => [d.file_name, d.size_bytes, d.uploaded_by]));
    for (const [i, d] of copies.entries()) {
      expect(d.storage_path).toMatch(new RegExp(`^${copy}/[0-9a-f-]{36}$`));
      expect(d.id).not.toBe(originals[i].id);
      expect(
        Buffer.compare(
          files.get(d.storage_path),
          files.get(originals[i].storage_path),
        ),
      ).toBe(0);
    }
    expect(
      (
        await one(
          "select count(*)::int n from property_photos where property_id=$1",
          [copy],
        )
      ).n,
    ).toBe(1);
    // The original listing and its documents are unchanged.
    expect(await docsOf(id)).toEqual(originals);
    // Company inventory: every agent opens the copies; only administrators
    // change them, and removing a copy leaves the original.
    const [first] = copies;
    for (const agent of [ali, sara]) {
      expect(
        (await get(agent, `/properties/${copy}/documents/${first.id}/file`))
          .status,
      ).toBe(200);
      expect(
        (
          await send(
            agent,
            "delete",
            `/properties/${copy}/documents/${first.id}`,
          )
        ).status,
      ).toBe(403);
    }
    expect((await get(sara, `/properties/${id}/documents`)).status).toBe(404);
    expect(
      (await send(admin, "delete", `/properties/${copy}/documents/${first.id}`))
        .status,
    ).toBe(204);
    expect(await docsOf(id)).toEqual(originals);
    expect(files.has(originals[0].storage_path)).toBe(true);
    // No reservation is left waiting, and the audit counts the documents.
    expect(
      (
        await one(
          "select count(*)::int n from property_document_cleanup where property_id=$1 and not_before>now()",
          [copy],
        )
      ).n,
    ).toBe(0);
    const audit = await one(
      "select actor_id,metadata from audit_log where action='promote'",
    );
    expect(audit.metadata).toMatchObject({
      photo_count: 1,
      document_count: 2,
      documents_missing: 0,
    });
    expect(
      presentAuditEntry({
        action: "promote",
        entity: "properties",
        metadata: audit.metadata,
        agent: { name: "Ali Agent" },
      }).description,
    ).toContain(
      "originally listed by Ali Agent, with 1 photo and 2 documents.",
    );
  });
  it("skips a document whose file is missing and leaves nothing behind when copying fails", async () => {
    const id = await property(ali);
    await upload(ali, id, pdf(), "Brochure.pdf");
    await upload(ali, id, pdf(), "Gone.pdf");
    const [, gone] = await docsOf(id);
    files.delete(gone.storage_path);
    const res = await promote(id);
    expect(res.status).toBe(201);
    expect(res.body.documents_missing).toBe(1);
    expect((await docsOf(res.body.id)).map((d) => d.file_name)).toEqual([
      "Brochure.pdf",
    ]);
    // The missing one's reservation is released, never a record.
    expect(await queue(res.body.id)).toEqual([
      { storage_path: expect.stringMatching(`^${res.body.id}/`), due: true },
    ]);
    // Storage fails on the second document: no copy, no record, and the
    // pictures and documents already copied are removed.
    const next = await property(ali, { title: "Second listing" });
    expect((await photo(ali, next)).status).toBe(201);
    await upload(ali, next, pdf(), "One.pdf");
    await upload(ali, next, pdf(), "Two.pdf");
    const [, second] = await docsOf(next);
    failCopy = (bucket, from) =>
      bucket === "property-documents" && from === second.storage_path;
    const before = new Set(files.keys());
    const failed = await promote(next);
    expect(failed.status).toBe(503);
    expect(failed.body.error).toBe(
      "The documents could not be copied. Please try again.",
    );
    expect(new Set(files.keys())).toEqual(before);
    const orphans = await all(
      "select property_id,not_before<=now() due from property_document_cleanup c where not exists(select 1 from properties p where p.id=c.property_id) union all select property_id,not_before<=now() from property_photo_cleanup c where not exists(select 1 from properties p where p.id=c.property_id)",
    );
    // Released for the queue (whose files are already gone), nothing pending.
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans.every((r) => r.due)).toBe(true);
    expect(
      (
        await one(
          "select count(*)::int n from property_documents d where not exists(select 1 from properties p where p.id=d.property_id)",
        )
      ).n,
    ).toBe(0);
    expect((await docsOf(next)).map((d) => d.file_name)).toEqual([
      "One.pdf",
      "Two.pdf",
    ]);
    expect(
      (
        await one(
          "select count(*)::int n from property_promotions where source_id=$1",
          [next],
        )
      ).n,
    ).toBe(0);
    // A retry, with Storage working again, copies everything.
    failCopy = () => false;
    const retry = await promote(next);
    expect(retry.status).toBe(201);
    expect((await docsOf(retry.body.id)).map((d) => d.file_name)).toEqual([
      "One.pdf",
      "Two.pdf",
    ]);
  });
  it("only accepts copies that were reserved, and still promotes for code that copies pictures only", async () => {
    const id = await property(ali);
    await upload(ali, id, pdf(), "Brochure.pdf");
    const copy = "54200000-0000-4000-8000-0000000000c1";
    const plan = (
      await one("select inventory_promote_prepare($1,$2,$3) r", [
        admin,
        id,
        copy,
      ])
    ).r;
    expect(plan.documents).toEqual([
      {
        from: expect.stringMatching(`^${id}/`),
        to: expect.stringMatching(`^${copy}/`),
      },
    ]);
    // Agents cannot prepare a promotion.
    await expect(
      pg.query("select inventory_promote_prepare($1,$2,$3)", [
        ali,
        id,
        "54200000-0000-4000-8000-0000000000c2",
      ]),
    ).rejects.toMatchObject({ code: "HA403" });
    // A path that was never reserved is refused.
    await expect(
      pg.query("select inventory_promote($1,$2,$3,$4,'t')", [
        admin,
        id,
        copy,
        [`${copy}/00000000-0000-4000-8000-0000000000ee`],
      ]),
    ).rejects.toMatchObject({ code: "HA409" });
    // The release deployed before 054 copies pictures only: the listing is
    // still added, without documents, and the reservation is released.
    const made = (
      await one("select inventory_promote($1,$2,$3,'{}','t') r", [
        admin,
        id,
        copy,
      ])
    ).r;
    expect(made.id).toBe(copy);
    expect(await docsOf(copy)).toEqual([]);
    expect(await queue(copy)).toEqual([
      { storage_path: plan.documents[0].to, due: true },
    ]);
  });
  it("gives browsers no access to the documents, their files or functions", async () => {
    expect(
      await one(
        "select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='property-documents'",
      ),
    ).toEqual({
      id: "property-documents",
      public: false,
      file_size_limit: 26214400,
      allowed_mime_types: ["application/pdf"],
    });
    const tables = await all(
      "select c.relname,c.relrowsecurity rls,has_table_privilege('anon',c.oid,'select,insert,update,delete') anon,has_table_privilege('authenticated',c.oid,'select,insert,update,delete') authenticated from pg_class c where c.relname in ('property_documents','property_document_cleanup') order by 1",
    );
    expect(tables).toEqual([
      {
        relname: "property_document_cleanup",
        rls: true,
        anon: false,
        authenticated: false,
      },
      {
        relname: "property_documents",
        rls: true,
        anon: false,
        authenticated: false,
      },
    ]);
    const functions = await all(
      "select p.proname,has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') server from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('inventory_documents','inventory_document_file','inventory_document_reserve','inventory_document_add','inventory_document_release','inventory_document_remove','queue_property_document_file','property_document_json') order by 1",
    );
    expect(functions.every((f) => !f.browser)).toBe(true);
    expect(functions.filter((f) => f.server).map((f) => f.proname)).toEqual([
      "inventory_document_add",
      "inventory_document_file",
      "inventory_document_release",
      "inventory_document_remove",
      "inventory_document_reserve",
      "inventory_documents",
    ]);
  });
});
