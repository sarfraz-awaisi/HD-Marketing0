import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { unwrap } from "./crm.routes.js";
// Only local fixture protocol. Real providers must implement their documented verification and payload mapping.
export function verifySignature(raw, signature, secret) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  return timingSafeEqual(
    Buffer.from(signature.slice(7), "hex"),
    createHmac("sha256", secret).update(raw).digest(),
  );
}
export function webhooksRouter(db) {
  const r = Router();
  r.post("/:provider", async (req, res) => {
    if (
      req.params.provider !== "mock" ||
      process.env.NODE_ENV === "production" ||
      process.env.CALL_PROVIDER !== "mock"
    )
      return res.status(503).json({ error: "Provider adapter not configured" });
    if (
      !verifySignature(
        req.body,
        req.headers["x-hd-signature"],
        process.env.WEBHOOK_SECRET,
      )
    )
      return res.status(401).json({ error: "Webhook verification failed" });
    let parsed;
    try {
      parsed = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    const event = z
      .object({
        event_id: z.string().min(1).max(150),
        provider_call_id: z.string().startsWith("mock-"),
        status: z.enum(["ringing", "completed", "failed"]),
        ended_at: z.iso.datetime({ offset: true }).optional(),
        duration_seconds: z.number().int().min(0).max(86400).optional(),
      })
      .strict()
      .parse(parsed);
    res.json(unwrap(await db.rpc("apply_call_event", { p_event: event })));
  });
  return r;
}
