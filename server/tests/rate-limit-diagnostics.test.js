import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  rateLimitLogInterval,
  routeCategory,
} from "../src/middleware/rateLimit.js";
import { fakeSupabase, office as team } from "./office-fixture.js";
// Rate-limit diagnostics: every refusal by the real limiters, through the
// real app, writes one "rate_limited" line naming the policy and the subject
// it counted (a verified user's ID, or the client address that the trusted
// loopback proxy reported), at most once a minute for one subject. Never a
// password, token, cookie, header, query or body. The office's address
// arrives as Nginx sends it in production: X-Forwarded-For over loopback.
const officeIp = "203.0.113.10";
const crew = team({ admins: 1, agents: 3, ip: officeIp });
const [boss, ali, sara, omar] = crew;
const servers = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
function serve(rateLimits, { now, db = fakeSupabase(crew) } = {}) {
  const lines = [];
  const server = createApp(db, {
    createSignInClient: db.signIn,
    rateLimits,
    rateLimitDiagnostics: {
      write: (event) => lines.push(JSON.parse(JSON.stringify(event))),
      ...(now ? { now } : {}),
    },
  }).listen(0);
  servers.push(server);
  return { server, lines };
}
const as = (server, person, method, path, ip = person.ip) =>
  request(server)
    [method]("/api" + path)
    .set("X-Forwarded-For", ip)
    .set("Authorization", "Bearer " + person.token)
    .set("Cookie", "sb-session=secret-cookie-value");
const repeat = async (n, send) => {
  const statuses = [];
  for (let i = 0; i < n; i++) statuses.push((await send()).status);
  return statuses;
};
// Nothing a request carries that could identify a secret or a customer.
const secrets = [
  ...crew.map((p) => p.token),
  ...crew.map((p) => p.password),
  ...crew.map((p) => p.email),
  "secret-cookie-value",
  "Bearer",
  "923001234567",
  "Ayesha",
];
const leaks = (lines) => {
  const text = JSON.stringify(lines);
  return secrets.filter((s) => text.includes(s));
};

describe("rate-limit diagnostics", () => {
  it("per user: names the employee over the limit, not the office address; colleagues on the same IP carry on", async () => {
    const { server, lines } = serve({ perUser: 4 });
    expect(await repeat(4, () => as(server, ali, "get", "/me"))).toEqual(
      Array(4).fill(200),
    );
    const refused = await as(server, ali, "get", "/me");
    expect(refused.status).toBe(429);
    // Colleagues on the same office IP, an admin included.
    for (const person of [sara, omar, boss])
      expect((await as(server, person, "get", "/me")).status).toBe(200);
    expect(lines).toEqual([
      {
        event: "rate_limited",
        at: expect.any(String),
        source: "api",
        policy: "perUser",
        per: "user",
        limit: 4,
        window_minutes: 15,
        method: "GET",
        route: "/api/me",
        authenticated: true,
        user_id: ali.id,
        retry_after_s: expect.any(Number),
        refusals_this_minute: 1,
        repeated: 0,
        request_id: refused.body.request_id,
      },
    ]);
    expect(lines[0]).not.toHaveProperty("client_ip");
    expect(Date.parse(lines[0].at)).toBeGreaterThan(Date.now() - 60000);
    expect(lines[0].retry_after_s).toBeGreaterThan(800);
  });
  it("sensitive changes: the route with its IDs and query left out", async () => {
    const { server, lines } = serve({ sensitive: 2 });
    const lead = ali.leads[0];
    const save = () =>
      as(
        server,
        ali,
        "patch",
        `/leads/${lead}?search=Ayesha&phone=%2B923001234567`,
      ).send({ status: "contacted", notes: "Ayesha +923001234567" });
    await repeat(2, save);
    expect((await save()).status).toBe(429);
    expect(lines).toMatchObject([
      {
        policy: "sensitive",
        per: "user",
        route: "/api/leads/:id",
        method: "PATCH",
        user_id: ali.id,
      },
    ]);
    expect(leaks(lines)).toEqual([]);
  });
  it("failed sign-ins: counted per network; the address comes from the trusted proxy, never a forged header", async () => {
    const { server, lines } = serve({ login: 3 });
    const guess = (headers = {}) => {
      const req = request(server)
        .post("/api/auth/login")
        // The client forges a hop; Nginx appends the real connecting address.
        .set("X-Forwarded-For", `10.9.9.9, ${officeIp}`)
        .set("X-Real-IP", "10.8.8.8")
        .set("CF-Connecting-IP", "10.7.7.7");
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      return req.send({
        email: ali.email,
        password: "wrong-" + ali.password,
        portal: "agent",
      });
    };
    expect(await repeat(3, () => guess())).toEqual([401, 401, 401]);
    expect((await guess()).status).toBe(429);
    expect(lines).toMatchObject([
      {
        policy: "login",
        per: "ip",
        client_ip: officeIp,
        authenticated: false,
        route: "/api/auth/login",
        limit: 3,
      },
    ]);
    expect(lines[0]).not.toHaveProperty("user_id");
    expect(leaks(lines)).toEqual([]);
    // The forged hop never reaches the log, only the address the proxy saw.
    expect(JSON.stringify(lines)).not.toContain("10.9.9.9");
  });
  it("unauthenticated requests: the network's allowance, recorded as not signed in", async () => {
    const { server, lines } = serve({ unauthenticated: 3 });
    const anon = () =>
      request(server)
        .get("/api/leads/all?search=Ayesha")
        .set("X-Forwarded-For", "198.51.100.7")
        .set("Authorization", "Bearer not-a-valid-token");
    expect(await repeat(3, anon)).toEqual([401, 401, 401]);
    expect((await anon()).status).toBe(429);
    // Signed-in colleagues elsewhere are untouched.
    expect((await as(server, sara, "get", "/me")).status).toBe(200);
    expect(lines).toMatchObject([
      {
        policy: "unauthenticated",
        per: "ip",
        client_ip: "198.51.100.7",
        authenticated: false,
        route: "/api/leads/all",
      },
    ]);
    expect(leaks(lines)).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain("not-a-valid-token");
  });
  it("a flood shows at once (first, 10th, 100th… refusal of a minute) and then once a minute, never line by line", async () => {
    let clock = Date.now();
    const { server, lines } = serve(
      { unauthenticated: 1 },
      { now: () => clock },
    );
    const anon = () =>
      request(server).get("/api/me").set("X-Forwarded-For", "192.0.2.50");
    await anon();
    expect(await repeat(40, anon)).toEqual(Array(40).fill(429));
    // 40 refusals in one minute: the first, and the 10th with the 8 held
    // back between them.
    expect(
      lines.map((l) => [l.refusals_this_minute, l.repeated, l.client_ip]),
    ).toEqual([
      [1, 0, "192.0.2.50"],
      [10, 8, "192.0.2.50"],
    ]);
    clock += rateLimitLogInterval;
    expect((await anon()).status).toBe(429);
    // The next minute's first line carries the 30 held back after the 10th.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({
      policy: "unauthenticated",
      client_ip: "192.0.2.50",
      refusals_this_minute: 1,
      repeated: 30,
    });
    // Another address gets its own line at once.
    await request(server).get("/api/me").set("X-Forwarded-For", "192.0.2.51");
    expect(
      (
        await request(server)
          .get("/api/me")
          .set("X-Forwarded-For", "192.0.2.51")
      ).status,
    ).toBe(429);
    expect(lines.map((l) => l.client_ip)).toEqual([
      "192.0.2.50",
      "192.0.2.50",
      "192.0.2.50",
      "192.0.2.51",
    ]);
  });
  it("a failure to write the line never changes the refusal", async () => {
    const db = fakeSupabase(crew);
    const server = createApp(db, {
      createSignInClient: db.signIn,
      rateLimits: { perUser: 1 },
      rateLimitDiagnostics: {
        write: () => {
          throw new Error("log unavailable");
        },
      },
    }).listen(0);
    servers.push(server);
    expect((await as(server, ali, "get", "/me")).status).toBe(200);
    const refused = await as(server, ali, "get", "/me");
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      error: "Too many requests. Please wait a moment and try again.",
      request_id: expect.any(String),
    });
  });
  it("Google Sheets: a refused key counts per address; an accepted key per integration, never the key itself", async () => {
    const db = fakeSupabase(crew);
    const rpc = db.rpc.bind(db);
    const keyId = "5e600000-0000-4000-8000-000000000001";
    db.rpc = (name, args) =>
      name === "sheet_sync_auth"
        ? Promise.resolve({ data: { key: keyId } })
        : name === "sheet_sync_sources"
          ? Promise.resolve({
              data: { now: new Date().toISOString(), sources: [] },
            })
          : rpc(name, args);
    const { server, lines } = serve(
      { sheetsSyncAuth: 2, sheetsSync: 2 },
      { db },
    );
    const secret = "hdcrm_sheets_" + "k".repeat(43);
    const sync = (key, ip) =>
      request(server)
        .get("/api/integrations/sheets-sync/sources")
        .set("X-Forwarded-For", ip)
        .set("Authorization", key ? "Bearer " + key : "");
    expect(await repeat(2, () => sync(null, "198.51.100.20"))).toEqual([
      401, 401,
    ]);
    expect((await sync(null, "198.51.100.20")).status).toBe(429);
    expect(await repeat(2, () => sync(secret, "34.1.2.3"))).toEqual([200, 200]);
    expect((await sync(secret, "34.1.2.4")).status).toBe(429);
    expect(lines).toMatchObject([
      { policy: "sheetsSyncAuth", per: "ip", client_ip: "198.51.100.20" },
      {
        policy: "sheetsSync",
        per: "integration",
        integration: keyId,
        route: "/api/integrations/sheets-sync/sources",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });
  it("a refused request still gets its JSON answer, and allowed requests write nothing", async () => {
    const { server, lines } = serve({ perUser: 2 });
    await repeat(2, () => as(server, boss, "get", "/me"));
    expect(lines).toEqual([]);
    const refused = await as(server, boss, "get", "/me");
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      error: "Too many requests. Please wait a moment and try again.",
      request_id: expect.any(String),
    });
    expect(refused.headers["retry-after"]).toBeDefined();
    expect(refused.headers["ratelimit-policy"]).toContain('"perUser"');
    expect(lines).toHaveLength(1);
  });
  it("normalises routes: path words stay; IDs, numbers and query strings never reach the log", () => {
    const route = (originalUrl) => routeCategory({ originalUrl });
    expect(
      route(
        "/api/leads/7c0a8f1e-1234-4abc-8def-0123456789ab/assign?phone=%2B923001234567",
      ),
    ).toBe("/api/leads/:id/assign");
    expect(route("/api/leads/HD-000123")).toBe("/api/leads/:id");
    expect(route("/api/leads/all?search=Ayesha")).toBe("/api/leads/all");
    expect(route("/api/integrations/sheets-sync/sources/3f2a/rows")).toBe(
      "/api/integrations/sheets-sync/sources/:id/rows",
    );
  });
});
