import { clockLabel } from "./attendance";
import { workDaysText } from "./roles";
// Office timings (update 048). Each employee follows, highest first, their
// own shift, their department's, their role's (agents or staff) or the
// company default; the server says which as source and source_label.
export const shiftSources = [
  ["individual", "Individual shift"],
  ["department", "Department shift"],
  ["role", "Role default shift"],
  ["company", "Company default shift"],
];
// "Media department shift"; update 047 called an employee's own shift
// "assigned".
export function sourceLabel(s) {
  if (!s) return "—";
  if (s.source_label) return s.source_label;
  if (s.source === "assigned" || s.source === "individual")
    return "Individual shift";
  return s.source === "company" ? "Company default shift" : "—";
}
// What employees see: "Media department", "Individual schedule".
export function scheduleName(s) {
  if (!s) return "—";
  if (s.source === "individual" || s.source === "assigned")
    return "Individual schedule";
  if (s.source === "company") return "Company default";
  return sourceLabel(s).replace(/ shift$/, "");
}
export const shiftHours = (s) =>
  s?.shift_start
    ? `${clockLabel(s.shift_start)} – ${clockLabel(s.shift_end)}`
    : "—";
// "12:00 PM – 8:00 PM, Mon–Sat, 15 min grace".
export const shiftLine = (s) =>
  s?.shift_start
    ? `${shiftHours(s)}, ${workDaysText(s.work_days)}, ${s.grace_minutes} min grace`
    : "—";
// "Media department shift: 12:00 PM – 8:00 PM, Mon–Sat, 15 min grace". An
// employee's own shift shows the name it was given.
export const shiftText = (s) =>
  s?.shift_start
    ? `${(s.source === "individual" || s.source === "assigned") && s.label ? s.label : sourceLabel(s)}: ${shiftLine(s)}`
    : s?.source
      ? sourceLabel(s)
      : "—";
export const sameDayShift = (start, end) =>
  Boolean(start && end && end > start);
export const minutesBetween = (start, end) => {
  const [a, b] = [start, end].map((t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  });
  return b - a;
};
// Checks a timing before it is sent; the server checks it again.
export function timingProblem(form) {
  if (!sameDayShift(form.shift_start, form.shift_end))
    return "The shift must end after it starts, on the same day. Overnight shifts are not supported.";
  if (!form.work_days.length) return "Choose at least one working day.";
  const grace = Number(form.grace_minutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120)
    return "Choose a grace period of 0 to 120 minutes.";
  if (grace >= minutesBetween(form.shift_start, form.shift_end))
    return "The grace period must be shorter than the shift.";
  return "";
}
