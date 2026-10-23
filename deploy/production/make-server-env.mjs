#!/usr/bin/env node
// Builds the production server settings (/etc/hd-crm/production/server.env)
// on the Mac from an allowlist of the local .env plus fixed production
// values, and checks them with the API's own production validator. Prints key
// names only, never a value. The file is written with mode 600 and is never
// overwritten. Copy it to the VPS with scp; bootstrap-vps.sh --server-env
// installs it and deletes the uploaded copy.
//
//   node deploy/production/make-server-env.mjs --domain hdmarketing.tech \
//     [--from .env] [--out ~/hd-crm-server.env] [--dry-run]
// --dry-run runs every check and writes nothing.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs, parseEnv } from "node:util";
import { validateRuntime } from "../../server/src/config/runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values: args } = parseArgs({
  options: {
    domain: { type: "string" },
    from: { type: "string", default: join(root, ".env") },
    out: { type: "string", default: join(homedir(), "hd-crm-server.env") },
    "dry-run": { type: "boolean", default: false },
  },
});
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(args.domain || ""))
  fail("Give --domain as a lower-case host name such as hdmarketing.tech");
if (!existsSync(args.from)) fail(`Source settings not found: ${args.from}`);
if (existsSync(args.out) && !args["dry-run"])
  fail(`${args.out} already exists; move or delete it first (never overwritten)`);

const source = parseEnv(readFileSync(args.from, "utf8"));
// Existing installation secrets are carried unchanged: a new
// ACCOUNTS_PIN_PEPPER or ACCOUNT_OTP_SECRET would invalidate PINs and codes.
const carried = new Set([
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACCOUNTS_PIN_PEPPER",
  "ACCOUNT_OTP_SECRET",
  "ACCOUNT_EMAIL_PROVIDER",
  "ACCOUNT_EMAIL_FROM",
  "ACCOUNT_SMTP_HOST",
  "ACCOUNT_SMTP_PORT",
  "ACCOUNT_SMTP_USER",
  "ACCOUNT_SMTP_PASSWORD",
  "RESEND_API_KEY",
  "REQUIRE_AGENT_MFA",
  "CRM_INVITATION_TTL_MINUTES",
  "CRM_BLOCKED_EMAIL_DOMAINS",
  "OUTCOME_GRACE_MINUTES",
  "RECORDING_RETENTION_DAYS",
  "JOB_INTERVAL_SECONDS",
  "PHONE_REVEAL_DAILY_LIMIT",
  "LEAD_DELETE_RETENTION_DAYS",
]);
const carriedPrefixes = ["LOGIN_", "RATE_LIMIT_", "META_"];
// Non-secret defaults come from the reviewed template.
const template = parseEnv(
  readFileSync(join(root, "deploy/production/production.env.example"), "utf8"),
);
const defaults = Object.fromEntries(
  [
    "REQUIRE_AGENT_MFA",
    "JOB_INTERVAL_SECONDS",
    "OUTCOME_GRACE_MINUTES",
    "RECORDING_RETENTION_DAYS",
    "PHONE_REVEAL_DAILY_LIMIT",
  ].map((key) => [key, template[key]]),
);
const fixed = {
  NODE_ENV: "production",
  FRONTEND_URL: `https://${args.domain}`,
  CALL_PROVIDER: "manual",
  TRUST_PROXY: "loopback",
};

const output = { ...fixed };
const kept = [];
const skipped = [];
for (const [key, value] of Object.entries(source)) {
  if (key in fixed) continue;
  if (carried.has(key) || carriedPrefixes.some((p) => key.startsWith(p))) {
    if (value !== "") {
      output[key] = value;
      kept.push(key);
    }
  } else if (key !== "WEBHOOK_SECRET") skipped.push(key);
}
const defaulted = [];
for (const [key, value] of Object.entries(defaults))
  if (!(key in output)) {
    output[key] = value;
    defaulted.push(key);
  }
let webhook = "kept";
if ((source.WEBHOOK_SECRET || "").length >= 32)
  output.WEBHOOK_SECRET = source.WEBHOOK_SECRET;
else {
  output.WEBHOOK_SECRET = randomBytes(32).toString("hex");
  webhook = "generated";
}

const problems = [];
try {
  validateRuntime(output);
} catch (error) {
  problems.push(error.message);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(output.SUPABASE_URL || ""))
  problems.push(
    "SUPABASE_URL must be https://<project>.supabase.co without a trailing slash (the frontend build uses the same value)",
  );
const serviceKey = output.SUPABASE_SERVICE_ROLE_KEY || "";
let role;
try {
  role = JSON.parse(
    Buffer.from(serviceKey.split(".")[1], "base64url").toString(),
  ).role;
} catch {}
if (role === "anon" || serviceKey.startsWith("sb_publishable_"))
  problems.push(
    "SUPABASE_SERVICE_ROLE_KEY holds the public anon key; use the service-role key",
  );
if (output.ACCOUNT_OTP_SECRET && output.ACCOUNT_OTP_SECRET.length < 32)
  problems.push("ACCOUNT_OTP_SECRET needs at least 32 characters");
if (
  output.META_OAUTH_REDIRECT_URL &&
  !output.META_OAUTH_REDIRECT_URL.startsWith(`https://${args.domain}/`)
)
  problems.push(
    `META_OAUTH_REDIRECT_URL must point to https://${args.domain}/ (set it for production first)`,
  );
if (problems.length) fail("Not written:\n- " + problems.join("\n- "));

// Unquoted when plain; otherwise single quotes, which the API's
// --env-file parser and the bootstrap check both read literally.
const line = ([key, value]) => {
  if (/^[A-Za-z0-9_@%+=:,./~^-]*$/.test(value)) return `${key}=${value}`;
  if (/['\n\r]/.test(value))
    fail(`${key} contains a quote or line break; set it by hand on the VPS`);
  return `${key}='${value}'`;
};
const text =
  "# Production settings for HD Marketing CRM, generated by deploy/production/make-server-env.mjs.\n" +
  "# Private: root:crm-prod 640 on the VPS. Never commit, print or share this file.\n" +
  Object.entries(output).map(line).join("\n") +
  "\n";
if (!isDeepStrictEqual(parseEnv(text), output))
  fail("Internal check failed: the file would not read back identically");
if (!args["dry-run"]) writeFileSync(args.out, text, { mode: 0o600, flag: "wx" });

console.log(
  args["dry-run"]
    ? `Dry run: all checks passed; nothing written. Values are not shown.`
    : `Written ${args.out} (mode 600). Values are not shown.`,
);
console.log(`Set for production: ${Object.keys(fixed).join(", ")}`);
console.log(`Carried from ${args.from}: ${kept.join(", ") || "none"}`);
console.log(`Template defaults: ${defaulted.join(", ") || "none"}`);
console.log(`WEBHOOK_SECRET: ${webhook}`);
console.log(`Not carried: ${skipped.join(", ") || "none"}`);
console.log(
  "Next: scp it to the VPS, then run bootstrap-vps.sh with --server-env (it installs and deletes the copy).",
);
