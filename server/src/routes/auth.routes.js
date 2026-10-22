import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loginLimit, passwordResetLimit } from "../middleware/rateLimit.js";
// One message for a wrong password and a locked account (no account probing).
export const SIGN_IN_REFUSED =
  "Email or password is incorrect, or sign-in is temporarily locked after repeated attempts. Check your details or try again in 15 minutes.";
const credentials = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254),
    password: z.string().min(1).max(1024),
    portal: z.enum(["admin", "agent"]),
  })
  .strict();
const bounded = (value, fallback, min, max, name) => {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
};
export function loginSettings(env = process.env) {
  const hours = (env.LOGIN_BUSINESS_HOURS || "08-21").match(
    /^(\d{1,2})-(\d{1,2})$/,
  );
  if (!hours)
    throw new Error(
      "LOGIN_BUSINESS_HOURS must look like 08-21 (Pakistan time).",
    );
  return {
    max: bounded(env.LOGIN_MAX_ATTEMPTS, 5, 1, 20, "LOGIN_MAX_ATTEMPTS"),
    window: bounded(
      env.LOGIN_WINDOW_MINUTES,
      15,
      1,
      1440,
      "LOGIN_WINDOW_MINUTES",
    ),
    lock: bounded(env.LOGIN_LOCK_MINUTES, 15, 1, 1440, "LOGIN_LOCK_MINUTES"),
    businessStart: bounded(hours[1], 8, 0, 23, "LOGIN_BUSINESS_HOURS start"),
    businessEnd: bounded(hours[2], 21, 0, 23, "LOGIN_BUSINESS_HOURS end"),
  };
}
// Isolated, non-persistent client: the sign-in session is returned to the
// browser only, never kept by the server or shared with the admin client.
function createSignInClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
const fail = (message, status, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
export function authRouter(db, options = {}) {
  const router = Router();
  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (!error) return data;
    throw fail(
      ["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code)
        ? "Sign-in needs CRM database update 037 after 036."
        : "Sign-in is temporarily unavailable. Please try again.",
      503,
    );
  };
  router.post("/login", loginLimit, async (req, res) => {
    const { email, password, portal } = credentials.parse(req.body);
    let settings;
    try {
      settings = loginSettings(options.loginEnv);
    } catch (error) {
      throw fail("Sign-in configuration: " + error.message, 503);
    }
    const record = (success, user) =>
      rpc("record_login_attempt", {
        p_email: email,
        p_success: success,
        p_user: user,
        p_portal: portal,
        p_ip: String(req.ip || "").slice(0, 100),
        p_agent: String(req.get("user-agent") || "").slice(0, 300),
        p_max: settings.max,
        p_window: settings.window,
        p_lock: settings.lock,
        p_business_start: settings.businessStart,
        p_business_end: settings.businessEnd,
      });
    const refuse = () => res.status(401).json({ error: SIGN_IN_REFUSED });
    // A locked account is refused before Supabase is asked about the password.
    if ((await rpc("login_attempt_status", { p_email: email })).locked) {
      await record(false, null);
      return refuse();
    }
    let result;
    try {
      result = await (
        options.createSignInClient || createSignInClient
      )().auth.signInWithPassword({ email, password });
    } catch {
      result = { error: {} };
    }
    const session = result.data?.session;
    if (result.error || !session?.access_token || !session.refresh_token) {
      const status = result.error?.status;
      // Provider outages and Supabase's own rate limits are not wrong passwords.
      if (status === 429)
        throw fail(
          "Too many sign-in attempts. Wait a few minutes and try again.",
          429,
        );
      if (!status || status >= 500)
        throw fail(
          "Sign-in is temporarily unavailable. Supabase could not be reached; please try again.",
          503,
        );
      await record(false, null);
      return refuse();
    }
    let recorded;
    try {
      recorded = await record(true, session.user?.id || null);
    } catch (error) {
      // Never leave a usable session behind when the attempt was not recorded.
      await db.auth.admin.signOut(session.access_token).catch(() => {});
      throw error;
    }
    if (recorded.outcome !== "success") {
      // A lock taken by a parallel attempt wins; discard this new session.
      await db.auth.admin.signOut(session.access_token).catch(() => {});
      return refuse();
    }
    res.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
      user: { id: session.user.id, email: session.user.email },
    });
  });
  router.post("/forgot-password", passwordResetLimit, async (req, res) => {
    const { email } = z
      .object({
        email: z
          .string()
          .trim()
          .toLowerCase()
          .email("Please enter a valid email address.")
          .max(254),
      })
      .strict()
      .parse(req.body);
    const user = await findUserByEmail(db, email, options);
    if (!user) {
      return res.status(404).json({
        error: "This email is not registered in our system.",
      });
    }
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("id, role, active")
      .eq("id", user.id)
      .single();
    if (profileError || !profile) {
      return res.status(404).json({
        error: "No administrator profile found for this account.",
      });
    }
    if (profile.role !== "admin") {
      return res.status(403).json({
        error:
          "Password reset is only available for administrator accounts. Agents must contact an administrator to change their password.",
      });
    }
    if (!profile.active) {
      return res.status(403).json({
        error:
          "This administrator account is disabled. Contact system support.",
      });
    }
    const redirectTo = `${process.env.FRONTEND_URL || "http://localhost:5173"}/login`;
    const reset =
      options.resetPasswordForEmail ||
      ((e, opts) => db.auth.resetPasswordForEmail(e, opts));
    const result = await reset(user.email, { redirectTo });
    if (result?.error) {
      throw fail(
        result.error.message || "Failed to send reset email. Please try again.",
        500,
      );
    }
    res.json({
      message:
        "If your administrator account exists, check your inbox for a reset link.",
    });
  });
  return router;
}

export async function findUserByEmail(db, email, options = {}) {
  const normalized = email.trim().toLowerCase();
  if (typeof options.findUserByEmail === "function") {
    return options.findUserByEmail(normalized);
  }
  if (typeof db.auth?.admin?.listUsers === "function") {
    let page = 1;
    while (true) {
      const { data, error } = await db.auth.admin.listUsers({
        page,
        perPage: 100,
      });
      if (error || !data?.users) break;
      const found = data.users.find(
        (u) => u.email?.trim().toLowerCase() === normalized,
      );
      if (found) return found;
      if (data.users.length < 100) break;
      page++;
    }
  }
  return null;
}
