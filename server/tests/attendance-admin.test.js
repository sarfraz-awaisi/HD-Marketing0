import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 042: administrators enter or correct attendance for earlier days.
// Dated checks call the *_at form with a fixed "now" (Wednesday 28 October
// 2026, 12:00 Pakistan time); tracking began on Monday 26 October, so the
// week of 19 October lies before it. API checks use the database clock.
const admin = "ac000000-0000-4000-8000-000000000001",
  agent = "ac000000-0000-4000-8000-000000000002",
  other = "ac000000-0000-4000-8000-000000000003";
const NOW = "2026-10-28T12:00:00+05:00";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  await pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-26');update attendance_periods set starts_on='2026-10-26';",
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
const set = (actor, user, entries, opts = {}) =>
  sql(
    "select public.attendance_admin_set_at($1,$2,$3::jsonb,$4,$5,$6,'t',$7) r",
    [
      actor,
      user,
      JSON.stringify(entries),
      opts.reason ?? null,
      opts.replace ?? false,
      opts.dry ?? false,
      opts.now ?? NOW,
    ],
  ).then((x) => x.r);
const worked = (date, check_in = "10:00", check_out = "18:00", status) => ({
  date,
  status: status || "present",
  check_in,
  check_out,
});
const outcomes = (r) => r.results.map((x) => [x.date, x.result]);
const days = (user, from, to, now = NOW) =>
  all(
    "select day::text,state,punctuality from public.attendance_days($1,$2,$3,$4) order by day",
    [from, to, user, now],
  );
const totals = (user, from, to, now = NOW) =>
  one("select * from public.attendance_totals($1,$2,$3,$4)", [
    from,
    to,
    user,
    now,
  ]);
const record = (user, day) =>
  one(
    "select check_in_at,check_out_at,state,punctuality,late_minutes,beyond_grace_minutes,worked_minutes,early_departure_minutes,corrected from attendance_records where user_id=$1 and attendance_date=$2",
    [user, day],
  );
const notifications = () =>
  one("select count(*)::integer n from notifications").then((x) => x.n);
const week = (from, to) =>
  ["19", "20", "21", "22", "23", "24", "25", "26", "27"]
    .map((d) => `2026-10-${d}`)
    .filter((d) => d >= from && d <= to);

describe("entering days before tracking began", () => {
  it("previews without changing anything, then records the week under the same rules", async () => {
    const entries = week("2026-10-19", "2026-10-25").map((d) => worked(d));
    const preview = await set(admin, agent, entries, {
      dry: true,
      reason: "Paper register",
    });
    expect(preview.dry_run).toBe(true);
    expect(outcomes(preview)).toEqual([
      ["2026-10-19", "create"],
      ["2026-10-20", "create"],
      ["2026-10-21", "create"],
      ["2026-10-22", "create"],
      ["2026-10-23", "create"],
      ["2026-10-24", "create"],
      ["2026-10-25", "error"],
    ]);
    expect(preview.results[6].message).toBe("Scheduled day off");
    expect(preview.counted_days).toEqual(week("2026-10-19", "2026-10-24"));
    expect(preview.tracking_start).toEqual({
      from: "2026-10-26",
      to: "2026-10-19",
    });
    expect(
      (await one("select count(*)::integer n from attendance_records")).n,
    ).toBe(0);
    expect(
      (await one("select min(effective_from)::text d from attendance_policies"))
        .d,
    ).toBe("2026-10-26");

    const saved = await set(admin, agent, entries, {
      reason: "Paper register",
    });
    expect(saved.summary).toEqual({
      created: 6,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 1,
    });
    expect(await record(agent, "2026-10-20")).toMatchObject({
      state: "checked_out",
      punctuality: "on_time",
      worked_minutes: 480,
      early_departure_minutes: 0,
      corrected: true,
    });
    // The first rules now start on 19 October. Ali's own attendance still
    // starts on 26 October; the entered week is counted by a period of its
    // own, run over Sunday up to his start, and nobody else's changed.
    expect(
      (await one("select min(effective_from)::text d from attendance_policies"))
        .d,
    ).toBe("2026-10-19");
    expect(
      await all(
        "select user_id,starts_on::text,ends_on::text,recorded_by from attendance_periods order by starts_on,user_id",
      ),
    ).toEqual([
      {
        user_id: agent,
        starts_on: "2026-10-19",
        ends_on: "2026-10-25",
        recorded_by: admin,
      },
      {
        user_id: admin,
        starts_on: "2026-10-26",
        ends_on: null,
        recorded_by: null,
      },
      {
        user_id: agent,
        starts_on: "2026-10-26",
        ends_on: null,
        recorded_by: null,
      },
      {
        user_id: other,
        starts_on: "2026-10-26",
        ends_on: null,
        recorded_by: null,
      },
    ]);
    expect(
      (await days(agent, "2026-10-19", "2026-10-27")).map((d) => d.state),
    ).toEqual([...Array(6).fill("checked_out"), "day_off", "absent", "absent"]);
    // Sara's earlier days stay outside her attendance, never absent.
    expect(
      (await days(other, "2026-10-19", "2026-10-27")).map((d) => d.state),
    ).toEqual([...Array(7).fill("not_employed"), "absent", "absent"]);
    expect(await totals(agent, "2026-10-19", "2026-10-28")).toMatchObject({
      scheduled_days: 9,
      eligible_days: 8,
      present_days: 6,
      absent_days: 2,
      on_time_days: 6,
      attendance_percent: "75.0",
    });
    // Each change is audited with who, which day, before, after and why.
    const audit = await all(
      "select action,actor_id,metadata from audit_log order by id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      "attendance.tracking_start_moved",
      ...Array(6).fill("attendance.manual_create"),
    ]);
    // The administrator is the actor; the employee is named in every entry.
    expect(audit.every((a) => a.actor_id === admin)).toBe(true);
    expect(audit.every((a) => a.metadata.user_id === agent)).toBe(true);
    expect(audit[1].metadata).toMatchObject({
      user_id: agent,
      date: "2026-10-19",
      status: "present",
      reason: "Paper register",
      counted: true,
      before: { state: "not_counted", check_in_at: null },
      after: {
        state: "checked_out",
        punctuality: "on_time",
        worked_minutes: 480,
      },
    });
    expect(await notifications()).toBe(0);
  });

  it("counts only the days entered; days nobody entered never become absences", async () => {
    const preview = await set(
      admin,
      agent,
      [{ date: "2026-10-21", status: "absent" }],
      { dry: true },
    );
    expect(outcomes(preview)).toEqual([["2026-10-21", "create"]]);
    expect(preview.counted_days).toEqual(["2026-10-21"]);
    await set(admin, agent, [{ date: "2026-10-21", status: "absent" }]);
    // Days nobody entered are not counted, never absent: 19 and 20 fall
    // before tracking (which moved back only to 21), 22–25 outside Ali's
    // attendance.
    expect(
      (await days(agent, "2026-10-19", "2026-10-25")).map((d) => d.state),
    ).toEqual([
      "not_tracked",
      "not_tracked",
      "absent",
      "not_employed",
      "not_employed",
      "not_employed",
      "not_employed",
    ]);
    expect(await totals(agent, "2026-10-19", "2026-10-25")).toMatchObject({
      eligible_days: 1,
      absent_days: 1,
      present_days: 0,
    });
    // Entering the rest of the week joins it up, Sunday included as a day off.
    await set(
      admin,
      agent,
      week("2026-10-22", "2026-10-24").map((d) => worked(d)),
    );
    expect(
      (await days(agent, "2026-10-21", "2026-10-25")).map((d) => d.state),
    ).toEqual([
      "absent",
      "checked_out",
      "checked_out",
      "checked_out",
      "day_off",
    ]);
    expect(
      await all(
        "select starts_on::text,ends_on::text from attendance_periods where user_id=$1 and recorded_by is not null",
        [agent],
      ),
    ).toEqual([{ starts_on: "2026-10-21", ends_on: "2026-10-25" }]);
    const again = await set(admin, agent, [
      { date: "2026-10-27", status: "absent" },
    ]);
    expect(again.results[0]).toMatchObject({
      result: "unchanged",
      message: "Already counted as absent",
    });
  });

  it("removes a mistaken entry without leaving an absence behind", async () => {
    await set(admin, other, [
      worked("2026-10-20"),
      worked("2026-10-21"),
      { date: "2026-10-22", status: "leave", leave_type: "casual" },
    ]);
    const kept = await set(admin, other, [
      { date: "2026-10-20", status: "clear" },
    ]);
    expect(kept.results[0].result).toBe("skip");
    const removed = await set(
      admin,
      other,
      [
        { date: "2026-10-20", status: "clear" },
        { date: "2026-10-22", status: "clear" },
        { date: "2026-10-19", status: "clear" },
        { date: "2026-10-27", status: "clear" },
      ],
      { replace: true, reason: "Wrong employee" },
    );
    expect(removed.results.map((r) => [r.date, r.result])).toEqual([
      ["2026-10-19", "unchanged"],
      ["2026-10-20", "update"],
      ["2026-10-22", "update"],
      ["2026-10-27", "error"],
    ]);
    expect(removed.results[3].message).toBe(
      "This day is part of the employee's own attendance. Mark it absent or enter attendance instead.",
    );
    expect(
      (await days(other, "2026-10-19", "2026-10-23")).map((d) => d.state),
    ).toEqual([
      "not_tracked",
      "not_employed",
      "checked_out",
      "not_employed",
      "not_employed",
    ]);
    expect(
      (await one("select count(*)::integer n from attendance_leave_requests"))
        .n,
    ).toBe(0);
    expect(
      await all(
        "select starts_on::text,ends_on::text from attendance_periods where user_id=$1 and recorded_by is not null",
        [other],
      ),
    ).toEqual([{ starts_on: "2026-10-21", ends_on: "2026-10-21" }]);
    const audit = await one(
      "select actor_id,metadata from audit_log where action='attendance.manual_update' and metadata->>'date'='2026-10-20'",
    );
    expect(audit).toMatchObject({
      actor_id: admin,
      metadata: {
        user_id: other,
        status: "clear",
        reason: "Wrong employee",
        before: { state: "checked_out" },
        after: { state: "not_counted" },
      },
    });
  });

  it("saves a batch together or not at all, and never duplicates a day", async () => {
    await pg.exec(
      "create function fail_on_22() returns trigger language plpgsql as $$ begin if new.attendance_date='2026-10-22' then raise exception 'database refused'; end if; return new; end $$; create trigger fail_on_22 before insert on attendance_records for each row execute function fail_on_22();",
    );
    try {
      await expect(
        set(
          admin,
          agent,
          week("2026-10-19", "2026-10-24").map((d) => worked(d)),
        ),
      ).rejects.toThrow("database refused");
      expect(
        (await one("select count(*)::integer n from attendance_records")).n,
      ).toBe(0);
      expect(
        (
          await one(
            "select count(*)::integer n from attendance_periods where recorded_by is not null",
          )
        ).n,
      ).toBe(0);
      expect(
        (
          await one(
            "select min(effective_from)::text d from attendance_policies",
          )
        ).d,
      ).toBe("2026-10-26");
      expect((await one("select count(*)::integer n from audit_log")).n).toBe(
        0,
      );
    } finally {
      await pg.exec(
        "drop trigger fail_on_22 on attendance_records;drop function fail_on_22();",
      );
    }
    const entries = week("2026-10-19", "2026-10-24").map((d) => worked(d));
    expect((await set(admin, agent, entries)).summary.created).toBe(6);
    const again = await set(admin, agent, entries, { replace: true });
    expect(again.summary).toMatchObject({ created: 0, unchanged: 6 });
    expect(
      (await one("select count(*)::integer n from attendance_records")).n,
    ).toBe(6);
  });
});

describe("changing existing attendance", () => {
  it("keeps existing days unless asked to replace them, then audits before and after", async () => {
    await sql("select public.attendance_check_in_at($1,$2,'t')", [
      agent,
      pk("2026-10-26", "10:20"),
    ]);
    await sql("select public.attendance_check_out_at($1,$2,'t')", [
      agent,
      pk("2026-10-26", "17:00"),
    ]);
    await sql("select public.attendance_check_in_at($1,$2,'t')", [
      other,
      pk("2026-10-26", "10:05"),
    ]);
    await sql("select public.attendance_check_out_at($1,$2,'t')", [
      other,
      pk("2026-10-26", "18:00"),
    ]);
    const sara = await record(other, "2026-10-26");
    const kept = await set(admin, agent, [worked("2026-10-26")]);
    expect(kept.results[0]).toMatchObject({ result: "skip" });
    expect(await record(agent, "2026-10-26")).toMatchObject({
      punctuality: "late",
      late_minutes: 20,
      corrected: false,
    });
    const changed = await set(admin, agent, [worked("2026-10-26")], {
      replace: true,
      reason: "Arrived on time; door log",
    });
    expect(changed.results[0].result).toBe("update");
    expect(await record(agent, "2026-10-26")).toMatchObject({
      punctuality: "on_time",
      late_minutes: 0,
      worked_minutes: 480,
      corrected: true,
    });
    const audit = await one(
      "select metadata from audit_log where action='attendance.manual_update'",
    );
    expect(audit.metadata).toMatchObject({
      user_id: agent,
      date: "2026-10-26",
      reason: "Arrived on time; door log",
      before: { state: "checked_out", punctuality: "late" },
      after: { punctuality: "on_time", worked_minutes: 480 },
    });
    expect(new Date(audit.metadata.before.check_in_at).toISOString()).toBe(
      "2026-10-26T05:20:00.000Z",
    );
    const same = await set(admin, agent, [worked("2026-10-26")], {
      replace: true,
    });
    expect(same.results[0].result).toBe("unchanged");
    // Nobody else's attendance changed, and no duplicate row was made.
    expect(await record(other, "2026-10-26")).toEqual(sara);
    expect(
      (await one("select count(*)::integer n from attendance_records")).n,
    ).toBe(2);
    // Removing a worked day makes it an absence again.
    const removed = await set(
      admin,
      agent,
      [{ date: "2026-10-26", status: "absent" }],
      { replace: true },
    );
    expect(removed.results[0].result).toBe("update");
    expect((await days(agent, "2026-10-26", "2026-10-26"))[0].state).toBe(
      "absent",
    );
    expect(await notifications()).toBe(0);
  });

  it("records leave without notifying anyone and leaves employees' own leave alone", async () => {
    const leave = await set(
      admin,
      agent,
      [{ date: "2026-10-27", status: "leave", leave_type: "sick" }],
      { reason: "Doctor's note seen" },
    );
    expect(leave.results[0].result).toBe("create");
    // The employee sees this leave in their own list, so the
    // administrator's reason stays in the audit log only.
    expect(
      await one(
        "select leave_type,status,reviewer_id,recorded_by,start_date::text,end_date::text,reason from attendance_leave_requests where user_id=$1",
        [agent],
      ),
    ).toEqual({
      leave_type: "sick",
      status: "approved",
      reviewer_id: admin,
      recorded_by: admin,
      start_date: "2026-10-27",
      end_date: "2026-10-27",
      reason: "Recorded by an administrator",
    });
    expect(
      (
        await one(
          "select metadata->>'reason' r from audit_log where action='attendance.manual_create'",
        )
      ).r,
    ).toBe("Doctor's note seen");
    expect((await days(agent, "2026-10-27", "2026-10-27"))[0].state).toBe(
      "leave",
    );
    // Recorded leave can be turned into a worked day; the leave row goes.
    const work = await set(admin, agent, [worked("2026-10-27")], {
      replace: true,
    });
    expect(work.results[0].result).toBe("update");
    expect(
      (await one("select count(*)::integer n from attendance_leave_requests"))
        .n,
    ).toBe(0);
    // An employee's own approved request cannot be removed here.
    await pg.query(
      "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason,status,reviewer_id,reviewed_at) values($1,'casual','2026-10-26','2026-10-27','Family visit','approved',$2,now())",
      [other, admin],
    );
    const request = await one(
      "select * from attendance_leave_requests where user_id=$1",
      [other],
    );
    const refused = await set(
      admin,
      other,
      [
        { date: "2026-10-26", status: "leave", leave_type: "sick" },
        { date: "2026-10-27", status: "absent" },
      ],
      { replace: true },
    );
    expect(refused.results.map((r) => [r.result, r.message])).toEqual([
      [
        "error",
        "This day is covered by an approved leave request, which cannot be changed here",
      ],
      [
        "error",
        "This day is covered by an approved leave request, which cannot be changed here",
      ],
    ]);
    // Without "replace", work over that leave is not recorded at all.
    const kept = await set(admin, other, [worked("2026-10-26")]);
    expect(kept.results[0].result).toBe("skip");
    expect(
      await one("select * from attendance_leave_requests where user_id=$1", [
        other,
      ]),
    ).toEqual(request);
    expect(await notifications()).toBe(0);
  });

  it("protects days with a waiting or past correction", async () => {
    await sql("select public.attendance_check_in_at($1,$2,'t')", [
      agent,
      pk("2026-10-26", "10:00"),
    ]);
    const rec = await one(
      "select id,check_in_at from attendance_records where user_id=$1",
      [agent],
    );
    await pg.query(
      "insert into attendance_corrections(user_id,attendance_date,record_id,correction_type,original_check_in_at,requested_check_out_at,reason,status) values($1,'2026-10-26',$2,'missing_check_out',$3,$4,'Forgot to check out','pending')",
      [agent, rec.id, rec.check_in_at, pk("2026-10-26", "18:00")],
    );
    const waiting = await set(admin, agent, [worked("2026-10-26")], {
      replace: true,
    });
    expect(waiting.results[0].message).toBe(
      "A correction request for this day is waiting. Review it first.",
    );
    await pg.query("update attendance_corrections set status='cancelled'");
    const correction = await one("select * from attendance_corrections");
    const history = await set(
      admin,
      agent,
      [{ date: "2026-10-26", status: "absent" }],
      { replace: true },
    );
    expect(history.results[0].message).toBe(
      "This day has correction history, so its record cannot be removed",
    );
    // The day's times can still be corrected on purpose; the correction
    // request itself is never changed.
    const fixed = await set(admin, agent, [worked("2026-10-26")], {
      replace: true,
    });
    expect(fixed.results[0].result).toBe("update");
    expect(await one("select * from attendance_corrections")).toEqual(
      correction,
    );
  });
});

describe("validation", () => {
  it("accepts only earlier working days with sensible times", async () => {
    await pg.query(
      "insert into attendance_holidays(holiday_date,name) values('2026-10-22','Founders day')",
    );
    const r = await set(admin, agent, [
      worked("2026-10-28"),
      worked("2026-10-29"),
      worked("2025-10-20"),
      worked("2026-10-22"),
      worked("2026-10-19", "18:00", "10:00"),
      { date: "2026-10-20", status: "present", check_in: "10:00" },
      worked("2026-10-21", "10:15", "18:00", "late"),
      worked("2026-10-23", "10:16", "18:00", "late"),
      worked("2026-10-24", "10:00", "18:00", "half_day"),
    ]);
    expect(r.results.map((x) => [x.date, x.result, x.message])).toEqual([
      ["2025-10-20", "error", "Choose a date within the last year"],
      ["2026-10-19", "error", "Check-out must be after check-in"],
      ["2026-10-20", "error", "Enter both the check-in and check-out times"],
      [
        "2026-10-21",
        "error",
        "A 10:15 check-in is within the 15-minute grace period, so the day is not late",
      ],
      ["2026-10-22", "error", "Company holiday: Founders day"],
      ["2026-10-23", "create", null],
      ["2026-10-24", "error", "A half day ends before the shift ends at 18:00"],
      [
        "2026-10-28",
        "error",
        "Today's attendance uses check-in and check-out. Choose an earlier day.",
      ],
      ["2026-10-29", "error", "Future dates cannot be entered"],
    ]);
    // Late is calculated by the existing rules: 16 minutes, one beyond grace.
    expect(await record(agent, "2026-10-23")).toMatchObject({
      punctuality: "late",
      late_minutes: 16,
      beyond_grace_minutes: 1,
    });
    const half = await set(admin, agent, [
      worked("2026-10-24", "10:00", "14:00", "half_day"),
    ]);
    expect(half.results[0].result).toBe("create");
    expect(await record(agent, "2026-10-24")).toMatchObject({
      worked_minutes: 240,
      early_departure_minutes: 240,
    });
    // A day when the account was disabled is not filled in.
    await pg.query(
      "update attendance_periods set ends_on='2026-10-26' where user_id=$1 and recorded_by is null",
      [other],
    );
    await pg.query(
      "insert into attendance_periods(user_id,starts_on) values($1,'2026-10-28')",
      [other],
    );
    const gap = await set(admin, other, [worked("2026-10-27")]);
    expect(gap.results[0]).toMatchObject({
      result: "error",
      message: "The account was not active on this date",
    });
  });

  it("refuses malformed requests, self-changes, unknown people and agents", async () => {
    const fails = (actor, user, entries) =>
      set(actor, user, entries).then(
        () => null,
        (e) => [e.code, e.message],
      );
    expect(
      await fails(admin, agent, [worked("2026-10-20"), worked("2026-10-20")]),
    ).toEqual(["HA400", "Enter each date once"]);
    expect(
      await fails(admin, agent, [{ date: "2026-10-20", status: "sick" }]),
    ).toEqual(["HA400", "Invalid attendance entry"]);
    expect(
      await fails(
        admin,
        agent,
        Array.from({ length: 32 }, (_, i) =>
          worked(`2026-09-${String((i % 28) + 1).padStart(2, "0")}`),
        ),
      ),
    ).toEqual(["HA400", "Choose between 1 and 31 dates"]);
    expect(await fails(admin, admin, [worked("2026-10-20")])).toEqual([
      "HA403",
      "You cannot change your own attendance. Another administrator must do it.",
    ]);
    expect(
      await fails(admin, "ac000000-0000-4000-8000-000000000009", [
        worked("2026-10-20"),
      ]),
    ).toEqual(["HA404", "Employee not found"]);
    expect(await fails(agent, other, [worked("2026-10-20")])).toEqual([
      "HA403",
      "Administrator access required",
    ]);
  });
});

describe("reports and live attendance after entering history", () => {
  it("counts entered days in the daily register and weekly and monthly reports", async () => {
    await set(admin, agent, [
      worked("2026-10-19"),
      worked("2026-10-20", "10:30", "18:00"),
      { date: "2026-10-21", status: "absent" },
      { date: "2026-10-22", status: "leave", leave_type: "casual" },
      worked("2026-10-23"),
      worked("2026-10-24", "10:00", "14:00", "half_day"),
    ]);
    const register = await sql(
      "select public.attendance_daily($1,'2026-10-20',null,null,null,null,null,1,25) r",
      [admin],
    );
    expect(
      register.r.data.map((r) => [r.name, r.state, r.punctuality, r.corrected]),
    ).toEqual([["Ali Agent", "checked_out", "late", true]]);
    const weekly = await sql(
      "select public.attendance_period($1,'2026-10-19','2026-10-25',null,null,null) r",
      [admin],
    );
    expect(weekly.r.employees.find((e) => e.user_id === agent)).toMatchObject({
      present_days: 4,
      absent_days: 1,
      leave_days: 1,
      late_days: 1,
      eligible_days: 5,
      attendance_percent: 80,
    });
    expect(weekly.r.trend.map((d) => d.present)).toEqual([1, 1, 0, 0, 1, 1, 0]);
    const monthly = await sql(
      "select public.attendance_period($1,'2026-10-01','2026-10-31',null,null,null) r",
      [admin],
    );
    expect(monthly.r.employees.find((e) => e.user_id === agent)).toMatchObject({
      present_days: 4,
      leave_days: 1,
      late_days: 1,
    });
  });

  it("keeps live check-in and the reconciliation job working without notices for earlier days", async () => {
    await set(
      admin,
      agent,
      week("2026-10-19", "2026-10-24").map((d) => worked(d)),
    );
    const checked = await sql(
      "select public.attendance_check_in_at($1,$2,'t') r",
      [agent, pk("2026-10-28", "10:05")],
    );
    expect(checked.r).toMatchObject({
      state: "checked_in",
      punctuality: "within_grace",
    });
    await sql("select public.attendance_reconcile($1)", [NOW]);
    expect(await notifications()).toBe(0);
    expect((await days(agent, "2026-10-28", "2026-10-28"))[0].state).toBe(
      "checked_in",
    );
  });
});

describe("administrator attendance API", () => {
  const pkToday = () =>
    new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const addDays = (d, n) =>
    new Date(Date.parse(d + "T00:00:00Z") + n * 864e5)
      .toISOString()
      .slice(0, 10);
  const isoDow = (d) => ((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
  // The most recent earlier working day (Monday–Saturday).
  let day = addDays(pkToday(), -1);
  while (isoDow(day) === 7) day = addDays(day, -1);

  it("keeps the management endpoints for administrators", async () => {
    expect(
      (
        await request(app())
          .get(`/api/admin/attendance/manage?user=${other}&date=${day}`)
          .set(as(agent))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .post("/api/admin/attendance/manage")
          .set(as(agent))
          .send({ user_id: other, entries: [worked(day)] })
      ).status,
    ).toBe(403);
  });

  it("loads a day, previews, saves and shows the result in the register", async () => {
    const view = await request(app())
      .get(`/api/admin/attendance/manage?user=${agent}&date=${day}`)
      .set(as(admin));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      date: day,
      self: false,
      employee: { id: agent, name: "Ali Agent" },
      rules: { shift_start: "10:00", shift_end: "18:00", grace_minutes: 15 },
      record: null,
      history: [],
    });
    const body = {
      user_id: agent,
      entries: [worked(day, "10:00", "18:00")],
      reason: "Paper register",
    };
    const preview = await request(app())
      .post("/api/admin/attendance/manage")
      .set(as(admin))
      .send({ ...body, dry_run: true });
    expect(preview.status).toBe(200);
    expect(preview.body.results[0].result).toBe("create");
    expect(
      (await one("select count(*)::integer n from attendance_records")).n,
    ).toBe(0);
    const saved = await request(app())
      .post("/api/admin/attendance/manage")
      .set(as(admin))
      .send(body);
    expect(saved.body.summary.created).toBe(1);
    const register = await request(app())
      .get(`/api/admin/attendance/daily?date=${day}&search=Ali`)
      .set(as(admin));
    expect(register.body.data[0]).toMatchObject({
      state: "checked_out",
      corrected: true,
      worked_minutes: 480,
    });
    const after = await request(app())
      .get(`/api/admin/attendance/manage?user=${agent}&date=${day}`)
      .set(as(admin));
    expect(after.body.history[0]).toMatchObject({
      action: "attendance.manual_create",
      by: "Owner",
      reason: "Paper register",
      after: { state: "checked_out" },
    });
  });

  it("names update 042 when the database has not been updated", async () => {
    const missing = {
      ...db,
      rpc: async (name, args) =>
        name.startsWith("attendance_admin")
          ? { data: null, error: { code: "PGRST202", message: "not found" } }
          : db.rpc(name, args),
    };
    const r = await request(createApp(trustedMfaFixture(missing)))
      .get(`/api/admin/attendance/manage?user=${agent}&date=${day}`)
      .set(as(admin));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(
      "Attendance management needs CRM database update 042.",
    );
  });

  it("rejects invalid dates, times and fields before reaching the database", async () => {
    for (const entries of [
      [worked("2026-02-30")],
      [worked(day, "25:00", "18:00")],
      [{ ...worked(day), user_id: other }],
      [],
    ]) {
      const r = await request(app())
        .post("/api/admin/attendance/manage")
        .set(as(admin))
        .send({ user_id: agent, entries });
      expect(r.status).toBe(400);
    }
    expect(
      (
        await request(app())
          .get(`/api/admin/attendance/manage?user=${agent}&date=2026-13-01`)
          .set(as(admin))
      ).status,
    ).toBe(400);
  });
});
