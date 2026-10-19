import { createAuthClient } from "./authClient";
export const configured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export const supabase = configured
  ? createAuthClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
      {
        detectSessionInUrl: !window.location.pathname
          .replace(/\/+$/, "")
          .endsWith("/accept-invitation"),
      },
    )
  : null;

// Keep a candidate login isolated until the CRM confirms its portal role.
// This client neither saves credentials nor broadcasts auth events to the app.
export function createLoginClient() {
  if (!configured) throw new Error("Supabase setup is required.");
  return createAuthClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `hd-marketing-portal-login-${crypto.randomUUID()}`,
    },
  );
}
