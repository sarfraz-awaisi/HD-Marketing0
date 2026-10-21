import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("POST /api/auth/forgot-password", () => {
  const adminId = "a7000000-0000-4000-8000-000000000001";
  const agentId = "a7000000-0000-4000-8000-000000000002";
  const disabledAdminId = "a7000000-0000-4000-8000-000000000003";

  const users = [
    { id: adminId, email: "admin@example.com" },
    { id: agentId, email: "agent@example.com" },
    { id: disabledAdminId, email: "disabled-admin@example.com" },
  ];

  const profiles = {
    [adminId]: { id: adminId, role: "admin", active: true },
    [agentId]: { id: agentId, role: "agent", active: true },
    [disabledAdminId]: { id: disabledAdminId, role: "admin", active: false },
  };

  function createTestDb(resetMock = vi.fn().mockResolvedValue({ error: null })) {
    return {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({
            data: { users },
            error: null,
          })),
        },
        resetPasswordForEmail: resetMock,
      },
      from: (table) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: (_col, id) => ({
                single: async () => ({
                  data: profiles[id] || null,
                  error: profiles[id] ? null : { message: "Not found" },
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
      rpc: vi.fn(),
    };
  }

  it("rejects missing or invalid email addresses", async () => {
    const db = createTestDb();
    const app = createApp(db);

    const r1 = await request(app)
      .post("/api/auth/forgot-password")
      .send({});
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "notanemail" });
    expect(r2.status).toBe(400);
  });

  it("returns 404 for an unregistered email address without sending a reset link", async () => {
    const resetMock = vi.fn();
    const db = createTestDb(resetMock);
    const app = createApp(db);

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "unknown@example.com" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not registered");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("blocks agent email from resetting password with 403 and never calls resetPasswordForEmail", async () => {
    const resetMock = vi.fn();
    const db = createTestDb(resetMock);
    const app = createApp(db);

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "agent@example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("only available for administrator accounts");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("blocks disabled administrator accounts from resetting password", async () => {
    const resetMock = vi.fn();
    const db = createTestDb(resetMock);
    const app = createApp(db);

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "disabled-admin@example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("disabled");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("sends password reset link when valid active administrator email is provided", async () => {
    const resetMock = vi.fn().mockResolvedValue({ error: null });
    const db = createTestDb(resetMock);
    const app = createApp(db);

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "admin@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("check your inbox");
    expect(resetMock).toHaveBeenCalledWith(
      "admin@example.com",
      expect.objectContaining({ redirectTo: expect.any(String) }),
    );
  });
});
