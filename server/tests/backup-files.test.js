import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  stat,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runFileBackup } from "../../deploy/backup-files.mjs";
let root, env;
const objects = {
  "property-photos": {
    "p1/front.jpg": "front-photo",
    "p1/gallery/back.jpg": "back-photo",
  },
  "knowledge-files": { "kyc/lead-7/cnic.pdf": "private-kyc" },
  recordings: {},
};
// Mimics the Storage REST responses: folders have no id; files do.
function fakeStorage(store = objects) {
  return {
    listBuckets: async () => Object.keys(store),
    list: async (bucket, prefix, offset) => {
      if (offset) return [];
      const names = new Map();
      for (const path of Object.keys(store[bucket])) {
        if (prefix && !path.startsWith(prefix + "/")) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const [first, ...more] = rest.split("/");
        names.set(first, more.length ? null : "file-" + path);
      }
      return [...names].map(([name, id]) => ({ name, id }));
    },
    download: async (bucket, path) => Buffer.from(store[bucket][path]),
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hd-file-backup-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  // Stand-in for age: marks the output and passes the tar stream through.
  await writeFile(
    join(bin, "age"),
    "#!" +
      process.execPath +
      "\nprocess.stdout.write('FIXTURE-CIPHERTEXT:');process.stdin.pipe(process.stdout);",
    { mode: 0o700 },
  );
  env = {
    PATH: bin + ":/usr/bin:/bin",
    BACKUP_AGE_RECIPIENT: "age1fixture",
    BACKUP_DIR: join(root, "backups"),
  };
}, 15000);
afterEach(() => rm(root, { recursive: true, force: true }));
it("copies every bucket and nested folder into one private encrypted archive", async () => {
  const result = await runFileBackup(env, fakeStorage());
  expect(result.files).toBe(3);
  const entries = await readdir(env.BACKUP_DIR);
  // Only the finished archive remains; plain staging copies are deleted.
  expect(entries).toEqual([result.filename]);
  expect(result.filename).toMatch(/^hd-crm-files-[A-Za-z0-9_-]+\.tar\.age$/);
  const path = join(env.BACKUP_DIR, result.filename);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const archive = await readFile(path, "latin1");
  expect(archive.startsWith("FIXTURE-CIPHERTEXT:")).toBe(true);
  for (const name of [
    "property-photos/p1/front.jpg",
    "property-photos/p1/gallery/back.jpg",
    "knowledge-files/kyc/lead-7/cnic.pdf",
    "back-photo",
    "private-kyc",
  ])
    expect(archive).toContain(name);
}, 15000);
it("refuses unsafe object paths and leaves no partial or plain copies", async () => {
  const unsafe = { "property-photos": { "../../escape.txt": "x" } };
  await expect(runFileBackup(env, fakeStorage(unsafe))).rejects.toThrow(
    "File backup failed",
  );
  expect(await readdir(env.BACKUP_DIR)).toEqual([]);
  await expect(stat(join(root, "escape.txt"))).rejects.toThrow();
}, 15000);
it("keeps earlier backups when Storage cannot be read", async () => {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  await writeFile(join(env.BACKUP_DIR, "hd-crm-files-earlier.tar.age"), "old");
  const broken = fakeStorage();
  broken.listBuckets = async () => {
    throw new Error("down");
  };
  await expect(runFileBackup(env, broken)).rejects.toThrow(
    "File backup failed",
  );
  expect(await readdir(env.BACKUP_DIR)).toEqual([
    "hd-crm-files-earlier.tar.age",
  ]);
}, 15000);
it("prunes only its own archives older than 30 days", async () => {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  const old = new Date(Date.now() - 31 * 86400000);
  for (const name of [
    "hd-crm-files-old.tar.age",
    "hd-crm-20260101-old.dump.age",
    "notes.txt",
  ]) {
    await writeFile(join(env.BACKUP_DIR, name), "x");
    await utimes(join(env.BACKUP_DIR, name), old, old);
  }
  await writeFile(join(env.BACKUP_DIR, "hd-crm-files-recent.tar.age"), "x");
  const result = await runFileBackup(env, fakeStorage());
  expect((await readdir(env.BACKUP_DIR)).sort()).toEqual(
    [
      "hd-crm-20260101-old.dump.age",
      "hd-crm-files-recent.tar.age",
      "notes.txt",
      result.filename,
    ].sort(),
  );
}, 15000);
it("requires the public encryption recipient before touching Storage", async () => {
  let listed = false;
  const storage = fakeStorage();
  storage.listBuckets = async () => {
    listed = true;
    return [];
  };
  await expect(
    runFileBackup({ ...env, BACKUP_AGE_RECIPIENT: "" }, storage),
  ).rejects.toThrow("BACKUP_AGE_RECIPIENT");
  expect(listed).toBe(false);
});
it("talks to the Supabase Storage REST API with the server key and encoded paths", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers.apikey });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/storage/v1/bucket")
        return res.end(JSON.stringify([{ name: "property-photos" }]));
      if (req.url === "/storage/v1/object/list/property-photos") {
        const { prefix } = JSON.parse(body);
        return res.end(
          JSON.stringify(
            prefix
              ? [{ name: "front photo.jpg", id: "f1" }]
              : [{ name: "listing 1", id: null }],
          ),
        );
      }
      if (
        req.url ===
        "/storage/v1/object/property-photos/listing%201/front%20photo.jpg"
      )
        return res.end("photo-bytes");
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { storageClient } = await import("../../deploy/backup-files.mjs");
    const result = await runFileBackup(
      env,
      storageClient({
        SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
        SUPABASE_SERVICE_ROLE_KEY: "service-fixture",
      }),
    );
    expect(result.files).toBe(1);
    expect(seen.every((r) => r.key === "service-fixture")).toBe(true);
    expect(
      await readFile(join(env.BACKUP_DIR, result.filename), "latin1"),
    ).toContain("photo-bytes");
  } finally {
    server.close();
  }
}, 15000);
