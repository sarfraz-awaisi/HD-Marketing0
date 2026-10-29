import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 047 in the normal forward-only order: a database at 046 with
// accounts, attendance, leave, tasks and reports made by the earlier
// functions, then 047.
const admin = "47100000-0000-4000-8000-000000000001",
  agent = "47100000-0000-4000-8000-000000000002";
const MON = "2026-11-02";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (file) =>
  (await readFile(new URL(file, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
let db, before;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const all = async (text, args = []) => (await db.query(text, args)).rows;
const pk = (day, time) => `${day}T${time}:00+05:00`;
// Every existing row, without the columns 047 adds.
const snapshot = async () => {
  const out = {};
  for (const table of [
    "profiles",
    "attendance_records",
    "attendance_periods",
    "attendance_leave_requests",
    "tasks",
    "task_assignments",
    "task_daily_reports",
    "notifications",
    "login_events",
    "account_provisioning",
  ])
    out[table] = await all(
      `select to_jsonb(t)-'department_id'-'job_title'-'joined_on'-'audience'-'requested_department_id'-'requested_job_title' row from public.${table} t order by to_jsonb(t)::text`,
    );
  out.audit = (await one("select count(*)::int n from audit_log")).n;
  return out;
};
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    if (file < "047") await db.exec(await migration(file));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, agent],
  );
  await db.query(
    "update profiles set active=true,name=case when id=$1 then 'Owner' else 'Ali Agent' end,role=case when id=$1 then 'admin' else 'agent' end where id in ($1,$2)",
    [admin, agent],
  );
  await db.exec(
    "update attendance_policies set effective_from='2026-10-01';update attendance_periods set starts_on='2026-10-01';",
  );
  await db.query("select public.attendance_check_in_at($1,$2,'t')", [
    agent,
    pk(MON, "10:20"),
  ]);
  await db.query("select public.attendance_check_out_at($1,$2,'t')", [
    agent,
    pk(MON, "18:10"),
  ]);
  const task = (
    await one("select public.task_create_at($1,$2::jsonb,'t',$3) r", [
      admin,
      JSON.stringify({
        client_key: randomUUID(),
        scope: "team",
        title: "Contact buyers",
        kind: "measurable",
        target_quantity: 10,
        unit: "calls",
        all_agents: true,
        task_date: MON,
      }),
      pk(MON, "09:00"),
    ])
  ).r;
  await db.query(
    "select public.task_progress_at($1,$2,'{\"quantity\":4}'::jsonb,'t',$3)",
    [agent, task.assignments[0].id, pk(MON, "12:00")],
  );
  await db.query(
    "select public.task_report_submit_at($1,$2,'Four calls',false,'t',$3)",
    [agent, MON, pk(MON, "17:00")],
  );
  await db.query(
    "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason) values($1,'casual','2026-11-10','2026-11-10','Wedding')",
    [agent],
  );
  before = await snapshot();
  await db.exec(await migration("047_staff_management.sql"));
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 047 after 046", () => {
  it("keeps every existing account, attendance, leave, task and report", async () => {
    expect(before.profiles).toHaveLength(2);
    expect(before.attendance_records).toHaveLength(1);
    expect(before.task_assignments).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    expect(
      await all(
        "select role,department_id,job_title,joined_on from profiles order by role",
      ),
    ).toEqual([
      { role: "admin", department_id: null, job_title: null, joined_on: null },
      { role: "agent", department_id: null, job_title: null, joined_on: null },
    ]);
    expect(
      (await all("select name from departments order by sort_order")).map(
        (d) => d.name,
      ),
    ).toEqual(["Sales", "Media", "Technical", "Operations / Other"]);
  });
  it("changes nothing when applied again", async () => {
    const now = await snapshot();
    const departments = await all("select * from departments order by name");
    await db.exec(await migration("047_staff_management.sql"));
    expect(await snapshot()).toEqual(now);
    expect(await all("select * from departments order by name")).toEqual(
      departments,
    );
  });
  it("leaves agents working exactly as before", async () => {
    const day = (
      await one(
        "select row_to_json(d) r from public.attendance_days($1,$1,$2,$3) d",
        [MON, agent, pk(MON, "20:00")],
      )
    ).r;
    expect(day).toMatchObject({
      state: "checked_out",
      punctuality: "late",
      late_minutes: 20,
      shift_start: "10:00:00",
    });
    const mine = (
      await one("select public.task_my_at($1,$2) r", [agent, pk(MON, "18:30")])
    ).r;
    expect(mine.report).toMatchObject({ completion_percent: 40 });
    expect(
      (
        await one("select public.task_checkout_state_at($1,$2) r", [
          agent,
          pk(MON, "18:30"),
        ])
      ).r,
    ).toMatchObject({ required: false });
    // The 045 performance call without a department still answers.
    const perf = (
      await one("select public.task_performance($1,$2,$2,null) r", [admin, MON])
    ).r;
    expect(perf.totals).toMatchObject({ assignments: 1, average_percent: 40 });
    // As does the 040 leave list.
    const leave = (
      await one(
        "select public.attendance_leave_page($1,false,'pending',null,1,20) r",
        [admin],
      )
    ).r;
    expect(leave.count).toBe(1);
  });
});
