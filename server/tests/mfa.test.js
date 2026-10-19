import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
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
import { digest } from "../src/services/accountsSecurity.js";
import {
  mfaVerifyLimit,
  sensitiveLimit,
  apiLimit,
} from "../src/middleware/rateLimit.js";
import { createMfaClient } from "../src/services/mfa.js";
const admin = "e1000000-0000-4000-8000-000000000001",
  other = "e1000000-0000-4000-8000-000000000002",
  agent = "e1000000-0000-4000-8000-000000000003",
  factor = "f1000000-0000-4000-8000-000000000001",
  grant = "fixture-unlock";
let pg, db, app, claims, users, provider, states;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args = {}) =>
  (
    await one(
      `select to_jsonb(public.${name}(${Object.keys(args)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(",")})) value`,
      Object.values(args).map((v) =>
        v !== null && typeof v === "object" ? JSON.stringify(v) : v,
      ),
    )
  ).value;
const headers = (token = "admin1") => ({
  Authorization: "Bearer " + token,
  "X-Accounts-Unlock": grant,
});
function database() {
  return {
    auth: {
      getUser: vi.fn(async (token) => ({
        data: { user: users[token] || null },
      })),
      getClaims: vi.fn(async (token) =>
        claims[token]
          ? { data: { claims: claims[token] } }
          : { error: { code: "invalid_jwt" } },
      ),
      admin: {
        mfa: {
          listFactors: vi.fn(async ({ userId }) => ({
            data: { factors: states[userId] || [] },
          })),
          deleteFactor: vi.fn(async ({ userId, id }) => {
            states[userId] = states[userId].filter((f) => f.id !== id);
            for (const user of Object.values(users))
              if (user.id === userId) user.factors = states[userId];
            return { data: {} };
          }),
        },
      },
    },
    rpc: vi.fn(async (name, args) => {
      try {
        return { data: await rpc(name, args) };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }),
    from(table) {
      let filters = [],
        fields = "*";
      const q = {
        select(value) {
          fields = value;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        async single() {
          return {
            data: await one(
              `select ${fields} from public.${table} where ${filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ")}`,
              filters.map(([, v]) => v),
            ),
          };
        },
      };
      return q;
    },
  };
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(f, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 30000);
afterAll(() => pg?.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  for (const limiter of [mfaVerifyLimit, sensitiveLimit, apiLimit])
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1"]) limiter.resetKey(ip);
  await pg.exec("truncate auth.users cascade");
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'second@example.test',now()),($3,'agent@example.test',now())",
    [admin, other, agent],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'agent' else 'admin' end",
    [agent],
  );
  vi.stubEnv("REQUIRE_AGENT_MFA", "false");
  const native = {
    id: factor,
    factor_type: "totp",
    status: "verified",
    friendly_name: "Authenticator",
  };
  states = { [admin]: [native], [other]: [native], [agent]: [] };
  users = {
    admin1: {
      id: admin,
      email_confirmed_at: "2026-10-14T00:00:00Z",
      factors: states[admin],
    },
    admin2: {
      id: admin,
      email_confirmed_at: "2026-10-14T00:00:00Z",
      factors: states[admin],
    },
    other2: {
      id: other,
      email_confirmed_at: "2026-10-14T00:00:00Z",
      factors: states[other],
    },
    agent1: {
      id: agent,
      email_confirmed_at: "2026-10-14T00:00:00Z",
      factors: [],
    },
  };
  const now = Math.floor(Date.now() / 1000);
  claims = {
    admin1: {
      sub: admin,
      aal: "aal1",
      iat: now,
      amr: [{ method: "password", timestamp: now }],
    },
    admin2: {
      sub: admin,
      aal: "aal2",
      iat: now,
      amr: [{ method: "totp", timestamp: now }],
    },
    other2: {
      sub: other,
      aal: "aal2",
      iat: now,
      amr: [{ method: "totp", timestamp: now }],
    },
    agent1: {
      sub: agent,
      aal: "aal1",
      iat: now,
      amr: [{ method: "password", timestamp: now }],
    },
  };
  db = database();
  provider = {
    auth: {
      mfa: {
        challenge: vi.fn(async () => ({ data: { id: randomUUID() } })),
        verify: vi.fn(async () => ({
          data: { access_token: "admin2", refresh_token: "private-refresh" },
        })),
      },
    },
  };
  app = createApp(db, { createMfaClient: () => provider });
  await rpc("save_accounts_pin", {
    p_actor: other,
    p_hash: "fixture-" + "x".repeat(80),
    p_request: "fixture",
  });
  const pin = await one(
    "select version from account_security where admin_id=$1",
    [other],
  );
  await rpc("unlock_accounts", {
    p_actor: other,
    p_session: digest("Bearer other2"),
    p_version: pin.version,
    p_valid: true,
    p_token: digest(grant),
    p_request: "fixture",
  });
});
describe("administrator email/password login", () => {
  it.each([true, false])(
    "allows password-only admins with enrolled factors=%s without consulting MFA storage",
    async (enrolled) => {
      users.admin1.factors = enrolled ? states[admin] : [];
      const me = await request(app).get("/api/me?portal=admin").set(headers());
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        id: admin,
        role: "admin",
        active: true,
        mfa_required: false,
        mfa_enrolled: enrolled,
        mfa_reset_pending: false,
      });
      expect(
        (await request(app).get("/api/call-capabilities").set(headers()))
          .status,
      ).toBe(200);
      expect(db.rpc).not.toHaveBeenCalled();
      expect(provider.auth.mfa.verify).not.toHaveBeenCalled();
    },
  );
  it.each(["pending", "failed", "complete"])(
    "does not force admin MFA from a historical %s reset",
    async (status) => {
      await pg.query(
        "insert into crm_private.mfa_resets(user_id,actor_id,status) values($1,$2,$3)",
        [admin, other, status],
      );
      const result = await request(app)
        .get("/api/me?portal=admin")
        .set(headers());
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        mfa_required: false,
        mfa_reset_pending: false,
      });
      expect(db.rpc).not.toHaveBeenCalled();
    },
  );
  it("supports admin and optional unenrolled agent login with a genuine database through 024", async () => {
    await pg.exec(
      "drop function public.mfa_session_state(uuid); drop function public.mfa_begin_attempt(uuid,text); drop function public.mfa_finish_attempt(uuid,uuid,text,text); drop function public.mfa_reset_begin(uuid,text,text,uuid,text); drop function public.mfa_reset_finish(uuid,uuid,uuid,boolean,text); drop table crm_private.mfa_attempts,crm_private.mfa_resets;",
    );
    try {
      for (const token of ["admin1", "agent1"]) {
        const result = await request(app).get("/api/me").set(headers(token));
        expect(result.status).toBe(200);
        expect(result.body.mfa_required).toBe(false);
        expect(
          (await request(app).get("/api/call-capabilities").set(headers(token)))
            .status,
        ).toBe(200);
      }
      vi.stubEnv("REQUIRE_AGENT_MFA", "true");
      expect(
        (await request(app).get("/api/me").set(headers("agent1"))).body.code,
      ).toBe("MFA_DATABASE_UPDATE");
    } finally {
      await pg.exec(
        await readFile(
          new URL(
            "../../supabase/migrations/025_admin_totp_mfa.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    }
  });
  it("does not impose the agent MFA setting on administrators", async () => {
    for (const value of ["true", "typo"]) {
      vi.stubEnv("REQUIRE_AGENT_MFA", value);
      const result = await request(app).get("/api/me").set(headers());
      expect(result.status).toBe(200);
      expect(result.body.mfa_required).toBe(false);
    }
  });
  it("refuses obsolete admin verification and factor-reset actions without native calls", async () => {
    const verify = await request(app)
      .post("/api/mfa/verify")
      .set(headers())
      .send({ factor_id: factor, code: "123456" });
    expect(verify.status).toBe(400);
    expect(verify.body.code).toBe("MFA_NOT_REQUIRED");
    const reset = await request(app)
      .post("/api/accounts/" + admin + "/mfa-reset")
      .set(headers("other2"))
      .send({ confirm: true });
    expect(reset.status).toBe(400);
    expect(reset.body.code).toBe("MFA_NOT_REQUIRED");
    expect(provider.auth.mfa.challenge).not.toHaveBeenCalled();
    expect(db.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });
  it("still requires a valid Accounts PIN for a password-only admin", async () => {
    claims.other2 = { ...claims.other2, aal: "aal1", amr: [] };
    const result = await request(app)
      .post("/api/accounts/" + agent + "/mfa-reset")
      .set({ Authorization: "Bearer other2" })
      .send({ confirm: true });
    expect(result.status).toBe(423);
    expect(db.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });
});
describe("optional-agent verified assurance and CRM access", () => {
  beforeEach(async () => {
    await pg.query("update profiles set role='agent' where id=$1", [admin]);
  });
  it.each([
    "/api/users",
    "/api/audit",
    "/api/accounts",
    "/api/account-security",
    "/api/leads",
    "/api/integrations/meta/settings",
    "/api/integrations/meta/summary",
    "/api/call-capabilities",
    "/api/security-alerts",
  ])(
    "blocks an opted-in agent before protected handlers at %s",
    async (path) => {
      const r = await request(app).get(path).set(headers());
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("mfa_required");
      expect(
        db.rpc.mock.calls.every(([name]) => name === "mfa_session_state"),
      ).toBe(true);
    },
  );
  it("allows only profile bootstrap and MFA verification before assurance upgrade", async () => {
    const me = await request(app).get("/api/me?portal=agent").set(headers());
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: admin,
      role: "agent",
      mfa_required: true,
      mfa_enrolled: true,
    });
    expect(
      (await request(app).post("/api/me").set(headers()).send({})).body.code,
    ).toBe("mfa_required");
    const r = await request(app)
      .post("/api/mfa/verify")
      .set(headers())
      .send({ factor_id: factor, code: "123456" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      access_token: "admin2",
      refresh_token: "private-refresh",
    });
    expect(
      (await request(app).get("/api/me").set(headers("admin2"))).body
        .mfa_required,
    ).toBe(false);
  });
  it("blocks absent/forged assurance despite a valid password identity", async () => {
    delete claims.admin1;
    const r = await request(app).get("/api/me").set(headers());
    expect(r.status).toBe(401);
    expect(provider.auth.mfa.verify).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("does not trust an AAL2 string in body/header or a mismatched verified subject", async () => {
    claims.admin1 = { ...claims.admin1, sub: other, aal: "aal2" };
    expect(
      (
        await request(app)
          .get("/api/me")
          .set({ ...headers(), "X-AAL": "aal2" })
      ).status,
    ).toBe(401);
    claims.admin1 = { sub: admin, aal: "aal1" };
    expect(
      (
        await request(app)
          .post("/api/leads")
          .set(headers())
          .send({ aal: "aal2" })
      ).body.code,
    ).toBe("mfa_required");
  });
  it("requires enrollment for a required agent when a stale AAL2 token has no verified TOTP factor", async () => {
    vi.stubEnv("REQUIRE_AGENT_MFA", "true");
    users.admin2.factors = [];
    const r = await request(app).get("/api/me").set(headers("admin2"));
    expect(r.body).toMatchObject({ mfa_required: true, mfa_enrolled: false });
  });
  it("keeps inactive/unconfirmed and wrong portal access checks ahead of MFA", async () => {
    users.admin1.email_confirmed_at = null;
    expect((await request(app).get("/api/me").set(headers())).body.code).toBe(
      "EMAIL_CONFIRMATION_REQUIRED",
    );
    users.admin1.email_confirmed_at = "2026-10-14";
    await pg.query("update profiles set active=false where id=$1", [admin]);
    expect((await request(app).get("/api/me").set(headers())).status).toBe(403);
    await pg.query("update profiles set active=true where id=$1", [admin]);
    const wrong = await request(app).get("/api/me?portal=admin").set(headers());
    expect(wrong.status).toBe(403);
    expect(wrong.body).not.toHaveProperty("mfa_enrolled");
  });
  it("allows ordinary agents by default and requires them under the explicit setting or enrolled factor", async () => {
    expect(
      (await request(app).get("/api/me").set(headers("agent1"))).body
        .mfa_required,
    ).toBe(false);
    expect(
      (await request(app).get("/api/call-capabilities").set(headers("agent1")))
        .status,
    ).toBe(200);
    vi.stubEnv("REQUIRE_AGENT_MFA", "true");
    expect(
      (await request(app).get("/api/call-capabilities").set(headers("agent1")))
        .body.code,
    ).toBe("mfa_required");
    vi.stubEnv("REQUIRE_AGENT_MFA", "false");
    users.agent1.factors = [
      { id: factor, factor_type: "totp", status: "verified" },
    ];
    expect(
      (await request(app).get("/api/call-capabilities").set(headers("agent1")))
        .body.code,
    ).toBe("mfa_required");
  });
  it("fails closed when agent MFA needs a missing migration/state or invalid policy", async () => {
    db.rpc.mockResolvedValueOnce({ error: { code: "42883" } });
    const r = await request(app).get("/api/me").set(headers());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("MFA_DATABASE_UPDATE");
    expect(r.body.error).toContain("025 after 024");
    db.rpc.mockResolvedValueOnce({ data: {} });
    expect((await request(app).get("/api/me").set(headers())).status).toBe(503);
    vi.stubEnv("REQUIRE_AGENT_MFA", "typo");
    expect(
      (await request(app).get("/api/me").set(headers("agent1"))).status,
    ).toBe(503);
  });
});
describe("authoritative agent MFA verification, retries and alerts", () => {
  beforeEach(async () => {
    await pg.query("update profiles set role='agent' where id=$1", [admin]);
  });
  it("rejects malformed codes and forged factor/user fields before native verification", async () => {
    for (const body of [
      { factor_id: factor, code: "12345" },
      { factor_id: factor, code: "abcdef" },
      { factor_id: factor, code: "123456", actor_id: other },
    ])
      expect(
        (await request(app).post("/api/mfa/verify").set(headers()).send(body))
          .status,
      ).toBe(400);
    expect(provider.auth.mfa.verify).not.toHaveBeenCalled();
    expect(
      (await one("select count(*)::int n from crm_private.mfa_attempts")).n,
    ).toBe(0);
  });
  it("audits five native rejections, emits one safe alert and rate-limits further attempts across sessions", async () => {
    provider.auth.mfa.verify.mockResolvedValue({
      error: { code: "mfa_verification_failed", message: "secret-123456" },
    });
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post("/api/mfa/verify")
            .set(headers())
            .send({ factor_id: factor, code: "123456" })
        ).status,
      ).toBe(400);
    const blocked = await request(app)
      .post("/api/mfa/verify")
      .set(headers())
      .send({ factor_id: factor, code: "654321" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(provider.auth.mfa.verify).toHaveBeenCalledTimes(5);
    const a = await one(
      "select * from security_alerts where type='mfa_verification_failures'",
    );
    expect(a).toMatchObject({ user_id: admin, severity: "critical" });
    const audit = await one(
      "select count(*)::int n from audit_log where action='auth.mfa_failed'",
    );
    expect(audit.n).toBe(5);
    expect(
      JSON.stringify((await pg.query("select metadata from audit_log")).rows),
    ).not.toContain("123456");
    expect(JSON.stringify(a)).not.toContain("secret-123456");
    await pg.query(
      "update crm_private.mfa_attempts set created_at=now()-interval '16 minutes'",
    );
    expect(
      (
        await request(app)
          .post("/api/mfa/verify")
          .set(headers())
          .send({ factor_id: factor, code: "123456" })
      ).status,
    ).toBe(400);
  });
  it("does not mistake provider/network outages for wrong codes or return raw provider details", async () => {
    for (const code of ["unexpected_failure", "mfa_totp_verify_disabled"]) {
      provider.auth.mfa.challenge.mockResolvedValue({
        error: { code, message: "private provider token" },
      });
      const r = await request(app)
        .post("/api/mfa/verify")
        .set(headers())
        .send({ factor_id: factor, code: "123456" });
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.body)).not.toContain("private provider");
    }
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.mfa_attempts where result='unavailable'",
        )
      ).n,
    ).toBe(2);
    expect((await one("select count(*)::int n from security_alerts")).n).toBe(
      0,
    );
  });
  it("does not install/release unverifiable, wrong-user or password-only returned sessions", async () => {
    for (const session of [
      { access_token: "unknown", refresh_token: "private" },
      { access_token: "agent1", refresh_token: "private" },
      { access_token: "admin1", refresh_token: "private" },
    ]) {
      provider.auth.mfa.verify.mockResolvedValue({ data: session });
      const r = await request(app)
        .post("/api/mfa/verify")
        .set(headers())
        .send({ factor_id: factor, code: "123456" });
      expect(r.status).toBe(503);
      expect(r.body).not.toHaveProperty("access_token");
    }
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.mfa_attempts where result='verified'",
        )
      ).n,
    ).toBe(0);
  });
  it("cannot fake success by posting a result or bypass verification with wrong actor identity", async () => {
    const start = await rpc("mfa_begin_attempt", {
      p_actor: admin,
      p_request: "fixture",
    });
    await expect(
      rpc("mfa_finish_attempt", {
        p_actor: agent,
        p_attempt: start.attempt_id,
        p_result: "verified",
        p_request: "fixture",
      }),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(
      (
        await request(app)
          .post("/api/mfa/verify")
          .set(headers())
          .send({ factor_id: factor, code: "123456", result: "verified" })
      ).status,
    ).toBe(400);
  });
  it("reserves an attempt durably before contacting the provider and refuses on audit failure", async () => {
    db.rpc
      .mockImplementationOnce(async () => ({
        data: { reset_pending: false, reset_after: null },
      }))
      .mockImplementationOnce(async () => ({ error: { code: "08006" } }));
    const r = await request(app)
      .post("/api/mfa/verify")
      .set(headers())
      .send({ factor_id: factor, code: "123456" });
    expect(r.status).toBe(503);
    expect(provider.auth.mfa.challenge).not.toHaveBeenCalled();
  });
  it("uses the real installed SDK without shared Auth-session mutation or a service-role user identity", async () => {
    vi.stubEnv("SUPABASE_URL", "https://project.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "private-service-key");
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith("/challenge"))
          return new Response(JSON.stringify({ id: factor, type: "totp" }));
        return new Response(
          JSON.stringify({
            access_token: "new-aal2",
            refresh_token: "new-refresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: admin },
          }),
        );
      }),
    );
    const a = createMfaClient("user-token-a"),
      b = createMfaClient("user-token-b");
    expect((await a.auth.mfa.challenge({ factorId: factor })).error).toBeNull();
    expect(
      (
        await b.auth.mfa.verify({
          factorId: factor,
          challengeId: factor,
          code: "123456",
        })
      ).error,
    ).toBeNull();
    expect(new Headers(calls[0].options.headers).get("Authorization")).toBe(
      "Bearer user-token-a",
    );
    expect(new Headers(calls[1].options.headers).get("Authorization")).toBe(
      "Bearer user-token-b",
    );
    expect(new Headers(calls[0].options.headers).get("apikey")).toBe(
      "private-service-key",
    );
    expect((await a.auth.getSession()).data.session).toBeNull();
  });
});
describe("PIN-protected optional-agent MFA reset", () => {
  beforeEach(async () => {
    await pg.query("update profiles set role='agent' where id=$1", [admin]);
  });
  it("refuses agents, administrator targets and missing-PIN reset requests", async () => {
    for (const [token, id, status] of [
      ["admin1", other, 403],
      ["agent1", admin, 403],
      ["other2", other, 400],
    ])
      expect(
        (
          await request(app)
            .post("/api/accounts/" + id + "/mfa-reset")
            .set(headers(token))
            .send({ confirm: true })
        ).status,
      ).toBe(status);
    expect(
      (
        await request(app)
          .post("/api/accounts/" + admin + "/mfa-reset")
          .set({ Authorization: "Bearer other2" })
          .send({ confirm: true })
      ).status,
    ).toBe(423);
    expect(db.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });
  it("removes agent factors, invalidates old tokens, and preserves customer ownership/roles", async () => {
    await pg.query(
      "insert into leads(name,masked_phone,assigned_agent) values('Buyer','+92******123',$1)",
      [agent],
    );
    const r = await request(app)
      .post("/api/accounts/" + admin + "/mfa-reset")
      .set(headers("other2"))
      .send({ confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.reset).toBe(true);
    expect(db.auth.admin.mfa.deleteFactor).toHaveBeenCalledWith({
      userId: admin,
      id: factor,
    });
    expect(
      (await request(app).get("/api/call-capabilities").set(headers("admin2")))
        .body.code,
    ).toBe("mfa_required");
    expect(
      (await request(app).get("/api/me").set(headers("admin1"))).body,
    ).toMatchObject({
      mfa_required: true,
      mfa_enrolled: false,
      mfa_reset_pending: false,
    });
    expect(
      await one("select role,active from profiles where id=$1", [admin]),
    ).toEqual({ role: "agent", active: true });
    expect((await one("select assigned_agent from leads")).assigned_agent).toBe(
      agent,
    );
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='account.mfa_reset_completed'",
        )
      ).n,
    ).toBe(1);
  });
  it("blocks stale signed AAL2 even after a replacement factor is enrolled, then admits a fresh verified session", async () => {
    await request(app)
      .post("/api/accounts/" + admin + "/mfa-reset")
      .set(headers("other2"))
      .send({ confirm: true });
    const reset = await rpc("mfa_session_state", { p_actor: admin });
    users.admin2.factors = [
      { id: randomUUID(), factor_type: "totp", status: "verified" },
    ];
    claims.admin2.amr = [{ method: "totp", timestamp: reset.reset_after - 1 }];
    expect(
      (await request(app).get("/api/call-capabilities").set(headers("admin2")))
        .body.code,
    ).toBe("mfa_required");
    claims.admin2.amr = [
      { method: "mfa/totp", timestamp: reset.reset_after + 1 },
    ];
    claims.admin2.iat = reset.reset_after + 1;
    expect(
      (await request(app).get("/api/me").set(headers("admin2"))).body
        .mfa_required,
    ).toBe(false);
  });
  it("retains blocked recoverable state on partial provider deletion failure, then retries safely", async () => {
    db.auth.admin.mfa.deleteFactor.mockResolvedValueOnce({
      error: { code: "provider_fail", message: "private Auth response" },
    });
    const r = await request(app)
      .post("/api/accounts/" + admin + "/mfa-reset")
      .set(headers("other2"))
      .send({ confirm: true });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("private Auth");
    expect(
      (await one("select status from crm_private.mfa_resets")).status,
    ).toBe("failed");
    expect(
      (await request(app).get("/api/me").set(headers("admin2"))).body
        .mfa_reset_pending,
    ).toBe(true);
    expect(
      (
        await request(app)
          .post("/api/mfa/verify")
          .set(headers())
          .send({ factor_id: factor, code: "123456" })
      ).status,
    ).toBe(503);
    expect(
      (
        await request(app)
          .post("/api/accounts/" + admin + "/mfa-reset")
          .set(headers("other2"))
          .send({ confirm: true })
      ).status,
    ).toBe(200);
  });
  it("serializes concurrent resets and makes an abandoned operation recoverable without old completion overwrite", async () => {
    const args = {
      p_actor: other,
      p_target: admin,
      p_session: digest("Bearer other2"),
      p_unlock: digest(grant),
      p_request: "fixture",
    };
    const operation = await rpc("mfa_reset_begin", args);
    await expect(rpc("mfa_reset_begin", args)).rejects.toMatchObject({
      code: "40001",
    });
    await pg.query(
      "update crm_private.mfa_resets set started_at=now()-interval '6 minutes'",
    );
    const newer = await rpc("mfa_reset_begin", args);
    await expect(
      rpc("mfa_reset_finish", {
        p_actor: other,
        p_target: admin,
        p_operation: operation,
        p_success: true,
        p_request: "fixture",
      }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(newer).not.toBe(operation);
  });
  it("does not run provider factor deletion when the durable reset/audit transaction fails", async () => {
    db.rpc.mockImplementation(async (name, args) =>
      name === "mfa_reset_begin"
        ? { error: { code: "08006" } }
        : { data: await rpc(name, args) },
    );
    const r = await request(app)
      .post("/api/accounts/" + admin + "/mfa-reset")
      .set(headers("other2"))
      .send({ confirm: true });
    expect(r.status).toBe(503);
    expect(db.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });
  it("denies browser access to attempt/reset records and every privileged MFA SQL function", async () => {
    expect(
      (
        await one(
          "select has_table_privilege('authenticated','crm_private.mfa_attempts','select') permitted",
        )
      ).permitted,
    ).toBe(false);
    expect(
      (
        await one(
          "select has_table_privilege('authenticated','crm_private.mfa_resets','select') permitted",
        )
      ).permitted,
    ).toBe(false);
    const functions = (
      await pg.query(
        "select proname,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where pronamespace='public'::regnamespace and proname like 'mfa_%'",
      )
    ).rows;
    expect(functions).toHaveLength(5);
    expect(functions.every((f) => !f.allowed)).toBe(true);
  });
});
