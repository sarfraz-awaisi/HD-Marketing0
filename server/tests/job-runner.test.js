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
  vi.spyOn(globalThis, "setInterval").mockReturnValue(0);
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
    expect(setInterval).toHaveBeenCalledOnce();
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
