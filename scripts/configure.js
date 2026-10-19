import { readFile, writeFile, chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import { configurationFiles } from "./configuration.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run npm run configure in an interactive terminal.");
  process.exit(1);
}

let hidden = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!hidden) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const root = new URL("../", import.meta.url);
const connectionOnly = process.argv.includes("--connection-only");
rl.on("SIGINT", () => rl.close());

async function ask(label, secret = false) {
  if (!secret) return (await rl.question(label)).trim();
  process.stdout.write(label);
  hidden = true;
  try {
    return await rl.question("");
  } finally {
    hidden = false;
    process.stdout.write("\n");
  }
}

try {
  let existing;
  try {
    existing = await readFile(new URL(".env", root), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existing = await readFile(new URL(".env.example", root), "utf8");
  }
  const saved = parseEnv(existing);
  const savedUrl = saved.SUPABASE_URL?.startsWith("https://")
    ? saved.SUPABASE_URL
    : "";
  const savedPublicKey =
    saved.VITE_SUPABASE_ANON_KEY &&
    !saved.VITE_SUPABASE_ANON_KEY.startsWith("replace-with-")
      ? saved.VITE_SUPABASE_ANON_KEY
      : "";
  console.log("HD Marketing configuration — values stay in local .env files.");
  console.log(
    "Keys and passwords are hidden while typing. Paste, then press Enter.",
  );
  const settings = {
    url:
      (await ask(
        savedUrl
          ? "Supabase Project URL (press Enter to keep saved URL): "
          : "Supabase Project URL: ",
      )) || savedUrl,
    publicKey:
      (
        await ask(
          savedPublicKey
            ? "Publishable key (press Enter to keep saved key): "
            : "Publishable key (or legacy anon key): ",
          true,
        )
      ).trim() || savedPublicKey,
    secretKey: (
      await ask("Secret key (or legacy service_role key): ", true)
    ).trim(),
  };
  if (!connectionOnly) {
    settings.adminEmail = await ask("CRM admin login email: ");
    settings.adminPassword = await ask(
      "CRM admin password (at least 12 characters): ",
      true,
    );
    settings.agentEmail = await ask(
      "CRM agent login email (different from admin): ",
    );
    settings.agentPassword = await ask(
      "CRM agent password (at least 12 characters): ",
      true,
    );
  }
  const files = configurationFiles(settings, existing, {
    accounts: !connectionOnly,
  });
  await writeFile(new URL(".env", root), files.root, { mode: 0o600 });
  await chmod(new URL(".env", root), 0o600);
  await writeFile(new URL("client/.env", root), files.client, { mode: 0o600 });
  await chmod(new URL("client/.env", root), 0o600);
  console.log(
    "Saved root .env and client/.env. No login accounts were created or changed.",
  );
  console.log(
    connectionOnly
      ? "Next run: npm run dev. Sign in with your existing Auth account."
      : "Next run: npm run setup:dev",
  );
} catch (error) {
  console.error(
    error.code
      ? "Configuration was not completed. Check file access and retry."
      : error.message,
  );
  process.exitCode = 1;
} finally {
  rl.close();
}
