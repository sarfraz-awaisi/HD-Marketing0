import { rateLimit } from "express-rate-limit";

// Every API rate-limit policy: who it counts, its window in minutes, the
// default limit and the environment variable that overrides it.
// - "user": per user that auth() verified with Supabase (active profile,
//   two-factor satisfied). Mounted after auth(); headers, bodies and
//   unverified token claims never choose the key, so colleagues behind one
//   office IP each have their own allowance.
// - "invitee": per invited user whose invitation session Supabase verified.
// - "integration": per Google Sheets integration key the database accepted
//   (update 056), so the Apps Script's allowance is its own.
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
  // Google Sheets import (update 056): requests with a refused key, per
  // address, and every request of an accepted key.
  sheetsSyncAuth: {
    per: "ip",
    minutes: 15,
    limit: 30,
    env: "RATE_LIMIT_SHEETS_SYNC_REFUSED_PER_15_MIN",
    message:
      "Too many requests with an invalid integration key. Wait 15 minutes and try again.",
  },
  sheetsSync: {
    per: "integration",
    minutes: 15,
    limit: 900,
    env: "RATE_LIMIT_SHEETS_SYNC_PER_15_MIN",
    message:
      "Too many Google Sheets requests. Wait a few minutes and try again.",
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
  integration: (req) => {
    if (!req.rateLimitIntegration)
      throw Object.assign(new Error("Invalid integration key."), {
        status: 401,
      });
    return "integration:" + req.rateLimitIntegration;
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
  // Only refused keys count against the address (Apps Script requests come
  // from Google's shared addresses).
  sheetsSyncAuth: {
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req) => Boolean(req.sheetsKey),
  },
};
// Diagnostics: every refusal is one structured line (event "rate_limited"),
// so a blocked employee can be matched to the limit that refused them. A
// request Nginx refused, or one that never reached the server, leaves no
// such line (docs/RATE_LIMITS.md, "Telling blocks apart"). The line names
// the policy, its limit and window, the route with its IDs replaced, and
// the subject the policy counts: the verified user's ID for per-user
// limits, the client address (as TRUST_PROXY derives it) for per-address
// ones, the integration key's ID for Google Sheets. Never the query, body,
// headers, tokens or cookies. Repeated refusals of one subject by one
// policy are counted rather than each written: one line when a minute
// starts, then lines at its 10th, 100th, 1,000th and 10,000th refusal, so a
// flood shows at once without flooding the log.
export const rateLimitLogInterval = 60000;
const floodMarks = new Set([10, 100, 1000, 10000]);
const writeEvent = (event) => {
  if (process.env.NODE_ENV !== "test") console.log(JSON.stringify(event));
};
// "/api/leads/<uuid>/assign?x=y" → "/api/leads/:id/assign": path words
// stay, anything with a digit or other characters becomes :id.
export function routeCategory(req) {
  return (
    String(req.originalUrl || req.url || "")
      .split("?")[0]
      .split("/")
      .slice(0, 8)
      .map((part) =>
        !part || /^[a-z][a-z_-]{0,39}$/i.test(part) ? part : ":id",
      )
      .join("/") || "/"
  );
}
const subjects = {
  user: (req) => ({ user_id: req.rateLimitUser || null }),
  invitee: (req) => ({ user_id: req.invitedUser?.id || null }),
  integration: (req) => ({ integration: req.rateLimitIntegration || null }),
  ip: (req) => ({ client_ip: req.ip || null }),
};
function refusalLog(write = writeEvent, now = Date.now) {
  const recent = new Map();
  const line = (req, name, policy, limit, subject, at, minute, repeated) => {
    const reset = req.rateLimit?.resetTime;
    write({
      event: "rate_limited",
      at: new Date(at).toISOString(),
      source: "api",
      policy: name,
      per: policy.per,
      limit,
      window_minutes: policy.minutes,
      method: req.method,
      route: routeCategory(req),
      authenticated: Boolean(req.rateLimitUser),
      ...subject,
      retry_after_s: reset
        ? Math.max(0, Math.ceil((new Date(reset).getTime() - at) / 1000))
        : null,
      // Refusals of this subject by this policy in the current minute, this
      // one included, and those not written since its previous line.
      refusals_this_minute: minute,
      repeated,
      request_id: req.id || null,
    });
  };
  return (req, name, policy, limit) => {
    const subject = subjects[policy.per](req);
    const key = name + "|" + Object.values(subject).join("|");
    const at = now();
    const last = recent.get(key);
    if (last && at - last.at < rateLimitLogInterval) {
      last.count++;
      last.held++;
      if (!floodMarks.has(last.count)) return;
      line(req, name, policy, limit, subject, at, last.count, last.held - 1);
      last.held = 0;
      return;
    }
    if (recent.size >= 10000)
      for (const [k, v] of recent)
        if (at - v.at >= rateLimitLogInterval) recent.delete(k);
    if (recent.size >= 10000) recent.clear();
    recent.set(key, { at, count: 1, held: 0 });
    line(req, name, policy, limit, subject, at, 1, last ? last.held : 0);
  };
}
export function createApiLimiters(
  overrides = {},
  env = process.env,
  diagnostics = {},
) {
  const limits = rateLimitSettings(env, overrides);
  const logRefusal = refusalLog(diagnostics.write, diagnostics.now);
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
      handler: (req, res) => {
        // The refusal is answered whatever happens to its log line.
        try {
          logRefusal(req, name, policy, limits[name]);
        } catch {
          // A diagnostics failure never changes the response.
        }
        res.status(429).json({ error, request_id: req.id });
      },
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
export const sheetsSyncLimit = policy("sheetsSync");
