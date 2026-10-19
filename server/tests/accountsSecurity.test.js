import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));
import { verifyAdminPassword } from "../src/services/accountsSecurity.js";
let db, verifier;
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://isolated-auth.example.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "isolated-service-key");
  db = {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: { user: { id: "admin-id", email: "trusted@example.test" } },
        }),
      },
    },
  };
  verifier = {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({
        data: {
          user: { id: "admin-id" },
          session: { access_token: "temporary" },
        },
      }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  };
  createClient.mockReset().mockReturnValue(verifier);
});
afterEach(() => vi.unstubAllEnvs());
describe("Accounts PIN current-password verification", () => {
  it("uses a separate nonpersistent Auth client and revokes only its temporary session", async () => {
    expect(await verifyAdminPassword(db, "admin-id", "entered-password")).toBe(
      true,
    );
    expect(db.auth.admin.getUserById).toHaveBeenCalledWith("admin-id");
    expect(createClient).toHaveBeenCalledWith(
      "https://isolated-auth.example.test",
      "isolated-service-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    expect(verifier.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "trusted@example.test",
      password: "entered-password",
    });
    expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(db.auth.signInWithPassword).toBeUndefined();
  });
  it("rejects a successful sign-in for a different user and still revokes it", async () => {
    verifier.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: "another-user" },
        session: { access_token: "temporary" },
      },
    });
    expect(await verifyAdminPassword(db, "admin-id", "password")).toBe(false);
    expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("rejects failed credential verification without assuming a session exists", async () => {
    verifier.auth.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid credentials" },
      data: { user: null, session: null },
    });
    expect(await verifyAdminPassword(db, "admin-id", "wrong-password")).toBe(
      false,
    );
    expect(verifier.auth.signOut).not.toHaveBeenCalled();
  });
  it("requires a trusted account email before trying a password", async () => {
    db.auth.admin.getUserById.mockResolvedValue({
      error: { message: "Unavailable" },
      data: { user: null },
    });
    expect(await verifyAdminPassword(db, "admin-id", "password")).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("does not replace a verified result when temporary-session cleanup fails", async () => {
    verifier.auth.signOut.mockRejectedValue(new Error("Unavailable"));
    expect(await verifyAdminPassword(db, "admin-id", "password")).toBe(true);
  });
});
