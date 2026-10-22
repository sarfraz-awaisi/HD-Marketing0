import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, retryQuery } from "../src/lib/api";
import { authErrorMessage } from "../src/lib/authErrors";

vi.mock("../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
      }),
    },
  },
}));
beforeEach(() => vi.stubEnv("VITE_API_URL", "/api"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("login network requests", () => {
  it("preserves import column metadata so the picker can show matching choices", async () => {
    const columns = [
      { index: 0, label: "Customer", suggested: null },
      { index: 1, label: "Mobile", suggested: "phone" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Match file columns",
          code: "IMPORT_COLUMNS_REQUIRED",
          columns,
          format: "xlsx",
          worksheet: "Leads",
        }),
      }),
    );
    const data = new FormData();
    data.append("file", new File(["workbook"], "leads.xlsx"));
    await expect(
      api("/leads/import", { method: "POST", body: data }),
    ).rejects.toMatchObject({
      message: "Match file columns",
      code: "IMPORT_COLUMNS_REQUIRED",
      columns,
      format: "xlsx",
      worksheet: "Leads",
    });
  });
  it("loads the profile through the same origin with the session token", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "agent" }),
    });
    vi.stubGlobal("fetch", fetch);
    expect(await api("/me")).toEqual({ role: "agent" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
      }),
    );
  });
  it("makes a Safari network failure distinguishable from a bad password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Load failed")),
    );
    await expect(api("/me")).rejects.toMatchObject({
      code: "API_UNREACHABLE",
      message: expect.stringContaining("CRM server"),
    });
    expect(
      authErrorMessage({
        name: "AuthRetryableFetchError",
        message: "Load failed",
      }),
    ).toContain("Supabase login");
    expect(authErrorMessage({ message: "Invalid login credentials" })).toBe(
      "Invalid login credentials",
    );
  });
  it("preserves backend authorization errors after successful authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Account disabled or not provisioned" }),
      }),
    );
    await expect(api("/me")).rejects.toThrow(
      "Account disabled or not provisioned",
    );
  });
});

it("explains unconfirmed email and expired confirmation links without accepting them", () => {
  expect(
    authErrorMessage({
      code: "email_not_confirmed",
      message: "Email not confirmed",
    }),
  ).toContain("Confirm your email");
  expect(
    authErrorMessage({
      code: "otp_expired",
      message: "Provider internal error",
    }),
  ).toContain("new confirmation link");
});
describe("refused and failed requests", () => {
  it("explains Nginx's plain-text 429 as too many requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      }),
    );
    await expect(api("/leads")).rejects.toMatchObject({
      status: 429,
      message: "Too many requests. Please wait a moment and try again.",
    });
  });
  it("retries a query once after a network or server error, never after a refusal", () => {
    const failure = (status) => Object.assign(new Error("Failed"), { status });
    for (const status of [400, 401, 403, 404, 429])
      expect(retryQuery(0, failure(status))).toBe(false);
    for (const error of [
      failure(500),
      failure(503),
      Object.assign(new Error("offline"), { code: "API_UNREACHABLE" }),
    ]) {
      expect(retryQuery(0, error)).toBe(true);
      expect(retryQuery(1, error)).toBe(false);
    }
  });
});
