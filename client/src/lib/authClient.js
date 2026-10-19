import { AuthClient } from "@supabase/auth-js";
export function createAuthClient(url, key, options = {}) {
  const origin = new URL(url);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid Supabase URL.");
  if (!key || key.startsWith("sb_secret_"))
    throw new Error("Use only the public Supabase key in the browser.");
  return {
    auth: new AuthClient({
      url: new URL("auth/v1", origin.href.replace(/\/?$/, "/")).href,
      headers: { apikey: key, Authorization: "Bearer " + key },
      storageKey: `sb-${origin.hostname.split(".")[0]}-auth-token`,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit",
      ...options,
    }),
  };
}
