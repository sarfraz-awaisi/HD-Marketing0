import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CFB } from "xlsx";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { validateDocumentFile } from "../src/services/documentFiles.js";
import { cleanupKnowledgeFiles } from "../src/jobs/cleanupKnowledgeFiles.js";
let pg, clientLead;
const admin = "61000000-0000-4000-8000-000000000001",
  agent = "61000000-0000-4000-8000-000000000002",
  second = "61000000-0000-4000-8000-000000000003";
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const entryData = {
  title: "Team guidance",
  category: "policy",
  content: "First line\nSecond line",
};
const save = async (
  data = entryData,
  id = null,
  actor = admin,
  req = randomUUID(),
) =>
  (
    await one("select save_knowledge_document($1,$2::jsonb,$3,$4) value", [
      id,
      JSON.stringify(data),
      actor,
      req,
    ])
  ).value;
const remove = async (id, actor = admin, req = randomUUID()) =>
  one("select delete_knowledge_document($1,$2,$3)", [id, actor, req]);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");
function word(format = "docx", extras = []) {
  const c = CFB.utils.cfb_new();
  if (format === "doc")
    CFB.utils.cfb_add(
      c,
      "WordDocument",
      Buffer.from([0xec, 0xa5, 0xc1, 0, 0, 0, 0, 0]),
    );
  else {
    CFB.utils.cfb_add(
      c,
      "[Content_Types].xml",
      Buffer.from(
        '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    );
    CFB.utils.cfb_add(
      c,
      "word/document.xml",
      Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
      ),
    );
    for (const [name, content] of extras)
      CFB.utils.cfb_add(c, name, Buffer.from(content));
  }
  return CFB.write(c, {
    type: "buffer",
    ...(format === "docx" ? { fileType: "zip" } : {}),
  });
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(f, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query("insert into auth.users(id) values($1),($2),($3)", [
    admin,
    agent,
    second,
  ]);
  await pg.query("update profiles set active=true where id=any($1::uuid[])", [
    [admin, agent, second],
  ]);
  await pg.query("update profiles set role='admin' where id=any($1::uuid[])", [
    [admin, second],
  ]);
  clientLead = (
    await one(
      "select to_jsonb(create_lead($1::jsonb,$2,$3,'fixture:kyc-client')) value",
      [
        JSON.stringify({
          name: "Document client fixture",
          assigned_agent: agent,
        }),
        "+923007654321",
        admin,
      ],
    )
  ).value.id;
}, 30000);
afterAll(async () => {
  await pg?.close();
});
function database() {
  const objects = new Map();
  let storageFailure = false,
    auditFailure = false;
  const db = {
    objects,
    setStorageFailure: (v) => {
      storageFailure = v;
    },
    setAuditFailure: (v) => {
      auditFailure = v;
    },
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, agent, second].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01T00:00:00Z" }
            : null,
        },
      }),
    },
    rpc: vi.fn(async (name, a) => {
      const calls = {
        knowledge_documents_page: [
          "select knowledge_documents_page($1,$2,$3,$4,$5,$6,$7) value",
          [
            a.p_actor,
            a.p_page,
            a.p_limit,
            a.p_search,
            a.p_category,
            a.p_lead,
            a.p_unlinked,
          ],
        ],
        read_knowledge_document: [
          "select read_knowledge_document($1,$2) value",
          [a.p_id, a.p_actor],
        ],
        read_knowledge_file: [
          "select read_knowledge_file($1,$2,$3) value",
          [a.p_document, a.p_file, a.p_actor],
        ],
        authorize_knowledge_download: [
          "select authorize_knowledge_download($1,$2,$3,$4) value",
          [a.p_document, a.p_file, a.p_actor, a.p_request],
        ],
        search_kyc_clients: [
          "select search_kyc_clients($1,$2,$3,$4) value",
          [a.p_actor, a.p_search, a.p_limit, a.p_selected],
        ],
        list_knowledge_documents: [
          "select list_knowledge_documents($1,$2,$3,$4,$5) value",
          [a.p_actor, a.p_page, a.p_limit, a.p_search, a.p_category],
        ],
        save_knowledge_document: [
          "select save_knowledge_document($1,$2::jsonb,$3,$4) value",
          [a.p_id, JSON.stringify(a.p_data), a.p_actor, a.p_request],
        ],
        delete_knowledge_document: [
          "select delete_knowledge_document($1,$2,$3) value",
          [a.p_id, a.p_actor, a.p_request],
        ],
        attach_knowledge_file: [
          "select attach_knowledge_file($1,$2::jsonb,$3,$4) value",
          [a.p_document, JSON.stringify(a.p_data), a.p_actor, a.p_request],
        ],
        delete_knowledge_file: [
          "select delete_knowledge_file($1,$2,$3,$4) value",
          [a.p_document, a.p_file, a.p_actor, a.p_request],
        ],
      };
      try {
        if (name === "authorize_knowledge_download" && auditFailure) {
          await one("select read_knowledge_file($1,$2,$3) value", [
            a.p_document,
            a.p_file,
            a.p_actor,
          ]);
          return { error: { code: "503" } };
        }
        return { data: (await one(...calls[name])).value };
      } catch (e) {
        return { error: { code: e.code } };
      }
    }),
    from(table) {
      let filters = [],
        select = "*",
        count = false,
        mutation = null,
        valuesData = null,
        limit = Infinity,
        orders = [];
      const where = (offset = 0) => {
        const values = [],
          clauses = [];
        for (const [k, op, v] of filters) {
          values.push(v);
          clauses.push(
            op === "in"
              ? `${k}=any($${offset + values.length}::uuid[])`
              : `${k} ${op} $${offset + values.length}`,
          );
        }
        return {
          values,
          clause: clauses.length ? " where " + clauses.join(" and ") : "",
        };
      };
      async function run() {
        try {
          if (table === "audit_log" && auditFailure && mutation === "insert")
            return { error: { code: "503" } };
          let sql, args;
          if (mutation === "insert") {
            const keys = Object.keys(valuesData);
            args = keys.map((k) =>
              typeof valuesData[k] === "object"
                ? JSON.stringify(valuesData[k])
                : valuesData[k],
            );
            sql = `insert into ${table}(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")}) returning *`;
          } else if (mutation === "update") {
            const keys = Object.keys(valuesData);
            const w = where(keys.length);
            args = [...keys.map((k) => valuesData[k]), ...w.values];
            sql = `update ${table} set ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")}${w.clause} returning *`;
          } else {
            const w = where();
            args = w.values;
            sql =
              mutation === "delete"
                ? `delete from ${table}${w.clause} returning *`
                : `select ${select} from ${table}${w.clause}${orders.length ? " order by " + orders.join(",") : ""}`;
          }
          const rows = (await pg.query(sql, args)).rows;
          return {
            data: rows.slice(0, limit),
            count: count ? rows.length : undefined,
          };
        } catch (e) {
          return { error: { code: e.code } };
        }
      }
      const q = {
        select: (fields, options) => {
          select = fields || "*";
          count = !!options?.count;
          return q;
        },
        eq: (k, v) => {
          filters.push([k, "=", v]);
          return q;
        },
        in: (k, v) => {
          filters.push([k, "in", v]);
          return q;
        },
        lte: (k, v) => {
          filters.push([k, "<=", v]);
          return q;
        },
        ilike: (k, v) => {
          filters.push([k, "ilike", v]);
          return q;
        },
        order: (k, options) => {
          orders.push(k + (options?.ascending === false ? " desc" : " asc"));
          return q;
        },
        limit: (n) => {
          limit = n;
          return q;
        },
        insert: (data) => {
          mutation = "insert";
          valuesData = data;
          return q;
        },
        update: (data) => {
          mutation = "update";
          valuesData = data;
          return q;
        },
        delete: () => {
          mutation = "delete";
          return q;
        },
        single: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] };
        },
        maybeSingle: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] || null };
        },
        range: async (lo, hi) => {
          const r = await run();
          return { ...r, data: r.data?.slice(lo, hi + 1) };
        },
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return q;
    },
    storage: {
      from: () => ({
        upload: async (path, buffer, options) => {
          if (storageFailure) return { error: { code: "503" } };
          objects.set(path, { buffer, type: options.contentType });
          return { data: { path } };
        },
        remove: async (paths) => {
          if (storageFailure) return { error: { code: "503" } };
          for (const path of paths) objects.delete(path);
          return { data: [] };
        },
        download: async (path) =>
          objects.has(path)
            ? { data: new Blob([objects.get(path).buffer]) }
            : { error: { code: "404" } },
      }),
    },
  };
  return db;
}
const upload = (app, id, buffer = pdf, name = "policy.pdf", actor = admin) =>
  request(app)
    .post(`/api/documents/${id}/files`)
    .set("Authorization", "Bearer " + actor)
    .attach("file", buffer, name);

describe("documentation and policy database/API", () => {
  it("creates and updates entries with trusted ownership, timestamps and safe audit metadata", async () => {
    const requestId = randomUUID(),
      entry = await save(
        { ...entryData, title: "  Shared policy  " },
        null,
        admin,
        requestId,
      );
    expect(entry.title).toBe("Shared policy");
    expect(entry.created_by).toBe(admin);
    const updated = await save(
      {
        ...entryData,
        category: "documentation",
        content: "Changed instructions",
      },
      entry.id,
      second,
    );
    expect(updated.created_by).toBe(admin);
    expect(updated.updated_by).toBe(second);
    expect(new Date(updated.updated_at) >= new Date(entry.updated_at)).toBe(
      true,
    );
    const audit = await one(
      "select metadata from audit_log where request_id=$1",
      [requestId],
    );
    expect(audit.metadata).toEqual({
      fields: ["title", "category", "content"],
    });
    expect(JSON.stringify(audit)).not.toContain("Shared policy");
  });
  it("supports team read access, title search, type filtering and pagination without list bodies", async () => {
    const unique = "Reference " + randomUUID();
    const first = await save({
      ...entryData,
      title: unique,
      category: "documentation",
    });
    await save({ ...entryData, title: unique + " policy" });
    const app = createApp(trustedMfaFixture(database()));
    for (const actor of [admin, agent]) {
      const r = await request(app)
        .get("/api/documents")
        .query({ search: unique, limit: 1 })
        .set("Authorization", "Bearer " + actor);
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(2);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0]).not.toHaveProperty("content");
    }
    const filtered = await request(app)
      .get("/api/documents")
      .query({ search: unique, category: "documentation" })
      .set("Authorization", "Bearer " + agent);
    expect(filtered.body.data.map((r) => r.id)).toEqual([first.id]);
    const detail = await request(app)
      .get("/api/documents/" + first.id)
      .set("Authorization", "Bearer " + agent);
    expect(detail.body.content).toBe(entryData.content);
    expect(detail.body.files).toEqual([]);
  });
  it("treats search percent and underscore characters literally", async () => {
    const unique = randomUUID();
    await save({ ...entryData, title: unique + " 100%_approved" });
    await save({ ...entryData, title: unique + " 100XXapproved" });
    const r = await request(createApp(trustedMfaFixture(database())))
      .get("/api/documents")
      .query({ search: unique + " 100%_" })
      .set("Authorization", "Bearer " + agent);
    expect(r.body.count).toBe(1);
  });
  it.each([
    "property_deeds",
    "legal_noc",
    "policy",
    "client_kyc",
    "tenancy_agreements",
    "documentation",
  ])(
    "saves and filters the %s category for both active roles",
    async (category) => {
      const marker = randomUUID(),
        db = database(),
        app = createApp(trustedMfaFixture(db));
      const created = await request(app)
        .post("/api/documents")
        .set("Authorization", "Bearer " + admin)
        .send({
          ...entryData,
          category,
          ...(category === "client_kyc" ? { lead_id: clientLead } : {}),
          title: marker,
          property_name: "  River Gardens  ",
          keywords: "  ownership, rental  ",
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        category,
        property_name: "River Gardens",
        keywords: "ownership, rental",
      });
      for (const actor of [admin, agent]) {
        const r = await request(app)
          .get("/api/documents")
          .query({ category, search: marker })
          .set("Authorization", "Bearer " + actor);
        expect(r.status).toBe(200);
        expect(r.body.count).toBe(1);
        expect(r.body.data[0]).toMatchObject({
          id: created.body.id,
          category,
          property_name: "River Gardens",
        });
        expect(r.body.data[0]).not.toHaveProperty("content");
      }
      const id = created.body.id;
      const updated = await save(
        { ...entryData, title: marker + " updated", category },
        id,
      );
      expect(updated.property_name).toBe("River Gardens");
      expect(updated.keywords).toBe("ownership, rental");
    },
  );
  it("searches property names, explicit keywords and written content while respecting categories", async () => {
    const marker = randomUUID(),
      app = createApp(trustedMfaFixture(database()));
    const property = await save({
      ...entryData,
      category: "property_deeds",
      property_name: marker + " Property",
      keywords: "ownership",
    });
    const keywords = await save({
      ...entryData,
      category: "client_kyc",
      lead_id: clientLead,
      keywords: marker + " Identity",
    });
    const content = await save({
      ...entryData,
      category: "legal_noc",
      content: marker + " approval",
    });
    for (const [text, id] of [
      [marker + " Property", property.id],
      [marker + " Identity", keywords.id],
      [marker + " approval", content.id],
    ]) {
      const r = await request(app)
        .get("/api/documents")
        .query({ search: text.toUpperCase() })
        .set("Authorization", "Bearer " + agent);
      expect(r.status).toBe(200);
      expect(r.body.data.map((item) => item.id)).toEqual([id]);
    }
    const r = await request(app)
      .get("/api/documents")
      .query({ search: marker, category: "tenancy_agreements" })
      .set("Authorization", "Bearer " + agent);
    expect(r.body.count).toBe(0);
    const clear = await save(
      { ...entryData, property_name: "", keywords: "" },
      property.id,
    );
    expect(clear.property_name).toBe("");
    expect(clear.keywords).toBe("");
  });
  it("preserves entries when upgrading categories and rolls back new metadata on audit failure", async () => {
    const entry = await save({
      ...entryData,
      property_name: "Original property",
      keywords: "original",
    });
    await pg.exec(
      "create function reject_category_audit() returns trigger language plpgsql as $$ begin raise exception 'Test failure';end $$;create trigger test_category_audit before insert on audit_log for each row execute function reject_category_audit();",
    );
    try {
      await expect(
        save(
          {
            ...entryData,
            category: "legal_noc",
            property_name: "Changed",
            keywords: "changed",
          },
          entry.id,
        ),
      ).rejects.toThrow();
      expect(
        await one(
          "select category,property_name,keywords from knowledge_documents where id=$1",
          [entry.id],
        ),
      ).toEqual({
        category: "policy",
        property_name: "Original property",
        keywords: "original",
      });
    } finally {
      await pg.exec(
        "drop trigger test_category_audit on audit_log;drop function reject_category_audit();",
      );
    }
    const legacy = await save();
    expect(legacy).toMatchObject({
      category: "policy",
      property_name: "",
      keywords: "",
    });
  });
  it("rechecks active reader status and forbids browser execution of category search", async () => {
    await pg.query("update profiles set active=false where id=$1", [agent]);
    try {
      await expect(
        pg.query("select list_knowledge_documents($1,1,20,'','')", [agent]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.query("update profiles set active=true where id=$1", [agent]);
    }
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await one(
            "select has_function_privilege($1,'public.list_knowledge_documents(uuid,integer,integer,text,text)','execute') allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
    }
  });
  it("enforces admin-only API writes before any mutation RPC", async () => {
    const db = database(),
      app = createApp(trustedMfaFixture(db)),
      entry = await save();
    for (const method of ["post", "patch", "delete"]) {
      const r = await request(app)
        [method]("/api/documents" + (method === "post" ? "" : "/" + entry.id))
        .set("Authorization", "Bearer " + agent)
        .send(entryData);
      expect(r.status).toBe(403);
    }
    expect(db.rpc).not.toHaveBeenCalled();
    expect((await upload(app, entry.id, pdf, "policy.pdf", agent)).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .delete(`/api/documents/${entry.id}/files/${randomUUID()}`)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(403);
  });
  it("rejects absent/invalid sessions and disabled accounts for reading and downloads", async () => {
    const entry = await save(),
      app = createApp(trustedMfaFixture(database()));
    for (const token of ["", "invalid"])
      expect(
        (
          await request(app)
            .get("/api/documents")
            .set("Authorization", "Bearer " + token)
        ).status,
      ).toBe(401);
    await pg.query("update profiles set active=false where id=$1", [agent]);
    try {
      expect(
        (
          await request(app)
            .get("/api/documents/" + entry.id)
            .set("Authorization", "Bearer " + agent)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .get(`/api/documents/${entry.id}/files/${randomUUID()}/download`)
            .set("Authorization", "Bearer " + agent)
        ).status,
      ).toBe(403);
    } finally {
      await pg.query("update profiles set active=true where id=$1", [agent]);
    }
  });
  it("rechecks the SQL actor role and disabled status for create/update/delete", async () => {
    const entry = await save();
    for (const id of [null, entry.id])
      await expect(save(entryData, id, agent)).rejects.toMatchObject({
        code: "42501",
      });
    await expect(remove(entry.id, agent)).rejects.toMatchObject({
      code: "42501",
    });
    await pg.query("update profiles set active=false where id=$1", [second]);
    try {
      await expect(save(entryData, entry.id, second)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(remove(entry.id, second)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await pg.query("update profiles set active=true where id=$1", [second]);
    }
  });
  it.each([
    { title: " " },
    { title: "x".repeat(201) },
    { category: "admin" },
    { content: " " },
    { content: "x".repeat(50001) },
    { created_by: agent },
    { storage_path: "fake" },
    { property_name: "x".repeat(201) },
    { property_name: null },
    { keywords: "x".repeat(501) },
    { keywords: ["private"] },
  ])("validates entry fields and rejects privileged fields %j", async (bad) => {
    const r = await request(createApp(trustedMfaFixture(database())))
      .post("/api/documents")
      .set("Authorization", "Bearer " + admin)
      .send({ ...entryData, ...bad });
    expect(r.status).toBe(400);
    await expect(save({ ...entryData, ...bad })).rejects.toThrow();
  });
  it("returns safe errors for missing entries, invalid IDs, filters and database migrations", async () => {
    const db = database(),
      app = createApp(trustedMfaFixture(db));
    expect(
      (
        await request(app)
          .get("/api/documents/" + randomUUID())
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(404);
    for (const path of [
      "/api/documents/invalid",
      "/api/documents?category=secret",
      "/api/documents?page=0",
      "/api/documents?role=admin",
    ])
      expect(
        (
          await request(app)
            .get(path)
            .set("Authorization", "Bearer " + admin)
        ).status,
      ).toBe(400);
    db.rpc.mockResolvedValueOnce({
      error: { code: "PGRST202", message: "private details" },
    });
    const r = await request(app)
      .post("/api/documents")
      .set("Authorization", "Bearer " + admin)
      .send(entryData);
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("022");
    expect(r.body.error).not.toContain("private details");
  });
  it.each(["pdf", "doc", "docx"])(
    "uploads a validated %s attachment with private metadata and no browser path",
    async (format) => {
      const entry = await save(),
        db = database(),
        buffer = format === "pdf" ? pdf : word(format),
        app = createApp(trustedMfaFixture(db));
      const r = await upload(app, entry.id, buffer, "handbook." + format);
      expect(r.status).toBe(201);
      expect(r.body.file_name).toBe("handbook." + format);
      expect(r.body).not.toHaveProperty("storage_path");
      expect(db.objects.size).toBe(1);
      expect(
        (
          await one(
            "select count(*)::integer n from knowledge_file_cleanup where document_id=$1",
            [entry.id],
          )
        ).n,
      ).toBe(0);
      const detail = await request(app)
        .get("/api/documents/" + entry.id)
        .set("Authorization", "Bearer " + agent);
      expect(detail.body.files[0].file_name).toBe("handbook." + format);
      expect(JSON.stringify(detail.body)).not.toContain("storage_path");
    },
  );
  it("downloads through the authenticated API, audits before storage and forces attachment disposition", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db)),
      r = await upload(app, entry.id);
    const path = `/api/documents/${entry.id}/files/${r.body.id}/download`;
    const response = await request(app)
      .get(path)
      .set("Authorization", "Bearer " + agent);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(pdf);
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["cache-control"]).toBe("no-store");
    db.setAuditFailure(true);
    expect(
      (
        await request(app)
          .get(path)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(503);
    expect(
      (
        await request(app)
          .get(`/api/documents/${randomUUID()}/files/${r.body.id}/download`)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(404);
  });
  it("rejects renamed, unsupported, oversized, encrypted or macro DOCX files before storage", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db));
    for (const [buffer, name] of [
      [Buffer.from("<html>file</html>"), "fake.pdf"],
      [pdf, "fake.docx"],
      [word("doc"), "renamed.pdf"],
      [pdf, "script.html"],
      [Buffer.alloc(10 * 1024 * 1024 + 1), "huge.pdf"],
      [word("docx", [["word/vbaProject.bin", "macro"]]), "macro.docx"],
    ])
      expect(
        (await upload(app, entry.id, buffer, name)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(db.objects.size).toBe(0);
  });
  it("bounds ZIP expansion before parsing Word contents and validates actual Word streams", () => {
    const zip = word("docx"),
      bad = Buffer.from(zip);
    const directory = bad.readUInt32LE(bad.length - 6);
    bad.writeUInt32LE(0xffffffff, directory + 24);
    expect(() =>
      validateDocumentFile({
        originalname: "bomb.docx",
        mimetype: "application/octet-stream",
        buffer: bad,
      }),
    ).toThrow();
    const c = CFB.utils.cfb_new();
    CFB.utils.cfb_add(c, "Workbook", Buffer.from("spreadsheet"));
    expect(() =>
      validateDocumentFile({
        originalname: "renamed.doc",
        mimetype: "application/msword",
        buffer: CFB.write(c, { type: "buffer" }),
      }),
    ).toThrow();
  });
  it("keeps failed uploads recoverable through a durable reservation and cleanup retry", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db));
    db.setStorageFailure(true);
    expect((await upload(app, entry.id)).status).toBe(400);
    expect(
      (
        await one(
          "select count(*)::integer n from knowledge_file_cleanup where document_id=$1",
          [entry.id],
        )
      ).n,
    ).toBe(1);
    db.setStorageFailure(false);
    expect(await cleanupKnowledgeFiles(db, entry.id)).toEqual({ processed: 1 });
  });
  it("rolls back attachment metadata/audit and cleans the object if attach audit fails", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db));
    await pg.exec(
      "create function fail_knowledge_upload() returns trigger language plpgsql as $$ begin if new.action='upload_file' then raise exception 'Test failure';end if;return new;end $$;create trigger test_knowledge_upload before insert on audit_log for each row execute function fail_knowledge_upload();",
    );
    try {
      expect((await upload(app, entry.id)).status).toBe(400);
    } finally {
      await pg.exec(
        "drop trigger test_knowledge_upload on audit_log;drop function fail_knowledge_upload();",
      );
    }
    expect(db.objects.size).toBe(0);
    expect(
      (
        await one(
          "select count(*)::integer n from knowledge_files where document_id=$1",
          [entry.id],
        )
      ).n,
    ).toBe(0);
  });
  it("deletes an attachment or entire entry atomically and retries Storage cleanup failures", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db)),
      first = await upload(app, entry.id),
      secondFile = await upload(app, entry.id, word("doc"), "guide.doc");
    expect(
      (
        await request(app)
          .delete(`/api/documents/${entry.id}/files/${first.body.id}`)
          .set("Authorization", "Bearer " + admin)
      ).status,
    ).toBe(204);
    expect(db.objects.size).toBe(1);
    db.setStorageFailure(true);
    expect(
      (
        await request(app)
          .delete("/api/documents/" + entry.id)
          .set("Authorization", "Bearer " + admin)
      ).status,
    ).toBe(204);
    expect(
      await one("select id from knowledge_documents where id=$1", [entry.id]),
    ).toBeUndefined();
    expect(
      (
        await one(
          "select count(*)::integer n from knowledge_files where document_id=$1",
          [entry.id],
        )
      ).n,
    ).toBe(0);
    expect(db.objects.size).toBe(1);
    db.setStorageFailure(false);
    expect(await cleanupKnowledgeFiles(db, entry.id)).toEqual({ processed: 1 });
    expect(db.objects.size).toBe(0);
  });
  it("rolls back create/update/delete when their audit fails", async () => {
    const entry = await save(),
      requestId = randomUUID();
    await pg.exec(
      "create function fail_knowledge_change() returns trigger language plpgsql as $$ begin if new.entity='knowledge_documents' then raise exception 'Test failure';end if;return new;end $$;create trigger test_knowledge_change before insert on audit_log for each row execute function fail_knowledge_change();",
    );
    try {
      await expect(save(entryData, null, admin, requestId)).rejects.toThrow();
      await expect(
        save({ ...entryData, content: "Overwrite" }, entry.id),
      ).rejects.toThrow();
      await expect(remove(entry.id)).rejects.toThrow();
    } finally {
      await pg.exec(
        "drop trigger test_knowledge_change on audit_log;drop function fail_knowledge_change();",
      );
    }
    expect(
      (
        await one("select content from knowledge_documents where id=$1", [
          entry.id,
        ])
      ).content,
    ).toBe(entry.content);
    expect(
      (
        await one(
          "select count(*)::integer n from audit_log where request_id=$1",
          [requestId],
        )
      ).n,
    ).toBe(0);
  });
  it("rechecks attachment actors and requires an upload reservation", async () => {
    const entry = await save(),
      path = `${entry.id}/${randomUUID()}`;
    const metadata = {
      file_name: "policy.pdf",
      mime_type: "application/pdf",
      size_bytes: pdf.length,
      storage_path: path,
    };
    await expect(
      one("select attach_knowledge_file($1,$2::jsonb,$3,null)", [
        entry.id,
        JSON.stringify(metadata),
        agent,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      one("select attach_knowledge_file($1,$2::jsonb,$3,null)", [
        entry.id,
        JSON.stringify(metadata),
        admin,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      one("select delete_knowledge_file($1,$2,$3,null)", [
        entry.id,
        randomUUID(),
        agent,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("preserves attachment metadata and cleanup state when deletion auditing fails", async () => {
    const entry = await save(),
      db = database(),
      app = createApp(trustedMfaFixture(db)),
      file = await upload(app, entry.id);
    await pg.exec(
      "create function fail_knowledge_delete() returns trigger language plpgsql as $$ begin if new.action in ('delete','delete_file') and new.entity='knowledge_documents' then raise exception 'Test failure';end if;return new;end $$;create trigger test_knowledge_delete before insert on audit_log for each row execute function fail_knowledge_delete();",
    );
    try {
      await expect(remove(entry.id)).rejects.toThrow();
      await expect(
        one("select delete_knowledge_file($1,$2,$3,null)", [
          entry.id,
          file.body.id,
          admin,
        ]),
      ).rejects.toThrow();
    } finally {
      await pg.exec(
        "drop trigger test_knowledge_delete on audit_log;drop function fail_knowledge_delete();",
      );
    }
    expect(
      await one("select id from knowledge_files where id=$1", [file.body.id]),
    ).toBeTruthy();
    expect(
      (
        await one(
          "select count(*)::integer n from knowledge_file_cleanup where document_id=$1",
          [entry.id],
        )
      ).n,
    ).toBe(0);
    expect(db.objects.size).toBe(1);
  });
  it("denies browser tables, cleanup reservations and mutation RPCs; keeps Storage private", async () => {
    expect(
      (
        await one(
          "select public from storage.buckets where id='knowledge-files'",
        )
      ).public,
    ).toBe(false);
    await pg.exec("set role authenticated");
    try {
      for (const table of [
        "knowledge_documents",
        "knowledge_files",
        "knowledge_file_cleanup",
      ])
        await expect(pg.query("select * from " + table)).rejects.toMatchObject({
          code: "42501",
        });
      await expect(save()).rejects.toMatchObject({ code: "42501" });
      await expect(remove(randomUUID())).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        pg.query("select attach_knowledge_file($1,'{}',$2,null)", [
          randomUUID(),
          admin,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
  });
});
