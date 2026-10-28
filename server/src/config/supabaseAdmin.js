import { createClient } from "@supabase/supabase-js";
import { isLocalSupabase } from "./runtime.js";
export function getAdmin() {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key)
    throw new Error("Configure server Supabase credentials in root .env");
  if (process.env.LOCAL_DEV_ONLY === "true" && !isLocalSupabase(url))
    throw new Error(
      "LOCAL_DEV_ONLY: Refusing to connect to a non-local Supabase instance.",
    );
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
