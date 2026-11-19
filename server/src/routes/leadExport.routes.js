import { Router } from "express";
import {
  exportLimit,
  reportLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import { audit } from "../middleware/auditLogger.js";
import { leadExportFilters, leadExportRequest } from "../utils/validators.js";
import { excelTable } from "../utils/excelTable.js";
import {
  pipelineExportColumns,
  pipelineExportSheet,
} from "../services/pipelineExport.js";
import {
  exportFileName,
  exportLeads,
  exportMax,
  exportRpc,
} from "../services/leadExport.js";
// Lead export (updates 073 and 074), mounted at /leads/export for
// administrators only (adminOnly where it is mounted; the database checks
// the administrator again on every call). Sources lists the lead files to
// choose from, with their figures; preview counts the file's leads, its
// assigned leads and the leads the filters match; the export sends those
// leads as one Excel worksheet in the Lead pipeline export's columns, and is
// recorded in Audit history first (filters and counts, never a customer's
// details). Nothing is stored: the file is sent once, with no link to fetch
// it again.
export function leadExportRouter(db) {
  const router = Router();
  const rpc = (req, name, args = {}) =>
    exportRpc(db, name, { p_actor: req.user.id, ...args });

  router.get("/sources", reportLimit, async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(await rpc(req, "lead_export_sources")),
  );
  router.post("/preview", reportLimit, async (req, res) => {
    const filters = leadExportFilters.parse(req.body?.filters ?? {});
    const size = await rpc(req, "lead_file_export_ids", {
      p_query: filters,
      p_ids: false,
    });
    res.set("Cache-Control", "no-store").json({ ...size, max: exportMax });
  });

  router.post("/", sensitiveLimit, exportLimit, async (req, res) => {
    const { filters } = leadExportRequest.parse(req.body);
    const size = await rpc(req, "lead_file_export_ids", {
      p_query: filters,
      p_ids: true,
    });
    if (!size.count)
      throw Object.assign(
        new Error("No assigned leads of this file match these filters."),
        { status: 404 },
      );
    if (size.count > exportMax)
      throw Object.assign(
        new Error(
          `More than ${exportMax.toLocaleString("en-US")} leads match. Choose an agent or narrower filters.`,
        ),
        { status: 413 },
      );
    await audit(db, req, "leads.exported", "leads", null, {
      format: "xlsx",
      layout: "pipeline_columns",
      ...(filters.file ? { files: 1 } : {}),
      filters,
      leads: size.count,
    });
    const rows = await exportLeads(db, req, size.ids);
    res
      .set("Cache-Control", "no-store")
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(exportFileName(filters.file ? size.file?.name : "No file"))
      .send(
        excelTable({
          sheet: "Leads",
          rows: pipelineExportSheet(rows),
          columns: pipelineExportColumns,
        }),
      );
  });
  return router;
}
