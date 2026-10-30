import {
  isLocalSupabase,
  validateRuntime,
} from "../server/src/config/runtime.js";

// Development tools must opt in, even if NODE_ENV is unset.
export function requireLocalDevelopment(env = process.env) {
  if (env.LOCAL_DEV_ONLY !== "true" || !isLocalSupabase(env.SUPABASE_URL))
    throw new Error(
      "LOCAL_DEV_ONLY: require LOCAL_DEV_ONLY=true and http://127.0.0.1:54321",
    );
  if (env.VITE_SUPABASE_URL && !isLocalSupabase(env.VITE_SUPABASE_URL))
    throw new Error("LOCAL_DEV_ONLY: browser Supabase must also be local");
  validateRuntime(env);
}
