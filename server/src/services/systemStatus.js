export const systemJobs = [
  "deleteOldRecordings",
  "reportInactiveLeadOwners",
  "leadResponseCheck",
  "followUpReminders",
  "missingOutcomeCheck",
  "cleanupPropertyPhotos",
  "cleanupKnowledgeFiles",
  "processMetaLeads",
  "attendanceReconciliation",
];
export async function recordJob(db, job, success) {
  const result = await db.rpc("record_job_heartbeat", {
    p_job: job,
    p_success: success,
  });
  if (result.error) throw new Error("Job monitoring could not be saved.");
}
export async function systemStatus(db, actor) {
  try {
    const { data, error } = await db.rpc("system_status", { p_actor: actor });
    if (error || !data) {
      const missing = ["PGRST202", "PGRST205", "42883", "42P01"].includes(
        error?.code,
      );
      return {
        ready: false,
        database: !missing && error ? "unavailable" : "reachable",
        migration: missing ? "update_required" : "unavailable",
        expected_version: 26,
        jobs: [],
        last_job_at: null,
        backup: null,
        message: missing
          ? "System monitoring needs database update 026 after 025."
          : "System status could not be confirmed.",
      };
    }
    return { ...data, database: "reachable", expected_version: 26 };
  } catch {
    return {
      ready: false,
      database: "unavailable",
      migration: "unavailable",
      expected_version: 26,
      jobs: [],
      last_job_at: null,
      backup: null,
      message: "System status could not be confirmed.",
    };
  }
}
