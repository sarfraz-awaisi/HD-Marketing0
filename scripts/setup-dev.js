import { createClient } from "@supabase/supabase-js";
import { requireLocalDevelopment } from "./local-only.js";
if (process.env.NODE_ENV === "production")
  throw new Error("Development setup forbidden in production");
// Applies the LOCAL_DEV_ONLY checks before any account is created.
requireLocalDevelopment();
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
for (const role of ["admin", "agent"]) {
  const prefix = "DEV_" + role.toUpperCase();
  const email = process.env[prefix + "_EMAIL"],
    password = process.env[prefix + "_PASSWORD"];
  if (!email || !password || password.length < 12)
    throw new Error(
      `${prefix} requires explicit email and password of at least 12 characters`,
    );
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { name: role === "admin" ? "HD Administrator" : "HD Agent" },
  });
  if (error)
    throw new Error(
      `Account creation failed (${role}); use a new email or manage existing accounts in Supabase`,
    );
  const result = await db
    .from("profiles")
    .update({ role, active: false })
    .eq("id", data.user.id);
  if (result.error) throw new Error("Profile setup failed");
  const verification = await db.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo:
        (process.env.FRONTEND_URL || "http://localhost:5173") + "/login",
    },
  });
  if (verification.error)
    throw new Error(
      "Development verification could not be requested; review SMTP in Supabase.",
    );
  console.log(
    `Created pending development ${role}. Verify its inbox, then enable the known profile through trusted administration.`,
  );
}
