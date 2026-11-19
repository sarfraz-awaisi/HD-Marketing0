import { pipelineExportMax, pkToday, withDetails } from "./pipelineExport.js";
// Lead export (updates 073 and 074): an administrator downloads one lead
// file's leads (a Google Sheet, an imported CSV or Excel file, or the leads
// with no file) that are assigned to an agent now, every one of them whether
// the agent has called it or not, in exactly the Lead pipeline export's
// columns, on one worksheet. The database matches the leads
// (lead_file_export_ids) and reads each one as the Lead pipeline reads a
// lead (lead_file_export_rows: the agent's own calls and notes, the
// temperature of the current assignment); withDetails and
// pipelineExportSheet then add and write everything else, the same code the
// Lead pipeline export runs. The leads are a snapshot of IDs taken first;
// if one left the file's assigned leads meanwhile, the export stops and
// asks to be done again, so the file always has the count shown.
export const exportMax = pipelineExportMax;
const batchSize = 500;

export async function exportRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : error.code === "42501"
      ? 403
      : error.code === "P0002"
        ? 404
        : error.code === "22023"
          ? 400
          : 503;
  throw Object.assign(
    new Error(
      missing
        ? "Lead export needs CRM database update 074."
        : status === 503
          ? "The export could not be prepared. Please try again."
          : error.message,
    ),
    { status },
  );
}

// The snapshot's leads, 500 at a time, then everything the Lead pipeline
// export adds to a lead: its full phone number (recorded as viewed), its
// own record and its advertisement inquiries.
export async function exportLeads(db, req, ids) {
  const leads = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const rows = await exportRpc(db, "lead_file_export_rows", {
      p_actor: req.user.id,
      p_ids: batch,
    });
    if (rows.length !== batch.length)
      throw Object.assign(
        new Error(
          "Some leads changed (deleted, restored or unassigned) while the file was being prepared. Export again.",
        ),
        { status: 409 },
      );
    leads.push(...rows);
  }
  return withDetails(db, req, leads);
}

// "General-Form-Leads-Assigned-2026-11-19.xlsx": the file's name in letters
// and digits only, and the day in Pakistan.
export function exportFileName(name, day = pkToday()) {
  const safe = String(name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return `${safe || "Leads"}-Assigned-${day}.xlsx`;
}
