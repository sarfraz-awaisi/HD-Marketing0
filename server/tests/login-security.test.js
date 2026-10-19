import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { SIGN_IN_REFUSED, loginLimit } from "../src/routes/auth.routes.js";
const admin = "a7000000-0000-4000-8000-000000000001",
  agent = "a7000000-0000-4000-8000-000000000002";
const passwords = {
  "owner@gmail.com": "owner-password-1234",
  "agent@gmail.com": "agent-password-1234",
};
let pg, db, signIn, env;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const all = async (sql, args = []) => (await pg.query(sql, args)).rows;
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',last_sign_in_at timestamptz);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(f, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 60000);
afterAll(async () => {
  await pg?.close();
});
const pakistanHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Karachi",
    }).format(new Date()),
  );
// Business hours that include (or exclude) the current Pakistan hour.
const hoursIncludingNow = () =>
  `${String(pakistanHour()).padStart(2, "0")}-${String((pakistanHour() + 1) % 24).padStart(2, "0")}`;
const hoursExcludingNow = () =>
  `${String((pakistanHour() + 1) % 24).padStart(2, "0")}-${String((pakistanHour() + 2) % 24).padStart(2, "0")}`;
beforeEach(async () => {
  loginLimit.resetKey("::ffff:127.0.0.1");
  loginLimit.resetKey("127.0.0.1");
  await pg.exec(
    "truncate auth.users cascade;truncate crm_private.login_attempts;",
  );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'agent@gmail.com',now())",
    [admin, agent],
  );
  await pg.query(
    "update profiles set active=true,name=case when id=$1 then 'Owner' else 'Agent One' end,role=case when id=$1 then 'admin' else 'agent' end",
    [admin],
  );
  signIn = vi.fn(async ({ email, password }) => {
    const user = await one("select id,email from auth.users where email=$1", [
      email,
    ]);
    return user && passwords[email] === password
      ? {
          data: {
            session: {
              access_token: "access-" + user.id,
              refresh_token: "refresh-" + user.id,
              expires_in: 3600,
              expires_at: 1,
              token_type: "bearer",
              user,
            },
          },
        }
      : {
          data: { session: null },
          error: { status: 400, code: "invalid_credentials" },
        };
  });
  env = { LOGIN_BUSINESS_HOURS: hoursIncludingNow() };
  db = {
    auth: {
      getUser: async (token) => ({
        data: {
          user: await one(
            "select id,email,email_confirmed_at from auth.users where id::text=$1",
            [token],
          ),
        },
      }),
      admin: { signOut: vi.fn(async () => ({ error: null })) },
    },
    rpc: vi.fn(async (name, args) => {
      try {
        const keys = Object.keys(args);
        const row = await one(
          `select to_jsonb(public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")})) value`,
          Object.values(args),
        );
        return { data: row.value };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }),
    from(table) {
      let fields = "*",
        filters = [];
      const q = {
        select: (f) => ((fields = f), q),
        eq: (k, v) => (filters.push([k, v]), q),
        single: async () => ({
          data: await one(
            `select ${fields} from public.${table} where ${filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ")}`,
            filters.map(([, v]) => v),
          ),
        }),
      };
      return q;
    },
  };
});
const app = () =>
  createApp(trustedMfaFixture(db), {
    createSignInClient: () => ({ auth: { signInWithPassword: signIn } }),
    loginEnv: env,
  });
const login = (email, password, portal = "agent", server = app()) =>
  request(server)
    .post("/api/auth/login")
    .set("User-Agent", "Fixture Browser")
    .send({ email, password, portal });
const outcomes = async () =>
  (await all("select outcome from login_events order by id")).map(
    (r) => r.outcome,
  );
describe("server sign-in with per-account lockout", () => {
  it("returns the Supabase session for a correct password and records success", async () => {
    const r = await login(" Agent@Gmail.com ", passwords["agent@gmail.com"]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      access_token: "access-" + agent,
      refresh_token: "refresh-" + agent,
      user: { id: agent, email: "agent@gmail.com" },
    });
    expect(signIn).toHaveBeenCalledWith({
      email: "agent@gmail.com",
      password: passwords["agent@gmail.com"],
    });
    expect(
      await one(
        "select user_id,email,portal,outcome,user_agent from login_events",
      ),
    ).toEqual({
      user_id: agent,
      email: "agent@gmail.com",
      portal: "agent",
      outcome: "success",
      user_agent: "Fixture Browser",
    });
    expect(
      JSON.stringify(await all("select * from login_events")),
    ).not.toContain(passwords["agent@gmail.com"]);
  });
  it("locks after five wrong passwords and refuses even the correct one", async () => {
    const server = app();
    for (let n = 0; n < 5; n++) {
      const r = await login("agent@gmail.com", "wrong-" + n, "agent", server);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe(SIGN_IN_REFUSED);
    }
    const locked = await login(
      "agent@gmail.com",
      passwords["agent@gmail.com"],
      "agent",
      server,
    );
    expect(locked.status).toBe(401);
    // Same message: an attacker cannot tell a lock from a wrong password.
    expect(locked.body.error).toBe(SIGN_IN_REFUSED);
    // Supabase is not even asked while the account is locked.
    expect(signIn).toHaveBeenCalledTimes(5);
    expect(await outcomes()).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "locked",
    ]);
    expect(
      await all(
        "select type,severity,user_id from security_alerts where type='account_login_locked'",
      ),
    ).toEqual([
      { type: "account_login_locked", severity: "warning", user_id: agent },
    ]);
    // Other accounts are unaffected.
    expect(
      (await login("owner@gmail.com", passwords["owner@gmail.com"], "admin"))
        .status,
    ).toBe(200);
  });
  it("unlocks after the lock period and resets the counter on success", async () => {
    for (let n = 0; n < 5; n++) await login("agent@gmail.com", "wrong");
    await pg.exec(
      "update crm_private.login_attempts set locked_until=now()-interval '1 second'",
    );
    expect(
      (await login("agent@gmail.com", passwords["agent@gmail.com"])).status,
    ).toBe(200);
    expect(
      await one("select count(*)::int n from crm_private.login_attempts"),
    ).toEqual({ n: 0 });
  });
  it("only counts failures inside the 15-minute window", async () => {
    for (let n = 0; n < 4; n++) await login("agent@gmail.com", "wrong");
    await pg.exec(
      "update crm_private.login_attempts set window_started=now()-interval '16 minutes'",
    );
    for (let n = 0; n < 4; n++) await login("agent@gmail.com", "wrong");
    expect(
      await one("select failures,locked_until from crm_private.login_attempts"),
    ).toEqual({ failures: 4, locked_until: null });
    expect(
      (await login("agent@gmail.com", passwords["agent@gmail.com"])).status,
    ).toBe(200);
  });
  it("tracks unknown emails without creating account alerts", async () => {
    for (let n = 0; n < 6; n++)
      expect((await login("nobody@gmail.com", "guess")).status).toBe(401);
    expect(
      await one(
        "select count(*)::int n from login_events where user_id is null and email='nobody@gmail.com'",
      ),
    ).toEqual({ n: 6 });
    expect(await one("select count(*)::int n from security_alerts")).toEqual({
      n: 0,
    });
  });
  it("does not count Supabase outages or its own rate limit as wrong passwords", async () => {
    signIn.mockResolvedValueOnce({ error: { status: 500 } });
    expect((await login("agent@gmail.com", "x")).status).toBe(503);
    signIn.mockRejectedValueOnce(new Error("network"));
    expect((await login("agent@gmail.com", "x")).status).toBe(503);
    signIn.mockResolvedValueOnce({ error: { status: 429 } });
    expect((await login("agent@gmail.com", "x")).status).toBe(429);
    expect(await outcomes()).toEqual([]);
    expect(
      await one("select count(*)::int n from crm_private.login_attempts"),
    ).toEqual({ n: 0 });
  });
  it("discards a new session when a parallel attempt locked the account first", async () => {
    signIn.mockImplementationOnce(async (input) => {
      await pg.exec(
        "insert into crm_private.login_attempts(email,failures,locked_until) values('agent@gmail.com',5,now()+interval '15 minutes')",
      );
      return (await signIn.getMockImplementation()(input)) || {};
    });
    const r = await login("agent@gmail.com", passwords["agent@gmail.com"]);
    expect(r.status).toBe(401);
    expect(db.auth.admin.signOut).toHaveBeenCalledWith("access-" + agent);
  });
  it("revokes the new session when a successful sign-in cannot be recorded", async () => {
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation(async (name, args) =>
      name === "record_login_attempt"
        ? { error: { code: "XX000" } }
        : original(name, args),
    );
    const r = await login("agent@gmail.com", passwords["agent@gmail.com"]);
    expect(r.status).toBe(503);
    expect(r.body).not.toHaveProperty("access_token");
    expect(db.auth.admin.signOut).toHaveBeenCalledWith("access-" + agent);
  });
  it("raises one after-hours alert for a sign-in outside business hours", async () => {
    env = { LOGIN_BUSINESS_HOURS: hoursExcludingNow() };
    expect(
      (await login("agent@gmail.com", passwords["agent@gmail.com"])).status,
    ).toBe(200);
    expect(await all("select type,user_id from security_alerts")).toEqual([
      { type: "after_hours_login", user_id: agent },
    ]);
    env = { LOGIN_BUSINESS_HOURS: hoursIncludingNow() };
    await login("owner@gmail.com", passwords["owner@gmail.com"], "admin");
    expect(await one("select count(*)::int n from security_alerts")).toEqual({
      n: 1,
    });
  });
  it.each([
    [{ email: "agent@gmail.com", password: "x" }, "missing portal"],
    [
      { email: "agent@gmail.com", password: "x", portal: "owner" },
      "invalid portal",
    ],
    [
      {
        email: "agent@gmail.com",
        password: "x",
        portal: "agent",
        role: "admin",
      },
      "extra fields",
    ],
  ])("rejects %j (%s) before any attempt", async (body) => {
    const r = await request(app()).post("/api/auth/login").send(body);
    expect(r.status).toBe(400);
    expect(signIn).not.toHaveBeenCalled();
    expect(await outcomes()).toEqual([]);
  });
  it("reports missing update 037 and bad settings clearly", async () => {
    env = { LOGIN_MAX_ATTEMPTS: "zero" };
    const bad = await login("agent@gmail.com", "x");
    expect(bad.status).toBe(503);
    expect(bad.body.error).toContain("LOGIN_MAX_ATTEMPTS");
    env = {};
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation(async (name, args) =>
      name === "login_attempt_status"
        ? { error: { code: "PGRST202" } }
        : original(name, args),
    );
    const missing = await login("agent@gmail.com", "x");
    expect(missing.status).toBe(503);
    expect(missing.body.error).toContain("037");
    expect(signIn).not.toHaveBeenCalled();
  });
});
describe("admin login history", () => {
  it("lists attempts with account name and UID, filters, and refuses agents", async () => {
    await login("agent@gmail.com", "wrong");
    await login("agent@gmail.com", passwords["agent@gmail.com"]);
    await login("owner@gmail.com", passwords["owner@gmail.com"], "admin");
    const server = app();
    const page = await request(server)
      .get("/api/login-history")
      .set("Authorization", "Bearer " + admin);
    expect(page.status).toBe(200);
    expect(page.body.count).toBe(3);
    expect(page.body.summary).toEqual({ failed_24h: 1, locked_now: 0 });
    const uid = (await one("select uid from profiles where id=$1", [agent]))
      .uid;
    expect(page.body.data.at(-1)).toMatchObject({
      outcome: "failed",
      email: "agent@gmail.com",
      user_name: "Agent One",
      user_uid: uid,
      user_role: "agent",
    });
    const failed = await request(server)
      .get(`/api/login-history?outcome=failed&user=${agent}`)
      .set("Authorization", "Bearer " + admin);
    expect(failed.body.data.map((r) => r.outcome)).toEqual(["failed"]);
    const ranged = await request(server)
      .get(
        `/api/login-history?from=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`,
      )
      .set("Authorization", "Bearer " + admin);
    expect(ranged.body.count).toBe(0);
    expect(
      (
        await request(server)
          .get("/api/login-history")
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .get("/api/login-history?outcome=maybe")
          .set("Authorization", "Bearer " + admin)
      ).status,
    ).toBe(400);
  });
  it("keeps login data out of browser roles", async () => {
    await login("agent@gmail.com", "wrong");
    await pg.exec("set role authenticated");
    try {
      for (const sql of [
        "select * from public.login_events",
        "select * from crm_private.login_attempts",
        `select public.login_attempt_status('agent@gmail.com')`,
      ])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
  });
});
