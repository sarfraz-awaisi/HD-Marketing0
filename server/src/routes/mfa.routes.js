import { Router } from "express";
import { mfaVerification } from "../utils/validators.js";
import { mfaVerifyLimit } from "../middleware/rateLimit.js";
import {
  createMfaClient,
  mfaRpc,
  verifiedClaims,
  totpFactors,
  freshMfa,
} from "../services/mfa.js";
export function mfaRouter(db, options = {}) {
  const router = Router();
  router.post("/verify", mfaVerifyLimit, async (req, res) => {
    if (req.user.role === "admin")
      return res.status(400).json({
        error:
          "Administrator sign-in uses email and password. No authenticator code is required.",
        code: "MFA_NOT_REQUIRED",
      });
    const { factor_id, code } = mfaVerification.parse(req.body);
    const ticket = await mfaRpc(db, "mfa_begin_attempt", {
      p_actor: req.user.id,
      p_request: req.id,
    });
    if (!ticket.allowed) {
      res.set("Retry-After", String(ticket.retry_after));
      return res.status(429).json({
        error: "Too many authenticator attempts. Wait before trying again.",
        code: "MFA_RATE_LIMIT",
        retry_after: ticket.retry_after,
      });
    }
    let finished = false;
    try {
      const client = (options.createMfaClient || createMfaClient)(
        req.authToken,
      );
      const challenge = await client.auth.mfa.challenge({
        factorId: factor_id,
      });
      if (challenge.error || !challenge.data?.id)
        throw challenge.error || new Error();
      const result = await client.auth.mfa.verify({
        factorId: factor_id,
        challengeId: challenge.data.id,
        code,
      });
      if (result.error) throw result.error;
      const session = result.data;
      if (!session?.access_token || !session?.refresh_token) throw new Error();
      const claims = await verifiedClaims(
        db,
        session.access_token,
        req.user.id,
      );
      const current = await db.auth.getUser(session.access_token),
        state = await mfaRpc(db, "mfa_session_state", { p_actor: req.user.id });
      if (
        current.error ||
        current.data?.user?.id !== req.user.id ||
        !freshMfa(claims, state, totpFactors(current.data.user).length > 0)
      )
        throw new Error();
      await mfaRpc(db, "mfa_finish_attempt", {
        p_actor: req.user.id,
        p_attempt: ticket.attempt_id,
        p_result: "verified",
        p_request: req.id,
      });
      finished = true;
      res.json({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    } catch (error) {
      const rejected = [
        "mfa_verification_failed",
        "mfa_challenge_expired",
        "mfa_factor_not_found",
        "mfa_factor_not_verified",
        "mfa_ip_address_mismatch",
      ].includes(error.code);
      if (!finished)
        await mfaRpc(db, "mfa_finish_attempt", {
          p_actor: req.user.id,
          p_attempt: ticket.attempt_id,
          p_result: rejected ? "failed" : "unavailable",
          p_request: req.id,
        });
      res.status(rejected ? 400 : 503).json({
        error: rejected
          ? "The authenticator code was not accepted. Check the code and your phone clock, then try again."
          : "Two-factor verification could not be confirmed. Please try again.",
        code: rejected ? "MFA_CODE_INVALID" : "MFA_UNAVAILABLE",
      });
    }
  });
  return router;
}
