// Account roles (update 047 adds staff). The server decides what each role
// may do; these only label and route.
export const roleLabels = { admin: "Admin", agent: "Agent", staff: "Staff" };
export const roleLabel = (role) => roleLabels[role] || role || "—";
// Agents and staff both have daily tasks, reports and checkout requests.
export const hasDailyTasks = (role) => role === "agent" || role === "staff";
const weekdays = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function workDaysText(days) {
  const list = [...new Set(Array.isArray(days) ? days : [])]
    .map(Number)
    .filter((d) => d >= 1 && d <= 7)
    .sort();
  if (!list.length) return "—";
  const consecutive = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  return consecutive && list.length > 2
    ? `${weekdays[list[0]]}–${weekdays[list.at(-1)]}`
    : list.map((d) => weekdays[d]).join(", ");
}
export const weekdayOptions = weekdays
  .slice(1)
  .map((label, i) => ({ value: i + 1, label }));
