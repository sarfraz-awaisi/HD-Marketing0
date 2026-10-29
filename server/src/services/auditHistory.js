// Plain-English audit history (update 043). Each audit entry becomes a title,
// a description, who acted, who or what was affected and what changed, using
// only what the entry recorded: nothing is guessed. The original values stay
// available as technical details, with anything secret or personal removed.
import { buildingCategories } from "../utils/validators.js";

export const auditModules = [
  ["leads", "Leads"],
  ["calls", "Calls"],
  ["activities", "Follow-ups, visits and deals"],
  ["targets", "Targets"],
  ["properties", "Properties"],
  ["documents", "Documents"],
  ["accounts", "Employee accounts"],
  ["security", "Sign-in and security"],
  ["attendance", "Attendance"],
  ["settings", "Settings"],
  ["integrations", "Facebook leads"],
  ["system", "Automatic CRM tasks"],
  ["tasks", "Tasks and daily reports"],
];
export const auditKinds = [
  ["create", "Added or created"],
  ["update", "Changed"],
  ["delete", "Removed or deleted"],
  ["assign", "Assigned"],
  ["import", "Imported"],
  ["view", "Viewed or downloaded"],
  ["request", "Requested"],
  ["review", "Approved or rejected"],
  ["security", "Security"],
  ["automatic", "Automatic"],
];

// ------------------------------------------------------------ wording helpers
const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Karachi",
});
// "2026-10-22" as "October 22, 2026"; anything else is not a date.
export const dayText = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) &&
  !Number.isNaN(Date.parse(value + "T00:00:00Z"))
    ? dayFormat.format(new Date(value + "T00:00:00Z"))
    : null;
const timeText = (value) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? timeFormat.format(at) : null;
};
const words = (value) => String(value ?? "").replaceAll("_", " ");
const sentence = (value) => {
  const text = words(value).replaceAll(".", " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Recorded activity";
};
const listText = (items) =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const minutesText = (value) => {
  const n = number(value);
  if (n == null) return null;
  const h = Math.floor(n / 60),
    m = n % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
};
const fieldLabels = {
  active: "access (enabled or disabled)",
  area_unit: "area unit",
  assigned_agent: "assigned agent",
  availability: "availability status",
  budget_max: "maximum budget",
  budget_min: "minimum budget",
  close_date: "close date",
  due_at: "due date",
  ended_at: "end time",
  expected_updated_at: null,
  first_call_grace_minutes: "first-call grace period",
  idle_days: "idle-lead days",
  lost_reason: "lost reason",
  owner_agent_id: "owner",
  preferred_location: "preferred location",
  property_id: "linked property",
  scheduled_at: "visit time",
  started_at: "start time",
  type: "type",
  uid: "UID",
  work_days: "working days",
  work_end: "end of the working day",
  work_start: "start of the working day",
  due_on: "due date",
  target_quantity: "target",
  building_categories: "building categories",
};
// ["price","availability"] as "price and availability status".
export function fieldsText(fields) {
  if (!Array.isArray(fields)) return null;
  const labels = fields
    .filter((f) => typeof f === "string")
    .map((f) => (f in fieldLabels ? fieldLabels[f] : words(f)))
    .filter(Boolean);
  if (!labels.length) return null;
  return labels.length > 8
    ? `${labels.slice(0, 7).join(", ")} and ${labels.length - 7} more`
    : listText(labels);
}
const leadStatuses = {
  new: "New",
  contacted: "Contacted",
  interested: "Interested",
  visit_scheduled: "Visit scheduled",
  visit_done: "Visit done",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};
const leaveTypes = {
  casual: "casual",
  sick: "sick",
  emergency: "emergency",
  unpaid: "unpaid",
  other: "other",
};
const roleLabel = (role) =>
  role === "admin" ? "Admin" : role === "agent" ? "Agent" : sentence(role);
const propertyRef = (no) =>
  number(no) != null ? "PR-" + String(no).padStart(6, "0") : null;

// One attendance snapshot (before or after a change) in words.
export function attendanceText(s) {
  if (!s || typeof s !== "object") return null;
  const times = s.check_in_at
    ? ` (${timeText(s.check_in_at)}${s.check_out_at ? ` – ${timeText(s.check_out_at)}` : ""})`
    : "";
  switch (s.state) {
    case "checked_out":
      return (s.punctuality === "late" ? "Late" : "Present") + times;
    case "checked_in":
      return "Checked in" + times;
    case "incomplete":
      return "Incomplete, no check-out" + times;
    case "absent":
      return "Absent";
    case "leave":
      return s.leave_type
        ? `On ${leaveTypes[s.leave_type] || words(s.leave_type)} leave`
        : "On leave";
    case "not_counted":
      return "Not counted";
    default:
      return s.state ? sentence(s.state) : null;
  }
}

// --------------------------------------------------------------- redaction
// Keys whose values are never shown, by any part of their name.
const secretParts = new Set([
  "password",
  "pass",
  "token",
  "secret",
  "otp",
  "pin",
  "hash",
  "cookie",
  "session",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "key",
  "apikey",
  "ciphertext",
]);
const personalParts = new Set(["phone", "phones", "email", "emails", "mobile"]);
const looksSecret =
  /^(eyJ[\w-]+\.[\w-]+|sb_(secret|publishable)_|-----BEGIN|Bearer\s)|^[A-Za-z0-9+/_-]{48,}={0,2}$/;
export function sanitizeMetadata(value, depth = 0) {
  if (depth > 6) return "[…]";
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, v]) => {
          const parts = key.toLowerCase().split(/[_\-\s.]+/);
          const hidden =
            parts.some((p) => secretParts.has(p)) ||
            (parts.some((p) => personalParts.has(p)) &&
              (typeof v === "string" || Array.isArray(v))) ||
            (parts.includes("code") && /^\d{4,8}$/.test(String(v)));
          return [key, hidden ? "[hidden]" : sanitizeMetadata(v, depth + 1)];
        }),
    );
  if (typeof value === "string")
    return looksSecret.test(value)
      ? "[hidden]"
      : value.length > 300
        ? value.slice(0, 300) + "…"
        : value;
  return value;
}

// ------------------------------------------------------------------ catalog
// c: { m (metadata), actor, affected, agent, lead, property, document,
// import, entityId, self (the actor is the employee affected) }.
const person = (p) =>
  p ? `${p.name}${p.deleted ? " (deleted account)" : ""}` : null;
const who = (c, fallback = "an employee") => person(c.affected) || fallback;
const whose = (c) => (c.affected ? `${person(c.affected)}'s` : "an employee's");
const leadRef = (c) =>
  c.lead
    ? `lead ${c.lead.number}${c.lead.deleted ? " (in Deleted leads)" : ""}`
    : "a lead";
const agentText = (c) => person(c.agent) || "an agent";
const propertyText = (c) =>
  c.property
    ? `“${c.property.title}” (${propertyRef(c.property.number) || "property"})`
    : "a property that has since been deleted";
const documentText = (c) => {
  const title = c.document?.title || c.m.title;
  return title ? `the document “${title}”` : "a document";
};
const fileText = (c) =>
  c.import
    ? `the file “${c.import.file_name}”${c.import.deleted ? " (deleted)" : ""}`
    : "an import file";
const changed = (c, prefix) => {
  const fields = fieldsText(c.m.fields);
  return fields ? `${prefix}: ${fields}.` : `${prefix}.`;
};
// Building categories (update 046), labelled and in the standard order.
const categoryLabels = new Map(
  buildingCategories.map((c) => [c.value, c.label]),
);
const categoriesOf = (list) => {
  const chosen = new Set(Array.isArray(list) ? list : []);
  return buildingCategories
    .filter((c) => chosen.has(c.value))
    .map((c) => categoryLabels.get(c.value));
};
function categoryChange(m) {
  const before = new Set(categoriesOf(m.building_categories?.before)),
    after = new Set(categoriesOf(m.building_categories?.after));
  const added = [...after].filter((l) => !before.has(l)),
    removed = [...before].filter((l) => !after.has(l));
  return [
    added.length && `Added ${listText(added)}.`,
    removed.length && `Removed ${listText(removed)}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
// Property saves from update 046 record the fields that actually changed;
// older entries name the fields that were sent.
const propertyUpdated = (c) => {
  if (!Array.isArray(c.m.changed))
    return changed(c, `Updated ${propertyText(c)}`);
  if (!c.m.changed.length) return `Saved ${propertyText(c)} without changes.`;
  const text = changed(
    { m: { fields: c.m.changed } },
    `Updated ${propertyText(c)}`,
  );
  const categories = categoryChange(c.m);
  return categories ? `${text} ${categories}` : text;
};
const counts = (c, keys) =>
  keys
    .filter(([key]) => number(c.m[key]) != null && c.m[key] > 0)
    .map(([key, one, many]) => count(c.m[key], one, many));
const withCounts = (text, parts) =>
  parts.length ? `${text} (${listText(parts)}).` : `${text}.`;
const dateOf = (c, key = "date") => dayText(c.m[key]);
const range = (c) => {
  const from = dayText(c.m.start_date),
    to = dayText(c.m.end_date);
  return from && to && from !== to
    ? `from ${from} to ${to}`
    : from
      ? `on ${from}`
      : "";
};
const leaveText = (c) =>
  c.m.leave_type
    ? `${leaveTypes[c.m.leave_type] || words(c.m.leave_type)} `
    : "";

const catalog = [];
// add(action, entity, module, kind, title, describe, options)
function add(action, entity, module, kind, title, describe, options = {}) {
  catalog.push({ action, entity, module, kind, title, describe, ...options });
}
const generic = (entity, module, created, updated, what) => {
  add("create", entity, module, "create", created, (c) =>
    `${created} ${what(c)}.`.replace(" .", "."),
  );
  add("update", entity, module, "update", updated, (c) =>
    changed(c, `${updated} ${what(c)}`.trim()),
  );
};

// Leads
add(
  "create",
  "leads",
  "leads",
  "create",
  "Created a lead",
  (c) => `Created ${leadRef(c)}.`,
);
add("update", "leads", "leads", "update", "Updated a lead", (c) =>
  changed(c, `Updated ${leadRef(c)}`),
);
add("assign", "leads", "leads", "assign", "Assigned a lead", (c) =>
  "agent_id" in c.m && c.m.agent_id == null
    ? `Removed the agent from ${leadRef(c)}.`
    : `Assigned ${leadRef(c)} to ${agentText(c)}.`,
);
add(
  "status_change",
  "leads",
  "leads",
  "update",
  "Changed a lead's status",
  (c) =>
    c.m.from_status && c.m.to_status
      ? `Moved ${leadRef(c)} from ${leadStatuses[c.m.from_status] || words(c.m.from_status)} to ${leadStatuses[c.m.to_status] || words(c.m.to_status)}.`
      : `Changed the status of ${leadRef(c)}.`,
);
add("import", "lead_imports", "leads", "import", "Imported leads", (c) => {
  const added = number(c.m.imported_count),
    rejected = number(c.m.rejected_count);
  return `Imported ${added != null ? count(added, "lead") : "leads"} from ${fileText(c)}${rejected ? `; ${count(rejected, "row")} could not be imported` : ""}.`;
});
add(
  "assign_file",
  "lead_imports",
  "leads",
  "assign",
  "Assigned imported leads",
  (c) =>
    number(c.m.assigned_count) != null
      ? `Assigned ${c.m.assigned_count}${number(c.m.lead_count) != null ? ` of ${c.m.lead_count}` : ""} leads from ${fileText(c)} to ${agentText(c)}.`
      : `Assigned the leads from ${fileText(c)} to ${agentText(c)}.`,
);
add(
  "lead.bulk_assigned",
  "leads",
  "leads",
  "assign",
  "Assigned leads in bulk",
  (c) =>
    withCounts(
      "Assigned several leads in one action",
      counts(c, [
        ["assigned", "lead assigned", "leads assigned"],
        ["skipped", "skipped", "skipped"],
        ["failed", "failed", "failed"],
      ]),
    ),
);
add("lead.bulk_deleted", "leads", "leads", "delete", "Deleted leads", (c) =>
  withCounts(
    "Moved leads to Deleted leads, where they can be restored for a limited time",
    counts(c, [
      ["deleted", "lead moved", "leads moved"],
      ["failed", "failed", "failed"],
    ]),
  ),
);
add(
  "lead.bulk_restored",
  "leads",
  "leads",
  "update",
  "Restored deleted leads",
  (c) =>
    withCounts(
      "Restored leads from Deleted leads",
      counts(c, [
        ["restored", "lead restored", "leads restored"],
        ["failed", "failed", "failed"],
      ]),
    ),
);
add(
  "lead.file_deleted",
  "lead_imports",
  "leads",
  "delete",
  "Deleted an imported file's leads",
  (c) =>
    withCounts(
      `Moved the leads from ${fileText(c)} to Deleted leads`,
      counts(c, [
        ["deleted", "lead moved", "leads moved"],
        ["kept_leads", "lead kept", "leads kept"],
        ["failed", "failed", "failed"],
      ]),
    ),
);
add(
  "lead.file_restored",
  "lead_imports",
  "leads",
  "update",
  "Restored an imported file's leads",
  (c) =>
    withCounts(
      `Restored the leads from ${fileText(c)}`,
      counts(c, [["restored", "lead restored", "leads restored"]]),
    ),
);
add(
  "lead.purged",
  "leads",
  "system",
  "automatic",
  "Permanently removed old deleted leads",
  (c) =>
    number(c.m.purged) != null
      ? `Permanently removed ${count(c.m.purged, "lead")} whose recovery period in Deleted leads had ended.`
      : "Permanently removed leads whose recovery period in Deleted leads had ended.",
  { system: true },
);
add(
  "lead.phone_changed",
  "leads",
  "leads",
  "update",
  "Changed a lead's phone number",
  (c) => `Changed the phone number of ${leadRef(c)}.`,
);
add(
  "lead.phone_revealed",
  "leads",
  "leads",
  "view",
  "Viewed a lead's phone number",
  (c) => `Viewed the phone number of ${leadRef(c)}.`,
);
add(
  "lead.review_kept",
  "leads",
  "leads",
  "review",
  "Kept a lead with its agent",
  (c) => `Reviewed ${leadRef(c)} and kept it with ${agentText(c)}.`,
);
add(
  "pipeline_backfill",
  "leads",
  "system",
  "automatic",
  "Filled in lead pipeline details",
  () => "Filled in lead pipeline details during a CRM update.",
  { system: true },
);
add(
  "pipeline_backfill",
  "deals",
  "system",
  "automatic",
  "Filled in deal pipeline details",
  () => "Filled in deal pipeline details during a CRM update.",
  { system: true },
);

// Calls
add(
  "create",
  "calls",
  "calls",
  "create",
  "Started a call",
  (c) => `Started a call with ${leadRef(c)}.`,
);
add("update", "calls", "calls", "update", "Updated a call record", (c) =>
  changed(c, `Updated a call with ${leadRef(c)}`),
);
add(
  "playback",
  "calls",
  "calls",
  "view",
  "Played a call recording",
  (c) => `Played the recording of a call with ${leadRef(c)}.`,
);
add(
  "call.manual_logged",
  "calls",
  "calls",
  "create",
  "Logged a call manually",
  (c) =>
    `Logged a call with ${leadRef(c)}${c.agent ? ` made by ${agentText(c)}` : ""}.`,
);
add(
  "webhook",
  "calls",
  "system",
  "automatic",
  "Received a call update",
  () => "Received a call status update from the calling service.",
  { system: true },
);
add(
  "recording_deleted",
  "calls",
  "system",
  "automatic",
  "Deleted an expired call recording",
  () =>
    "Deleted a call recording that had reached the end of its retention period.",
  { system: true },
);
add(
  "recording_delete_failed",
  "calls",
  "system",
  "automatic",
  "Could not delete a call recording",
  () => "Could not delete an expired call recording; it will be tried again.",
  { system: true },
);
add(
  "call.method_backfilled",
  "calls",
  "system",
  "automatic",
  "Recorded how earlier calls were made",
  () => "Recorded how earlier calls were made during a CRM update.",
  { system: true },
);

// Follow-ups, visits, deals and notes
generic(
  "followups",
  "activities",
  "Scheduled a follow-up",
  "Updated a follow-up",
  (c) => (c.lead ? `for ${leadRef(c)}` : ""),
);
generic(
  "visits",
  "activities",
  "Scheduled a site visit",
  "Updated a site visit",
  (c) => (c.lead ? `for ${leadRef(c)}` : ""),
);
generic("deals", "activities", "Created a deal", "Updated a deal", (c) =>
  c.lead ? `for ${leadRef(c)}` : "",
);
generic("notes", "activities", "Added a note", "Updated a note", (c) =>
  c.lead ? `to ${leadRef(c)}` : "",
);

// Targets
const period = (c) =>
  ["day", "week", "month"].includes(c.m.period)
    ? `${c.m.period}ly`.replace("dayly", "daily")
    : "";
add("create", "targets", "targets", "create", "Set a sales target", (c) =>
  `Set a ${period(c)} sales target.`.replace("a  ", "a "),
);
add("update", "targets", "targets", "update", "Updated a sales target", (c) =>
  changed(c, `Updated a ${period(c)} sales target`.replace("a  ", "a ")),
);
add(
  "targets.copied",
  "targets",
  "targets",
  "create",
  "Copied sales targets",
  (c) => {
    const from = dayText(c.m.from),
      to = dayText(c.m.to);
    return `Copied ${number(c.m.copied) != null ? count(c.m.copied, "target") : "targets"}${from ? ` from the period starting ${from}` : ""}${to ? ` to the period starting ${to}` : ""}.`;
  },
);

// Daily tasks, reports and checkout requests (update 045)
const taskTitle = (c) => (c.m.title ? `“${c.m.title}”` : "a task");
const target = (c) =>
  number(c.m.target_quantity) != null && c.m.unit
    ? ` (target ${c.m.target_quantity} ${c.m.unit})`
    : "";
const qty = (c, n) =>
  number(n) != null ? `${n}${c.m.unit ? ` ${c.m.unit}` : ""}` : null;
const checkoutKind = (c) =>
  c.m.kind === "emergency" ? "emergency" : c.m.kind === "early" ? "early" : "";
const forDay = (c) => (dateOf(c) ? ` for ${dateOf(c)}` : "");
const pct = (v) => (number(v) != null ? `${v}%` : null);
// "18:00" as "6:00 PM": a shift time, not a moment.
const clock = (hhmm) => {
  const [h, m] = String(hhmm || "")
    .split(":")
    .map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
add("task.create", "tasks", "tasks", "assign", "Assigned a task", (c) =>
  number(c.m.assignee_count) > 1
    ? `Assigned ${taskTitle(c)}${target(c)} to ${count(c.m.assignee_count, "agent")}${forDay(c)}; each agent has their own assignment.`
    : `Assigned ${taskTitle(c)}${target(c)} to ${who(c, "an agent")}${forDay(c)}.`,
);
add(
  "task.update",
  "tasks",
  "tasks",
  "update",
  "Changed a task",
  (c) =>
    changed(c, `Changed ${taskTitle(c)}`) +
    (number(c.m.added_count)
      ? ` Added ${count(c.m.added_count, "agent")} to it.`
      : ""),
);
add(
  "task.cancel",
  "tasks",
  "tasks",
  "delete",
  "Cancelled a task",
  (c) =>
    `Cancelled ${taskTitle(c)}${forDay(c)}${number(c.m.assignee_count) ? `, for ${count(c.m.assignee_count, "agent")}` : ""}. Progress already reported is kept.`,
);
add(
  "task.unassign",
  "task_assignments",
  "tasks",
  "delete",
  "Took an agent off a task",
  (c) => `Took ${who(c, "an agent")} off ${taskTitle(c)}${forDay(c)}.`,
);
add(
  "task.progress",
  "task_assignments",
  "tasks",
  "update",
  "Updated task progress",
  (c) =>
    c.m.kind === "measurable" && number(c.m.after?.quantity) != null
      ? `Reported ${number(c.m.target_quantity) != null ? `${c.m.after.quantity} of ${qty(c, c.m.target_quantity)}` : qty(c, c.m.after.quantity)} on ${taskTitle(c)}.`
      : `Marked ${taskTitle(c)} as ${words(c.m.after?.status) || "updated"}.`,
);
add(
  "task.verify",
  "task_assignments",
  "tasks",
  "review",
  "Verified a task",
  (c) => {
    const reported =
      c.m.kind === "measurable"
        ? qty(c, c.m.reported_quantity)
        : words(c.m.reported_status);
    const result =
      c.m.verified_status === "not_done"
        ? "not done"
        : c.m.verified_status === "adjusted"
          ? `adjusted to ${qty(c, c.m.verified_quantity)}`
          : "confirmed";
    return `Checked ${whose(c)} ${taskTitle(c)}${forDay(c)}: reported ${reported || "—"}, ${result}.`;
  },
);
add(
  "task.report_submit",
  "task_daily_reports",
  "tasks",
  "create",
  "Submitted a daily report",
  (c) =>
    `Submitted the daily work report${forDay(c)}${
      number(c.m.task_count) === 0
        ? " (no tasks that day)"
        : pct(c.m.completion_percent)
          ? `: ${pct(c.m.completion_percent)} across ${count(c.m.task_count, "task")}`
          : ""
    }${c.m.late ? ", after the day" : ""}.`,
);
add(
  "task.report_amend",
  "task_daily_reports",
  "tasks",
  "update",
  "Amended a daily report",
  (c) =>
    `Amended the daily work report${forDay(c)}. The earlier version is kept below.`,
);
add(
  "task.report_review",
  "task_daily_reports",
  "tasks",
  "review",
  "Reviewed a daily report",
  (c) =>
    `Reviewed ${whose(c)} daily work report${forDay(c)}${pct(c.m.completion_percent) ? ` (${pct(c.m.completion_percent)})` : ""}.`,
);
add(
  "checkout.request",
  "task_checkout_requests",
  "tasks",
  "request",
  "Requested checkout approval",
  (c) =>
    (c.m.kind === "emergency"
      ? `Requested an emergency checkout${forDay(c)}${pct(c.m.completion_percent) ? ` with tasks at ${pct(c.m.completion_percent)}` : ""}${c.m.report_submitted ? "" : ", report not submitted"}.`
      : `Requested an early checkout${forDay(c)} after finishing every task due${clock(c.m.shift_end) ? `, before the ${clock(c.m.shift_end)} shift end` : ""}.`) +
    (Number(c.m.attempt) > 1 ? ` Request ${c.m.attempt} of the day.` : ""),
  {
    titled: (c) =>
      c.m.kind === "emergency"
        ? "Requested emergency checkout"
        : "Requested early checkout",
  },
);
add(
  "checkout.approve",
  "task_checkout_requests",
  "tasks",
  "review",
  "Approved a checkout request",
  (c) =>
    `Approved ${whose(c)} ${checkoutKind(c)} checkout request${forDay(c)}.${c.m.waive_report ? " The daily report was waived." : ""}${c.m.retrospective ? " Approved after the day, to record the exception." : ""}`.replace(
      "  ",
      " ",
    ),
  {
    titled: (c) =>
      c.m.kind === "emergency"
        ? "Approved emergency checkout"
        : "Approved early checkout",
  },
);
add(
  "checkout.reject",
  "task_checkout_requests",
  "tasks",
  "review",
  "Rejected a checkout request",
  (c) =>
    `Rejected ${whose(c)} ${checkoutKind(c)} checkout request${forDay(c)}.`.replace(
      "  ",
      " ",
    ),
  {
    titled: (c) =>
      c.m.kind === "emergency"
        ? "Rejected emergency checkout"
        : "Rejected early checkout",
  },
);
add(
  "checkout.cancel",
  "task_checkout_requests",
  "tasks",
  "request",
  "Cancelled a checkout request",
  (c) =>
    `Cancelled their ${checkoutKind(c)} checkout request${forDay(c)}.`.replace(
      "  ",
      " ",
    ),
);
add(
  "task.rules_changed",
  "crm_settings",
  "tasks",
  "update",
  "Changed the task checkout rules",
  (c) =>
    c.m.to
      ? `Checkout rules start on ${dayText(c.m.to)}: agents submit a daily report before checking out, and checking out before the shift ends needs approval.`
      : "Turned the task checkout rules off.",
);

// Properties
add(
  "create",
  "properties",
  "properties",
  "create",
  "Created a property listing",
  (c) => {
    const categories = categoriesOf(c.m.building_categories?.after);
    return (
      `Created ${propertyText(c)}${c.m.ownership === "company" ? " in the company inventory" : c.m.ownership === "agent" ? " in an agent's inventory" : ""}.` +
      (categories.length
        ? ` Building categories: ${listText(categories)}.`
        : "")
    );
  },
);
add(
  "update",
  "properties",
  "properties",
  "update",
  "Updated a property listing",
  propertyUpdated,
  {
    titled: (c) =>
      Array.isArray(c.m.changed) &&
      c.m.changed.length === 1 &&
      c.m.changed[0] === "building_categories"
        ? "Updated property building categories"
        : "Updated a property listing",
  },
);
add(
  "delete",
  "properties",
  "properties",
  "delete",
  "Deleted a property listing",
  (c) =>
    (number(c.m.photo_count)
      ? `Deleted a property listing and its ${count(c.m.photo_count, "photo")}.`
      : "Deleted a property listing.") +
    (propertyRef(c.m.admin_copy_property_no)
      ? ` Its copy in Admin Properties (${propertyRef(c.m.admin_copy_property_no)}) was kept.`
      : ""),
);
// Update 044: an agent's listing copied into Admin Properties.
add(
  "promote",
  "properties",
  "properties",
  "create",
  "Added an agent property to Admin Properties",
  (c) => {
    const copy = c.property
      ? propertyText(c)
      : propertyRef(c.m.copy_property_no) || "a copy";
    const from = propertyRef(c.m.source_property_no);
    const notes = c.agent
      ? [
          number(c.agent.uid) != null ? `UID ${c.agent.uid}` : null,
          c.agent.deleted ? "deleted account" : null,
        ].filter(Boolean)
      : [];
    const agent = c.agent
      ? `${c.agent.name}${notes.length ? ` (${notes.join(", ")})` : ""}`
      : "an agent";
    const missing = number(c.m.photos_missing);
    return `Added ${copy} to Admin Properties as an independent copy of ${from ? `${from}, ` : "the listing "}originally listed by ${agent}${number(c.m.photo_count) ? `, with ${count(c.m.photo_count, "photo")}` : ""}.${missing ? ` ${count(missing, "photo")} could not be copied.` : ""}`;
  },
);
add(
  "upload_photo",
  "properties",
  "properties",
  "create",
  "Uploaded a property photo",
  (c) => `Added a photo to ${propertyText(c)}.`,
);
add(
  "delete_photo",
  "properties",
  "properties",
  "delete",
  "Removed a property photo",
  (c) => `Removed a photo from ${propertyText(c)}.`,
);
add(
  "reorder_photos",
  "properties",
  "properties",
  "update",
  "Reordered property photos",
  (c) => `Changed the order of the photos of ${propertyText(c)}.`,
);

// Documents
add(
  "create",
  "knowledge_documents",
  "documents",
  "create",
  "Added a document",
  (c) => `Added ${documentText(c)}.`,
);
add(
  "update",
  "knowledge_documents",
  "documents",
  "update",
  "Updated a document",
  (c) => changed(c, `Updated ${documentText(c)}`),
);
add(
  "delete",
  "knowledge_documents",
  "documents",
  "delete",
  "Deleted a document",
  (c) => `Deleted ${documentText(c)}.`,
);
add(
  "upload_file",
  "knowledge_documents",
  "documents",
  "create",
  "Attached a file to a document",
  (c) => `Attached a file to ${documentText(c)}.`,
);
add(
  "delete_file",
  "knowledge_documents",
  "documents",
  "delete",
  "Removed a file from a document",
  (c) => `Removed a file from ${documentText(c)}.`,
);
add(
  "download_file",
  "knowledge_documents",
  "documents",
  "view",
  "Downloaded a document file",
  (c) => `Downloaded a file from ${documentText(c)}.`,
);

// Employee accounts
add(
  "account.created",
  "profiles",
  "accounts",
  "create",
  "Created an employee account",
  (c) =>
    `Created ${c.affected ? `${whose(c)} ` : "an "}${c.m.role === "admin" ? "admin" : c.m.role === "agent" ? "agent" : c.m.role === "staff" ? "staff" : ""} account${c.m.uid ? ` with UID ${c.m.uid}` : ""}${c.m.department ? ` in ${c.m.department}` : ""}${c.m.job_title ? ` as ${c.m.job_title}` : ""}${c.m.active === false ? "; it starts disabled" : ""}.`.replace(
      "  ",
      " ",
    ),
);
add(
  "account.create_requested",
  "profiles",
  "accounts",
  "request",
  "Started creating an employee account",
  (c) =>
    `Started creating ${c.m.role === "admin" ? "an admin" : c.m.role === "agent" ? "an agent" : "an employee"} account${c.m.uid ? ` with UID ${c.m.uid}` : ""}.`,
);
add(
  "account.create_failed",
  "profiles",
  "accounts",
  "create",
  "Could not create an employee account",
  () => "Could not finish creating an employee account.",
);
add(
  "account.create_recovered",
  "profiles",
  "accounts",
  "create",
  "Finished an interrupted account creation",
  (c) => `Finished creating ${whose(c)} account after an interruption.`,
);
add(
  "manage_account",
  "profiles",
  "accounts",
  "update",
  "Updated an employee account",
  (c) => {
    const parts = [];
    if (c.m.role_from && c.m.role_to)
      parts.push(
        `changed the role from ${roleLabel(c.m.role_from)} to ${roleLabel(c.m.role_to)}`,
      );
    if (typeof c.m.active === "boolean")
      parts.push(c.m.active ? "enabled access" : "disabled access");
    return parts.length
      ? `${sentence(listText(parts))} for ${who(c)}.`
      : changed(c, `Changed ${whose(c)} account`);
  },
  {
    titled: (c) =>
      c.m.role_from && c.m.role_to
        ? "Changed an employee's role"
        : c.m.active === true
          ? "Enabled an employee account"
          : c.m.active === false
            ? "Disabled an employee account"
            : "Updated an employee account",
  },
);
// Employee management (update 047)
const weekdays = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function daysText(days) {
  const list = [...new Set(Array.isArray(days) ? days : [])]
    .map(Number)
    .filter((d) => d >= 1 && d <= 7)
    .sort();
  if (!list.length) return null;
  const consecutive = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  return consecutive && list.length > 2
    ? `${weekdays[list[0]]}–${weekdays[list.at(-1)]}`
    : list.map((d) => weekdays[d]).join(", ");
}
// A timing without its source: "12:00 PM–8:00 PM, Mon–Sat, 15 min grace".
const timingText = (s) =>
  s && typeof s === "object"
    ? [
        clock(s.shift_start) && clock(s.shift_end)
          ? `${clock(s.shift_start)}–${clock(s.shift_end)}`
          : null,
        daysText(s.work_days),
        number(s.grace_minutes) != null ? `${s.grace_minutes} min grace` : null,
      ]
        .filter(Boolean)
        .join(", ") || null
    : null;
// What an employee followed (update 047 wrote assigned for their own shift;
// 048 adds department and role timings).
const shiftText = (s) => {
  if (!s || typeof s !== "object") return null;
  const hours =
    clock(s.shift_start) && clock(s.shift_end)
      ? `${clock(s.shift_start)}–${clock(s.shift_end)}`
      : null;
  if (s.source === "company")
    return hours ? `Company default shift (${hours})` : "Company default shift";
  const name =
    (s.source === "department" || s.source === "role") && s.source_label
      ? s.source_label
      : s.label;
  return [name, timingText(s)].filter(Boolean).join(", ");
};
const reasonText = (c) =>
  typeof c.m.reason === "string" && c.m.reason ? ` Reason: ${c.m.reason}` : "";
const sameShift = (a, b, keys) =>
  keys.every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));
// Shift management (update 048): the role or department a timing belongs to.
const shiftTarget = (c) =>
  c.m.scope === "department"
    ? `${c.m.department || "a department"} department`
    : c.m.role === "agent"
      ? "Agent default"
      : c.m.role === "staff"
        ? "Staff default"
        : "default";
const fallbackText = (c) =>
  c.m.scope === "department" ? "Role default shifts" : "Company default shift";
const employeeChanges = {
  department: "Department",
  job_title: "Job title",
  joined_on: "Joining date",
};
add(
  "employee.updated",
  "profiles",
  "accounts",
  "update",
  "Updated employee details",
  (c) => {
    const ch =
      c.m.changes && typeof c.m.changes === "object" ? c.m.changes : {};
    const parts = Object.entries(employeeChanges)
      .filter(([key]) => ch[key])
      .map(([key, label]) => {
        const after =
          key === "joined_on" ? dayText(ch[key].after) : ch[key].after;
        return after
          ? `${label.toLowerCase()} to ${after}`
          : `removed the ${label.toLowerCase()}`;
      });
    return parts.length
      ? `Set ${whose(c)} ${listText(parts)}.`.replace("Set removed", "Removed")
      : `Updated ${whose(c)} details.`;
  },
  {
    titled: (c) =>
      c.m.changes?.department && Object.keys(c.m.changes).length === 1
        ? "Changed an employee's department"
        : "Updated employee details",
  },
);
add(
  "employee.shift_changed",
  "profiles",
  "attendance",
  "update",
  "Changed an employee's shift",
  (c) => {
    const from = dayText(c.m.effective_from);
    if (c.m.inherits === true)
      return `Removed ${whose(c)} individual shift${from ? ` from ${from}` : ""}; they follow the ${shiftText(c.m.after) || "shift of their department or role"}.${reasonText(c)}`;
    const after = shiftText(c.m.after);
    return `${after ? `Set ${whose(c)} shift to ${after}` : `Changed ${whose(c)} shift`}${from ? ` from ${from}` : ""}.${reasonText(c)}`;
  },
  {
    titled: (c) => {
      const b = c.m.before || {},
        a = c.m.after || {};
      if (c.m.inherits === true) return "Removed an individual shift";
      if (b.source && !["individual", "assigned"].includes(b.source))
        return "Assigned an individual shift";
      if (
        sameShift(a, b, ["shift_start", "shift_end", "grace_minutes"]) &&
        !sameShift(a, b, ["work_days"])
      )
        return "Changed an employee's working days";
      if (
        sameShift(a, b, ["shift_start", "shift_end", "work_days"]) &&
        !sameShift(a, b, ["grace_minutes"])
      )
        return "Changed an employee's grace period";
      return "Changed an employee's shift";
    },
  },
);
add(
  "employee.shift_cancelled",
  "profiles",
  "attendance",
  "update",
  "Withdrew a planned shift change",
  (c) =>
    `Withdrew ${whose(c)} shift change planned for ${dayText(c.m.effective_from) || "a later date"}.`,
);
add(
  "shift.default_changed",
  "shift_schedules",
  "attendance",
  "update",
  "Changed a shift timing",
  (c) => {
    const from = dayText(c.m.effective_from);
    const told =
      number(c.m.notified) > 0
        ? ` ${count(c.m.notified, "employee")} whose timing changes ${c.m.notified === 1 ? "was" : "were"} notified.`
        : "";
    return c.m.inherits === true
      ? `Ended the ${shiftTarget(c)} shift${from ? ` from ${from}` : ""}; its employees follow ${fallbackText(c).toLowerCase().replace("role", "their role")}.${told}${reasonText(c)}`
      : `Set the ${shiftTarget(c)} shift to ${timingText(c.m.after) || "a new timing"}${from ? ` from ${from}` : ""}.${told}${reasonText(c)}`;
  },
  {
    titled: (c) =>
      c.m.inherits === true
        ? `Removed ${shiftTarget(c)} shift`
        : `Updated ${shiftTarget(c)} shift`,
  },
);
add(
  "shift.default_withdrawn",
  "shift_schedules",
  "attendance",
  "update",
  "Withdrew a planned shift change",
  (c) =>
    `Withdrew the ${shiftTarget(c)} shift change planned for ${dayText(c.m.effective_from) || "a later date"}.`,
);
add(
  "department.created",
  "departments",
  "accounts",
  "create",
  "Added a department",
  (c) =>
    `Added the department ${c.m.name ? `“${c.m.name}”` : ""}.`.replace(
      " .",
      ".",
    ),
);
add(
  "department.updated",
  "departments",
  "accounts",
  "update",
  "Changed a department",
  (c) => {
    const b = c.m.before || {},
      a = c.m.after || {};
    const parts = [];
    if (b.name && a.name && b.name !== a.name)
      parts.push(`renamed “${b.name}” to “${a.name}”`);
    if (typeof a.active === "boolean" && a.active !== b.active)
      parts.push(
        `${a.active ? "reactivated" : "deactivated"} “${a.name || c.m.name}”`,
      );
    return parts.length
      ? `${sentence(listText(parts))}.`
      : `Changed the department “${c.m.name || "a department"}”.`;
  },
);
add(
  "offboard_agent",
  "profiles",
  "accounts",
  "update",
  "Offboarded an agent",
  (c) => {
    const parts = Object.entries(c.m)
      .filter(([, v]) => number(v) != null)
      .map(([k, v]) => `${words(k)}: ${v}`);
    return parts.length
      ? `Offboarded ${who(c, "an agent")} (${parts.join(", ")}).`
      : `Offboarded ${who(c, "an agent")}.`;
  },
);
add(
  "account.delete_requested",
  "profiles",
  "accounts",
  "request",
  "Started deleting an employee account",
  (c) => `Started deleting ${whose(c)} account.`,
);
add(
  "account.deleted",
  "profiles",
  "accounts",
  "delete",
  "Deleted an employee account",
  (c) => `Deleted ${whose(c)} account.`,
);
add(
  "account.delete_failed",
  "profiles",
  "accounts",
  "delete",
  "Could not delete an employee account",
  (c) => `Could not delete ${whose(c)} account.`,
);
add(
  "account.mfa_reset_requested",
  "profiles",
  "accounts",
  "request",
  "Started a two-factor reset",
  (c) => `Started resetting ${whose(c)} two-factor sign-in.`,
);
add(
  "account.mfa_reset_completed",
  "profiles",
  "accounts",
  "update",
  "Reset two-factor sign-in",
  (c) => `Reset ${whose(c)} two-factor sign-in.`,
);
add(
  "account.mfa_reset_failed",
  "profiles",
  "accounts",
  "update",
  "Could not reset two-factor sign-in",
  (c) => `Could not reset ${whose(c)} two-factor sign-in.`,
);
add(
  "create_account_requested",
  "profiles",
  "accounts",
  "request",
  "Requested a new employee account",
  (c) => `Requested an account for ${who(c, "a new employee")}.`,
);
add(
  "set_password_requested",
  "profiles",
  "accounts",
  "request",
  "Started setting a password",
  (c) => `Started setting a new password for ${who(c)}.`,
);
add(
  "set_password_completed",
  "profiles",
  "accounts",
  "update",
  "Set an employee's password",
  (c) => `Set a new password for ${who(c)}.`,
);
add(
  "set_password_failed",
  "profiles",
  "accounts",
  "update",
  "Could not set a password",
  (c) => `Could not set a new password for ${who(c)}.`,
);
add(
  "email_confirmation_",
  "profiles",
  "accounts",
  "request",
  "Email confirmation",
  (c) =>
    `Email confirmation for ${who(c)}: ${words(c.action.replace("email_confirmation_", ""))}.`,
  { prefix: true },
);
add(
  "invitation_requested",
  "profiles",
  "accounts",
  "request",
  "Invited an employee",
  (c) => `Invited ${who(c)} to set up their account.`,
);
add(
  "invitation_send_requested",
  "profiles",
  "accounts",
  "request",
  "Sent an account invitation",
  (c) => `Sent an account invitation to ${who(c)}.`,
);
add(
  "invitation_send_failed",
  "profiles",
  "accounts",
  "request",
  "Could not send an account invitation",
  (c) => `Could not send an account invitation to ${who(c)}.`,
);
add(
  "invitation_cancelled",
  "profiles",
  "accounts",
  "delete",
  "Cancelled an account invitation",
  (c) => `Cancelled ${whose(c)} account invitation.`,
);
add(
  "invitation_accepted",
  "profiles",
  "accounts",
  "update",
  "Accepted an account invitation",
  (c) =>
    c.self
      ? "Accepted their account invitation and set up the account."
      : `${who(c)} accepted the account invitation.`,
);
add(
  "account.email_code_",
  "profiles",
  "accounts",
  "request",
  "Email verification code",
  (c) =>
    `Email verification code for ${who(c)}: ${words(c.action.replace("account.email_code_", ""))}.`,
  { prefix: true },
);
add(
  "account_creation.",
  null,
  "accounts",
  "request",
  "Account verification (earlier process)",
  (c) =>
    `Account creation step: ${words(c.action.replace("account_creation.", ""))}.`,
  { prefix: true },
);
add(
  "migration.pending_access_blocked",
  "profiles",
  "system",
  "automatic",
  "Blocked an unverified account",
  (c) =>
    `Blocked access to ${whose(c)} unverified account during a CRM update.`,
  { system: true },
);
add(
  "migration.account_uids_assigned",
  "profiles",
  "system",
  "automatic",
  "Assigned account UIDs",
  (c) =>
    number(c.m.assigned) != null
      ? `Gave ${count(c.m.assigned, "account")} a six-digit UID during a CRM update.`
      : "Gave accounts a six-digit UID during a CRM update.",
  { system: true },
);
add(
  "inactive_agent_work_found",
  "profiles",
  "system",
  "automatic",
  "Found work owned by a disabled employee",
  (c) =>
    `${who(c)} is disabled but still owns ${number(c.m.leads) != null ? count(c.m.leads, "lead") : "leads"}; an alert was raised for an administrator.`,
  { system: true },
);

// Sign-in and security
add(
  "set_accounts_pin",
  "account_security",
  "security",
  "security",
  "Set an Accounts PIN",
  () => "Set a new PIN for opening the Accounts page.",
);
add(
  "accounts_pin_failed",
  "account_security",
  "security",
  "security",
  "Entered a wrong Accounts PIN",
  (c) =>
    `Entered a wrong Accounts PIN${c.m.locked === true ? "; the Accounts page was locked" : ""}.`,
);
add(
  "unlock_accounts",
  "account_security",
  "security",
  "security",
  "Unlocked the Accounts page",
  () => "Unlocked the Accounts page with the PIN.",
);
add(
  "security.alert_created",
  "security_alerts",
  "security",
  "security",
  "Security alert raised",
  (c) =>
    `Raised a ${c.m.severity ? `${words(c.m.severity)} ` : ""}security alert${c.m.type ? ` (${words(c.m.type)})` : ""}${c.affected ? ` about ${person(c.affected)}` : ""}.`,
  { system: true },
);
add(
  "security.alert_reviewed",
  "security_alerts",
  "security",
  "review",
  "Reviewed a security alert",
  () => "Reviewed and closed a security alert.",
);
add(
  "auth.mfa_verified",
  "profiles",
  "security",
  "security",
  "Confirmed two-factor sign-in",
  () => "Signed in with a correct authenticator code.",
);
add(
  "auth.mfa_failed",
  "profiles",
  "security",
  "security",
  "Entered a wrong authenticator code",
  () => "Entered a wrong authenticator code while signing in.",
);
add(
  "auth.mfa_unavailable",
  "profiles",
  "security",
  "security",
  "Two-factor sign-in was unavailable",
  () => "Two-factor sign-in could not be checked.",
);

// Attendance
add(
  "attendance.check_in",
  "attendance_records",
  "attendance",
  "create",
  "Checked in",
  (c) =>
    `Checked in${dateOf(c) ? ` on ${dateOf(c)}` : ""}${c.m.punctuality === "late" && number(c.m.late_minutes) != null ? `, ${minutesText(c.m.late_minutes)} late` : c.m.punctuality === "within_grace" ? ", within the grace period" : ""}.`,
);
add(
  "attendance.check_out",
  "attendance_records",
  "attendance",
  "update",
  "Checked out",
  (c) =>
    `Checked out${dateOf(c) ? ` on ${dateOf(c)}` : ""}${number(c.m.worked_minutes) != null ? ` after working ${minutesText(c.m.worked_minutes)}` : ""}${c.m.checkout_kind === "early" ? ", using an approved early checkout" : c.m.checkout_kind === "emergency" ? ", using an approved emergency checkout" : ""}.`,
);
add(
  "attendance.leave_requested",
  "attendance_leave_requests",
  "attendance",
  "request",
  "Requested leave",
  (c) => `Requested ${leaveText(c)}leave ${range(c)}.`.replace(" .", "."),
);
add(
  "attendance.leave_cancelled",
  "attendance_leave_requests",
  "attendance",
  "delete",
  "Cancelled a leave request",
  () => "Cancelled a leave request.",
);
add(
  "attendance.leave_approved",
  "attendance_leave_requests",
  "attendance",
  "review",
  "Approved a leave request",
  (c) =>
    `Approved ${whose(c)} ${leaveText(c)}leave ${range(c)}.`.replace(" .", "."),
);
add(
  "attendance.leave_rejected",
  "attendance_leave_requests",
  "attendance",
  "review",
  "Rejected a leave request",
  (c) =>
    `Did not approve ${whose(c)} ${leaveText(c)}leave ${range(c)}.`.replace(
      " .",
      ".",
    ),
);
add(
  "attendance.correction_requested",
  "attendance_corrections",
  "attendance",
  "request",
  "Requested an attendance correction",
  (c) =>
    `Asked to correct ${c.m.correction_type ? words(c.m.correction_type) : "attendance"}${dateOf(c) ? ` on ${dateOf(c)}` : ""}.`,
);
add(
  "attendance.correction_cancelled",
  "attendance_corrections",
  "attendance",
  "delete",
  "Cancelled an attendance correction",
  () => "Cancelled an attendance correction request.",
);
add(
  "attendance.correction_approved",
  "attendance_corrections",
  "attendance",
  "review",
  "Approved an attendance correction",
  (c) =>
    `Approved ${whose(c)} correction${dateOf(c) ? ` for ${dateOf(c)}` : ""}${c.m.before !== undefined && c.m.after ? `: ${attendanceText(c.m.before) || "no attendance"} → ${attendanceText(c.m.after)}` : ""}.`,
);
add(
  "attendance.correction_rejected",
  "attendance_corrections",
  "attendance",
  "review",
  "Rejected an attendance correction",
  (c) =>
    `Did not approve ${whose(c)} correction${dateOf(c) ? ` for ${dateOf(c)}` : ""}.`,
);
add(
  "attendance.holiday_added",
  "attendance_holidays",
  "attendance",
  "create",
  "Added a company holiday",
  (c) => `Added a company holiday${dateOf(c) ? ` on ${dateOf(c)}` : ""}.`,
);
add(
  "attendance.holiday_removed",
  "attendance_holidays",
  "attendance",
  "delete",
  "Removed a company holiday",
  (c) =>
    `Removed the company holiday${c.m.name ? ` “${c.m.name}”` : ""}${dateOf(c) ? ` on ${dateOf(c)}` : ""}.`,
);
add(
  "attendance.policy_saved",
  "attendance_policies",
  "attendance",
  "update",
  "Changed the attendance rules",
  (c) =>
    `Changed the attendance rules${dayText(c.m.effective_from) ? ` from ${dayText(c.m.effective_from)}` : ""}.`,
);
add(
  "attendance.marked_incomplete",
  "attendance_records",
  "system",
  "automatic",
  "Marked a missing check-out",
  (c) =>
    `Marked ${whose(c)} check-in${dateOf(c) ? ` on ${dateOf(c)}` : ""} as incomplete because no check-out was recorded.`,
  { system: true },
);
add(
  "attendance.tracking_start_moved",
  "attendance_policies",
  "attendance",
  "update",
  "Moved the start of attendance tracking",
  (c) =>
    `Attendance tracking now starts on ${dayText(c.m.to) || "an earlier day"}${dayText(c.m.from) ? ` instead of ${dayText(c.m.from)}` : ""}, so ${whose(c)} earlier attendance could be entered.`,
);
for (const action of ["attendance.manual_create", "attendance.manual_update"])
  add(
    action,
    null,
    "attendance",
    action.endsWith("create") ? "create" : "update",
    null,
    manualAttendance,
    { titled: manualTitle },
  );

function manualTitle(c) {
  const update = c.action === "attendance.manual_update";
  switch (c.m.status) {
    case "clear":
      return "Removed a historical attendance entry";
    case "leave":
      return update ? "Changed attendance to leave" : "Recorded employee leave";
    case "absent":
      return update ? "Changed attendance to absent" : "Marked a day absent";
    default:
      return update
        ? "Corrected an attendance record"
        : "Added historical attendance";
  }
}
function manualAttendance(c) {
  const day = dateOf(c) ? ` on ${dateOf(c)}` : "";
  const before = attendanceText(c.m.before),
    after = attendanceText(c.m.after);
  if (c.m.status === "clear")
    return `Removed ${whose(c)} attendance entry${day}; the day is no longer counted.`;
  if (c.action === "attendance.manual_update" && before && after)
    return `Changed ${whose(c)} attendance${day} from ${before} to ${after}.`;
  if (c.m.status === "leave")
    return `Recorded ${c.m.after?.leave_type ? `${leaveTypes[c.m.after.leave_type] || words(c.m.after.leave_type)} ` : ""}leave for ${who(c)}${day}.`;
  if (c.m.status === "absent") return `Counted ${who(c)} as absent${day}.`;
  return after
    ? `Added ${whose(c)} attendance${day}: ${after}.`
    : `Entered ${whose(c)} attendance${day}.`;
}

// Settings and integrations
add(
  "settings.work_hours_updated",
  "crm_settings",
  "settings",
  "update",
  "Changed the working hours",
  (c) => changed(c, "Changed the CRM working hours"),
);
add(
  "meta.connect_requested",
  null,
  "integrations",
  "request",
  "Started connecting Facebook Lead Ads",
  () => "Started connecting the CRM to Facebook Lead Ads.",
);
add(
  "meta.connected",
  null,
  "integrations",
  "update",
  "Connected Facebook Lead Ads",
  () => "Connected the CRM to Facebook Lead Ads.",
);
add(
  "meta.disconnected",
  null,
  "integrations",
  "delete",
  "Disconnected Facebook Lead Ads",
  () => "Disconnected the CRM from Facebook Lead Ads.",
);
add(
  "meta.forms_refreshed",
  null,
  "integrations",
  "update",
  "Refreshed Facebook lead forms",
  () => "Refreshed the list of Facebook pages and lead forms.",
);
add(
  "meta.configuration_changed",
  null,
  "integrations",
  "update",
  "Changed a Facebook lead setting",
  (c) =>
    `${c.m.enabled === true ? "Turned on" : c.m.enabled === false ? "Turned off" : "Changed"} a Facebook ${c.entity === "meta_forms" ? "lead form" : c.entity === "meta_pages" ? "page" : "lead setting"}.`,
);
add(
  "meta.submission_processed",
  null,
  "integrations",
  "automatic",
  "Processed a Facebook lead",
  (c) =>
    `Processed a Facebook lead${c.lead ? ` into ${leadRef(c)}` : ""}${c.m.status ? ` (${words(c.m.status)})` : ""}.`,
  { system: true },
);
add(
  "meta.processing_failed",
  null,
  "integrations",
  "automatic",
  "Could not process a Facebook lead",
  (c) =>
    `Could not process a Facebook lead${number(c.m.attempt) != null ? ` (attempt ${c.m.attempt})` : ""}.`,
  { system: true },
);
add(
  "meta.retry_requested",
  null,
  "integrations",
  "request",
  "Retried a Facebook lead",
  () => "Asked to process a Facebook lead again.",
);
add(
  "meta.review_resolved",
  null,
  "integrations",
  "review",
  "Resolved a Facebook lead for review",
  () => "Resolved a Facebook lead that needed review.",
);
add(
  "meta.submission_viewed",
  null,
  "integrations",
  "view",
  "Viewed a Facebook lead",
  () => "Viewed the answers of a Facebook lead.",
);
add(
  "meta.bulk_assigned",
  "leads",
  "integrations",
  "assign",
  "Assigned Facebook leads",
  (c) =>
    `Assigned ${number(c.m.count) != null ? count(c.m.count, "Facebook lead") : "Facebook leads"} to ${agentText(c)}.`,
);

const moduleByEntity = {
  departments: "accounts",
  shift_schedules: "attendance",
  leads: "leads",
  lead_imports: "leads",
  calls: "calls",
  followups: "activities",
  visits: "activities",
  deals: "activities",
  notes: "activities",
  targets: "targets",
  properties: "properties",
  knowledge_documents: "documents",
  profiles: "accounts",
  account_creation_requests: "accounts",
  account_security: "security",
  security_alerts: "security",
  crm_settings: "settings",
  tasks: "tasks",
  task_assignments: "tasks",
  task_daily_reports: "tasks",
  task_checkout_requests: "tasks",
};
function entryFor(action, entity) {
  return (
    catalog.find(
      (e) => !e.prefix && e.action === action && e.entity === entity,
    ) ||
    catalog.find((e) => !e.prefix && e.action === action && e.entity == null) ||
    catalog.find(
      (e) =>
        e.prefix &&
        action.startsWith(e.action) &&
        (e.entity == null || e.entity === entity),
    )
  );
}
// Self-service attendance: the employee who acted is the employee affected.
const ownAttendance = new Set([
  "attendance.check_in",
  "attendance.check_out",
  "attendance.leave_requested",
  "attendance.leave_cancelled",
  "attendance.correction_requested",
  "attendance.correction_cancelled",
]);

// The database filter for a module and/or action type: every catalog entry
// that fits, as {action|prefix, entity}. null means "no filter".
export function auditMatches({ module, kind } = {}) {
  if (!module && !kind) return null;
  return catalog
    .filter(
      (e) => (!module || e.module === module) && (!kind || e.kind === kind),
    )
    .map((e) => ({
      ...(e.prefix ? { prefix: e.action } : { action: e.action }),
      ...(e.entity ? { entity: e.entity } : {}),
    }));
}

const label = (pairs, key) => pairs.find(([k]) => k === key)?.[1] || key;
const personBadge = (p) =>
  [roleLabel(p.role), p.uid ? `UID ${p.uid}` : null]
    .filter(Boolean)
    .join(" · ");
const personNote = (p) =>
  p.deleted
    ? "Account deleted"
    : p.active === false
      ? "Account disabled"
      : null;

// One audit row from audit_page as the page shows it.
export function presentAuditEntry(row) {
  const m =
    row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const entry = entryFor(String(row.action || ""), row.entity);
  const automatic =
    !row.actor_id &&
    (entry?.system ||
      String(row.request_id || "").startsWith("job:") ||
      String(row.action || "").startsWith("migration."));
  const actorId = row.actor?.id || null;
  const affected =
    row.affected ||
    (ownAttendance.has(row.action) && row.actor ? row.actor : null);
  const c = {
    m,
    action: String(row.action || ""),
    entity: row.entity,
    entityId: row.entity_id,
    actor: row.actor,
    affected,
    agent: row.agent,
    lead: row.lead,
    property: row.property,
    document: row.document,
    import: row.import,
    self: Boolean(actorId && affected && affected.id === actorId),
  };
  let title, description;
  try {
    title = entry ? (entry.titled ? entry.titled(c) : entry.title) : null;
    description = entry ? entry.describe(c) : null;
  } catch {
    title = description = null;
  }
  const module =
    entry?.module ||
    moduleByEntity[row.entity] ||
    (c.action.startsWith("attendance.")
      ? "attendance"
      : c.action.startsWith("meta.")
        ? "integrations"
        : null);
  const kind = entry?.kind || null;
  const changes = [];
  if (c.action === "task.update" && m.before && m.after) {
    for (const [key, label, show] of [
      ["title", "Title", (v) => v],
      [
        "target_quantity",
        "Target",
        (v) => (number(v) != null ? String(v) : null),
      ],
      ["due_on", "Due date", dayText],
    ])
      if (
        m.before[key] !== m.after[key] &&
        (show(m.before[key]) || show(m.after[key]))
      )
        changes.push({
          label,
          before: show(m.before[key]),
          after: show(m.after[key]),
        });
  }
  if (
    c.entity === "properties" &&
    (c.action === "create" || c.action === "update") &&
    m.building_categories
  )
    changes.push({
      label: "Building categories",
      before: categoriesOf(m.building_categories.before).join(", ") || "None",
      after: categoriesOf(m.building_categories.after).join(", ") || "None",
    });
  if (c.action === "task.report_amend" && m.before && m.after)
    changes.push({
      label: "Completion",
      before: pct(m.before.completion_percent),
      after: pct(m.after.completion_percent),
    });
  if (c.action === "manage_account" && m.role_from && m.role_to)
    changes.push({
      label: "Role",
      before: roleLabel(m.role_from),
      after: roleLabel(m.role_to),
    });
  if (
    c.action === "employee.updated" &&
    m.changes &&
    typeof m.changes === "object"
  )
    for (const [key, label] of Object.entries(employeeChanges))
      if (m.changes[key])
        changes.push({
          label,
          before:
            key === "joined_on"
              ? dayText(m.changes[key].before)
              : m.changes[key].before || null,
          after:
            key === "joined_on"
              ? dayText(m.changes[key].after)
              : m.changes[key].after || null,
        });
  if (c.action === "employee.shift_changed")
    changes.push({
      label: "Shift",
      before: shiftText(m.before),
      after: shiftText(m.after),
    });
  if (c.action === "shift.default_changed")
    changes.push({
      label: "Shift",
      before:
        m.before && !m.before.inherits ? timingText(m.before) : fallbackText(c),
      after: m.inherits ? fallbackText(c) : timingText(m.after),
    });
  if (m.from_status && m.to_status)
    changes.push({
      label: "Lead status",
      before: leadStatuses[m.from_status] || words(m.from_status),
      after: leadStatuses[m.to_status] || words(m.to_status),
    });
  if (
    c.action.startsWith("attendance.") &&
    (m.before !== undefined || m.after !== undefined) &&
    (attendanceText(m.before) || attendanceText(m.after))
  )
    changes.push({
      label: "Attendance",
      before: attendanceText(m.before),
      after: attendanceText(m.after),
    });
  if (
    c.action === "attendance.tracking_start_moved" &&
    dayText(m.from) &&
    dayText(m.to)
  )
    changes.push({
      label: "Tracking starts",
      before: dayText(m.from),
      after: dayText(m.to),
    });
  // The record affected: an employee, or a lead, property, document or file.
  const record = affected
    ? {
        label: person(affected),
        detail:
          c.action.startsWith("attendance.") && dateOf(c)
            ? dateOf(c)
            : personBadge(affected),
        note: personNote(affected),
      }
    : row.lead
      ? {
          label: `Lead ${row.lead.number}`,
          detail: row.lead.deleted ? "In Deleted leads" : null,
        }
      : row.property
        ? {
            label: row.property.title,
            detail: propertyRef(row.property.number),
          }
        : row.document
          ? { label: row.document.title, detail: "Document" }
          : row.import
            ? { label: row.import.file_name, detail: "Import file" }
            : row.entity === "properties" && row.entity_id
              ? { label: "Deleted property", detail: null }
              : null;
  return {
    id: row.id,
    at: row.created_at,
    module: module
      ? { key: module, label: label(auditModules, module) }
      : { key: "other", label: "Other" },
    kind: kind ? { key: kind, label: label(auditKinds, kind) } : null,
    title: title || sentence(row.action),
    description:
      description ||
      `A ${words(row.entity) || "CRM"} activity was recorded. Open the technical details to see exactly what was stored.`,
    actor: row.actor
      ? {
          type: "person",
          name: person(row.actor),
          detail: personBadge(row.actor),
          note: personNote(row.actor),
        }
      : automatic
        ? {
            type: "system",
            name: "System",
            detail: "Automatic CRM task",
            note: null,
          }
        : {
            type: "unknown",
            name: "Unknown user",
            detail: "Not recorded",
            note: null,
          },
    record,
    fields: fieldsText(m.fields),
    changes,
    reason:
      typeof m.reason === "string" && m.reason.trim()
        ? m.reason.trim().slice(0, 300)
        : null,
    technical: {
      action: row.action,
      entity: row.entity,
      actor_id: row.actor_id ?? null,
      entity_id: row.entity_id ?? null,
      request_id: row.request_id ?? null,
      metadata: sanitizeMetadata(m),
    },
  };
}
