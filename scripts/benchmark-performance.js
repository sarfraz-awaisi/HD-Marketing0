// Isolated synthetic PostgreSQL benchmark. Never reads .env or contacts Supabase.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
const pg = new PGlite({ extensions: { pg_trgm } });
const admin = "b2800000-0000-4000-8000-000000000000";
const agent = "b2800000-0000-4000-8000-000000000001";
const queries = {
  assigned_lead_page: {
    sql: "select id,name from leads where assigned_agent=$1 order by created_at desc limit 20",
    args: [agent],
  },
  substring_search: {
    sql: "select id from leads where name ilike '%49999%'",
    args: [],
  },
  leaderboard: {
    sql: "select crm_leaderboard($1,'2026-10-01','2026-11-01') value",
    args: [admin],
  },
};
async function measure() {
  const results = {};
  for (const [name, { sql, args }] of Object.entries(queries)) {
    await pg.query(sql, args);
    const times = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      await pg.query(sql, args);
      times.push(performance.now() - start);
    }
    const plan = (
      await pg.query("explain (analyze, buffers, format json) " + sql, args)
    ).rows[0]["QUERY PLAN"][0];
    results[name] = {
      median_ms: Number(times.sort((a, b) => a - b)[4].toFixed(3)),
      plan,
    };
  }
  return results;
}
try {
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.filter((f) => f < "027"))
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.exec(
    "insert into auth.users(id) select ('b2800000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid from generate_series(0,40) i;update profiles set active=true,name=id::text;",
  );
  await pg.query("update profiles set role='admin' where id=$1", [admin]);
  await pg.exec(
    "insert into leads(id,name,masked_phone,assigned_agent,created_at) select ('b2900000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Benchmark customer '||i,'***123',('b2800000-0000-4000-8000-'||lpad((1+i%40)::text,12,'0'))::uuid,'2026-10-01'::timestamptz+i*interval '1 second' from generate_series(1,50000) i;",
  );
  await pg.exec(
    "insert into calls(lead_id,agent_id,status,ended_at) select ('b2900000-0000-4000-8000-'||lpad((1+i%50000)::text,12,'0'))::uuid,('b2800000-0000-4000-8000-'||lpad((1+i%40)::text,12,'0'))::uuid,'completed','2026-10-01'::timestamptz+i*interval '1 second' from generate_series(1,100000) i;analyze;",
  );
  const before = await measure();
  const oldLeaders = (
    await pg.query(queries.leaderboard.sql, queries.leaderboard.args)
  ).rows[0].value;
  await pg.exec(
    await readFile(new URL("027_loading_performance.sql", dir), "utf8"),
  );
  await pg.exec("analyze;");
  const after = await measure();
  const newLeaders = (
    await pg.query(queries.leaderboard.sql, queries.leaderboard.args)
  ).rows[0].value;
  const ordered = (rows) =>
    rows.toSorted((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(ordered(oldLeaders), ordered(newLeaders));
  const comparison = Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      {
        before_ms: before[key].median_ms,
        after_ms: after[key].median_ms,
        speedup: Number(
          (before[key].median_ms / after[key].median_ms).toFixed(2),
        ),
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        fixture: {
          leads: 50000,
          calls: 100000,
          agents: 40,
          engine: "PGlite PostgreSQL",
          samples: 9,
          warmup: 1,
          hosted_requests: 0,
        },
        comparison,
        leaderboard_results_identical: true,
        before,
        after,
      },
      null,
      2,
    ),
  );
} finally {
  await pg.close();
}
