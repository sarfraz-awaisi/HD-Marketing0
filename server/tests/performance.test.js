import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readdir, readFile } from "node:fs/promises";
import request from "supertest";
import { authRequest } from "../src/services/authRequests.js";
import { dashboardSnapshot } from "../src/services/dashboard.js";
import { propertyCovers } from "../src/services/propertyCovers.js";
import { createApp } from "../src/app.js";

const admin = "b2700000-0000-4000-8000-000000000001",
  agent = "b2700000-0000-4000-8000-000000000002",
  other = "b2700000-0000-4000-8000-000000000003";
const range = {
  from: "2026-10-01T00:00:00+05:00",
  to: "2026-11-01T00:00:00+05:00",
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
describe("overlapping native authentication requests", () => {
  it("shares only concurrent verification and checks again after completion", async () => {
    const pending = deferred(),
      db = { auth: { getUser: vi.fn(() => pending.promise) } };
    const a = authRequest(db, "getUser", "same"),
      b = authRequest(db, "getUser", "same");
    expect(a).toBe(b);
    pending.resolve({ data: { user: {} } });
    await a;
    await authRequest(db, "getUser", "same");
    expect(db.auth.getUser).toHaveBeenCalledTimes(2);
  });
  it("isolates different tokens, Auth methods and database clients", async () => {
    const a = deferred(),
      b = deferred();
    const db = {
      auth: {
        getUser: vi.fn(() => a.promise),
        getClaims: vi.fn(() => b.promise),
      },
    };
    const second = { auth: { getUser: vi.fn(() => a.promise) } };
    const pending = [
      authRequest(db, "getUser", "first"),
      authRequest(db, "getUser", "second"),
      authRequest(db, "getClaims", "first"),
      authRequest(second, "getUser", "first"),
    ];
    a.resolve({ data: {} });
    b.resolve({ data: {} });
    await Promise.all(pending);
    expect(db.auth.getUser).toHaveBeenCalledTimes(2);
    expect(db.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(second.auth.getUser).toHaveBeenCalledTimes(1);
  });
  it("evicts failed requests so the next request can recover", async () => {
    const db = {
      auth: {
        getUser: vi
          .fn()
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValue({ data: {} }),
      },
    };
    await expect(authRequest(db, "getUser", "token")).rejects.toThrow(
      "offline",
    );
    await expect(authRequest(db, "getUser", "token")).resolves.toEqual({
      data: {},
    });
  });
  it("does not cache the active account or its role between API requests", async () => {
    let active = true;
    const db = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: admin, email_confirmed_at: "2026-10-14" } },
        })),
        getClaims: vi.fn(async () => ({
          data: { claims: { sub: admin, aal: "aal1" } },
        })),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: admin, name: "Admin", role: "admin", active },
            }),
          }),
        }),
      }),
    };
    const app = createApp(db);
    expect(
      (await request(app).get("/api/me").set("Authorization", "Bearer fixture"))
        .status,
    ).toBe(200);
    active = false;
    expect(
      (await request(app).get("/api/me").set("Authorization", "Bearer fixture"))
        .status,
    ).toBe(403);
    expect(db.auth.getUser).toHaveBeenCalledTimes(2);
  });
});
describe("dashboard compatibility while upgrading", () => {
  it("uses the authenticated actor and rejects forged actor and source filters", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        metrics: {},
        leaders: [],
        followups: [],
        visits: [],
        targets: [],
      },
    }));
    const db = {
      rpc,
      auth: {
        getUser: async () => ({
          data: { user: { id: admin, email_confirmed_at: "2026-10-14" } },
        }),
        getClaims: async () => ({
          data: { claims: { sub: admin, aal: "aal1" } },
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: admin, role: "admin", active: true },
            }),
          }),
        }),
      }),
    };
    const app = createApp(db);
    const query = { from: range.from, to: range.to };
    const result = await request(app)
      .get("/api/dashboard")
      .query(query)
      .set("Authorization", "Bearer fixture");
    expect(result.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("dashboard_snapshot", {
      p_actor: admin,
      p_from: range.from,
      p_to: range.to,
    });
    for (const invalid of [
      { ...query, actor: other },
      { ...query, source: "Meta" },
      { ...query, to: range.from },
    ])
      expect(
        (
          await request(app)
            .get("/api/dashboard")
            .query(invalid)
            .set("Authorization", "Bearer fixture")
        ).status,
      ).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("uses one database RPC when the aggregate reader is installed", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: {
          metrics: { leads: 4 },
          leaders: [],
          followups: [],
          visits: [],
          targets: [],
        },
      })),
    };
    expect(
      (await dashboardSnapshot(db, { id: admin, role: "admin" }, range)).metrics
        .leads,
    ).toBe(4);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("keeps agent current-owner filters when only the new function is missing", async () => {
    const queries = [];
    const db = {
      rpc: vi.fn(async (name) =>
        name === "dashboard_snapshot"
          ? { error: { code: "PGRST202" } }
          : { data: name === "crm_metrics" ? {} : [] },
      ),
      from: (table) => {
        const filters = [],
          q = {
            select: () => q,
            eq: (...args) => {
              filters.push(args);
              return q;
            },
            lte: () => q,
            order: () => q,
            limit: () => Promise.resolve({ data: [] }),
          };
        queries.push({ table, filters });
        return q;
      },
    };
    await dashboardSnapshot(db, { id: agent, role: "agent" }, range);
    for (const query of queries)
      expect(query.filters).toContainEqual([
        query.table === "targets" ? "agent_id" : "leads.assigned_agent",
        agent,
      ]);
    expect(queries).toHaveLength(3);
  });
  it.each(["42501", "42P01", "PGRST205", "08006"])(
    "fails without fallback for %s",
    async (code) => {
      const db = {
        rpc: vi.fn(async () => ({ error: { code } })),
        from: vi.fn(),
      };
      await expect(
        dashboardSnapshot(db, { id: agent, role: "agent" }, range),
      ).rejects.toMatchObject({ status: code === "42501" ? 403 : 503 });
      expect(db.from).not.toHaveBeenCalled();
    },
  );
});
describe("batch property covers", () => {
  it("signs all card covers once and sends no private storage paths to the browser", async () => {
    const sign = vi.fn(async (paths) => ({
      data: paths.map((path) => ({ signedUrl: "signed:" + path })),
    }));
    const db = {
      rpc: vi.fn(async () => ({
        data: [
          {
            property_id: "p1",
            id: "photo1",
            storage_path: "private1",
            photo_count: 2,
          },
          {
            property_id: "p2",
            id: "photo2",
            storage_path: "private2",
            photo_count: 1,
          },
        ],
      })),
      storage: { from: () => ({ createSignedUrls: sign }) },
    };
    const result = await propertyCovers(db, agent, [
      { id: "p1" },
      { id: "p2" },
      { id: "p3" },
    ]);
    expect(sign).toHaveBeenCalledExactlyOnceWith(["private1", "private2"], 60);
    expect(result[0]).toMatchObject({
      photo_count: 2,
      cover_photo: { id: "photo1", url: "signed:private1" },
    });
    expect(result[2]).toMatchObject({ photo_count: 0, cover_photo: null });
    expect(result[0]).not.toHaveProperty("storage_path");
  });
  it("retains the existing image loader until the cover RPC is installed", async () => {
    const properties = [{ id: "p1" }],
      db = { rpc: async () => ({ error: { code: "42883" } }) };
    expect(await propertyCovers(db, agent, properties)).toBe(properties);
  });
  it("keeps property details when Storage cannot sign photos", async () => {
    const db = {
      rpc: async () => ({
        data: [
          {
            property_id: "p1",
            id: "photo",
            storage_path: "private",
            photo_count: 1,
          },
        ],
      }),
      storage: {
        from: () => ({
          createSignedUrls: async () => ({ error: { message: "Unavailable" } }),
        }),
      },
    };
    expect(
      await propertyCovers(db, agent, [
        { id: "p1", title: "Visible property" },
      ]),
    ).toEqual([
      {
        id: "p1",
        title: "Visible property",
        photo_count: 1,
        cover_photo: { id: "photo", url: null },
      },
    ]);
  });
});
let pg, property, lead;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query("insert into auth.users(id) values($1),($2),($3)", [
    admin,
    agent,
    other,
  ]);
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=id::text",
    [admin],
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Test','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  lead = (
    await one(
      "insert into leads(name,masked_phone,assigned_agent) values('Assigned','***123',$1) returning id",
      [other],
    )
  ).id;
  await pg.query(
    "insert into followups(lead_id,agent_id,due_at) values($1,$2,now())",
    [lead, agent],
  );
  await pg.query(
    "insert into visits(lead_id,property_id,agent_id,scheduled_at) values($1,$2,$3,now())",
    [lead, property, agent],
  );
  await pg.query(
    "insert into targets(agent_id,month,calls) values($1,'2026-10-01',7),($2,'2026-10-01',9)",
    [agent, other],
  );
  await pg.query(
    "insert into calls(lead_id,agent_id,status,ended_at) values($1,$2,'completed','2026-10-14'),($1,$3,'completed','2026-09-14')",
    [lead, agent, other],
  );
  await pg.query(
    "insert into property_photos(property_id,storage_path,created_at) values($1,'first','2026-10-01'),($1,'second','2026-10-02')",
    [property],
  );
}, 30000);
afterAll(() => pg?.close());
describe("executable performance readers", () => {
  const snapshot = async (actor) =>
    (
      await one("select dashboard_snapshot($1,$2,$3) value", [
        actor,
        range.from,
        range.to,
      ])
    ).value;
  it("matches the existing metrics and groups leaderboard totals by the date range", async () => {
    const data = await snapshot(admin),
      metrics = (
        await one("select crm_metrics($1,$2,$3,null,null) value", [
          admin,
          range.from,
          range.to,
        ])
      ).value;
    expect(data.metrics).toEqual(metrics);
    expect(data.leaders.find((p) => p.name === agent).completed_calls).toBe(1);
    expect(data.leaders.find((p) => p.name === other).completed_calls).toBe(0);
    expect(data.targets).toEqual([]);
  });
  it("uses the lead's current owner rather than a stale activity author", async () => {
    const former = await snapshot(agent),
      current = await snapshot(other);
    expect(former.followups).toEqual([]);
    expect(former.visits).toEqual([]);
    expect(current.followups).toHaveLength(1);
    expect(current.visits).toHaveLength(1);
    expect(former.targets.map((t) => t.agent_id)).toEqual([agent]);
  });
  it("returns only the first cover and the complete count for requested properties", async () => {
    const covers = (
      await one("select property_cover_photos($1,$2) value", [
        agent,
        [property],
      ])
    ).value;
    expect(covers).toHaveLength(1);
    expect(covers[0]).toMatchObject({ storage_path: "first", photo_count: 2 });
    expect(
      (await one("select property_cover_photos($1,'{}') value", [agent])).value,
    ).toEqual([]);
    await expect(
      pg.query(
        "select property_cover_photos($1,array_fill($2::uuid,array[101]))",
        [agent, property],
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("refuses disabled users and invalid report ranges", async () => {
    await pg.query("update profiles set active=false where id=$1", [agent]);
    await expect(snapshot(agent)).rejects.toMatchObject({ code: "42501" });
    await expect(
      pg.query("select property_cover_photos($1,$2)", [agent, [property]]),
    ).rejects.toMatchObject({ code: "42501" });
    await pg.query("update profiles set active=true where id=$1", [agent]);
    await expect(
      pg.query("select dashboard_snapshot($1,$2,$2)", [admin, range.from]),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("blocks direct execution by browser roles", async () => {
    await pg.exec("set role authenticated");
    try {
      for (const sql of [
        "select dashboard_snapshot($1,$2,$3)",
        "select property_cover_photos($1,array[]::uuid[])",
      ]) {
        await expect(
          pg.query(
            sql,
            sql.includes("dashboard") ? [agent, range.from, range.to] : [agent],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await pg.exec("reset role");
    }
  });
  it("installs substring and ownership indexes without widening table grants", async () => {
    const indexes = (
      await pg.query(
        "select indexname,indexdef from pg_indexes where indexname in ('leads_name_substring','properties_title_substring','lead_imports_filename_substring','leads_owner_created','calls_agent_completed_ended')",
      )
    ).rows;
    expect(indexes).toHaveLength(5);
    expect(
      indexes.find((i) => i.indexname === "leads_name_substring").indexdef,
    ).toContain("USING gin");
    expect(
      (
        await one(
          "select has_table_privilege('authenticated','public.leads','SELECT') allowed",
        )
      ).allowed,
    ).toBe(false);
  });
});
