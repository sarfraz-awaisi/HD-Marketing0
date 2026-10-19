import { recordJob } from "../services/systemStatus.js";
export function createJobRunner(db, jobs, logger = console) {
  let running = false;
  return async function tick() {
    if (running) return;
    running = true;
    try {
      for (const [name, job] of jobs) {
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
