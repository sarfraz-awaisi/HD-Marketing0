import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { adminOnly } from "../middleware/role.js";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import { maskAgentResponse } from "../middleware/phoneProtection.js";
import { validateDocumentFile } from "../services/documentFiles.js";
import { cleanupKnowledgeFiles } from "../jobs/cleanupKnowledgeFiles.js";
import { listQuery, uuid } from "../utils/validators.js";

const category = z.enum([
  "documentation",
  "policy",
  "property_deeds",
  "legal_noc",
  "client_kyc",
  "tenancy_agreements",
]);
const entry = z
  .object({
    title: z.string().trim().min(1).max(200),
    category,
    content: z.string().trim().min(1).max(50000),
    property_name: z.string().trim().max(200).optional(),
    keywords: z.string().trim().max(500).optional(),
    lead_id: uuid.nullable().optional(),
  })
  .strict();
const pageQuery = z
  .object({
    page: listQuery.shape.page,
    limit: listQuery.shape.limit,
    search: z.string().trim().max(100).optional(),
    category: category.optional(),
    lead_id: uuid.optional(),
    unlinked_kyc: z.enum(["true", "false"]).optional(),
  })
  .strict();
function result({ data, error }) {
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01"].includes(
    error.code,
  );
  throw Object.assign(
    new Error(
      missing
        ? "Documentation & policies needs a database update. Apply CRM migration 022 after completing migrations through 021."
        : error.code === "P0002"
          ? "Entry not found"
          : error.code === "42501"
            ? "Administrator access required"
            : error.code === "22023"
              ? "Check the document title, category, content and search details."
              : "The entry could not be saved or loaded. Please try again.",
    ),
    {
      status: missing
        ? 503
        : error.code === "P0002"
          ? 404
          : error.code === "42501"
            ? 403
            : 400,
    },
  );
}
export function documentsRouter(db) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  });
  const cleanup = async (id) => {
    try {
      await cleanupKnowledgeFiles(db, id);
    } catch {
      console.error("Document file cleanup pending; jobs will retry");
    }
  };
  router.get("/", async (req, res) => {
    const q = pageQuery.parse(req.query);
    res.json(
      result(
        await db.rpc("knowledge_documents_page", {
          p_actor: req.user.id,
          p_page: q.page,
          p_limit: q.limit,
          p_search: q.search || "",
          p_category: q.category || "",
          p_lead: q.lead_id || null,
          p_unlinked: q.unlinked_kyc === "true",
        }),
      ),
    );
  });
  router.get("/clients", adminOnly, async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(100).default(""),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        selected: uuid.optional(),
      })
      .strict()
      .parse(req.query);
    res.json(
      maskAgentResponse(
        result(
          await db.rpc("search_kyc_clients", {
            p_actor: req.user.id,
            p_search: q.search,
            p_limit: q.limit,
            p_selected: q.selected || null,
          }),
        ),
      ),
    );
  });
  router.get("/:id", async (req, res) => {
    res.json(
      result(
        await db.rpc("read_knowledge_document", {
          p_id: uuid.parse(req.params.id),
          p_actor: req.user.id,
        }),
      ),
    );
  });
  router.get("/:id/files", async (req, res) => {
    const doc = result(
      await db.rpc("read_knowledge_document", {
        p_id: uuid.parse(req.params.id),
        p_actor: req.user.id,
      }),
    );
    res.json(doc.files);
  });
  router.post(
    "/:id/files",
    adminOnly,
    sensitiveLimit,
    upload.single("file"),
    async (req, res) => {
      const id = uuid.parse(req.params.id),
        file = validateDocumentFile(req.file);
      const document = result(
        await db.rpc("read_knowledge_document", {
          p_id: id,
          p_actor: req.user.id,
        }),
      );
      if (document.category === "client_kyc" && !document.lead_id)
        throw Object.assign(
          new Error(
            "Link this Client KYC entry to a client before attaching files.",
          ),
          { status: 400 },
        );
      const path = `${id}/${randomUUID()}`;
      result(
        await db.from("knowledge_file_cleanup").insert({
          document_id: id,
          storage_path: path,
          not_before: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      try {
        result(
          await db.storage
            .from("knowledge-files")
            .upload(path, req.file.buffer, { contentType: file.mime_type }),
        );
        const attached = result(
          await db.rpc("attach_knowledge_file", {
            p_document: id,
            p_data: { ...file, storage_path: path },
            p_actor: req.user.id,
            p_request: req.id,
          }),
        );
        res.status(201).json(attached);
      } catch (error) {
        // Make the reservation eligible for immediate cleanup. If the update or
        // Storage removal fails, the original durable reservation still expires.
        try {
          await db
            .from("knowledge_file_cleanup")
            .update({ not_before: new Date().toISOString() })
            .eq("storage_path", path);
        } catch {}
        await cleanup(id);
        throw error;
      }
    },
  );
  router.get("/:id/files/:file/download", sensitiveLimit, async (req, res) => {
    const access = {
      p_document: uuid.parse(req.params.id),
      p_file: uuid.parse(req.params.file),
      p_actor: req.user.id,
    };
    const authorization = await db.rpc("authorize_knowledge_download", {
      ...access,
      p_request: req.id,
    });
    if (
      authorization.error &&
      ![
        "P0002",
        "42501",
        "22023",
        "PGRST202",
        "PGRST205",
        "42883",
        "42P01",
      ].includes(authorization.error.code)
    )
      throw Object.assign(
        new Error(
          "Download authorization could not be completed. Please try again.",
        ),
        { status: 503 },
      );
    const file = result(authorization);
    const blob = result(
      await db.storage.from("knowledge-files").download(file.storage_path),
    );
    // A lead may change owners while Storage responds. Recheck before sending bytes.
    result(await db.rpc("read_knowledge_file", access));
    res.set("Content-Type", file.mime_type);
    res.set(
      "Content-Disposition",
      `attachment; filename="document.${file.file_name.split(".").at(-1)}"; filename*=UTF-8''${encodeURIComponent(file.file_name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
    );
    res.send(Buffer.from(await blob.arrayBuffer()));
  });
  router.delete("/:id/files/:file", adminOnly, async (req, res) => {
    const id = uuid.parse(req.params.id);
    result(
      await db.rpc("delete_knowledge_file", {
        p_document: id,
        p_file: uuid.parse(req.params.file),
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
    await cleanup(id);
    res.status(204).end();
  });
  router.post("/", adminOnly, async (req, res) => {
    res.status(201).json(
      result(
        await db.rpc("save_knowledge_document", {
          p_id: null,
          p_data: entry
            .refine((v) => v.category !== "client_kyc" || !!v.lead_id, {
              message: "Choose a client for Client KYC",
            })
            .parse(req.body),
          p_actor: req.user.id,
          p_request: req.id,
        }),
      ),
    );
  });
  router.patch("/:id", adminOnly, async (req, res) => {
    res.json(
      result(
        await db.rpc("save_knowledge_document", {
          p_id: uuid.parse(req.params.id),
          p_data: entry.parse(req.body),
          p_actor: req.user.id,
          p_request: req.id,
        }),
      ),
    );
  });
  router.delete("/:id", adminOnly, async (req, res) => {
    result(
      await db.rpc("delete_knowledge_document", {
        p_id: uuid.parse(req.params.id),
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
    await cleanup(req.params.id);
    res.status(204).end();
  });
  return router;
}
