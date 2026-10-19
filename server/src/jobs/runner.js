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
await scheduledTick();
setInterval(
  scheduledTick,
  Math.max(10, Number(process.env.JOB_INTERVAL_SECONDS || 60)) * 1000,
);
