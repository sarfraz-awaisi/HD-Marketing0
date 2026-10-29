import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 048 in the normal forward-only order: a database at 047 with
// accounts in departments, attendance, leave and own shifts made by the
// earlier functions, then 048.
const admin = "48100000-0000-4000-8000-000000000001",
  agent = "48100000-0000-4000-8000-000000000002",
  editor = "48100000-0000-4000-8000-000000000003";
const MON = "2026-11-02",
  TUE = "2026-11-03",
  SAT = "2026-11-07";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const migration = async (file) =>
  (await readFile(new URL(file, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
let db, before, days;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const all = async (text, args = []) => (await db.query(text, args)).rows;
const pk = (day, time) => `${day}T${time}:00+05:00`;
// Every existing row, without the columns 048 adds.
const snapshot = async () => {
  const out = {};
  for (const table of [
    "profiles",
    "departments",
    "employee_shifts",
    "attendance_records",
    "attendance_periods",
    "attendance_leave_requests",
    "attendance_policies",
    "notifications",
  ])
    out[table] = await all(
      `select to_jsonb(t)-'reason'-'withdrawn_at'-'withdrawn_by' row from public.${table} t order by to_jsonb(t)::text`,
    );
  out.audit = (await one("select count(*)::int n from audit_log")).n;
  return out;
};
const week = () =>
  all(
    "select day::text d,state,scheduled,shift_start::text s,shift_end::text e from public.attendance_days($1,$2,$3,$4) order by day",
    [MON, SAT, editor, pk(SAT, "21:00")],
  );
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    if (file < "048") await db.exec(await migration(file));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'editor@gmail.com',now())",
    [admin, agent, editor],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Ali Editor' end,role=case id when $1 then 'admin' when $2 then 'agent' else 'staff' end,department_id=case when id=$3 then (select id from departments where name='Media') end where id in ($1,$2,$3)",
    [admin, agent, editor],
  );
  await db.exec(
    "update attendance_policies set effective_from='2026-10-01';update attendance_periods set starts_on='2026-10-01';",
  );
  // The editor's own 047 shift from Tuesday, back to the company from Saturday.
  await db.query(
    "insert into employee_shifts(user_id,effective_from,label,shift_start,shift_end,work_days,grace_minutes) values($1,$2,'Media shift','12:00','20:00','{1,2,3,4,5}',10)",
    [editor, TUE],
  );
  await db.query(
    "insert into employee_shifts(user_id,effective_from,follows_company) values($1,$2,true)",
    [editor, SAT],
  );
  await db.query("select public.attendance_check_in_at($1,$2,'t')", [
    editor,
    pk(MON, "10:20"),
  ]);
  await db.query("select public.attendance_check_out_at($1,$2,'t')", [
    editor,
    pk(MON, "18:10"),
  ]);
  await db.query("select public.attendance_check_in_at($1,$2,'t')", [
    editor,
    pk(TUE, "12:05"),
  ]);
  await db.query(
    "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason) values($1,'casual','2026-11-10','2026-11-10','Wedding')",
    [editor],
  );
  before = await snapshot();
  days = await week();
  await db.exec(await migration("048_flexible_employee_shifts.sql"));
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 048 after 047", () => {
  it("keeps every existing account, shift, attendance record and leave request", async () => {
    expect(before.employee_shifts).toHaveLength(2);
    expect(before.attendance_records).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
    expect(await all("select count(*)::int n from shift_schedules")).toEqual([
      { n: 0 },
    ]);
    // Everyone starts with the role and department they have now.
    expect(
      await all(
        "select h.effective_from::text f,h.role,d.name department from employee_group_history h left join departments d on d.id=h.department_id order by h.role",
      ),
    ).toEqual([
      { f: "-infinity", role: "admin", department: null },
      { f: "-infinity", role: "agent", department: null },
      { f: "-infinity", role: "staff", department: "Media" },
    ]);
  });
  it("resolves every day exactly as before", async () => {
    expect(await week()).toEqual(days);
    expect(
      (await one("select public.employee_shift_info($1,$2) r", [editor, TUE]))
        .r,
    ).toMatchObject({
      source: "individual",
      label: "Media shift",
      shift_start: "12:00",
      grace_minutes: 10,
      upcoming: { effective_from: SAT, source: "company" },
    });
    expect(
      (await one("select public.employee_shift_info($1,$2) r", [agent, TUE])).r,
    ).toMatchObject({
      source: "company",
      source_label: "Company default shift",
      shift_start: "10:00",
    });
  });
  it("changes nothing when applied again", async () => {
    const now = await snapshot();
    const history = await all(
      "select * from employee_group_history order by user_id",
    );
    await db.exec(await migration("048_flexible_employee_shifts.sql"));
    expect(await snapshot()).toEqual(now);
    expect(
      await all("select * from employee_group_history order by user_id"),
    ).toEqual(history);
  });
  it("records later role and department changes from the day they happen", async () => {
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    // An account made weeks ago (one set up today keeps its groups from the
    // start).
    await db.query(
      "update profiles set created_at=now()-interval '30 days' where id=$1",
      [editor],
    );
    await db.query(
      "update profiles set department_id=(select id from departments where name='Technical') where id=$1",
      [editor],
    );
    expect(
      await all(
        "select h.effective_from::text f,d.name department from employee_group_history h left join departments d on d.id=h.department_id where h.user_id=$1 order by h.effective_from",
        [editor],
      ),
    ).toEqual([
      { f: "-infinity", department: "Media" },
      { f: today, department: "Technical" },
    ]);
  });
});
