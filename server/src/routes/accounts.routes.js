import { Router } from "express";
import { mfaResetRequest } from "../utils/validators.js";
import { mfaRpc } from "../services/mfa.js";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { adminOnly } from "../middleware/role.js";
import {
  accountCreationLimit,
  accountSecurityLimit as securityLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import {
  digest,
  pinSecret,
  hashPin,
  matchesPin,
  verifyAdminPassword,
} from "../services/accountsSecurity.js";
import {
  accountEmail,
  checkEmailProvider,
  invitationMinutes,
  invitationRedirect,
  requestInvitationEmail,
} from "../services/accountInvitations.js";
import { uuid, accountVerification } from "../utils/validators.js";
import { sendEmailConfirmation } from "../services/emailConfirmation.js";
import { accountCreationService } from "../services/accountCreation.js";
import {
  accountProvisioningService,
  accountUid,
  UID_FORMAT_MESSAGE,
} from "../services/accountProvisioning.js";
import {
  createEmailOtpClient,
  requestAgentEmailCode,
} from "../services/agentEmailCodes.js";
const pin = z.string().regex(/^\d{4}$/, "Use exactly four digits");
const password = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= 72,
    "Use a password up to 72 bytes",
  );
const name = z.string().trim().min(1).max(200),
  role = z.enum(["admin", "agent"]);
const accountChange = z
  .object({
    name: name.optional(),
    role: role.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const fail = (message, status, code) =>
  Object.assign(new Error(message), { status, code });
function checked({ data, error }) {
  if (!error) return data;
  if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code))
    throw fail(
      "Accounts needs a database update. Apply CRM migration 016.",
      503,
      "ACCOUNTS_MIGRATION_REQUIRED",
    );
  if (error.code === "PT423")
    throw fail(
      "Unlock Accounts with your PIN to continue.",
      423,
      "ACCOUNTS_LOCKED",
    );
  if (error.code === "23505")
    throw fail("An account with this email already exists.", 409);
  if (error.code === "PT429")
    throw fail("Wait a minute before requesting another invitation.", 429);
  if (error.code === "42501") throw fail("Administrator access required", 403);
  if (error.code === "P0002") throw fail("Account not found", 404);
  if (error.code === "22023") {
    const messages = [
      "You cannot disable or demote your own administrator account",
      "Keep at least one active administrator",
      "Use your own password recovery flow to change your login password",
      "Use the agent handover dialog before disabling an agent with leads",
      "No other active agents. Choose Keep with admin.",
      "Choose an active agent",
      "This account has not completed email verification",
      "This account has not accepted its invitation",
      "Account is already active",
      "Invitation already accepted",
      "You cannot delete your own administrator account",
      "Type the account email to confirm deletion",
      "This account is being deleted and cannot be changed",
    ];
    throw fail(
      messages.includes(error.message)
        ? error.message
        : "Check the account fields and try again.",
      400,
    );
  }
  throw fail(
    "Account operation could not be completed. Please try again.",
    503,
  );
}
function authResult({ data, error }) {
  if (!error) return data;
  if (
    [
      "email_exists",
      "user_already_exists",
      "email_address_not_authorized",
    ].includes(error.code)
  )
    throw fail(
      "This email is already registered or cannot be used. Check the account list.",
      409,
    );
  if (error.code === "weak_password")
    throw fail("Choose a stronger password of at least 12 characters.", 400);
  throw fail(
    "Supabase account administration could not be reached. Check the account list before retrying.",
    503,
  );
}
export function accountsRouter(db, options = {}) {
  const router = Router();
  const creation = accountCreationService(db, options);
  const provisioning = accountProvisioningService(db);
  router.use(["/accounts", "/account-security"], adminOnly);
  const session = (req) => digest(req.headers.authorization || "");
  const grant = (req) => ({
    p_actor: req.user.id,
    p_session: session(req),
    p_unlock: digest(req.get("X-Accounts-Unlock") || ""),
  });
  const rpc = async (method, args) => {
    const response = await db.rpc(method, args);
    if (method.includes("email_code") && response.error) {
      const { code } = response.error;
      if (["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(code))
        throw fail(
          "Account email codes need CRM database update 034 after 033.",
          503,
          "ACCOUNTS_MIGRATION_REQUIRED",
        );
      if (code === "PT429")
        throw fail(
          "Too many code requests or attempts. Wait a minute, then resend the code.",
          429,
        );
      if (code === "40001")
        throw fail(
          "Email verification changed or is already running. Wait briefly, then try again.",
          409,
        );
      if (code === "22023")
        throw fail(
          "Email code expired, cancelled or unavailable. Resend the code for a pending account.",
          400,
        );
    }
    if (
      ["prepare_account_deletion", "finish_account_deletion"].includes(method)
    ) {
      if (["PGRST202", "42883", "42P01"].includes(response.error?.code))
        throw fail(
          "Account deletion needs CRM database update 028 after 027.",
          503,
          "ACCOUNTS_MIGRATION_REQUIRED",
        );
      if (response.error?.code === "40001")
        throw fail(
          "Account deletion is already running or changed. Try again shortly.",
          409,
          "ACCOUNTS_DELETE_BUSY",
        );
    }
    if (
      [
        "check_account_email",
        "issue_account_invitation",
        "finish_account_invitation",
        "cancel_account_invitation",
      ].includes(method) &&
      ["PGRST202", "42883", "42P01"].includes(response.error?.code)
    )
      throw fail(
        "Account invitations need CRM migration 023 after 022.",
        503,
        "ACCOUNTS_MIGRATION_REQUIRED",
      );
    if (
      ["offboard_agent", "offboard_preview"].includes(method) &&
      ["PGRST202", "42883", "42P01"].includes(response.error?.code)
    )
      throw fail(
        "Agent handover needs CRM migration 022 after 021.",
        503,
        "ACCOUNTS_MIGRATION_REQUIRED",
      );
    return checked(response);
  };
  const gate = async (req, _res, next) => {
    await rpc("accounts_gate", grant(req));
    next();
  };
  const action = async (req, target, value) => {
    const result = await db.rpc("account_action", {
      ...grant(req),
      p_target: target,
      p_action: value,
      p_request: req.id,
    });
    if (
      value.startsWith("email_confirmation_") &&
      result.error?.code === "22023"
    )
      throw fail(
        "Email confirmation needs CRM migration 020 after 019. Ask your administrator to apply the update.",
        503,
      );
    return checked(result);
  };
  const update = (req, target, data) =>
    rpc("update_account", {
      ...grant(req),
      p_target: target,
      p_data: data,
      p_request: req.id,
    });
  const confirmation = async (req, id, email) => {
    await action(req, id, "email_confirmation_requested");
    try {
      await sendEmailConfirmation(db, email);
    } catch (error) {
      try {
        await action(req, id, "email_confirmation_failed");
      } catch {}
      throw error;
    }
    try {
      await action(req, id, "email_confirmation_sent");
      return { sent: true };
    } catch {
      return {
        sent: true,
        warning:
          "Verification email requested. Its completion audit could not be confirmed; check the account before retrying.",
      };
    }
  };
  const unban = async (id) =>
    authResult(
      await db.auth.admin.updateUserById(id, { ban_duration: "none" }),
    );
  router.get("/account-security", async (req, res) => {
    const row = checked(
      await db
        .from("account_security")
        .select("updated_at,locked_until")
        .eq("admin_id", req.user.id)
        .maybeSingle(),
    );
    res.json({
      configured: !!row,
      updated_at: row?.updated_at || null,
      locked_until: row?.locked_until || null,
    });
  });
  router.put(
    "/account-security",
    sensitiveLimit,
    securityLimit,
    async (req, res) => {
      const data = z
        .object({
          pin,
          confirm_pin: pin,
          password: z.string().min(1).max(1024),
        })
        .strict()
        .refine((v) => v.pin === v.confirm_pin, { message: "PINs must match" })
        .parse(req.body);
      const verify = options.verifyPassword || verifyAdminPassword;
      if (!(await verify(db, req.user.id, data.password)))
        throw fail("Your current login password was not accepted.", 403);
      const hashed = await hashPin(data.pin, pinSecret(options.pinSecret));
      res.json(
        await rpc("save_accounts_pin", {
          p_actor: req.user.id,
          p_hash: hashed,
          p_request: req.id,
        }),
      );
    },
  );
  router.post(
    "/account-security/unlock",
    sensitiveLimit,
    securityLimit,
    async (req, res) => {
      const data = z.object({ pin }).strict().parse(req.body);
      const row = checked(
        await db
          .from("account_security")
          .select("pin_hash,version,locked_until")
          .eq("admin_id", req.user.id)
          .maybeSingle(),
      );
      if (!row)
        throw fail(
          "Set your Accounts PIN in Admin settings → Security first.",
          428,
          "ACCOUNTS_PIN_REQUIRED",
        );
      const token = randomBytes(32).toString("hex");
      const valid =
        row.locked_until && new Date(row.locked_until) > new Date()
          ? false
          : await matchesPin(
              data.pin,
              row.pin_hash,
              pinSecret(options.pinSecret),
            );
      const result = await rpc("unlock_accounts", {
        p_actor: req.user.id,
        p_session: session(req),
        p_version: row.version,
        p_valid: valid,
        p_token: digest(token),
        p_request: req.id,
      });
      if (result.status === "allowed")
        return res.json({ token, expires_at: result.expires_at });
      if (result.status === "locked")
        return res.status(429).json({
          error:
            "Too many incorrect PINs. Try again after the lockout ends, or reset your PIN using your login password in Admin settings.",
          code: "ACCOUNTS_PIN_LOCKED",
          locked_until: result.locked_until,
        });
      if (result.status === "incorrect")
        throw fail(
          `Incorrect PIN. ${result.remaining} ${result.remaining === 1 ? "attempt" : "attempts"} remaining.`,
          403,
        );
      throw fail(
        "Your PIN settings changed. Reload the page and try again.",
        409,
      );
    },
  );
  router.post("/account-security/lock", async (req, res) => {
    await rpc("lock_accounts", grant(req));
    res.status(204).end();
  });
  router.get("/accounts", gate, async (req, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().trim().max(100).default(""),
        role: role.optional(),
        access: z
          .enum([
            "active",
            "disabled",
            "pending",
            "expired",
            "cancelled",
            "deleting",
          ])
          .optional(),
      })
      .strict()
      .parse(req.query);
    res.json(
      await rpc("accounts_page", {
        ...grant(req),
        p_page: q.page,
        p_limit: q.limit,
        p_search: q.search,
        p_role: q.role || "",
        p_access: q.access || "",
      }),
    );
  });
  router.get("/accounts/pending", gate, async (req, res) => {
    res.json(await creation.list(grant(req)));
  });
  router.get(
    "/accounts/uid-availability",
    sensitiveLimit,
    gate,
    async (req, res) => {
      const { uid } = z.object({ uid: z.string() }).strict().parse(req.query);
      const parsed = accountUid.safeParse(uid);
      if (!parsed.success)
        throw fail(UID_FORMAT_MESSAGE, 400, "ACCOUNTS_INVALID_UID");
      res.json(await provisioning.available(grant(req), parsed.data));
    },
  );
  router.post(
    "/accounts/pending/:requestId/resend",
    sensitiveLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      res.json(
        await creation.resend(
          grant(req),
          uuid.parse(req.params.requestId),
          req.id,
        ),
      );
    },
  );
  router.post(
    "/accounts/pending/:requestId/verify",
    sensitiveLimit,
    gate,
    async (req, res) => {
      res.json(
        await creation.verify(
          grant(req),
          uuid.parse(req.params.requestId),
          req.body,
          req.id,
        ),
      );
    },
  );
  router.delete(
    "/accounts/pending/:requestId",
    sensitiveLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      await creation.cancel(
        grant(req),
        uuid.parse(req.params.requestId),
        req.id,
      );
      res.status(204).end();
    },
  );
  router.use("/accounts/:id", async (req, _res, next) => {
    if (req.params.id === "pending") return next();
    if (req.method === "GET" || (req.method === "DELETE" && req.path === "/"))
      return next();
    const target = await rpc("account_detail", {
      ...grant(req),
      p_target: uuid.parse(req.params.id),
    });
    if (
      target.deletion_requested_at ||
      target.account_status === "deletion_pending"
    )
      throw fail(
        "This account is being deleted. Retry Delete account to finish.",
        409,
        "ACCOUNTS_DELETE_PENDING",
      );
    if (target.account_creation_pending)
      throw fail(
        "Resume pending account verification before changing this account.",
        409,
        "ACCOUNTS_CREATION_PENDING",
      );
    next();
  });
  router.delete("/accounts/:id", sensitiveLimit, gate, async (req, res) => {
    z.object({}).strict().parse(req.query);
    const data = z
      .object({ confirm: z.literal(true), email: accountEmail })
      .strict()
      .parse(req.body);
    const id = uuid.parse(req.params.id),
      operation = randomUUID();
    const args = {
      ...grant(req),
      p_target: id,
      p_operation: operation,
      p_request: req.id,
    };
    const prepared = await rpc("prepare_account_deletion", {
      ...args,
      p_email: data.email,
    });
    if (prepared.deleted)
      return res.json({ ...prepared, message: "Account deleted." });
    try {
      const lookup = await db.auth.admin.getUserById(id);
      const absent =
        lookup.error?.status === 404 || lookup.error?.code === "user_not_found";
      const native = absent ? null : authResult(lookup).user;
      // Completion independently checks auth.users.deleted_at, including when
      // a provider hides a previously deleted user during a recovery attempt.
      if (native && !native.deleted_at)
        authResult(await db.auth.admin.deleteUser(id, true));
    } catch {
      try {
        await rpc("finish_account_deletion", { ...args, p_success: false });
      } catch {}
      throw fail(
        "Sign-in access is blocked, but account deletion could not finish. Retry Delete account. Customer history is retained.",
        503,
        "ACCOUNTS_DELETE_PENDING",
      );
    }
    try {
      const completed = await rpc("finish_account_deletion", {
        ...args,
        p_success: true,
      });
      res.json({
        ...completed,
        message: `Account deleted. ${completed.leads} leads moved to the admin pool; activity history retained.`,
      });
    } catch (error) {
      if ([401, 403, 423].includes(error.status)) throw error;
      // Release this attempt for immediate recovery if its completion audit failed.
      try {
        await rpc("finish_account_deletion", { ...args, p_success: false });
      } catch {}
      throw fail(
        "Account access is blocked, but deletion confirmation could not be saved. Retry Delete account to finish.",
        503,
        "ACCOUNTS_DELETE_PENDING",
      );
    }
  });
  router.get(
    "/accounts/:id/offboard-preview",
    sensitiveLimit,
    gate,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      res.json(
        await rpc("offboard_preview", {
          ...grant(req),
          p_agent: uuid.parse(req.params.id),
        }),
      );
    },
  );
  router.post(
    "/accounts/:id/offboard",
    sensitiveLimit,
    gate,
    async (req, res) => {
      const data = z
        .object({
          mode: z.enum(["equal", "single", "admin"]),
          target: uuid.nullable().optional(),
          changes: z
            .object({ name: name.optional(), role: role.optional() })
            .strict()
            .optional(),
        })
        .strict()
        .refine((v) => (v.mode === "single" ? !!v.target : !v.target), {
          message: "Choose an active target only for a single-agent handover",
        })
        .parse(req.body);
      res.json(
        await rpc("offboard_agent", {
          ...grant(req),
          p_agent: uuid.parse(req.params.id),
          p_mode: data.mode,
          p_target: data.target || null,
          p_request: req.id,
          p_changes: data.changes || {},
        }),
      );
    },
  );
  router.get("/accounts/:id", gate, async (req, res) => {
    res.json(
      await rpc("account_detail", {
        ...grant(req),
        p_target: uuid.parse(req.params.id),
      }),
    );
  });
  const invite = async (req, id, active = true) => {
    const ticket = randomBytes(32).toString("hex"),
      hash = digest(ticket),
      redirectTo = invitationRedirect(ticket);
    const prepared = await rpc("issue_account_invitation", {
      ...grant(req),
      p_target: id,
      p_hash: hash,
      p_ttl: invitationMinutes(),
      p_active: active,
      p_request: req.id,
    });
    let sent = false,
      warning;
    try {
      const native = authResult(await db.auth.admin.getUserById(id)).user;
      await unban(id);
      await requestInvitationEmail(
        db,
        { ...native, name: prepared.name },
        redirectTo,
      );
      sent = true;
    } catch (error) {
      warning = error.message;
    }
    try {
      await rpc("finish_account_invitation", {
        ...grant(req),
        p_target: id,
        p_hash: hash,
        p_sent: sent,
        p_request: req.id,
      });
    } catch {
      warning =
        "Invitation setup could not be confirmed. Check the account before resending. Access remains blocked.";
      sent = false;
    }
    return {
      id,
      invitation_required: true,
      invitation_sent: sent,
      message: sent
        ? "Invitation requested. Waiting for email verification and password setup."
        : "Account pending invitation. Access remains blocked.",
      ...(warning ? { warning } : {}),
    };
  };
  const emailClient = options.createEmailOtpClient || createEmailOtpClient;
  const sendAccountCode = async (req, id, active = null) => {
    await rpc("account_email_code_ready", grant(req));
    const hash = digest(randomBytes(32).toString("hex"));
    const prepared = await rpc("issue_agent_email_code", {
      ...grant(req),
      p_target: id,
      p_hash: hash,
      p_active: active,
      p_request: req.id,
    });
    let sent = false,
      warning;
    try {
      const native = authResult(await db.auth.admin.getUserById(id)).user;
      if (native?.id !== id || native.email?.toLowerCase() !== prepared.email)
        throw fail(
          "Account email could not be confirmed. Review the account before resending.",
          503,
        );
      authResult(
        await db.auth.admin.updateUserById(id, {
          ban_duration: "none",
          user_metadata: {
            ...(native.user_metadata || {}),
            crm_email_code: true,
          },
        }),
      );
      await requestAgentEmailCode(emailClient(), native);
      sent = true;
    } catch (error) {
      warning = error.message;
    }
    try {
      await rpc("finish_agent_email_code", {
        ...grant(req),
        p_target: id,
        p_hash: hash,
        p_sent: sent,
        p_request: req.id,
      });
    } catch {
      sent = false;
      warning =
        "Verification code delivery could not be confirmed. Access remains blocked. Check the account before resending.";
    }
    return {
      id,
      name: prepared.name,
      email: prepared.email,
      role: prepared.role,
      email_code_required: true,
      email_code_sent: sent,
      message: sent
        ? "Verification code requested. Enter the emailed code in Accounts and set the initial password."
        : "Account pending email verification. Access remains blocked.",
      ...(warning ? { warning } : {}),
    };
  };
  router.post(
    "/accounts/:id/email-code",
    sensitiveLimit,
    securityLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      const id = uuid.parse(req.params.id);
      await rpc("account_detail", { ...grant(req), p_target: id });
      res.json(await sendAccountCode(req, id));
    },
  );
  router.post(
    "/accounts/:id/email-code/verify",
    sensitiveLimit,
    securityLimit,
    gate,
    async (req, res) => {
      const data = z
        .object({
          code: z
            .string()
            .trim()
            .regex(/^\d{6}$/, "Enter the 6-digit code from the latest email."),
          password,
        })
        .strict()
        .parse(req.body);
      await rpc("account_email_code_ready", grant(req));
      const id = uuid.parse(req.params.id),
        claim = randomUUID();
      const args = { ...grant(req), p_target: id, p_claim: claim };
      const flow = await rpc("begin_agent_email_code", {
        ...args,
        p_request: req.id,
      });
      let verifier, session;
      try {
        // A previously consumed native code must not become an approval for
        // arbitrary code input when password saving or the final audit failed.
        if (flow.verified)
          throw fail(
            "This code has already been used. Resend a verification code to finish account setup.",
            400,
          );
        verifier = emailClient();
        let response;
        try {
          response = await verifier.auth.verifyOtp({
            email: flow.email,
            token: data.code,
            type: "email",
          });
        } catch {
          throw fail(
            "Email verification is temporarily unavailable. Please try again.",
            503,
          );
        }
        session = response.data?.session;
        const recipient = response.data?.user;
        if (
          response.error ||
          !session?.access_token ||
          recipient?.id !== id ||
          !recipient.email_confirmed_at ||
          recipient.email?.toLowerCase() !== flow.email
        )
          throw fail(
            "Wrong verification code or code expired. Enter the latest 6-digit code from the email or resend it.",
            400,
          );
        await rpc("mark_agent_email_code", {
          ...args,
          p_version: flow.version,
          p_request: req.id,
        });
        const changed = await db.auth.admin.updateUserById(id, {
          password: data.password,
        });
        if (changed.error || changed.data?.user?.id !== id)
          throw fail(
            "Email verified, but the password could not be saved. Resend a verification code and try again with a strong password.",
            503,
          );
        res.json(
          await rpc("complete_agent_email_code", {
            ...args,
            p_version: flow.version,
            p_request: req.id,
          }),
        );
      } finally {
        if (session)
          await verifier.auth.signOut({ scope: "local" }).catch(() => {});
        await rpc("release_agent_email_code", args).catch(() => {});
      }
    },
  );
  router.post(
    "/accounts",
    sensitiveLimit,
    accountCreationLimit,
    gate,
    async (req, res) => {
      res
        .status(201)
        .json(await provisioning.create(grant(req), req.body, req.id));
    },
  );
  router.post(
    "/accounts/:id/invitation",
    sensitiveLimit,
    securityLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      const id = uuid.parse(req.params.id);
      const target = await rpc("account_detail", {
        ...grant(req),
        p_target: id,
      });
      res.json(
        await (target.role === "admin" &&
        target.email_verification_method === "link"
          ? invite(req, id)
          : sendAccountCode(req, id)),
      );
    },
  );
  router.delete(
    "/accounts/:id/invitation",
    sensitiveLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      await rpc("cancel_account_invitation", {
        ...grant(req),
        p_target: uuid.parse(req.params.id),
        p_request: req.id,
      });
      res.status(204).end();
    },
  );
  router.post(
    "/accounts/:id/verification",
    sensitiveLimit,
    securityLimit,
    gate,
    async (req, res) => {
      accountVerification.parse(req.body);
      const id = uuid.parse(req.params.id);
      // Read the email from trusted Auth; no caller-supplied address or redirect.
      const existing = await rpc("account_detail", {
        ...grant(req),
        p_target: id,
      });
      if (existing.invitation_state)
        throw fail("Use Resend invitation for this account.", 400);
      const target = authResult(await db.auth.admin.getUserById(id)).user;
      if (!target?.email) throw fail("Account email is unavailable.", 404);
      if (target.email_confirmed_at)
        return res.json({ already_confirmed: true, sent: false });
      res.json(await confirmation(req, id, target.email));
    },
  );
  router.patch("/accounts/:id", sensitiveLimit, gate, async (req, res) => {
    const id = uuid.parse(req.params.id),
      data = accountChange.parse(req.body);
    if (data.active === true) {
      // Verify the target and current grant before touching Auth. The profile
      // stays inactive if a later audited SQL update fails.
      const target = await rpc("account_detail", {
        ...grant(req),
        p_target: id,
      });
      if (!target.active) await unban(id);
    }
    res.json(await update(req, id, data));
  });
  router.post(
    "/accounts/:id/password",
    sensitiveLimit,
    gate,
    async (req, res) => {
      const id = uuid.parse(req.params.id),
        data = z.object({ password }).strict().parse(req.body);
      const target = await rpc("account_detail", {
        ...grant(req),
        p_target: id,
      });
      if (
        !target.email_confirmed_at ||
        (target.invitation_state && target.invitation_state !== "accepted")
      )
        throw fail(
          "The recipient must verify their email and accept their invitation before password management.",
          400,
        );
      await action(req, id, "set_password_requested");
      try {
        authResult(
          await db.auth.admin.updateUserById(id, { password: data.password }),
        );
      } catch (error) {
        try {
          await action(req, id, "set_password_failed");
        } catch {}
        throw error;
      }
      try {
        await action(req, id, "set_password_completed");
        res.json({ updated: true });
      } catch {
        res.json({
          updated: true,
          warning:
            "Password updated. The request audit was saved, but its completion record could not be confirmed.",
        });
      }
    },
  );
  router.post(
    "/accounts/:id/mfa-reset",
    sensitiveLimit,
    gate,
    async (req, res) => {
      const id = uuid.parse(req.params.id);
      mfaResetRequest.parse(req.body);
      const target = await db
        .from("profiles")
        .select("id,role")
        .eq("id", id)
        .single();
      if (target.error || !target.data) throw fail("Account not found.", 404);
      if (target.data.role !== "agent")
        throw fail(
          "Administrator accounts do not require two-factor login. Only agent factors can be reset here.",
          400,
          "MFA_NOT_REQUIRED",
        );
      const operation = await mfaRpc(db, "mfa_reset_begin", {
        ...grant(req),
        p_target: id,
        p_request: req.id,
      });
      try {
        const listed = await db.auth.admin.mfa.listFactors({ userId: id });
        if (listed.error || !Array.isArray(listed.data?.factors))
          throw new Error();
        for (const factor of listed.data.factors) {
          const removed = await db.auth.admin.mfa.deleteFactor({
            userId: id,
            id: uuid.parse(factor.id),
          });
          if (removed.error) throw new Error();
        }
        const remaining = await db.auth.admin.mfa.listFactors({ userId: id });
        if (
          remaining.error ||
          !Array.isArray(remaining.data?.factors) ||
          remaining.data.factors.length > 0
        )
          throw new Error();
        await mfaRpc(db, "mfa_reset_finish", {
          p_actor: req.user.id,
          p_target: id,
          p_operation: operation,
          p_success: true,
          p_request: req.id,
        });
        res.json({
          reset: true,
          message:
            "Two-factor login reset. The user must sign in again and set up their authenticator when required.",
        });
      } catch {
        try {
          await mfaRpc(db, "mfa_reset_finish", {
            p_actor: req.user.id,
            p_target: id,
            p_operation: operation,
            p_success: false,
            p_request: req.id,
          });
        } catch {}
        throw Object.assign(
          new Error(
            "Two-factor reset could not be completed. Access remains blocked; retry this reset before the user signs in.",
          ),
          { status: 503, code: "MFA_RESET_PENDING" },
        );
      }
    },
  );
  return router;
}
