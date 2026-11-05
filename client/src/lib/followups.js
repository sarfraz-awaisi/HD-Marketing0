// A follow-up's state as people think of it: a pending follow-up is overdue,
// due within the next 24 hours, or upcoming.
export function followUpState(followUp, now = Date.now()) {
  if (followUp.status !== "pending") return followUp.status;
  const due = Date.parse(followUp.due_at);
  if (due < now) return "overdue";
  return due <= now + 86400000 ? "due" : "upcoming";
}
const labels = {
  overdue: "Overdue",
  due: "Due within 24 hours",
  upcoming: "Upcoming",
  completed: "Completed",
  cancelled: "Cancelled",
};
export const followUpStateLabel = (state) => labels[state] || state;
// The Follow-ups page filters, with the server's view for each.
export const followUpViews = [
  ["pending", "Pending (soonest first)"],
  ["overdue", "Overdue"],
  ["due", "Due within 24 hours"],
  ["upcoming", "Upcoming"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
  ["", "All follow-ups"],
];
