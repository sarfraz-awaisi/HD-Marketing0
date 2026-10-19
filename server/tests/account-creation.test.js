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
import { randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { digest } from "../src/services/accountsSecurity.js";
import {
  creationBinding,
  creationDigest,
} from "../src/services/accountCreation.js";
import {
  GMAIL_ONLY_MESSAGE,
  UID_FORMAT_MESSAGE,
  UID_TAKEN_MESSAGE,
} from "../src/services/accountProvisioning.js";
import { sensitiveLimit } from "../src/middleware/rateLimit.js";
import { accountsSecurityLimit } from "../src/routes/accounts.routes.js";
const admin = "c1000000-0000-4000-8000-000000000001",
  agent = "c1000000-0000-4000-8000-000000000002",
  grant = "fixture-invitation-grant",
  secret = "isolated-creation-secret-abcdefghijklmnopqrstuvwxyz0123456789";
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
const adminGrant = () => ({
  p_actor: admin,
  p_session: digest("Bearer " + admin),
  p_unlock: digest(grant),
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
              "select id,email,email_confirmed_at,raw_app_meta_data as app_metadata from auth.users where id=$1",
              [id],
            ),
          },
        }),
        createUser: vi.fn(async (data) => {
          try {
            const id = data.id || randomUUID();
            // Like Supabase Auth, the profile trigger runs inside this insert
            // and confirmation is recorded afterwards in the same operation.
            await pg.query(
              "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3::jsonb,$4::jsonb)",
              [
                id,
                data.email,
                JSON.stringify(data.user_metadata),
                JSON.stringify(data.app_metadata),
              ],
            );
            if (data.email_confirm)
              await pg.query(
                "update auth.users set email_confirmed_at=now() where id=$1",
                [id],
              );
            return {
              data: {
                user: {
                  id,
                  email: data.email,
                  email_confirmed_at: data.email_confirm
                    ? new Date().toISOString()
                    : null,
                  app_metadata: data.app_metadata,
                },
              },
            };
          } catch (e) {
            return {
              error:
                e.code === "23505"
                  ? { code: "email_exists", status: 422 }
                  : { code: "unexpected_failure", status: 500 },
            };
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
  accountsSecurityLimit.resetKey(admin);
  sensitiveLimit.resetKey("127.0.0.1");
  sensitiveLimit.resetKey("::ffff:127.0.0.1");
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
  db.deliveries = [];
  app = createApp(trustedMfaFixture(db), {
    creationEnv: { ACCOUNT_OTP_SECRET: secret },
    sendAccountCreationEmail: async (data) => {
      if (db.mailError) throw new Error("private-mail-error");
      db.deliveries.push(data);
    },
    createEmailOtpClient: () => db.otp,
  });
  vi.stubEnv("FRONTEND_URL", "http://localhost:5173");
});
const account = (more = {}) => ({
  name: "Muhammad Ali",
  email: "muhammadali@gmail.com",
  password: "initial-account-password-123",
  role: "agent",
  ...more,
});
const create = (more = {}, actor = admin) =>
  request(app).post("/api/accounts").set(headers(actor)).send(account(more));
const authUsers = async (email) =>
  Number(
    (await one("select count(*) n from auth.users where email=$1", [email])).n,
  );
const noMailOrCodes = () => {
  expect(db.deliveries).toHaveLength(0);
  expect(db.otp.auth.resend).not.toHaveBeenCalled();
  expect(db.otp.auth.signInWithOtp).not.toHaveBeenCalled();
  expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
  expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
};
describe("direct admin account creation with Gmail and six-digit UIDs", () => {
  it.each(["agent", "admin"])(
    "creates an %s with an automatic UID, synchronized Auth/profile records and no email code",
    async (role) => {
      const r = await create({
        role,
        email: "  Muhammad.Ali@GMAIL.com ",
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        name: "Muhammad Ali",
        email: "muhammad.ali@gmail.com",
        role,
        active: true,
        account_status: "active",
        message: "Account created successfully.",
      });
      expect(r.body.uid).toBeGreaterThanOrEqual(100000);
      expect(r.body.uid).toBeLessThanOrEqual(999999);
      // The popup derives its Active badge from these saved Auth facts.
      expect(r.body.email_confirmed_at).toBeTruthy();
      expect(JSON.stringify(r.body)).not.toContain(account().password);
      const { id, uid } = r.body;
      // Supabase Auth keeps its UUID identity; the UID is a separate field.
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const native = await one(
        "select email,email_confirmed_at,raw_app_meta_data from auth.users where id=$1",
        [id],
      );
      expect(native.email).toBe("muhammad.ali@gmail.com");
      expect(native.email_confirmed_at).not.toBeNull();
      expect(native.raw_app_meta_data).toMatchObject({
        crm_provisioning: true,
        crm_account_request: id,
      });
      expect(
        await one("select name,role,active,uid from profiles where id=$1", [
          id,
        ]),
      ).toEqual({ name: "Muhammad Ali", role, active: true, uid });
      expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
      expect(db.auth.admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id,
          email: "muhammad.ali@gmail.com",
          password: account().password,
          email_confirm: true,
        }),
      );
      noMailOrCodes();
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
      // The same UID appears in the admin list, account details and the
      // new user's own profile; the new user signs in to the matching portal.
      const list = await request(app)
        .get("/api/accounts?search=muhammad")
        .set(headers());
      expect(list.body.data.find((row) => row.id === id)).toMatchObject({
        uid,
        role,
      });
      expect(
        (await request(app).get(`/api/accounts/${id}`).set(headers())).body.uid,
      ).toBe(uid);
      const me = await request(app)
        .get(`/api/me?portal=${role}`)
        .set({ Authorization: "Bearer " + id });
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        id,
        uid,
        role,
        email: "muhammad.ali@gmail.com",
      });
      // The creating administrator stays signed in with a working PIN unlock.
      expect(
        (await request(app).get("/api/me?portal=admin").set(headers())).body,
      ).toMatchObject({ id: admin, role: "admin" });
      expect(
        (await request(app).get("/api/accounts").set(headers())).status,
      ).toBe(200);
      expect(
        await one(
          "select uid,uid_source,status from account_provisioning where id=$1",
          [id],
        ),
      ).toEqual({ uid, uid_source: "auto", status: "completed" });
      const audits = (await pg.query("select action,metadata from audit_log"))
        .rows;
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(["account.create_requested", "account.created"]),
      );
      expect(JSON.stringify(audits)).not.toContain(account().password);
    },
  );
  it("assigns an available manual UID exactly as entered", async () => {
    const r = await create({ uid_mode: "manual", uid: "583214" });
    expect(r.status).toBe(201);
    expect(r.body.uid).toBe(583214);
    expect(
      (await one("select uid from profiles where id=$1", [r.body.id])).uid,
    ).toBe(583214);
    expect(
      (
        await one("select uid_source from account_provisioning where id=$1", [
          r.body.id,
        ])
      ).uid_source,
    ).toBe("manual");
    // A numeric JSON value is accepted for API clients as well.
    expect(
      (
        await create({
          email: "second@gmail.com",
          uid_mode: "manual",
          uid: 741205,
        })
      ).body.uid,
    ).toBe(741205);
  });
  it("rejects a duplicate manual UID without replacing it or creating a user", async () => {
    await create({ uid_mode: "manual", uid: "908234" });
    const duplicate = await create({
      email: "another@gmail.com",
      uid_mode: "manual",
      uid: "908234",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      error: UID_TAKEN_MESSAGE,
      code: "ACCOUNTS_UID_TAKEN",
    });
    expect(await authUsers("another@gmail.com")).toBe(0);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
    // UIDs from the earlier accounts are also unavailable.
    const existing = (
      await one("select uid from profiles where id=$1", [admin])
    ).uid;
    expect(
      (
        await create({
          email: "third@gmail.com",
          uid_mode: "manual",
          uid: String(existing),
        })
      ).status,
    ).toBe(409);
  });
  it("serializes simultaneous requests for the same manual UID to one account", async () => {
    const [first, second] = await Promise.all([
      create({
        email: "first.race@gmail.com",
        uid_mode: "manual",
        uid: "700001",
      }),
      create({
        email: "second.race@gmail.com",
        uid_mode: "manual",
        uid: "700001",
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error).toBe(UID_TAKEN_MESSAGE);
    expect(
      Number((await one("select count(*) n from profiles where uid=700001")).n),
    ).toBe(1);
    expect(
      (await authUsers("first.race@gmail.com")) +
        (await authUsers("second.race@gmail.com")),
    ).toBe(1);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("serializes simultaneous requests for the same email to one account", async () => {
    const results = await Promise.all([
      create({ email: "same@gmail.com" }),
      create({ email: "SAME@gmail.com" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await authUsers("same@gmail.com")).toBe(1);
  });
  it("keeps generated UIDs unique under parallel creation", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        create({ email: `bulk${n}@gmail.com` }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const uids = results.map((r) => r.body.uid);
    expect(new Set(uids).size).toBe(8);
    expect(uids.every((uid) => uid >= 100000 && uid <= 999999)).toBe(true);
  });
  it("retries a generated UID that collides at the database unique index", async () => {
    const original = (
      await one(
        "select pg_get_functiondef('public.generate_account_uid()'::regprocedure) def",
      )
    ).def;
    await pg.query(
      "insert into account_provisioning(id,uid,uid_source,normalized_email,requested_name,requested_role,desired_active,requested_by,status,lease_until) values($1,654321,'manual','held@gmail.com','Held','agent',true,$2,'creating',now()+interval '5 minutes')",
      [randomUUID(), admin],
    );
    // Simulate a candidate that passed the application check but collides on insert.
    await pg.exec(
      "create sequence public.fixture_uid_draws;create or replace function public.generate_account_uid() returns integer language sql volatile set search_path='' as $$ select case when nextval('public.fixture_uid_draws')=1 then 654321 else 765432 end $$;",
    );
    try {
      const r = await create({ email: "collision@gmail.com" });
      expect(r.status).toBe(201);
      expect(r.body.uid).toBe(765432);
    } finally {
      await pg.exec(original + ";drop sequence public.fixture_uid_draws;");
    }
  });
  it("stops at the retry limit when no generated UID is free", async () => {
    const original = (
      await one(
        "select pg_get_functiondef('public.account_uid_candidate()'::regprocedure) def",
      )
    ).def;
    const used = (await one("select uid from profiles where id=$1", [admin]))
      .uid;
    await pg.exec(
      `create or replace function public.account_uid_candidate() returns integer language sql volatile set search_path='' as $$ select ${used} $$;`,
    );
    try {
      const r = await create();
      expect(r.status).toBe(503);
      expect(db.auth.admin.createUser).not.toHaveBeenCalled();
      expect(
        Number((await one("select count(*) n from account_provisioning")).n),
      ).toBe(0);
    } finally {
      await pg.exec(original);
    }
    expect((await create()).status).toBe(201);
  });
  it.each([
    ["12345", "five digits"],
    ["1234567", "seven digits"],
    ["12a456", "letters"],
    ["58321!", "special characters"],
    ["012345", "a leading zero"],
    [" 583214", "spaces"],
    ["", "an empty value"],
    [null, "a missing value"],
    [12345, "a five-digit number"],
    [583214.5, "a decimal"],
  ])("rejects a manual UID %j with %s", async (uid) => {
    const r = await create({ uid_mode: "manual", uid });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      error: UID_FORMAT_MESSAGE,
      code: "ACCOUNTS_INVALID_UID",
    });
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(
      Number((await one("select count(*) n from account_provisioning")).n),
    ).toBe(0);
  });
  it("rejects a UID in automatic mode instead of silently changing modes", async () => {
    const r = await create({ uid: "583214" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ACCOUNTS_INVALID_UID");
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it.each([
    "john@yahoo.com",
    "john@outlook.com",
    "john@company.com",
    "john@gmail.co",
    "john@gmail.com.fake",
    "john@gmail",
    "invalid-email",
    "john@googlemail.com",
    "john@mail.gmail.com",
    "x@@gmail.com",
    "a@gmail..com",
    ".john@gmail.com",
    "john @gmail.com",
    "",
  ])("rejects %j before any Auth call", async (email) => {
    const r = await create({ email });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      error: GMAIL_ONLY_MESSAGE,
      code: "ACCOUNTS_INVALID_EMAIL",
    });
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(
      Number((await one("select count(*) n from account_provisioning")).n),
    ).toBe(0);
  });
  it.each(["john@gmail.com", "agent123@gmail.com", "hdmarketing@gmail.com"])(
    "accepts %s",
    async (email) => {
      const r = await create({ email });
      expect(r.status).toBe(201);
      expect(r.body.email).toBe(email);
    },
  );
  it("prevents duplicate email registration across Auth users, invitations and earlier pending requests", async () => {
    expect((await create()).status).toBe(201);
    const again = await create({ email: " MuhammadAli@Gmail.com " });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ACCOUNTS_EMAIL_EXISTS");
    await pg.query(
      "insert into auth.users(id,email) values($1,'outside@gmail.com')",
      [randomUUID()],
    );
    expect((await create({ email: "outside@gmail.com" })).status).toBe(409);
    await start("agent", { email: "pending.request@gmail.com" });
    expect((await create({ email: "Pending.Request@gmail.com" })).status).toBe(
      409,
    );
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("requires an authenticated active admin with the current PIN unlock", async () => {
    for (const h of [
      {},
      { Authorization: "Bearer " + agent },
      headers(agent),
      { Authorization: "Bearer " + admin },
      { ...headers(), "X-Accounts-Unlock": "wrong" },
    ]) {
      const r = await request(app).post("/api/accounts").set(h).send(account());
      expect([401, 403, 423]).toContain(r.status);
      expect(
        (
          await request(app)
            .get("/api/accounts/uid-availability?uid=583214")
            .set(h)
        ).status,
      ).toBeGreaterThanOrEqual(401);
    }
    // Agents are refused by role before any PIN or Auth work.
    expect(
      (
        await request(app)
          .post("/api/accounts")
          .set(headers(agent))
          .send(account())
      ).status,
    ).toBe(403);
    await pg.query("update profiles set active=false where id=$1", [admin]);
    expect((await create()).status).toBe(403);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("checks manual UID availability for the unlocked admin", async () => {
    const check = (uid) =>
      request(app)
        .get(`/api/accounts/uid-availability?uid=${uid}`)
        .set(headers());
    expect((await check("583214")).body).toEqual({
      uid: 583214,
      available: true,
    });
    await create({ uid_mode: "manual", uid: "583214" });
    expect((await check("583214")).body.available).toBe(false);
    for (const invalid of ["012345", "12345", "abcdef"]) {
      const r = await check(invalid);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("ACCOUNTS_INVALID_UID");
    }
  });
  it("frees the UID and email when Supabase Auth rejects the account", async () => {
    db.auth.admin.createUser.mockResolvedValueOnce({
      error: { code: "unexpected_failure", status: 500 },
    });
    const failed = await create({ uid_mode: "manual", uid: "246800" });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain("Nothing was saved");
    expect(await authUsers("muhammadali@gmail.com")).toBe(0);
    expect((await one("select status from account_provisioning")).status).toBe(
      "failed",
    );
    const retry = await create({ uid_mode: "manual", uid: "246800" });
    expect(retry.status).toBe(201);
    expect(retry.body.uid).toBe(246800);
  });
  it("maps an Auth duplicate email to 409 and releases the reservation", async () => {
    db.auth.admin.createUser.mockResolvedValueOnce({
      error: { code: "email_exists", status: 422 },
    });
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ACCOUNTS_EMAIL_EXISTS");
    expect((await one("select status from account_provisioning")).status).toBe(
      "failed",
    );
  });
  it("rolls back the Auth user when its profile cannot be saved", async () => {
    await pg.exec(
      "create function fail_profile_insert() returns trigger language plpgsql as $$ begin raise exception 'fixture profile failure';end $$;create trigger fail_profile_insert before insert on profiles for each row execute function fail_profile_insert();",
    );
    try {
      const r = await create({ uid_mode: "manual", uid: "135790" });
      expect(r.status).toBe(503);
      expect(await authUsers("muhammadali@gmail.com")).toBe(0);
      expect(
        await one("select id from profiles where uid=135790"),
      ).toBeUndefined();
    } finally {
      await pg.exec(
        "drop trigger fail_profile_insert on profiles;drop function fail_profile_insert();",
      );
    }
    const retry = await create({ uid_mode: "manual", uid: "135790" });
    expect(retry.status).toBe(201);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(2);
  });
  it("recovers an ambiguous Auth timeout after the user was created", async () => {
    const native = db.auth.admin.createUser.getMockImplementation();
    db.auth.admin.createUser.mockImplementationOnce(async (data) => {
      await native(data);
      throw new Error("ambiguous timeout");
    });
    const r = await create({ uid_mode: "manual", uid: "864200" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ uid: 864200, active: true });
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("leaves an unconfirmed creation for automatic recovery without guessing", async () => {
    db.auth.admin.createUser.mockImplementationOnce(async () => {
      throw new Error("network timeout");
    });
    const lookup = db.auth.admin.getUserById;
    db.auth.admin.getUserById = async () => ({ error: { status: 500 } });
    try {
      const r = await create({ uid_mode: "manual", uid: "975310" });
      expect(r.status).toBe(503);
      expect(r.body.error).toContain("could not be confirmed");
    } finally {
      db.auth.admin.getUserById = lookup;
    }
    expect((await one("select status from account_provisioning")).status).toBe(
      "creating",
    );
    // While reserved, the UID is held; after the lease it is safely released.
    expect(
      (
        await create({
          email: "held@gmail.com",
          uid_mode: "manual",
          uid: "975310",
        })
      ).status,
    ).toBe(409);
    await pg.exec(
      "update account_provisioning set lease_until=now()-interval '1 second'",
    );
    expect(
      (
        await create({
          email: "later@gmail.com",
          uid_mode: "manual",
          uid: "975310",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await pg.query(
          "select action,metadata from audit_log where action='account.create_recovered'",
        )
      ).rows[0].metadata,
    ).toEqual({ status: "failed" });
  });
  it("keeps a consistent disabled account when the final activation step fails", async () => {
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation((name, args) =>
      name === "complete_account_provisioning"
        ? { error: { code: "XX000" } }
        : original(name, args),
    );
    const r = await create({
      role: "admin",
      email: "stuck@gmail.com",
      uid_mode: "manual",
      uid: "246810",
    });
    db.rpc.mockImplementation(original);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("ACCOUNTS_CREATE_INCOMPLETE");
    expect(r.body.error).toContain("246810");
    const { id } = await one("select id from auth.users where email=$1", [
      "stuck@gmail.com",
    ]);
    // Auth and profile records still match; only access stays disabled.
    expect(
      await one("select name,role,active,uid from profiles where id=$1", [id]),
    ).toEqual({
      name: "Muhammad Ali",
      role: "admin",
      active: false,
      uid: 246810,
    });
    expect(
      (
        await request(app)
          .get("/api/me")
          .set({ Authorization: "Bearer " + id })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/accounts/${id}`)
          .set(headers())
          .send({ active: true })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/me")
          .set({ Authorization: "Bearer " + id })
      ).body,
    ).toMatchObject({ role: "admin", uid: 246810 });
    await pg.exec(
      "update account_provisioning set lease_until=now()-interval '1 second'",
    );
    expect((await create({ email: "next@gmail.com" })).status).toBe(201);
    expect(
      (await one("select status from account_provisioning where id=$1", [id]))
        .status,
    ).toBe("completed");
  });
  it("never lets the API or SQL change an assigned UID", async () => {
    const { id, uid } = (await create()).body;
    const patched = await request(app)
      .patch(`/api/accounts/${id}`)
      .set(headers())
      .send({ uid: 111111 });
    expect(patched.status).toBe(400);
    await expect(
      rpc("update_account", {
        ...adminGrant(),
        p_target: id,
        p_data: { uid: 111111 },
        p_request: "forged",
      }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      pg.query("update profiles set uid=111111 where id=$1", [id]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      pg.query("update profiles set uid=99999 where id=$1", [id]),
    ).rejects.toMatchObject({ code: "22023" });
    expect((await one("select uid from profiles where id=$1", [id])).uid).toBe(
      uid,
    );
  });
  it("denies browser roles the provisioning data, UIDs and functions", async () => {
    await create();
    await pg.exec("set role authenticated");
    try {
      for (const sql of [
        "select * from public.account_provisioning",
        "select uid from public.profiles",
        "select * from crm_private.account_uid_review",
        "select public.generate_account_uid()",
        "select public.account_uid_candidate()",
      ])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: "42501" });
      await expect(
        rpc("begin_account_provisioning", {
          ...adminGrant(),
          p_id: randomUUID(),
          p_email: "browser@gmail.com",
          p_name: "Browser",
          p_role: "admin",
          p_active: true,
          p_uid: 123456,
          p_request: "browser",
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        rpc("account_uid_available", { ...adminGrant(), p_uid: 123456 }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
  });
  it("fails safely before Auth mutation when update 036 is absent", async () => {
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation((name, args) =>
      name === "begin_account_provisioning"
        ? { error: { code: "PGRST202" } }
        : original(name, args),
    );
    const r = await create();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "ACCOUNTS_MIGRATION_REQUIRED" });
    expect(r.body.error).toContain("036");
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("keeps sign-in working for a database that has not received update 036", async () => {
    const legacy = {
      ...db,
      from(table) {
        const q = db.from(table);
        const select = q.select;
        q.select = (columns) =>
          columns.includes("uid")
            ? {
                eq: () => ({
                  single: async () => ({
                    error: {
                      code: "42703",
                      message: "column profiles.uid does not exist",
                    },
                  }),
                }),
              }
            : select(columns);
        return q;
      },
    };
    const me = await request(createApp(trustedMfaFixture(legacy)))
      .get("/api/me?portal=agent")
      .set({ Authorization: "Bearer " + agent });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: agent, role: "agent" });
    expect(me.body.uid).toBeUndefined();
  });
});
// Email-code requests issued before update 036 remain resumable. No route can
// start a new one, so these fixtures reserve them the way the old route did.
const form = (role = "agent", more = {}) => ({
  name: "Verified teammate",
  email: "owned+new@example.test",
  password: "initial-account-password-123",
  role,
  ...more,
});
async function start(role = "agent", more = {}) {
  const data = form(role, more),
    email = data.email.trim().toLowerCase(),
    id = randomUUID(),
    version = randomUUID(),
    code = String(randomInt(0, 1000000)).padStart(6, "0");
  await rpc("prepare_account_creation", {
    ...adminGrant(),
    p_id: id,
    p_email: email,
    p_name: data.name,
    p_role: role,
    p_active: true,
    p_binding: creationBinding(secret, id, {
      email,
      name: data.name,
      role,
      active: true,
      password: data.password,
    }),
    p_hash: creationDigest(secret, "otp-v1", id, version, code),
    p_version: version,
    p_request: "legacy-fixture",
  });
  const sent = !db.mailError;
  if (sent) db.deliveries.push({ id, version, code, email });
  return {
    ...(await rpc("finish_account_creation_email", {
      ...adminGrant(),
      p_id: id,
      p_version: version,
      p_sent: sent,
      p_request: "legacy-fixture",
    })),
    verification_required: true,
    email_sent: sent,
  };
}
const verify = (pending, more = {}, actor = admin) =>
  request(app)
    .post(`/api/accounts/pending/${pending.request_id}/verify`)
    .set(headers(actor))
    .send({
      code: db.deliveries.at(-1)?.code || "123456",
      password: form().password,
      ...more,
    });
const resend = (pending) =>
  request(app)
    .post(`/api/accounts/pending/${pending.request_id}/resend`)
    .set(headers())
    .send({});
const cool = () =>
  pg.exec(
    "update account_creation_requests set last_sent_at=now()-interval '2 minutes'",
  );
describe("email-code requests created before update 036", () => {
  it("blocks older password, edit and native-code routes for a partially provisioned request", async () => {
    const p = await start("admin");
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation((method, args) =>
      method === "complete_account_creation"
        ? { error: { code: "503" } }
        : original(method, args),
    );
    expect((await verify(p)).status).toBe(503);
    const mutations = db.auth.admin.updateUserById.mock.calls.length;
    expect(
      (
        await request(app)
          .post(`/api/accounts/${p.request_id}/password`)
          .set(headers())
          .send({ password: "another-password-123" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`/api/accounts/${p.request_id}`)
          .set(headers())
          .send({ role: "admin", active: true })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/api/accounts/${p.request_id}/email-code`)
          .set(headers())
          .send({})
      ).status,
    ).toBe(409);
    expect(db.auth.admin.updateUserById.mock.calls).toHaveLength(mutations);
    expect(db.otp.auth.resend).not.toHaveBeenCalled();
    expect(
      (await one("select active from profiles where id=$1", [p.request_id]))
        .active,
    ).toBe(false);
    db.rpc.mockImplementation(original);
    expect((await verify(p)).status).toBe(200);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("never alters or deletes an unrelated Auth user when a reserved identity conflicts", async () => {
    const p = await start();
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'legitimate@example.test',now(),'{}')",
      [p.request_id],
    );
    expect((await verify(p)).status).toBe(409);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(
      (await one("select email from auth.users where id=$1", [p.request_id]))
        .email,
    ).toBe("legitimate@example.test");
  });
  it("recovers a trigger/profile-insertion failure without an orphaned Auth user", async () => {
    const p = await start();
    await pg.exec(
      "create function fail_creation_profile() returns trigger language plpgsql as $$ begin raise exception 'fixture profile failure';end $$;create trigger fail_creation_profile before insert on profiles for each row execute function fail_creation_profile();",
    );
    try {
      expect((await verify(p)).status).toBe(503);
      expect(
        await one("select id from auth.users where id=$1", [p.request_id]),
      ).toBeUndefined();
    } finally {
      await pg.exec(
        "drop trigger fail_creation_profile on profiles;drop function fail_creation_profile();",
      );
    }
    expect((await verify(p)).status).toBe(200);
  });
  it("enforces durable recipient send quotas for earlier requests", async () => {
    const p = await start();
    for (let n = 0; n < 4; n++) {
      await cool();
      expect((await resend(p)).status).toBe(200);
    }
    await cool();
    expect((await resend(p)).status).toBe(429);
    expect(
      (
        await request(app)
          .delete(`/api/accounts/pending/${p.request_id}`)
          .set(headers())
          .send({})
      ).status,
    ).toBe(204);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it.each(["agent", "admin"])(
    "completes an earlier %s request after its code, assigns a UID and preserves the admin session",
    async (role) => {
      const before = Number((await one("select count(*) n from auth.users")).n);
      const pending = await start(role);
      expect(db.auth.admin.createUser).not.toHaveBeenCalled();
      expect(Number((await one("select count(*) n from auth.users")).n)).toBe(
        before,
      );
      expect(
        await one("select * from profiles where id=$1", [pending.request_id]),
      ).toBeUndefined();
      expect(pending).toMatchObject({
        verification_required: true,
        email_sent: true,
        masked_email: "o***@example.test",
        role,
      });
      const state = await one(
        "select * from account_creation_requests where id=$1",
        [pending.request_id],
      );
      expect(state.otp_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(state)).not.toContain(form().password);
      expect(JSON.stringify(pending)).not.toContain(db.deliveries[0].code);
      const done = await verify(pending);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({
        completed: true,
        id: pending.request_id,
        role,
      });
      const profile = await one(
        "select role,active,uid from profiles where id=$1",
        [pending.request_id],
      );
      expect(profile).toMatchObject({ role, active: true });
      expect(profile.uid).toBeGreaterThanOrEqual(100000);
      expect(
        (await request(app).get("/api/me").set(headers(pending.request_id)))
          .body,
      ).toMatchObject({ role, uid: profile.uid });
      expect((await request(app).get("/api/me").set(headers())).body.role).toBe(
        "admin",
      );
      expect((await verify(pending)).status).toBe(200);
      expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
      expect(db.otp.auth.verifyOtp).not.toHaveBeenCalled();
      expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(
        JSON.stringify((await pg.query("select * from audit_log")).rows),
      ).not.toContain(db.deliveries[0].code);
    },
  );
  it("rejects random codes, persists five failures, then requires resend", async () => {
    const p = await start();
    const wrong = db.deliveries.at(-1).code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await verify(p, { code: wrong });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("Invalid verification code. Please try again.");
    }
    expect((await verify(p)).status).toBe(429);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(
      (
        await one(
          "select failed_attempts from account_creation_requests where id=$1",
          [p.request_id],
        )
      ).failed_attempts,
    ).toBe(5);
    await cool();
    expect((await resend(p)).status).toBe(200);
    expect((await verify(p)).status).toBe(200);
  });
  it("rejects expiry, enforces cooldown and invalidates the prior OTP on resend", async () => {
    const p = await start();
    const old = db.deliveries.at(-1).code;
    expect((await resend(p)).status).toBe(429);
    await pg.exec(
      "update account_creation_requests set otp_expires_at=now()-interval '1 second'",
    );
    const expired = await verify(p);
    expect(expired.status).toBe(400);
    expect(expired.body.error).toContain("has expired");
    await cool();
    expect((await resend(p)).status).toBe(200);
    // Distinct version invalidates the old hash even on a rare equal random code;
    // use a deterministic mismatch here without assuming probabilistic uniqueness.
    if (db.deliveries.at(-1).code !== old)
      expect((await verify(p, { code: old })).status).toBe(400);
    expect((await verify(p)).status).toBe(200);
  });
  it("requires active admin and PIN for each pending endpoint", async () => {
    const p = await start();
    for (const h of [
      {},
      headers(agent),
      { Authorization: "Bearer " + admin },
      { ...headers(), "X-Accounts-Unlock": "wrong" },
    ]) {
      for (const [method, path, body] of [
        ["get", "/api/accounts/pending"],
        [
          "post",
          `/api/accounts/pending/${p.request_id}/verify`,
          { code: db.deliveries[0].code, password: form().password },
        ],
        ["post", `/api/accounts/pending/${p.request_id}/resend`, {}],
        ["delete", `/api/accounts/pending/${p.request_id}`, {}],
      ]) {
        expect([401, 403, 423]).toContain(
          (await request(app)[method](path).set(h).send(body)).status,
        );
      }
    }
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("binds password, role and email to the original request and denies other admins", async () => {
    const p = await start();
    expect(
      (await verify(p, { password: "another-strong-password-123" })).status,
    ).toBe(400);
    expect((await verify(p, { role: "admin" })).status).toBe(400);
    expect((await verify(p, { email: "other@example.test" })).status).toBe(400);
    const other = randomUUID();
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'other-admin@example.test',now())",
      [other],
    );
    await pg.query("update profiles set role='admin',active=true where id=$1", [
      other,
    ]);
    const otherGrant = {
      p_actor: other,
      p_session: digest("Bearer " + other),
      p_unlock: digest("other-grant"),
    };
    await rpc("save_accounts_pin", {
      p_actor: other,
      p_hash: "fixture-" + "x".repeat(80),
      p_request: "other-pin",
    });
    await rpc("unlock_accounts", {
      p_actor: other,
      p_session: otherGrant.p_session,
      p_version: (
        await one("select version from account_security where admin_id=$1", [
          other,
        ])
      ).version,
      p_valid: true,
      p_token: otherGrant.p_unlock,
      p_request: "other-unlock",
    });
    expect(
      (
        await request(app)
          .post(`/api/accounts/pending/${p.request_id}/verify`)
          .set({ ...headers(other), "X-Accounts-Unlock": "other-grant" })
          .send({ code: db.deliveries.at(-1).code, password: form().password })
      ).status,
    ).toBe(404);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect((await verify(p)).status).toBe(200);
  });
  it("denies disabled or demoted administrators while verification is pending", async () => {
    const p = await start();
    await pg.query("update profiles set active=false where id=$1", [admin]);
    expect((await verify(p)).status).toBe(403);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("serializes simultaneous verification to exactly one Auth user", async () => {
    const p = await start();
    let release;
    const native = db.auth.admin.createUser.getMockImplementation();
    db.auth.admin.createUser.mockImplementationOnce(async (data) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return native(data);
    });
    const first = verify(p).then((r) => r);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await verify(p)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("handles mail failure, safe resend and cancellation without Auth provisioning", async () => {
    db.mailError = {};
    const p = await start();
    expect(p.email_sent).toBe(false);
    expect((await verify(p)).status).toBe(400);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    db.mailError = null;
    await cool();
    expect((await resend(p)).body.email_sent).toBe(true);
    expect(
      (
        await request(app)
          .delete(`/api/accounts/pending/${p.request_id}`)
          .set(headers())
          .send({})
      ).status,
    ).toBe(204);
    expect((await verify(p)).status).toBe(400);
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("recovers Auth failure without creating a second request or enabling a profile", async () => {
    const p = await start();
    db.auth.admin.createUser.mockResolvedValueOnce({
      error: { code: "provider_failure" },
    });
    expect((await verify(p)).status).toBe(503);
    expect(
      await one("select id from profiles where id=$1", [p.request_id]),
    ).toBeUndefined();
    expect((await verify(p)).status).toBe(200);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(2);
  });
  it("recovers a provider timeout after successful Auth insertion using only its reserved identity", async () => {
    const p = await start();
    const native = db.auth.admin.createUser.getMockImplementation();
    db.auth.admin.createUser.mockImplementationOnce(async (data) => {
      await native(data);
      throw new Error("ambiguous timeout");
    });
    expect((await verify(p)).status).toBe(200);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
  it("retries audited profile failure without duplicating or mutating the Auth user", async () => {
    const p = await start("admin");
    await pg.exec(
      "create function fail_creation_audit() returns trigger language plpgsql as $$ begin if new.action='account_creation.completed' then raise exception 'fixture';end if;return new;end $$;create trigger fail_creation_audit before insert on audit_log for each row execute function fail_creation_audit();",
    );
    try {
      expect((await verify(p)).status).toBe(503);
      expect(
        await one("select active,role from profiles where id=$1", [
          p.request_id,
        ]),
      ).toEqual({ active: false, role: "agent" });
    } finally {
      await pg.exec(
        "drop trigger fail_creation_audit on audit_log;drop function fail_creation_audit();",
      );
    }
    expect((await verify(p)).status).toBe(200);
    expect(db.auth.admin.createUser).toHaveBeenCalledTimes(1);
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
  it("retains blocked managed partial users when the initiating admin loses authority mid-flight", async () => {
    const p = await start();
    const native = db.auth.admin.createUser.getMockImplementation();
    db.auth.admin.createUser.mockImplementationOnce(async (data) => {
      const result = await native(data);
      await pg.query("update profiles set active=false where id=$1", [admin]);
      return result;
    });
    expect((await verify(p)).status).toBe(403);
    expect(
      (await one("select active from profiles where id=$1", [p.request_id]))
        .active,
    ).toBe(false);
    expect(
      (
        await one("select status from account_creation_requests where id=$1", [
          p.request_id,
        ])
      ).status,
    ).toBe("creating");
  });
  it("denies browser challenge reads/functions and profile activation before completion", async () => {
    const p = await start();
    await pg.exec("set role authenticated");
    try {
      await expect(
        pg.query("select * from public.account_creation_requests"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        rpc("account_creation_list", {
          p_actor: admin,
          p_session: "x",
          p_unlock: "x",
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
    db.auth.admin.createUser.mockImplementationOnce(async (data) => {
      const id = data.id;
      await pg.query(
        "insert into auth.users(id,email,raw_app_meta_data,email_confirmed_at) values($1,$2,$3,now())",
        [id, data.email, JSON.stringify(data.app_metadata)],
      );
      await expect(
        pg.query("update profiles set active=true where id=$1", [id]),
      ).rejects.toMatchObject({ code: "22023" });
      return { error: { code: "timeout" } };
    });
    expect((await verify(p)).status).toBe(200);
  });
});
