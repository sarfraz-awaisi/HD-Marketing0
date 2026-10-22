const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key } = process.env;
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url || ""))
  throw new Error("Configure public Supabase URL");
let valid = key?.startsWith("sb_publishable_");
try {
  valid ||=
    JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role === "anon";
} catch {}
if (!valid)
  throw new Error(
    "Browser build requires a public anon/publishable key, never a privileged key",
  );
