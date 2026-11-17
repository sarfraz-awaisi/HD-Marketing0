// Team performance (update 071): the eight columns, as the table and its
// export show them. The database counts every number; this only chooses
// the rows (all agents or one, and the name search) and adds them up.
export const teamColumns = [
  ["received", "Leads received"],
  ["received_first_time", "New"],
  ["received_reassigned", "From another agent"],
  ["moved_away", "Moved away"],
  ["calls", "Total calls"],
  ["followup_leads", "Follow-ups"],
];
// Worked minutes as "7h 45m".
export const workTime = (minutes) =>
  `${Math.floor((minutes || 0) / 60)}h ${(minutes || 0) % 60}m`;
export function teamRows(report, { agent, search } = {}) {
  const words = (search || "").trim().toLowerCase();
  return (report?.agents || []).filter(
    (a) =>
      (!agent || a.agent_id === agent) &&
      (!words || (a.name || "").toLowerCase().includes(words)),
  );
}
// The rows shown, added up: a lead two agents each received counts for both.
export function teamTotal(rows) {
  const total = {};
  for (const key of [
    ...teamColumns.map(([k]) => k),
    "worked_minutes",
    "open_days",
    "incomplete_days",
  ])
    total[key] = rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return total;
}
export function teamCsv(report, filters) {
  const rows = teamRows(report, filters);
  // An agent whose attendance is not tracked has no time, not "0h 0m".
  const line = (name, status, r, tracked = true) => [
    name,
    status,
    ...teamColumns.map(([k]) => r[k] ?? 0),
    tracked ? workTime(r.worked_minutes) : "Not tracked",
    tracked ? (r.worked_minutes ?? 0) : "",
    (r.open_days ?? 0) + (r.incomplete_days ?? 0),
  ];
  return [
    [
      "Agent",
      "Status",
      ...teamColumns.map(([, label]) => label),
      "Time",
      "Time (minutes)",
      "Days without checkout",
    ],
    ...rows.map((r) =>
      line(
        r.name,
        r.active ? "Active" : "Inactive",
        r,
        r.attendance_tracked !== false,
      ),
    ),
    line("All agents shown", "", teamTotal(rows)),
  ];
}
