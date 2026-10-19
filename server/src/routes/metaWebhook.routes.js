import { Router } from "express";
import { z } from "zod";
import { metaConfig } from "../services/meta/config.js";
import { safeEqual, validSignature } from "../services/meta/crypto.js";
import { metaRpc } from "../services/meta/rpc.js";
const id = z.string().regex(/^\d{1,40}$/);
const webhook = z.object({
  object: z.literal("page"),
  entry: z
    .array(
      z.object({
        id,
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z
                .object({
                  leadgen_id: id.optional(),
                  form_id: id.optional(),
                  page_id: id.optional(),
                  ad_id: id.optional(),
                  created_time: z
                    .number()
                    .int()
                    .nonnegative()
                    .max(253402300799)
                    .optional(),
                })
                .passthrough(),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});
export function metaWebhookRouter(db) {
  const router = Router();
  router.get("/", (req, res) => {
    let config;
    try {
      config = metaConfig();
    } catch {
      return res.status(503).json({ error: "Meta webhook is not configured." });
    }
    if (
      req.query["hub.mode"] !== "subscribe" ||
      !safeEqual(req.query["hub.verify_token"], config.verify) ||
      !/^\d{1,100}$/.test(req.query["hub.challenge"] || "")
    )
      return res.status(403).json({ error: "Webhook verification failed" });
    res.type("text/plain").send(req.query["hub.challenge"]);
  });
  router.post("/", async (req, res) => {
    const config = metaConfig();
    if (
      !validSignature(req.body, req.get("X-Hub-Signature-256"), config.secret)
    )
      return res.status(401).json({ error: "Webhook signature invalid" });
    let parsed;
    try {
      parsed = webhook.parse(JSON.parse(req.body.toString("utf8")));
    } catch {
      return res.status(400).json({ error: "Invalid lead event" });
    }
    const events = [];
    for (const entry of parsed.entry)
      for (const change of entry.changes) {
        if (change.field !== "leadgen") continue;
        const v = change.value;
        if (
          !v.leadgen_id ||
          !v.form_id ||
          (v.page_id && v.page_id !== entry.id)
        )
          return res.status(400).json({ error: "Invalid lead identity" });
        if (events.length >= 1000)
          return res.status(400).json({ error: "Too many lead events" });
        events.push({
          page_id: entry.id,
          form_id: v.form_id,
          lead_id: v.leadgen_id,
          ad_id: v.ad_id,
          ...(v.created_time
            ? { submitted_at: new Date(v.created_time * 1000).toISOString() }
            : {}),
        });
      }
    const queued = await metaRpc(db, "meta_enqueue", { p_events: events });
    res.json({ received: true, ...queued });
  });
  return router;
}
