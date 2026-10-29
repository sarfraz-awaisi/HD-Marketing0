// Daily tasks (update 045): labels and helpers shared by My tasks, Task
// management and My attendance. The server calculates every percentage.
export const taskPriorities = [
  ["urgent", "Urgent"],
  ["high", "High"],
  ["normal", "Normal"],
  ["low", "Low"],
];
export const taskCategories = [
  ["calls", "Calls"],
  ["follow_ups", "Follow-ups"],
  ["site_visits", "Site visits"],
  ["listings", "Property listings"],
  ["meetings", "Meetings"],
  ["documents", "Documents"],
  // Update 047: office staff.
  ["media", "Media and content"],
  ["technical", "Technical and IT"],
  ["operations", "Office and operations"],
  ["other", "Other"],
];
// Who a task was assigned to (update 047), as kept with the task.
export function audienceText(audience) {
  if (!audience || typeof audience !== "object") return "";
  return [
    audience.all_agents && "All agents",
    audience.all_staff && "All staff",
    ...(Array.isArray(audience.departments)
      ? audience.departments.map((d) => `${d} team`)
      : []),
    audience.people &&
      `${audience.people} chosen ${audience.people === 1 ? "person" : "people"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
export const taskStatuses = {
  pending: ["Pending", ""],
  in_progress: ["In progress", "warning"],
  completed: ["Completed", "completed"],
  cancelled: ["Cancelled", "lost"],
};
export const verifiedLabels = {
  confirmed: "Verified",
  adjusted: "Verified (adjusted)",
  not_done: "Verified: not done",
};
const labelOf = (list, value) =>
  list.find(([key]) => key === value)?.[1] || value || "—";
export const priorityLabel = (value) => labelOf(taskPriorities, value);
export const categoryLabel = (value) => labelOf(taskCategories, value);
export const statusLabel = (value) => taskStatuses[value]?.[0] || value;
export const statusTone = (value) => taskStatuses[value]?.[1] || "";
export const percent = (value) =>
  value == null ? "—" : `${Number(value).toLocaleString("en-PK")}%`;
// "40 of 50 calls" or the status for a simple task.
export function progressText(task) {
  if (task.kind !== "measurable") return statusLabel(task.status);
  const extra = task.excess_quantity
    ? ` (+${task.excess_quantity} over target)`
    : "";
  return `${task.completed_quantity} of ${task.target_quantity} ${task.unit}${extra}`;
}
export const taskKeys = [
  "my-tasks",
  "task-checkout",
  "admin-tasks",
  "admin-task",
  "task-overview",
  "task-reports",
  "task-report",
  "checkout-requests",
  "task-performance",
  "task-settings",
  "attendance-me",
  "notifications",
];
export const invalidateTasks = (client) =>
  client.invalidateQueries({
    predicate: (query) => taskKeys.includes(query.queryKey[0]),
  });
