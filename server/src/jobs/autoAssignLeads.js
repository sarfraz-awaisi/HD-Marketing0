import { runAutoAssign } from "../services/autoAssign.js";
// Update 091: automatic lead distribution. Runs only when JOBS_ENABLED
// names autoAssignLeads; the settings (on, paused, off) are the
// administrators', so a running worker with the setting off assigns
// nothing. Each run assigns the complete batches waiting, as the
// administrator who saved the settings.
export async function autoAssignLeads(db) {
  const result = await runAutoAssign(db, null, "job:auto-assign");
  if (result.status === "failed") throw new Error("Automatic batch failed");
  return result;
}
