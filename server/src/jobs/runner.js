import { purgeDeletedLeads } from "./purgeDeletedLeads.js";
import { getAdmin } from "../config/supabaseAdmin.js";
import { deleteOldRecordings } from "./deleteOldRecordings.js";
import { leadResponseCheck } from "./leadResponseCheck.js";
import { attendanceReconciliation } from "./attendanceReconciliation.js";
import { reportInactiveLeadOwners } from "./reportInactiveLeadOwners.js";
import { followUpReminders } from "./followUpReminders.js";
import { missingOutcomeCheck } from "./missingOutcomeCheck.js";
import { cleanupPropertyPhotos } from "./cleanupPropertyPhotos.js";
import { cleanupKnowledgeFiles } from "./cleanupKnowledgeFiles.js";
import { processMetaLeads } from "./processMetaLeads.js";
import { validateRuntime } from "../config/runtime.js";
import { createJobRunner } from "./maintenance.js";
validateRuntime();
// Local development runs no jobs unless RUN_LOCAL_JOBS=true. The process stays
// idle rather than exiting, because `npm run dev` stops every stream when one
// exits (concurrently -k).
if (
  process.env.LOCAL_DEV_ONLY === "true" &&
  process.env.RUN_LOCAL_JOBS !== "true"
) {
  console.log(
    "Background jobs are off for local development. Set RUN_LOCAL_JOBS=true in .env to run them against local Supabase.",
  );
  const idle = setInterval(() => {}, 60 * 60 * 1000);
  const exit = () => (clearInterval(idle), process.exit(0));
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
  await new Promise(() => {});
}
const db = getAdmin();
const tick = createJobRunner(db, [
  ["deleteOldRecordings", deleteOldRecordings],
  ["reportInactiveLeadOwners", reportInactiveLeadOwners],
  ["leadResponseCheck", leadResponseCheck],
  ["followUpReminders", followUpReminders],
  ["missingOutcomeCheck", missingOutcomeCheck],
  ["cleanupPropertyPhotos", cleanupPropertyPhotos],
  ["cleanupKnowledgeFiles", cleanupKnowledgeFiles],
  ["processMetaLeads", processMetaLeads],
  ["attendanceReconciliation", attendanceReconciliation],
]);
async function scheduledTick() {
  await tick();
  try {
    await purgeDeletedLeads(db);
  } catch {
    console.error("Deleted lead purge/cleanup pending; jobs will retry");
  }
}
// A single timer includes purge work, and shutdown waits for the whole tick.
let stopping = false;
let timer;
let pending;
function stop() {
  stopping = true;
  clearTimeout(timer);
  // Do not force-exit while an external write may still be committing.
  pending?.finally(() => process.exit(0));
  if (!pending) process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
async function loop() {
  pending = scheduledTick();
  await pending;
  pending = null;
  if (!stopping)
    timer = setTimeout(
      loop,
      Math.max(10, Number(process.env.JOB_INTERVAL_SECONDS || 60)) * 1000,
    );
}
await loop();
