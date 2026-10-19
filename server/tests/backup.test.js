import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  stat,
  utimes,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { databaseEnvironment, runBackup } from "../../deploy/backup.mjs";
let root, env;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hd-backup-fixture-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  env = {
    PATH: bin + ":" + process.env.PATH,
    SUPABASE_DB_URL:
      "postgresql://fixture-user:private%24password@fixture.test:5432/postgres?sslmode=require",
    BACKUP_AGE_RECIPIENT: "age1fixture",
    BACKUP_DIR: join(root, "backups"),
  };
  const write = async (name, script) =>
    writeFile(join(bin, name), "#!" + process.execPath + "\n" + script, {
      mode: 0o700,
    });
  await write(
    "pg_dump",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, "calls"))},JSON.stringify({name:'pg_dump',args:process.argv.slice(2),host:process.env.PGHOST})+'\\n');process.stdout.write('fixture-database-stream');`,
  );
  await write(
    "age",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, "calls"))},JSON.stringify({name:'age',args:process.argv.slice(2),hasPassword:!!process.env.PGPASSWORD})+'\\n');process.stdout.write('FIXTURE-CIPHERTEXT:');process.stdin.pipe(process.stdout);`,
  );
  await write(
    "psql",
    `const fs=require('node:fs');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(join(root, "ledger"))},data));`,
  );
}, 15000);
afterEach(() => rm(root, { recursive: true, force: true }));
it("keeps credentials out of argv and rejects transaction/non-TLS connections", () => {
  const pg = databaseEnvironment(env);
  expect(pg.PGPASSWORD).toBe("private$password");
  expect(pg.PGHOST).toBe("fixture.test");
  for (const url of [
    "http://bad",
    "postgresql://a:b@host:6543/postgres?sslmode=require",
    "postgresql://a:b@host/db?sslmode=disable",
  ])
    expect(() =>
      databaseEnvironment({ ...env, SUPABASE_DB_URL: url }),
    ).toThrow();
}, 15000);
it("streams into ciphertext, atomically finalizes a private file and only then records success", async () => {
  const result = await runBackup(env);
  const files = await readdir(env.BACKUP_DIR);
  expect(files).toEqual([result.filename]);
  expect((await stat(join(env.BACKUP_DIR, result.filename))).mode & 0o777).toBe(
    0o600,
  );
  expect(
    await readFile(join(env.BACKUP_DIR, result.filename), "utf8"),
  ).toContain("FIXTURE-CIPHERTEXT");
  const calls = await readFile(join(root, "calls"), "utf8");
  expect(calls).not.toContain("private$password");
  expect(calls).toContain('"hasPassword":false');
  const ledger = await readFile(join(root, "ledger"), "utf8");
  expect(ledger).toContain(",true,");
  expect(ledger).not.toContain("private");
}, 15000);
it("removes partial output and never records success after dump/encryption failure", async () => {
  await writeFile(
    join(root, "bin", "pg_dump"),
    "#!" +
      process.execPath +
      "\nconsole.error('private-db-url');process.exit(1);",
    { mode: 0o700 },
  );
  await expect(runBackup(env)).rejects.toThrow("Backup failed");
  expect(await readdir(env.BACKUP_DIR)).toEqual([]);
  const ledger = await readFile(join(root, "ledger"), "utf8");
  expect(ledger).toContain(",false,");
  expect(ledger).not.toContain(",true,");
}, 15000);
it("keeps valid ciphertext and older backups if the ledger fails", async () => {
  await mkdir(env.BACKUP_DIR);
  const old = join(env.BACKUP_DIR, "hd-crm-old.dump.age");
  await writeFile(old, "old");
  await utimes(old, new Date(0), new Date(0));
  await writeFile(
    join(root, "bin", "psql"),
    "#!" + process.execPath + "\nprocess.exit(1);",
    { mode: 0o700 },
  );
  await expect(runBackup(env)).rejects.toThrow("Backup failed");
  expect((await readdir(env.BACKUP_DIR)).length).toBe(2);
  expect(await readFile(old, "utf8")).toBe("old");
}, 15000);
it("prunes only expired completed backup files after success, preserving symlinks/unrelated/recent files", async () => {
  await mkdir(env.BACKUP_DIR);
  for (const name of [
    "hd-crm-old.dump.age",
    "other.dump.age",
    "hd-crm-recent.dump.age",
  ])
    await writeFile(join(env.BACKUP_DIR, name), "fixture");
  for (const name of ["hd-crm-old.dump.age", "other.dump.age"])
    await utimes(join(env.BACKUP_DIR, name), new Date(0), new Date(0));
  await symlink(
    join(root, "outside"),
    join(env.BACKUP_DIR, "hd-crm-link.dump.age"),
  );
  await runBackup(env);
  const files = await readdir(env.BACKUP_DIR);
  expect(files).not.toContain("hd-crm-old.dump.age");
  expect(files).toEqual(
    expect.arrayContaining([
      "other.dump.age",
      "hd-crm-recent.dump.age",
      "hd-crm-link.dump.age",
    ]),
  );
}, 15000);
