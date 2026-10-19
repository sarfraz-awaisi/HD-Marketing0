import { Router } from "express";
import { z } from "zod";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import { digest } from "../services/accountsSecurity.js";
const ticket = z.string().regex(/^[a-f0-9]{64}$/);
function result({ data, error }) {
  if (!error) return data;
  const missing = ["42P01", "42883", "PGRST202"].includes(error.code),
    denied = error.code === "P0002";
  throw Object.assign(
    new Error(
      missing
        ? "Account invitations need CRM migration 023 after 022."
        : denied
          ? "This invitation is expired, cancelled or no longer valid. Ask your administrator for a new invitation."
          : "Invitation setup could not be completed. Access remains blocked. Please try again.",
    ),
    { status: denied ? 404 : 503 },
  );
}
export function onboardingRouter(db) {
  const router = Router();
  router.use(sensitiveLimit);
  router.use(async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token)
      return res
        .status(401)
        .json({ error: "Open the invitation link from your inbox." });
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user?.email_confirmed_at)
      return res.status(401).json({
        error:
          "Invitation verification failed. Open a valid invitation from your inbox.",
      });
    req.invitedUser = data.user;
    next();
  });
  router.post("/context", async (req, res) => {
    const data = z.object({ ticket }).strict().parse(req.body);
    res.json(
      result(
        await db.rpc("invitation_context", {
          p_actor: req.invitedUser.id,
          p_hash: digest(data.ticket),
        }),
      ),
    );
  });
  router.post("/complete", async (req, res) => {
    const data = z
      .object({
        ticket,
        password: z
          .string()
          .min(12)
          .max(72)
          .refine((v) => Buffer.byteLength(v, "utf8") <= 72),
      })
      .strict()
      .parse(req.body);
    const args = { p_actor: req.invitedUser.id, p_hash: digest(data.ticket) };
    result(await db.rpc("invitation_context", args));
    const changed = await db.auth.admin.updateUserById(req.invitedUser.id, {
      password: data.password,
    });
    if (changed.error)
      throw Object.assign(
        new Error(
          "Password setup could not be completed. Use a strong password and try again.",
        ),
        { status: 400 },
      );
    if (changed.data?.user?.id !== req.invitedUser.id)
      throw Object.assign(
        new Error(
          "Password setup could not be confirmed. Access remains blocked. Please try again.",
        ),
        { status: 503 },
      );
    // Auth and SQL cannot share a transaction; failed acceptance leaves access blocked.
    res.json(
      result(
        await db.rpc("accept_account_invitation", {
          ...args,
          p_request: req.id,
        }),
      ),
    );
  });
  return router;
}
