import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobRunner, selectJobs } from "../src/jobs/maintenance.js";
// Update 080: a worker runs only the jobs named in JOBS_ENABLED, and only
// while it holds the single worker lease.
const known = ["leadResponseCheck", "followUpReminders", "processMetaLeads", "purgeDeletedLeads"];
const A = "80100000-0000-4000-8000-00000000000a",
  B = "80100000-0000-4000-8000-00000000000b";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace("create extension if not exists pgcrypto;", "");
let db;
const lease = async (holder, seconds = 120, jobs = ["processMetaLeads"]) =>
  (await db.query("select worker_lease($1,$2,$3) ok", [holder, seconds, jobs])).rows[0].ok;
const quiet = { log() {}, error() {} };

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const name of (await readdir(dir)).sort()) await db.exec(await migration(name));
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("choosing jobs", () => {
  it("runs nothing unless jobs are named", () => {
    expect(selectJobs(undefined, known)).toEqual([]);
    expect(selectJobs("", known)).toEqual([]);
    expect(selectJobs(" , ", known)).toEqual([]);
  });
  it("accepts known names once and refuses unknown ones", () => {
    expect(selectJobs("processMetaLeads, processMetaLeads", known)).toEqual(["processMetaLeads"]);
    expect(() => selectJobs("processMetaLeads,purgeEverything", known)).toThrow(/Unknown job in JOBS_ENABLED: purgeEverything/);
    expect(() => selectJobs("ProcessMetaLeads", known)).toThrow(/Unknown job/);
  });
  it("runs only the chosen jobs and stops when the lease is lost", async () => {
    const ran = [];
    const job = (name) => [name, async () => ran.push(name)];
    const jobs = [job("processMetaLeads"), job("purgeDeletedLeads")];
    const chosen = selectJobs("processMetaLeads", known);
    const db0 = { rpc: async () => ({ error: null }), from: () => ({ upsert: async () => ({}) }) };
    await createJobRunner(db0, jobs.filter(([n]) => chosen.includes(n)), quiet)();
    expect(ran).toEqual(["processMetaLeads"]);
    ran.length = 0;
    await createJobRunner(db0, jobs, quiet, { beforeJob: async (name) => name !== "purgeDeletedLeads" })();
    expect(ran).toEqual(["processMetaLeads"]);
  });
});

describe("the single worker lease", () => {
  it("lets one worker hold it, refuses a second, and recovers after a crash", async () => {
    expect(await lease(A)).toBe(true);
    expect(await lease(B)).toBe(false);
    expect(await lease(A)).toBe(true);
    // A crashes: its lease runs out and B takes over; A, if it comes back,
    // is refused and stops.
    await db.exec("update crm_private.worker_lease set expires_at=now()-interval '1 second'");
    expect(await lease(B)).toBe(true);
    expect(await lease(A)).toBe(false);
    await db.query("select worker_lease_release($1)", [B]);
    expect(await lease(A)).toBe(true);
    await db.query("select worker_lease_release($1)", [A]);
  });
  it("reruns safely and refuses unexpected definitions without changing anything", async () => {
    const sql = await migration("080_worker_control_meta_health.sql");
    expect(await lease(A)).toBe(true);
    await db.exec(sql);
    expect((await db.query("select holder from crm_private.worker_lease")).rows).toEqual([{ holder: A }]);
    await db.query("select worker_lease_release($1)", [A]);
    for (const odd of [
      "alter table crm_private.worker_lease add column note text",
      "create function public.worker_lease(p_holder text) returns boolean language sql as 'select true'",
    ]) {
      await db.exec(`begin;${odd};`);
      await expect(db.exec(sql)).rejects.toThrow(/unexpected worker lease or health definition/);
      await db.exec("rollback");
    }
    expect((await db.query("select count(*)::int n from pg_proc where proname='worker_lease'")).rows[0].n).toBe(1);
  });
  it("has a read-only check that shows the release stage", async () => {
    const check = await readFile(new URL("../check-worker-control-080.sql", dir), "utf8");
    const stage = async () => (await db.query(check)).rows[0];
    expect(await stage()).toMatchObject({ release_stage: "at 080", functions_present: 3, browser_can_use_it: false, worker_leases: 0 });
    await db.exec(
      "begin;drop function worker_lease(uuid,integer,text[]);drop function worker_lease_release(uuid);drop function meta_health(uuid);drop table crm_private.worker_lease;",
    );
    expect(await stage()).toMatchObject({ release_stage: "at 079, ready for 080", functions_present: 0 });
    await db.exec("rollback");
  });
  it("rejects bad requests and is closed to browser roles", async () => {
    await expect(lease(A, 5)).rejects.toThrow(/Invalid worker lease/);
    await expect(lease(null)).rejects.toThrow(/Invalid worker lease/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(lease(A)).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from crm_private.worker_lease")).rejects.toThrow(/permission denied/);
      await expect(db.query("select meta_health($1)", [A])).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });
});
