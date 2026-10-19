import { callingProvider } from "../services/cloudCalling.js";
function checked(result) {
  if (result.error) throw new Error("Deleted lead cleanup will retry");
  return result.data;
}
// SQL persists the daily schedule and serializes multiple jobs processes. Storage
// work stays queued until both Storage and provider deletion have succeeded.
export async function purgeDeletedLeads(db) {
  const retention = Number(process.env.LEAD_DELETE_RETENTION_DAYS || 30);
  if (!Number.isInteger(retention) || retention < 30 || retention > 3650)
    throw new Error("Lead retention must be 30–3650 days");
  const result = checked(
    await db.rpc("purge_deleted_leads", { p_retention: retention }),
  );
  const queue = checked(await db.rpc("lead_recording_cleanup_batch"));
  for (const row of queue) {
    if (row.storage_path)
      checked(await db.storage.from("recordings").remove([row.storage_path]));
    if (row.provider_ref)
      await callingProvider().deleteRecording(row.provider_ref);
    checked(await db.rpc("lead_recording_cleanup_done", { p_id: row.id }));
  }
  return result;
}
