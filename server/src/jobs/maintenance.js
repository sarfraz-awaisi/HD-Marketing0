import { recordJob } from "../services/systemStatus.js";

// Update 080: the jobs a worker runs come only from JOBS_ENABLED, a comma
// list of known job names. Unset or empty runs none; an unknown name stops
// the worker before it does anything.
export function selectJobs(value, known) {
  const names = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length)
    throw new Error(
      `Unknown job in JOBS_ENABLED: ${unknown.join(", ")}. Known jobs: ${known.join(", ")}.`,
    );
  return [...new Set(names)];
}

// The single worker lease (update 080). `hold()` takes or renews it and is
// true only while this worker has it; `release()` gives it up at shutdown.
export function workerLease(db, holder, seconds, jobs) {
  return {
    async hold() {
      const { data, error } = await db.rpc("worker_lease", {
        p_holder: holder,
        p_seconds: seconds,
        p_jobs: jobs,
      });
      return !error && data === true;
    },
    async release() {
      await db.rpc("worker_lease_release", { p_holder: holder });
    },
  };
}

// `beforeJob` runs before each job; returning false ends the tick (the
// lease was lost), so a stale worker stops between jobs.
export function createJobRunner(db, jobs, logger = console, { beforeJob } = {}) {
  let running = false;
  return async function tick() {
    if (running) return;
    running = true;
    try {
      for (const [name, job] of jobs) {
        if (beforeJob && !(await beforeJob(name))) {
          logger.error("worker lease lost; stopping before", name);
          return;
        }
        let success = false;
        try {
          const result = await job(db);
          if (result?.error) throw new Error("Job database failure");
          success = true;
          logger.log(name, "finished");
        } catch {
          logger.error(name, "failed; will retry next interval");
        }
        try {
          await recordJob(db, name, success);
        } catch {
          logger.error(
            name,
            "monitoring unavailable; check database update 026",
          );
        }
      }
    } finally {
      running = false;
    }
  };
}
