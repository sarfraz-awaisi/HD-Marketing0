import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 061 on a database at 060: no row or trigger changes; only its own
// helpers, the functions it replaces and the checked edits; applying it
// again changes nothing; it refuses to run before 060 or on a function it
// does not expect.
const admin = "61100000-0000-4000-8000-000000000001",
  ali = "61100000-0000-4000-8000-000000000002",
  sara = "61100000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "061_reassigned_lead_workspace.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
// New (the first seven), replaced and edited by 061; every other function
// must not change.
const changed = [
  "workspace_since",
  "workspace_item",
  "workspace_state",
  "lead_first_call_reopened",
  "lead_workspace",
  "agent_workspaces",
  "report_drill_row_workspace",
  "crm_mutate",
  "agent_lead_list",
  "agent_pipeline_attribution",
  "visit_calendar",
  "first_call_queue",
  "lead_response_job",
  "crm_metrics_038",
  "call_activity",
  "report_records",
  "report_today_records",
  "admin_lead_list",
  "report_drilldown",
  "dashboard_snapshot",
  "agent_pipeline_numbers",
  "admin_agent_pipeline",
  "record_first_call",
  "log_manual_call",
];
async function database(upTo) {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await db.exec(await migration(name));
  return db;
}
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-reassigned-workspace-061.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const snapshot = async (except = []) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [except],
    )
  ).s,
  // Who may run the functions 061 replaces or edits stays as it was.
  grants: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)",
      [changed.slice(7)],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
// The administrators' reports, as the Reports and Overview pages read them.
const reports = async () => {
  const from = new Date(Date.now() - 30 * 86400000).toISOString(),
    to = new Date(Date.now() + 86400000).toISOString();
  const read = async (sql, args) => (await one(sql, args)).v;
  return {
    metrics: await read("select crm_metrics($1,$2,$3) v", [admin, from, to]),
    leaderboard: await read("select crm_leaderboard($1,$2,$3) v", [
      admin,
      from,
      to,
    ]),
    sources: await read("select report_sources($1,$2,$3) v", [admin, from, to]),
    agents: await read("select report_agents($1,$2,$3) v", [admin, from, to]),
    funnel: await read("select report_funnel($1,$2,$3) v", [admin, from, to]),
    lost: await read("select report_lost($1,$2,$3) v", [admin, from, to]),
    today: await read("select call_activity($1) v", [admin]),
  };
};
beforeAll(async () => {
  db = await database("061");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  const lead = async (n, agent) =>
    (
      await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
        JSON.stringify({ name: `Buyer ${n}`, assigned_agent: agent }),
        "+9230012100" + n,
        admin,
      ])
    ).id;
  const kept = await lead(1, ali);
  const moved = await lead(2, ali);
  await lead(3, null);
  for (const id of [kept, moved])
    await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
      id,
      ali,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 60000).toISOString(),
        duration_seconds: 60,
        outcome: "Not interested",
        notes: "Ali's comment",
        deal_tags: ["Cold lead"],
      }),
    ]);
  await db.query(
    'select crm_mutate(\'leads\',$1,\'{"status":"lost","lost_reason":"not_interested"}\'::jsonb,$2,\'t\')',
    [moved, ali],
  );
  await db.query("select admin_assign_leads($1,$2,$3,'t')", [
    [moved],
    admin,
    sara,
  ]);
  await db.query(
    "update leads set call_due_at=now()-interval '1 hour' where id=$1",
    [moved],
  );
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 061 on a database at 060", () => {
  it("changes no record, trigger or other function", async () => {
    const counts = {
      leads_not_deleted: 3,
      lost_leads: 1,
      existing_calls: 2,
      existing_assignments: 3,
    };
    expect(await check()).toMatchObject({
      release_stage: "at 060, ready for 061",
      reassigned_leads: 1,
      reassigned_waiting_first_call: 1,
      reassigned_lost_waiting_first_call: 1,
      deadline_already_passed: 1,
      ...counts,
      server_functions: 0,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot(changed);
    const reported = await reports();
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    // Every report number stays, except the one intended change: Sara's
    // reassigned Lost lead, its deadline passed, is now a missed first call.
    const now = await reports();
    expect(now.metrics.missed_first_calls).toBe(
      reported.metrics.missed_first_calls + 1,
    );
    expect(now.today.agents.find((a) => a.agent_id === sara).missed).toBe(
      reported.today.agents.find((a) => a.agent_id === sara).missed + 1,
    );
    expect({
      ...now,
      metrics: {
        ...now.metrics,
        missed_first_calls: reported.metrics.missed_first_calls,
      },
      today: {
        ...now.today,
        agents: now.today.agents.map((a) =>
          a.agent_id === sara ? { ...a, missed: a.missed - 1 } : a,
        ),
      },
    }).toEqual(reported);
    expect(await check()).toMatchObject({
      release_stage: "at 061",
      reassigned_leads: 1,
      reassigned_lost_waiting_first_call: 1,
      ...counts,
      browser_function_access_must_be_0: 0,
      server_functions: 9,
    });
    // The Lost lead joins Sara's first calls and stays Lost.
    expect(
      await one(
        "select status,lead_first_call_reopened(id) reopened,lead_workspace(id)->>'status' shown,lead_workspace(id)->>'previous_result' previous from leads where name='Buyer 2'",
      ),
    ).toEqual({
      status: "lost",
      reopened: true,
      shown: "new",
      previous: "not_interested",
    });
    expect(
      await one(
        "select count(*)::int n from lead_review_queue where kind='missed'",
      ),
    ).toEqual({ n: 1 });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 060", async () => {
    const old = await database("060");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 060 before update 061.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("061");
    try {
      // A changed version of one function 061 edits.
      const body = (
        await other.query(
          "select pg_get_functiondef('public.call_activity(uuid)'::regprocedure) d",
        )
      ).rows[0].d;
      await other.exec(
        body.replace("l.status not in ('won','lost')", "l.status<>'won'"),
      );
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 061 found an unexpected version of public.call_activity(uuid)",
      );
      await other.exec("rollback");
      expect(
        (
          await other.query(
            "select to_regprocedure('public.agent_workspaces(uuid,uuid[])') f",
          )
        ).rows[0].f,
      ).toBeNull();
    } finally {
      await other.close();
    }
  }, 120000);
});
