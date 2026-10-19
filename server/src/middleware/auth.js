import {
  requireAgentMfa,
  mfaRpc,
  verifiedClaims,
  totpFactors,
  freshMfa,
} from "../services/mfa.js";
import { authRequest } from "../services/authRequests.js";
// The token's own subject lets these reads start while Supabase verifies the
// token. Their results are used only once Supabase confirms that same user.
function tokenSubject(token) {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return /^[0-9a-f-]{36}$/i.test(claims.sub) && claims.exp * 1000 > Date.now()
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}
export const auth =
  (db, { allowMfaSetup = false } = {}) =>
  async (req, res, next) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!token)
        return res.status(401).json({ error: "Authentication required" });
      const reads = (id) => {
        const readProfile = (columns) =>
          Promise.resolve(
            db.from("profiles").select(columns).eq("id", id).single(),
          );
        // The UID column arrives with update 036; older databases still sign in.
        const profile = readProfile("id,name,role,active,uid").then((result) =>
          ["42703", "PGRST204"].includes(result.error?.code)
            ? readProfile("id,name,role,active")
            : result,
        );
        const claims = verifiedClaims(db, token, id);
        for (const pending of [profile, claims]) pending.catch(() => {});
        return { profile, claims };
      };
      const subject = tokenSubject(token),
        early = subject && reads(subject);
      const { data, error } = await authRequest(db, "getUser", token);
      if (error || !data.user)
        return res.status(401).json({ error: "Invalid or expired session" });
      if (!data.user.email_confirmed_at)
        return res.status(403).json({
          error:
            "Verify your email before signing in. Ask your administrator to complete email verification in Accounts.",
          code: "EMAIL_CONFIRMATION_REQUIRED",
        });
      const verifiedReads =
        early && subject === data.user.id ? early : reads(data.user.id);
      const [profileResult, claimsResult] = await Promise.allSettled([
        verifiedReads.profile,
        verifiedReads.claims,
      ]);
      if (profileResult.status === "rejected") throw profileResult.reason;
      const profile = profileResult.value;
      if (profile.error || !profile.data?.active)
        return res
          .status(403)
          .json({ error: "Account disabled or not provisioned" });
      if (claimsResult.status === "rejected") throw claimsResult.reason;
      const claims = claimsResult.value;
      const enrolled = totpFactors(data.user).length > 0;
      req.user = profile.data;
      req.authToken = token;
      req.authUser = data.user;
      req.claims = claims;
      // Admin login uses email/password, independently of migration 025 or saved factors.
      if (profile.data.role === "admin") {
        req.mfa = {
          required: false,
          enrolled,
          verified: claims.aal === "aal2" && enrolled,
          reset_pending: false,
        };
        return next();
      }
      const required = requireAgentMfa() || enrolled;
      let state;
      try {
        // MFA state is read only after identity, profile and claims verify.
        state = await mfaRpc(db, "mfa_session_state", {
          p_actor: data.user.id,
        });
      } catch (error) {
        // An unenrolled, optional agent also needs no MFA installation to sign in.
        if (required || !error.missingFunction) throw error;
        state = { reset_pending: false, reset_after: null };
      }
      if (typeof state?.reset_pending !== "boolean")
        throw Object.assign(
          new Error(
            "Two-factor security could not be confirmed. Please try again.",
          ),
          { status: 503 },
        );
      const verified = freshMfa(claims, state, enrolled),
        stale = state.reset_after && (claims.iat || 0) < state.reset_after;
      const blocked = Boolean(
        state.reset_pending || (required && !verified) || stale,
      );
      req.mfa = {
        required: blocked,
        enrolled,
        verified,
        reset_pending: state.reset_pending,
      };
      if (
        blocked &&
        !allowMfaSetup &&
        !(req.method === "GET" && req.path === "/me")
      )
        return res.status(403).json({
          error: state.reset_pending
            ? "Your two-factor reset needs administrator recovery. Ask another administrator to retry it."
            : "Complete two-factor verification before opening your workspace.",
          code: "mfa_required",
        });
      next();
    } catch (e) {
      next(e);
    }
  };
