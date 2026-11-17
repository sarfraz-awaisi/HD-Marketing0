import { callingProvider } from "../services/cloudCalling.js";
function checked(result) {
  if (result.error) throw new Error("Deleted lead cleanup will retry");
  return result.data;
}
// Erased leads' recordings, queued by the database: each stays queued until
// both Storage and provider deletion have succeeded. One batch of up to 100.
export async function cleanLeadRecordings(db) {
  const queue = checked(await db.rpc("lead_recording_cleanup_batch"));
  for (const row of queue) {
    if (row.storage_path)
      checked(await db.storage.from("recordings").remove([row.storage_path]));
    if (row.provider_ref)
      await callingProvider().deleteRecording(row.provider_ref);
    checked(await db.rpc("lead_recording_cleanup_done", { p_id: row.id }));
  }
  return queue.length;
}
// SQL persists the daily schedule and serializes multiple jobs processes.
// Deleted leads are erased after 14 days (update 069), or later when
// LEAD_DELETE_RETENTION_DAYS says so.
export async function purgeDeletedLeads(db) {
  const retention = Number(process.env.LEAD_DELETE_RETENTION_DAYS || 14);
  if (!Number.isInteger(retention) || retention < 14 || retention > 3650)
    throw new Error("Lead retention must be 14–3650 days");
  const result = checked(
    await db.rpc("purge_deleted_leads", { p_retention: retention }),
  );
  await cleanLeadRecordings(db);
  return result;
}
