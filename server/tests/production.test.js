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
import { spawnSync } from "node:child_process";
import request from "supertest";
import { validateRuntime, trustProxy } from "../src/config/runtime.js";
import { pinSecret } from "../src/services/accountsSecurity.js";
import { createJobRunner } from "../src/jobs/maintenance.js";
import { systemJobs } from "../src/services/systemStatus.js";
import { createApp } from "../src/app.js";
const admin = "e2000000-0000-4000-8000-000000000001",
  agent = "e2000000-0000-4000-8000-000000000002";
const production = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-private-service",
  FRONTEND_URL: "https://crm.example.test",
  WEBHOOK_SECRET: "w".repeat(32),
  ACCOUNTS_PIN_PEPPER: "p".repeat(32),
  CALL_PROVIDER: "manual",
};
let pg, db, app;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args = {}) =>
  (
    await one(
      `select to_jsonb(public.${name}(${Object.keys(args)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(",")})) value`,
      Object.values(args),
    )
  ).value;
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
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
}, 30000);
afterAll(() => pg?.close());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  await pg.exec(
    "truncate auth.users cascade;truncate job_heartbeats,backups;update crm_schema_versions set version=26;",
  );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'agent@example.test',now());",
    [admin, agent],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end",
    [admin],
  );
  vi.stubEnv("REQUIRE_AGENT_MFA", "false");
  db = {
    auth: {
      getUser: async (token) => ({
        data: {
          user: ["admin", "agent"].includes(token)
            ? {
                id: token === "admin" ? admin : agent,
                email_confirmed_at: "2026-10-14",
                factors: [],
              }
            : null,
        },
      }),
      getClaims: async (token) => ({
        data: {
          claims: { sub: token === "admin" ? admin : agent, aal: "aal1" },
        },
      }),
    },
    from: () => ({
      select: () => ({
        eq: (_, id) => ({
          single: async () => ({
            data: await one(
              "select id,name,role,active from profiles where id=$1",
              [id],
            ),
          }),
        }),
      }),
    }),
    rpc: vi.fn(async (name, args) => {
      try {
        return { data: await rpc(name, args) };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }),
  };
  app = createApp(db);
});
describe("production startup and trusted proxies", () => {
  it("accepts valid manual/HTTPS config without admin MFA", () =>
    expect(() => validateRuntime(production)).not.toThrow());
  it.each([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FRONTEND_URL",
    "WEBHOOK_SECRET",
    "ACCOUNTS_PIN_PEPPER",
    "CALL_PROVIDER",
  ])("refuses missing %s without printing secret values", (key) => {
    const env = { ...production, [key]: "" };
    expect(() => validateRuntime(env)).toThrow(key);
    try {
      validateRuntime(env);
    } catch (e) {
      expect(e.message).not.toContain(production.SUPABASE_SERVICE_ROLE_KEY);
    }
  });
  it.each([
    { CALL_PROVIDER: "mock" },
    { CALL_PROVIDER: "cloud" },
    { FRONTEND_URL: "http://crm.example.test" },
    { FRONTEND_URL: "https://crm.example.test/login" },
    { WEBHOOK_SECRET: "short" },
    { ACCOUNTS_PIN_PEPPER: "short" },
    { SUPABASE_URL: "http://127.0.0.1:54321" },
    { JOB_INTERVAL_SECONDS: "300" },
    { PORT: "abc" },
  ])("rejects invalid production settings %j", (change) =>
    expect(() => validateRuntime({ ...production, ...change })).toThrow(),
  );
  it("fails API and jobs entrypoints before touching any provider", () => {
    for (const entry of ["src/index.js", "src/jobs/runner.js"]) {
      const r = spawnSync(process.execPath, [entry], {
        cwd: new URL("..", import.meta.url),
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Production configuration");
      expect(r.stderr).toContain("ACCOUNTS_PIN_PEPPER");
    }
  });
  it("requires an explicit production PIN pepper without service-key fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ACCOUNTS_PIN_PEPPER", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "s".repeat(64));
    expect(() => pinSecret()).toThrow("not configured");
    vi.stubEnv("ACCOUNTS_PIN_PEPPER", "p".repeat(32));
    expect(pinSecret()).toBe("p".repeat(32));
  });
  it("accepts only bounded proxy networks and obtains the correct client IP", () => {
    expect(trustProxy()).toEqual(["loopback"]);
    expect(trustProxy("false")).toBe(false);
    expect(trustProxy("loopback,192.0.2.0/24,2001:db8::/32")).toHaveLength(3);
    for (const v of ["true", "1", "*", "192.0.2.0/33", "loopback,"])
      expect(() => trustProxy(v)).toThrow("TRUST_PROXY");
  });
  it("trusts the nearest forwarded address rather than a forged extra hop", async () => {
    app.get("/__test-ip", (req, res) => res.json({ ip: req.ip }));
    const r = await request(app)
      .get("/__test-ip")
      .set("X-Forwarded-For", "198.51.100.9, 203.0.113.7");
    // The production 404 prevents arbitrary routes; use a standalone fixture with identical trust setting.
    expect(r.status).toBe(404);
    const express = (await import("express")).default,
      fixture = express();
    fixture.set("trust proxy", trustProxy());
    fixture.get("/", (req, res) => res.json({ ip: req.ip }));
    expect(
      (
        await request(fixture)
          .get("/")
          .set("X-Forwarded-For", "198.51.100.9, 203.0.113.7")
      ).body.ip,
    ).toBe("203.0.113.7");
  });
});
describe("durable heartbeat, backup metadata and admin readiness", () => {
  it("does not accept optional-agent access when an installed MFA table is unavailable", async () => {
    db.rpc.mockResolvedValueOnce({ error: { code: "42P01" } });
    const result = await request(app)
      .get("/api/me")
      .set("Authorization", "Bearer agent");
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("MFA_DATABASE_UPDATE");
  });
  it("requires admin/active identity and denies browser SQL access", async () => {
    expect((await request(app).get("/api/health/ready")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/health/status")
          .set("Authorization", "Bearer agent")
      ).status,
    ).toBe(403);
    await expect(
      rpc("system_status", { p_actor: agent }),
    ).rejects.toMatchObject({ code: "42501" });
    await pg.query("update profiles set active=false where id=$1", [admin]);
    expect(
      (
        await request(app)
          .get("/api/health/ready")
          .set("Authorization", "Bearer admin")
      ).status,
    ).toBe(403);
    for (const name of ["job_heartbeats", "backups", "crm_schema_versions"])
      expect(
        (
          await one(
            "select has_table_privilege('authenticated',$1,'select') allowed",
            ["public." + name],
          )
        ).allowed,
      ).toBe(false);
    expect(
      (
        await one(
          "select bool_or(has_function_privilege('authenticated',oid,'execute')) allowed from pg_proc where proname in('record_job_heartbeat','record_backup','system_status')",
        )
      ).allowed,
    ).toBe(false);
  });
  it("reports all missing jobs and no invented backup", async () => {
    const r = await request(app)
      .get("/api/health/ready")
      .set("Authorization", "Bearer admin");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({
      ready: false,
      installed_version: 26,
      database: "reachable",
      last_job_at: null,
      backup: { last_success_at: null, status: "not_started" },
    });
    expect(r.body.jobs).toHaveLength(systemJobs.length);
    expect(r.body.jobs.every((j) => j.status === "not_started")).toBe(true);
  });
  it("requires every expected job to be fresh and recovered", async () => {
    for (const job of systemJobs)
      await rpc("record_job_heartbeat", { p_job: job, p_success: true });
    expect(
      (
        await request(app)
          .get("/api/health/ready")
          .set("Authorization", "Bearer admin")
      ).status,
    ).toBe(200);
    await rpc("record_job_heartbeat", {
      p_job: systemJobs[0],
      p_success: false,
    });
    let state = await rpc("system_status", { p_actor: admin });
    expect(state.ready).toBe(false);
    expect(state.jobs[0].last_success_at).not.toBeNull();
    await rpc("record_job_heartbeat", {
      p_job: systemJobs[0],
      p_success: true,
    });
    expect((await rpc("system_status", { p_actor: admin })).ready).toBe(true);
    await pg.query(
      "update job_heartbeats set last_run_at=now()-interval '6 minutes' where job=$1",
      [systemJobs[0]],
    );
    state = await rpc("system_status", { p_actor: admin });
    expect(state.ready).toBe(false);
    expect(state.jobs.find((job) => job.job === systemJobs[0]).status).toBe(
      "stale",
    );
    await pg.exec("update crm_schema_versions set version=25");
    expect((await rpc("system_status", { p_actor: admin })).migration).toBe(
      "update_required",
    );
  });
  it("records only safe backup metadata and preserves last success after failure", async () => {
    const filename = "hd-crm-fixture.dump.age";
    await rpc("record_backup", {
      p_filename: filename,
      p_success: true,
      p_bytes: 42,
      p_sha256: "a".repeat(64),
    });
    await rpc("record_backup", {
      p_filename: filename,
      p_success: false,
      p_bytes: 0,
      p_sha256: null,
    });
    const state = await rpc("system_status", { p_actor: admin });
    expect(state.backup).toMatchObject({ status: "failed" });
    expect(state.backup.last_success_at).not.toBeNull();
    expect(JSON.stringify(state)).not.toContain(filename);
    await expect(
      rpc("record_backup", {
        p_filename: "../private-url",
        p_success: true,
        p_bytes: 0,
        p_sha256: null,
      }),
    ).rejects.toBeDefined();
  });
  it("reports missing update or database outage without raw secrets", async () => {
    db.rpc.mockResolvedValueOnce({
      error: { code: "PGRST202", message: "private-token" },
    });
    let r = await request(app)
      .get("/api/health/ready")
      .set("Authorization", "Bearer admin");
    expect(r.status).toBe(503);
    expect(r.body.message).toContain("026 after 025");
    expect(JSON.stringify(r.body)).not.toContain("private-token");
    db.rpc.mockRejectedValueOnce(new Error("private-db-url"));
    r = await request(app)
      .get("/api/health/status")
      .set("Authorization", "Bearer admin");
    expect(r.status).toBe(200);
    expect(r.body.database).toBe("unavailable");
    expect(JSON.stringify(r.body)).not.toContain("private-db");
  });
  it("continues other jobs when execution or heartbeat persistence fails, without logging secrets", async () => {
    const jobs = [
      [
        "deleteOldRecordings",
        vi.fn().mockRejectedValue(new Error("private-token")),
      ],
      ["processMetaLeads", vi.fn().mockResolvedValue({})],
    ];
    db.rpc.mockResolvedValueOnce({ error: { code: "08006" } });
    const logger = { log: vi.fn(), error: vi.fn() };
    await createJobRunner(db, jobs, logger)();
    expect(jobs[1][1]).toHaveBeenCalledWith(db);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "private-token",
    );
    expect(db.rpc.mock.calls.map(([, a]) => a.p_success)).toEqual([
      false,
      true,
    ]);
  });
  it("does not overlap local ticks and resumes after completion", async () => {
    let resolve;
    const job = vi.fn(() => new Promise((r) => (resolve = r)));
    const tick = createJobRunner(db, [["processMetaLeads", job]], {
      log: () => {},
      error: () => {},
    });
    const pending = tick();
    await tick();
    expect(job).toHaveBeenCalledOnce();
    resolve({});
    await pending;
    const next = tick();
    expect(job).toHaveBeenCalledTimes(2);
    resolve({});
    await next;
  });
});
