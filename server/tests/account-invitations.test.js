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
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { digest } from "../src/services/accountsSecurity.js";
import {
  accountEmail,
  checkEmailProvider,
  invitationRedirect,
} from "../src/services/accountInvitations.js";
const admin = "c1000000-0000-4000-8000-000000000001",
  agent = "c1000000-0000-4000-8000-000000000002",
  grant = "fixture-invitation-grant";
let pg, db, app;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args) =>
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
const headers = (actor = admin) => ({
  Authorization: "Bearer " + actor,
  "X-Accounts-Unlock": grant,
});
function database() {
  const db = {
    mailError: null,
    passwordError: false,
    codes: new Map(),
    auth: {
      getUser: async (id) => ({
        data: {
          user: await one(
            "select id,email,email_confirmed_at from auth.users where id::text=$1",
            [id],
          ),
        },
      }),
      resetPasswordForEmail: vi.fn(async () =>
        db.mailError ? { error: db.mailError } : { data: {} },
      ),
      admin: {
        getUserById: async (id) => ({
          data: {
            user: await one(
              "select id,email,email_confirmed_at from auth.users where id=$1",
              [id],
            ),
          },
        }),
        createUser: vi.fn(async (data) => {
          try {
            const id = randomUUID();
            await pg.query(
              "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3::jsonb,$4::jsonb)",
              [
                id,
                data.email,
                JSON.stringify(data.user_metadata),
                JSON.stringify(data.app_metadata),
              ],
            );
            return { data: { user: { id, email: data.email } } };
          } catch (e) {
            return { error: { code: "email_exists" } };
          }
        }),
        inviteUserByEmail: vi.fn(async () =>
          db.mailError ? { error: db.mailError } : { data: {} },
        ),
        updateUserById: vi.fn(async (id, data) =>
          db.passwordError && data.password
            ? { error: { code: "weak_password" } }
            : { data: { user: { id } } },
        ),
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
      let fields = "*",
        filters = [];
      const run = async () => ({
        data: (
          await pg.query(
            `select ${fields} from public.${table}${filters.length ? " where " + filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ") : ""}`,
            filters.map(([, v]) => v),
          )
        ).rows,
      });
      const q = {
        select(f) {
          fields = f;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        async single() {
          const r = await run();
          return { data: r.data[0] };
        },
        async maybeSingle() {
          const r = await run();
          return { data: r.data[0] || null };
        },
      };
      return q;
    },
  };
  let sends = 0;
  const sendCode = async (email) => {
    if (db.mailError) return { error: db.mailError };
    db.codes.set(email, String(100000 + ++sends));
    return { data: { user: null, session: null } };
  };
  db.otp = {
    auth: {
      signInWithOtp: vi.fn(async ({ email }) => {
        // Hosted signup is disabled. Unconfirmed users must use confirmation
        // resend rather than the passwordless endpoint's signup branch.
        if (
          !(
            await one(
              "select email_confirmed_at from auth.users where email=$1",
              [email],
            )
          )?.email_confirmed_at
        )
          return { error: { code: "signup_disabled" } };
        return sendCode(email);
      }),
      resend: vi.fn(async ({ email }) => sendCode(email)),
      verifyOtp: vi.fn(async ({ email, token }) => {
        if (!db.codes.has(email) || db.codes.get(email) !== token)
          return { error: { code: "otp_expired" } };
        db.codes.delete(email);
        const user = (
          await pg.query(
            "update auth.users set email_confirmed_at=now() where email=$1 returning id,email,email_confirmed_at",
            [email],
          )
        ).rows[0];
        return {
          data: { user, session: { access_token: "recipient-only-session" } },
        };
      }),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
  return db;
}
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
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec("truncate auth.users cascade;");
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'agent@example.test',now())",
    [admin, agent],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end",
    [admin],
  );
  await rpc("save_accounts_pin", {
    p_actor: admin,
    p_hash: "fixture-" + "x".repeat(80),
    p_request: "fixture:pin",
  });
  await rpc("unlock_accounts", {
    p_actor: admin,
    p_session: digest("Bearer " + admin),
    p_version: (
      await one("select version from account_security where admin_id=$1", [
        admin,
      ])
    ).version,
    p_valid: true,
    p_token: digest(grant),
    p_request: "fixture:unlock",
  });
  db = database();
  app = createApp(trustedMfaFixture(db), {
    creationEnv: {
      ACCOUNT_OTP_SECRET: "fixture-creation-secret-abcdefghijklmnopqrstuvwxyz",
    },
    sendAccountCreationEmail: async () => {},
    createEmailOtpClient: () => db.otp,
  });
  vi.stubEnv("FRONTEND_URL", "http://localhost:5173");
});
// Historical 033/034 pending Auth users remain recoverable after 035.
async function legacyCodeResponse(role = "agent", extra = {}) {
  const { data } = await db.auth.admin.createUser({
    email: extra.email || "owned+team@example.test",
    email_confirm: false,
    user_metadata: { name: "Invited teammate" },
    app_metadata: { crm_provisioning: true },
  });
  const id = data.user.id;
  const args = {
    p_actor: admin,
    p_session: digest("Bearer " + admin),
    p_unlock: digest(grant),
    p_target: id,
    p_request: "legacy-code",
  };
  await rpc("update_account", {
    ...args,
    p_data: { name: "Invited teammate", role, active: false },
  });
  await rpc("issue_agent_email_code", {
    ...args,
    p_hash: digest(randomUUID()),
    p_active: extra.active ?? true,
  });
  await pg.query(
    "update account_invitations set requested_at=now()-interval '2 minutes',state='failed' where user_id=$1",
    [id],
  );
  return request(app)
    .post(`/api/accounts/${id}/email-code`)
    .set(headers())
    .send({});
}
async function createdCode(role = "agent", extra = {}) {
  const r = await legacyCodeResponse(role, extra);
  expect(r.status).toBe(200);
  return r.body.id;
}
// A pre-034 invitation fixture retains coverage of links already issued before
// the switch. New account creation below exercises only the current OTP route.
async function created(role = "admin", extra = {}) {
  const email = extra.email || "owned+team@example.test";
  const { data } = await db.auth.admin.createUser({
    email,
    email_confirm: false,
    user_metadata: { name: "Invited teammate" },
    app_metadata: { crm_provisioning: true },
  });
  const id = data.user.id;
  const args = {
    p_actor: admin,
    p_session: digest("Bearer " + admin),
    p_unlock: digest(grant),
    p_target: id,
    p_request: "legacy-fixture",
  };
  await rpc("update_account", {
    ...args,
    p_data: { name: "Invited teammate", role, active: false },
  });
  const secret = randomBytes(32).toString("hex");
  await rpc("issue_account_invitation", {
    ...args,
    p_hash: digest(secret),
    p_ttl: 60,
    p_active: extra.active ?? true,
  });
  const result = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo: invitationRedirect(secret),
  });
  await rpc("finish_account_invitation", {
    ...args,
    p_hash: digest(secret),
    p_sent: !result.error,
  });
  return id;
}
const ticket = () =>
  new URL(
    db.auth.admin.inviteUserByEmail.mock.calls.at(-1)[1].redirectTo,
  ).searchParams.get("ticket");
const complete = (id, secret = ticket(), body = {}) =>
  request(app)
    .post("/api/onboarding/complete")
    .set(headers(id))
    .send({ ticket: secret, password: "recipient-only-password-123", ...body });
const verified = (id) =>
  pg.query("update auth.users set email_confirmed_at=now() where id=$1", [id]);
const verifyAgent = (id, body = {}) =>
  request(app)
    .post(`/api/accounts/${id}/email-code/verify`)
    .set(headers())
    .send({
      code: db.codes.get("owned+team@example.test") || "100001",
      password: "initial-agent-password-123",
      ...body,
    });

describe("account codes verified inside Accounts", () => {
  it.each([
    ["agent", "admin"],
    ["admin", "agent"],
  ])(
    "rejects a %s code if the account role changes to %s during native verification",
    async (initial, changed) => {
      const id = await createdCode(initial);
      const nativeVerify = db.otp.auth.verifyOtp.getMockImplementation();
      db.otp.auth.verifyOtp.mockImplementationOnce(async (input) => {
        const response = await nativeVerify(input);
        await pg.query("update profiles set role=$2 where id=$1", [
          id,
          changed,
        ]);
        return response;
      });
      db.auth.admin.updateUserById.mockClear();
      expect((await verifyAgent(id)).status).toBe(400);
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(
        (await one("select active from profiles where id=$1", [id])).active,
      ).toBe(false);
      await pg.exec(
        "update account_invitations set requested_at=now()-interval '2 minutes'",
      );
      expect(
        (
          await request(app)
            .post(`/api/accounts/${id}/email-code`)
            .set(headers())
            .send({})
        ).body,
      ).toMatchObject({ role: changed, email_code_sent: true });
      expect((await verifyAgent(id)).body).toMatchObject({
        role: changed,
        active: true,
      });
    },
  );
  it("explains the default Supabase sender restriction without activating the account", async () => {
    db.mailError = {
      code: "email_address_not_authorized",
      status: 403,
      message: "private provider detail",
    };
    const response = await legacyCodeResponse("admin");
    expect(response.body).toMatchObject({
      role: "admin",
      email_code_required: true,
      email_code_sent: false,
    });
    expect(response.body.warning).toContain("default sender");
    expect(response.body.warning).not.toContain("private provider detail");
    expect(
      (await request(app).get("/api/me").set(headers(response.body.id))).status,
    ).toBe(403);
  });
  it.each(["agent", "admin"])(
    "keeps a new %s inaccessible until native email OTP and password completion",
    async (role) => {
      const id = await createdCode(role);
      expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
      expect(db.auth.resetPasswordForEmail).not.toHaveBeenCalled();
      expect(db.auth.admin.createUser.mock.calls[0][0]).not.toHaveProperty(
        "password",
      );
      expect(db.otp.auth.resend).toHaveBeenCalledWith({
        type: "signup",
        email: "owned+team@example.test",
      });
      expect(db.otp.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(id, {
        ban_duration: "none",
        user_metadata: { crm_email_code: true },
      });
      expect((await request(app).get("/api/me").set(headers(id))).status).toBe(
        403,
      );
      const listing = (await request(app).get("/api/accounts").set(headers()))
        .body;
      expect(listing.data.find((row) => row.id === id)).toMatchObject({
        active: false,
        email_verification_method: "email_otp",
        email_code_verified: false,
      });
      expect(JSON.stringify(listing)).not.toMatch(
        /token_hash|otp_claim|100001|initial-agent-password/,
      );
      expect((await verifyAgent(id)).body).toMatchObject({
        id,
        role,
        active: true,
        email_verified: true,
      });
      expect(db.otp.auth.verifyOtp).toHaveBeenCalledWith({
        email: "owned+team@example.test",
        token: "100001",
        type: "email",
      });
      expect(db.otp.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(id, {
        password: "initial-agent-password-123",
      });
      expect(
        (await request(app).get("/api/me").set(headers(id))).body.role,
      ).toBe(role);
      expect((await verifyAgent(id)).status).toBe(400);
      const audits = JSON.stringify(
        (await pg.query("select * from audit_log")).rows,
      );
      expect(audits).toContain("account.email_code_completed");
      expect(audits).not.toMatch(
        /100001|initial-agent-password|recipient-only-session/,
      );
    },
  );
  it.each(["agent", "admin"])(
    "rejects fake codes for a pending %s and blocks verification after five failures",
    async (role) => {
      const id = await createdCode(role);
      db.auth.admin.updateUserById.mockClear();
      for (let i = 0; i < 5; i++) {
        const result = await verifyAgent(id, { code: "999999" });
        expect(result.status).toBe(400);
        expect(result.body.error).toContain("Wrong verification code");
      }
      expect((await verifyAgent(id)).status).toBe(429);
      expect(db.otp.auth.verifyOtp).toHaveBeenCalledTimes(5);
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(
        (await one("select active from profiles where id=$1", [id])).active,
      ).toBe(false);
    },
  );
  it("preserves leading zeroes when checking a real six-digit code", async () => {
    const id = await createdCode("agent");
    db.codes.set("owned+team@example.test", "001234");
    expect((await verifyAgent(id, { code: "001234" })).status).toBe(200);
    expect(db.otp.auth.verifyOtp).toHaveBeenCalledWith({
      email: "owned+team@example.test",
      token: "001234",
      type: "email",
    });
  });
  it("uses native email OTP without signup when a pending recipient was already confirmed", async () => {
    const id = await createdCode("agent");
    await verified(id);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    const result = await request(app)
      .post(`/api/accounts/${id}/email-code`)
      .set(headers())
      .send({});
    expect(result.body.email_code_sent).toBe(true);
    expect(db.otp.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "owned+team@example.test",
      options: { shouldCreateUser: false },
    });
    expect((await verifyAgent(id)).status).toBe(200);
  });
  it("resends only to the stored account email, invalidates the prior code and preserves disabled intent", async () => {
    const id = await createdCode("agent", { active: false });
    const old = db.codes.get("owned+team@example.test");
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/email-code`)
          .set(headers())
          .send({})
      ).status,
    ).toBe(429);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    const sent = await request(app)
      .post(`/api/accounts/${id}/email-code`)
      .set(headers())
      .send({});
    expect(sent.body).toMatchObject({
      email_code_required: true,
      email_code_sent: true,
    });
    expect((await verifyAgent(id, { code: old })).status).toBe(400);
    expect((await verifyAgent(id)).body).toMatchObject({
      email_verified: true,
      active: false,
    });
    expect((await request(app).get("/api/me").set(headers(id))).status).toBe(
      403,
    );
    expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("rejects expired or cancelled verification before consulting native Auth", async () => {
    const id = await createdCode("agent");
    await pg.exec(
      "update account_invitations set expires_at=now()-interval '1 second'",
    );
    expect((await verifyAgent(id)).status).toBe(400);
    await pg.exec(
      "update account_invitations set expires_at=now()+interval '10 minutes',state='cancelled'",
    );
    expect((await verifyAgent(id)).status).toBe(400);
    expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
  });
  it("keeps mail failures blocked and retries a code rather than sending an invitation", async () => {
    db.mailError = { message: "secret SMTP response", status: 503 };
    const response = await legacyCodeResponse("agent");
    expect(response.body).toMatchObject({
      email_code_required: true,
      email_code_sent: false,
    });
    expect(response.body.warning).toContain("SMTP");
    expect(JSON.stringify(response.body)).not.toContain("secret SMTP response");
    expect((await verifyAgent(response.body.id)).status).toBe(400);
    db.mailError = null;
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    expect(
      (
        await request(app)
          .post(`/api/accounts/${response.body.id}/invitation`)
          .set(headers())
          .send({})
      ).body.email_code_sent,
    ).toBe(true);
    expect((await verifyAgent(response.body.id)).status).toBe(200);
    expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("requires a fresh emailed code after password-save failure and rejects fake or consumed codes during retry", async () => {
    const id = await createdCode("agent");
    db.passwordError = true;
    expect((await verifyAgent(id)).status).toBe(503);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    expect((await request(app).get("/api/me").set(headers(id))).status).toBe(
      403,
    );
    db.passwordError = false;
    expect((await verifyAgent(id, { code: "999999" })).status).toBe(400);
    expect((await verifyAgent(id)).status).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/email-code`)
          .set(headers())
          .send({})
      ).body.email_code_sent,
    ).toBe(true);
    expect((await verifyAgent(id)).status).toBe(200);
    expect(db.otp.auth.verifyOtp).toHaveBeenCalledTimes(2);
  });
  it("does not activate if the final audited SQL transaction fails and safely permits retry", async () => {
    const id = await createdCode("agent");
    await pg.exec(
      "create function fail_code_completion() returns trigger language plpgsql as $$ begin if new.action='account.email_code_completed' then raise exception 'fixture audit failure';end if;return new;end $$;create trigger fail_code_completion before insert on audit_log for each row execute function fail_code_completion();",
    );
    try {
      expect((await verifyAgent(id)).status).toBe(503);
      expect(
        (await one("select active from profiles where id=$1", [id])).active,
      ).toBe(false);
      expect(
        (
          await one("select state from account_invitations where user_id=$1", [
            id,
          ])
        ).state,
      ).toBe("sent");
    } finally {
      await pg.exec(
        "drop trigger fail_code_completion on audit_log;drop function fail_code_completion();",
      );
    }
    expect((await verifyAgent(id, { code: "999999" })).status).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/email-code`)
          .set(headers())
          .send({})
      ).body.email_code_sent,
    ).toBe(true);
    expect((await verifyAgent(id)).status).toBe(200);
    expect(db.otp.auth.verifyOtp).toHaveBeenCalledTimes(2);
  });
  it("rejects another recipient's native session and closes it locally", async () => {
    const id = await createdCode("agent");
    db.otp.auth.verifyOtp.mockResolvedValue({
      data: {
        user: {
          id: agent,
          email: "agent@example.test",
          email_confirmed_at: "2026-10-15",
        },
        session: { access_token: "foreign-session" },
      },
    });
    db.auth.admin.updateUserById.mockClear();
    expect((await verifyAgent(id)).status).toBe(400);
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(db.otp.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
  });
  it("rechecks cancellation while native verification is running", async () => {
    const id = await createdCode("agent");
    const original = db.otp.auth.verifyOtp.getMockImplementation();
    db.otp.auth.verifyOtp.mockImplementation(async (args) => {
      await rpc("cancel_account_invitation", {
        p_actor: admin,
        p_session: digest("Bearer " + admin),
        p_unlock: digest(grant),
        p_target: id,
        p_request: "cancel-during-verification",
      });
      return original(args);
    });
    expect((await verifyAgent(id)).status).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
  });
  it("requires an active admin and current Accounts unlock for both code endpoints", async () => {
    const id = await createdCode("agent");
    for (const h of [
      {},
      headers(agent),
      { Authorization: "Bearer " + admin },
      { ...headers(), "X-Accounts-Unlock": "wrong" },
    ]) {
      for (const [suffix, body] of [
        ["email-code", {}],
        [
          "email-code/verify",
          { code: "100001", password: "initial-agent-password-123" },
        ],
      ])
        expect(
          (
            await request(app)
              .post(`/api/accounts/${id}/${suffix}`)
              .set(h)
              .send(body)
          ).status,
        ).toBeGreaterThanOrEqual(400);
    }
    expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("rejects forged verification fields, malformed codes and weak passwords before native verification", async () => {
    const id = await createdCode("agent");
    // This test sends more PIN-protected requests than one allowance holds.
    app.locals.rateLimiters.accountSecurity.resetKey("user:" + admin);
    for (const body of [
      { code: "12" },
      { code: "1234" },
      { code: "1234567" },
      { code: "abcdef" },
      { code: "１２３４５６" },
      { code: "100001", role: "admin" },
      { code: "100001", active: true },
      { code: "100001", email: "other@example.test" },
      { code: "100001", password: "short" },
    ])
      expect((await verifyAgent(id, body)).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/email-code`)
          .set(headers())
          .send({ email: "other@example.test" })
      ).status,
    ).toBe(400);
    expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("refuses code creation for active agents, administrators and accounts marked for deletion", async () => {
    for (const target of [admin, agent])
      expect(
        (
          await request(app)
            .post(`/api/accounts/${target}/email-code`)
            .set(headers())
            .send({})
        ).status,
      ).toBe(400);
    const id = await createdCode("agent");
    await pg.query(
      "update profiles set deletion_requested_at=now() where id=$1",
      [id],
    );
    expect((await verifyAgent(id)).status).toBe(409);
    expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it.each(["agent", "admin"])(
    "requires update 034 before resending a historical %s code",
    async (role) => {
      const original = db.rpc.getMockImplementation();
      db.rpc.mockImplementation((name, args) =>
        name === "account_email_code_ready"
          ? { error: { code: "PGRST202" } }
          : original(name, args),
      );
      const result = await legacyCodeResponse(role);
      expect(result.status).toBe(503);
      expect(result.body.error).toContain("034");
      expect(db.otp.auth.resend).not.toHaveBeenCalled();
    },
  );
  it("denies browser execution and stale, missing or simultaneous verification claims", async () => {
    const id = await createdCode("agent");
    const claim = randomUUID();
    const args = {
      p_actor: admin,
      p_session: digest("Bearer " + admin),
      p_unlock: digest(grant),
      p_target: id,
      p_claim: claim,
      p_request: "claim-fixture",
    };
    const flow = await rpc("begin_agent_email_code", args);
    await expect(
      rpc("begin_agent_email_code", { ...args, p_claim: randomUUID() }),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      rpc("complete_agent_email_code", { ...args, p_version: flow.version }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      rpc("mark_agent_email_code", {
        ...args,
        p_claim: null,
        p_version: flow.version,
      }),
    ).rejects.toMatchObject({ code: "22023" });
    await pg.exec("set role authenticated");
    try {
      await expect(rpc("begin_agent_email_code", args)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await pg.exec("reset role");
    }
    await verified(id);
    expect((await complete(id, "0".repeat(64))).status).toBe(404);
  });
});
describe("admin-managed invitations and authorization", () => {
  it("does not activate when Auth cannot confirm the recipient password update", async () => {
    const id = await created();
    await verified(id);
    db.auth.admin.updateUserById.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    expect((await complete(id)).status).toBe(503);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    expect(
      (
        await one("select state from account_invitations where user_id=$1", [
          id,
        ])
      ).state,
    ).toBe("sent");
  });
  it("upgrades legacy accounts without changing verified access and safely audits unconfirmed suspension", async () => {
    const legacy = new PGlite({ extensions: { pg_trgm } });
    try {
      await legacy.exec(
        "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
      );
      const dir = new URL("../../supabase/migrations/", import.meta.url);
      for (const f of (await readdir(dir)).sort().filter((f) => f < "023"))
        await legacy.exec(
          (await readFile(new URL(f, dir), "utf8")).replace(
            "create extension if not exists pgcrypto;",
            "",
          ),
        );
      await legacy.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,'legacy-owner@example.test',now()),($2,'legacy-pending@example.test',null)",
        [admin, agent],
      );
      await legacy.query("update profiles set role='admin' where id=$1", [
        admin,
      ]);
      await legacy.exec(
        await readFile(
          new URL("023_admin_account_invitations.sql", dir),
          "utf8",
        ),
      );
      expect(
        (await legacy.query("select id,role,active from profiles order by id"))
          .rows,
      ).toEqual([
        { id: admin, role: "admin", active: true },
        { id: agent, role: "agent", active: false },
      ]);
      expect(
        (
          await legacy.query(
            "select metadata from audit_log where action='migration.pending_access_blocked'",
          )
        ).rows,
      ).toEqual([{ metadata: { count: 1 } }]);
    } finally {
      await legacy.close();
    }
  }, 30000);
  it.each(["admin"])(
    "keeps %s pending until verified recipient password setup",
    async (role) => {
      const id = await created(role);
      expect(
        await one("select active,role from profiles where id=$1", [id]),
      ).toEqual({ active: false, role });
      expect(db.auth.admin.createUser.mock.calls[0][0]).not.toHaveProperty(
        "password",
      );
      expect(db.auth.admin.createUser.mock.calls[0][0].email_confirm).toBe(
        false,
      );
      expect((await complete(id)).status).toBe(401);
      expect((await request(app).get("/api/me").set(headers(id))).status).toBe(
        403,
      );
      await verified(id);
      expect((await request(app).get("/api/me").set(headers(id))).status).toBe(
        403,
      );
      expect((await complete(id)).body).toMatchObject({ role, active: true });
      expect(
        (await request(app).get("/api/me").set(headers(id))).body.role,
      ).toBe(role);
      expect(
        (
          await one("select state from account_invitations where user_id=$1", [
            id,
          ])
        ).state,
      ).toBe("accepted");
      expect(
        JSON.stringify((await pg.query("select * from audit_log")).rows),
      ).not.toContain("recipient-only-password");
      expect(
        JSON.stringify(
          (await request(app).get("/api/accounts").set(headers())).body,
        ),
      ).not.toContain(ticket());
    },
  );
  it.each([
    "",
    "broken",
    "x@@gmail.com",
    "a@-gmail.com",
    "a@gmail..com",
    "a@localhost",
    "a@例子.com",
  ])("rejects invalid address %s before Auth calls", async (email) => {
    const r = await request(app)
      .post("/api/accounts")
      .set(headers())
      .send({ name: "Fixture", email, role: "agent" });
    expect(r.status).toBe(400);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("normalizes spaces/case while preserving dots and plus addressing", () =>
    expect(accountEmail.parse("  Person.Name+Team@GMAIL.COM  ")).toBe(
      "person.name+team@gmail.com",
    ));
  it("supports optional explicit domain screening without claiming mailbox existence", () => {
    vi.stubEnv("CRM_BLOCKED_EMAIL_DOMAINS", "temporary.example.test");
    expect(() => checkEmailProvider("a@temporary.example.test")).toThrow(
      "not permitted",
    );
    expect(() => checkEmailProvider("invented@gmail.com")).not.toThrow();
    vi.unstubAllEnvs();
  });
  it("keeps an inaccessible address blocked despite a successful send request", async () => {
    const id = await created("admin", {
      email: "inaccessible@controlled.example.test",
    });
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
    expect((await complete(id)).status).toBe(401);
    expect(
      (await request(app).get("/api/documents").set(headers(id))).status,
    ).toBe(403);
  });
  it("rejects duplicate pending emails before sending another invitation", async () => {
    await created("admin", { email: "owned+team@gmail.com" });
    const r = await request(app).post("/api/accounts").set(headers()).send({
      name: "Duplicate",
      password: "fixture-pending-password-123",
      email: "OWNED+TEAM@GMAIL.COM",
      role: "agent",
    });
    expect(r.status).toBe(409);
    expect(db.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(
      (await one("select count(*)::int n from account_invitations")).n,
    ).toBe(1);
  });
  it("requires admin identity and the current PIN grant", async () => {
    for (const h of [
      {},
      headers(agent),
      { Authorization: "Bearer " + admin },
      { ...headers(), "X-Accounts-Unlock": "wrong" },
    ])
      expect(
        (
          await request(app).post("/api/accounts").set(h).send({
            name: "Denied",
            email: "denied@example.test",
            role: "admin",
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("rejects forged role/status fields and does not allow direct pending activation", async () => {
    const id = await created();
    await verified(id);
    expect(
      (await complete(id, ticket(), { role: "admin", active: true })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch("/api/accounts/" + id)
          .set(headers())
          .send({ active: true })
      ).status,
    ).toBe(400);
    await expect(
      pg.query("update profiles set active=true where id=$1", [id]),
    ).rejects.toMatchObject({ code: "22023" });
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/password`)
          .set(headers())
          .send({ password: "admin-chosen-password-123" })
      ).status,
    ).toBe(400);
  });
  it("expires invitations and lets admin resend, invalidating the old link", async () => {
    const id = await created(),
      old = ticket();
    await verified(id);
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 hours',expires_at=now()-interval '1 minute'",
    );
    expect((await complete(id, old)).status).toBe(404);
    const list = (
      await request(app).get("/api/accounts?access=expired").set(headers())
    ).body;
    expect(list.count).toBe(1);
    expect(list.data[0].account_status).toBe("invitation_expired");
    expect(
      (
        await request(app)
          .post(`/api/accounts/${id}/invitation`)
          .set(headers())
          .send({})
      ).body.invitation_sent,
    ).toBe(true);
    expect(db.auth.resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect((await complete(id, old)).status).toBe(404);
    const fresh = new URL(
      db.auth.resetPasswordForEmail.mock.calls[0][1].redirectTo,
    ).searchParams.get("ticket");
    expect((await complete(id, fresh)).status).toBe(200);
  });
  it("cancels pending invitations without deleting Auth users", async () => {
    const id = await created(),
      old = ticket();
    await verified(id);
    expect(
      (
        await request(app)
          .delete(`/api/accounts/${id}/invitation`)
          .set(headers())
          .send({})
      ).status,
    ).toBe(204);
    expect((await complete(id, old)).status).toBe(404);
    expect(
      (await one("select count(*)::int n from auth.users where id=$1", [id])).n,
    ).toBe(1);
    expect(
      (await request(app).get("/api/accounts?access=cancelled").set(headers()))
        .body.count,
    ).toBe(1);
  });
  it("blocks other accounts and a wrong invitation ticket", async () => {
    const id = await created();
    await verified(id);
    expect((await complete(agent)).status).toBe(404);
    expect((await complete(id, "f".repeat(64))).status).toBe(404);
    expect(
      db.auth.admin.updateUserById.mock.calls.some(([, data]) => data.password),
    ).toBe(false);
  });
  it("retains pending status on SMTP or password setup failure", async () => {
    db.mailError = { message: "private SMTP value" };
    const id = await created();
    expect(
      (
        await one("select state from account_invitations where user_id=$1", [
          id,
        ])
      ).state,
    ).toBe("failed");
    await verified(id);
    expect((await complete(id)).status).toBe(404);
    db.mailError = null;
    await pg.exec(
      "update account_invitations set requested_at=now()-interval '2 minutes'",
    );
    await request(app)
      .post(`/api/accounts/${id}/invitation`)
      .set(headers())
      .send({});
    const fresh = new URL(
      db.auth.resetPasswordForEmail.mock.calls[0][1].redirectTo,
    ).searchParams.get("ticket");
    db.passwordError = true;
    expect((await complete(id, fresh)).status).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [id])).active,
    ).toBe(false);
  });
  it("rolls back acceptance if its audit fails even after password setup", async () => {
    const id = await created();
    await verified(id);
    await pg.exec(
      "create function fail_acceptance_fixture() returns trigger language plpgsql as $$ begin if new.action='invitation_accepted' then raise exception 'fixture failure'; end if; return new; end $$;create trigger fail_acceptance_fixture before insert on audit_log for each row execute function fail_acceptance_fixture();",
    );
    try {
      expect((await complete(id)).status).toBe(503);
      expect(
        (await one("select active from profiles where id=$1", [id])).active,
      ).toBe(false);
      expect(
        (
          await one("select state from account_invitations where user_id=$1", [
            id,
          ])
        ).state,
      ).toBe("sent");
    } finally {
      await pg.exec(
        "drop trigger fail_acceptance_fixture on audit_log;drop function fail_acceptance_fixture();",
      );
    }
  });
  it("preserves verified legacy login and suspended denial", async () => {
    expect((await request(app).get("/api/me").set(headers(agent))).status).toBe(
      200,
    );
    await request(app)
      .patch(`/api/accounts/${agent}`)
      .set(headers())
      .send({ active: false });
    expect((await request(app).get("/api/me").set(headers(agent))).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .patch(`/api/accounts/${agent}`)
          .set(headers())
          .send({ active: true })
      ).status,
    ).toBe(200);
  });
  it("leaves Auth signups inactive despite forged metadata and forbids browser invitation access", async () => {
    const id = randomUUID();
    await pg.query(
      'insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,\'signup@example.test\',now(),\'{"role":"admin","active":true}\')',
      [id],
    );
    expect(
      await one("select role,active from profiles where id=$1", [id]),
    ).toEqual({ role: "agent", active: false });
    await pg.exec("set role authenticated");
    try {
      await expect(
        pg.query("select * from account_invitations"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pg.query("select accept_account_invitation($1,$2,$3)", [
          id,
          "0".repeat(64),
          "forged",
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
  });
});
