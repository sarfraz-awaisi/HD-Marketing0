import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
// Attendance labels and formatting (update 040). All figures come from the
// server; these helpers only present them in Pakistan time.
export const stateInfo = {
  checked_in: ["Checked in", "warning"],
  checked_out: ["Checked out", "completed"],
  incomplete: ["Incomplete", "overdue"],
  absent: ["Absent", "overdue"],
  not_checked_in: ["Not checked in", ""],
  leave: ["Approved leave", "info"],
  holiday: ["Holiday", "info"],
  day_off: ["Scheduled day off", ""],
  upcoming: ["Upcoming", ""],
  not_employed: ["Not active", ""],
  not_tracked: ["Not tracked", ""],
};
export const punctualityInfo = {
  on_time: ["On time", "completed"],
  within_grace: ["Within grace", "warning"],
  late: ["Late", "overdue"],
};
export const stateLabel = (state) => stateInfo[state]?.[0] || state || "—";
export const punctualityLabel = (value) => punctualityInfo[value]?.[0] || "—";
export const leaveTypes = [
  ["casual", "Casual leave"],
  ["sick", "Sick leave"],
  ["emergency", "Emergency leave"],
  ["unpaid", "Unpaid leave"],
  ["other", "Other"],
];
export const leaveTypeLabel = (value) =>
  leaveTypes.find(([key]) => key === value)?.[1] || value;
export const correctionTypes = [
  ["missing_check_in", "Missing check-in"],
  ["missing_check_out", "Missing check-out"],
  ["incorrect_check_in", "Incorrect check-in"],
  ["incorrect_check_out", "Incorrect check-out"],
];
export const correctionTypeLabel = (value) =>
  correctionTypes.find(([key]) => key === value)?.[1] || value;
export const requestStatusInfo = {
  pending: ["Pending", "warning"],
  approved: ["Approved", "completed"],
  rejected: ["Not approved", "overdue"],
  cancelled: ["Cancelled", ""],
};
const timeFormatter = new Intl.DateTimeFormat("en-PK", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Karachi",
});
export const pkTime = (value) =>
  value
    ? timeFormatter
        .format(new Date(value))
        .replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())
    : "—";
// "10:00" (a shift time) as "10:00 AM".
export function clockLabel(value) {
  if (!value) return "—";
  const [h, m] = value.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function minutesLabel(value) {
  if (value == null) return "—";
  const total = Math.max(0, Math.round(value));
  const h = Math.floor(total / 60),
    m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
export const percentLabel = (value) =>
  value == null ? "—" : `${Number(value).toLocaleString("en-PK")}%`;
export const weekdayNames = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];
export const workDaysLabel = (days = []) =>
  weekdayNames
    .filter(([n]) => days.includes(n))
    .map(([, label]) => label)
    .join(", ");
// A Pakistan date plus "HH:MM" as an ISO moment with the +05:00 offset.
export const pkMoment = (day, time) =>
  day && time ? `${day}T${time}:00+05:00` : undefined;
export const useMyAttendance = () =>
  useQuery({
    queryKey: ["attendance-me"],
    queryFn: ({ signal }) => api("/attendance/me", { signal }),
    refetchInterval: 300000,
  });
export const attendanceKeys = [
  "attendance-me",
  "attendance-history",
  "attendance-leave",
  "attendance-corrections",
  "attendance-admin",
];
export const invalidateAttendance = (client) =>
  client.invalidateQueries({
    predicate: (query) => attendanceKeys.includes(query.queryKey[0]),
  });
