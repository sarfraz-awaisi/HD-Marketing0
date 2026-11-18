import { leadContacts } from "./phoneAccess.js";
import {
  amount,
  exportTemperatures,
  leadNo,
  lostReasons,
  pkDateTime,
  platforms,
  statusLabels,
} from "./pipelineExport.js";
// Lead export (update 073): administrators export leads file by file (a
// Google Sheet, a CSV or Excel file, or leads with no file) with their whole
// CRM history. The database matches the leads and reads their records
// (lead_export_*); this file turns them into worksheets:
// - Read me: who exported what, with which filters, and what each column
//   means;
// - Lead summary: one row per lead;
// - Call history, Notes, Assignment history: one row per record;
// - Ad quality: the leads grouped by the advertisement that created them;
// - Files: each file's figures (rows, new leads, repeat inquiries, rejected
//   rows, leads now in the CRM).
// The leads are a snapshot of IDs taken first; their records are read 500 at
// a time, and if one went to Deleted leads meanwhile the export stops and
// asks to be done again, so the file never disagrees with its own counts.
// Phone numbers come as in every lead list, 100 at a time, recorded as
// viewed.
export const exportSheets = [
  "summary",
  "calls",
  "notes",
  "assignments",
  "ad_quality",
  "files",
];
export const sheetTitles = {
  readme: "Read me",
  summary: "Lead summary",
  calls: "Call history",
  notes: "Notes",
  assignments: "Assignment history",
  ad_quality: "Ad quality",
  files: "Files",
};
// One Excel file holds at most this many leads and records; a larger export
// is done one worksheet at a time as CSV, which is written as it is read.
export const exportLimits = {
  xlsxLeads: 10000,
  xlsxRecords: 60000,
  csvLeads: 50000,
  csvRecords: 300000,
};
const batchSize = 500;

export async function exportRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : error.code === "42501"
      ? 403
      : error.code === "P0002"
        ? 404
        : error.code === "22023"
          ? 400
          : 503;
  throw Object.assign(
    new Error(
      missing
        ? "Lead export needs CRM database update 073."
        : status === 503
          ? "The export could not be prepared. Please try again."
          : error.message,
    ),
    { status },
  );
}

// How big the export is, and whether one file can hold it.
export function exportSize(size, format, sheets) {
  const records =
    (sheets.includes("calls") ? size.calls : 0) +
    (sheets.includes("notes") ? size.notes : 0) +
    (sheets.includes("assignments") ? size.assignments : 0);
  const [leads, max] =
    format === "xlsx"
      ? [exportLimits.xlsxLeads, exportLimits.xlsxRecords]
      : [exportLimits.csvLeads, exportLimits.csvRecords];
  if (size.count > leads)
    return `More than ${leads.toLocaleString("en-US")} leads match. Choose fewer files or narrower filters${format === "xlsx" ? ", or export one worksheet as CSV" : ""}.`;
  if (records > max)
    return `These leads have more than ${max.toLocaleString("en-US")} calls, notes and assignments together. Choose fewer files or a call period${format === "xlsx" ? ", or export one worksheet as CSV" : ""}.`;
  return null;
}

// The records of the snapshot's leads, a batch at a time; with their phone
// numbers only when the file shows them.
export async function* leadBatches(db, req, ids, phones = true) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const rows = await exportRpc(db, "lead_export_rows", {
      p_actor: req.user.id,
      p_ids: batch,
    });
    if (rows.length !== batch.length) throw changed();
    if (!phones) {
      yield rows;
      continue;
    }
    const withPhones = [];
    for (let j = 0; j < rows.length; j += 100)
      withPhones.push(...(await leadContacts(db, req, rows.slice(j, j + 100))));
    yield withPhones;
  }
}
export async function* recordBatches(db, req, name, ids, extra = {}) {
  for (let i = 0; i < ids.length; i += batchSize)
    yield await exportRpc(db, name, {
      p_actor: req.user.id,
      p_ids: ids.slice(i, i + batchSize),
      ...extra,
    });
}
const changed = () =>
  Object.assign(
    new Error(
      "Some leads changed (deleted or restored) while the file was being prepared. Export again.",
    ),
    { status: 409 },
  );

// ------------------------------------------------------------- the words
const yesNo = (value) => (value ? "Yes" : "No");
const fileTypes = {
  sheets: "Google Sheet",
  csv: "CSV file",
  xlsx: "Excel file",
  xls: "Excel file",
  legacy: "Earlier import (recovered)",
};
const attribution = {
  sheet: "Google Sheet row",
  meta: "Meta Lead Ads",
  file: "Ad name in the file",
};
const followupStates = {
  pending: "Pending",
  completed: "Completed",
  cancelled: "Cancelled",
};
const visitStates = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  "no-show": "No-show",
};
const dealStages = {
  discussion: "Discussion",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};
const roles = { admin: "Administrator", agent: "Agent", staff: "Staff" };
const callStates = {
  completed: "Answered",
  failed: "Not answered",
  initiated: "Started",
  ringing: "Ringing",
};
const person = (p) => p?.name ?? "";
const fileId = (f) => f?.id ?? "";

export const summaryHeadings = [
  "Lead #",
  "CRM lead ID",
  "Name",
  "Phone",
  "Phone country",
  "Email",
  "File",
  "File type",
  "File ID",
  "Google spreadsheet ID",
  "Sheet tab",
  "Row in file",
  "Google Sheet row",
  "File imported",
  "Source",
  "Ad attribution",
  "Ad platform",
  "Campaign",
  "Campaign ID",
  "Ad set",
  "Ad set ID",
  "Advertisement",
  "Ad ID",
  "Lead form",
  "Form ID",
  "Submitted to Meta",
  "Lead created",
  "Agent",
  "Agent UID",
  "Agent account",
  "Assigned to agent",
  "Status",
  "Lost reason",
  "First-call deadline",
  "First call",
  "Call attempts",
  "Answered calls",
  "Contacted",
  "Showed interest",
  "Latest call",
  "Latest call outcome",
  "Latest call answered",
  "Temperature",
  "Temperature set",
  "Latest comment",
  "Latest comment by",
  "Latest comment on",
  "Follow-up",
  "Follow-up due",
  "Follow-ups",
  "Site visit",
  "Site visit on",
  "Site visits",
  "Deal stage",
  "Deal value (PKR)",
  "Deals",
  "Won deals",
  "Last activity",
];
export function summaryRow(r) {
  const ad = r.ad || {};
  const f = r.file;
  return [
    leadNo(r.lead_no),
    r.id,
    r.name ?? "",
    r.phone ?? "",
    r.phone_country ?? "",
    r.email ?? "",
    f ? f.name : "No file",
    f ? (fileTypes[f.format] ?? f.format) : "",
    fileId(f),
    f?.spreadsheet_id ?? "",
    f?.sheet_tab ?? (f?.format === "sheets" ? "" : (f?.worksheet ?? "")),
    f?.row ?? "",
    f?.sheet_row ?? "",
    pkDateTime(f?.created_at),
    r.source ?? "",
    attribution[ad.origin] ?? "None recorded",
    ad.platform
      ? (platforms[ad.platform] ?? ad.platform) +
        (ad.organic ? " (organic)" : "")
      : "",
    ad.campaign_name ?? "",
    ad.campaign_id ?? "",
    ad.adset_name ?? "",
    ad.adset_id ?? "",
    ad.ad_name ?? "",
    ad.ad_id ?? "",
    ad.form_name ?? "",
    ad.form_id ?? "",
    pkDateTime(ad.submitted_at),
    pkDateTime(r.created_at),
    person(r.agent),
    r.agent?.uid ?? "",
    r.agent ? (r.agent.active ? "Active" : "Disabled") : "",
    pkDateTime(r.assigned_at),
    statusLabels[r.status] ?? r.status ?? "",
    r.lost_reason ? (lostReasons[r.lost_reason] ?? r.lost_reason) : "",
    pkDateTime(r.call_due_at),
    pkDateTime(r.first_call_at),
    r.calls.attempts,
    r.calls.answered,
    yesNo(r.calls.answered > 0),
    yesNo(r.calls.interested),
    pkDateTime(r.calls.latest_at),
    r.calls.latest_outcome ?? "",
    r.calls.latest_at ? yesNo(r.calls.latest_answered) : "",
    exportTemperatures[r.temperature?.value] ?? "",
    pkDateTime(r.temperature?.at),
    r.comment?.text ?? "",
    person(r.comment?.by),
    pkDateTime(r.comment?.at),
    followupStates[r.followup?.status] ?? "",
    pkDateTime(r.followup?.due_at),
    r.followups,
    visitStates[r.visit?.status] ?? "",
    pkDateTime(r.visit?.scheduled_at),
    r.visits,
    dealStages[r.deal?.stage] ?? "",
    amount(r.deal?.value),
    r.deals,
    r.won_deals,
    pkDateTime(r.last_activity_at),
  ];
}

export const callHeadings = [
  "Lead #",
  "CRM lead ID",
  "Call time",
  "Made by",
  "Made by role",
  "Lead's agent then",
  "How",
  "Call status",
  "Answered",
  "Duration (seconds)",
  "Outcome",
  "Outcome missing",
  "Temperature saved",
  "Tags",
  "Call notes",
];
export function callRow(c) {
  const finished = c.status === "completed" || c.status === "failed";
  return [
    leadNo(c.lead_no),
    c.lead_id,
    pkDateTime(c.started_at),
    person(c.by),
    roles[c.by?.role] ?? "",
    person(c.filed_under),
    c.method === "manual" ? "Logged by hand" : "Phone system",
    callStates[c.status] ?? c.status ?? "",
    finished ? yesNo(c.answered) : "",
    // Only as recorded: a call still ringing has no duration yet.
    finished ? c.duration_seconds : "",
    c.outcome ?? "",
    c.missing_outcome ? "Yes" : "",
    exportTemperatures[c.temperature] ?? "",
    (c.tags || []).filter((t) => !/^(Hot|Warm|Cold) lead$/.test(t)).join(", "),
    c.notes ?? "",
  ];
}

export const noteHeadings = [
  "Lead #",
  "CRM lead ID",
  "Type",
  "Written",
  "By",
  "By role",
  "About",
  "Note",
];
const noteKinds = {
  note: "Lead note",
  followup: "Follow-up note",
  visit: "Site visit note",
  deal: "Deal note",
};
export function noteRow(n) {
  const a = n.about || {};
  const about =
    n.kind === "followup"
      ? `Follow-up due ${pkDateTime(a.due_at)} (${followupStates[a.status] ?? a.status})`
      : n.kind === "visit"
        ? `Site visit ${pkDateTime(a.scheduled_at)} (${visitStates[a.status] ?? a.status})`
        : n.kind === "deal"
          ? `Deal (${dealStages[a.stage] ?? a.stage})`
          : "";
  return [
    leadNo(n.lead_no),
    n.lead_id,
    noteKinds[n.kind] ?? n.kind,
    pkDateTime(n.at),
    person(n.by),
    roles[n.by?.role] ?? "",
    about,
    n.text ?? "",
  ];
}

export const assignmentHeadings = [
  "Lead #",
  "CRM lead ID",
  "When",
  "From",
  "To",
  "By",
  "First-call deadline",
  "First call",
  "Deadline missed",
  "Reason",
];
export function assignmentRow(a) {
  return [
    leadNo(a.lead_no),
    a.lead_id,
    pkDateTime(a.at),
    a.from ? person(a.from) : "",
    a.to ? person(a.to) : "Administrators (no agent)",
    person(a.by),
    pkDateTime(a.call_due_at),
    pkDateTime(a.first_call_at),
    pkDateTime(a.missed_at),
    a.reason ? a.reason.replaceAll("_", " ") : "",
  ];
}

// Ad quality: the exported leads grouped by the advertisement that created
// them, each lead once. Contacted: at least one answered call. Showed
// interest: at least one call with the outcome Interested, Site visit
// scheduled or Deal discussion, whatever came after. Hot, Warm, Cold: the
// lead's temperature now, so each lead is in one of them or none. With
// follow-ups, site visits (scheduled or completed), deals: at least one;
// won deals: at least one deal won.
export const adQualityHeadings = [
  "Ad attribution",
  "Campaign",
  "Campaign ID",
  "Ad set",
  "Ad set ID",
  "Advertisement",
  "Ad ID",
  "Lead form",
  "Leads",
  "Contacted",
  "Not contacted",
  "Contact rate",
  "Showed interest",
  "Hot",
  "Warm",
  "Cold",
  "No temperature",
  "With follow-ups",
  "With site visits",
  "With deals",
  "With won deals",
];
export function adQuality(rows) {
  const groups = new Map();
  const blank = (label) => ({
    label,
    leads: 0,
    contacted: 0,
    interested: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    none: 0,
    followups: 0,
    visits: 0,
    deals: 0,
    won: 0,
  });
  const total = blank({ origin: "total" });
  for (const r of rows) {
    const ad = r.ad || {};
    // The IDs when recorded, else the names; an ad name from a file has no
    // ID. A lead with nothing recorded is grouped as such, never guessed.
    const key = ad.origin
      ? [
          ad.origin === "file" ? "file" : "meta",
          ad.campaign_id || ad.campaign_name || "",
          ad.adset_id || ad.adset_name || "",
          ad.ad_id || ad.ad_name || "",
          ad.form_id || ad.form_name || "",
        ].join("|")
      : "none";
    if (!groups.has(key)) groups.set(key, blank(ad));
    for (const g of [groups.get(key), total]) {
      g.leads++;
      if (r.calls.answered > 0) g.contacted++;
      if (r.calls.interested) g.interested++;
      g[r.temperature?.value ?? "none"]++;
      if (r.followups > 0) g.followups++;
      if (r.visits > 0) g.visits++;
      if (r.deals > 0) g.deals++;
      if (r.won_deals > 0) g.won++;
    }
  }
  const line = (g, name) => {
    const ad = g.label;
    return [
      name ?? attribution[ad.origin] ?? "None recorded",
      ad.campaign_name ?? "",
      ad.campaign_id ?? "",
      ad.adset_name ?? "",
      ad.adset_id ?? "",
      ad.ad_name ?? "",
      ad.ad_id ?? "",
      ad.form_name ?? "",
      g.leads,
      g.contacted,
      g.leads - g.contacted,
      g.leads ? `${Math.round((100 * g.contacted) / g.leads)}%` : "",
      g.interested,
      g.hot,
      g.warm,
      g.cold,
      g.none,
      g.followups,
      g.visits,
      g.deals,
      g.won,
    ];
  };
  return [
    ...[...groups.values()]
      .sort((a, b) => b.leads - a.leads)
      .map((g) => line(g)),
    ...(rows.length ? [line(total, "All exported leads")] : []),
  ];
}

export const fileHeadings = [
  "File",
  "File type",
  "File ID",
  "Google spreadsheet ID",
  "Sheet tab",
  "Imported first",
  "Rows in the source",
  "New leads created",
  "Repeat inquiries (existing leads)",
  "Rows rejected",
  "Leads in the CRM now",
  "In Deleted leads",
  "No longer in the CRM",
  "Leads in this export",
];
// Each file of the export: the figures the CRM recorded, apart, never
// combined with another file's. Rows in the source: a Sheet's rows at its
// last check, or the rows of the file imported.
export function fileRows(sources, exported) {
  const rows = sources.files
    .filter((f) => exported[f.id] !== undefined)
    .map((f) => [
      f.name,
      fileTypes[f.format] ?? f.format,
      f.id,
      f.sheet?.spreadsheet_id ?? "",
      f.sheet?.worksheet ?? (f.format === "sheets" ? "" : (f.worksheet ?? "")),
      pkDateTime(f.created_at),
      f.rows ?? "",
      f.created ?? "",
      f.repeat ?? "",
      f.rejected ?? "",
      f.in_crm,
      f.deleted,
      f.created == null ? "" : Math.max(0, f.created - f.in_crm - f.deleted),
      exported[f.id],
    ]);
  if (exported.none !== undefined)
    rows.push([
      "No file (added by hand, Meta Lead Ads, WhatsApp, other)",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      Object.values(sources.no_file || {}).reduce((n, x) => n + x, 0),
      "",
      "",
      exported.none,
    ]);
  return rows;
}

// The Read me worksheet: the export, its filters in words, and what the
// columns mean.
const filterWords = {
  assignment: { assigned: "Assigned to an agent", unassigned: "No agent" },
  contacted: {
    yes: "Contacted (at least one answered call)",
    no: "Not contacted (no answered call)",
  },
  temperature: {
    hot: "Hot",
    warm: "Warm",
    cold: "Cold",
    none: "No temperature",
  },
  followup: {
    pending: "Has a pending follow-up",
    overdue: "Has an overdue follow-up",
    completed: "Has a completed follow-up",
    none: "No follow-ups",
  },
  visit: {
    scheduled: "Has a scheduled site visit",
    completed: "Has a completed site visit",
    cancelled: "Has a cancelled or missed site visit",
    none: "No site visits",
  },
  deal: {
    discussion: "Has a deal in discussion",
    negotiation: "Has a deal in negotiation",
    won: "Has a won deal",
    lost: "Has a lost deal",
    none: "No deals",
  },
};
export function filterLines(filters, names) {
  const lines = [];
  const f = filters;
  if (f.files || f.no_file)
    lines.push([
      "Files",
      [
        ...(f.files || []).map((id) => names.files[id] ?? id),
        ...(f.no_file ? ["No file"] : []),
      ].join("; "),
    ]);
  else lines.push(["Files", "All files and leads with no file"]);
  if (f.agent) lines.push(["Agent now", names.agent ?? f.agent]);
  if (f.assignment)
    lines.push(["Assignment now", filterWords.assignment[f.assignment]]);
  if (f.source) lines.push(["Source", f.source]);
  if (f.status) lines.push(["Status now", statusLabels[f.status]]);
  if (f.temperature)
    lines.push(["Temperature now", filterWords.temperature[f.temperature]]);
  if (f.outcome) lines.push(["Latest call outcome", f.outcome]);
  if (f.contacted) lines.push(["Contact", filterWords.contacted[f.contacted]]);
  if (f.followup) lines.push(["Follow-ups", filterWords.followup[f.followup]]);
  if (f.visit) lines.push(["Site visits", filterWords.visit[f.visit]]);
  if (f.deal) lines.push(["Deals", filterWords.deal[f.deal]]);
  if (f.created_from || f.created_to)
    lines.push([
      "Lead created (Pakistan days)",
      `${f.created_from ?? "any day"} to ${f.created_to ?? "today"}`,
    ]);
  if (f.calls_from || f.calls_to)
    lines.push([
      "Had a call (Pakistan days)",
      `${f.calls_from ?? "any day"} to ${f.calls_to ?? "today"}; Call history shows the calls of these days only`,
    ]);
  if (f.had_outcome)
    lines.push([
      "Had a call with the outcome",
      f.had_outcome +
        (f.calls_from || f.calls_to ? " (in those days)" : " (at any time)"),
    ]);
  return lines;
}
export const definitions = [
  [
    "Contacted",
    "At least one answered (connected) call, from anyone, as Reports count answered calls. No answer, Busy, Wrong number and Number off are attempts, not contacts.",
  ],
  [
    "Showed interest",
    "At least one call with the outcome Interested, Site visit scheduled or Deal discussion, whatever came after.",
  ],
  [
    "Temperature",
    "The latest Hot, Warm or Cold saved with a call since the lead came to its current agent, as All leads and the Lead pipeline show it.",
  ],
  [
    "Latest call outcome",
    "The outcome of the lead's most recent call, as the All leads filter reads it.",
  ],
  [
    "File",
    "The Google Sheet or CSV/Excel file that created the lead. A Sheet is identified by its spreadsheet ID and tab, not its name. A repeat inquiry from a customer who was already a lead is counted under Files, not exported as that Sheet's lead.",
  ],
  [
    "Ad attribution",
    "The advertisement that created the lead, as recorded: a Google Sheet row or a Meta Lead Ads submission (campaign, ad set, ad and form with their IDs), or only an ad name from a CSV/Excel file. None recorded: nothing is guessed.",
  ],
  [
    "Leads",
    "Leads in Deleted leads are never exported; leads erased for good no longer exist.",
  ],
  ["Times", "Pakistan time (UTC+5)."],
];
