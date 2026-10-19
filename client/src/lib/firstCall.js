// First-call deadlines (update 038), shown in Pakistan time.
const dueFormatter = new Intl.DateTimeFormat("en-PK", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Karachi",
});
export const dueLabel = (value) =>
  value ? dueFormatter.format(new Date(value)) : "—";
export function lateBy(value, now = Date.now()) {
  const hours = Math.floor((now - Date.parse(value)) / 3600000);
  if (!value || Number.isNaN(hours) || hours < 1) return "Under 1 hour late";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} late`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} late`;
}
export function idleFor(value, now = Date.now()) {
  const days = Math.floor((now - Date.parse(value)) / 86400000);
  return Number.isNaN(days) ? "—" : `${days} day${days === 1 ? "" : "s"}`;
}
// Badge state for a lead row: called, waiting with a deadline, or missed.
export function firstCallState(lead, now = Date.now()) {
  if (lead.first_call_at) return { tone: "completed", label: "Called" };
  if (
    !lead.assigned_agent ||
    !lead.call_due_at ||
    ["won", "lost"].includes(lead.status)
  )
    return null;
  return Date.parse(lead.call_due_at) < now
    ? { tone: "overdue", label: "Missed first call" }
    : { tone: "warning", label: `Call by ${dueLabel(lead.call_due_at)}` };
}
export const weekdays = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];
