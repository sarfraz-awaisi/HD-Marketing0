import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 089: Attendance Management never shows deleted accounts. A
// disabled account stays, apart from the active ones, with its attendance
// history; no attendance record is deleted or changed.
const admin = "89000000-0000-4000-8000-000000000001",
  ali = "89000000-0000-4000-8000-000000000002",
  bilal = "89000000-0000-4000-8000-000000000003",
  chand = "89000000-0000-4000-8000-000000000004";
const migration = new URL(
  "../../supabase/migrations/089_attendance_active_disabled.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-attendance-active-disabled-089.sql",
  import.meta.url,
);
const pkToday = () =>
  new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const addDays = (d, n) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const isoDow = (d) => ((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
// The two most recent earlier working days (Monday–Saturday).
const workdays = [];
for (let d = addDays(pkToday(), -1); workdays.length < 2; d = addDays(d, -1))
  if (isoDow(d) !== 7) workdays.unshift(d);
const [day1, day2] = workdays;
const monday = (d) => addDays(d, 1 - isoDow(d));

// Ali stays active; Bilal worked both days and left (disabled); Chand
// worked both days, asked for leave and a correction, and was deleted.
async function people(t) {
  await resetPeople(t.pg, [admin, ali, bilal]);
  await t.pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'chand@gmail.com',now())",
    [chand],
  );
  await t.pg.query(
    "update profiles set active=true,role='agent',name=case id when $1 then 'Ali Agent' when $2 then 'Bilal Agent' else 'Chand Agent' end where id=any($3::uuid[])",
    [ali, bilal, [ali, bilal, chand]],
  );
  await t.pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-26');update attendance_periods set starts_on='2026-10-26';",
  );
  const app = createApp(trustedMfaFixture(t.db));
  for (const user of [ali, bilal, chand])
    await request(app)
      .post("/api/admin/attendance/manage")
      .set({ Authorization: "Bearer " + admin })
      .send({
        user_id: user,
        entries: [day1, day2].map((date) => ({
          date,
          status: "present",
          check_in: "10:00",
          check_out: "18:00",
        })),
        reason: "Paper register",
      })
      .expect(200);
  await t.pg.query(
    "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason) values($1,'casual',$2,$2,'Family visit')",
    [chand, addDays(pkToday(), 7)],
  );
  await t.pg.query(
    "insert into attendance_corrections(user_id,attendance_date,correction_type,reason,requested_check_out_at) values($1,$2,'incorrect_check_out','Left at seven',$3)",
    [chand, day2, `${day2}T19:00:00+05:00`],
  );
  await t.pg.query("update profiles set active=false where id=$1", [bilal]);
  await t.pg.query(
    "update profiles set active=false,deletion_requested_at=now(),deleted_at=now() where id=$1",
    [chand],
  );
}

describe("Attendance Management: active, disabled and deleted accounts (update 089)", () => {
  let t;
  beforeAll(async () => {
    t = await startCrmDatabase();
    await people(t);
  }, 120000);
  afterAll(async () => {
    await t?.pg.close();
  });
  const get = async (path, status = 200) =>
    (
      await request(createApp(trustedMfaFixture(t.db)))
        .get("/api/admin/attendance" + path)
        .set({ Authorization: "Bearer " + admin })
        .expect(status)
    ).body;
  const names = (rows) => rows.map((r) => r.name).sort();

  it("lists active and disabled employees, never deleted ones", async () => {
    const list = await get("/employees");
    expect(
      Object.fromEntries(
        list.filter((p) => p.id !== admin).map((p) => [p.name, p.active]),
      ),
    ).toEqual({ "Ali Agent": true, "Bilal Agent": false });
  });

  it("keeps a disabled employee's attendance history; a deleted one's is not shown", async () => {
    const bilals = await get(`/employees/${bilal}?from=${day1}&to=${day2}`);
    expect(bilals.employee).toMatchObject({
      name: "Bilal Agent",
      active: false,
    });
    expect(bilals.totals).toMatchObject({
      present_days: 2,
      worked_minutes: 960,
    });
    expect(bilals.employee.periods.at(-1).ends_on).toBe(pkToday());
    expect(
      (await get(`/employees/${chand}?from=${day1}&to=${day2}`, 404)).error,
    ).toBe("Employee not found");
    // Nothing was deleted: Chand's records are all still there.
    expect(
      await t.one(
        "select (select count(*) from attendance_records where user_id=$1)::int r,(select count(*) from attendance_leave_requests where user_id=$1)::int l,(select count(*) from attendance_corrections where user_id=$1)::int c",
        [chand],
      ),
    ).toEqual({ r: 2, l: 1, c: 1 });
  });

  it("Daily, Weekly, Monthly and the register export leave deleted accounts out; Inactive is disabled only", async () => {
    const daily = await get(`/daily?date=${day2}`);
    expect(names(daily.data)).toEqual(
      expect.arrayContaining(["Ali Agent", "Bilal Agent"]),
    );
    expect(names(daily.data)).not.toContain("Chand Agent");
    expect(daily.summary.total).toBe(daily.count);
    expect(
      names((await get(`/daily?date=${day2}&account=inactive`)).data),
    ).toEqual(["Bilal Agent"]);
    const week = await get(`/weekly?week_start=${monday(day2)}`);
    expect(week.employees.map((e) => e.name)).not.toContain("Chand Agent");
    expect(
      (
        await get(`/weekly?week_start=${monday(day2)}&account=inactive`)
      ).employees.map((e) => e.name),
    ).toEqual(["Bilal Agent"]);
    const month = await get(`/monthly?month=${day2.slice(0, 7)}`);
    expect(month.employees.map((e) => e.name)).not.toContain("Chand Agent");
    const csv = await request(createApp(trustedMfaFixture(t.db)))
      .get(`/api/admin/attendance/export?type=daily&date=${day2}&format=csv`)
      .set({ Authorization: "Bearer " + admin })
      .expect(200);
    expect(csv.text).toContain("Bilal Agent");
    expect(csv.text).not.toContain("Chand");
  });

  it("Overview counts and the leave and correction lists leave deleted accounts out", async () => {
    const overview = await get("/overview");
    expect(overview).toMatchObject({
      pending_leave: 0,
      pending_corrections: 0,
    });
    expect((await get("/leave")).count).toBe(0);
    expect((await get("/corrections")).count).toBe(0);
    expect((await get(`/leave?user=${chand}`)).count).toBe(0);
  });
});

describe("update 089 on a database at 088, as production is", () => {
  let t;
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "089" });
    await people(t);
  }, 120000);
  afterAll(async () => {
    await t?.pg.close();
  });
  const get = async (path) =>
    (
      await request(createApp(trustedMfaFixture(t.db)))
        .get("/api/admin/attendance" + path)
        .set({ Authorization: "Bearer " + admin })
        .expect(200)
    ).body;
  const list = async () => (await get("/employees")).map((p) => p.name);
  // What a deleted account still shows before 089 and no longer after.
  const shown = async () => ({
    listed: (await list()).includes("Chand Agent"),
    daily: (await get(`/daily?date=${day2}`)).data.some(
      (r) => r.name === "Chand Agent",
    ),
    leave: (await get("/leave")).count,
    corrections: (await get("/corrections")).count,
    pending: (({ pending_leave, pending_corrections }) => [
      pending_leave,
      pending_corrections,
    ])(await get("/overview")),
  });
  const fns = async () =>
    (
      await t.one(
        "select md5(string_agg(md5(pg_get_functiondef(p.oid))||coalesce(p.proacl::text,''),',' order by p.oid::regprocedure::text)) f from pg_proc p where p.proname like 'attendance%'",
      )
    ).f;
  const check = async () => t.one(await readFile(checkFile, "utf8"));

  it("applies once, reruns as a no-op and refuses before 088", async () => {
    expect(await shown()).toEqual({
      listed: true,
      daily: true,
      leave: 1,
      corrections: 1,
      pending: [1, 1],
    });
    expect(await check()).toMatchObject({
      release_stage: "at 088, ready for 089",
      edits_fit: true,
      active_employees: 2,
      disabled_employees: 1,
      deleted_hidden: 1,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    const rows = await t.one(
      "select (select count(*) from attendance_records)::int r,(select count(*) from attendance_periods)::int p",
    );
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 089",
      edits_fit: null,
    });
    expect(await shown()).toEqual({
      listed: false,
      daily: false,
      leave: 0,
      corrections: 0,
      pending: [0, 0],
    });
    expect(
      await t.one(
        "select (select count(*) from attendance_records)::int r,(select count(*) from attendance_periods)::int p",
      ),
    ).toEqual(rows);
    const after = await fns();
    await t.pg.exec(sql);
    expect(await fns()).toBe(after);
    const at087 = await startCrmDatabase({ before: "088" });
    try {
      await expect(at087.pg.exec(sql)).rejects.toThrow(
        "Apply CRM updates up to 088 before update 089.",
      );
    } finally {
      await at087.pg.close();
    }
  }, 180000);
});
