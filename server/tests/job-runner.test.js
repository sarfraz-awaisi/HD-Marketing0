import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  db: { rpc: vi.fn() },
  jobs: Array.from({ length: 9 }, () => vi.fn()),
}));
vi.mock("../src/config/supabaseAdmin.js", () => ({
  getAdmin: () => fixture.db,
}));
vi.mock("../src/jobs/deleteOldRecordings.js", () => ({
  deleteOldRecordings: fixture.jobs[0],
}));
vi.mock("../src/jobs/reportInactiveLeadOwners.js", () => ({
  reportInactiveLeadOwners: fixture.jobs[1],
}));
vi.mock("../src/jobs/leadResponseCheck.js", () => ({
  leadResponseCheck: fixture.jobs[2],
}));
vi.mock("../src/jobs/followUpReminders.js", () => ({
  followUpReminders: fixture.jobs[3],
}));
vi.mock("../src/jobs/missingOutcomeCheck.js", () => ({
  missingOutcomeCheck: fixture.jobs[4],
}));
vi.mock("../src/jobs/cleanupPropertyPhotos.js", () => ({
  cleanupPropertyPhotos: fixture.jobs[5],
}));
vi.mock("../src/jobs/cleanupKnowledgeFiles.js", () => ({
  cleanupKnowledgeFiles: fixture.jobs[6],
}));
vi.mock("../src/jobs/purgeDeletedLeads.js", () => ({
  purgeDeletedLeads: async () => ({ skipped: true }),
}));
vi.mock("../src/jobs/processMetaLeads.js", () => ({
  processMetaLeads: fixture.jobs[7],
}));
vi.mock("../src/jobs/attendanceReconciliation.js", () => ({
  attendanceReconciliation: fixture.jobs[8],
}));
beforeEach(() => {
  vi.resetModules();
  fixture.db.rpc.mockReset().mockResolvedValue({ data: null });
  for (const job of fixture.jobs) job.mockReset().mockResolvedValue({});
  vi.spyOn(process, "once").mockReturnValue(process);
  vi.spyOn(globalThis, "setTimeout").mockReturnValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("durable Meta work alongside existing maintenance jobs", () => {
  it("continues lead processing when an earlier storage job throws, without logging its secret error", async () => {
    fixture.jobs[0].mockRejectedValue(
      new Error("private-token-provider-response"),
    );
    await import("../src/jobs/runner.js");
    expect(fixture.jobs[7]).toHaveBeenCalledWith(fixture.db);
    expect(fixture.jobs.every((job) => job.mock.calls.length === 1)).toBe(true);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(
      "private-token",
    );
    expect(setTimeout).toHaveBeenCalledOnce();
  });
  it("continues retention and ingestion after an earlier database job reports failure", async () => {
    fixture.jobs[5].mockResolvedValue({
      error: { message: "private database details" },
    });
    await import("../src/jobs/runner.js");
    expect(fixture.jobs[6]).toHaveBeenCalledOnce();
    expect(fixture.jobs[7]).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(
      "private database",
    );
  });
});
describe("background jobs in LOCAL_DEV_ONLY development", () => {
  beforeEach(() => {
    vi.stubEnv("LOCAL_DEV_ONLY", "true");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.spyOn(globalThis, "setInterval").mockReturnValue(0);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("stays idle and runs no job unless RUN_LOCAL_JOBS is set", async () => {
    // The idle runner never finishes importing, so it is not awaited.
    import("../src/jobs/runner.js");
    await vi.waitFor(() =>
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("RUN_LOCAL_JOBS=true"),
      ),
    );
    expect(fixture.jobs.every((job) => job.mock.calls.length === 0)).toBe(
      true,
    );
    expect(fixture.db.rpc).not.toHaveBeenCalled();
  });
  it("runs the jobs against local Supabase when RUN_LOCAL_JOBS=true", async () => {
    vi.stubEnv("RUN_LOCAL_JOBS", "true");
    await import("../src/jobs/runner.js");
    expect(fixture.jobs.every((job) => job.mock.calls.length === 1)).toBe(true);
  });
  it("refuses to start when the settings point at hosted Supabase", async () => {
    vi.stubEnv("RUN_LOCAL_JOBS", "true");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    await expect(import("../src/jobs/runner.js")).rejects.toThrow(
      "LOCAL_DEV_ONLY",
    );
    expect(fixture.jobs.every((job) => job.mock.calls.length === 0)).toBe(
      true,
    );
  });
});
