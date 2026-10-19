import { createLoginClient } from "./supabase";
import { api } from "./api";
export function readInvitationCallback() {
  const query = new URLSearchParams(window.location.search),
    hash = new URLSearchParams(window.location.hash.slice(1));
  const ticket = query.get("ticket"),
    type = hash.get("type") || query.get("type");
  if (
    !/^[a-f0-9]{64}$/.test(ticket || "") ||
    !["invite", "recovery"].includes(type)
  )
    return {
      error:
        "This invitation link is invalid or expired. Ask your administrator to resend it.",
    };
  return {
    ticket,
    type,
    access_token: hash.get("access_token"),
    refresh_token: hash.get("refresh_token"),
    token_hash: query.get("token_hash"),
  };
}
export async function openInvitation(callback) {
  if (callback.error) throw new Error(callback.error);
  const candidate = createLoginClient();
  let session;
  try {
    const response = callback.token_hash
      ? await candidate.auth.verifyOtp({
          token_hash: callback.token_hash,
          type: callback.type,
        })
      : await candidate.auth.setSession({
          access_token: callback.access_token || "",
          refresh_token: callback.refresh_token || "",
        });
    session = response.data?.session;
    if (response.error || !session?.access_token)
      throw new Error(
        "Invitation verification failed. Open a valid link from your inbox.",
      );
    const profile = await api("/onboarding/context", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: { ticket: callback.ticket },
    });
    return {
      profile,
      complete: async (password) => {
        const { data, error } = await candidate.auth.getSession();
        if (error || !data?.session?.access_token)
          throw new Error(
            "Your invitation session expired. Ask your administrator for a new link.",
          );
        const result = await api("/onboarding/complete", {
          method: "POST",
          headers: { Authorization: `Bearer ${data.session.access_token}` },
          body: { ticket: callback.ticket, password },
        });
        await candidate.auth.signOut({ scope: "local" }).catch(() => {});
        return result;
      },
      close: () => candidate.auth.signOut({ scope: "local" }).catch(() => {}),
    };
  } catch (error) {
    if (session)
      await candidate.auth.signOut({ scope: "local" }).catch(() => {});
    throw error;
  }
}
