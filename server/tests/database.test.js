import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
let db;
const admin = "10000000-0000-4000-8000-000000000001",
  agent = "10000000-0000-4000-8000-000000000002",
  other = "10000000-0000-4000-8000-000000000003";
let lead, property, call;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort()) {
    let sql = await readFile(new URL(f, dir), "utf8");
    sql = sql.replace("create extension if not exists pgcrypto;", "");
    await db.exec(sql);
  }
  await db.query(`insert into auth.users(id) values($1),($2),($3)`, [
    admin,
    agent,
    other,
  ]);
  await db.query(
    `update public.profiles set active=true,role='admin' where id=$1`,
    [admin],
  );
  await db.query("update profiles set active=true where id=any($1::uuid[])", [
    [agent, other],
  ]);
  property = (
    await one(
      `insert into public.properties(title,location,price,type,area,area_unit) values('Test house','Lahore',100,'House',5,'marla') returning id`,
    )
  ).id;
}, 30000);
afterAll(async () => {
  await db?.close();
});
describe("executable migrations and database security", () => {
  it("ignores user metadata role escalation", async () => {
    const id = "10000000-0000-4000-8000-000000000004";
    await db.query(
      `insert into auth.users(id,raw_user_meta_data) values($1,'{"role":"admin"}')`,
      [id],
    );
    expect(
      (await one("select role from profiles where id=$1", [id])).role,
    ).toBe("agent");
    await db.query("update profiles set active=false where id=$1", [id]);
  });
  it("creates a private normalized lead transactionally and rejects duplicates", async () => {
    const data = { name: "Test lead", assigned_agent: agent };
    lead = (
      await one("select (create_lead($1::jsonb,$2,$3,$4)).id", [
        JSON.stringify(data),
        "+923001234567",
        admin,
        "test",
      ])
    ).id;
    await expect(
      db.query("select create_lead($1::jsonb,$2,$3,$4)", [
        JSON.stringify(data),
        "+923001234567",
        admin,
        "test",
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await one("select count(*)::int n from leads")).n).toBe(1);
  });
  it("blocks browser phone reads and service-only RPC execution", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(
        db.query("select * from crm_private.lead_phones"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.query("select private_phone($1)", [lead]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select * from profiles")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await db.exec("reset role");
    }
  });
  it("enforces lead ownership and protects roles inside RPC", async () => {
    await expect(
      db.query("select crm_mutate($1,$2,$3::jsonb,$4,$5)", [
        "leads",
        lead,
        '{"status":"won"}',
        other,
        "test",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.query("select crm_mutate($1,$2,$3::jsonb,$4,$5)", [
        "profiles",
        agent,
        '{"role":"admin"}',
        agent,
        "test",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query("select crm_mutate($1,$2,$3::jsonb,$4,$5)", [
      "leads",
      lead,
      '{"status":"contacted"}',
      agent,
      "test",
    ]);
  });
  it("round robin remains balanced across concurrent requests", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        (
          await one("select (create_lead($1::jsonb,$2,$3,$4)).id", [
            JSON.stringify({ name: "RR " + i }),
            "+92300123457" + i,
            admin,
            "test",
          ])
        ).id,
      );
    const results = await Promise.all(
      ids.map((id) =>
        db.query("select assign_lead($1,$2,null,$3) as assigned", [
          id,
          admin,
          "concurrent",
        ]),
      ),
    );
    const picks = results.map((r) => r.rows[0].assigned);
    expect(picks.filter((x) => x === agent)).toHaveLength(2);
    expect(picks.filter((x) => x === other)).toHaveLength(2);
  });
  it("deduplicates webhook delivery and preserves outcome on late events", async () => {
    call = (
      await one("select crm_mutate($1,null,$2::jsonb,$3,$4) as value", [
        "calls",
        JSON.stringify({
          lead_id: lead,
          provider_call_id: "mock-test",
          status: "initiated",
        }),
        agent,
        "test",
      ])
    ).value.id;
    await db.query("select crm_mutate($1,$2,$3::jsonb,$4,$5)", [
      "calls",
      call,
      JSON.stringify({
        outcome: "Interested",
        outcome_submitted_at: new Date().toISOString(),
      }),
      agent,
      "test",
    ]);
    const event = {
      event_id: "evt-1",
      provider_call_id: "mock-test",
      status: "completed",
      ended_at: new Date().toISOString(),
      duration_seconds: 42,
    };
    await db.query("select apply_call_event($1::jsonb)", [
      JSON.stringify(event),
    ]);
    expect(
      (
        await one("select apply_call_event($1::jsonb) as result", [
          JSON.stringify(event),
        ])
      ).result.duplicate,
    ).toBe(true);
    await db.query("select apply_call_event($1::jsonb)", [
      JSON.stringify({ ...event, event_id: "evt-2", status: "ringing" }),
    ]);
    const row = await one("select * from calls where id=$1", [call]);
    expect(row.outcome).toBe("Interested");
    expect(row.status).toBe("completed");
  });
  it("counts deals once and sums closed value using same report metrics", async () => {
    const deal = {
      lead_id: lead,
      property_id: property,
      stage: "won",
      close_date: "2026-10-08",
      expected_value: 2500000,
    };
    await db.query("select crm_mutate($1,null,$2::jsonb,$3,$4)", [
      "deals",
      JSON.stringify(deal),
      agent,
      "test",
    ]);
    await expect(
      db.query("select crm_mutate($1,null,$2::jsonb,$3,$4)", [
        "deals",
        JSON.stringify(deal),
        agent,
        "test",
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    const metrics = (
      await one("select crm_metrics($1,$2,$3,null,null) as result", [
        agent,
        "2026-10-01",
        "2026-11-01",
      ])
    ).result;
    expect(metrics.won_deals).toBe(1);
    expect(metrics.revenue).toBe(2500000);
  });
  it("rerunning reminders does not create duplicates", async () => {
    await db.query("select crm_mutate($1,null,$2::jsonb,$3,$4)", [
      "followups",
      JSON.stringify({
        lead_id: lead,
        due_at: new Date(Date.now() + 3600000).toISOString(),
        status: "pending",
      }),
      agent,
      "test",
    ]);
    await db.exec(
      "select run_crm_job('followups','{}');select run_crm_job('followups','{}');",
    );
    expect((await one("select count(*)::int n from reminders")).n).toBe(1);
  });
  it("expired recordings cannot be played and failed deletion stays retryable", async () => {
    await db.query(
      `insert into crm_private.recordings(call_id,storage_path,created_at) values($1,'old.mp3',now()-interval '8 days')`,
      [call],
    );
    expect(
      (await one("select recording_access($1) as result", [call])).result,
    ).toBeNull();
    await db.query("select recording_deleted($1,$2)", [call, "retry required"]);
    expect(
      (await one("select recording_batch() as result")).result,
    ).toHaveLength(1);
    await db.query("select recording_deleted($1,null)", [call]);
    expect(
      (await one("select recording_batch() as result")).result,
    ).toHaveLength(0);
    expect(
      (await one("select count(*)::int n from calls where id=$1", [call])).n,
    ).toBe(1);
  });
  it("the stale job never moves leads; idle leads wait for an administrator's decision", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          await one("select (create_lead($1::jsonb,$2,$3,$4)).id", [
            JSON.stringify({ name: "Stale " + i, assigned_agent: agent }),
            "+92300111111" + i,
            admin,
            "test",
          ])
        ).id,
      );
    }
    await db.query(
      "update leads set last_activity_at=now()-interval '10 days',first_call_at=now()-interval '10 days' where id=any($1::uuid[])",
      [ids],
    );
    await db.query("update leads set status='won' where id=$1", [ids[0]]);
    await db.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '2 days')",
      [ids[1], agent],
    );
    const result = (
      await one("select run_crm_job('stale','{\"stale_days\":7}') as result")
    ).result;
    expect(result).toEqual({ affected: 0, disabled: true });
    for (const id of ids)
      expect(
        (await one("select assigned_agent from leads where id=$1", [id]))
          .assigned_agent,
      ).toBe(agent);
    // Only the open lead without a planned follow-up joins the review list.
    const queue = (
      await db.query(
        "select id,kind from lead_review_queue where id=any($1::uuid[])",
        [ids],
      )
    ).rows;
    expect(queue).toEqual([{ id: ids[2], kind: "idle" }]);
  });
  it("flags only completed calls without a submitted outcome after grace", async () => {
    const id = (
      await one(
        "insert into calls(lead_id,agent_id,status,ended_at) values($1,$2,'completed',now()-interval '1 hour') returning id",
        [lead, agent],
      )
    ).id;
    const first = (
      await one(
        "select run_crm_job('outcomes','{\"grace_minutes\":30}') as result",
      )
    ).result;
    expect(first.affected).toBe(1);
    expect(
      (await one("select missing_outcome from calls where id=$1", [id]))
        .missing_outcome,
    ).toBe(true);
    expect(
      (await one("select run_crm_job('outcomes','{}') as result")).result
        .affected,
    ).toBe(0);
    expect(
      (await one("select missing_outcome from calls where id=$1", [call]))
        .missing_outcome,
    ).toBe(false);
  });
  it("audit history cannot be rewritten", async () => {
    await expect(
      db.query("update audit_log set action='changed'"),
    ).rejects.toThrow("append-only");
  });
});
