import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The read-only production check supabase/check-followups-activity.sql, run on
// synthetic historical records made the way the CRM made them before the fix:
// calls marked Follow-up required with no follow-up, follow-ups on leads that
// moved, were unassigned or deleted, duplicates, a legacy completion without
// a time, an administrator's note on an agent's lead, and a daily task about
// following up (tasks have no lead, so they are only counted).
const admin = "f0500000-0000-4000-8000-000000000001",
  ali = "f0500000-0000-4000-8000-000000000002",
  sara = "f0500000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
let pg, rows;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
let phone = 5000;
const lead = async (owner) =>
  (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name: "Historic " + phone, assigned_agent: owner }),
      "+92311" + String(phone++).padStart(7, "0"),
      admin,
    ])
  ).id;
const mutate = (table, data, actor) =>
  one("select public.crm_mutate($1,null,$2::jsonb,$3,'t') r", [
    table,
    JSON.stringify(data),
    actor,
  ]);
const due = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
// The sum of a metric's rows in one section (detail null: every detail).
const value = (section, metric, detail = "") =>
  rows
    .filter(
      (r) =>
        r.section === section &&
        r.metric === metric &&
        (detail === null || r.detail === detail),
    )
    .reduce((n, r) => n + Number(r.value), 0);
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.test',now()),($2,'ali@example.test',now()),($3,'sara@example.test',now())",
    [admin, ali, sara],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end",
    [admin, ali],
  );
  // A call marked Follow-up required, saved before the call form could
  // schedule the follow-up: no follow-up exists.
  const waiting = await lead(ali);
  await pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    waiting,
    ali,
    JSON.stringify({
      answered: true,
      started_at: new Date(Date.now() - 86400000).toISOString(),
      duration_seconds: 60,
      outcome: "Follow-up required",
      notes: "",
      deal_tags: ["Warm lead"],
    }),
  ]);
  // A follow-up whose lead later moved to Sara.
  const moved = await lead(ali);
  await mutate(
    "followups",
    { lead_id: moved, due_at: due(24), status: "pending" },
    ali,
  );
  await pg.query("select assign_lead($1,$2,$3,'t')", [moved, admin, sara]);
  // A follow-up on a lead that is now unassigned, and one on a deleted lead.
  const unassigned = await lead(ali);
  await mutate(
    "followups",
    { lead_id: unassigned, due_at: due(-5), status: "pending" },
    ali,
  );
  await pg.query("update leads set assigned_agent=null where id=$1", [
    unassigned,
  ]);
  const deleted = await lead(ali);
  await mutate(
    "followups",
    { lead_id: deleted, due_at: due(30), status: "pending" },
    ali,
  );
  await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
    [deleted],
    admin,
  ]);
  // Two identical pending follow-ups, and a completion from before
  // completion times were stamped.
  const twice = await lead(ali);
  const sameTime = due(10);
  for (let i = 0; i < 2; i++)
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,$3,'pending')",
      [twice, ali, sameTime],
    );
  const legacy = await lead(ali);
  const done = (
    await mutate(
      "followups",
      { lead_id: legacy, due_at: due(-48), status: "pending" },
      ali,
    )
  ).r;
  await pg.query("update followups set status='completed' where id=$1", [
    done.id,
  ]);
  await pg.query("update followups set completed_at=null where id=$1", [
    done.id,
  ]);
  // The administrator writes a note on Ali's lead.
  await mutate("notes", { lead_id: legacy, body: "Prefers WhatsApp" }, admin);
  // A daily task about following up: it has no lead.
  await pg.query("select public.task_create_at($1,$2::jsonb,'t',now())", [
    admin,
    JSON.stringify({
      client_key: randomUUID(),
      scope: "individual",
      assignees: [ali],
      title: "Follow up with this week's buyers",
      kind: "simple",
      category: "follow_ups",
      task_date: (
        await one("select public.attendance_local_date(now())::text d")
      ).d,
    }),
  ]);
  rows = (
    await pg.query(
      await readFile(
        new URL("../../supabase/check-followups-activity.sql", import.meta.url),
        "utf8",
      ),
    )
  ).rows;
}, 120000);
afterAll(async () => {
  await pg?.close();
});

describe("the production follow-up check on historical records", () => {
  const hidden = "followups hidden or inconsistent";
  it("counts follow-ups and where each agent sees them", () => {
    expect(value("followups", "total")).toBe(6);
    expect(value("followups", "by status", "pending")).toBe(4);
    expect(value("followups", "by status", "completed")).toBe(1);
    // Deleting a lead cancels its pending follow-ups.
    expect(value("followups", "by status", "cancelled")).toBe(1);
    const owners = "pending by current lead owner (what each agent sees)";
    expect(value("followups", owners, null)).toBe(4);
    expect(
      value("followups", owners, "(unassigned lead: administrators only)"),
    ).toBe(1);
  });
  it("finds hidden and inconsistent follow-ups", () => {
    expect(value(hidden, "on deleted leads (hidden from every list)")).toBe(1);
    expect(
      value(hidden, "on unassigned leads (only administrators see them)"),
    ).toBe(1);
    // Reassigning a lead moves its follow-ups to the new owner.
    expect(
      value(hidden, "lead moved to another agent (listed for the new owner)"),
    ).toBe(0);
    expect(
      rows.find(
        (r) =>
          r.metric === "by stored responsible agent" &&
          r.detail.startsWith("Sara Agent"),
      )?.value,
    ).toBe(1);
    expect(value(hidden, "completed without a completion time")).toBe(1);
    expect(
      value(hidden, "duplicate pending (same lead and time), extra rows"),
    ).toBe(1);
    expect(value(hidden, "due more than a day before it was created")).toBe(1);
  });
  it("lists leads whose follow-up was promised on a call but never saved, by lead number only", () => {
    expect(
      value(
        "calls",
        "leads waiting for a follow-up date (latest call: Follow-up required)",
      ),
    ).toBe(1);
    const row = rows.find(
      (r) => r.metric === "lead waiting for a follow-up date",
    );
    expect(row.detail).toMatch(/^HD-\d+ · Ali Agent \(UID \d+\) · call /);
    expect(JSON.stringify(rows)).not.toMatch(/Historic|\+92311|@example/);
    expect(value("calls", "with lead tag", "Warm lead")).toBe(1);
  });
  it("keeps daily tasks separate and shows activity history", () => {
    expect(value("daily tasks", "follow-up category or wording", null)).toBe(1);
    expect(
      value(
        "activity",
        "notes written by someone other than the lead's agent (now shown with the writer)",
      ),
    ).toBe(1);
    // The two follow-ups inserted directly, as old data might have been.
    expect(
      value("activity", "follow-ups without an audit entry (creator unknown)"),
    ).toBe(2);
  });
});
