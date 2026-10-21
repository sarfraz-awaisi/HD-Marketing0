import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
// Several employees behind one office IP. Requests arrive through Caddy on
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
