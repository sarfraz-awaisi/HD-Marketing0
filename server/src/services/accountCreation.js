// Email-code requests created before update 036 can still be resumed, resent or
// cancelled here. New accounts are created directly (accountProvisioning.js).
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountMailConfig,
  sendAccountCreationEmail,
} from "./accountCreationMail.js";
export const creationPassword = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= 72,
    "Use a password up to 72 bytes",
  );
const fail = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, code });
export function creationSecret(env = process.env) {
  const secret = env.ACCOUNT_OTP_SECRET;
  if (!secret || secret.length < 32 || /^(replace|your|<)/i.test(secret))
    throw fail(
      "Configure ACCOUNT_OTP_SECRET with at least 32 random characters on the server.",
      503,
    );
  return secret;
}
export const creationDigest = (secret, ...parts) =>
  createHmac("sha256", secret).update(JSON.stringify(parts)).digest("hex");
export const creationBinding = (secret, id, data) =>
  creationDigest(
    secret,
    "binding-v1",
    id,
    data.email,
    data.name,
    data.role,
    data.active,
    data.password,
  );
export function accountCreationService(db, options = {}) {
  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (!error) return data;
    if (
      ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(error.code)
    )
      throw fail(
        "Account creation verification needs CRM database update 035 after 034.",
        503,
        "ACCOUNTS_MIGRATION_REQUIRED",
      );
    if (error.code === "PT423")
      throw fail(
        "Unlock Accounts with your PIN to continue.",
        423,
        "ACCOUNTS_LOCKED",
      );
    if (error.code === "42501")
      throw fail("Administrator access required.", 403);
    if (error.code === "P0002") throw fail("Pending request not found.", 404);
    if (error.code === "23505")
      throw fail(
        "An account or pending request with this email already exists. Resume the pending request instead.",
        409,
      );
    if (error.code === "PT429")
      throw fail(
        "Too many requests. Wait at least 60 seconds before resending; hourly limits also apply.",
        429,
      );
    if (error.code === "40001")
      throw fail(
        "Account creation is already running or changed. Retry shortly; once provisioning starts, use Resume verification to finish.",
        409,
      );
    if (error.code === "22023")
      throw fail(
        "This request cannot be completed. Resume verification or start a new request.",
      );
    throw fail(
      "Account setup could not finish. Resume verification to retry safely.",
      503,
    );
  };
  const config = () => {
    const secret = creationSecret(options.creationEnv);
    if (!options.sendAccountCreationEmail)
      accountMailConfig(options.creationEnv);
    return secret;
  };
  const deliver = async (grant, id, version, code, email, request) => {
    let sent = false;
    try {
      await (options.sendAccountCreationEmail || sendAccountCreationEmail)({
        id,
        version,
        code,
        email,
      });
      sent = true;
    } catch {}
    let summary;
    try {
      summary = await rpc("finish_account_creation_email", {
        ...grant,
        p_id: id,
        p_version: version,
        p_sent: sent,
        p_request: request,
      });
    } catch {
      return {
        ...(await rpc("account_creation_list", grant)).find(
          (r) => r.request_id === id,
        ),
        verification_required: true,
        email_sent: false,
        warning:
          "Email delivery could not be confirmed. Resume the pending request and resend after the cooldown.",
      };
    }
    return {
      ...summary,
      verification_required: true,
      email_sent: sent,
      ...(sent
        ? { message: "Code requested. Verify the email to create the account." }
        : {
            warning:
              "Verification email could not be sent. Check sender settings, then resend. No login account was created.",
          }),
    };
  };
  const context = (grant, id) =>
    rpc("account_creation_context", { ...grant, p_id: id });
  const trustedNative = (user, r) =>
    user?.id === r.id &&
    user.email?.toLowerCase() === r.normalized_email &&
    user.app_metadata?.crm_account_request === r.id &&
    !!user.email_confirmed_at &&
    !user.deleted_at;
  const nativeLookup = async (r) => {
    const result = await db.auth.admin.getUserById(r.id);
    if (result.error?.status === 404 || result.error?.code === "user_not_found")
      return null;
    if (result.error)
      throw fail(
        "Account creation status could not be checked. Resume verification to retry.",
        503,
      );
    if (!result.data?.user) return null;
    if (!trustedNative(result.data.user, r))
      throw fail(
        "This account identity is already in use. Contact your administrator; no existing account was changed.",
        409,
      );
    return result.data.user;
  };
  return {
    list: (grant) => rpc("account_creation_list", grant),
    async resend(grant, id, request) {
      const secret = config(),
        r = await context(grant, id),
        version = randomUUID();
      let code;
      do {
        code = String(randomInt(0, 1000000)).padStart(6, "0");
      } while (
        creationDigest(secret, "otp-v1", id, r.version, code) === r.otp_hash
      );
      await rpc("resend_account_creation", {
        ...grant,
        p_id: id,
        p_hash: creationDigest(secret, "otp-v1", id, version, code),
        p_version: version,
        p_request: request,
      });
      return deliver(grant, id, version, code, r.normalized_email, request);
    },
    cancel: (grant, id, request) =>
      rpc("cancel_account_creation", {
        ...grant,
        p_id: id,
        p_request: request,
      }),
    async verify(grant, id, body, request) {
      const data = z
        .object({
          code: z
            .string()
            .trim()
            .regex(/^\d{6}$/),
          password: creationPassword,
        })
        .strict()
        .parse(body);
      const secret = creationSecret(options.creationEnv),
        r = await context(grant, id),
        claim = randomUUID();
      const result = await rpc("begin_account_creation", {
        ...grant,
        p_id: id,
        p_hash: creationDigest(secret, "otp-v1", id, r.version, data.code),
        p_binding: creationBinding(secret, id, {
          email: r.normalized_email,
          name: r.requested_name,
          role: r.requested_role,
          active: r.desired_active,
          password: data.password,
        }),
        p_claim: claim,
        p_request: request,
      });
      if (result.result === "completed")
        return {
          ...result,
          message: "Account already created. No duplicate account was created.",
        };
      const errors = {
        invalid: ["Invalid verification code. Please try again.", 400],
        expired: [
          "Verification code has expired. Please request a new code.",
          400,
        ],
        locked: [
          "Too many failed attempts. Request a new verification code.",
          429,
        ],
        busy: ["Account creation is already running. Retry shortly.", 409],
        limited: ["Too many verification attempts. Try again later.", 429],
        cancelled: ["This verification request was cancelled.", 400],
        unavailable: [
          "No code is available. Resend the verification email.",
          400,
        ],
      };
      if (result.result !== "allowed")
        throw fail(
          ...(errors[result.result] || ["Verification is unavailable.", 400]),
        );
      try {
        // Recheck current authorization immediately before the external mutation.
        await context(grant, id);
        if (!(await nativeLookup(r))) {
          let created;
          try {
            created = await db.auth.admin.createUser({
              id: r.id,
              email: r.normalized_email,
              password: data.password,
              email_confirm: true,
              user_metadata: { name: r.requested_name },
              app_metadata: {
                crm_provisioning: true,
                crm_account_request: r.id,
              },
            });
          } catch {
            created = { error: {} };
          }
          // The deterministic id and trusted metadata recover an ambiguous
          // timeout or duplicate attempt without touching somebody else's user.
          if (!trustedNative(created.data?.user, r) && !(await nativeLookup(r)))
            throw fail(
              "Account creation could not finish. Retry the same verification request; no duplicate account will be created.",
              503,
            );
        }
        const summary = await rpc("complete_account_creation", {
          ...grant,
          p_id: id,
          p_claim: claim,
          p_request: request,
        });
        return {
          ...summary,
          message: "Email verified. Account created successfully.",
        };
      } finally {
        await rpc("release_account_creation", {
          ...grant,
          p_id: id,
          p_claim: claim,
        }).catch(() => {});
      }
    },
  };
}
