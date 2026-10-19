import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { normalizePhone, phoneMask, csvCell } from "../src/utils/phoneMask.js";
import { verifySignature } from "../src/routes/webhooks.routes.js";
import { createHmac } from "node:crypto";
import { deleteOldRecordings } from "../src/jobs/deleteOldRecordings.js";
const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Agent",
  role: "agent",
  active: true,
};
const leadId = "22222222-2222-4222-8222-222222222222";
function dbFake(profile = agent) {
  const rpc = vi.fn(async (name) =>
    name === "lead_contact_phones"
      ? { error: { code: "P0002" } }
      : { data: {}, error: null },
  );
  const db = {
    auth: {
      getUser: vi.fn(async (token) =>
        token === "valid"
          ? {
              data: {
                user: {
                  id: agent.id,
                  email_confirmed_at: "2026-10-01T00:00:00Z",
                },
              },
            }
          : { data: {}, error: { message: "expired" } },
      ),
    },
    rpc,
    from: vi.fn((table) => {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: profile }),
        maybeSingle: async () => ({ data: null }),
      };
      return q;
    }),
  };
  return db;
}
describe("API access boundaries", () => {
  it("health is public and contains no credentials", async () => {
    const r = await request(createApp(trustedMfaFixture(dbFake()))).get(
      "/health",
    );
    expect(r.body).toEqual({ status: "ok" });
  });
  it.each([undefined, "bad", "expired"])(
    "rejects absent/invalid/expired token %s",
    async (token) => {
      let r = request(createApp(trustedMfaFixture(dbFake()))).get("/api/me");
      if (token) r = r.set("Authorization", "Bearer " + token);
      expect((await r).status).toBe(401);
    },
  );
  it("checks disabled profile even with valid token", async () => {
    const r = await request(
      createApp(trustedMfaFixture(dbFake({ ...agent, active: false }))),
    )
      .get("/api/me")
      .set("Authorization", "Bearer valid");
    expect(r.status).toBe(403);
  });
  it.each(["agent", "admin"])(
    "accepts only the saved %s role for its selected login portal",
    async (role) => {
      const profile = { ...agent, role };
      const app = createApp(trustedMfaFixture(dbFake(profile)));
      const matching = await request(app)
        .get(`/api/me?portal=${role}`)
        .set("Authorization", "Bearer valid");
      expect(matching.status).toBe(200);
      expect(matching.body).toMatchObject(profile);
      const other = role === "agent" ? "admin" : "agent";
      const denied = await request(app)
        .get(`/api/me?portal=${other}`)
        .set("Authorization", "Bearer valid");
      expect(denied.status).toBe(403);
      expect(denied.body.error).toContain("Choose the correct portal");
      expect(denied.body).not.toHaveProperty("role");
      expect(denied.headers["cache-control"]).toBe("no-store");
    },
  );
  it.each([
    "portal=owner",
    "portal=admin&portal=agent",
    "portal[role]=admin",
    "portal=admin&role=admin",
  ])("rejects malformed portal selection %s", async (query) => {
    const response = await request(createApp(trustedMfaFixture(dbFake())))
      .get(`/api/me?${query}`)
      .set("Authorization", "Bearer valid");
    expect(response.status).toBe(400);
  });
  it("keeps portal checks behind authentication and active-account checks", async () => {
    for (const role of ["admin", "agent"]) {
      expect(
        (
          await request(createApp(trustedMfaFixture(dbFake()))).get(
            `/api/me?portal=${role}`,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request(
            createApp(
              trustedMfaFixture(dbFake({ ...agent, role, active: false })),
            ),
          )
            .get(`/api/me?portal=${role}`)
            .set("Authorization", "Bearer valid")
        ).status,
      ).toBe(403);
    }
  });
  it("refuses agent team and audit endpoints", async () => {
    const app = createApp(trustedMfaFixture(dbFake()));
    for (const path of ["/api/users", "/api/audit"])
      expect(
        (await request(app).get(path).set("Authorization", "Bearer valid"))
          .status,
      ).toBe(403);
  });
  it("cannot call or read another agent lead", async () => {
    const db = dbFake();
    const app = createApp(trustedMfaFixture(db));
    for (const path of [
      "/api/leads/" + leadId,
      "/api/leads/" + leadId + "/timeline",
      "/api/leads/" + leadId + "/phone",
    ])
      expect(
        (await request(app).get(path).set("Authorization", "Bearer valid"))
          .status,
      ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/leads/" + leadId + "/call")
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(404);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith(
      "lead_contact_phones",
      expect.objectContaining({ p_leads: [leadId], p_actor: agent.id }),
    );
  });
  it("rejects role escalation and arbitrary lead changes", async () => {
    const db = dbFake();
    const app = createApp(trustedMfaFixture(db));
    expect(
      (
        await request(app)
          .patch("/api/users/" + agent.id)
          .set("Authorization", "Bearer valid")
          .send({ role: "admin" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/leads/" + leadId)
          .set("Authorization", "Bearer valid")
          .send({ name: "Override" })
      ).status,
    ).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects unverified webhook with no secret", async () => {
    delete process.env.WEBHOOK_SECRET;
    process.env.CALL_PROVIDER = "mock";
    expect(
      (
        await request(createApp(trustedMfaFixture(dbFake())))
          .post("/api/webhooks/mock")
          .send({ event_id: "a" })
      ).status,
    ).toBe(401);
  });
});
describe("phone and export safety", () => {
  it("normalizes equivalent Pakistani numbers", () => {
    expect(normalizePhone("0300 1234567")).toBe(
      normalizePhone("+92 300 1234567"),
    );
    expect(phoneMask(normalizePhone("03001234567"))).not.toContain("1234567");
    expect(() => normalizePhone("abc")).toThrow();
  });
  it("escapes spreadsheet formulas and quotes", () => {
    expect(csvCell("=CMD()")).toBe('"\'=CMD()"');
    expect(csvCell('hello "there"')).toBe('"hello ""there"""');
    expect(csvCell("  +1")).toContain("'");
  });
  it("requires matching HMAC", () => {
    const raw = Buffer.from('{"event_id":"1"}');
    const sign =
      "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifySignature(raw, sign, "secret")).toBe(true);
    expect(verifySignature(Buffer.from("{}"), sign, "secret")).toBe(false);
    expect(verifySignature(raw, sign, "")).toBe(false);
  });
});
describe("recording deletion", () => {
  it("deletes the actual object before marking metadata", async () => {
    const remove = vi.fn(async () => ({ data: [] }));
    const rpc = vi.fn(async (name) => ({
      data:
        name === "recording_batch"
          ? [{ call_id: leadId, storage_path: "expired.mp3" }]
          : null,
    }));
    await deleteOldRecordings({ rpc, storage: { from: () => ({ remove }) } });
    expect(remove).toHaveBeenCalledWith(["expired.mp3"]);
    expect(rpc).toHaveBeenLastCalledWith("recording_deleted", {
      p_call: leadId,
      p_error: null,
    });
  });
  it("records safe failure so next run can retry", async () => {
    const rpc = vi.fn(async (name) => ({
      data:
        name === "recording_batch"
          ? [{ call_id: leadId, storage_path: "old" }]
          : null,
    }));
    await deleteOldRecordings({
      rpc,
      storage: {
        from: () => ({ remove: async () => ({ error: { code: "503" } }) }),
      },
    });
    expect(rpc).toHaveBeenLastCalledWith("recording_deleted", {
      p_call: leadId,
      p_error: "Deletion failed; retry required",
    });
  });
});
