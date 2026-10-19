import { afterEach, describe, it, expect, vi } from "vitest";
import { purgeDeletedLeads } from "../src/jobs/purgeDeletedLeads.js";
afterEach(() => vi.unstubAllEnvs());
describe("durable deleted-lead cleanup job", () => {
  it("cleans queued storage before acknowledging and uses the 30-day default", async () => {
    const remove = vi.fn(async () => ({})),
      rpc = vi.fn(async (name) => ({
        data:
          name === "lead_recording_cleanup_batch"
            ? [{ id: "entry", storage_path: "fixture/path" }]
            : { purged: 1 },
      }));
    await purgeDeletedLeads({ rpc, storage: { from: () => ({ remove }) } });
    expect(rpc).toHaveBeenCalledWith("purge_deleted_leads", {
      p_retention: 30,
    });
    expect(remove).toHaveBeenCalledWith(["fixture/path"]);
    expect(rpc).toHaveBeenLastCalledWith("lead_recording_cleanup_done", {
      p_id: "entry",
    });
  });
  it("retains the durable cleanup item on storage failure and retries even when the daily SQL run is skipped", async () => {
    const rpc = vi.fn(async (name) => ({
      data:
        name === "lead_recording_cleanup_batch"
          ? [{ id: "entry", storage_path: "fixture/path" }]
          : { skipped: true },
    }));
    await expect(
      purgeDeletedLeads({
        rpc,
        storage: {
          from: () => ({ remove: async () => ({ error: { code: "503" } }) }),
        },
      }),
    ).rejects.toThrow("retry");
    expect(
      rpc.mock.calls.some(([name]) => name === "lead_recording_cleanup_done"),
    ).toBe(false);
  });
  it.each(["0", "29", "not-a-number", "3651"])(
    "refuses invalid retention %s before querying",
    async (value) => {
      vi.stubEnv("LEAD_DELETE_RETENTION_DAYS", value);
      const rpc = vi.fn();
      await expect(purgeDeletedLeads({ rpc })).rejects.toThrow("retention");
      expect(rpc).not.toHaveBeenCalled();
    },
  );
});
