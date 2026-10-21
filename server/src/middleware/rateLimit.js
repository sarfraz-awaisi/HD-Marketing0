import { rateLimit } from "express-rate-limit";
export const mfaVerifyLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
export const metaWebhookLimit = rateLimit({
  windowMs: 60000,
  limit: 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
export const sensitiveLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

// General API limits per 15 minutes. Several employees often share one office
// IP, so signed-in traffic is limited per verified user instead of per IP:
// - public: sign-in and onboarding routes, per IP (no user is known yet);
// - unauthenticated: per IP, counting only requests that fail authentication
//   (missing, invalid or expired tokens, disabled accounts, pending 2FA);
// - perUser: per user ID that auth() verified with Supabase. Headers, bodies
//   and unverified token claims never choose the key.
// Each store lives in this process's memory, which suits the single PM2 API
// instance; several API instances would each keep their own counts.
export const API_LIMIT_WINDOW_MS = 15 * 60000;
export const apiLimits = { public: 300, unauthenticated: 300, perUser: 1000 };
export function createApiLimiters(overrides = {}) {
  const limits = { ...apiLimits, ...overrides };
  const shared = {
    windowMs: API_LIMIT_WINDOW_MS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  };
  return {
    publicLimit: rateLimit({ ...shared, limit: limits.public }),
    // Mounted before auth(): every request is counted on arrival and released
    // when it finishes if it passed authentication, so the IP allowance only
    // fills with requests that never proved who they are.
    unauthenticatedLimit: rateLimit({
      ...shared,
      limit: limits.unauthenticated,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (req) => Boolean(req.rateLimitUser),
    }),
    // Mounted after auth(), which sets req.user only once Supabase has
    // confirmed the token and the profile is active (and 2FA is satisfied).
    userLimit: [
      (req, _res, next) => {
        if (!req.user?.id)
          return next(
            Object.assign(new Error("Authentication required"), {
              status: 401,
            }),
          );
        req.rateLimitUser = req.user.id;
        next();
      },
      rateLimit({
        ...shared,
        limit: limits.perUser,
        keyGenerator: (req) => "user:" + req.rateLimitUser,
      }),
    ],
  };
}
