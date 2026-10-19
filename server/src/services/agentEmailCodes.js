import { createClient } from "@supabase/supabase-js";
export function createEmailOtpClient() {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key)
    throw Object.assign(
      new Error("Server email verification settings are missing."),
      { status: 503 },
    );
  // Verification creates a temporary recipient session. Never use the shared
  // service client for it or install it as the administrator's workspace session.
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "hd-email-code-" + crypto.randomUUID(),
    },
  });
}
export async function requestAgentEmailCode(client, user) {
  let response;
  try {
    // Unconfirmed admin-created users use confirmation OTP delivery. Trying
    // passwordless signup here fails when public signup is disabled. A user
    // already confirmed by an earlier attempt needs the normal email OTP path.
    response = user.email_confirmed_at
      ? await client.auth.signInWithOtp({
          email: user.email,
          options: { shouldCreateUser: false },
        })
      : await client.auth.resend({ type: "signup", email: user.email });
  } catch {
    response = { error: {} };
  }
  if (response.error) {
    const limited =
      response.error.status === 429 ||
      ["over_email_send_rate_limit", "over_request_rate_limit"].includes(
        response.error.code,
      );
    const unauthorized = response.error.code === "email_address_not_authorized";
    throw Object.assign(
      new Error(
        limited
          ? "Verification codes are temporarily rate-limited. Wait before resending."
          : unauthorized
            ? "Supabase's default sender only emails project-team members. Configure a sender in Supabase SMTP settings; an eligible Gmail account can be used without a paid plan. Then resend from Accounts."
            : "Verification code could not be requested. Check Supabase SMTP and the email code template, then resend from Accounts.",
      ),
      { status: limited ? 429 : 503 },
    );
  }
}
