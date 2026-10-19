// Sets up the daily encrypted backup on this Mac. Safe to run again.
// Usage: node scripts/install-mac-backup.mjs   (optional: BACKUP_TIME=21:30)
// The scheduled job runs from ~/.hd-crm because macOS blocks background jobs
// from reading the Desktop and Documents folders.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const config = join(home, ".hd-crm"),
  bin = join(config, "bin");
const label = "com.hdmarketing.crm-backup";
const fail = (message) => {
  console.error("Backup setup stopped: " + message);
  process.exit(1);
};
if (platform() !== "darwin") fail("this installer is for macOS.");
const [hour, minute] = (process.env.BACKUP_TIME || "21:30")
  .split(":")
  .map(Number);
if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59))
  fail("BACKUP_TIME must look like 21:30.");

const toolDirs = [
  "/opt/homebrew/opt/libpq/bin",
  "/usr/local/opt/libpq/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];
const find = (tool) => toolDirs.map((dir) => join(dir, tool)).find(existsSync);
for (const tool of ["pg_dump", "psql", "age", "age-keygen", "tar"])
  if (!find(tool))
    fail(`${tool} is missing. Install the tools first: brew install libpq age`);
const node = process.execPath;

// Settings the job needs from the project's private .env.
const projectEnv = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, "$2")]),
);
for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!projectEnv[key]) fail(`${key} is missing from the project .env.`);

mkdirSync(bin, { recursive: true, mode: 0o700 });
chmodSync(config, 0o700);
for (const script of ["backup.mjs", "backup-files.mjs"]) {
  copyFileSync(join(root, "deploy", script), join(bin, script));
  chmodSync(join(bin, script), 0o600);
}

// Only the public key is used for backups. Keep a copy of the private key
// somewhere safe (password manager or USB drive): it is needed to restore.
const key = join(config, "backup-key.txt");
if (!existsSync(key)) {
  execFileSync(find("age-keygen"), ["-o", key], { stdio: "ignore" });
  chmodSync(key, 0o600);
}
const recipient = execFileSync(find("age-keygen"), ["-y", key], {
  encoding: "utf8",
}).trim();

const settings = join(config, "backup.env");
const previous = existsSync(settings)
  ? Object.fromEntries(
      readFileSync(settings, "utf8")
        .split("\n")
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map(([, k, v]) => [k, v]),
    )
  : {};
const backupDir = previous.BACKUP_DIR || join(home, "HD-CRM-Backups");
const certificate = previous.PGSSLROOTCERT || join(config, "supabase-ca.crt");
writeFileSync(
  settings,
  [
    "# HD Marketing CRM daily backup settings. Private: never share this file.",
    "# SUPABASE_DB_URL: Supabase -> Connect -> Session pooler connection string,",
    "# with your database password in place of [YOUR-PASSWORD] (remove the brackets too), ending in",
    "# ?sslmode=verify-full (uses the certificate below) or ?sslmode=require.",
    `SUPABASE_DB_URL=${previous.SUPABASE_DB_URL || ""}`,
    // Certificate checking is used only once the downloaded file exists.
    existsSync(certificate)
      ? `PGSSLROOTCERT=${certificate}`
      : `# PGSSLROOTCERT: save Supabase's certificate as ${certificate} and run the installer again.`,
    `SUPABASE_URL=${projectEnv.SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${projectEnv.SUPABASE_SERVICE_ROLE_KEY}`,
    `BACKUP_AGE_RECIPIENT=${recipient}`,
    `BACKUP_DIR=${backupDir}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(settings, 0o600);

const runner = join(bin, "run-backup.sh");
writeFileSync(
  runner,
  `#!/bin/bash
# Daily HD Marketing CRM backup: database, then uploaded files.
set -uo pipefail
umask 077
# Homebrew's libpq is not linked into the usual PATH, so name the tools here.
export PATH="${[...new Set([dirname(node), ...toolDirs])].join(":")}"
dir="$HOME/.hd-crm"
echo "== $(date '+%Y-%m-%d %H:%M:%S') HD Marketing CRM backup"
status=0
"${node}" --env-file="$dir/backup.env" "$dir/bin/backup.mjs" || status=1
"${node}" --env-file="$dir/backup.env" "$dir/bin/backup-files.mjs" || status=1
exit $status
`,
  { mode: 0o700 },
);
chmodSync(runner, 0o700);

const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const agents = join(home, "Library", "LaunchAgents");
mkdirSync(agents, { recursive: true });
const plist = join(agents, label + ".plist");
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${xml(runner)}</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml([...new Set([dirname(node), ...toolDirs])].join(":"))}</string></dict>
  <key>StandardOutPath</key><string>${xml(join(config, "backup.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(config, "backup.log"))}</string>
</dict>
</plist>
`,
);
const domain = "gui/" + userInfo().uid;
try {
  execFileSync("launchctl", ["bootout", domain + "/" + label], {
    stdio: "ignore",
  });
} catch {
  // Not loaded yet.
}
execFileSync("launchctl", ["bootstrap", domain, plist]);

console.log(`Daily backup scheduled for ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (runs on wake if the Mac was asleep).
  Settings:      ${settings}
  Backups:       ${backupDir}
  Log:           ${join(config, "backup.log")}
  Private key:   ${key}  <- copy this to a password manager or USB drive
${previous.SUPABASE_DB_URL ? "" : "\nNext: open the settings file and paste your Supabase database connection string into SUPABASE_DB_URL.\n"}`);
