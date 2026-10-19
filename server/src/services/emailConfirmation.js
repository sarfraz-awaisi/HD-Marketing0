// Redirects come exclusively from server configuration, never a request origin.
export function confirmationRedirect() {
  let site;
  try {
    if (process.env.NODE_ENV === "production" && !process.env.FRONTEND_URL)
      throw new Error();
    site = new URL(process.env.FRONTEND_URL || "http://localhost:5173");
    if (
      site.username ||
      site.password ||
      site.search ||
      site.hash ||
      !["http:", "https:"].includes(site.protocol) ||
      (process.env.NODE_ENV === "production" && site.protocol !== "https:") ||
      (site.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(site.hostname))
    )
      throw new Error();
  } catch {
    throw Object.assign(
      new Error(
        "Configure FRONTEND_URL with the CRM address before sending verification emails.",
      ),
      { status: 503 },
    );
  }
  return new URL("login", site.href.endsWith("/") ? site : site.href + "/")
    .href;
}

export async function sendEmailConfirmation(db, email) {
  const emailRedirectTo = confirmationRedirect();
  let response;
  try {
    response = await db.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo },
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
          ? "Verification emails are temporarily rate-limited. Wait a few minutes, then resend."
          : "Verification email could not be sent. Check Supabase email delivery settings, then resend from Accounts.",
      ),
      { status: limited ? 429 : 503 },
    );
  }
}
