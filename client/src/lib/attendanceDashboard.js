import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { weekdayNames } from "./attendance";
import { addDays, startOfMonth, startOfWeek, todayPk } from "./calendar";
// Data for the Attendance Command Center. Every figure comes from the
// existing attendance API; these helpers only group it for display. Query
// keys match the report tabs so their caches are shared.
const get =
  (path) =>
  ({ signal }) =>
    api(path, { signal });
export const useAttendanceOverview = () =>
  useQuery({
    queryKey: ["attendance-admin", "overview"],
    queryFn: get("/admin/attendance/overview"),
    refetchInterval: 120000,
  });
export const useAttendancePolicy = () =>
  useQuery({
    queryKey: ["attendance-admin", "settings"],
    queryFn: get("/admin/attendance/settings"),
    staleTime: 300000,
  });
// Up to 100 employees per request; the dashboard pages through them locally.
export const registerLimit = 100;
export function useRegister(filters) {
  const params = { ...filters, limit: registerLimit };
  return useQuery({
    queryKey: ["attendance-admin", "daily", params, 1],
    queryFn: get(
      "/admin/attendance/daily?" + new URLSearchParams({ ...params, page: 1 }),
    ),
  });
}
export const useWeekReport = (weekStart) =>
  useQuery({
    queryKey: ["attendance-admin", "weekly", { week_start: weekStart }],
    queryFn: get(
      "/admin/attendance/weekly?" +
        new URLSearchParams({ week_start: weekStart }),
    ),
  });
export const useMonthReport = (month) =>
  useQuery({
    queryKey: ["attendance-admin", "monthly", { month }],
    queryFn: get("/admin/attendance/monthly?" + new URLSearchParams({ month })),
  });
export const currentWeekStart = () => startOfWeek(todayPk());
export const currentMonth = () => startOfMonth(todayPk()).slice(0, 7);

// Today's mutually exclusive states from the overview. "Expected" means
// scheduled to work today and not on approved leave; punctuality is a
// separate dimension and is never added to these totals.
export function todaySummary(overview) {
  const s = overview?.states || {},
    p = overview?.punctuality || {};
  const n = (key) => Number(s[key] || 0);
  const working = n("checked_in"),
    completed = n("checked_out"),
    waiting = n("not_checked_in"),
    absent = n("absent"),
    incomplete = n("incomplete"),
    leave = n("leave");
  const expected = working + completed + waiting + absent + incomplete;
  return {
    expected,
    working,
    completed,
    waiting,
    absent,
    incomplete,
    leave,
    recorded: working + completed,
    scheduled: expected + leave,
    late: Number(p.late || 0),
    withinGrace: Number(p.within_grace || 0),
    onTime: Number(p.on_time || 0),
  };
}
// "Monday–Saturday" for consecutive days, otherwise a short list.
const longDay = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
export function workDayRange(days = []) {
  const sorted = [...days].sort((a, b) => a - b);
  if (!sorted.length) return "No working days";
  const consecutive = sorted.every(
    (d, i) => i === 0 || d === sorted[i - 1] + 1,
  );
  if (consecutive && sorted.length > 2)
    return `${longDay[sorted[0]]}–${longDay[sorted.at(-1)]}`;
  return weekdayNames
    .filter(([n]) => sorted.includes(n))
    .map(([, label]) => label)
    .join(", ");
}
const isoWeekday = (day) => {
  const d = new Date(day + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
};
// One entry per day of a report's trend, labelled as a working day, day off
// or upcoming day. Missing days are never filled with invented numbers.
export function weekSeries(trend = [], workDays = [], today = todayPk()) {
  return trend.map((t) => ({
    ...t,
    dayOff: workDays.length > 0 && !workDays.includes(isoWeekday(t.date)),
    upcoming: t.date > today,
    total: t.present + t.absent + t.leave + t.incomplete,
  }));
}
// Team totals for the month: sums of the server's per-employee totals.
// The team percentage applies the server's own formula (present ÷ eligible)
// to those sums.
export function monthTotals(employees = []) {
  const sum = (key) =>
    employees.reduce((total, e) => total + Number(e[key] || 0), 0);
  const present = sum("present_days"),
    eligible = sum("eligible_days");
  return {
    present,
    eligible,
    absent: sum("absent_days"),
    leave: sum("leave_days"),
    late: sum("late_days"),
    incomplete: sum("incomplete_days"),
    worked: sum("worked_minutes"),
    percent: eligible ? Math.round((present * 1000) / eligible) / 10 : null,
  };
}
// Monday-first calendar grid for a month, padded with blanks.
export function monthGrid(month, trend = []) {
  const first = `${month}-01`;
  const byDate = Object.fromEntries(trend.map((t) => [t.date, t]));
  const lead = isoWeekday(first) - 1;
  const cells = Array.from({ length: lead }, (_, i) => ({ key: "lead" + i }));
  for (let day = first; day.startsWith(month); day = addDays(day, 1))
    cells.push({ key: day, date: day, ...(byDate[day] || {}) });
  return cells;
}
