export function authErrorMessage(error) {
  if (
    error?.code === "email_not_confirmed" ||
    /email not confirmed/i.test(error?.message || "")
  )
    return "Confirm your email using the link in your inbox. Ask your administrator to resend it if needed.";
  if (["otp_expired", "flow_state_expired"].includes(error?.code))
    return "This email link has expired or was already used. Ask your administrator for a new confirmation link.";
  if (
    error?.name === "AuthRetryableFetchError" ||
    /^(load failed|failed to fetch|network request failed|fetch failed)$/i.test(
      error?.message || "",
    )
  ) {
    return "Supabase login could not be reached. Check your internet connection and try again.";
  }
  return error?.message || "Sign-in could not be completed. Please try again.";
}
