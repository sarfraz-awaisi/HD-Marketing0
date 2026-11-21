import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 078 on a database at 077. Production differs from the repository in
// two functions (schema-only restores of 17 and 21 Nov): log_manual_call
// lacks update 061's actor line and account_action_034 lacks update 020's
// email confirmation actions. Here the repository build is first turned into
// that production state, then 078 repairs it without changing any row.
const admin = "78100000-0000-4000-8000-000000000001",
  ali = "78100000-0000-4000-8000-000000000002";
const session = "a".repeat(64),
  unlock = "b".repeat(64);
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace("create extension if not exists pgcrypto;", "");
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const actorLine = "  perform set_config('hd.actor_id',p_actor::text,true);\n";
const emailActions = ",'email_confirmation_requested','email_confirmation_sent','email_confirmation_failed'";
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(await readFile(new URL("../../supabase/check-function-drift-078.sql", import.meta.url), "utf8"));
const apply = async () => db.exec(await migration("078_function_drift.sql"));
const functions = async () =>
  (
    await one(
      "select md5(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure))||md5(pg_get_functiondef('account_action_034(uuid,text,text,uuid,text,text)'::regprocedure)) f",
    )
  ).f;
const rows = async () =>
  (
    await one(
      "select (select md5(string_agg(l::text,'|' order by id)) from leads l)||(select md5(string_agg(c::text,'|' order by id)) from calls c)||(select md5(string_agg(a::text,'|' order by id)) from assignments a)||(select count(*) from audit_log) s",
    )
  ).s;
// Turns the repository functions into the production ones (the drift).
const drift = () =>
  db.exec(
    `do $$ begin
      execute replace(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure),${lit(actorLine)},'');
      execute replace(pg_get_functiondef('account_action_034(uuid,text,text,uuid,text,text)'::regprocedure),${lit(emailActions)},'');
    end $$;`,
  );
const lit = (s) => `'${s.replaceAll("'", "''")}'`;
const lead = async (n) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name: `Buyer ${n}`, assigned_agent: ali }),
      "+9230078000" + String(n).padStart(2, "0"),
      admin,
    ])
  ).id;
const call = (leadId, actor, minutesAgo) =>
  db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    leadId,
    actor,
    JSON.stringify({
      answered: true,
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: 60,
      outcome: "Follow-up required",
      notes: "",
      deal_tags: [],
    }),
  ]);
const firstCall = async (leadId) => (await one("select first_call_at from leads where id=$1", [leadId])).first_call_at;
const emailAction = (action = "email_confirmation_requested") =>
  db.query("select account_action_034($1,$2,$3,$4,$5,'t')", [admin, session, unlock, ali, action]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort()) if (name < "078") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  // An unlocked Accounts session for the administrator (accounts_gate).
  const version = (
    await one("insert into account_security(admin_id,pin_hash) values($1,$2) returning version", [admin, "x".repeat(60)])
  ).version;
  await db.query(
    "insert into account_unlocks(token_hash,admin_id,session_hash,pin_version,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",
    [unlock, admin, session, version],
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("update 078 on a database at 077", () => {
  it("changes nothing where the functions already match the repository", async () => {
    expect(await check()).toMatchObject({ release_stage: "at 078", records_call_actor: true, accepts_email_confirmation: true, functions_secure: true });
    const before = await functions();
    await apply();
    expect(await functions()).toBe(before);
  });

  it("reproduces production: an administrator's call is credited as the agent's first call", async () => {
    await drift();
    expect(await check()).toMatchObject({
      release_stage: "at 077, ready for 078",
      records_call_actor: false,
      accepts_email_confirmation: false,
      admin_logged_first_calls: 0,
    });
    const credited = await lead(1);
    // Started before the assignment, so the stamp is the assignment time.
    await call(credited, admin, 30);
    expect(await firstCall(credited)).not.toBeNull();
    expect((await check()).admin_logged_first_calls).toBe(1);
    await expect(emailAction()).rejects.toThrow(/Invalid account action/);
  });

  it("repairs both functions without changing any row, and keeps them secure", async () => {
    const before = await rows();
    await apply();
    expect(await rows()).toBe(before);
    expect(await check()).toMatchObject({
      release_stage: "at 078",
      records_call_actor: true,
      accepts_email_confirmation: true,
      functions_secure: true,
      admin_logged_first_calls: 1,
    });
  });

  it("no longer credits an administrator's call; the agent's own call still counts", async () => {
    const fresh = await lead(2);
    await call(fresh, admin, 30);
    expect(await firstCall(fresh)).toBeNull();
    await call(fresh, ali, 0);
    expect(await firstCall(fresh)).not.toBeNull();
    // Only the earlier, historical one is reported; it is not changed.
    expect((await check()).admin_logged_first_calls).toBe(1);
  });

  it("restores Send verification email and still refuses other actions and non-administrators", async () => {
    await expect(emailAction()).resolves.toBeDefined();
    await expect(emailAction("email_confirmation_sent")).resolves.toBeDefined();
    await expect(emailAction("delete_everything")).rejects.toThrow(/Invalid account action/);
    await expect(
      db.query("select account_action_034($1,$2,$3,$4,'email_confirmation_requested','t')", [ali, session, unlock, admin]),
    ).rejects.toThrow();
  });

  it("changes nothing when applied again", async () => {
    const before = (await functions()) + (await rows());
    await apply();
    expect((await functions()) + (await rows())).toBe(before);
  });

  it("refuses to run before 077, and stops without changes on an unexpected function", async () => {
    await db.exec("alter function public.call_outcome_stage(text) rename to call_outcome_stage_hidden");
    await drift();
    await expect(apply()).rejects.toThrow(/up to 077 before update 078/);
    // The failed update leaves its transaction open; nothing was changed.
    await db.exec("rollback");
    await db.exec("alter function public.call_outcome_stage_hidden(text) rename to call_outcome_stage");
    // A version of log_manual_call that is neither production's nor the repository's.
    await db.exec(
      `do $$ begin execute replace(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure),'Choose distinct supported tags','Choose distinct tags'); end $$;`,
    );
    const before = await functions();
    await expect(apply()).rejects.toThrow(/unexpected version of public\.log_manual_call/);
    await db.exec("rollback");
    expect(await functions()).toBe(before);
    expect((await check()).accepts_email_confirmation).toBe(false);
  });
});
