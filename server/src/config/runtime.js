import { isIP } from "node:net";
import { rateLimitSettings } from "../middleware/rateLimit.js";
export function trustProxy(value = "loopback") {
  if (value === "false") return false;
  const entries = value.split(",").map((item) => item.trim());
  if (
    !entries.length ||
    entries.some((item) => {
      if (["loopback", "linklocal", "uniquelocal"].includes(item)) return false;
      const [ip, prefix, ...extra] = item.split("/");
      const family = isIP(ip);
      return (
        !family ||
        extra.length ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
      );
    })
  )
    throw new Error(
      "TRUST_PROXY must be false, named networks or explicit IP/CIDR entries; never use true or a hop count.",
    );
  return entries;
}
// The Supabase CLI's local API; LOCAL_DEV_ONLY accepts nothing else.
export function isLocalSupabase(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "54321" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
// LOCAL_DEV_ONLY=true (local .env only) refuses every setting that reaches a
// hosted service, so a stray production value stops startup instead of
// touching live data, sending real email or calling Meta.
export function localOnlyProblems(env = process.env) {
  const problems = [];
  if (env.NODE_ENV === "production")
    problems.push("NODE_ENV must not be production");
  if (!isLocalSupabase(env.SUPABASE_URL))
    problems.push(
      "SUPABASE_URL must be the local Supabase API http://127.0.0.1:54321",
    );
  if (["smtp", "resend"].includes(env.ACCOUNT_EMAIL_PROVIDER))
    problems.push(
      "ACCOUNT_EMAIL_PROVIDER must not send real email (local Auth email goes to Mailpit)",
    );
  if (env.CALL_PROVIDER && !["manual", "mock"].includes(env.CALL_PROVIDER))
    problems.push("CALL_PROVIDER must be manual or mock");
  const meta = Object.keys(env).filter(
    (key) =>
      key.startsWith("META_") && key !== "META_ANSWER_RETENTION_DAYS" && env[key],
  );
  if (meta.length)
    problems.push(meta.join(", ") + " must be empty (Meta is a live service)");
  return problems;
}
export function validateRuntime(env = process.env) {
  trustProxy(env.TRUST_PROXY || "loopback");
  // Throws for a RATE_LIMIT_* value that is not a whole number >= 1.
  rateLimitSettings(env);
  const port = Number(env.PORT || 3001),
    interval = Number(env.JOB_INTERVAL_SECONDS || 60);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  if (!Number.isInteger(interval) || interval < 10 || interval > 240)
    throw new Error(
      "JOB_INTERVAL_SECONDS must be between 10 and 240 for the five-minute health check.",
    );
  if (env.LOCAL_DEV_ONLY === "true") {
    const problems = localOnlyProblems(env);
    if (problems.length)
      throw new Error("LOCAL_DEV_ONLY: " + problems.join("; "));
  }
  if (env.NODE_ENV !== "production") return;
  const failures = [];
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FRONTEND_URL",
    "WEBHOOK_SECRET",
    "ACCOUNTS_PIN_PEPPER",
    "CALL_PROVIDER",
  ]) {
    if (!env[key]?.trim() || /^(replace[-_ ]|your[-_ ]|<)/i.test(env[key]))
      failures.push(key + " is required (use a real configured value)");
  }
  for (const key of ["WEBHOOK_SECRET", "ACCOUNTS_PIN_PEPPER"])
    if ((env[key]?.length || 0) < 32)
      failures.push(key + " must contain at least 32 characters");
  for (const key of ["SUPABASE_URL", "FRONTEND_URL"]) {
    try {
      const url = new URL(env[key]);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        /^(localhost|127\.|\[::1\])/.test(url.hostname)
      )
        throw new Error();
    } catch {
      failures.push(key + " must be a public HTTPS origin");
    }
  }
  if (env.CALL_PROVIDER !== "manual")
    failures.push(
      "CALL_PROVIDER must be manual; mock/cloud calling is not available in production",
    );
  if (!["true", "false"].includes(env.REQUIRE_AGENT_MFA || "false"))
    failures.push("REQUIRE_AGENT_MFA must be true or false");
  if (failures.length)
    throw new Error("Production configuration: " + failures.join("; "));
}
