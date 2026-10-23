import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  rateLimitPolicies,
  rateLimitSettings,
} from "../src/middleware/rateLimit.js";
import {
  fakeSupabase,
  office as team,
  range,
} from "./office-fixture.js";
// Several employees behind one office IP. Requests arrive through Nginx on
// loopback, so the default TRUST_PROXY=loopback takes the client IP from
// X-Forwarded-For exactly as in production.
const office = "203.0.113.10";
const ids = {
  admin: "a7000000-0000-4000-8000-000000000001",
  ali: "a7000000-0000-4000-8000-000000000002",
  sara: "a7000000-0000-4000-8000-000000000003",
  disabled: "a7000000-0000-4000-8000-000000000004",
};
const profiles = {
  [ids.admin]: {
    id: ids.admin,
    uid: 100001,
    name: "Admin",
    role: "admin",
    active: true,
  },
  [ids.ali]: {
    id: ids.ali,
    uid: 100002,
    name: "Ali",
    role: "agent",
    active: true,
  },
  [ids.sara]: {
    id: ids.sara,
    uid: 100003,
    name: "Sara",
    role: "agent",
    active: true,
  },
  [ids.disabled]: {
    id: ids.disabled,
    uid: 100004,
    name: "Former",
    role: "agent",
    active: false,
  },
};
// JWT-shaped tokens. Only the mocked Supabase decides whose token it is.
const jwt = (sub, tag = "") =>
  [
    "e30",
    Buffer.from(
      JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600, tag }),
    ).toString("base64url"),
    "sig",
  ].join(".");
const tokens = Object.fromEntries(
  Object.entries(ids).map(([name, id]) => [name, jwt(id)]),
);
// Claims Sara's ID in its payload, but Supabase verifies it as Ali's token.
const forged = jwt(ids.sara, "forged");
// Claims the admin's ID, and Supabase rejects it.
const rejected = jwt(ids.admin, "rejected");
const verified = {
  ...Object.fromEntries(Object.entries(tokens).map(([n, t]) => [t, ids[n]])),
  [forged]: ids.ali,
};
const db = {
  auth: {
    getUser: async (token) =>
      verified[token]
        ? {
            data: {
              user: {
                id: verified[token],
                email: verified[token] + "@gmail.com",
                email_confirmed_at: "2026-10-01T00:00:00Z",
              },
            },
          }
        : { data: { user: null }, error: { status: 401 } },
    getClaims: async (token) => ({
      data: { claims: { sub: verified[token], aal: "aal1" } },
    }),
  },
  from: () => {
    let id;
    const q = {
      select: () => q,
      eq: (_column, value) => ((id = value), q),
      single: async () =>
        profiles[id]
          ? { data: profiles[id] }
          : { data: null, error: { code: "PGRST116" } },
    };
    return q;
  },
  rpc: async () => ({ data: { reset_pending: false, reset_after: null } }),
};
const servers = [];
function serve(rateLimits) {
  const server = createApp(db, rateLimits ? { rateLimits } : {}).listen(0);
  servers.push(server);
  return server;
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
const me = (server, token, { ip = office, headers = {} } = {}) => {
  const req = request(server).get("/api/me").set("X-Forwarded-For", ip);
  for (const [name, value] of Object.entries(headers)) req.set(name, value);
  return token ? req.set("Authorization", "Bearer " + token) : req;
};
async function statuses(count, send) {
  const seen = [];
  for (let i = 0; i < count; i++) seen.push((await send()).status);
  return seen;
}

describe("API rate limits for a shared office IP", () => {
  it("lets an admin's dashboard polling and two agents share one IP without 429s", async () => {
    // A busy admin's 15 minutes on the Overview, from the client's polling
    // intervals: notifications 60 s (15), Meta summary 30 s (30), security
    // alerts 60 s (15), System status 60 s (15) and Today's calling 120 s (8)
    // = 83, plus about 30 page opens of ~8 requests = ~323. That alone was
    // over the old shared 300-per-IP allowance.
    const server = serve();
    const admin = await statuses(330, () => me(server, tokens.admin));
    const ali = await statuses(150, () => me(server, tokens.ali));
    const sara = await statuses(150, () => me(server, tokens.sara));
    for (const seen of [admin, ali, sara])
      expect(seen.every((s) => s === 200)).toBe(true);
  }, 30000);
  it("limits one user who sends too many requests without blocking colleagues", async () => {
    const server = serve({ perUser: 5 });
    expect(await statuses(5, () => me(server, tokens.ali))).toEqual(
      Array(5).fill(200),
    );
    const blocked = await me(server, tokens.ali);
    expect(blocked.status).toBe(429);
    expect(blocked.text).toContain("Too many requests");
    expect(blocked.headers.ratelimit).toBeDefined();
    expect((await me(server, tokens.sara)).status).toBe(200);
    expect((await me(server, tokens.admin)).status).toBe(200);
  });
  it("caps unauthenticated requests per IP, without counting verified traffic", async () => {
    const server = serve({ unauthenticated: 3 });
    // Verified requests are released from the IP allowance when they finish.
    expect(
      (await statuses(10, () => me(server, tokens.sara))).every(
        (s) => s === 200,
      ),
    ).toBe(true);
    expect(await statuses(3, () => me(server))).toEqual([401, 401, 401]);
    expect((await me(server, "not-a-token")).status).toBe(429);
    // Another network is unaffected.
    expect((await me(server, null, { ip: "198.51.100.7" })).status).toBe(401);
    // Trade-off: once an IP has sent this many failed requests, everyone on
    // that IP waits for the window, as with the previous per-IP limit.
    expect((await me(server, tokens.sara)).status).toBe(429);
  });
  it("counts disabled accounts and rejected tokens as unauthenticated", async () => {
    const server = serve({ unauthenticated: 2 });
    expect((await me(server, tokens.disabled)).status).toBe(403);
    expect((await me(server, rejected)).status).toBe(401);
    expect((await me(server, tokens.disabled)).status).toBe(429);
  });
  it("ignores forged identity headers and unverified token claims", async () => {
    const server = serve({ perUser: 3 });
    expect(await statuses(3, () => me(server, tokens.ali))).toEqual([
      200, 200, 200,
    ]);
    // Headers naming someone else do not move Ali to another allowance.
    for (const headers of [
      { "X-User-Id": ids.sara },
      { "X-Forwarded-User": ids.admin },
    ])
      expect((await me(server, tokens.ali, { headers })).status).toBe(429);
    // A token whose payload claims Sara is counted as the user Supabase
    // verifies (Ali), so it is blocked too.
    expect((await me(server, forged)).status).toBe(429);
    // A rejected token claiming the admin never touches the admin's allowance.
    expect((await me(server, rejected)).status).toBe(401);
    expect((await me(server, tokens.sara)).status).toBe(200);
    expect((await me(server, tokens.admin)).status).toBe(200);
  });
  it("keeps sign-in routes limited per network, whatever token is sent", async () => {
    const server = serve({ public: 2 });
    const login = (token) =>
      request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "192.0.2.44")
        .set("Authorization", "Bearer " + token)
        .send({});
    expect((await login(tokens.admin)).status).toBe(400);
    expect((await login(tokens.ali)).status).toBe(400);
    expect((await login(tokens.sara)).status).toBe(429);
  });
  it("keeps the strict 30-attempt sign-in limit per network", async () => {
    const server = serve();
    const attempt = () =>
      request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "192.0.2.99")
        .send({ email: "someone@gmail.com" });
    expect((await statuses(30, attempt)).every((s) => s === 400)).toBe(true);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Too many sign-in attempts");
  });
});

// A whole office (two admins, fifteen agents) on the in-memory Supabase from
// the workload simulation, so every route answers as it does in production.
const crew = team({ admins: 2, agents: 15, ip: office });
const [boss, deputy, ...agents] = crew;
function serveCrew(rateLimits, options = {}) {
  const db = fakeSupabase(crew);
  const server = createApp(db, {
    createSignInClient: db.signIn,
    ...(rateLimits ? { rateLimits } : {}),
    ...options,
  }).listen(0);
  servers.push(server);
  return server;
}
const as = (server, person, method, path, ip = person.ip) =>
  request(server)
    [method.toLowerCase()]("/api" + path)
    .set("X-Forwarded-For", ip)
    .set("Authorization", "Bearer " + person.token);
// The draft-8 headers name every policy that counted the request.
const remaining = (res, policy) =>
  Number(new RegExp(`"${policy}"; r=(\\d+)`).exec(res.headers.ratelimit)?.[1]);
const policies = (res) =>
  [...(res.headers["ratelimit-policy"] || "").matchAll(/"([^"]+)"/g)].map(
    ([, name]) => name,
  );
const call = () => ({
  answered: true,
  started_at: new Date(Date.now() - 120000).toISOString(),
  duration_minutes: 2,
  duration_seconds: 0,
  outcome: "Interested",
});
const save = (server, agent, lead = agent.leads[0]) =>
  as(server, agent, "PATCH", "/leads/" + lead).send({ status: "contacted" });

describe("per-user limits for everyone on one office IP", () => {
  it("lets fifteen agents save changes in the same minute without sharing one allowance", async () => {
    // A call log and two status updates each: 45 changes in one minute, more
    // than the 30 the whole office used to share.
    const server = serveCrew();
    const results = await Promise.all(
      agents.map(async (agent) => [
        await as(
          server,
          agent,
          "POST",
          `/leads/${agent.leads[0]}/calls/manual`,
        ).send(call()),
        await save(server, agent),
        await save(server, agent, agent.leads[1]),
      ]),
    );
    for (const response of results.flat()) {
      expect(response.status).toBeLessThan(300);
      expect(policies(response)).toContain("sensitive");
    }
    // Each agent used three of their own thirty.
    expect(results.map((r) => remaining(r[2], "sensitive"))).toEqual(
      Array(15).fill(27),
    );
  });
  it("never lets an admin's activity use up an agent's allowances", async () => {
    const server = serveCrew({
      perUser: 30,
      sensitive: 3,
      reports: 5,
      exports: 2,
    });
    const [agent] = agents;
    // The admin reloads the Overview, exports and bulk-assigns until each
    // policy refuses them, then keeps going until the general one does too.
    const seen = [];
    for (let n = 0; n < 7; n++)
      seen.push((await as(server, boss, "GET", "/dashboard?" + range)).status);
    for (let n = 0; n < 3; n++)
      seen.push(
        (await as(server, boss, "GET", "/reports/export?" + range)).status,
      );
    for (let n = 0; n < 4; n++)
      seen.push(
        (
          await as(server, boss, "POST", "/leads/assign-bulk").send({
            lead_ids: agent.leads.slice(0, 5),
            mode: "agent",
            agent_id: agent.id,
          })
        ).status,
      );
    expect(seen).toEqual([
      ...[200, 200, 200, 200, 200, 429, 429],
      ...[200, 200, 429],
      ...[200, 200, 200, 429],
    ]);
    let general;
    do general = await as(server, boss, "GET", "/me");
    while (general.status === 200);
    expect(general.status).toBe(429);
    expect(remaining(general, "perUser")).toBe(0);
    // An agent on the same IP still has every allowance in full...
    const dashboard = await as(server, agent, "GET", "/dashboard?" + range);
    expect(dashboard.status).toBe(200);
    expect(remaining(dashboard, "perUser")).toBe(29);
    expect(remaining(dashboard, "reports")).toBe(4);
    const saved = await save(server, agent);
    expect(saved.status).toBe(200);
    expect(remaining(saved, "sensitive")).toBe(2);
    // ...and so does the other admin.
    expect(
      (await as(server, deputy, "GET", "/reports/export?" + range)).status,
    ).toBe(200);
  });
  it("limits imports, exports and account creation per admin", async () => {
    const server = serveCrew({ imports: 1, exports: 1, accountCreation: 1 });
    const actions = [
      (admin) =>
        as(server, admin, "POST", "/leads/import").attach(
          "file",
          Buffer.from("Name,Phone\r\nBuyer,03001234567"),
          "leads.csv",
        ),
      (admin) => as(server, admin, "GET", "/reports/sources/export?" + range),
      (admin) => as(server, admin, "POST", "/accounts").send({}),
    ];
    for (const send of actions) {
      expect((await send(boss)).status).not.toBe(429);
      expect((await send(boss)).status).toBe(429);
      expect((await send(deputy)).status).not.toBe(429);
    }
  });
  it("counts authenticator attempts per signed-in agent, not per office", async () => {
    const provider = {
      auth: {
        mfa: {
          challenge: async () => ({ data: { id: "challenge" } }),
          verify: async () => ({ error: { code: "mfa_verification_failed" } }),
        },
      },
    };
    const server = serveCrew(
      { mfaVerify: 3 },
      { createMfaClient: () => provider },
    );
    const attempt = (agent) =>
      as(server, agent, "POST", "/mfa/verify").send({
        factor_id: "f1000000-0000-4000-8000-000000000001",
        code: "123456",
      });
    const seen = [];
    for (let n = 0; n < 4; n++) seen.push((await attempt(agents[0])).status);
    expect(seen).toEqual([400, 400, 400, 429]);
    const colleague = await attempt(agents[1]);
    expect(colleague.status).toBe(400);
    expect(remaining(colleague, "mfaVerify")).toBe(2);
  });
  it("counts invitation set-up per invited employee", async () => {
    const server = serveCrew({ onboarding: 3 });
    const accept = (person) =>
      request(server)
        .post("/api/onboarding/context")
        .set("X-Forwarded-For", office)
        .set("Authorization", "Bearer " + person.token)
        .send({ ticket: "a".repeat(64) });
    const seen = [];
    for (let n = 0; n < 4; n++) seen.push((await accept(agents[0])).status);
    expect(seen).toEqual([200, 200, 200, 429]);
    expect((await accept(agents[1])).status).toBe(200);
  });
});

describe("protection before sign-in", () => {
  const attacker = "198.51.100.66";
  const send = (server, path, body, { ip = attacker, headers = {} } = {}) => {
    const req = request(server)
      .post("/api" + path)
      .set("X-Forwarded-For", ip);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req.send(body);
  };
  const login = (server, person, password, options) =>
    send(
      server,
      "/auth/login",
      { email: person.email, password, portal: person.role },
      options,
    );
  // Headers a client controls. Nginx replaces X-Forwarded-For with the
  // connecting address; even an appended, forged hop is ignored because only
  // the loopback proxy is trusted. The others are never read for limits.
  const forged = (n) =>
    [
      { "X-Forwarded-For": `10.0.0.${n}, ${attacker}` },
      { "X-Real-IP": `10.1.0.${n}` },
      { "CF-Connecting-IP": `10.2.0.${n}` },
      { "True-Client-IP": `10.3.0.${n}` },
      { "X-User-Id": crew[n].id },
      { Authorization: "Bearer " + crew[n].token },
    ][n % 6];
  it("stops password guessing from one network whatever headers it forges", async () => {
    const server = serveCrew({ login: 6 });
    const [target] = agents;
    for (let n = 0; n < 6; n++)
      expect(
        (await login(server, target, "guess-" + n, { headers: forged(n) }))
          .status,
      ).toBe(401);
    const blocked = await login(server, target, "guess", {
      headers: forged(6),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Too many sign-in attempts");
    expect(policies(blocked)).toEqual(["public", "login"]);
    // Even the right password waits for the window on that network, while the
    // office signs in as usual.
    expect((await login(server, target, target.password)).status).toBe(429);
    expect(
      (await login(server, target, target.password, { ip: office })).status,
    ).toBe(200);
  });
  it("does not count colleagues' successful sign-ins against the office", async () => {
    const server = serveCrew({ login: 3 });
    for (const person of crew)
      expect(
        (await login(server, person, person.password, { ip: office })).status,
      ).toBe(200);
    const typos = [];
    for (let n = 0; n < 4; n++)
      typos.push(
        (await login(server, agents[0], "typo", { ip: office })).status,
      );
    expect(typos).toEqual([401, 401, 401, 429]);
  });
  it("limits password reset requests separately and more strictly", async () => {
    const server = serveCrew({ passwordReset: 2 });
    const seen = [];
    for (let n = 0; n < 3; n++)
      seen.push(
        (
          await send(server, "/auth/forgot-password", {
            email: `probe${n}@gmail.com`,
          })
        ).status,
      );
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);
    // Sign-in from that network is counted separately.
    expect((await login(server, agents[0], agents[0].password)).status).toBe(
      200,
    );
  });
  it("caps unverified API requests per network whatever headers are forged", async () => {
    const server = serveCrew({ unauthenticated: 4 });
    const probe = (n, ip = attacker) => {
      const req = request(server).get("/api/me").set("X-Forwarded-For", ip);
      for (const [name, value] of Object.entries({
        ...forged(n),
        Authorization: "Bearer forged-" + n,
      }))
        req.set(name, value);
      return req;
    };
    const seen = [];
    for (let n = 0; n < 5; n++) seen.push((await probe(n)).status);
    expect(seen).toEqual([401, 401, 401, 401, 429]);
    // Another network has its own allowance.
    expect((await probe(1, "198.51.100.67")).status).toBe(401);
  });
});

describe("rate-limit policies by route", () => {
  const [agent] = agents;
  const lead = agent.leads[0];
  const id = "e1000000-0000-4000-8000-000000000001";
  const signedIn = ["unauthenticated", "perUser"];
  it.each([
    ["agent", "GET", "/me", signedIn],
    ["agent", "GET", "/leads?page=1&search=Ahmed", signedIn],
    ["agent", "PATCH", "/leads/" + lead, [...signedIn, "sensitive"]],
    [
      "agent",
      "POST",
      `/leads/${lead}/calls/manual`,
      [...signedIn, "sensitive"],
    ],
    [
      "agent",
      "GET",
      `/documents/${id}/files/${id}/download`,
      [...signedIn, "sensitive"],
    ],
    ["agent", "GET", "/dashboard?" + range, [...signedIn, "reports"]],
    ["agent", "POST", "/mfa/verify", [...signedIn, "mfaVerify"]],
    ["admin", "GET", "/reports?" + range, [...signedIn, "reports"]],
    ["admin", "GET", "/reports/sources?" + range, [...signedIn, "reports"]],
    ["admin", "GET", "/leaderboard?" + range, [...signedIn, "reports"]],
    ["admin", "GET", "/leads/selection?page=1", [...signedIn, "reports"]],
    ["admin", "GET", "/admin/attendance/overview", [...signedIn, "reports"]],
    ["admin", "GET", "/reports/export?" + range, [...signedIn, "exports"]],
    [
      "admin",
      "GET",
      "/reports/sources/export?" + range,
      [...signedIn, "exports"],
    ],
    ["admin", "POST", "/leads/assign-bulk", [...signedIn, "sensitive"]],
    ["admin", "POST", "/leads/import", [...signedIn, "sensitive", "imports"]],
    [
      "admin",
      "POST",
      "/accounts",
      [...signedIn, "sensitive", "accountCreation"],
    ],
    ["agent", "POST", "/onboarding/context", ["public", "onboarding"]],
    [null, "POST", "/auth/login", ["public", "login"]],
    [null, "POST", "/auth/forgot-password", ["public", "passwordReset"]],
    [null, "POST", "/webhooks/mock", ["callbacks"]],
    [null, "GET", "/integrations/meta/callback", ["callbacks"]],
    [null, "POST", "/integrations/meta/webhook", ["metaWebhook"]],
  ])("%s %s %s counts against %j", async (role, method, path, expected) => {
    const server = serveCrew();
    const person = role === "admin" ? boss : agent;
    const response = role
      ? await as(server, person, method, path)
      : await request(server)
          [method.toLowerCase()]("/api" + path)
          .set("X-Forwarded-For", office);
    expect(response.status).not.toBe(429);
    expect(policies(response)).toEqual(expected);
  });
  it("explains a refusal in JSON with the wait and the request ID", async () => {
    const server = serveCrew({ sensitive: 1 });
    const [first] = agents;
    expect((await save(server, first)).status).toBe(200);
    const refused = await save(server, first);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      error: "Too many changes in a short time. Wait a minute and try again.",
      request_id: refused.headers["x-request-id"],
    });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.headers.ratelimit).toContain('"sensitive"; r=0');
  });
});

describe("RATE_LIMIT_* settings", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("override the defaults and can never switch limiting off", () => {
    expect(rateLimitSettings({}).sensitive).toBe(30);
    expect(
      rateLimitSettings({ RATE_LIMIT_SENSITIVE_PER_MIN: "45" }).sensitive,
    ).toBe(45);
    expect(
      rateLimitSettings({ RATE_LIMIT_SENSITIVE_PER_MIN: "" }).sensitive,
    ).toBe(30);
    for (const value of ["0", "-1", "1.5", "abc", "1e3", "100001"])
      expect(() =>
        rateLimitSettings({ RATE_LIMIT_SENSITIVE_PER_MIN: value }),
      ).toThrow("RATE_LIMIT_SENSITIVE_PER_MIN must be a whole number");
    const names = Object.values(rateLimitPolicies).map((p) => p.env);
    expect(new Set(names).size).toBe(names.length);
  });
  it("apply when the API starts", async () => {
    vi.stubEnv("RATE_LIMIT_SENSITIVE_PER_MIN", "2");
    const server = serveCrew();
    const [agent] = agents;
    const seen = [];
    for (let n = 0; n < 3; n++) seen.push((await save(server, agent)).status);
    expect(seen).toEqual([200, 200, 429]);
  });
  it("are all documented with their defaults in .env.example", () => {
    const example = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8",
    );
    for (const { env, limit } of Object.values(rateLimitPolicies))
      expect(example).toContain(`${env}=${limit}\n`);
  });
});
