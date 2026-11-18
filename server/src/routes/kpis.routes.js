import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { adminOnly } from "../middleware/role.js";
import { reportLimit, sensitiveLimit } from "../middleware/rateLimit.js";
import {
  uuid,
  kpiCreate,
  kpiUpdate,
  kpiArchive,
  kpiAnswers,
  kpiReportQuery,
  kpiMyQuery,
  kpiEvidenceLink,
  kpiVisitPhoto,
  kpiEvidenceQuery,
  kpiInventoryQuery,
  kpiEvidenceReview,
  kpiInventoryReview,
} from "../utils/validators.js";
import {
  evidenceLink,
  fileHash,
  signatureType,
} from "../services/kpiEvidence.js";
import {
  kpiRpc,
  kpiList,
  agentDay,
  agentHistory,
  kpiReport,
  pkToday,
  weekStart,
  addDays,
} from "../services/kpis.js";
// Daily KPIs (update 070), after the shared auth middleware. Administrators
// manage KPIs and see everyone; an agent answers and sees only their own
// (req.user). The SQL functions check the person, the day and every answer
// again, so a request cannot act for someone else.
// Update 072: evidence for the KPIs the CRM fills in. Agents add links and
// visit photos and see only their own; administrators review everyone's.
// Photos stay in the private kpi-evidence bucket and are shown through
// short-lived signed links.
const noBody = z.object({}).strict();
const evidenceBucket = (db) => db.storage.from("kpi-evidence");
const PHOTO_LIMIT = 5 * 1024 * 1024;
const agentOnly = (req, res, next) =>
  req.user.role === "agent"
    ? next()
    : res.status(403).json({ error: "Agent access required" });

export function kpisRouter(db) {
  const router = Router();
  const rpc = (req, name, args) =>
    kpiRpc(db, name, { p_actor: req.user.id, ...args });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_LIMIT, files: 1, fields: 4 },
  });
  // multer's own "File too large" becomes the limit in words.
  const photoUpload = (req, res, next) =>
    upload.single("file")(req, res, (error) =>
      next(
        error?.code === "LIMIT_FILE_SIZE"
          ? Object.assign(
              new Error("Upload a JPEG, PNG or WebP photo up to 5 MB"),
              { status: 413 },
            )
          : error,
      ),
    );
  // An agent's day, with the 14 days before it for their history, and the
  // evidence and listings behind the KPIs the CRM fills in: the week's
  // links and photos, and the day's listings.
  const myDay = async (req, day) => {
    const from = [weekStart(day), addDays(day, -13)].sort()[0];
    const facts = await rpc(req, "kpi_facts", {
      p_from: from,
      p_to: day,
      p_agent: req.user.id,
    });
    const result = {
      ...agentDay(facts, req.user.id, day),
      history: agentHistory(facts, req.user.id, addDays(day, -13), day),
    };
    const uses = new Set(result.kpis.map((k) => k.measure));
    if (["social", "visits", "video"].some((m) => uses.has(m)))
      result.evidence = (
        await rpc(req, "kpi_evidence_list", {
          p_query: {
            from: weekStart(day),
            to: addDays(weekStart(day), 6),
            limit: 100,
          },
        })
      ).data;
    if (uses.has("inventory"))
      result.inventory = (
        await rpc(req, "kpi_inventory_list", {
          p_query: { from: day, to: day, limit: 50 },
        })
      ).data;
    return result;
  };

  router.get("/manage", adminOnly, async (req, res) =>
    res.json(kpiList(await rpc(req, "kpi_admin_list", {}))),
  );
  router.post("/", adminOnly, sensitiveLimit, async (req, res) =>
    res.status(201).json(
      await rpc(req, "kpi_save", {
        p_id: null,
        p_data: kpiCreate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.patch("/:id", adminOnly, sensitiveLimit, async (req, res) =>
    res.json(
      await rpc(req, "kpi_save", {
        p_id: uuid.parse(req.params.id),
        p_data: kpiUpdate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.post("/:id/archive", adminOnly, sensitiveLimit, async (req, res) =>
    res.json(
      await rpc(req, "kpi_archive", {
        p_id: uuid.parse(req.params.id),
        p_archived: kpiArchive.parse(req.body).archived,
        p_request: req.id,
      }),
    ),
  );
  router.delete("/:id", adminOnly, sensitiveLimit, async (req, res) => {
    noBody.parse(req.body ?? {});
    res.json(
      await rpc(req, "kpi_delete", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });

  // The agent's own day (today unless chosen; never a future day).
  router.get("/my", agentOnly, async (req, res) => {
    const { day = pkToday() } = kpiMyQuery.parse(req.query);
    if (day > pkToday() || day < addDays(pkToday(), -366))
      return res.status(400).json({ error: "Choose a day up to today" });
    res.set("Cache-Control", "no-store").json(await myDay(req, day));
  });
  router.put("/my/:day", agentOnly, sensitiveLimit, async (req, res) => {
    const day = z.iso.date().parse(req.params.day);
    const { answers } = kpiAnswers.parse(req.body);
    const saved = await rpc(req, "kpi_submit", {
      p_day: day,
      p_answers: answers,
      p_request: req.id,
    });
    res.json({ ...(await myDay(req, day)), saved: saved.saved });
  });

  // Evidence: an agent adds links and visit photos (always their own).
  router.post("/evidence", agentOnly, sensitiveLimit, async (req, res) => {
    const { kind, url } = kpiEvidenceLink.parse(req.body);
    const link = evidenceLink(url);
    if (!link)
      return res.status(400).json({
        error:
          "Add a link to a Facebook, Instagram, TikTok or YouTube post or video",
      });
    res.status(201).json(
      await rpc(req, "kpi_evidence_add", {
        p_data: { kind, ...link },
        p_request: req.id,
      }),
    );
  });
  router.post(
    "/evidence/photo",
    agentOnly,
    sensitiveLimit,
    photoUpload,
    async (req, res) => {
      const { project, visit_date } = kpiVisitPhoto.parse(req.body ?? {});
      const type = signatureType(req.file?.buffer);
      if (!req.file || !type || type !== req.file.mimetype)
        return res
          .status(400)
          .json({ error: "Upload a JPEG, PNG or WebP photo up to 5 MB" });
      // Stored under the agent's own folder; the database checks the path.
      const path = `${req.user.id}/${crypto.randomUUID()}`;
      const stored = await evidenceBucket(db).upload(path, req.file.buffer, {
        contentType: type,
      });
      if (stored.error)
        throw Object.assign(
          new Error("The photo could not be uploaded. Please try again."),
          { status: 503 },
        );
      try {
        res.status(201).json(
          await rpc(req, "kpi_evidence_add", {
            p_data: {
              kind: "visit",
              project,
              visit_date,
              storage_path: path,
              file_hash: fileHash(req.file.buffer),
              mime_type: type,
              size_bytes: req.file.size,
            },
            p_request: req.id,
          }),
        );
      } catch (error) {
        await evidenceBucket(db).remove([path]);
        throw error;
      }
    },
  );
  // Lists: an agent's own (the database refuses anyone else's); an
  // administrator's, anyone's, by agent, kind, status and days.
  router.get("/evidence", reportLimit, async (req, res) => {
    const q = kpiEvidenceQuery.parse(req.query);
    res
      .set("Cache-Control", "no-store")
      .json(await rpc(req, "kpi_evidence_list", { p_query: q }));
  });
  router.get("/evidence/:id/photo", async (req, res) => {
    const photo = await rpc(req, "kpi_evidence_photo", {
      p_id: uuid.parse(req.params.id),
    });
    const signed = await evidenceBucket(db).createSignedUrl(
      photo.storage_path,
      60,
    );
    if (signed.error || !signed.data?.signedUrl)
      throw Object.assign(new Error("The photo could not be loaded."), {
        status: 503,
      });
    // Only a signed link: nothing to mask, and masking could break it.
    req.phoneRevealResponse = true;
    res.set("Cache-Control", "no-store").json({ url: signed.data.signedUrl });
  });
  router.post(
    "/evidence/:id/review",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const { status, reason } = kpiEvidenceReview.parse(req.body);
      res.json(
        await rpc(req, "kpi_evidence_review", {
          p_id: uuid.parse(req.params.id),
          p_status: status,
          p_reason: reason,
          p_request: req.id,
        }),
      );
    },
  );
  // Agents' listings and their verification (never the owner's contact).
  router.get("/inventory", reportLimit, async (req, res) => {
    const q = kpiInventoryQuery.parse(req.query);
    res
      .set("Cache-Control", "no-store")
      .json(await rpc(req, "kpi_inventory_list", { p_query: q }));
  });
  router.post(
    "/inventory/:id/review",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const { status, reason } = kpiInventoryReview.parse(req.body);
      res.json(
        await rpc(req, "kpi_inventory_review", {
          p_property: uuid.parse(req.params.id),
          p_status: status,
          p_reason: reason,
          p_request: req.id,
        }),
      );
    },
  );

  // Administrators: every agent's results, and one agent's history.
  router.get("/report", adminOnly, reportLimit, async (req, res) => {
    const q = kpiReportQuery.parse(req.query);
    const facts = await rpc(req, "kpi_facts", {
      p_from: q.from,
      p_to: q.to,
      p_agent: q.agent ?? null,
    });
    res.set("Cache-Control", "no-store").json(kpiReport(facts, q.from, q.to));
  });
  router.get("/history", adminOnly, reportLimit, async (req, res) => {
    const q = kpiReportQuery.parse(req.query);
    if (!q.agent)
      return res.status(400).json({ error: "Choose an agent from the list" });
    if (addDays(q.from, 92) < q.to)
      return res
        .status(400)
        .json({ error: "Choose up to three months of history" });
    const facts = await rpc(req, "kpi_facts", {
      p_from: q.from,
      p_to: q.to,
      p_agent: q.agent,
    });
    res
      .set("Cache-Control", "no-store")
      .json(agentHistory(facts, q.agent, q.from, q.to));
  });
  return router;
}
