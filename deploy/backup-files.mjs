// Encrypted copy of every uploaded file (property photos, documentation and
// KYC files, call recordings). Database dumps never include Storage objects.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function exit(child, name) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(name + " could not start.")));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(name + " failed.")),
    );
  });
}
// Dependency-free Storage REST client (Node's fetch), so the scheduled job
// can run from a private folder outside macOS-protected locations.
export function storageClient(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const base = new URL("storage/v1/", env.SUPABASE_URL.replace(/\/?$/, "/"));
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const call = async (path, options = {}) => {
    const response = await fetch(new URL(path, base), {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error("Storage request failed.");
    return response;
  };
  const segments = (path) => path.split("/").map(encodeURIComponent).join("/");
  return {
    listBuckets: async () =>
      (await (await call("bucket")).json()).map((b) => b.name),
    list: async (bucket, prefix, offset) =>
      (
        await call("object/list/" + encodeURIComponent(bucket), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix,
            limit: 1000,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        })
      ).json(),
    download: async (bucket, path) =>
      Buffer.from(
        await (
          await call(
            "object/" + encodeURIComponent(bucket) + "/" + segments(path),
          )
        ).arrayBuffer(),
      ),
  };
}
// Downloads one bucket into staging, following folders page by page.
async function copyBucket(storage, bucket, staging) {
  let count = 0;
  const folders = [""];
  while (folders.length) {
    const prefix = folders.shift();
    for (let offset = 0; ; offset += 1000) {
      const listed = await storage.list(bucket, prefix, offset);
      if (!Array.isArray(listed)) throw new Error("Storage listing failed.");
      for (const item of listed) {
        const path = prefix ? prefix + "/" + item.name : item.name;
        // Storage reports folders without an object id.
        if (item.id == null) {
          folders.push(path);
          continue;
        }
        const target = resolve(staging, bucket, path);
        if (!target.startsWith(resolve(staging, bucket) + sep))
          throw new Error("Unsafe storage object path.");
        const data = await storage.download(bucket, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, data, { mode: 0o600 });
        count++;
      }
      if (listed.length < 1000) break;
    }
  }
  return count;
}
export async function runFileBackup(env = process.env, client) {
  if (!/^age1[a-z0-9]+$/.test(env.BACKUP_AGE_RECIPIENT || ""))
    throw new Error(
      "Configure the public BACKUP_AGE_RECIPIENT; keep the private key elsewhere.",
    );
  const storage = client || storageClient(env);
  const dir = resolve(env.BACKUP_DIR || "/var/backups/hd-crm");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename =
    "hd-crm-files-" +
    new Date().toISOString().replace(/[^0-9TZ]/g, "") +
    "-" +
    randomUUID() +
    ".tar.age";
  const file = join(dir, filename),
    partial = file + ".partial";
  // Plain copies exist only in this private folder and are always removed.
  const staging = await mkdtemp(join(dir, ".files-"));
  try {
    const buckets = await storage.listBuckets();
    if (!Array.isArray(buckets))
      throw new Error("Storage buckets could not be listed.");
    let files = 0;
    for (const bucket of buckets)
      files += await copyBucket(storage, bucket, staging);
    const tar = spawn("tar", ["-C", staging, "-cf", "-", "."], {
      env: { PATH: env.PATH },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const age = spawn(
      "age",
      ["--encrypt", "--recipient", env.BACKUP_AGE_RECIPIENT],
      { env: { PATH: env.PATH }, stdio: ["pipe", "pipe", "ignore"] },
    );
    age.stdin.on("error", () => {});
    await Promise.all([
      pipeline(tar.stdout, age.stdin),
      pipeline(
        age.stdout,
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      ),
      exit(tar, "tar"),
      exit(age, "age"),
    ]);
    const info = await lstat(partial);
    if (!info.size) throw new Error("Encrypted file backup is empty.");
    await rename(partial, file);
    for (const entry of await readdir(dir)) {
      if (
        !/^hd-crm-files-[A-Za-z0-9_-]+\.tar\.age$/.test(entry) ||
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
    return { filename, files, bytes: info.size };
  } catch {
    await unlink(partial).catch(() => {});
    throw new Error(
      "File backup failed. Check the Supabase connection, tar/age availability and free disk space. Earlier backups were kept.",
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runFileBackup();
    console.log(
      `Encrypted file backup saved: ${result.filename} (${result.files} files)`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
