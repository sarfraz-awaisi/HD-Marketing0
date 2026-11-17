import { addDays, startOfMonth, startOfWeek, todayPk } from "./calendar";
// Daily KPI report periods (update 070), in Pakistan days. KPI weeks run
// Monday to Sunday, as the weekly targets do (the Reports page's weeks start
// on Sunday).
export const kpiPeriods = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This week"],
  ["last_week", "Last week"],
  ["this_month", "This month"],
  ["custom", "Custom range"],
];
export function kpiRange(period, today = todayPk()) {
  const monday = startOfWeek(today);
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week":
      return { from: monday, to: today };
    case "last_week":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "this_month":
      return { from: startOfMonth(today), to: today };
    default:
      return null;
  }
}
// What a stored answer reads as.
export const answerText = (type, value) =>
  value === null || value === undefined
    ? ""
    : type === "yes_no"
      ? value
        ? "Yes"
        : "No"
      : String(value);
export const dayStates = {
  answered: "Answered",
  missed: "Missed",
  pending: "Pending",
  upcoming: "Upcoming",
  day_off: "Day off",
  holiday: "Holiday",
  leave: "Leave",
  not_employed: "—",
};
export const weekStates = {
  met: "Met",
  missed: "Missed",
  in_progress: "In progress",
};
