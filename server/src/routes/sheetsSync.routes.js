import express, { Router } from "express";
import { z } from "zod";
import { sheetsSyncLimit } from "../middleware/rateLimit.js";
import {
  metaLeadId,
  pendingBody,
  readSheetRow,
  reportBody,
  rowsBody,
  sheetsRpc,
  syncKeyHash,
} from "../services/sheetsImport.js";
// The Google Apps Script's endpoint (update 056), apart from CRM sign-in: the
// integration key is its only credential and acts as the administrator who
// created it. Mounted before the signed-in API; app.js counts refused keys
// per address, and each key has its own allowance (sheetsSync).
const source = z.string().uuid();
const refused = (message, status, code) =>
  Object.assign(new Error(message), { status, code });
export function sheetsSyncRouter(db) {
  const router = Router();
  // Production is reached through Nginx, which reports the scheme; a key sent
  // over plain HTTP is refused before it is checked.
  router.use((req, _res, next) =>
    next(
      process.env.NODE_ENV === "production" && !req.secure
        ? refused("HTTPS is required.", 403, "SHEETS_HTTPS_REQUIRED")
        : undefined,
    ),
  );
  router.use(async (req, _res, next) => {
    const hash = syncKeyHash(req.get("authorization"));
    if (!hash)
      return next(
        refused("Invalid integration key.", 401, "SHEETS_INVALID_KEY"),
      );
    const { key } = await sheetsRpc(db, "sheet_sync_auth", {
      p_key_hash: hash,
    });
    req.sheetsKey = { id: key, hash };
    req.rateLimitIntegration = key;
    next();
  });
  router.use(sheetsSyncLimit);
  // A row batch is at most 100 rows; the body is read only for a valid key.
  router.use(express.json({ limit: "1mb" }));
  router.get("/sources", async (req, res) =>
    res.json({
      ...(await sheetsRpc(db, "sheet_sync_sources", {
        p_key_hash: req.sheetsKey.hash,
      })),
      limits: { rows: 100, ids: 10000 },
    }),
  );
  // Which of the Sheet's Meta lead IDs are not imported yet, by position.
  router.post("/sources/:id/pending", async (req, res) => {
    const { ids } = pendingBody.parse(req.body);
    const { pending } = await sheetsRpc(db, "sheet_sync_pending", {
      p_key_hash: req.sheetsKey.hash,
      p_source: source.parse(req.params.id),
      p_ids: ids.map(metaLeadId),
    });
    res.json({ pending: pending.map((n) => n - 1) });
  });
  router.post("/sources/:id/rows", async (req, res) => {
    const { rows } = rowsBody.parse(req.body);
    const result = await sheetsRpc(db, "sheet_sync_import", {
      p_key_hash: req.sheetsKey.hash,
      p_source: source.parse(req.params.id),
      p_rows: rows.map(readSheetRow),
      p_request: req.id,
    });
    if (result.blocked)
      throw refused(
        "This Sheet's lead file was deleted. Restore it, or choose Start a new lead file in the CRM.",
        409,
        "SHEETS_FILE_DELETED",
      );
    res.json({ summary: result.summary, rows: result.rows });
  });
  router.post("/sources/:id/report", async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_sync_report", {
        p_key_hash: req.sheetsKey.hash,
        p_source: source.parse(req.params.id),
        p_report: reportBody.parse(req.body),
      }),
    ),
  );
  return router;
}
