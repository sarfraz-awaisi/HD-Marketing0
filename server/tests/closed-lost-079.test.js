import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outcomes } from "../src/utils/validators.js";
// Update 079: the call outcome "Closed lost", saved, filtered and exported
// like the others, without moving the stage or touching follow-ups.
const admin = "79100000-0000-4000-8000-000000000001",
  ali = "79100000-0000-4000-8000-000000000002",
  sara = "79100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace("create extension if not exists pgcrypto;", "");
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const apply = async () => db.exec(await migration("079_closed_lost_outcome.sql"));
const lead = async (n) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name: `Buyer ${n}`, assigned_agent: ali }),
      "+9230079000" + String(n).padStart(2, "0"),
      admin,
    ])
  ).id;
const call = (leadId, actor, outcome, answered = true) =>
  db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    leadId,
    actor,
    JSON.stringify({ answered, started_at: new Date().toISOString(), duration_seconds: answered ? 60 : 0, outcome, notes: "", deal_tags: [] }),
  ]);
const status = async (id) => (await one("select status from leads where id=$1", [id])).status;
const listed = async (fn, actor, query) => JSON.stringify((await one(`select ${fn}($1,$2::jsonb) r`, [actor, JSON.stringify(query)])).r);

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort()) if (name < "079") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("update 079 Closed lost", () => {
  it("refuses an unexpected outcome constraint and changes nothing", async () => {
    await db.exec("alter table calls drop constraint calls_outcome_check; alter table calls add constraint calls_outcome_check check(outcome is not null)");
    await expect(apply()).rejects.toThrow(/unexpected calls_outcome_check/);
    await db.exec("rollback");
    await db.exec(
      "alter table calls drop constraint calls_outcome_check; alter table calls add constraint calls_outcome_check check(outcome = any(array['No answer','Busy','Wrong number','Number off','Interested','Not interested','Follow-up required','Site visit scheduled','Deal discussion']))",
    );
    const before = await lead(1);
    await expect(call(before, ali, "Closed lost")).rejects.toThrow();
  });

  it("applies once and again without change", async () => {
    await apply();
    const fns = "select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) h from pg_proc p where p.proname in ('admin_lead_list','agent_lead_list','admin_agent_pipeline','lead_export_match','lead_file_export_match')";
    const h = (await one(fns)).h;
    await apply();
    expect((await one(fns)).h).toBe(h);
    expect(outcomes).toContain("Closed lost");
    for (const f of ["lead_export_match", "lead_file_export_match"])
      expect((await one(`select pg_get_functiondef('${f}(jsonb)'::regprocedure) like '%''Closed lost''%' ok`)).ok).toBe(true);
  });

  it("saves Closed lost for agents and administrators without moving the stage or touching follow-ups", async () => {
    const byAgent = await lead(2);
    const byAdmin = await lead(3);
    await db.query("insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()+interval '1 day','pending')", [byAgent, ali]);
    const followups = (await one("select count(*)::int n, string_agg(status,',') s from followups")).n;
    await call(byAgent, ali, "Closed lost");
    await call(byAdmin, admin, "Closed lost");
    expect((await one("select count(*)::int n from calls where outcome='Closed lost'")).n).toBe(2);
    expect(await status(byAgent)).toBe("contacted");
    expect(await status(byAdmin)).toBe("contacted");
    expect((await one("select count(*)::int n from followups where status='pending'")).n).toBe(followups);
    // An unanswered call cannot have it; unknown outcomes stay refused.
    await expect(call(byAgent, ali, "Closed lost", false)).rejects.toThrow();
    await expect(call(byAgent, ali, "Closed Lost")).rejects.toThrow();
  });

  it("keeps a won lead won", async () => {
    const won = await lead(4);
    await db.query("select set_config('hd.actor_id',$1,false)", [admin]);
    await db.query("update leads set status='won' where id=$1", [won]);
    await call(won, ali, "Closed lost");
    expect(await status(won)).toBe("won");
  });

  it("filters by the latest call's outcome in All leads, the agent's lists and the agent pipeline", async () => {
    const later = await lead(5);
    await call(later, ali, "Closed lost");
    await call(later, ali, "Interested");
    const closed = (await one("select string_agg(lead_id::text,',') ids from calls where outcome='Closed lost'")).ids.split(",");
    const all = await listed("admin_lead_list", admin, { outcome: "Closed lost" });
    const mine = await listed("agent_lead_list", ali, { outcome: "Closed lost" });
    for (const id of closed.filter((id) => id !== later)) {
      expect(all).toContain(id);
      expect(mine).toContain(id);
    }
    // Latest call decides: a later Interested call takes the lead out.
    expect(all).not.toContain(later);
    expect(mine).not.toContain(later);
    const pipeline = JSON.stringify(
      (await one("select admin_agent_pipeline($1,$2,$3::jsonb) r", [admin, ali, JSON.stringify({ outcome: "Closed lost" })])).r,
    );
    expect(pipeline).not.toContain(later);
  });

  it("combines with agent, status, search and pages, and leaves deleted leads out", async () => {
    const closed = (await one("select string_agg(distinct lead_id::text,',') ids from calls where outcome='Closed lost'")).ids.split(",");
    const won = (await one("select id from leads where status='won'")).id;
    expect(await listed("admin_lead_list", admin, { outcome: "Closed lost", agent: ali, status: "won", page: 1 })).toContain(won);
    expect(await listed("admin_lead_list", admin, { outcome: "Closed lost", status: "new" })).not.toContain(won);
    expect(await listed("admin_lead_list", admin, { outcome: "Closed lost", search: "Buyer 4" })).toContain(won);
    const gone = closed.find((id) => id !== won);
    await db.query(
      "update leads set deleted_at=now(),deleted_by=$2,delete_reason='test deletion',deleted_batch=gen_random_uuid() where id=$1",
      [gone, admin],
    );
    expect(await listed("admin_lead_list", admin, { outcome: "Closed lost" })).not.toContain(gone);
    expect(await listed("agent_lead_list", ali, { outcome: "Closed lost" })).not.toContain(gone);
    await db.query("update leads set deleted_at=null,deleted_by=null,delete_reason=null,deleted_batch=null where id=$1", [gone]);
  });

  it("filters file exports by it and still refuses other spellings", async () => {
    const exported = (await db.query("select lead_id from lead_file_export_match($1::jsonb)", [JSON.stringify({ no_file: true, outcome: "Closed lost", agent: ali })])).rows.map((r) => r.lead_id);
    expect(exported.length).toBeGreaterThan(0);
    await expect(db.query("select * from lead_file_export_match($1::jsonb)", [JSON.stringify({ no_file: true, outcome: "Closed Lost" })])).rejects.toThrow(/valid export filters/);
    await expect(listed("admin_lead_list", admin, { outcome: "Lost call" })).rejects.toThrow();
  });

  it("keeps other agents' leads and the database closed to restricted roles", async () => {
    const theirs = (await one("select lead_id from calls where outcome='Closed lost' limit 1")).lead_id;
    // Another agent sees none of Ali's leads and cannot log a call on them.
    expect(await listed("agent_lead_list", sara, { outcome: "Closed lost" })).not.toContain(theirs);
    await expect(call(theirs, sara, "Closed lost")).rejects.toThrow(/Forbidden|not found/i);
    // Browser roles reach neither the calls table nor the functions.
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select count(*) from public.calls")).rejects.toThrow(/permission denied/);
      await expect(call(theirs, admin, "Closed lost")).rejects.toThrow(/permission denied/);
      await expect(db.query("select admin_lead_list($1,'{}'::jsonb)", [admin])).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
    const secure = await one(
      "select bool_and(p.prosecdef and p.proconfig=array['search_path=\"\"'] and pg_get_userbyid(p.proowner)=current_user and not has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')) ok from pg_proc p where p.oid in ('admin_lead_list(uuid,jsonb)'::regprocedure,'agent_lead_list(uuid,jsonb)'::regprocedure,'admin_agent_pipeline(uuid,uuid,jsonb)'::regprocedure,'lead_export_match(jsonb)'::regprocedure,'lead_file_export_match(jsonb)'::regprocedure)",
    );
    expect(secure.ok).toBe(true);
    expect((await one("select count(*)::int n from deals")).n).toBe(0);
  });
});
