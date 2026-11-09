import { Router } from "express";
import { z } from "zod";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import {
  newSyncKey,
  sheetsRpc,
  sourceCreate,
  sourceUpdate,
} from "../services/sheetsImport.js";
// Administrators' Google Sheets settings (update 056), mounted behind
// adminOnly: the Sheets, their lead files and counts, rejected rows, and the
// integration key. The database checks the administrator again.
const uuid = z.string().uuid();
export function sheetsAdminRouter(db) {
  const router = Router();
  router.get("/", async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_sources_overview", { p_actor: req.user.id }),
    ),
  );
  router.post("/sources", sensitiveLimit, async (req, res) => {
    const { spreadsheet, ...data } = sourceCreate.parse(req.body);
    res.status(201).json(
      await sheetsRpc(db, "sheet_source_save", {
        p_actor: req.user.id,
        p_source: null,
        p_data: { ...data, spreadsheet_id: spreadsheet },
        p_request: req.id,
      }),
    );
  });
  router.patch("/sources/:id", sensitiveLimit, async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_source_save", {
        p_actor: req.user.id,
        p_source: uuid.parse(req.params.id),
        p_data: sourceUpdate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.get("/sources/:id/rejections", async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_source_rejections", {
        p_actor: req.user.id,
        p_source: uuid.parse(req.params.id),
      }),
    ),
  );
  router.post("/sources/:id/new-file", sensitiveLimit, async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_source_new_file", {
        p_actor: req.user.id,
        p_source: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    ),
  );
  // The key is returned this once; the CRM keeps only its hash.
  router.post("/key", sensitiveLimit, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body || {});
    const { key, hash, hint } = newSyncKey();
    const saved = await sheetsRpc(db, "sheet_sync_key_create", {
      p_actor: req.user.id,
      p_hash: hash,
      p_hint: hint,
      p_request: req.id,
    });
    res.status(201).json({ ...saved, key });
  });
  router.delete("/key", sensitiveLimit, async (req, res) =>
    res.json(
      await sheetsRpc(db, "sheet_sync_key_revoke", {
        p_actor: req.user.id,
        p_request: req.id,
      }),
    ),
  );
  return router;
}
