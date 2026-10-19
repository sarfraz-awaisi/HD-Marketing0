import { createClient } from "@supabase/supabase-js";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function pinSecret(override) {
  const secret =
    override ||
    process.env.ACCOUNTS_PIN_PEPPER ||
    (process.env.NODE_ENV !== "production"
      ? process.env.SUPABASE_SERVICE_ROLE_KEY
      : undefined);
  if (!secret || secret.length < 32)
    throw Object.assign(
      new Error("Account security is not configured on the server."),
      { status: 503 },
    );
  return secret;
}
const input = (pin, secret) =>
  createHmac("sha256", secret).update(pin).digest();
export async function hashPin(pin, secret) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(input(pin, secret), salt, 32, parameters);
  return `scrypt1:${salt}:${key.toString("hex")}`;
}
export async function matchesPin(pin, stored, secret) {
  if (!/^scrypt1:[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored || "")) return false;
  const [, salt, value] = stored.split(":");
  const key = await derive(input(pin, secret), salt, 32, parameters);
  return timingSafeEqual(key, Buffer.from(value, "hex"));
}
export async function verifyAdminPassword(db, actor, password) {
  const { data, error } = await db.auth.admin.getUserById(actor);
  if (error || !data.user?.email) return false;
  const verifier = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  let result;
  try {
    result = await verifier.auth.signInWithPassword({
      email: data.user.email,
      password,
    });
    return !result.error && result.data.user?.id === actor;
  } finally {
    if (result?.data.session) {
      try {
        await verifier.auth.signOut({ scope: "local" });
      } catch {}
    }
  }
}
