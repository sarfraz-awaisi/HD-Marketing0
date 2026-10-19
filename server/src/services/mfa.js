import { createClient } from "@supabase/supabase-js";
import { authRequest } from "./authRequests.js";
export function requireAgentMfa() {
  const value = process.env.REQUIRE_AGENT_MFA || "false";
  if (!["true", "false"].includes(value))
    throw Object.assign(new Error("REQUIRE_AGENT_MFA must be true or false."), {
      status: 503,
    });
  return value === "true";
}
export async function mfaRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42P01", "42883"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : error.code === "42501"
      ? 403
      : error.code === "PT423"
        ? 423
        : error.code === "40001"
          ? 409
          : error.code === "P0002"
            ? 404
            : error.code === "22023"
              ? 400
              : 503;
  throw Object.assign(
    new Error(
      missing
        ? "Two-factor login needs CRM database update 025 after 024."
        : error.code === "PT423"
          ? "Unlock Accounts with your PIN to continue."
          : error.code === "40001"
            ? "A two-factor reset is already running. Try again later."
            : error.code === "22023"
              ? "Another administrator must reset your two-factor login."
              : "Two-factor security could not be confirmed. Please try again.",
    ),
    {
      status,
      missingFunction: ["PGRST202", "42883"].includes(error.code),
      code: missing
        ? "MFA_DATABASE_UPDATE"
        : error.code === "55000"
          ? "MFA_RESET_PENDING"
          : "MFA_OPERATION_FAILED",
    },
  );
}
export function createMfaClient(token) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key)
    throw Object.assign(
      new Error("Server authentication settings are missing."),
      { status: 503 },
    );
  return createClient(url, key, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "hd-mfa-request-" + crypto.randomUUID(),
    },
  });
}
export function totpFactors(user) {
  return (user?.factors || []).filter(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
}
export async function verifiedClaims(db, token, userId) {
  const { data, error } = await authRequest(db, "getClaims", token);
  if (error || !data?.claims || data.claims.sub !== userId)
    throw Object.assign(new Error("Invalid or expired session"), {
      status: 401,
    });
  return data.claims;
}
export function freshMfa(claims, state, enrolled) {
  const verifiedAt = Math.max(
    0,
    ...(claims.amr || [])
      .filter(
        (a) =>
          ["totp", "mfa/totp"].includes(a.method) &&
          Number.isFinite(a.timestamp),
      )
      .map((a) => a.timestamp),
  );
  return (
    claims.aal === "aal2" &&
    enrolled &&
    !state.reset_pending &&
    (!state.reset_after || verifiedAt >= state.reset_after)
  );
}
