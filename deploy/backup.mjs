import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, lstat, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function databaseEnvironment(env) {
  let url;
  try {
    url = new URL(env.SUPABASE_DB_URL);
  } catch {
    throw new Error(
      "Configure SUPABASE_DB_URL in the private backup environment.",
    );
  }
  const ssl = url.searchParams.get("sslmode") || "verify-full";
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname.slice(1) ||
    url.port === "6543" ||
    !["require", "verify-full"].includes(ssl)
  )
    throw new Error(
      "Use a TLS direct/session database connection, not a transaction pooler.",
    );
  return {
    PATH: env.PATH,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: ssl,
    PGCONNECT_TIMEOUT: "30",
    PGAPPNAME: "hd-crm-backup",
    ...(env.PGSSLROOTCERT ? { PGSSLROOTCERT: env.PGSSLROOTCERT } : {}),
  };
}
function command(name, args, env, input) {
  const process = spawn(name, args, { env, stdio: ["pipe", "pipe", "ignore"] });
  const done = new Promise((resolve, reject) => {
    process.once("error", () => reject(new Error(name + " could not start.")));
    process.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(name + " failed.")),
    );
  });
  done.catch(() => {});
  if (input !== undefined) {
    process.stdin.on("error", () => {});
    process.stdin.end(input);
    process.stdout.resume();
  }
  return { process, done };
}
async function ledger(env, filename, success, bytes = 0, sha = null) {
  // Filename/digest are generated internally; no URL, password or path enters SQL.
  const sql = `select public.record_backup('${filename}',${success},${bytes},${sha ? "'" + sha + "'" : "null"});\n`;
  await command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], env, sql).done;
}
export async function runBackup(env = process.env) {
  const pgEnv = databaseEnvironment(env);
  if (!/^age1[a-z0-9]+$/.test(env.BACKUP_AGE_RECIPIENT || ""))
    throw new Error(
      "Configure the public BACKUP_AGE_RECIPIENT; never put the decryption key on the VPS.",
    );
  const dir = resolve(env.BACKUP_DIR || "/var/backups/hd-crm");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename =
    "hd-crm-" +
    new Date().toISOString().replace(/[^0-9TZ]/g, "") +
    "-" +
    randomUUID() +
    ".dump.age";
  const file = join(dir, filename),
    partial = file + ".partial";
  let dump, encrypt, timer;
  try {
    dump = command(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      pgEnv,
    );
    dump.process.stdin.end();
    encrypt = command(
      "age",
      ["--encrypt", "--recipient", env.BACKUP_AGE_RECIPIENT],
      { PATH: env.PATH },
    );
    timer = setTimeout(() => {
      dump.process.kill("SIGKILL");
      encrypt.process.kill("SIGKILL");
    }, 2 * 3600000);
    await Promise.all([
      pipeline(dump.process.stdout, encrypt.process.stdin),
      pipeline(
        encrypt.process.stdout,
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      ),
      dump.done,
      encrypt.done,
    ]);
    const info = await lstat(partial);
    if (!info.size) throw new Error("Encrypted backup is empty.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(partial)) digest.update(chunk);
    await rename(partial, file);
    await ledger(pgEnv, filename, true, info.size, digest.digest("hex"));
    // Prune only our completed encrypted files after a successful ledger write.
    for (const entry of await readdir(dir)) {
      if (
        !/^hd-crm-[A-Za-z0-9_-]+\.dump\.age$/.test(entry) ||
        entry === filename
      )
        continue;
      const path = join(dir, entry),
        stat = await lstat(path);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.mtimeMs < Date.now() - 30 * 86400000
      )
        await unlink(path);
    }
    return { filename, bytes: info.size };
  } catch {
    dump?.process.kill("SIGKILL");
    encrypt?.process.kill("SIGKILL");
    await unlink(partial).catch(() => {});
    await ledger(pgEnv, filename, false).catch(() => {});
    throw new Error(
      "Backup failed. Check database connectivity, pg_dump/age availability and update 026. No success is recorded unless encryption and the ledger both complete.",
    );
  } finally {
    clearTimeout(timer);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runBackup();
    console.log("Encrypted database backup recorded:", result.filename);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
