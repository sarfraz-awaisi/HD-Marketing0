import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
const admin = "d1000000-0000-4000-8000-000000000001",
  agent = "d1000000-0000-4000-8000-000000000002";
const profiles = {
  [admin]: {
    id: admin,
    uid: 741205,
    name: "Admin",
    role: "admin",
    active: true,
  },
  [agent]: {
    id: agent,
    uid: 583214,
    name: "Agent",
    role: "agent",
    active: true,
  },
};
// Unsigned JWT-shaped token; only Supabase (mocked here) decides validity.
const jwt = (sub, exp = Math.floor(Date.now() / 1000) + 600) =>
  [
    "e30",
    Buffer.from(JSON.stringify({ sub, exp })).toString("base64url"),
    "sig",
  ].join(".");
function fixture({ verified = {}, delay = 30 } = {}) {
  const events = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const db = {
    auth: {
      // Native verification is slow and resolves to the token's real owner.
      getUser: vi.fn(async (token) => {
        events.push("getUser:start");
        await Promise.race([gate, new Promise((r) => setTimeout(r, delay))]);
        events.push("getUser:end");
        const id = verified[token];
        return id
          ? {
              data: {
                user: {
                  id,
                  email: id + "@gmail.com",
                  email_confirmed_at: "2026-10-17T00:00:00Z",
                },
              },
            }
          : { data: { user: null }, error: { status: 401 } };
      }),
      getClaims: vi.fn(async (token) => ({
        data: { claims: { sub: verified[token], aal: "aal1" } },
      })),
    },
    from: vi.fn(() => {
      let id;
      const q = {
        select: () => q,
        eq: (_, value) => ((id = value), q),
        single: async () => {
          events.push("profile:" + id);
          return profiles[id]
            ? { data: profiles[id] }
            : { data: null, error: { code: "PGRST116" } };
        },
      };
      return q;
    }),
    rpc: vi.fn(async (name, args) => {
      events.push(name + ":" + args.p_actor);
      return { data: { reset_pending: false, reset_after: null } };
    }),
  };
  return { db, events, release };
}
describe("parallel request authentication", () => {
  it("starts profile reads while Supabase verifies the token", async () => {
    const token = jwt(admin);
    const { db, events } = fixture({ verified: { [token]: admin } });
    const me = await request(createApp(db))
      .get("/api/me")
      .set("Authorization", "Bearer " + token);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: admin, uid: 741205, role: "admin" });
    expect(events.indexOf("profile:" + admin)).toBeLessThan(
      events.indexOf("getUser:end"),
    );
    // Administrator sign-in never calls the MFA SQL functions.
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("reads an agent's MFA state only after the token is verified", async () => {
    const token = jwt(agent);
    const { db, events } = fixture({ verified: { [token]: agent } });
    const me = await request(createApp(db))
      .get("/api/me?portal=agent")
      .set("Authorization", "Bearer " + token);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: agent, role: "agent", uid: 583214 });
    expect(events.indexOf("mfa_session_state:" + agent)).toBeGreaterThan(
      events.indexOf("getUser:end"),
    );
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("uses only the verified user when a token names someone else", async () => {
    // The token claims to be the admin, but Supabase verifies it as the agent.
    const token = jwt(admin);
    const { db } = fixture({ verified: { [token]: agent } });
    const me = await request(createApp(db))
      .get("/api/me")
      .set("Authorization", "Bearer " + token);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: agent, role: "agent" });
    expect(me.body.role).not.toBe("admin");
    const admin_only = await request(createApp(db))
      .get("/api/users")
      .set("Authorization", "Bearer " + token);
    expect(admin_only.status).toBe(403);
  });
  it("refuses an unverified token even when its early reads succeed", async () => {
    const token = jwt(admin);
    const { db } = fixture({ verified: {} });
    const me = await request(createApp(db))
      .get("/api/me")
      .set("Authorization", "Bearer " + token);
    expect(me.status).toBe(401);
    expect(me.body).not.toHaveProperty("role");
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["an expired token", jwt(admin, Math.floor(Date.now() / 1000) - 60)],
    ["a malformed token", "not-a-jwt"],
  ])("verifies %s first without early reads", async (_, token) => {
    const { db, events } = fixture({ verified: { [token]: admin } });
    const me = await request(createApp(db))
      .get("/api/me")
      .set("Authorization", "Bearer " + token);
    expect(me.status).toBe(200);
    expect(events.indexOf("getUser:end")).toBeLessThan(
      events.indexOf("profile:" + admin),
    );
  });
});
