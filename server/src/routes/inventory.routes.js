import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { adminOnly } from "../middleware/role.js";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import { maskAgentResponse } from "../middleware/phoneProtection.js";
import { cleanupPropertyPhotos } from "../jobs/cleanupPropertyPhotos.js";
import {
  uuid,
  propertyCreate,
  propertyUpdate,
  inventoryQuery,
  inventoryAgentsQuery,
  photoOrder,
} from "../utils/validators.js";
// Property inventory (update 041). Every read and write goes through a SQL
// function that checks the signed-in account (p_actor): agents keep a private
// inventory, administrators keep the company inventory agents can only read.
// SQL raises HA<status> with messages written for the signed-in user.
export async function inventoryRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const custom = /^HA(\d{3})$/.exec(error.code || "");
  if (custom)
    throw Object.assign(new Error(error.message), {
      status: Number(custom[1]),
    });
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : error.code === "23505" || ["40001", "40P01"].includes(error.code)
      ? 409
      : ["22P02", "22003", "22023", "23514"].includes(error.code)
        ? 400
        : 503;
  throw Object.assign(
    new Error(
      missing
        ? "Inventory needs CRM database update 041 after 040."
        : status === 409
          ? "This was changed at the same moment. Refresh and try again."
          : status === 400
            ? "Check the property details and try again."
            : "The inventory could not be loaded. Please try again.",
    ),
    { status },
  );
}
const bucket = (db) => db.storage.from("property-photos");
// Storage paths stay on the server; cards get a short-lived signed cover URL.
async function withCovers(db, rows, signed) {
  const paths = signed ? rows.filter((r) => r.cover_path) : [];
  let urls = new Map();
  if (paths.length) {
    const result = await bucket(db).createSignedUrls(
      paths.map((r) => r.cover_path),
      60,
    );
    if (!result.error)
      urls = new Map(
        paths.map((r, i) => [r.id, result.data?.[i]?.signedUrl || null]),
      );
  }
  return rows.map(({ cover_path, cover_photo_id, ...row }) =>
    signed
      ? {
          ...row,
          cover_photo: cover_photo_id
            ? { id: cover_photo_id, url: urls.get(row.id) || null }
            : null,
        }
      : row,
  );
}
// Agent responses are phone-masked (protectAgentPhones). Owner contact numbers
// are returned unmasked only where SQL authorized them: the agent's own
// property, or a company property whose contact an administrator shared.
function sendProperty(req, res, property, status = 200) {
  if (req.user.role === "agent" && property.owner_contact) {
    const { owner_contact, ...rest } = property;
    req.phoneRevealResponse = true;
    return res
      .status(status)
      .json({ ...maskAgentResponse(rest), owner_contact });
  }
  res.status(status).json(property);
}
function signatureType(buffer) {
  if (
    buffer
      ?.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer?.[0] === 255 && buffer?.[1] === 216 && buffer?.[2] === 255)
    return "image/jpeg";
  if (
    buffer?.subarray(0, 4).toString() === "RIFF" &&
    buffer?.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
export function inventoryRouter(db) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  const rpc = (req, name, args = {}) =>
    inventoryRpc(db, name, { p_actor: req.user.id, ...args });
  router.get("/inventory/summary", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(await rpc(req, "inventory_summary"));
  });
  router.get("/inventory/agents", adminOnly, async (req, res) => {
    const q = inventoryAgentsQuery.parse(req.query);
    res.json(
      await rpc(req, "inventory_agents", {
        p_search: q.search || null,
        p_page: q.page,
        p_limit: q.limit,
      }),
    );
  });
  // scope=company (default; also the lead, visit and deal property choices),
  // mine (the signed-in agent) or agent&agent=<id> (administrators only).
  router.get("/properties", async (req, res) => {
    const { scope, agent, page, limit, covers, ...filters } =
      inventoryQuery.parse(req.query);
    const result = await rpc(req, "inventory_page", {
      p_scope: scope,
      p_agent: agent || null,
      p_filters: filters,
      p_page: page,
      p_limit: limit,
    });
    res.json({
      ...result,
      data: await withCovers(db, result.data, covers === "true"),
    });
  });
  router.post("/properties", sensitiveLimit, async (req, res) => {
    const data = propertyCreate.parse(req.body);
    sendProperty(
      req,
      res,
      await rpc(req, "inventory_save", {
        p_property: null,
        p_data: data,
        p_request: req.id,
      }),
      201,
    );
  });
  router.get("/properties/:id", async (req, res) => {
    sendProperty(
      req,
      res,
      await rpc(req, "inventory_property", {
        p_property: uuid.parse(req.params.id),
      }),
    );
  });
  router.patch("/properties/:id", sensitiveLimit, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const data = propertyUpdate.parse(req.body);
    sendProperty(
      req,
      res,
      await rpc(req, "inventory_save", {
        p_property: id,
        p_data: data,
        p_request: req.id,
      }),
    );
  });
  router.delete("/properties/:id", sensitiveLimit, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { error } = await db.rpc("delete_property", {
      p_property: id,
      p_actor: req.user.id,
      p_request: req.id,
    });
    if (error)
      throw Object.assign(
        new Error(
          error.code === "23503"
            ? "This property is linked to leads, visits or deals. Archive it to retain their history."
            : error.code === "PGRST202"
              ? "Apply database migration 013 to enable property deletion."
              : error.code === "42501"
                ? error.message || "You cannot delete this property."
                : error.code === "P0002"
                  ? "Property not found"
                  : "The property could not be deleted. Please try again.",
        ),
        {
          status:
            { 23503: 409, PGRST202: 503, 42501: 403, P0002: 404 }[error.code] ||
            503,
        },
      );
    try {
      await cleanupPropertyPhotos(db, id);
    } catch {
      // The committed queue is retried by the jobs runner. The property itself
      // has already been deleted successfully and must not appear as a failure.
      console.error("Property photo cleanup pending; jobs will retry");
    }
    res.status(204).end();
  });
  router.get("/properties/:id/photos", async (req, res) => {
    const photos = await rpc(req, "inventory_photos", {
      p_property: uuid.parse(req.params.id),
    });
    if (!photos.length) return res.json([]);
    const signed = await bucket(db).createSignedUrls(
      photos.map((photo) => photo.storage_path),
      60,
    );
    if (signed.error)
      throw Object.assign(new Error("Property pictures could not be loaded."), {
        status: 503,
      });
    res.json(
      photos.map((photo, i) => ({
        id: photo.id,
        url: signed.data?.[i]?.signedUrl || null,
      })),
    );
  });
  // Like before 041, uploads use only the general per-user limit, so saving a
  // property with many pictures is never cut off part-way.
  router.post(
    "/properties/:id/photos",
    upload.single("file"),
    async (req, res) => {
      const id = uuid.parse(req.params.id);
      // Ownership is checked before anything reaches Storage.
      const access = await rpc(req, "inventory_access", {
        p_property: id,
        p_write: true,
      });
      if (access.photo_count >= 20)
        throw Object.assign(
          new Error("A property can have up to 20 pictures"),
          { status: 409 },
        );
      const type = signatureType(req.file?.buffer);
      if (!req.file || !type || type !== req.file.mimetype)
        throw Object.assign(
          new Error("Upload a valid JPEG, PNG or WebP under 5 MB"),
          { status: 400 },
        );
      const path = `${id}/${crypto.randomUUID()}`;
      const stored = await bucket(db).upload(path, req.file.buffer, {
        contentType: type,
      });
      if (stored.error)
        throw Object.assign(
          new Error("The picture could not be uploaded. Please try again."),
          { status: 503 },
        );
      try {
        res.status(201).json(
          await rpc(req, "inventory_photo_add", {
            p_property: id,
            p_path: path,
            p_request: req.id,
          }),
        );
      } catch (error) {
        await bucket(db).remove([path]);
        throw error;
      }
    },
  );
  router.put(
    "/properties/:id/photos/order",
    sensitiveLimit,
    async (req, res) => {
      const { photo_ids } = photoOrder.parse(req.body);
      const photos = await rpc(req, "inventory_photo_order", {
        p_property: uuid.parse(req.params.id),
        p_photos: photo_ids,
        p_request: req.id,
      });
      res.json(photos.map(({ id }) => ({ id })));
    },
  );
  router.delete(
    "/properties/:id/photos/:photo",
    sensitiveLimit,
    async (req, res) => {
      const id = uuid.parse(req.params.id);
      // SQL removes the row and queues the file in one transaction.
      await rpc(req, "inventory_photo_remove", {
        p_property: id,
        p_photo: uuid.parse(req.params.photo),
        p_request: req.id,
      });
      try {
        await cleanupPropertyPhotos(db, id);
      } catch {
        console.error("Property photo cleanup pending; jobs will retry");
      }
      res.status(204).end();
    },
  );
  return router;
}
