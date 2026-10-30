import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { requireLocalDevelopment } from "../../scripts/local-only.js";
import { seedLocal, sampleProperty } from "../../scripts/seed-local.js";

const local = {
  LOCAL_DEV_ONLY: "true",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-test-key",
};
const unsafe = [
  { LOCAL_DEV_ONLY: undefined },
  { LOCAL_DEV_ONLY: "false" },
  { SUPABASE_URL: undefined },
  { SUPABASE_URL: "https://example.supabase.co" },
  { SUPABASE_URL: "http://127.0.0.1.evil.test:54321" },
  { SUPABASE_URL: "http://127.0.0.1@evil.test:54321" },
  { VITE_SUPABASE_URL: "https://example.supabase.co" },
  { NODE_ENV: "production" },
];

describe("local development isolation", () => {
  it("accepts only explicitly opted-in local configuration", () => {
    expect(() => requireLocalDevelopment(local)).not.toThrow();
    for (const override of unsafe)
      expect(() =>
        requireLocalDevelopment({ ...local, ...override }),
      ).toThrow();
  });
  it.each([
    "setup-dev.js",
    "verify-live.js",
    "send-mock-event.js",
    "seed-local.js",
  ])(
    "%s refuses missing opt-in and hosted targets before any request",
    (script) => {
      for (const override of [unsafe[0], unsafe[3]]) {
        const env = { PATH: process.env.PATH, ...local, ...override };
        if (env.LOCAL_DEV_ONLY === undefined) delete env.LOCAL_DEV_ONLY;
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url))],
          {
            env,
            encoding: "utf8",
            timeout: 5000,
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("LOCAL_DEV_ONLY:");
      }
    },
  );
  it("rejects unsafe seed configuration before constructing a client", async () => {
    const factory = vi.fn();
    for (const override of unsafe)
      await expect(
        seedLocal({ ...local, ...override }, factory),
      ).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("adds the local fixture once and preserves an existing matching record", async () => {
    const rows = [];
    const insert = vi.fn(async (row) => {
      rows.push({ ...row });
      return { error: null };
    });
    const db = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({ limit: async () => ({ data: rows, error: null }) }),
        }),
        insert,
      })),
    };
    const factory = vi.fn(() => db);
    await seedLocal(local, factory);
    rows[0].description = "Locally edited";
    await seedLocal(local, factory);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(sampleProperty);
    expect(rows[0].description).toBe("Locally edited");
    expect(factory.mock.calls[0][0]).toBe(local.SUPABASE_URL);
  });
  it("does not insert when the existing-data lookup fails", async () => {
    const insert = vi.fn();
    const factory = () => ({
      from: () => ({
        insert,
        select: () => ({ eq: () => ({ limit: async () => ({ error: {} }) }) }),
      }),
    });
    await expect(seedLocal(local, factory)).rejects.toThrow("lookup failed");
    expect(insert).not.toHaveBeenCalled();
  });
  it("keeps SQL bundles and automatic CLI seeding free of demo records", async () => {
    const read = (name) =>
      readFile(new URL(`../../${name}`, import.meta.url), "utf8");
    expect(await read("supabase/setup.sql")).not.toContain(
      "Development sample property",
    );
    expect(await read("supabase/seed.sql")).not.toMatch(/insert\s+into/i);
    expect(await read("supabase/config.toml")).toMatch(
      /\[db.seed\]\s*enabled = false/,
    );
  });
});
