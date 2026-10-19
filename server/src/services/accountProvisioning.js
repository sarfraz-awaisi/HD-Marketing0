import { randomUUID } from "node:crypto";
import { z } from "zod";
import { creationPassword } from "./accountCreation.js";
import { checkEmailProvider } from "./accountInvitations.js";
export const GMAIL_ONLY_MESSAGE =
  "Only valid @gmail.com email addresses are allowed.";
export const UID_TAKEN_MESSAGE =
  "This UID is already assigned to another account. Please choose a different UID.";
export const UID_FORMAT_MESSAGE =
  "Enter a 6-digit UID from 100000 to 999999. It cannot begin with 0.";
// Domain and syntax only; this cannot prove that Google registered the mailbox.
export const gmailAccountEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())
  .refine((email) => /^[^@]+@gmail\.com$/.test(email), GMAIL_ONLY_MESSAGE);
export const accountUid = z
  .union([
    z.string().regex(/^[1-9]\d{5}$/),
    z.number().int().min(100000).max(999999),
  ])
  .transform(Number);
const fields = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string(),
    password: creationPassword,
    role: z.enum(["agent", "admin"]),
    active: z.boolean().default(true),
    uid_mode: z.enum(["auto", "manual"]).default("auto"),
    uid: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .strict();
const fail = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, code });
export function parseAccountCreation(body) {
  const email = gmailAccountEmail.safeParse(body?.email);
  if (!email.success)
    throw fail(GMAIL_ONLY_MESSAGE, 400, "ACCOUNTS_INVALID_EMAIL");
  const data = fields.parse(body);
  if (data.uid_mode === "auto") {
    if (data.uid != null)
      throw fail(
        "Choose Enter UID Manually to assign a specific UID.",
        400,
        "ACCOUNTS_INVALID_UID",
      );
    return { ...data, email: email.data, uid: null };
  }
  // A manual UID is validated as entered and never replaced by a random one.
  const uid = accountUid.safeParse(data.uid);
  if (!uid.success) throw fail(UID_FORMAT_MESSAGE, 400, "ACCOUNTS_INVALID_UID");
  return { ...data, email: email.data, uid: uid.data };
}
export function accountProvisioningService(db) {
  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (!error) return data;
    if (
      ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(error.code)
    )
      throw fail(
        "Account creation needs CRM database update 036 after 035.",
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
    if (error.code === "23505")
      throw fail(
        "An account with this email already exists.",
        409,
        "ACCOUNTS_EMAIL_EXISTS",
      );
    if (error.code === "PT409")
      throw fail(UID_TAKEN_MESSAGE, 409, "ACCOUNTS_UID_TAKEN");
    if (error.code === "22023")
      throw fail("Check the account fields and try again.", 400);
    throw fail(
      "Account creation could not be completed. Please try again.",
      503,
    );
  };
  const trusted = (user, id, email) =>
    user?.id === id &&
    user.email?.toLowerCase() === email &&
    user.app_metadata?.crm_account_request === id &&
    !!user.email_confirmed_at &&
    !user.deleted_at;
  // Only this request's reserved random id is ever looked up or accepted.
  const lookup = async (id, email) => {
    const result = await db.auth.admin.getUserById(id);
    if (result.error?.status === 404 || result.error?.code === "user_not_found")
      return null;
    if (result.error) throw new Error("lookup failed");
    if (!result.data?.user) return null;
    if (!trusted(result.data.user, id, email))
      throw fail(
        "This account identity is already in use. No existing account was changed.",
        409,
      );
    return result.data.user;
  };
  return {
    available: (grant, uid) =>
      rpc("account_uid_available", { ...grant, p_uid: uid }),
    async create(grant, body, request) {
      const data = parseAccountCreation(body);
      checkEmailProvider(data.email);
      const id = randomUUID();
      const reserved = await rpc("begin_account_provisioning", {
        ...grant,
        p_id: id,
        p_email: data.email,
        p_name: data.name,
        p_role: data.role,
        p_active: data.active,
        p_uid: data.uid,
        p_request: request,
      });
      // Server-only Auth administration: the admin's own session is untouched.
      // The profile trigger stores the reserved UID, name and role in the same
      // database transaction as the Auth user, with access still disabled.
      let created;
      try {
        created = await db.auth.admin.createUser({
          id,
          email: data.email,
          password: data.password,
          email_confirm: true,
          user_metadata: { name: data.name },
          app_metadata: { crm_provisioning: true, crm_account_request: id },
        });
      } catch {
        created = { error: {} };
      }
      if (!trusted(created.data?.user, id, data.email)) {
        let native;
        try {
          native = await lookup(id, data.email);
        } catch (error) {
          if (error.status) throw error;
          throw fail(
            "Account creation could not be confirmed. Refresh Accounts before trying again.",
            503,
          );
        }
        if (!native) {
          await rpc("fail_account_provisioning", {
            ...grant,
            p_id: id,
            p_request: request,
          }).catch(() => {});
          const code = created.error?.code;
          if (["email_exists", "user_already_exists"].includes(code))
            throw fail(
              "An account with this email already exists.",
              409,
              "ACCOUNTS_EMAIL_EXISTS",
            );
          if (code === "weak_password")
            throw fail(
              "Choose a stronger password of at least 12 characters.",
              400,
            );
          throw fail(
            "The login account could not be created. Nothing was saved; please try again.",
            503,
          );
        }
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const summary = await rpc("complete_account_provisioning", {
            ...grant,
            p_id: id,
            p_request: request,
          });
          return { ...summary, message: "Account created successfully." };
        } catch {}
      }
      throw fail(
        `The login account was created with UID ${reserved.uid}, but its setup could not finish. It stays disabled until an administrator enables it in Accounts.`,
        503,
        "ACCOUNTS_CREATE_INCOMPLETE",
      );
    },
  };
}
