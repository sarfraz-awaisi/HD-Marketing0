import { unwrap } from "../routes/crm.routes.js";
import { callingProvider } from "../services/cloudCalling.js";
export async function deleteOldRecordings(db) {
  const days = Number(process.env.RECORDING_RETENTION_DAYS || 7);
  if (!Number.isInteger(days) || days < 1 || days > 7)
    throw new Error("Recording retention must be between 1 and 7 days");
  const rows = unwrap(await db.rpc("recording_batch", { p_days: days }));
  for (const r of rows) {
    try {
      if (r.storage_path)
        unwrap(await db.storage.from("recordings").remove([r.storage_path]));
      if (r.provider_ref)
        await callingProvider().deleteRecording(r.provider_ref);
      unwrap(
        await db.rpc("recording_deleted", { p_call: r.call_id, p_error: null }),
      );
    } catch {
      unwrap(
        await db.rpc("recording_deleted", {
          p_call: r.call_id,
          p_error: "Deletion failed; retry required",
        }),
      );
    }
  }
  return { processed: rows.length };
}
