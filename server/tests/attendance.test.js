import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { read } from "xlsx";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 040: attendance. Dated checks use the *_at functions with explicit
// Pakistan times (Monday 19 October 2026 is a working day); API checks use
// the database clock.
const admin = "ab000000-0000-4000-8000-000000000001",
  agent = "ab000000-0000-4000-8000-000000000002",
  other = "ab000000-0000-4000-8000-000000000003",
  second = "ab000000-0000-4000-8000-000000000004";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  // Tracking (and every account) started on Thursday 1 October 2026.
  await pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-01');update attendance_periods set starts_on='2026-10-01';",
  );
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const pk = (day, time) => `${day}T${time}:00+05:00`;
const sql = async (text, args = []) => {
  try {
    return await one(text, args);
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: e.code });
  }
};
const checkIn = (user, day, time) =>
  sql("select public.attendance_check_in_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]).then((x) => x.r);
const checkOut = (user, day, time) =>
  sql("select public.attendance_check_out_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]).then((x) => x.r);
const days = (user, from, to, now) =>
  all(
    "select day::text,state,punctuality from public.attendance_days($1,$2,$3,$4) order by day",
    [from, to, user, now],
  );
const totals = (user, from, to, now) =>
  one("select * from public.attendance_totals($1,$2,$3,$4)", [
    from,
    to,
    user,
    now,
  ]);
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
async function addAdmin() {
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'second@gmail.com',now())",
    [second],
  );
  await pg.query(
    "update profiles set active=true,role='admin',name='Second Admin' where id=$1",
    [second],
  );
  await pg.query(
    "update attendance_periods set starts_on='2026-10-01' where user_id=$1",
    [second],
  );
}

describe("punctuality", () => {
  it.each([
    ["09:59", "on_time", 0, 0],
    ["10:00", "on_time", 0, 0],
    ["10:14", "within_grace", 14, 0],
    ["10:15", "within_grace", 15, 0],
    ["10:16", "late", 16, 1],
    ["11:00", "late", 60, 45],
  ])("check-in at %s is %s", async (time, punctuality, late, beyond) => {
    expect(
      await one(
        "select punctuality,late_minutes,beyond_grace_minutes from public.attendance_compute('2026-10-19','10:00','18:00',15,$1,null)",
        [pk("2026-10-19", time)],
      ),
    ).toEqual({
      punctuality,
      late_minutes: late,
      beyond_grace_minutes: beyond,
    });
  });
});

describe("check-in", () => {
  it("records agents and admins with the trusted time and audits it", async () => {
    const a = await checkIn(agent, "2026-10-19", "10:20");
    expect(a).toMatchObject({
      user_id: agent,
      attendance_date: "2026-10-19",
      state: "checked_in",
      punctuality: "late",
      late_minutes: 20,
      beyond_grace_minutes: 5,
      shift_start: "10:00:00",
      grace_minutes: 15,
    });
    expect((await checkIn(admin, "2026-10-19", "09:50")).punctuality).toBe(
      "on_time",
    );
    expect(
      await all(
        "select action,metadata->>'punctuality' p from audit_log where action='attendance.check_in' order by p",
      ),
    ).toEqual([
      { action: "attendance.check_in", p: "late" },
      { action: "attendance.check_in", p: "on_time" },
    ]);
  });
  it("refuses duplicates, including two at the same moment", async () => {
    const results = await Promise.allSettled([
      checkIn(agent, "2026-10-19", "10:01"),
      checkIn(agent, "2026-10-19", "10:02"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({
      code: "HA409",
      message: "You have already checked in today",
    });
    expect(
      (await one("select count(*)::int n from attendance_records")).n,
    ).toBe(1);
  });
  it("refuses inactive accounts, days off, holidays, approved leave and dates before tracking", async () => {
    await pg.query("update profiles set active=false where id=$1", [other]);
    await expect(checkIn(other, "2026-10-19", "10:00")).rejects.toMatchObject({
      code: "HA403",
    });
    await expect(checkIn(agent, "2026-10-18", "10:00")).rejects.toMatchObject({
      code: "HA409",
      message: "Today is a scheduled day off. No check-in is needed.",
    });
    await pg.query(
      "insert into attendance_holidays(holiday_date,name) values('2026-10-20','Founders day')",
    );
    await expect(checkIn(agent, "2026-10-20", "10:00")).rejects.toMatchObject({
      message:
        "Today is a company holiday (Founders day). No check-in is needed.",
    });
    await pg.query(
      "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason,status,reviewer_id,reviewed_at) values($1,'sick','2026-10-21','2026-10-21','Fever','approved',$2,now())",
      [agent, admin],
    );
    await expect(checkIn(agent, "2026-10-21", "10:00")).rejects.toMatchObject({
      code: "HA409",
    });
    await expect(checkIn(agent, "2026-09-28", "10:00")).rejects.toMatchObject({
      message: "Attendance tracking has not started yet",
    });
  });
});

describe("check-out", () => {
  it("calculates worked time, early departure and overtime", async () => {
    await checkIn(agent, "2026-10-19", "10:00");
    expect(await checkOut(agent, "2026-10-19", "16:30")).toMatchObject({
      state: "checked_out",
      worked_minutes: 390,
      early_departure_minutes: 90,
      overtime_minutes: 0,
    });
    await checkIn(other, "2026-10-19", "09:45");
    expect(await checkOut(other, "2026-10-19", "19:15")).toMatchObject({
      worked_minutes: 570,
      early_departure_minutes: 0,
      overtime_minutes: 75,
    });
  });
  it("refuses a second check-out, a check-out without check-in and two at once", async () => {
    await expect(checkOut(agent, "2026-10-19", "18:00")).rejects.toMatchObject({
      message: "You have not checked in today",
    });
    await checkIn(agent, "2026-10-19", "10:00");
    const both = await Promise.allSettled([
      checkOut(agent, "2026-10-19", "18:00"),
      checkOut(agent, "2026-10-19", "18:01"),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(checkOut(agent, "2026-10-19", "18:05")).rejects.toMatchObject({
      message: "You have already checked out today",
    });
  });
  it("keeps a forgotten check-out incomplete without inventing a time", async () => {
    await checkIn(agent, "2026-10-19", "10:00");
    // The report already shows the day as incomplete, before any job runs.
    expect(
      await days(agent, "2026-10-19", "2026-10-19", pk("2026-10-20", "09:00")),
    ).toEqual([
      { day: "2026-10-19", state: "incomplete", punctuality: "on_time" },
    ]);
    await expect(checkOut(agent, "2026-10-20", "18:00")).rejects.toMatchObject({
      message: expect.stringMatching(/never closed/),
    });
    const next = await checkIn(agent, "2026-10-20", "10:05");
    expect(next.closed_incomplete).toBe(1);
    expect(
      await one(
        "select state,check_out_at,worked_minutes from attendance_records where attendance_date='2026-10-19'",
      ),
    ).toEqual({
      state: "incomplete",
      check_out_at: null,
      worked_minutes: null,
    });
    const t = await totals(
      agent,
      "2026-10-19",
      "2026-10-19",
      pk("2026-10-21", "09:00"),
    );
    expect(t).toMatchObject({
      present_days: 0,
      incomplete_days: 1,
      worked_minutes: 0,
    });
  });
  it("reconciles open sessions once and never touches lead ownership", async () => {
    const lead = (
      await one(
        "select (public.create_lead($1::jsonb,'+923004445556',$2,'x')).id",
        [JSON.stringify({ name: "Customer", assigned_agent: agent }), admin],
      )
    ).id;
    // The scheduled job reaches the same function through run_crm_job.
    expect(
      (await one("select public.run_crm_job('attendance','{}') r")).r,
    ).toHaveProperty("affected");
    await checkIn(agent, "2026-10-19", "10:00");
    const job = async () =>
      (
        await one("select public.attendance_reconcile($1) r", [
          pk("2026-10-20", "09:00"),
        ])
      ).r;
    expect((await job()).affected).toBe(1);
    expect((await job()).affected).toBe(0);
    expect(
      await all(
        "select type,title from notifications where user_id=$1 and type='attendance_incomplete'",
        [agent],
      ),
    ).toEqual([
      {
        type: "attendance_incomplete",
        title: "Check-out missing for Mon 19 Oct",
      },
    ]);
    expect(
      (await one("select assigned_agent from leads where id=$1", [lead]))
        .assigned_agent,
    ).toBe(agent);
    expect(
      (
        await one("select count(*)::int n from assignments where lead_id=$1", [
          lead,
        ])
      ).n,
    ).toBe(1);
  });
});

describe("reports", () => {
  const now = pk("2026-10-24", "20:00");
  it("derives every day's state and agrees between daily and period totals", async () => {
    await pg.query(
      "insert into attendance_holidays(holiday_date,name) values('2026-10-22','Holiday')",
    );
    await checkIn(agent, "2026-10-19", "10:00");
    await checkOut(agent, "2026-10-19", "18:00");
    await checkIn(agent, "2026-10-20", "10:40");
    await checkOut(agent, "2026-10-20", "18:00");
    await checkIn(agent, "2026-10-21", "10:10");
    await pg.query(
      "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason,status,reviewer_id,reviewed_at) values($1,'casual','2026-10-23','2026-10-23','Family','approved',$2,now())",
      [agent, admin],
    );
    expect(await days(agent, "2026-10-19", "2026-10-25", now)).toEqual([
      { day: "2026-10-19", state: "checked_out", punctuality: "on_time" },
      { day: "2026-10-20", state: "checked_out", punctuality: "late" },
      { day: "2026-10-21", state: "incomplete", punctuality: "within_grace" },
      { day: "2026-10-22", state: "holiday", punctuality: null },
      { day: "2026-10-23", state: "leave", punctuality: null },
      { day: "2026-10-24", state: "absent", punctuality: null },
      { day: "2026-10-25", state: "day_off", punctuality: null },
    ]);
    const t = await totals(agent, "2026-10-19", "2026-10-25", now);
    expect(t).toMatchObject({
      scheduled_days: 6,
      eligible_days: 4,
      present_days: 2,
      absent_days: 1,
      incomplete_days: 1,
      leave_days: 1,
      holiday_days: 1,
      late_days: 1,
      within_grace_days: 1,
      completed_days: 2,
      worked_minutes: 480 + 440,
    });
    expect(Number(t.attendance_percent)).toBe(50);
    // A weekly total equals the sum of its days.
    let sum = 0;
    for (const d of [
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ])
      sum += (await totals(agent, d, d, now))?.present_days || 0;
    expect(sum).toBe(t.present_days);
  });
  it("handles mid-month joiners, dates before tracking and disabled employees", async () => {
    await pg.query(
      "update attendance_periods set starts_on='2026-10-15' where user_id=$1",
      [other],
    );
    const october = await totals(
      other,
      "2026-10-01",
      "2026-10-31",
      pk("2026-10-31", "20:00"),
    );
    // 15–31 October has 15 working days (Sundays excluded) for this joiner.
    expect(october.scheduled_days).toBe(15);
    expect(october.absent_days).toBe(15);
    expect(
      (await days(other, "2026-10-14", "2026-10-15", now)).map((d) => d.state),
    ).toEqual(["not_employed", "absent"]);
    expect(
      (await days(agent, "2026-09-30", "2026-10-01", now)).map((d) => d.state),
    ).toEqual(["not_tracked", "absent"]);
    await checkIn(agent, "2026-10-19", "10:00");
    await checkOut(agent, "2026-10-19", "18:00");
    await pg.query("update profiles set active=false where id=$1", [agent]);
    await pg.query(
      "update attendance_periods set ends_on='2026-10-20' where user_id=$1",
      [agent],
    );
    const later = await days(agent, "2026-10-19", "2026-10-21", now);
    expect(later.map((d) => d.state)).toEqual([
      "checked_out",
      "absent",
      "not_employed",
    ]);
    const report = await rpc("attendance_period", {
      p_actor: admin,
      p_from: "2026-10-19",
      p_to: "2026-10-24",
      p_search: null,
      p_role: null,
      p_account: "inactive",
    });
    expect(
      report.employees.map((e) => [e.name, e.active, e.present_days]),
    ).toEqual([["Ali Agent", false, 1]]);
  });
  it("opens and closes attendance periods as accounts are enabled and disabled", async () => {
    await pg.query("update profiles set active=false where id=$1", [other]);
    expect(
      await one(
        "select count(*)::int n from attendance_periods where user_id=$1 and ends_on is null",
        [other],
      ),
    ).toEqual({ n: 0 });
    await pg.query("update profiles set active=true where id=$1", [other]);
    expect(
      await one(
        "select count(*)::int n from attendance_periods where user_id=$1 and ends_on is null",
        [other],
      ),
    ).toEqual({ n: 1 });
  });
});

describe("leave", () => {
  it("validates, prevents overlaps and needs another administrator's approval", async () => {
    const req = (user, data) =>
      rpc("attendance_leave_request", {
        p_actor: user,
        p_data: data,
        p_request: "t",
      });
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    const leave = await req(agent, {
      leave_type: "sick",
      start_date: today,
      end_date: today,
      reason: "Fever",
    });
    await expect(
      req(agent, {
        leave_type: "casual",
        start_date: today,
        end_date: today,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "HA409" });
    await expect(
      rpc("attendance_leave_review", {
        p_actor: agent,
        p_id: leave.id,
        p_decision: "approved",
        p_note: null,
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "HA403" });
    const own = await req(admin, {
      leave_type: "casual",
      start_date: today,
      end_date: today,
      reason: "Errand",
    });
    await expect(
      rpc("attendance_leave_review", {
        p_actor: admin,
        p_id: own.id,
        p_decision: "approved",
        p_note: null,
        p_request: "t",
      }),
    ).rejects.toMatchObject({
      code: "HA403",
      message: expect.stringMatching(/another administrator/i),
    });
    await addAdmin();
    expect(
      (
        await rpc("attendance_leave_review", {
          p_actor: second,
          p_id: own.id,
          p_decision: "approved",
          p_note: "Fine",
          p_request: "t",
        })
      ).status,
    ).toBe("approved");
    const rejected = await rpc("attendance_leave_review", {
      p_actor: admin,
      p_id: leave.id,
      p_decision: "rejected",
      p_note: "Busy day",
      p_request: "t",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      review_note: "Busy day",
      reviewer_id: admin,
    });
    await expect(
      rpc("attendance_leave_review", {
        p_actor: second,
        p_id: leave.id,
        p_decision: "approved",
        p_note: null,
        p_request: "t",
      }),
    ).rejects.toMatchObject({
      message: "This request has already been reviewed",
    });
    expect(
      (
        await all(
          "select type,title from notifications where user_id=$1 and type='attendance_review'",
          [agent],
        )
      ).map((n) => n.title),
    ).toEqual(["Leave not approved"]);
  });
  it("turns past absences into leave when approved retroactively", async () => {
    const now = pk("2026-10-24", "20:00");
    expect((await days(agent, "2026-10-21", "2026-10-21", now))[0].state).toBe(
      "absent",
    );
    const leave = await rpc("attendance_leave_request", {
      p_actor: agent,
      p_data: {
        leave_type: "sick",
        start_date: "2026-10-21",
        end_date: "2026-10-21",
        reason: "Doctor",
      },
      p_request: "t",
    }).catch(async () =>
      // The 30-day retroactive window is relative to the real date; insert directly if it has passed.
      one(
        "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason) values($1,'sick','2026-10-21','2026-10-21','Doctor') returning *",
        [agent],
      ),
    );
    expect((await days(agent, "2026-10-21", "2026-10-21", now))[0].state).toBe(
      "absent",
    );
    await rpc("attendance_leave_review", {
      p_actor: admin,
      p_id: leave.id,
      p_decision: "approved",
      p_note: null,
      p_request: "t",
    });
    expect((await days(agent, "2026-10-21", "2026-10-21", now))[0].state).toBe(
      "leave",
    );
  });
});

describe("corrections", () => {
  const now = pk("2026-10-24", "20:00");
  async function correction(data) {
    // Requests are validated against the real date; build them directly for fixed past dates.
    return one(
      "insert into attendance_corrections(user_id,attendance_date,record_id,correction_type,original_check_in_at,original_check_out_at,requested_check_in_at,requested_check_out_at,reason) values($1,$2,$3,$4,$5,$6,$7,$8,'Forgot') returning *",
      [
        agent,
        data.date,
        data.record?.id || null,
        data.type,
        data.record?.check_in_at || null,
        data.record?.check_out_at || null,
        data.in || null,
        data.out || null,
      ],
    );
  }
  it("applies an approved missing check-out, recalculates and audits before and after", async () => {
    await checkIn(agent, "2026-10-19", "10:05");
    const record = await one(
      "select * from attendance_records where user_id=$1",
      [agent],
    );
    const c = await correction({
      date: "2026-10-19",
      type: "missing_check_out",
      record,
      out: pk("2026-10-19", "18:30"),
    });
    await expect(
      rpc("attendance_correction_review", {
        p_actor: agent,
        p_id: c.id,
        p_decision: "approved",
        p_note: null,
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "HA403" });
    const reviews = await Promise.allSettled(
      [1, 2].map(() =>
        rpc("attendance_correction_review", {
          p_actor: admin,
          p_id: c.id,
          p_decision: "approved",
          p_note: "Ok",
          p_request: "t",
        }),
      ),
    );
    expect(reviews.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await one(
        "select state,worked_minutes,overtime_minutes,corrected from attendance_records where id=$1",
        [record.id],
      ),
    ).toEqual({
      state: "checked_out",
      worked_minutes: 505,
      overtime_minutes: 30,
      corrected: true,
    });
    const audit = await one(
      "select metadata from audit_log where action='attendance.correction_approved'",
    );
    expect(audit.metadata.before).toMatchObject({
      check_out_at: null,
      worked_minutes: null,
    });
    expect(audit.metadata.after).toMatchObject({
      state: "checked_out",
      worked_minutes: 505,
    });
    expect((await days(agent, "2026-10-19", "2026-10-19", now))[0].state).toBe(
      "checked_out",
    );
  });
  it("creates a record for a missing check-in and refuses stale or self reviews", async () => {
    const c = await correction({
      date: "2026-10-20",
      type: "missing_check_in",
      in: pk("2026-10-20", "10:30"),
      out: pk("2026-10-20", "18:00"),
    });
    expect(
      (
        await rpc("attendance_correction_review", {
          p_actor: admin,
          p_id: c.id,
          p_decision: "approved",
          p_note: null,
          p_request: "t",
        })
      ).status,
    ).toBe("approved");
    expect(
      await one(
        "select punctuality,late_minutes,worked_minutes,corrected from attendance_records where attendance_date='2026-10-20'",
      ),
    ).toEqual({
      punctuality: "late",
      late_minutes: 30,
      worked_minutes: 450,
      corrected: true,
    });
    await checkIn(agent, "2026-10-21", "10:00");
    const record = await one(
      "select * from attendance_records where attendance_date='2026-10-21'",
    );
    const stale = await correction({
      date: "2026-10-21",
      type: "incorrect_check_in",
      record,
      in: pk("2026-10-21", "09:55"),
    });
    await pg.query("update attendance_records set check_in_at=$1 where id=$2", [
      pk("2026-10-21", "09:58"),
      record.id,
    ]);
    await expect(
      rpc("attendance_correction_review", {
        p_actor: admin,
        p_id: stale.id,
        p_decision: "approved",
        p_note: null,
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "HA409" });
    expect(
      (
        await rpc("attendance_correction_review", {
          p_actor: admin,
          p_id: stale.id,
          p_decision: "rejected",
          p_note: "Ask again",
          p_request: "t",
        })
      ).status,
    ).toBe("rejected");
  });
  it("validates proposed times when an employee asks", async () => {
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    const ask = (data) =>
      rpc("attendance_correction_request", {
        p_actor: agent,
        p_data: { attendance_date: today, reason: "Forgot", ...data },
        p_request: "t",
      });
    await pg.query(
      "update attendance_policies set work_days='{1,2,3,4,5,6,7}'",
    );
    await expect(
      ask({
        correction_type: "missing_check_out",
        requested_check_out_at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "HA409" });
    await expect(
      ask({
        correction_type: "missing_check_in",
        requested_check_in_at: "2020-01-01T10:00:00+05:00",
      }),
    ).rejects.toMatchObject({
      message: "Requested times must be on the selected date",
    });
    await expect(
      ask({
        correction_type: "missing_check_in",
        requested_check_in_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "HA400" });
    await expect(
      rpc("attendance_correction_request", {
        p_actor: agent,
        p_data: {
          attendance_date: "2026-01-05",
          correction_type: "missing_check_in",
          requested_check_in_at: "2026-01-05T10:00:00+05:00",
          reason: "Old",
        },
        p_request: "t",
      }),
    ).rejects.toMatchObject({ code: "HA400" });
  });
});

describe("attendance API", () => {
  it("lets each employee check in and out of today only for themselves", async () => {
    await pg.query(
      "update attendance_policies set work_days='{1,2,3,4,5,6,7}'",
    );
    expect((await request(app()).post("/api/attendance/check-in")).status).toBe(
      401,
    );
    expect(
      (
        await request(app())
          .post("/api/attendance/check-in")
          .set(as(agent))
          .send({ user_id: other })
      ).status,
    ).toBe(400);
    const r = await request(app())
      .post("/api/attendance/check-in")
      .set(as(agent))
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.user_id).toBe(agent);
    expect(r.headers["cache-control"]).toBe("no-store");
    const again = await request(app())
      .post("/api/attendance/check-in")
      .set(as(agent))
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("You have already checked in today");
    const me = await request(app()).get("/api/attendance/me").set(as(agent));
    expect(me.body.today).toMatchObject({
      state: "checked_in",
      record_id: r.body.id,
    });
    expect(me.body.employee).toMatchObject({
      id: agent,
      name: "Ali Agent",
      role: "agent",
    });
    const out = await request(app())
      .post("/api/attendance/check-out")
      .set(as(agent))
      .send({});
    expect(out.status).toBe(200);
    expect(out.body.state).toBe("checked_out");
    expect(
      (
        await request(app())
          .post("/api/attendance/check-in")
          .set(as(admin))
          .send({})
      ).status,
    ).toBe(201);
    await pg.query("update profiles set active=false where id=$1", [other]);
    expect(
      (
        await request(app())
          .post("/api/attendance/check-in")
          .set(as(other))
          .send({})
      ).status,
    ).toBe(403);
  });
  it("keeps team attendance and reviews for administrators", async () => {
    for (const path of [
      "/api/admin/attendance/overview",
      "/api/admin/attendance/daily?date=2026-10-19",
      "/api/admin/attendance/weekly?week_start=2026-10-19",
      `/api/admin/attendance/employees/${other}?from=2026-10-01&to=2026-10-19`,
      "/api/admin/attendance/export?type=daily&date=2026-10-19",
    ])
      expect((await request(app()).get(path).set(as(agent))).status).toBe(403);
    expect(
      (
        await request(app())
          .get(`/api/attendance/history?from=2026-10-01&to=2026-10-19`)
          .set(as(agent))
      ).status,
    ).toBe(200);
    const register = await request(app())
      .get("/api/admin/attendance/daily?date=2026-10-12")
      .set(as(admin));
    expect(register.status).toBe(200);
    expect(register.body.data.map((r) => [r.name, r.state])).toEqual([
      ["Ali Agent", "absent"],
      ["Owner", "absent"],
      ["Sara Agent", "absent"],
    ]);
    const lateOnly = await request(app())
      .get(
        "/api/admin/attendance/daily?date=2026-10-12&state=absent&role=agent&search=Sara",
      )
      .set(as(admin));
    expect(lateOnly.body.data.map((r) => r.name)).toEqual(["Sara Agent"]);
    const month = await request(app())
      .get("/api/admin/attendance/monthly?month=2026-10")
      .set(as(admin));
    expect(month.body.employees).toHaveLength(3);
    expect(month.body.trend.length).toBe(31);
    expect(
      (
        await request(app())
          .get("/api/admin/attendance/weekly?week_start=2026-10-20")
          .set(as(admin))
      ).status,
    ).toBe(400);
  });
  it("exports formula-safe CSV and XLSX without private data", async () => {
    await pg.query("update profiles set name='=HYPERLINK(\"x\")' where id=$1", [
      other,
    ]);
    const csv = await request(app())
      .get("/api/admin/attendance/export?type=daily&date=2026-10-12")
      .set(as(admin));
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\r\n")).toHaveLength(4);
    expect(csv.text).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv.text).not.toMatch(/\+92|password|token/i);
    const xlsx = await request(app())
      .get(
        "/api/admin/attendance/export?type=monthly&month=2026-10&format=xlsx",
      )
      .set(as(admin))
      .buffer(true)
      .parse((res, done) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const book = read(xlsx.body);
    const sheet = book.Sheets.Attendance;
    expect(sheet.A1.v).toBe("Employee");
    expect(Object.values(sheet).some((cell) => cell?.f)).toBe(false);
  });
  it("manages holidays and versioned settings without rewriting history", async () => {
    await checkIn(agent, "2026-10-19", "10:20");
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    expect(
      (
        await request(app())
          .post("/api/admin/attendance/holidays")
          .set(as(agent))
          .send({ holiday_date: "2026-12-25", name: "Quaid Day" })
      ).status,
    ).toBe(403);
    const h = await request(app())
      .post("/api/admin/attendance/holidays")
      .set(as(admin))
      .send({ holiday_date: "2026-12-25", name: "Quaid Day" });
    expect(h.status).toBe(201);
    expect(
      (
        await request(app())
          .post("/api/admin/attendance/holidays")
          .set(as(admin))
          .send({ holiday_date: "2026-12-25", name: "Again" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app())
          .get("/api/attendance/holidays?year=2026")
          .set(as(agent))
      ).body,
    ).toHaveLength(1);
    expect(
      (
        await request(app())
          .delete("/api/admin/attendance/holidays/" + h.body.id)
          .set(as(admin))
      ).status,
    ).toBe(200);
    const policy = {
      name: "Winter hours",
      shift_start: "09:30",
      shift_end: "17:30",
      work_days: [1, 2, 3, 4, 5, 6],
      grace_minutes: 10,
    };
    expect(
      (
        await request(app())
          .patch("/api/admin/attendance/settings")
          .set(as(admin))
          .send({ ...policy, effective_from: "2026-10-02" })
      ).status,
    ).toBe(400);
    const saved = await request(app())
      .patch("/api/admin/attendance/settings")
      .set(as(admin))
      .send({ ...policy, effective_from: today });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      name: "Winter hours",
      grace_minutes: 10,
      effective_from: today,
    });
    // The earlier record keeps the rules it was recorded under.
    expect(
      await one(
        "select shift_start::text,grace_minutes,late_minutes from attendance_records",
      ),
    ).toEqual({
      shift_start: "10:00:00",
      grace_minutes: 15,
      late_minutes: 20,
    });
    const list = await request(app())
      .get("/api/admin/attendance/settings")
      .set(as(admin));
    expect(list.body.versions.map((v) => v.name)).toEqual([
      "Winter hours",
      "HD Marketing standard",
    ]);
    expect(list.body.current.name).toBe("Winter hours");
  });
  it("runs the leave and correction workflow over the API", async () => {
    const today = (
      await one("select public.attendance_local_date(now())::text d")
    ).d;
    expect(
      (
        await request(app()).post("/api/attendance/leave").set(as(agent)).send({
          leave_type: "sick",
          start_date: today,
          end_date: "2000-01-01",
          reason: "x",
        })
      ).status,
    ).toBe(400);
    const leave = await request(app())
      .post("/api/attendance/leave")
      .set(as(agent))
      .send({
        leave_type: "sick",
        start_date: today,
        end_date: today,
        reason: "Fever",
      });
    expect(leave.status).toBe(201);
    expect(
      (await request(app()).get("/api/attendance/leave").set(as(other))).body
        .count,
    ).toBe(0);
    expect(
      (
        await request(app())
          .get("/api/admin/attendance/leave?status=pending")
          .set(as(admin))
      ).body.data[0],
    ).toMatchObject({
      id: leave.body.id,
      employee_name: "Ali Agent",
    });
    expect(
      (
        await request(app())
          .post(`/api/admin/attendance/leave/${leave.body.id}/review`)
          .set(as(agent))
          .send({ decision: "approved" })
      ).status,
    ).toBe(403);
    const reviewed = await request(app())
      .post(`/api/admin/attendance/leave/${leave.body.id}/review`)
      .set(as(admin))
      .send({ decision: "approved", note: "Get well" });
    expect(reviewed.body.status).toBe("approved");
    const mine = await request(app())
      .get("/api/attendance/leave")
      .set(as(agent));
    expect(mine.body.data[0]).toMatchObject({
      status: "approved",
      review_note: "Get well",
      reviewer_name: "Owner",
    });
  });
});
