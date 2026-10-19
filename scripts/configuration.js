import { parseEnv } from "node:util";

// Node's --env-file parser supports quoted values, but not JSON-style escaped quotes.
export function envValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Settings must fit on one line.");
  const quote = ["'", '"', "`"].find((candidate) => !value.includes(candidate));
  if (!quote)
    throw new Error(
      "Use a password without all three quote characters together.",
    );
  return `${quote}${value}${quote}`;
}

function legacyRole(key) {
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
      .role;
  } catch {
    return null;
  }
}

export function validateSettings(settings, { accounts = true } = {}) {
  let url;
  try {
    url = new URL(settings.url);
  } catch {
    throw new Error("Enter the Supabase Project URL from Connect.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  ) {
    throw new Error(
      "Use the Supabase Project URL, without credentials or query parameters.",
    );
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Hosted Supabase projects require an HTTPS URL.");
  }
  if (
    !settings.publicKey.startsWith("sb_publishable_") &&
    legacyRole(settings.publicKey) !== "anon"
  ) {
    throw new Error(
      "For the public key, copy a Publishable key or legacy anon key.",
    );
  }
  if (
    !settings.secretKey.startsWith("sb_secret_") &&
    legacyRole(settings.secretKey) !== "service_role"
  ) {
    throw new Error(
      "For the server key, copy a Secret key or legacy service_role key.",
    );
  }
  if (settings.publicKey === settings.secretKey)
    throw new Error("Public and server keys must be different.");
  if (accounts) {
    for (const role of ["admin", "agent"]) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings[`${role}Email`]))
        throw new Error(`Enter a valid ${role} email address.`);
      if (settings[`${role}Password`].length < 12)
        throw new Error(`The ${role} password needs at least 12 characters.`);
    }
    if (settings.adminEmail.toLowerCase() === settings.agentEmail.toLowerCase())
      throw new Error("Use different emails for admin and agent.");
  }
  Object.values(settings).forEach(envValue);
}

export function configurationFiles(
  settings,
  existingRoot,
  { accounts = true } = {},
) {
  validateSettings(settings, { accounts });
  const url = settings.url.replace(/\/$/, "");
  const values = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: settings.secretKey,
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: settings.publicKey,
    ...(accounts
      ? {
          DEV_ADMIN_EMAIL: settings.adminEmail,
          DEV_ADMIN_PASSWORD: settings.adminPassword,
          DEV_AGENT_EMAIL: settings.agentEmail,
          DEV_AGENT_PASSWORD: settings.agentPassword,
        }
      : {}),
  };
  let root = existingRoot;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, "gm");
    const line = `${key}=${envValue(value)}`;
    root = pattern.test(root)
      ? root.replace(pattern, () => line)
      : root.trimEnd() + "\n" + line + "\n";
  }
  // Build the browser config from public values only, never the server config.
  const frontend = {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: settings.publicKey,
    VITE_API_URL: parseEnv(root).VITE_API_URL || "/api",
  };
  const client =
    "# Public browser configuration only.\n" +
    Object.entries(frontend)
      .map(([key, value]) => `${key}=${envValue(value)}`)
      .join("\n") +
    "\n";
  return { root, client };
}
