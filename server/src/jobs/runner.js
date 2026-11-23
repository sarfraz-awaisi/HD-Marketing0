import { purgeDeletedLeads } from "./purgeDeletedLeads.js";
import { getAdmin } from "../config/supabaseAdmin.js";
import { deleteOldRecordings } from "./deleteOldRecordings.js";
import { leadResponseCheck } from "./leadResponseCheck.js";
import { attendanceReconciliation } from "./attendanceReconciliation.js";
import { reportInactiveLeadOwners } from "./reportInactiveLeadOwners.js";
import { followUpReminders } from "./followUpReminders.js";
import { missingOutcomeCheck } from "./missingOutcomeCheck.js";
import { cleanupPropertyPhotos } from "./cleanupPropertyPhotos.js";
import { cleanupPropertyDocuments } from "./cleanupPropertyDocuments.js";
import { cleanupKnowledgeFiles } from "./cleanupKnowledgeFiles.js";
import { processMetaLeads } from "./processMetaLeads.js";
import { validateRuntime } from "../config/runtime.js";
import { randomUUID } from "node:crypto";
import { createJobRunner, selectJobs, workerLease } from "./maintenance.js";
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
// Every job this worker knows. Update 080: only those named in JOBS_ENABLED
// run (none when it is unset), so a worker can be started for Meta leads
// alone (JOBS_ENABLED=processMetaLeads) without touching any backlog.
const allJobs = [
  ["deleteOldRecordings", deleteOldRecordings],
  ["reportInactiveLeadOwners", reportInactiveLeadOwners],
  ["leadResponseCheck", leadResponseCheck],
  ["followUpReminders", followUpReminders],
  ["missingOutcomeCheck", missingOutcomeCheck],
  ["cleanupPropertyPhotos", cleanupPropertyPhotos],
  ["cleanupPropertyDocuments", cleanupPropertyDocuments],
  ["cleanupKnowledgeFiles", cleanupKnowledgeFiles],
  ["processMetaLeads", processMetaLeads],
  ["attendanceReconciliation", attendanceReconciliation],
  ["purgeDeletedLeads", purgeDeletedLeads],
];
let enabled;
try {
  enabled = selectJobs(
    process.env.JOBS_ENABLED,
    allJobs.map(([name]) => name),
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const interval = Math.max(10, Number(process.env.JOB_INTERVAL_SECONDS || 60));
// One worker at a time: the lease lasts three intervals (at least two
// minutes) and is renewed before every job.
const lease = workerLease(db, randomUUID(), Math.max(120, interval * 3), enabled);
console.log(
  enabled.length
    ? `Jobs enabled: ${enabled.join(", ")}`
    : "No jobs enabled (JOBS_ENABLED is empty); the worker only holds its lease.",
);
const tick = createJobRunner(
  db,
  allJobs.filter(([name]) => enabled.includes(name)),
  console,
  { beforeJob: () => lease.hold() },
);
let waiting = false;
async function scheduledTick() {
  if (!(await lease.hold())) {
    if (!waiting) console.error("Another worker holds the lease; waiting.");
    waiting = true;
    return;
  }
  waiting = false;
  await tick();
}
// Shutdown waits for the current tick, then gives the lease up.
let stopping = false;
let timer;
let pending;
function stop() {
  stopping = true;
  clearTimeout(timer);
  // Do not force-exit while an external write may still be committing.
  const done = () =>
    lease
      .release()
      .catch(() => {})
      .finally(() => process.exit(0));
  if (pending) pending.finally(done);
  else done();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
async function loop() {
  pending = scheduledTick();
  await pending;
  pending = null;
  if (!stopping) timer = setTimeout(loop, interval * 1000);
}
await loop();
