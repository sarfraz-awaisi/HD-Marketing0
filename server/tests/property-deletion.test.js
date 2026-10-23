import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { cleanupPropertyPhotos } from "../src/jobs/cleanupPropertyPhotos.js";

const admin = "40000000-0000-4000-8000-000000000001";
const agent = "40000000-0000-4000-8000-000000000002";
let db, property;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const remove = (actor = admin, id = property, requestId = randomUUID()) =>
  db.query("select delete_property($1,$2,$3)", [id, actor, requestId]);
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await db.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await db.query("insert into auth.users(id) values($1),($2)", [admin, agent]);
  await db.query("update profiles set active=true,role='admin' where id=$1", [
    admin,
  ]);
  await db.query("update profiles set active=true where id=$1", [agent]);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.query("update profiles set active=true where id=$1", [admin]);
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Disposable test property','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
});

describe("property deletion transaction", () => {
  it("deletes a property and photo metadata, queues files and records one safe audit", async () => {
    const path = property + "/photo-1",
      requestId = randomUUID();
    await db.query(
      "insert into property_photos(property_id,storage_path) values($1,$2)",
      [property, path],
    );
    await remove(admin, property, requestId);
    expect(
      await one("select id from properties where id=$1", [property]),
    ).toBeUndefined();
    expect(
      await one("select id from property_photos where property_id=$1", [
        property,
      ]),
    ).toBeUndefined();
    expect(
      (
        await one(
          "select storage_path from property_photo_cleanup where property_id=$1",
          [property],
        )
      ).storage_path,
    ).toBe(path);
    const audits = (
      await db.query(
        "select actor_id,action,metadata from audit_log where request_id=$1",
        [requestId],
      )
    ).rows;
    expect(audits).toEqual([
      { actor_id: admin, action: "delete", metadata: { photo_count: 1 } },
    ]);
    await expect(remove()).rejects.toMatchObject({ code: "P0002" });
  });
  it("rejects an agent and an administrator disabled after the API check", async () => {
    await expect(remove(agent)).rejects.toMatchObject({ code: "42501" });
    await db.query("update profiles set active=false where id=$1", [admin]);
    await expect(remove()).rejects.toMatchObject({ code: "42501" });
    expect(
      await one("select id from properties where id=$1", [property]),
    ).toBeTruthy();
  });
  it.each(["leads", "visits", "deals"])(
    "preserves a property linked to %s and leaves no cleanup/audit",
    async (table) => {
      const lead = (
        await one(
          "insert into leads(name,masked_phone,assigned_agent,property_id) values('Linked customer','******123',$1,$2) returning id",
          [agent, table === "leads" ? property : null],
        )
      ).id;
      if (table === "visits")
        await db.query(
          "insert into visits(lead_id,agent_id,property_id,scheduled_at) values($1,$2,$3,now())",
          [lead, agent, property],
        );
      if (table === "deals")
        await db.query(
          "insert into deals(lead_id,agent_id,property_id,stage,expected_value) values($1,$2,$3,'discussion',100)",
          [lead, agent, property],
        );
      const requestId = randomUUID();
      await expect(remove(admin, property, requestId)).rejects.toMatchObject({
        code: "23503",
      });
      expect(
        await one("select id from properties where id=$1", [property]),
      ).toBeTruthy();
      expect(
        await one(
          "select id from property_photo_cleanup where property_id=$1",
          [property],
        ),
      ).toBeUndefined();
      expect(
        await one("select id from audit_log where request_id=$1", [requestId]),
      ).toBeUndefined();
    },
  );
  it("rolls back property, photos and cleanup if the audit insert fails", async () => {
    await db.query(
      "insert into property_photos(property_id,storage_path) values($1,$2)",
      [property, property + "/rollback"],
    );
    await db.exec(
      "create function fail_delete_audit() returns trigger language plpgsql as $$ begin if new.action='delete' then raise exception 'Audit unavailable'; end if; return new; end $$; create trigger fail_delete_audit before insert on audit_log for each row execute function fail_delete_audit();",
    );
    try {
      await expect(remove()).rejects.toThrow("Audit unavailable");
      expect(
        await one("select id from properties where id=$1", [property]),
      ).toBeTruthy();
      expect(
        await one("select id from property_photos where property_id=$1", [
          property,
        ]),
      ).toBeTruthy();
      expect(
        await one(
          "select id from property_photo_cleanup where property_id=$1",
          [property],
        ),
      ).toBeUndefined();
    } finally {
      await db.exec(
        "drop trigger fail_delete_audit on audit_log; drop function fail_delete_audit();",
      );
    }
  });
  it.each(["anon", "authenticated"])(
    "denies %s direct delete RPC and cleanup-table access",
    async (role) => {
      expect(
        await one(
          "select has_function_privilege($1,'public.delete_property(uuid,uuid,text)','execute') as allowed,has_table_privilege($1,'public.property_photo_cleanup','select') as readable",
          [role],
        ),
      ).toEqual({ allowed: false, readable: false });
      await db.exec(`set role ${role}`);
      try {
        await expect(remove()).rejects.toMatchObject({ code: "42501" });
        await expect(
          db.query("select * from property_photo_cleanup"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.exec("reset role");
      }
    },
  );
});

function client(role = "admin", active = true) {
  const id = role === "admin" ? admin : agent;
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id, email_confirmed_at: "2026-10-01T00:00:00Z" } },
      }),
    },
    rpc: vi.fn(async (name, args) => {
      try {
        await remove(args.p_actor, args.p_property, args.p_request);
        return { data: null };
      } catch (error) {
        return { error: { code: error.code } };
      }
    }),
    storage: {
      from: vi.fn(() => ({ remove: vi.fn(async () => ({ data: [] })) })),
    },
    from(table) {
      let propertyId,
        ids,
        deleting = false;
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: (field, value) => {
          if (field === "property_id") propertyId = value;
          return query;
        },
        single: async () => ({ data: { id, name: "Test user", role, active } }),
        delete: () => {
          deleting = true;
          return query;
        },
        in: (field, values) => {
          ids = values;
          return query;
        },
        then: (resolve, reject) => {
          const sql = deleting
            ? "delete from property_photo_cleanup where id=any($1::uuid[])"
            : "select id,storage_path from property_photo_cleanup where ($1::uuid is null or property_id=$1) order by created_at limit 100";
          return db
            .query(sql, [deleting ? ids : propertyId || null])
            .then((r) => ({ data: r.rows }))
            .then(resolve, reject);
        },
      };
      return query;
    },
  };
}

describe("property delete API and file cleanup", () => {
  it("allows admin deletion and returns 404 on repeat", async () => {
    const app = createApp(trustedMfaFixture(client()));
    expect(
      (
        await request(app)
          .delete("/api/properties/" + property)
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .delete("/api/properties/" + property)
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(404);
  });
  it("returns a useful conflict when linked records prevent deletion", async () => {
    await db.query(
      "insert into leads(name,masked_phone,property_id) values('Linked','******123',$1)",
      [property],
    );
    const response = await request(createApp(trustedMfaFixture(client())))
      .delete("/api/properties/" + property)
      .set("Authorization", "Bearer valid");
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Archive/);
  });
  it("denies unauthenticated, disabled and invalid-ID requests before RPC", async () => {
    const unauth = client();
    expect(
      (
        await request(createApp(trustedMfaFixture(unauth))).delete(
          "/api/properties/" + property,
        )
      ).status,
    ).toBe(401);
    const disabled = client("admin", false);
    expect(
      (
        await request(createApp(trustedMfaFixture(disabled)))
          .delete("/api/properties/" + property)
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(403);
    expect(disabled.rpc).not.toHaveBeenCalled();
    // Agents may delete their own inventory (update 041), so the database
    // decides: this company property is read-only for them.
    const agentClient = client("agent");
    const refused = await request(createApp(trustedMfaFixture(agentClient)))
      .delete("/api/properties/" + property)
      .set("Authorization", "Bearer valid");
    expect(refused.status).toBe(403);
    expect(agentClient.rpc).toHaveBeenCalledOnce();
    expect(
      await one("select id from properties where id=$1", [property]),
    ).toBeTruthy();
    const invalid = client();
    expect(
      (
        await request(createApp(trustedMfaFixture(invalid)))
          .delete("/api/properties/not-a-uuid")
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(400);
    expect(invalid.rpc).not.toHaveBeenCalled();
    expect(unauth.rpc).not.toHaveBeenCalled();
  });
  it("explains when the hosted delete migration has not been installed", async () => {
    const database = client();
    database.rpc.mockResolvedValue({ error: { code: "PGRST202" } });
    const response = await request(createApp(trustedMfaFixture(database)))
      .delete("/api/properties/" + property)
      .set("Authorization", "Bearer valid");
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/migration 013/);
  });
  it("retains the durable queue on storage failure and removes it after a successful retry", async () => {
    await db.query(
      "insert into property_photos(property_id,storage_path) values($1,$2)",
      [property, property + "/retry"],
    );
    await remove();
    const database = client();
    const storageRemove = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "Temporary outage" } })
      .mockResolvedValue({ data: [] });
    database.storage.from = vi.fn(() => ({ remove: storageRemove }));
    await expect(cleanupPropertyPhotos(database, property)).rejects.toThrow(
      /retry/,
    );
    expect(
      await one("select id from property_photo_cleanup where property_id=$1", [
        property,
      ]),
    ).toBeTruthy();
    expect(await cleanupPropertyPhotos(database, property)).toEqual({
      processed: 1,
    });
    expect(storageRemove).toHaveBeenCalledWith([property + "/retry"]);
    expect(
      await one("select id from property_photo_cleanup where property_id=$1", [
        property,
      ]),
    ).toBeUndefined();
  });
});
