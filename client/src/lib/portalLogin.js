import { createLoginClient, supabase } from "./supabase";
import { api } from "./api";
import { authErrorMessage } from "./authErrors";
import { rememberLoginEmail } from "./loginEmails";
import { prepareMfa } from "./mfaLogin";

export async function signInToPortal({ email, password }, portal) {
  if (!["admin", "agent", "staff"].includes(portal))
    throw new Error("Choose Agent, Staff or Admin to sign in.");
  const candidate = createLoginClient();
  let session;
  try {
    // The CRM server applies the per-account lockout and records login
    // history; the session stays in this isolated client until the saved
    // portal role is confirmed below.
    const tokens = await api("/auth/login", {
      method: "POST",
      body: { email: email.trim(), password, portal },
    });
    const result = await candidate.auth.setSession({
      access_token: tokens?.access_token,
      refresh_token: tokens?.refresh_token,
    });
    if (result.error) throw new Error(authErrorMessage(result.error));
    session = result.data?.session;
    if (!session?.access_token || !session?.refresh_token)
      throw new Error("Sign-in could not be completed. Please try again.");
    const profile = await api(`/me?portal=${portal}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!profile.active || profile.role !== portal)
      throw new Error(
        `This account cannot sign in to the ${{ admin: "Admin", agent: "Agent", staff: "Staff" }[portal]} portal. Choose the correct portal for your account.`,
      );
    if (profile.mfa_required)
      return { mfa: await prepareMfa(candidate, profile, email) };
    const saved = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (saved.error) throw new Error(authErrorMessage(saved.error));
    rememberLoginEmail(portal, email);
    return profile;
  } catch (error) {
    if (session) {
      try {
        await candidate.auth.signOut({ scope: "local" });
      } catch {
        // The rejected candidate was never installed in the browser session.
      }
    }
    throw error;
  }
}
