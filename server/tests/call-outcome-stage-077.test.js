import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 077 on a database at 076: existing leads move once to the furthest
// stage their answered calls show (history dated by the call), won and lost
// leads stay, a rerun changes nothing, and new calls move the stage forward.
const admin = "77100000-0000-4000-8000-000000000001",
  ali = "77100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
let db;
const leads = {};
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(
    await readFile(
      new URL("../../supabase/check-call-outcome-stage-077.sql", import.meta.url),
      "utf8",
    ),
  );
const status = async (lead) =>
  (await one("select status from leads where id=$1", [lead])).status;
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const call = (lead, outcome, at = minutesAgo(1)) =>
  db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    ali,
    JSON.stringify({
      answered: !["No answer", "Number off"].includes(outcome),
      started_at: at,
      duration_seconds: ["No answer", "Number off"].includes(outcome) ? 0 : 60,
      outcome,
      notes: "",
      deal_tags: [],
    }),
  ]);
const lead = async (name) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name, assigned_agent: ali }),
      "+92300177" + String(Object.keys(leads).length).padStart(4, "0"),
      admin,
    ])
  ).id;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "077") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  for (const name of ["interested", "later", "deal", "won", "lost", "plain", "busy"])
    leads[name] = await lead(name);
  // Before 077 these calls only move the lead to Contacted.
  await call(leads.interested, "Interested", minutesAgo(300));
  await call(leads.interested, "Not interested", minutesAgo(200));
  await call(leads.later, "Interested", minutesAgo(250));
  await call(leads.later, "Site visit scheduled", minutesAgo(240));
  await call(leads.later, "Site visit scheduled", minutesAgo(230));
  await call(leads.deal, "Deal discussion", minutesAgo(220));
  await call(leads.won, "Interested", minutesAgo(210));
  await call(leads.lost, "Interested", minutesAgo(205));
  await call(leads.plain, "Follow-up required", minutesAgo(190));
  await call(leads.busy, "No answer", minutesAgo(180));
  await db.query("select set_config('hd.actor_id',$1,false)", [admin]);
  await db.query("update leads set status='won' where id=$1", [leads.won]);
  await db.query(
    "update leads set status='lost',lost_reason='not_interested' where id=$1",
    [leads.lost],
  );
  await db.query("select set_config('hd.actor_id','',false)");
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("update 077 on a database at 076", () => {
  it("reports what it will move before it is applied", async () => {
    expect(await status(leads.interested)).toBe("contacted");
    expect(await check()).toMatchObject({
      release_stage: "at 076, ready for 077",
      leads_to_move: "interested 1 | visit_scheduled 1 | negotiation 1",
      history_rows_077: 0,
    });
  });

  it("moves existing leads once to the furthest stage their calls show", async () => {
    const calls = await one("select count(*)::int n, md5(string_agg(c::text,'|' order by id)) h from calls c");
    await db.exec(await migration("077_call_outcome_stage.sql"));
    expect(await status(leads.interested)).toBe("interested");
    expect(await status(leads.later)).toBe("visit_scheduled");
    expect(await status(leads.deal)).toBe("negotiation");
    expect(await status(leads.won)).toBe("won");
    expect(await status(leads.lost)).toBe("lost");
    expect(await status(leads.plain)).toBe("contacted");
    expect(await status(leads.busy)).toBe("new");
    expect(await one("select count(*)::int n, md5(string_agg(c::text,'|' order by id)) h from calls c")).toEqual(calls);
    // One history row per moved lead, dated by the first call showing it,
    // by that call's agent; one matching audit entry each.
    const history = (
      await db.query(
        "select lead_id,from_status,to_status,actor_id,created_at from lead_status_history where request_id='update-077' order by to_status",
      )
    ).rows;
    expect(history.map((h) => [h.from_status, h.to_status])).toEqual([
      ["contacted", "interested"],
      ["contacted", "negotiation"],
      ["contacted", "visit_scheduled"],
    ]);
    expect(history.every((h) => h.actor_id === ali)).toBe(true);
    const first = await one(
      "select c.started_at from calls c where c.lead_id=$1 and c.outcome='Site visit scheduled' order by c.started_at limit 1",
      [leads.later],
    );
    expect(history.find((h) => h.lead_id === leads.later).created_at).toEqual(first.started_at);
    expect(
      (await one("select count(*)::int n from audit_log where request_id='update-077' and action='status_change'")).n,
    ).toBe(3);
    expect(await check()).toMatchObject({
      release_stage: "at 077",
      leads_to_move: "none",
      history_rows_077: 3,
    });
  });

  it("changes nothing when applied again", async () => {
    const before = await one(
      "select md5(string_agg(l.id||l.status,'|' order by l.id)) l,(select count(*)::int from lead_status_history) h,md5(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure)) f from leads l",
    );
    await db.exec(await migration("077_call_outcome_stage.sql"));
    expect(
      await one(
        "select md5(string_agg(l.id||l.status,'|' order by l.id)) l,(select count(*)::int from lead_status_history) h,md5(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure)) f from leads l",
      ),
    ).toEqual(before);
  });

  it("moves leads forward on new calls, never backwards or out of won/lost", async () => {
    const fresh = await lead("fresh");
    await call(fresh, "Interested");
    expect(await status(fresh)).toBe("interested");
    await call(fresh, "Not interested");
    expect(await status(fresh)).toBe("interested");
    await call(fresh, "Deal discussion");
    expect(await status(fresh)).toBe("negotiation");
    await call(fresh, "Site visit scheduled");
    expect(await status(fresh)).toBe("negotiation");
    await call(leads.lost, "Deal discussion");
    expect(await status(leads.lost)).toBe("lost");
    await call(leads.won, "Interested");
    expect(await status(leads.won)).toBe("won");
    const moves = (
      await db.query(
        "select from_status,to_status,actor_id from lead_status_history where lead_id=$1 order by created_at",
        [fresh],
      )
    ).rows;
    expect(moves.map((m) => m.to_status)).toEqual(["contacted", "interested", "negotiation"]);
    expect(moves.every((m) => m.actor_id === ali)).toBe(true);
  });

  it("refuses to run on a drifted log_manual_call and keeps the helper private", async () => {
    expect(
      (await one("select has_function_privilege('service_role','call_outcome_stage(text)','execute') ok")).ok,
    ).toBe(false);
    const other = new PGlite({ extensions: { pg_trgm } });
    await other.exec(setup);
    for (const name of (await readdir(dir)).sort())
      if (name < "077") await other.exec(await migration(name));
    await other.exec(
      "do $$ begin execute replace(pg_get_functiondef('log_manual_call(uuid,uuid,jsonb,text)'::regprocedure),'if did_answer then','if did_answer and true then'); end $$;",
    );
    await expect(other.exec(await migration("077_call_outcome_stage.sql"))).rejects.toThrow(
      /unexpected version of public.log_manual_call/,
    );
    await other.close();
  }, 180000);
});
