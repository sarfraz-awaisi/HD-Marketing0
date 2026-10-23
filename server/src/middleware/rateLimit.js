import { rateLimit } from "express-rate-limit";

// Every API rate-limit policy: who it counts, its window in minutes, the
// default limit and the environment variable that overrides it.
// - "user": per user that auth() verified with Supabase (active profile,
//   two-factor satisfied). Mounted after auth(); headers, bodies and
//   unverified token claims never choose the key, so colleagues behind one
//   office IP each have their own allowance.
// - "invitee": per invited user whose invitation session Supabase verified.
// - "ip": per client address (req.ip, derived through TRUST_PROXY; IPv6 is
//   grouped by /56), for requests made before anyone has proved who they are.
// docs/RATE_LIMITS.md records the measured workload behind each default.
export const rateLimitPolicies = {
  perUser: {
    per: "user",
    minutes: 15,
    limit: 1000,
    env: "RATE_LIMIT_USER_PER_15_MIN",
  },
  sensitive: {
    per: "user",
    minutes: 1,
    limit: 30,
    env: "RATE_LIMIT_SENSITIVE_PER_MIN",
    message: "Too many changes in a short time. Wait a minute and try again.",
  },
  reports: {
    per: "user",
    minutes: 15,
    limit: 300,
    env: "RATE_LIMIT_REPORTS_PER_15_MIN",
    message: "Too many report requests. Wait a few minutes and try again.",
  },
  exports: {
    per: "user",
    minutes: 15,
    limit: 30,
    env: "RATE_LIMIT_EXPORTS_PER_15_MIN",
    message: "Too many exports. Wait a few minutes and try again.",
  },
  imports: {
    per: "user",
    minutes: 15,
    limit: 30,
    env: "RATE_LIMIT_IMPORTS_PER_15_MIN",
    message: "Too many imports. Wait a few minutes before importing again.",
  },
  accountCreation: {
    per: "user",
    minutes: 15,
    limit: 20,
    env: "RATE_LIMIT_ACCOUNT_CREATION_PER_15_MIN",
    message:
      "Too many accounts created in a short time. Wait a few minutes and try again.",
  },
  accountSecurity: {
    per: "user",
    minutes: 15,
    limit: 10,
    env: "RATE_LIMIT_ACCOUNT_SECURITY_PER_15_MIN",
  },
  mfaVerify: {
    per: "user",
    minutes: 15,
    limit: 10,
    env: "RATE_LIMIT_MFA_VERIFY_PER_15_MIN",
    message: "Too many authenticator attempts. Wait before trying again.",
  },
  onboarding: {
    per: "invitee",
    minutes: 15,
    limit: 20,
    env: "RATE_LIMIT_ONBOARDING_PER_15_MIN",
  },
  unauthenticated: {
    per: "ip",
    minutes: 15,
    limit: 300,
    env: "RATE_LIMIT_UNAUTHENTICATED_PER_15_MIN",
  },
  public: {
    per: "ip",
    minutes: 15,
    limit: 300,
    env: "RATE_LIMIT_PUBLIC_PER_15_MIN",
  },
  login: {
    per: "ip",
    minutes: 15,
    limit: 30,
    env: "RATE_LIMIT_LOGIN_FAILURES_PER_15_MIN",
    message:
      "Too many sign-in attempts from this network. Wait 15 minutes and try again.",
  },
  passwordReset: {
    per: "ip",
    minutes: 15,
    limit: 5,
    env: "RATE_LIMIT_PASSWORD_RESET_PER_15_MIN",
    message:
      "Too many password reset requests from this network. Wait 15 minutes and try again.",
  },
  callbacks: {
    per: "ip",
    minutes: 1,
    limit: 30,
    env: "RATE_LIMIT_CALLBACKS_PER_MIN",
  },
  metaWebhook: {
    per: "ip",
    minutes: 1,
    limit: 1200,
    env: "RATE_LIMIT_META_WEBHOOK_PER_MIN",
  },
};
// Limits from the environment (unset or empty means the default), then any
// overrides (tests use small ones). Rate limiting cannot be switched off:
// every limit is a whole number of at least 1.
export function rateLimitSettings(env = process.env, overrides = {}) {
  const limits = {};
  for (const [name, policy] of Object.entries(rateLimitPolicies)) {
    const value = overrides[name] ?? (env[policy.env] || policy.limit);
    if (!/^[1-9]\d{0,5}$/.test(String(value)) || Number(value) > 100000)
      throw new Error(
        `${policy.env} must be a whole number from 1 to 100000 (default ${policy.limit}).`,
      );
    limits[name] = Number(value);
  }
  return limits;
}
const verifiedUser = (req) => {
  if (!req.rateLimitUser)
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  return req.rateLimitUser;
};
const keys = {
  user: (req) => "user:" + verifiedUser(req),
  invitee: (req) => {
    if (!req.invitedUser?.id)
      throw Object.assign(new Error("Invitation verification failed."), {
        status: 401,
      });
    return "invitee:" + req.invitedUser.id;
  },
};
// One limiter (and one in-memory count) per policy for each app. The counts
// live in this API process, which suits the single active PM2 process per
// environment; the durable limits (sign-in lockout, two-factor, PIN, email
// codes, number reveals) are enforced by PostgreSQL across processes.
const options = {
  // Mounted before auth(): every request is counted on arrival and released
  // when it finishes if it passed authentication, so the IP allowance only
  // fills with requests that never proved who they are.
  unauthenticated: {
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req) => Boolean(req.rateLimitUser),
  },
  // Only refused sign-ins count, so colleagues signing in from one office do
  // not use up the network's allowance. Each account's durable lockout still
  // applies after five wrong passwords, from any network.
  login: { skipSuccessfulRequests: true },
};
export function createApiLimiters(overrides = {}, env = process.env) {
  const limits = rateLimitSettings(env, overrides);
  const limiters = {};
  for (const [name, policy] of Object.entries(rateLimitPolicies)) {
    const error =
      policy.message ||
      "Too many requests. Please wait a moment and try again.";
    limiters[name] = rateLimit({
      windowMs: policy.minutes * 60000,
      limit: limits[name],
      standardHeaders: "draft-8",
      legacyHeaders: false,
      identifier: name,
      keyGenerator: keys[policy.per],
      handler: (req, res) =>
        res.status(429).json({ error, request_id: req.id }),
      ...options[name],
    });
  }
  return {
    ...limiters,
    // Mounted after auth(), which sets req.user only once Supabase has
    // confirmed the token and the profile is active (and 2FA is satisfied).
    perUser: [
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
      limiters.perUser,
    ],
  };
}
// Route modules name a policy; the limiter belongs to the app createApp()
// built (app.locals.rateLimiters), so each app keeps its own counts.
const policy = (name) => (req, res, next) => {
  const limiter = req.app.locals.rateLimiters?.[name];
  if (!limiter)
    return next(new Error(`Rate limit policy ${name} is not installed`));
  return limiter(req, res, next);
};
export const sensitiveLimit = policy("sensitive");
export const reportLimit = policy("reports");
export const exportLimit = policy("exports");
export const importLimit = policy("imports");
export const accountCreationLimit = policy("accountCreation");
export const accountSecurityLimit = policy("accountSecurity");
export const mfaVerifyLimit = policy("mfaVerify");
export const onboardingLimit = policy("onboarding");
export const loginLimit = policy("login");
export const passwordResetLimit = policy("passwordReset");
export const callbackLimit = policy("callbacks");
