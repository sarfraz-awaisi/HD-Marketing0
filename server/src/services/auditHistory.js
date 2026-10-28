// Plain-English audit history (update 043). Each audit entry becomes a title,
// a description, who acted, who or what was affected and what changed, using
// only what the entry recorded: nothing is guessed. The original values stay
// available as technical details, with anything secret or personal removed.

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

// Properties
add(
  "create",
  "properties",
  "properties",
  "create",
  "Created a property listing",
  (c) =>
    `Created ${propertyText(c)}${c.m.ownership === "company" ? " in the company inventory" : c.m.ownership === "agent" ? " in an agent's inventory" : ""}.`,
);
add(
  "update",
  "properties",
  "properties",
  "update",
  "Updated a property listing",
  (c) => changed(c, `Updated ${propertyText(c)}`),
);
add(
  "delete",
  "properties",
  "properties",
  "delete",
  "Deleted a property listing",
  (c) =>
    number(c.m.photo_count)
      ? `Deleted a property listing and its ${count(c.m.photo_count, "photo")}.`
      : "Deleted a property listing.",
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
    `Created ${c.affected ? `${whose(c)} ` : "an "}${c.m.role === "admin" ? "admin" : c.m.role === "agent" ? "agent" : ""} account${c.m.uid ? ` with UID ${c.m.uid}` : ""}${c.m.active === false ? "; it starts disabled" : ""}.`.replace(
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
  (c) => changed(c, `Changed ${whose(c)} account`),
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
    `Checked out${dateOf(c) ? ` on ${dateOf(c)}` : ""}${number(c.m.worked_minutes) != null ? ` after working ${minutesText(c.m.worked_minutes)}` : ""}.`,
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
