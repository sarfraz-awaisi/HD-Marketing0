import { z } from "zod";
import { confirmationRedirect } from "./emailConfirmation.js";
export const accountEmail = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .refine(
    (email) =>
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
        email.split("@")[1],
      ),
    "Please enter a valid email address.",
  )
  .transform((email) => email.toLowerCase());
export function checkEmailProvider(email) {
  const domain = email.split("@")[1];
  const blocked = (process.env.CRM_BLOCKED_EMAIL_DOMAINS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (blocked.includes(domain))
    throw Object.assign(
      new Error(
        "This email provider is not permitted. Use your regular work email.",
      ),
      { status: 400 },
    );
}
export function invitationMinutes() {
  const value = Number(process.env.CRM_INVITATION_TTL_MINUTES || 60);
  if (!Number.isInteger(value) || value < 5 || value > 60)
    throw Object.assign(
      new Error("Configure the invitation expiry between 5 and 60 minutes."),
      { status: 503 },
    );
  return value;
}
export function invitationRedirect(ticket) {
  const url = new URL(confirmationRedirect());
  url.pathname = url.pathname.replace(/login$/, "accept-invitation");
  url.searchParams.set("ticket", ticket);
  return url.href;
}
export async function requestInvitationEmail(db, user, redirectTo) {
  let response;
  try {
    response = user.email_confirmed_at
      ? await db.auth.resetPasswordForEmail(user.email, { redirectTo })
      : await db.auth.admin.inviteUserByEmail(user.email, {
          redirectTo,
          data: { name: user.name },
        });
  } catch {
    response = { error: {} };
  }
  if (response.error) {
    const limited =
      response.error.status === 429 ||
      ["over_email_send_rate_limit", "over_request_rate_limit"].includes(
        response.error.code,
      );
    throw Object.assign(
      new Error(
        limited
          ? "Invitation emails are temporarily rate-limited. Wait before resending."
          : "Invitation email could not be requested. Check Supabase SMTP and redirect settings, then resend from Accounts.",
      ),
      { status: limited ? 429 : 503 },
    );
  }
}
