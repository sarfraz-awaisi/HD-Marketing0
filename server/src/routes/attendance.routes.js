import { Router } from "express";
import { utils, write } from "xlsx";
import { z } from "zod";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import {
  uuid,
  attendanceRange,
  leaveCreate,
  correctionCreate,
  requestReview,
  requestListQuery,
  attendanceDailyQuery,
  attendanceWeekQuery,
  attendanceMonthQuery,
  attendanceExportQuery,
  holidayCreate,
  holidayQuery,
  attendancePolicy,
} from "../utils/validators.js";
import { csvCell } from "../utils/phoneMask.js";
// Attendance (update 040). Every handler runs after the shared auth
// middleware; the employee is always req.user, never an id from the browser.
// SQL raises HA<status> with messages written for the signed-in user.
export async function attendanceRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const custom = /^HA(\d{3})$/.exec(error.code || "");
  if (custom)
    throw Object.assign(new Error(error.message), {
      status: Number(custom[1]),
    });
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : error.code === "23505" || ["40001", "40P01"].includes(error.code)
      ? 409
      : ["22P02", "22007", "22008", "23514"].includes(error.code)
        ? 400
        : 503;
  throw Object.assign(
    new Error(
      missing
        ? "Attendance needs CRM database update 040 after 039."
        : status === 409
          ? "This was changed at the same moment. Refresh and try again."
          : status === 400
            ? "Check the dates and times and try again."
            : "Attendance could not be loaded. Please try again.",
    ),
    { status },
  );
}
const noBody = z.object({}).strict();
const addDays = (day, n) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  };
};
const filters = (q) => ({
  p_search: q.search || null,
  p_role: q.role || null,
  p_account: q.account || null,
});
const page = (q) => ({
  p_status: q.status || null,
  p_page: q.page,
  p_limit: q.limit,
});

export function attendanceRouter(db) {
  const router = Router();
  const self = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args });
  router.get("/me", async (req, res) =>
    res.json(await self(req, "attendance_me")),
  );
  router.post("/check-in", async (req, res) => {
    noBody.parse(req.body || {});
    res
      .status(201)
      .json(await self(req, "attendance_check_in", { p_request: req.id }));
  });
  router.post("/check-out", async (req, res) => {
    noBody.parse(req.body || {});
    res.json(await self(req, "attendance_check_out", { p_request: req.id }));
  });
  router.get("/history", async (req, res) => {
    const q = attendanceRange.parse(req.query);
    res.json(
      await self(req, "attendance_employee", {
        p_user: req.user.id,
        p_from: q.from,
        p_to: q.to,
      }),
    );
  });
  router.get("/summary", async (req, res) => {
    const q = z
      .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .strict()
      .parse(req.query);
    const range = monthRange(q.month);
    const result = await self(req, "attendance_employee", {
      p_user: req.user.id,
      p_from: range.from,
      p_to: range.to,
    });
    res.json({ month: q.month, totals: result.totals });
  });
  router.get("/holidays", async (req, res) => {
    const q = holidayQuery.parse(req.query);
    res.json(await self(req, "attendance_holidays_list", { p_year: q.year }));
  });
  router.get("/leave", async (req, res) => {
    const q = requestListQuery.omit({ user: true }).parse(req.query);
    res.json(
      await self(req, "attendance_leave_page", {
        p_mine: true,
        p_user: null,
        ...page(q),
      }),
    );
  });
  router.post("/leave", sensitiveLimit, async (req, res) => {
    const body = leaveCreate.parse(req.body);
    res.status(201).json(
      await self(req, "attendance_leave_request", {
        p_data: body,
        p_request: req.id,
      }),
    );
  });
  router.post("/leave/:id/cancel", async (req, res) => {
    noBody.parse(req.body || {});
    res.json(
      await self(req, "attendance_leave_cancel", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });
  router.get("/corrections", async (req, res) => {
    const q = requestListQuery.omit({ user: true }).parse(req.query);
    res.json(
      await self(req, "attendance_correction_page", {
        p_mine: true,
        p_user: null,
        ...page(q),
      }),
    );
  });
  router.post("/corrections", sensitiveLimit, async (req, res) => {
    const body = correctionCreate.parse(req.body);
    res.status(201).json(
      await self(req, "attendance_correction_request", {
        p_data: body,
        p_request: req.id,
      }),
    );
  });
  router.post("/corrections/:id/cancel", async (req, res) => {
    noBody.parse(req.body || {});
    res.json(
      await self(req, "attendance_correction_cancel", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });
  return router;
}

// ---------------------------------------------------------------- exports
const pkTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const time = (value) => (value ? pkTime.format(new Date(value)) : "");
const hours = (minutes) =>
  minutes == null ? "" : Math.round((minutes / 60) * 100) / 100;
export const stateLabels = {
  checked_in: "Checked in",
  checked_out: "Checked out",
  incomplete: "Incomplete",
  absent: "Absent",
  not_checked_in: "Not checked in",
  leave: "Approved leave",
  holiday: "Holiday",
  day_off: "Scheduled day off",
  upcoming: "Upcoming",
  not_employed: "Not active",
  not_tracked: "Not tracked",
};
const punctualityLabels = {
  on_time: "On time",
  within_grace: "Within grace",
  late: "Late",
};
const dayCell = (d) =>
  d.punctuality === "late" && ["checked_out", "checked_in"].includes(d.state)
    ? "Late"
    : stateLabels[d.state] || d.state;
function dailySheet(result) {
  return [
    [
      "Employee",
      "UID",
      "Role",
      "Account",
      "Date",
      "Shift start",
      "Shift end",
      "Check-in",
      "Check-out",
      "Worked hours",
      "Late minutes",
      "Punctuality",
      "Early departure minutes",
      "Overtime minutes",
      "Attendance state",
      "Leave",
      "Correction pending",
      "Corrected",
    ],
    ...result.data.map((r) => [
      r.name,
      r.uid ?? "",
      r.role,
      r.account_active ? "Active" : "Inactive",
      r.day,
      (r.shift_start || "").slice(0, 5),
      (r.shift_end || "").slice(0, 5),
      time(r.check_in_at),
      time(r.check_out_at),
      hours(r.worked_minutes),
      r.late_minutes ?? "",
      punctualityLabels[r.punctuality] || "",
      r.early_departure_minutes ?? "",
      r.overtime_minutes ?? "",
      stateLabels[r.state] || r.state,
      r.leave_type || "",
      r.pending_correction ? "Yes" : "No",
      r.corrected ? "Yes" : "No",
    ]),
  ];
}
function periodSheet(result) {
  const dates = result.employees[0]?.days?.map((d) => d.date) || [];
  return [
    [
      "Employee",
      "UID",
      "Role",
      "Account",
      "Scheduled days",
      "Eligible days",
      "Present",
      "Absent",
      "Approved leave",
      "Holidays",
      "On time",
      "Within grace",
      "Late",
      "Incomplete",
      "Worked hours",
      "Average hours per completed day",
      "Early departure minutes",
      "Overtime minutes",
      "Attendance %",
      ...dates,
    ],
    ...result.employees.map((e) => [
      e.name,
      e.uid ?? "",
      e.role,
      e.active ? "Active" : "Inactive",
      e.scheduled_days,
      e.eligible_days,
      e.present_days,
      e.absent_days,
      e.leave_days,
      e.holiday_days,
      e.on_time_days,
      e.within_grace_days,
      e.late_days,
      e.incomplete_days,
      hours(e.worked_minutes),
      e.completed_days ? hours(e.worked_minutes / e.completed_days) : "",
      e.early_departure_minutes,
      e.overtime_minutes,
      e.attendance_percent ?? "",
      ...(e.days || []).map(dayCell),
    ]),
  ];
}
function sendSheet(res, rows, name, format) {
  if (format === "xlsx") {
    // Cells are written as plain values; no formulas are ever created.
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Attendance");
    return res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(name + ".xlsx")
      .send(write(book, { type: "buffer", bookType: "xlsx" }));
  }
  res
    .type("text/csv")
    .attachment(name + ".csv")
    .send(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
}

export function attendanceAdminRouter(db) {
  const router = Router();
  const admin = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args });
  const daily = (req, q, limit = q.limit, pageNo = q.page) =>
    admin(req, "attendance_daily", {
      p_date: q.date,
      ...filters(q),
      p_state: q.state || null,
      p_punctuality: q.punctuality || null,
      p_page: pageNo,
      p_limit: limit,
    });
  const period = (req, q, from, to) =>
    admin(req, "attendance_period", { p_from: from, p_to: to, ...filters(q) });
  router.get("/overview", async (req, res) =>
    res.json(await admin(req, "attendance_overview")),
  );
  router.get("/daily", async (req, res) =>
    res.json(await daily(req, attendanceDailyQuery.parse(req.query))),
  );
  router.get("/weekly", async (req, res) => {
    const q = attendanceWeekQuery.parse(req.query);
    res.json(await period(req, q, q.week_start, addDays(q.week_start, 6)));
  });
  router.get("/monthly", async (req, res) => {
    const q = attendanceMonthQuery.parse(req.query);
    const range = monthRange(q.month);
    res.json(await period(req, q, range.from, range.to));
  });
  router.get("/employees", async (req, res) =>
    res.json(await admin(req, "attendance_employees")),
  );
  router.get("/employees/:id", async (req, res) => {
    const q = attendanceRange.parse(req.query);
    res.json(
      await admin(req, "attendance_employee", {
        p_user: uuid.parse(req.params.id),
        p_from: q.from,
        p_to: q.to,
      }),
    );
  });
  router.get("/leave", async (req, res) => {
    const q = requestListQuery.parse(req.query);
    res.json(
      await admin(req, "attendance_leave_page", {
        p_mine: false,
        p_user: q.user || null,
        ...page(q),
      }),
    );
  });
  router.post("/leave/:id/review", sensitiveLimit, async (req, res) => {
    const body = requestReview.parse(req.body);
    res.json(
      await admin(req, "attendance_leave_review", {
        p_id: uuid.parse(req.params.id),
        p_decision: body.decision,
        p_note: body.note || null,
        p_request: req.id,
      }),
    );
  });
  router.get("/corrections", async (req, res) => {
    const q = requestListQuery.parse(req.query);
    res.json(
      await admin(req, "attendance_correction_page", {
        p_mine: false,
        p_user: q.user || null,
        ...page(q),
      }),
    );
  });
  router.post("/corrections/:id/review", sensitiveLimit, async (req, res) => {
    const body = requestReview.parse(req.body);
    res.json(
      await admin(req, "attendance_correction_review", {
        p_id: uuid.parse(req.params.id),
        p_decision: body.decision,
        p_note: body.note || null,
        p_request: req.id,
      }),
    );
  });
  router.get("/settings", async (req, res) =>
    res.json(await admin(req, "attendance_policies_list")),
  );
  router.patch("/settings", sensitiveLimit, async (req, res) => {
    const body = attendancePolicy.parse(req.body);
    res.json(
      await admin(req, "attendance_policy_save", {
        p_data: body,
        p_request: req.id,
      }),
    );
  });
  router.get("/holidays", async (req, res) => {
    const q = holidayQuery.parse(req.query);
    res.json(await admin(req, "attendance_holidays_list", { p_year: q.year }));
  });
  router.post("/holidays", sensitiveLimit, async (req, res) => {
    const body = holidayCreate.parse(req.body);
    res.status(201).json(
      await admin(req, "attendance_holiday_save", {
        p_data: body,
        p_request: req.id,
      }),
    );
  });
  router.delete("/holidays/:id", sensitiveLimit, async (req, res) => {
    res.json(
      await admin(req, "attendance_holiday_delete", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });
  router.get("/export", sensitiveLimit, async (req, res) => {
    const q = attendanceExportQuery.parse(req.query);
    if (q.type === "daily") {
      const result = await daily(req, q, 1000, 1);
      return sendSheet(
        res,
        dailySheet(result),
        `hd-attendance-${q.date}`,
        q.format,
      );
    }
    const range =
      q.type === "weekly"
        ? { from: q.week_start, to: addDays(q.week_start, 6) }
        : monthRange(q.month);
    const result = await period(req, q, range.from, range.to);
    sendSheet(
      res,
      periodSheet(result),
      `hd-attendance-${q.type === "weekly" ? "week-" + q.week_start : q.month}`,
      q.format,
    );
  });
  return router;
}
