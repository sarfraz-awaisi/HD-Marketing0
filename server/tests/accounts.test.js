import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
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
import { sensitiveLimit } from "../src/middleware/rateLimit.js";
import {
  digest,
  hashPin,
  matchesPin,
} from "../src/services/accountsSecurity.js";
let pg, admin, other, agent, db, app, stored;
const secret = "isolated-test-pin-pepper-0123456789-abcdefghijklmnopqrstuvwxyz";
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const functions = new Set([
  "prepare_account_creation",
  "account_creation_context",
  "account_creation_list",
  "resend_account_creation",
  "finish_account_creation_email",
  "begin_account_creation",
  "release_account_creation",
  "complete_account_creation",
  "cancel_account_creation",
  "accounts_admin",
  "accounts_gate",
  "save_accounts_pin",
  "unlock_accounts",
  "lock_accounts",
  "accounts_page",
  "account_detail",
  "update_account",
  "account_action",
  "check_account_email",
  "issue_account_invitation",
  "finish_account_invitation",
  "cancel_account_invitation",
  "invitation_context",
  "accept_account_invitation",
  "account_email_code_ready",
  "issue_agent_email_code",
  "finish_agent_email_code",
  "begin_agent_email_code",
  "mark_agent_email_code",
  "release_agent_email_code",
  "complete_agent_email_code",
]);
function database() {
  const credentials = new Map();
  const controls = {
    unbanFailure: false,
    passwordFailure: false,
    auditFailure: false,
    missing: false,
    emailFailure: null,
  };
  return {
    credentials,
    controls,
    auth: {
      getUser: async (token) => {
        const id = token.replace("-new-session", "");
        if (!/^[a-f0-9-]{36}$/i.test(id)) return { data: { user: null } };
        return {
          data: {
            user:
              (await one(
                "select id,email,email_confirmed_at from auth.users where id=$1",
                [id],
              )) || null,
          },
        };
      },
      resend: vi.fn(async () =>
        controls.emailFailure
          ? { error: controls.emailFailure }
          : { data: {}, error: null },
      ),
      resetPasswordForEmail: vi.fn(async () =>
        controls.emailFailure
          ? { error: controls.emailFailure }
          : { data: {}, error: null },
      ),
      admin: {
        inviteUserByEmail: vi.fn(async () =>
          controls.emailFailure
            ? { error: controls.emailFailure }
            : { data: {}, error: null },
        ),
        getUserById: vi.fn(async (id) => ({
          data: {
            user: await one(
              "select id,email,email_confirmed_at from auth.users where id=$1",
              [id],
            ),
          },
        })),
        createUser: vi.fn(async (data) => {
          try {
            const id = randomUUID();
            await pg.query(
              "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,email_confirmed_at,banned_until) values($1,$2,$3::jsonb,$4::jsonb,null,now()+interval '100 years')",
              [
                id,
                data.email,
                JSON.stringify(data.user_metadata),
                JSON.stringify(data.app_metadata),
              ],
            );
            credentials.set(id, data.password);
            return { data: { user: { id, email: data.email } } };
          } catch {
            return { error: { code: "email_exists" } };
          }
        }),
        updateUserById: vi.fn(async (id, data) => {
          if (
            (data.ban_duration && controls.unbanFailure) ||
            (data.password && controls.passwordFailure)
          )
            return { error: { code: "503" } };
          if (data.password) credentials.set(id, data.password);
          if (data.ban_duration)
            await pg.query(
              "update auth.users set banned_until=null where id=$1",
              [id],
            );
          return { data: { user: { id } } };
        }),
      },
    },
    rpc: vi.fn(async (name, args) => {
      if (controls.missing) return { error: { code: "PGRST202" } };
      if (
        controls.auditFailure &&
        ["save_accounts_pin", "update_account", "account_action"].includes(name)
      )
        return { error: { code: "503" } };
      if (!functions.has(name)) throw new Error("Unexpected test RPC");
      const keys = Object.keys(args),
        values = keys.map((key) =>
          args[key] !== null && typeof args[key] === "object"
            ? JSON.stringify(args[key])
            : args[key],
        );
      try {
        return {
          data: (
            await one(
              `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) value`,
              values,
            )
          ).value,
        };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }),
    from(table) {
      if (!["profiles", "account_security"].includes(table))
        throw new Error("Unexpected test table");
      let field,
        value,
        select = "*";
      const run = async () => {
        if (controls.missing && table === "account_security")
          return { error: { code: "42P01" } };
        return {
          data:
            (await one(`select ${select} from ${table} where ${field}=$1`, [
              value,
            ])) || null,
        };
      };
      const q = {
        select: (fields) => {
          select = fields;
          return q;
        },
        eq: (key, v) => {
          field = key;
          value = v;
          return q;
        },
        single: run,
        maybeSingle: run,
      };
      return q;
    },
  };
}
const auth = (id) => ({ Authorization: "Bearer " + id });
const headers = (token, id = admin) => ({
  ...auth(id),
  "X-Accounts-Unlock": token,
});
const grantArgs = (token, id = admin) => ({
  p_actor: id,
  p_session: digest("Bearer " + id),
  p_unlock: digest(token),
});
async function configure(id = admin) {
  await pg.query("select save_accounts_pin($1,$2,$3)", [
    id,
    stored,
    randomUUID(),
  ]);
}
async function unlock(id = admin, pin = "0123") {
  const r = await request(app)
    .post("/api/account-security/unlock")
    .set(auth(id))
    .send({ pin });
  expect(r.status).toBe(200);
  return r.body.token;
}
// Both roles use OTP. Legacy link coverage remains in account-invitations.test.js.
const newAccount = (role = "admin", extra = {}) => ({
  name: "New teammate",
  email: "new@example.com",
  role,
  password: "fixture-pending-password-123",
  active: true,
  ...extra,
});
// Reconstruct a pre-035 pending Auth user to retain historical recovery checks.
// Current no-user-before-OTP creation is tested in account-creation.test.js.
async function legacyCreate(token, data) {
  const args = { ...grantArgs(token), p_request: "legacy-fixture" };
  const checked = await db.rpc("check_account_email", {
    ...args,
    p_email: data.email,
  });
  if (checked.error)
    return { status: 409, body: { error: "Already registered" } };
  const { password, ...old } = data;
  const created = await db.auth.admin.createUser({
    email: old.email,
    email_confirm: false,
    user_metadata: { name: old.name },
    app_metadata: { crm_provisioning: true },
  });
  const id = created.data.user.id;
  const update = await db.rpc("update_account", {
    ...args,
    p_target: id,
    p_data: { name: old.name, role: old.role, active: false },
  });
  if (update.error)
    return { status: 201, body: { id, warning: "Setup interrupted" } };
  await db.rpc("issue_agent_email_code", {
    ...args,
    p_target: id,
    p_hash: digest(randomUUID()),
    p_active: data.active ?? true,
  });
  await pg.query(
    "update account_invitations set requested_at=now()-interval '2 minutes',state='failed' where user_id=$1",
    [id],
  );
  const r = await request(app)
    .post(`/api/accounts/${id}/email-code`)
    .set(headers(token))
    .send({});
  return { status: 201, body: r.body };
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',last_sign_in_at timestamptz,email_confirmed_at timestamptz,banned_until timestamptz);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  stored = await hashPin("0123", secret);
}, 30000);
beforeEach(async () => {
  await pg.exec(
    "drop trigger if exists reject_account_audit on public.audit_log;truncate auth.users cascade;",
  );
  admin = randomUUID();
  other = randomUUID();
  agent = randomUUID();
  for (const [id, role, email] of [
    [admin, "admin", "admin@example.com"],
    [other, "admin", "other@example.com"],
    [agent, "agent", "agent@example.com"],
  ]) {
    await pg.query(
      "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3::jsonb,now())",
      [id, email, JSON.stringify({ name: role + " " + email })],
    );
    await pg.query("update profiles set active=true,role=$2 where id=$1", [
      id,
      role,
    ]);
  }
  sensitiveLimit.resetKey("127.0.0.1");
  sensitiveLimit.resetKey("::ffff:127.0.0.1");
  db = database();
  app = createApp(trustedMfaFixture(db), {
    createEmailOtpClient: () => ({
      auth: {
        resend: db.auth.resend,
        signInWithOtp: db.auth.resend,
        verifyOtp: async ({ email, token }) => {
          if (token !== "123456") return { error: { code: "otp_expired" } };
          const user = (
            await pg.query(
              "update auth.users set email_confirmed_at=now() where email=$1 returning id,email,email_confirmed_at",
              [email],
            )
          ).rows[0];
          return {
            data: {
              user,
              session: { access_token: "synthetic-recipient-session" },
            },
          };
        },
        signOut: async () => ({ error: null }),
      },
    }),
    creationEnv: {
      ACCOUNT_OTP_SECRET: "fixture-creation-secret-abcdefghijklmnopqrstuvwxyz",
    },
    sendAccountCreationEmail: async () => {},
    pinSecret: secret,
    verifyPassword: async (_db, _id, password) =>
      password === "current-fixture-password",
  });
});
afterAll(async () => {
  await pg?.close();
});

describe("PIN-protected account administration", () => {
  it("keeps all sensitive routes behind authentication and the active admin role", async () => {
    for (const [method, path, body] of [
      ["get", "/api/accounts"],
      ["get", "/api/accounts/" + agent],
      ["post", "/api/accounts", newAccount()],
      ["patch", "/api/accounts/" + agent, { role: "admin" }],
      [
        "post",
        "/api/accounts/" + agent + "/password",
        { password: "fixture-password-123" },
      ],
      ["get", "/api/account-security"],
      [
        "put",
        "/api/account-security",
        {
          pin: "0123",
          confirm_pin: "0123",
          password: "current-fixture-password",
        },
      ],
      ["post", "/api/account-security/unlock", { pin: "0123" }],
      ["post", "/api/account-security/lock", {}],
    ]) {
      expect((await request(app)[method](path).send(body)).status).toBe(401);
      expect(
        (await request(app)[method](path).set(auth(agent)).send(body)).status,
      ).toBe(403);
    }
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
  it("requires password reauthentication to set a personal hashed PIN", async () => {
    const body = { pin: "0123", confirm_pin: "0123", password: "wrong" };
    expect(
      (
        await request(app)
          .put("/api/account-security")
          .set(auth(admin))
          .send(body)
      ).status,
    ).toBe(403);
    expect((await one("select count(*)::int n from account_security")).n).toBe(
      0,
    );
    const saved = await request(app)
      .put("/api/account-security")
      .set(auth(admin))
      .send({ ...body, password: "current-fixture-password" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      configured: true,
      updated_at: expect.any(String),
    });
    const row = await one("select * from account_security where admin_id=$1", [
      admin,
    ]);
    expect(row.pin_hash).not.toContain("0123");
    expect(await matchesPin("0123", row.pin_hash, secret)).toBe(true);
    expect(await matchesPin("0123", row.pin_hash, "different-secret")).toBe(
      false,
    );
    const status = await request(app)
      .get("/api/account-security")
      .set(auth(admin));
    expect(status.body.configured).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("pin_hash");
    expect(
      (await request(app).get("/api/account-security").set(auth(other))).body
        .configured,
    ).toBe(false);
  });
  it.each([
    { pin: "123", confirm_pin: "123" },
    { pin: "abcd", confirm_pin: "abcd" },
    { pin: "0123", confirm_pin: "0124" },
    { pin: 1234, confirm_pin: 1234 },
    { pin: "0123", confirm_pin: "0123", admin_id: "spoof" },
  ])("rejects malformed PIN settings %j", async (fields) => {
    expect(
      (
        await request(app)
          .put("/api/account-security")
          .set(auth(admin))
          .send({ password: "current-fixture-password", ...fields })
      ).status,
    ).toBe(400);
  });
  it("requires setup and an unexpired session-bound grant for all account data", async () => {
    expect(
      (
        await request(app)
          .post("/api/account-security/unlock")
          .set(auth(admin))
          .send({ pin: "0123" })
      ).status,
    ).toBe(428);
    expect(
      (await request(app).get("/api/accounts").set(auth(admin))).status,
    ).toBe(423);
    await configure();
    const token = await unlock();
    expect(
      (await request(app).get("/api/accounts").set(headers(token))).status,
    ).toBe(200);
    for (const h of [
      headers("forged"),
      headers(token, other),
      headers(token, admin + "-new-session"),
    ])
      expect((await request(app).get("/api/accounts").set(h)).status).toBe(423);
    await pg.query(
      "update account_unlocks set expires_at=now()-interval '1 second'",
    );
    expect(
      (await request(app).get("/api/accounts").set(headers(token))).status,
    ).toBe(423);
  });
  it("persists the five-failure lockout across API instances and resumes after expiry", async () => {
    await configure();
    for (let i = 1; i <= 5; i++) {
      const r = await request(
        createApp(trustedMfaFixture(db), { pinSecret: secret }),
      )
        .post("/api/account-security/unlock")
        .set(auth(admin))
        .send({ pin: "9999" });
      expect(r.status).toBe(i === 5 ? 429 : 403);
    }
    const locked = await request(app)
      .post("/api/account-security/unlock")
      .set(auth(admin))
      .send({ pin: "0123" });
    expect(locked.status).toBe(429);
    expect(
      (
        await one(
          "select failed_attempts from account_security where admin_id=$1",
          [admin],
        )
      ).failed_attempts,
    ).toBe(5);
    await pg.query(
      "update account_security set locked_until=now()-interval '1 second' where admin_id=$1",
      [admin],
    );
    const token = await unlock();
    expect(
      (await request(app).get("/api/accounts").set(headers(token))).status,
    ).toBe(200);
  }, 20000);
  it("invalidates every personal grant on PIN rotation and supports manual locking", async () => {
    await configure();
    const token = await unlock();
    const oldVersion = (
      await one("select version from account_security where admin_id=$1", [
        admin,
      ])
    ).version;
    await pg.query("select save_accounts_pin($1,$2,$3)", [
      admin,
      await hashPin("0456", secret),
      randomUUID(),
    ]);
    expect(
      (await request(app).get("/api/accounts").set(headers(token))).status,
    ).toBe(423);
    const stale = (
      await one("select unlock_accounts($1,$2,$3,true,$4,$5) value", [
        admin,
        digest("Bearer " + admin),
        oldVersion,
        digest("stale"),
        randomUUID(),
      ])
    ).value;
    expect(stale.status).toBe("changed");
    const fresh = await unlock(admin, "0456");
    expect(
      (
        await request(app)
          .post("/api/account-security/lock")
          .set(headers(fresh))
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get("/api/accounts").set(headers(fresh))).status,
    ).toBe(423);
  });
  it("lists and filters all accounts without passwords, hashes or tokens", async () => {
    await configure();
    const token = await unlock();
    let r = await request(app)
      .get("/api/accounts?limit=1&page=1")
      .set(headers(token));
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.summary).toEqual({
      total: 3,
      admins: 2,
      agents: 1,
      disabled: 0,
      pending: 0,
      expired: 0,
    });
    r = await request(app)
      .get("/api/accounts?search=agent%40example.com&role=agent&access=active")
      .set(headers(token));
    expect(r.body.data[0].id).toBe(agent);
    expect(r.body.count).toBe(1);
    r = await request(app).get("/api/accounts?search=%25_").set(headers(token));
    expect(r.body.count).toBe(0);
    const detail = await request(app)
      .get("/api/accounts/" + agent)
      .set(headers(token));
    expect(detail.status).toBe(200);
    expect(detail.body.email).toBe("agent@example.com");
    expect(detail.body.assigned_leads).toBe(0);
    expect(JSON.stringify(r.body) + JSON.stringify(detail.body)).not.toMatch(
      /password|pin_hash|refresh_token|token_hash|raw_app_meta/,
    );
  });
  it.each(["admin", "agent"])(
    "recovers a historical Auth-backed %s account with safe provisioning",
    async (role) => {
      await configure();
      const token = await unlock();
      const r = await legacyCreate(token, newAccount(role));
      expect(r.status).toBe(201);
      expect(r.body.warning).toBeUndefined();
      const profile = await one("select * from profiles where id=$1", [
        r.body.id,
      ]);
      expect(profile.role).toBe(role);
      expect(profile.active).toBe(false);
      expect(db.auth.admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email_confirm: false,
          app_metadata: { crm_provisioning: true },
        }),
      );
      expect(
        (
          await one("select banned_until from auth.users where id=$1", [
            r.body.id,
          ])
        ).banned_until,
      ).toBeNull();
      expect(db.credentials.get(r.body.id)).toBeUndefined();
      expect(db.auth.admin.createUser.mock.calls[0][0]).not.toHaveProperty(
        "password",
      );
      expect(r.body).toMatchObject({
        email_code_required: true,
        email_code_sent: true,
      });
      expect(
        (
          await one("select email_confirmed_at from auth.users where id=$1", [
            r.body.id,
          ])
        ).email_confirmed_at,
      ).toBeNull();
      expect(db.auth.resend).toHaveBeenCalledWith({
        type: "signup",
        email: newAccount().email,
      });
      expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
      const pending = await request(app).get("/api/me").set(auth(r.body.id));
      expect(pending.status).toBe(403);
      expect(pending.body.code).toBe("EMAIL_CONFIRMATION_REQUIRED");
      // Native confirmation alone must not bypass the completed-enrollment gate.
      await pg.query(
        "update auth.users set email_confirmed_at=now() where id=$1",
        [r.body.id],
      );
      expect(
        (await request(app).get("/api/me").set(auth(r.body.id))).status,
      ).toBe(403);
      const completed = await request(app)
        .post(`/api/accounts/${r.body.id}/email-code/verify`)
        .set(headers(token))
        .send({ code: "123456", password: "recipient-password-123" });
      expect(completed.status).toBe(200);
      expect(
        (await request(app).get("/api/me").set(auth(r.body.id))).body.role,
      ).toBe(role);
      const audits = await pg.query("select metadata from audit_log");
      expect(JSON.stringify(audits.rows)).not.toContain(
        "recipient-password-123",
      );
    },
  );
  it("recovers unfinished creation as an inactive account without duplicate creation", async () => {
    await configure();
    const token = await unlock();
    db.controls.unbanFailure = true;
    const r = await legacyCreate(token, newAccount("admin"));
    expect(r.status).toBe(201);
    expect(r.body.warning).toContain("Check the account list");
    expect(
      await one("select active,role from profiles where id=$1", [r.body.id]),
    ).toEqual({ active: false, role: "admin" });
    expect((await legacyCreate(token, newAccount("admin"))).status).toBe(409);
    db.controls.unbanFailure = false;
    expect(
      (
        await request(app)
          .patch("/api/accounts/" + r.body.id)
          .set(headers(token))
          .send({ active: true })
      ).status,
    ).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [r.body.id]))
        .active,
    ).toBe(false);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    expect(
      (
        await request(app)
          .post(`/api/accounts/${r.body.id}/invitation`)
          .set(headers(token))
          .send({})
      ).body.email_code_sent,
    ).toBe(true);
  });
  it("preserves a safe inactive default when the profile setup fails", async () => {
    await configure();
    const token = await unlock();
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation(async (name, args) =>
      name === "update_account"
        ? { error: { code: "503" } }
        : original(name, args),
    );
    const r = await legacyCreate(token, newAccount("admin"));
    expect(r.status).toBe(201);
    expect(r.body.warning).toBeTruthy();
    expect(
      await one("select active,role from profiles where id=$1", [r.body.id]),
    ).toEqual({ active: false, role: "agent" });
  });
  it("updates roles and access, revokes grants, and closes the old Team mutation bypass", async () => {
    await configure();
    await configure(other);
    const token = await unlock(),
      otherToken = await unlock(other);
    expect(
      (
        await request(app)
          .patch("/api/accounts/" + other)
          .set(headers(token))
          .send({ name: "Updated", role: "agent", active: false })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/accounts").set(headers(otherToken, other)))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/users/" + agent)
          .set(auth(admin))
          .send({ active: false })
      ).status,
    ).toBe(403);
    expect(
      (await one("select active from profiles where id=$1", [agent])).active,
    ).toBe(true);
    for (const body of [{ active: false }, { role: "agent" }])
      expect(
        (
          await request(app)
            .patch("/api/accounts/" + admin)
            .set(headers(token))
            .send(body)
        ).status,
      ).toBe(400);
    expect(
      await one("select role,active from profiles where id=$1", [admin]),
    ).toEqual({ role: "admin", active: true });
  });
  it.each([
    { email: "x@example.com" },
    { role: "owner" },
    { active: "false" },
    { name: " " },
    { password: "hidden" },
    { id: "forged" },
  ])("rejects privileged/malformed account edits %j", async (body) => {
    await configure();
    const token = await unlock();
    expect(
      (
        await request(app)
          .patch("/api/accounts/" + agent)
          .set(headers(token))
          .send(body)
      ).status,
    ).toBe(400);
  });
  it("sets another account's password only after an audited, unlocked request", async () => {
    const payload = { password: "new-private-password-123" };
    expect(
      (
        await request(app)
          .post("/api/accounts/" + agent + "/password")
          .set(auth(admin))
          .send(payload)
      ).status,
    ).toBe(423);
    await configure();
    const token = await unlock();
    expect(
      (
        await request(app)
          .post("/api/accounts/" + admin + "/password")
          .set(headers(token))
          .send(payload)
      ).status,
    ).toBe(400);
    const r = await request(app)
      .post("/api/accounts/" + agent + "/password")
      .set(headers(token))
      .send(payload);
    expect(r.status).toBe(200);
    expect(db.credentials.get(agent)).toBe(payload.password);
    const audits = await pg.query(
      "select action,metadata from audit_log where entity_id=$1 order by id",
      [agent],
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      "set_password_requested",
      "set_password_completed",
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain(payload.password);
    db.controls.auditFailure = true;
    db.auth.admin.updateUserById.mockClear();
    expect(
      (
        await request(app)
          .post("/api/accounts/" + agent + "/password")
          .set(headers(token))
          .send(payload)
      ).status,
    ).toBe(503);
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
  it("rolls back PIN and account updates on audit failure", async () => {
    await configure();
    const token = await unlock(),
      originalVersion = (
        await one("select version from account_security where admin_id=$1", [
          admin,
        ])
      ).version;
    await pg.exec(
      "create or replace function reject_account_test_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$;create trigger reject_account_audit before insert on audit_log for each row execute function reject_account_test_audit();",
    );
    const direct = grantArgs(token);
    expect(
      (
        await db.rpc("update_account", {
          ...direct,
          p_target: agent,
          p_data: { role: "admin", active: false },
          p_request: randomUUID(),
        })
      ).error,
    ).toBeTruthy();
    expect(
      await one("select role,active from profiles where id=$1", [agent]),
    ).toEqual({ role: "agent", active: true });
    expect(
      (
        await db.rpc("save_accounts_pin", {
          p_actor: admin,
          p_hash: await hashPin("9876", secret),
          p_request: randomUUID(),
        })
      ).error,
    ).toBeTruthy();
    expect(
      (
        await one("select version from account_security where admin_id=$1", [
          admin,
        ])
      ).version,
    ).toBe(originalVersion);
    expect((await one("select count(*)::int n from account_unlocks")).n).toBe(
      1,
    );
  });
  it("rechecks role and unlock inside SQL and prevents browser table/RPC access", async () => {
    await configure();
    const token = await unlock();
    await pg.query("update profiles set role='agent' where id=$1", [admin]);
    expect(
      (
        await db.rpc("update_account", {
          ...grantArgs(token),
          p_target: agent,
          p_data: { role: "admin" },
          p_request: randomUUID(),
        })
      ).error.code,
    ).toBe("42501");
    for (const table of ["account_security", "account_unlocks"]) {
      expect(
        (
          await one(
            "select has_table_privilege('authenticated',$1,'select') allowed",
            ["public." + table],
          )
        ).allowed,
      ).toBe(false);
      expect(
        (
          await one("select has_table_privilege('anon',$1,'insert') allowed", [
            "public." + table,
          ])
        ).allowed,
      ).toBe(false);
    }
    for (const name of functions)
      expect(
        (
          await one(
            "select has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where proname=$1",
            [name],
          )
        ).allowed,
      ).toBe(false);
  });
  it("requires migration 016 and ignores ordinary user metadata when provisioning", async () => {
    db.controls.missing = true;
    const r = await request(app).get("/api/account-security").set(auth(admin));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("ACCOUNTS_MIGRATION_REQUIRED");
    expect(r.body.error).toContain("016");
    const id = randomUUID();
    await pg.query(
      "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3::jsonb,now())",
      [
        id,
        "ordinary@example.com",
        JSON.stringify({ role: "admin", crm_provisioning: true }),
      ],
    );
    expect(
      await one("select role,active from profiles where id=$1", [id]),
    ).toEqual({ role: "agent", active: false });
  });
});

describe("owner email confirmation", () => {
  it("keeps a created account pending when mail fails and safely resends to its registered email", async () => {
    await configure();
    const token = await unlock();
    db.controls.emailFailure = {
      message: "private SMTP credentials",
      status: 500,
    };
    const created = await legacyCreate(token, newAccount());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email_code_required: true,
      email_code_sent: false,
    });
    expect(created.body.warning).toContain("SMTP");
    expect(JSON.stringify(created.body)).not.toContain("private SMTP");
    expect(
      (await request(app).get("/api/me").set(auth(created.body.id))).status,
    ).toBe(403);
    db.controls.emailFailure = null;
    db.auth.admin.inviteUserByEmail.mockClear();
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    const retry = await request(app)
      .post(`/api/accounts/${created.body.id}/invitation`)
      .set(headers(token))
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.email_code_sent).toBe(true);
    expect(db.auth.resend.mock.calls.at(-1)[0]).toEqual({
      type: "signup",
      email: newAccount().email,
    });
    expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    const events = (
      await pg.query(
        "select action,entity_id,metadata from audit_log where action like 'account.email_code_%' order by id",
      )
    ).rows;
    expect(events.map((r) => r.action)).toEqual([
      "account.email_code_requested",
      "account.email_code_requested",
      "account.email_code_send_failed",
      "account.email_code_requested",
      "account.email_code_sent",
    ]);
    expect(events.every((r) => r.entity_id === created.body.id)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(newAccount().email);
    expect(JSON.stringify(events)).not.toContain(
      "private-fixture-password-123",
    );
  });
  it("cannot bypass pending status by enabling access, setting a password or spoofing user metadata", async () => {
    await configure();
    const token = await unlock();
    const created = await legacyCreate(
      token,
      newAccount("admin", { active: false }),
    );
    const id = created.body.id;
    expect(created.body.email_code_sent).toBe(true);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    await request(app)
      .patch("/api/accounts/" + id)
      .set(headers(token))
      .send({ active: true });
    await request(app)
      .post("/api/accounts/" + id + "/password")
      .set(headers(token))
      .send({ password: "new-private-password-123" });
    await pg.query(
      'update auth.users set raw_user_meta_data=raw_user_meta_data||\'{"email_verified":true,"email_confirmed_at":"2026-10-13"}\'::jsonb where id=$1',
      [id],
    );
    for (const route of [
      "/api/me",
      "/api/leads",
      "/api/documents",
      "/api/accounts",
      "/api/security-alerts",
      "/api/phone-reveals/status",
    ]) {
      const r = await request(app).get(route).set(auth(id));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("EMAIL_CONFIRMATION_REQUIRED");
    }
    await pg.query(
      "update auth.users set email_confirmed_at=now() where id=$1",
      [id],
    );
    expect((await request(app).get("/api/me").set(auth(id))).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/email-code/verify`)
          .set(headers(token))
          .send({ code: "123456", password: "recipient-password-123" })
      ).status,
    ).toBe(200);
    expect((await request(app).get("/api/me").set(auth(id))).status).toBe(403);
    await request(app)
      .patch("/api/accounts/" + id)
      .set(headers(token))
      .send({ active: false });
    expect((await request(app).get("/api/me").set(auth(id))).status).toBe(403);
  });
  it("requires an admin and matching PIN grant and rejects forged resend fields before sending", async () => {
    await configure();
    const token = await unlock();
    for (const h of [{}, auth(agent), auth(admin), headers("wrong")]) {
      const r = await request(app)
        .post(`/api/accounts/${agent}/verification`)
        .set(h)
        .send({});
      expect([401, 403, 423]).toContain(r.status);
    }
    for (const body of [
      { email: "someone@example.test" },
      { redirectTo: "https://attacker.example.test" },
      { email_confirm: true },
    ])
      expect(
        (
          await request(app)
            .post(`/api/accounts/${agent}/verification`)
            .set(headers(token))
            .send(body)
        ).status,
      ).toBe(400);
    expect(db.auth.resend).not.toHaveBeenCalled();
  });
  it("does not pretend to resend to an already-confirmed or nonexistent account", async () => {
    await configure();
    const token = await unlock();
    expect(
      (
        await request(app)
          .post(`/api/accounts/${agent}/verification`)
          .set(headers(token))
          .send({})
      ).body,
    ).toEqual({ already_confirmed: true, sent: false });
    expect(
      (
        await request(app)
          .post(`/api/accounts/${randomUUID()}/verification`)
          .set(headers(token))
          .send({})
      ).status,
    ).toBe(404);
    expect(db.auth.resend).not.toHaveBeenCalled();
  });
  it("returns a safe rate-limit message for a pending-account resend", async () => {
    await configure();
    const token = await unlock();
    const created = { body: { id: agent } };
    await pg.query(
      "update auth.users set email_confirmed_at=null where id=$1",
      [agent],
    );
    await pg.query("update profiles set active=false where id=$1", [agent]);
    db.controls.emailFailure = { status: 429, message: "private SMTP" };
    const r = await request(app)
      .post(`/api/accounts/${created.body.id}/verification`)
      .set(headers(token))
      .send({});
    expect(r.status).toBe(429);
    expect(r.body.error).toContain("rate-limited");
    expect(r.body.error).not.toContain("private");
  });
  it("does not send if the requested audit cannot commit and reports a missing upgrade", async () => {
    await configure();
    const token = await unlock();
    const created = { body: { id: agent } };
    await pg.query(
      "update auth.users set email_confirmed_at=null where id=$1",
      [agent],
    );
    await pg.query("update profiles set active=false where id=$1", [agent]);
    db.auth.resend.mockClear();
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation((name, args) =>
      name === "account_action" &&
      args.p_action.startsWith("email_confirmation_")
        ? { error: { code: "22023" } }
        : original(name, args),
    );
    const r = await request(app)
      .post(`/api/accounts/${created.body.id}/verification`)
      .set(headers(token))
      .send({});
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("migration 020");
    expect(db.auth.resend).not.toHaveBeenCalled();
  });
  it("reports an accepted email with a warning when completion audit cannot be confirmed", async () => {
    await configure();
    const token = await unlock();
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation((name, args) =>
      name === "finish_agent_email_code"
        ? { error: { code: "503" } }
        : original(name, args),
    );
    const r = await legacyCreate(token, newAccount());
    expect(r.status).toBe(201);
    expect(r.body.email_code_sent).toBe(false);
    expect(r.body.warning).toContain("could not be confirmed");
    expect(db.auth.resend).toHaveBeenCalledTimes(1);
    expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(
      (await one("select active from profiles where id=$1", [r.body.id]))
        .active,
    ).toBe(false);
  });
});
