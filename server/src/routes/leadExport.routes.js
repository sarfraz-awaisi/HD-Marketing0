import { Router } from "express";
import { utils, write } from "xlsx";
import {
  exportLimit,
  reportLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import { audit } from "../middleware/auditLogger.js";
import { csvCell } from "../utils/phoneMask.js";
import { leadExportFilters, leadExportRequest } from "../utils/validators.js";
import { pkDateTime, pkToday } from "../services/pipelineExport.js";
import {
  adQuality,
  adQualityHeadings,
  assignmentHeadings,
  assignmentRow,
  callHeadings,
  callRow,
  definitions,
  exportLimits,
  exportRpc,
  exportSize,
  fileHeadings,
  fileRows,
  filterLines,
  leadBatches,
  noteHeadings,
  noteRow,
  recordBatches,
  sheetTitles,
  summaryHeadings,
  summaryRow,
} from "../services/leadExport.js";
// Lead export (update 073), mounted at /leads/export for administrators
// only (adminOnly where it is mounted; the database checks the
// administrator again on every call). Sources lists the files to choose;
// preview counts what the filters match; the export sends one Excel file
// with the chosen worksheets, or one worksheet as CSV, and is recorded in
// Audit history first (filters and counts, never a customer's details).
// Nothing is stored: the file is sent once, with no link to fetch it again.
const fileTypes = { sheets: "Google Sheet", csv: "CSV", xlsx: "Excel" };
const fileLabel = (f) =>
  `${f.name} (${fileTypes[f.format] ?? f.format}${f.sheet ? `, tab ${f.sheet.worksheet}` : ""})`;
// Excel: plain values only, so no cell is ever a formula; columns wide
// enough for their headings.
function workbook(sheets) {
  const book = utils.book_new();
  for (const [title, rows] of sheets) {
    const sheet = utils.aoa_to_sheet(rows);
    sheet["!cols"] = (rows[0] || []).map((h) => ({
      wch: Math.min(48, Math.max(12, String(h).length + 2)),
    }));
    utils.book_append_sheet(book, sheet, title);
  }
  return write(book, { type: "buffer", bookType: "xlsx" });
}

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
    const size = await rpc(req, "lead_export_ids", {
      p_query: filters,
      p_ids: false,
    });
    res
      .set("Cache-Control", "no-store")
      .json({ ...size, limits: exportLimits });
  });

  router.post("/", sensitiveLimit, exportLimit, async (req, res) => {
    const body = leadExportRequest.parse(req.body);
    const { filters, format } = body;
    const sheets =
      format === "csv"
        ? [body.sheet]
        : Object.keys(sheetTitles).filter(
            (s) => s !== "readme" && body.sheets.includes(s),
          );
    const size = await rpc(req, "lead_export_ids", {
      p_query: filters,
      p_ids: true,
    });
    if (!size.count)
      throw Object.assign(new Error("No leads match these filters."), {
        status: 404,
      });
    const tooBig = exportSize(size, format, sheets);
    if (tooBig) throw Object.assign(new Error(tooBig), { status: 413 });
    const sources = await rpc(req, "lead_export_sources");
    const ids = size.ids;
    await audit(db, req, "leads.exported", "leads", null, {
      preset: body.preset ?? null,
      format,
      sheets,
      filters,
      leads: size.count,
      files: Object.keys(size.files).filter((k) => k !== "none").length,
      no_file_leads: size.files.none ?? 0,
      ...(sheets.includes("calls") ? { calls: size.calls } : {}),
      ...(sheets.includes("notes") ? { notes: size.notes } : {}),
      ...(sheets.includes("assignments")
        ? { assignments: size.assignments }
        : {}),
    });
    // Phone numbers only for the Lead summary.
    const withPhones = sheets.includes("summary");
    const leads = () => leadBatches(db, req, ids, withPhones);
    const calls = () =>
      recordBatches(db, req, "lead_export_calls", ids, {
        p_from: filters.calls_from ?? null,
        p_to: filters.calls_to ?? null,
      });
    const name = `hd-leads-${body.preset ?? "export"}-${pkToday()}`;
    res.set("Cache-Control", "no-store");

    if (format === "csv") {
      const sheet = sheets[0];
      // Written as it is read, a batch at a time.
      const write = (rows) =>
        res.write(
          rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
        );
      const streamed = {
        summary: [summaryHeadings, leads, summaryRow],
        calls: [callHeadings, calls, callRow],
        notes: [
          noteHeadings,
          () => recordBatches(db, req, "lead_export_notes", ids),
          noteRow,
        ],
        assignments: [
          assignmentHeadings,
          () => recordBatches(db, req, "lead_export_assignments", ids),
          assignmentRow,
        ],
      };
      if (sheet === "ad_quality" || sheet === "files") {
        let rows;
        if (sheet === "files")
          rows = [fileHeadings, ...fileRows(sources, size.files)];
        else {
          const all = [];
          for await (const batch of leadBatches(db, req, ids, false))
            all.push(...batch);
          rows = [adQualityHeadings, ...adQuality(all)];
        }
        res.type("text/csv").attachment(`${name}-${sheet}.csv`);
        write(rows);
        return res.end();
      }
      const [headings, batches, toRow] = streamed[sheet];
      res.type("text/csv").attachment(`${name}-${sheet}.csv`);
      write([headings]);
      try {
        for await (const batch of batches())
          if (batch.length) write(batch.map(toRow));
      } catch (error) {
        // The file has started: end it unfinished rather than pass it off
        // as complete.
        console.error(
          JSON.stringify({ event: "lead_export_failed", id: req.id }),
        );
        return res.destroy(error);
      }
      return res.end();
    }

    // Excel: every chosen worksheet, built before anything is sent.
    const out = [];
    const names = {
      files: Object.fromEntries(sources.files.map((f) => [f.id, fileLabel(f)])),
      agent: null,
    };
    if (filters.agent) {
      const { data } = await db
        .from("profiles")
        .select("name")
        .eq("id", filters.agent)
        .maybeSingle();
      names.agent = data?.name ?? null;
    }
    out.push([
      sheetTitles.readme,
      [
        ["HD Marketing CRM: lead export"],
        ["Exported", pkDateTime(new Date())],
        ["By", req.user.name ?? req.user.email ?? req.user.id],
        ["Leads", size.count],
        ...filterLines(filters, names),
        [],
        ["What the columns mean"],
        ...definitions,
      ],
    ]);
    let rows = [];
    if (sheets.includes("summary") || sheets.includes("ad_quality"))
      for await (const batch of leads()) rows.push(...batch);
    if (rows.length && rows.length !== size.count)
      throw Object.assign(
        new Error(
          "Some leads changed while the file was being prepared. Export again.",
        ),
        { status: 409 },
      );
    if (sheets.includes("summary"))
      out.push([
        sheetTitles.summary,
        [summaryHeadings, ...rows.map(summaryRow)],
      ]);
    for (const [sheet, headings, batches, toRow] of [
      ["calls", callHeadings, calls, callRow],
      [
        "notes",
        noteHeadings,
        () => recordBatches(db, req, "lead_export_notes", ids),
        noteRow,
      ],
      [
        "assignments",
        assignmentHeadings,
        () => recordBatches(db, req, "lead_export_assignments", ids),
        assignmentRow,
      ],
    ]) {
      if (!sheets.includes(sheet)) continue;
      const lines = [headings];
      for await (const batch of batches()) lines.push(...batch.map(toRow));
      out.push([sheetTitles[sheet], lines]);
    }
    if (sheets.includes("ad_quality"))
      out.push([
        sheetTitles.ad_quality,
        [adQualityHeadings, ...adQuality(rows)],
      ]);
    if (sheets.includes("files"))
      out.push([
        sheetTitles.files,
        [fileHeadings, ...fileRows(sources, size.files)],
      ]);
    rows = null;
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(name + ".xlsx")
      .send(workbook(out));
  });
  return router;
}
