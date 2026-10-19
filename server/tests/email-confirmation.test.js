import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmationRedirect,
  sendEmailConfirmation,
} from "../src/services/emailConfirmation.js";
beforeEach(() => {
  vi.stubEnv("FRONTEND_URL", "http://localhost:5173");
});
afterEach(() => vi.unstubAllEnvs());
describe("email confirmation delivery", () => {
  it.each([
    ["http://localhost:5173", "http://localhost:5173/login"],
    ["https://crm.example.test", "https://crm.example.test/login"],
    ["https://example.test/crm/", "https://example.test/crm/login"],
  ])("uses only configured %s redirects", (url, expected) => {
    vi.stubEnv("FRONTEND_URL", url);
    expect(confirmationRedirect()).toBe(expected);
  });
  it.each([
    "javascript:alert(1)",
    "http://crm.example.test",
    "https://user:secret@example.test",
    "https://example.test/?redirect=bad",
    "https://example.test/#bad",
    "not a url",
  ])("refuses unsafe redirect %s", (url) => {
    vi.stubEnv("FRONTEND_URL", url);
    expect(() => confirmationRedirect()).toThrow("Configure FRONTEND_URL");
  });
  it("does not generate or expose a confirmation token", async () => {
    const resend = vi.fn(async () => ({ data: {}, error: null }));
    expect(
      await sendEmailConfirmation({ auth: { resend } }, "owner@example.test"),
    ).toBeUndefined();
    expect(resend).toHaveBeenCalledWith({
      type: "signup",
      email: "owner@example.test",
      options: { emailRedirectTo: "http://localhost:5173/login" },
    });
  });
  it.each([
    { status: 429 },
    { code: "over_email_send_rate_limit" },
    { code: "over_request_rate_limit" },
  ])("handles mail throttling safely: %j", async (error) => {
    const resend = vi.fn(async () => ({
      error: { ...error, message: "private provider details" },
    }));
    await expect(
      sendEmailConfirmation({ auth: { resend } }, "owner@example.test"),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("rate-limited"),
    });
  });
  it.each([false, true])(
    "handles mail/provider failure without raw private details (throws=%s)",
    async (throws) => {
      const resend = vi.fn(async () => {
        if (throws)
          throw Object.assign(new Error("secret owner@example.test"), {
            status: 503,
          });
        return { error: { message: "secret owner@example.test" } };
      });
      await expect(
        sendEmailConfirmation({ auth: { resend } }, "owner@example.test"),
      ).rejects.toMatchObject({
        status: 503,
        message:
          "Verification email could not be sent. Check Supabase email delivery settings, then resend from Accounts.",
      });
    },
  );
});

it("requires an explicit HTTPS CRM origin when sending production confirmations", () => {
  vi.stubEnv("NODE_ENV", "production");
  for (const url of ["", "http://localhost:5173", "http://crm.example.test"]) {
    vi.stubEnv("FRONTEND_URL", url);
    expect(() => confirmationRedirect()).toThrow("Configure FRONTEND_URL");
  }
  vi.stubEnv("FRONTEND_URL", "https://crm.example.test");
  expect(confirmationRedirect()).toBe("https://crm.example.test/login");
});
