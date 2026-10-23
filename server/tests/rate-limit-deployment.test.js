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
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { fakeSupabase, office } from "./office-fixture.js";
// Production runs two PM2 API slots per environment (blue 3101, green 3102)
// behind one Nginx. hd-crm-switch points Nginx at one slot and the previous
// slot keeps running for rollback. Each slot is a separate process, so each
// app below stands for one slot with its own in-memory counts.
async function statuses(count, send) {
  const seen = [];
  for (let n = 0; n < count; n++) seen.push((await send()).status);
  return seen;
}
// The perUser policy's draft-8 partition key: a hash of the counted user.
const partition = (res) =>
  /"perUser"; q=\d+; w=\d+; pk=:([^:]+):/.exec(
    res.headers["ratelimit-policy"],
  )?.[1];

describe("blue-green API slots", () => {
  const people = office({ admins: 1, agents: 2 });
  const [, agent, colleague] = people;
  const slot = (rateLimits) => createApp(fakeSupabase(people), { rateLimits });
  const save = (app, person = agent) =>
    request(app)
      .patch("/api/leads/" + person.leads[0])
      .set("X-Forwarded-For", person.ip)
      .set("Authorization", "Bearer " + person.token)
      .send({ status: "contacted" });
  it("keeps limiting after a switch, and a rollback finds the earlier counts", async () => {
    const blue = slot({ sensitive: 3 }),
      green = slot({ sensitive: 3 });
    // Live on blue: the agent uses up their allowance.
    expect(await statuses(4, () => save(blue))).toEqual([200, 200, 200, 429]);
    // After the switch, green counts from zero but enforces the same policy.
    expect(await statuses(4, () => save(green))).toEqual([200, 200, 200, 429]);
    // Rolling back within the window: the retained blue process remembers.
    expect((await save(blue)).status).toBe(429);
    // Colleagues are unaffected in both slots.
    expect((await save(blue, colleague)).status).toBe(200);
    expect((await save(green, colleague)).status).toBe(200);
  });
  it("gives a user at most one allowance per running slot while both serve", async () => {
    // During a reload, old Nginx workers finish requests on the previous slot
    // while new workers use the next one. Alternating between both doubles
    // the allowance at most; it never removes the limit.
    const blue = slot({ sensitive: 3 }),
      green = slot({ sensitive: 3 });
    const seen = [];
    for (let n = 0; n < 10; n++)
      seen.push((await save(n % 2 ? green : blue)).status);
    expect(seen).toEqual([200, 200, 200, 200, 200, 200, 429, 429, 429, 429]);
  });
  it("keys a signed-in user identically in both slots", async () => {
    const blue = slot(),
      green = slot();
    const [a, b, c] = [
      await save(blue),
      await save(green),
      await save(green, colleague),
    ];
    // Both slots verify the token with Supabase and count the same user.
    expect(partition(a)).toBe(partition(b));
    expect(partition(c)).not.toBe(partition(a));
  });
  it("identifies each client by the address Nginx forwards, in both slots", async () => {
    // Nginx sets X-Forwarded-For to the connecting address; both slots trust
    // only the loopback proxy, so a forged earlier hop changes nothing.
    const blue = slot({ unauthenticated: 2 }),
      green = slot({ unauthenticated: 2 });
    const probe = (app, forged, client = "198.51.100.66") =>
      request(app)
        .get("/api/me")
        .set("X-Forwarded-For", `${forged}, ${client}`);
    for (const app of [blue, green]) {
      expect((await probe(app, "10.0.0.1")).status).toBe(401);
      expect((await probe(app, "10.0.0.2")).status).toBe(401);
      expect((await probe(app, "10.0.0.3")).status).toBe(429);
      expect((await probe(app, "10.0.0.3", "198.51.100.67")).status).toBe(401);
    }
  });
});

describe("durable protection across slots and restarts", () => {
  const agent = "a8000000-0000-4000-8000-000000000002",
    password = "agent-password-1234";
  let pg, db, signIn;
  const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
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
  afterAll(async () => pg?.close());
  beforeEach(async () => {
    await pg.exec(
      "truncate auth.users cascade;truncate crm_private.login_attempts;",
    );
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'agent@gmail.com',now())",
      [agent],
    );
    await pg.query("update profiles set active=true,role='agent'");
    signIn = vi.fn(async ({ email, password: given }) =>
      email === "agent@gmail.com" && given === password
        ? {
            data: {
              session: {
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 3600,
                user: { id: agent, email },
              },
            },
          }
        : { data: { session: null }, error: { status: 400 } },
    );
    db = {
      auth: {
        getUser: async () => ({ data: { user: null } }),
        admin: { signOut: vi.fn(async () => ({ error: null })) },
      },
      rpc: async (name, args) => {
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
      },
    };
  });
  // A new process each time: the slot that is live, the other slot, or the
  // process PM2 starts after a deploy, restart or rollback.
  const slot = () =>
    createApp(trustedMfaFixture(db), {
      createSignInClient: () => ({ auth: { signInWithPassword: signIn } }),
      loginEnv: { LOGIN_BUSINESS_HOURS: "00-23" },
    });
  const login = (app, given) =>
    request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.66")
      .send({ email: "agent@gmail.com", password: given, portal: "agent" });
  it("locks an account after five wrong passwords spread over both slots", async () => {
    const blue = slot(),
      green = slot();
    for (let n = 0; n < 5; n++)
      expect((await login(n % 2 ? green : blue, "wrong-" + n)).status).toBe(
        401,
      );
    // Both slots and a freshly started process refuse even the right
    // password: the lockout lives in PostgreSQL, not in process memory.
    for (const app of [blue, green, slot()])
      expect((await login(app, password)).status).toBe(401);
    expect(signIn).toHaveBeenCalledTimes(5);
    expect(
      (
        await one(
          "select count(*)::int n from security_alerts where type='account_login_locked'",
        )
      ).n,
    ).toBe(1);
  });
});
