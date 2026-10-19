import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { manualCall } from "../src/utils/validators.js";

const admin = "81000000-0000-4000-8000-000000000001";
const agent = "81000000-0000-4000-8000-000000000002";
const other = "81000000-0000-4000-8000-000000000003";
let pg,
  lead,
  oldMock,
  oldProvider,
  sequence = 0;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const payload = (change = {}) => ({
  answered: true,
  started_at: new Date(Date.now() - 60000).toISOString(),
  duration_seconds: 45,
  outcome: "Interested",
  notes: "Fixture call note",
  deal_tags: ["Hot lead"],
  ...change,
});
const log = async (
  data = payload(),
  actor = agent,
  customer = lead,
  req = randomUUID(),
) =>
  (
    await one("select log_manual_call($1,$2,$3::jsonb,$4) value", [
      customer,
      actor,
      JSON.stringify(data),
      req,
    ])
  ).value;
const createLead = async (owner = agent) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture:create')).id", [
      JSON.stringify({ name: "Manual call fixture", assigned_agent: owner }),
      "+92310" + String(++sequence).padStart(7, "0"),
      admin,
    ])
  ).id;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(dir)).sort();
  for (const file of migrations.filter((name) => name < "018"))
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
  await pg.query("update profiles set active=true where id=any($1::uuid[])", [
    [admin, agent, other],
  ]);
  await pg.query("update profiles set role='admin' where id=$1", [admin]);
  await pg.query("update profiles set name=$1 where id=$2", [
    "Manual fixture agent",
    agent,
  ]);
  await pg.query("update profiles set name=$1 where id=$2", [
    "Other fixture agent",
    other,
  ]);
  const customer = await createLead();
  oldMock = await one(
    "insert into calls(lead_id,agent_id,provider_call_id) values($1,$2,$3) returning *",
    [customer, agent, "mock-" + randomUUID()],
  );
  oldProvider = await one(
    "insert into calls(lead_id,agent_id,provider_call_id) values($1,$2,$3) returning *",
    [customer, agent, "provider-" + randomUUID()],
  );
  for (const file of migrations.filter((name) => name >= "018"))
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  lead = await createLead();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function database() {
  const client = {
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, agent, other].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01T00:00:00Z" }
            : null,
        },
      }),
    },
    rpc: vi.fn(async (name, args) => {
      try {
        const keys = Object.keys(args);
        const values = keys.map((key) =>
          key === "p_data" ? JSON.stringify(args[key]) : args[key],
        );
        return {
          data: (
            await one(
              `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}${key === "p_data" ? "::jsonb" : ""}`).join(",")}) value`,
              values,
            )
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code } };
      }
    }),
    from(table) {
      let fields = "r.*",
        joins = "",
        filters = [],
        orders = [],
        cap = Infinity;
      async function run() {
        try {
          const sql = `select ${fields} from public.${table} r${joins}${filters.length ? " where " + filters.map(([field], i) => `${field}${filters[i][1] === null ? " is not distinct from " : "="}$${i + 1}`).join(" and ") : ""}${orders.length ? " order by " + orders.join(",") : ""}`;
          const rows = (
            await pg.query(
              sql,
              filters.map(([, value]) => value),
            )
          ).rows;
          return { data: rows.slice(0, cap), count: rows.length };
        } catch (error) {
          return { error: { code: error.code } };
        }
      }
      const q = {
        select(value = "*") {
          if (value.includes("!inner"))
            joins = " join public.leads l on l.id=r.lead_id";
          else
            fields =
              value === "*"
                ? "r.*"
                : value
                    .split(",")
                    .map((field) => "r." + field)
                    .join(",");
          return q;
        },
        eq(field, value) {
          filters.push([
            field.startsWith("leads.")
              ? field.replace("leads.", "l.")
              : "r." + field,
            value,
          ]);
          return q;
        },
        is(field, value) {
          filters.push([
            field.startsWith("leads.")
              ? field.replace("leads.", "l.")
              : "r." + field,
            value,
          ]);
          return q;
        },
        order(field, options) {
          orders.push(
            "r." + field + (options?.ascending === false ? " desc" : " asc"),
          );
          return q;
        },
        limit(value) {
          cap = value;
          return q;
        },
        async single() {
          const result = await run();
          return { ...result, data: result.data?.[0] };
        },
        async maybeSingle() {
          const result = await run();
          return { ...result, data: result.data?.[0] || null };
        },
        async range(low, high) {
          const result = await run();
          return { ...result, data: result.data?.slice(low, high + 1) };
        },
        then(resolve, reject) {
          return run().then(resolve, reject);
        },
      };
      return q;
    },
  };
  return client;
}
const post = (app, data = payload(), actor = agent, id = lead) =>
  request(app)
    .post(`/api/leads/${id}/calls/manual`)
    .set("Authorization", "Bearer " + actor)
    .send(data);

describe("P1 manual-call transactions", () => {
  it("backfills old mock calls without inventing answered history or changing provider records", async () => {
    expect(
      await one(
        "select method,answered,started_at,status from calls where id=$1",
        [oldMock.id],
      ),
    ).toMatchObject({
      method: "mock",
      answered: null,
      started_at: oldMock.started_at,
      status: oldMock.status,
    });
    expect(
      await one("select method,answered from calls where id=$1", [
        oldProvider.id,
      ]),
    ).toEqual({ method: "provider", answered: null });
  });
  it("logs an answered call, advances once, preserves exact duration and writes safe actor-linked audit", async () => {
    const req = randomUUID(),
      data = payload();
    const result = await log(data, agent, lead, req);
    expect(result).toMatchObject({
      lead_id: lead,
      agent_id: agent,
      method: "manual",
      answered: true,
      status: "completed",
      outcome: "Interested",
      duration_seconds: 45,
      missing_outcome: false,
      notes: data.notes,
      deal_tags: ["Hot lead"],
      provider_call_id: null,
    });
    expect(Date.parse(result.ended_at) - Date.parse(result.started_at)).toBe(
      45000,
    );
    expect(result.outcome_submitted_at).toBeTruthy();
    expect(
      (
        await one("select status,last_activity_at from leads where id=$1", [
          lead,
        ])
      ).status,
    ).toBe("contacted");
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(1);
    const audit = (
      await pg.query(
        "select * from audit_log where action='call.manual_logged' and request_id=$1",
        [req],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: agent,
      entity_id: result.id,
      entity: "calls",
    });
    expect(JSON.stringify(audit)).not.toContain(data.notes);
    expect(JSON.stringify(audit)).not.toContain(data.started_at);
    await log();
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(1);
  });
  it.each(["No answer", "Busy", "Wrong number"])(
    "records zero-duration %s without advancing a new lead",
    async (outcome) => {
      const result = await log(
        payload({ answered: false, duration_seconds: 0, outcome }),
      );
      expect(result).toMatchObject({
        method: "manual",
        answered: false,
        status: "failed",
        outcome,
        duration_seconds: 0,
        missing_outcome: false,
      });
      expect(result.ended_at).toBe(result.started_at);
      expect(
        (await one("select status from leads where id=$1", [lead])).status,
      ).toBe("new");
      expect(
        (
          await one(
            "select count(*)::int n from lead_status_history where lead_id=$1",
            [lead],
          )
        ).n,
      ).toBe(0);
    },
  );
  it.each([
    { answered: true, duration_seconds: 0 },
    { duration_seconds: -1 },
    { duration_seconds: 7201 },
    { duration_seconds: 1.5 },
    { answered: false, outcome: "Interested" },
    { outcome: "Invented" },
    { notes: "x".repeat(4001) },
    { deal_tags: ["Unknown"] },
    { deal_tags: ["Hot lead", "Hot lead"] },
    { deal_tags: [null] },
    { deal_tags: null },
    { answered: null },
    { started_at: "infinity" },
    { started_at: "2026-10-13T10:00:00" },
  ])(
    "rejects invalid direct SQL input %# without creating a call",
    async (change) => {
      await expect(log(payload(change))).rejects.toThrow();
      expect(
        (
          await one("select count(*)::int n from calls where lead_id=$1", [
            lead,
          ])
        ).n,
      ).toBe(0);
      expect(
        (await one("select status from leads where id=$1", [lead])).status,
      ).toBe("new");
    },
  );
  it("accepts one second and the 7200-second upper limit, with two minutes of clock skew", async () => {
    expect((await log(payload({ duration_seconds: 1 }))).duration_seconds).toBe(
      1,
    );
    expect(
      (
        await log(
          payload({
            duration_seconds: 7200,
            started_at: new Date(Date.now() + 90000).toISOString(),
          }),
        )
      ).duration_seconds,
    ).toBe(7200);
  });
  it("enforces the 48-hour agent and 30-day admin windows in SQL", async () => {
    await expect(
      log(payload({ started_at: new Date(Date.now() + 180000).toISOString() })),
    ).rejects.toThrow("time window");
    const old = payload({
      started_at: new Date(Date.now() - 49 * 3600000).toISOString(),
    });
    await expect(log(old)).rejects.toThrow("time window");
    expect((await log(old, admin)).agent_id).toBe(agent);
    await expect(
      log(
        payload({
          started_at: new Date(Date.now() - 31 * 86400000).toISOString(),
        }),
        admin,
      ),
    ).rejects.toThrow("time window");
  });
  it("checks current ownership, inactive actors and forged SQL fields", async () => {
    await expect(log(payload(), other)).rejects.toMatchObject({
      code: "P0002",
    });
    await expect(log(payload({ agent_id: other }))).rejects.toMatchObject({
      code: "42501",
    });
    await pg.query("select assign_lead($1,$2,$3,'fixture:reassign')", [
      lead,
      admin,
      other,
    ]);
    await expect(log()).rejects.toMatchObject({ code: "P0002" });
    await pg.query("update profiles set active=false where id=$1", [other]);
    try {
      await expect(log(payload(), other)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await pg.query("update profiles set active=true where id=$1", [other]);
    }
  });
  it("credits an admin log to the assigned agent, or to the admin for an unassigned lead", async () => {
    expect((await log(payload(), admin)).agent_id).toBe(agent);
    await pg.query("update leads set assigned_agent=null where id=$1", [lead]);
    expect((await log(payload(), admin)).agent_id).toBe(admin);
  });
  it.each(["interested", "won", "lost"])(
    "does not move %s backwards or reopen it",
    async (status) => {
      await pg.query(
        "select crm_mutate('leads',$1,$2::jsonb,$3,'fixture:stage')",
        [
          lead,
          JSON.stringify({
            status,
            ...(status === "lost" ? { lost_reason: "price" } : {}),
          }),
          agent,
        ],
      );
      await log();
      expect(
        (await one("select status from leads where id=$1", [lead])).status,
      ).toBe(status);
    },
  );
  it("rolls the call, lead activity, stage and history back if audit persistence fails", async () => {
    const before = await one(
      "select status,last_activity_at from leads where id=$1",
      [lead],
    );
    await pg.exec(
      "create function fail_manual_audit() returns trigger language plpgsql as $$ begin if new.action='call.manual_logged' then raise exception 'Audit unavailable'; end if; return new; end $$;create trigger fail_manual_audit before insert on audit_log for each row execute function fail_manual_audit();",
    );
    try {
      await expect(log()).rejects.toThrow("Audit unavailable");
      expect(
        await one("select status,last_activity_at from leads where id=$1", [
          lead,
        ]),
      ).toEqual(before);
      expect(
        (
          await one("select count(*)::int n from calls where lead_id=$1", [
            lead,
          ])
        ).n,
      ).toBe(0);
      expect(
        (
          await one(
            "select count(*)::int n from lead_status_history where lead_id=$1",
            [lead],
          )
        ).n,
      ).toBe(0);
    } finally {
      await pg.exec(
        "drop trigger fail_manual_audit on audit_log;drop function fail_manual_audit();",
      );
    }
  });
  it("denies browser execution and permits the trusted service role", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec("set role " + role);
      try {
        await expect(log()).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pg.exec("reset role");
      }
    }
    await pg.exec("set role service_role");
    try {
      expect((await log()).method).toBe("manual");
    } finally {
      await pg.exec("reset role");
    }
  });
});

describe("P1 API and production capabilities", () => {
  it.each([admin, agent])(
    "logs a phone conversation through actual SQL as %s",
    async (actor) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CALL_PROVIDER", "");
      const client = database();
      const response = await post(
        createApp(trustedMfaFixture(client)),
        payload({ duration_minutes: 2, duration_seconds: 7 }),
        actor,
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        method: "manual",
        answered: true,
        duration_seconds: 127,
        status: "completed",
        agent_id: agent,
      });
      expect(client.rpc).toHaveBeenCalledWith(
        "log_manual_call",
        expect.objectContaining({
          p_actor: actor,
          p_data: expect.objectContaining({ duration_seconds: 127 }),
          p_lead: lead,
        }),
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.ratelimit).toContain("30");
    },
  );
  it("accepts unanswered calls in production and leaves the lead New", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await post(
      createApp(trustedMfaFixture(database())),
      payload({ answered: false, outcome: "Busy", duration_seconds: 0 }),
    );
    expect(response.status).toBe(201);
    expect(response.body.status).toBe("failed");
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("new");
  });
  it("returns 400 before writes for malformed, future, old and unsupported call fields", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    for (const change of [
      { answered: "yes" },
      { duration_seconds: -1 },
      { duration_seconds: 7201 },
      { duration_seconds: 1.5 },
      { duration_minutes: 1, duration_seconds: 60 },
      { duration_minutes: 120, duration_seconds: 1 },
      { duration_seconds: 0 },
      { answered: false, outcome: "Interested" },
      { notes: "x".repeat(4001) },
      { deal_tags: ["Hot lead", "Hot lead"] },
      { started_at: new Date(Date.now() + 180000).toISOString() },
      { started_at: new Date(Date.now() - 49 * 3600000).toISOString() },
      { agent_id: other },
      { method: "mock" },
    ])
      expect((await post(app, payload(change))).status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it("returns 404 for another agent's lead and 403 for disabled accounts", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    expect((await post(app, payload(), other)).status).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
    await pg.query("update profiles set active=false where id=$1", [agent]);
    try {
      expect((await post(app)).status).toBe(403);
    } finally {
      await pg.query("update profiles set active=true where id=$1", [agent]);
    }
  });
  it("rechecks reassignment inside the write transaction after a preliminary read", async () => {
    const client = database(),
      original = client.rpc.getMockImplementation();
    client.rpc.mockImplementationOnce(async (...args) => {
      await pg.query("select assign_lead($1,$2,$3,'fixture:race')", [
        lead,
        admin,
        other,
      ]);
      return original(...args);
    });
    expect((await post(createApp(trustedMfaFixture(client)))).status).toBe(404);
    expect(
      (await one("select count(*)::int n from calls where lead_id=$1", [lead]))
        .n,
    ).toBe(0);
  });
  it("reports an actionable missing-migration error without inventing a result", async () => {
    const client = database();
    client.rpc.mockResolvedValueOnce({ error: { code: "PGRST202" } });
    const response = await post(createApp(trustedMfaFixture(client)));
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("migration 018");
  });
  it("advertises manual calling only in production and refuses mock initiation/completion", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CALL_PROVIDER", "mock");
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const get = (path) =>
      request(app)
        .get(path)
        .set("Authorization", "Bearer " + agent);
    expect((await get("/api/call-capabilities")).body).toEqual({
      manual: true,
      mock: false,
      provider: false,
    });
    expect(
      (
        await request(app)
          .post(`/api/leads/${lead}/call`)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/calls/${oldMock.id}/mock-complete`)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
    expect((await request(app).get("/api/call-capabilities")).status).toBe(401);
  });
  it("labels new development mock calls and hides mocks when the provider is absent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CALL_PROVIDER", "mock");
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    client.rpc.mockImplementationOnce(async (name, args) => ({
      data: (
        await one("select crm_mutate($1,$2,$3::jsonb,$4,$5) value", [
          args.p_table,
          args.p_id,
          JSON.stringify(args.p_data),
          args.p_actor,
          args.p_request,
        ])
      ).value,
    }));
    const original = client.rpc.getMockImplementation();
    client.rpc.mockImplementation(async (name, args) =>
      name === "private_phone"
        ? { data: "+923001234567" }
        : original(name, args),
    );
    const response = await request(app)
      .post(`/api/leads/${lead}/call`)
      .set("Authorization", "Bearer " + agent);
    expect(response.status).toBe(201);
    expect(response.body.method).toBe("mock");
    vi.stubEnv("CALL_PROVIDER", "");
    expect(
      (
        await request(app)
          .get("/api/call-capabilities")
          .set("Authorization", "Bearer " + agent)
      ).body.mock,
    ).toBe(false);
  });
  it("filters Manual/Mock/Provider in Call review and rejects misuse of the filter", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const call = await log();
    for (const method of ["manual", "mock", "provider"]) {
      const response = await request(app)
        .get(`/api/calls?method=${method}`)
        .set("Authorization", "Bearer " + admin);
      expect(response.status).toBe(200);
      expect(response.body.data.every((row) => row.method === method)).toBe(
        true,
      );
      if (method === "manual")
        expect(response.body.data.some((row) => row.id === call.id)).toBe(true);
    }
    for (const path of [
      "/api/calls?method=unknown",
      "/api/leads?method=manual",
    ])
      expect(
        (
          await request(app)
            .get(path)
            .set("Authorization", "Bearer " + admin)
        ).status,
      ).toBe(400);
  });
  it("preserves manual answered/outcome consistency during later API edits", async () => {
    const call = await log(
      payload({ answered: false, outcome: "No answer", duration_seconds: 0 }),
    );
    const response = await request(createApp(trustedMfaFixture(database())))
      .patch(`/api/calls/${call.id}`)
      .set("Authorization", "Bearer " + agent)
      .send({ outcome: "Interested", notes: "Invalid edit", deal_tags: [] });
    expect(response.status).toBe(400);
    expect(
      (await one("select outcome from calls where id=$1", [call.id])).outcome,
    ).toBe("No answer");
  });
  it("counts answered manual calls in reports, target actuals and the leaderboard", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const from = new Date(Date.now() - 86400000).toISOString(),
      to = new Date(Date.now() + 86400000).toISOString();
    const metrics = async () =>
      (
        await request(app)
          .get("/api/reports?" + new URLSearchParams({ from, to }))
          .set("Authorization", "Bearer " + agent)
      ).body;
    const board = async () =>
      (
        await request(app)
          .get("/api/leaderboard?" + new URLSearchParams({ from, to }))
          .set("Authorization", "Bearer " + agent)
      ).body;
    const initial = await metrics(),
      before = (await board()).find(
        (row) => row.name === "Manual fixture agent",
      );
    await log(
      payload({ started_at: new Date(Date.now() - 180000).toISOString() }),
    );
    await log(
      payload({ answered: false, outcome: "No answer", duration_seconds: 0 }),
    );
    expect((await metrics()).completed_calls).toBe(initial.completed_calls + 1);
    const after = (await board()).find(
      (row) => row.name === "Manual fixture agent",
    );
    expect(after.completed_calls).toBe(before.completed_calls + 1);
    const month =
      new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7) + "-01";
    await pg.query(
      "select crm_mutate('targets',null,$1::jsonb,$2,'fixture:target')",
      [
        JSON.stringify({
          agent_id: agent,
          month,
          calls: 5,
          visits: 0,
          deals: 0,
          revenue: 0,
        }),
        admin,
      ],
    );
    const targets = await request(app)
      .get("/api/targets")
      .set("Authorization", "Bearer " + agent);
    expect(targets.body.data[0].calls).toBe(5);
    expect((await metrics()).completed_calls).toBe(initial.completed_calls + 1);
  });
  it("converts split duration fields without accepting numeric strings", () => {
    expect(
      manualCall("agent").parse(
        payload({ duration_minutes: 2, duration_seconds: 3 }),
      ).duration_seconds,
    ).toBe(123);
    expect(() =>
      manualCall("agent").parse(payload({ duration_seconds: "45" })),
    ).toThrow();
  });
});
