import { createClient } from "@supabase/supabase-js";
export function getAdmin() {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key)
    throw new Error("Configure server Supabase credentials in root .env");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
