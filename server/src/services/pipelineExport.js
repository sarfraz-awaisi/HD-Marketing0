import { leadContacts } from "./phoneAccess.js";
import { leadInquiries } from "./sheetsImport.js";
// Lead pipeline export: every agent's Hot, Warm or Cold leads, exactly as
// the administrators' Lead pipeline counts them (update 055, with the
// current assignment's temperature of update 066): leads assigned to an
// agent now that the agent personally contacted. No database update is
// needed: the agents come from admin_pipeline_agents and each agent's leads
// from admin_agent_pipeline, 20 at a time, so the file always agrees with
// the numbers on screen. rpc(name, args) calls one of them for the signed-in
// administrator; the database checks the administrator on every call.
export const exportTemperatures = { hot: "Hot", warm: "Warm", cold: "Cold" };
export const pipelineExportMax = 10000;
const pageSize = 20;
// Every page of a list, each row once. A list read page by page can shift
// while it is read (a lead contacted meanwhile moves to the top), so a row
// can be seen twice or not at all; the pages are read again until the rows
// match the list's own count, and an export never leaves a lead out.
async function allPages(load) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rows = new Map();
    let count = 0;
    for (let page = 1; page <= pipelineExportMax / pageSize + 1; page++) {
      const result = await load(page);
      count = result.count;
      for (const row of result.data)
        if (!rows.has(row.id)) rows.set(row.id, row);
      if (result.data.length < pageSize || rows.size >= count) break;
    }
    if (rows.size === count) return [...rows.values()];
  }
  throw Object.assign(
    new Error(
      "The pipeline changed while the file was being prepared. Export again.",
    ),
    { status: 409 },
  );
}
// Every agent, with their numbers, in the Lead pipeline's order.
export async function pipelineTotals(rpc) {
  const agents = await allPages((page) =>
    rpc("admin_pipeline_agents", { p_query: { page } }),
  );
  const sum = (key) => agents.reduce((n, a) => n + (a[key] || 0), 0);
  return {
    agents,
    totals: { hot: sum("hot"), warm: sum("warm"), cold: sum("cold") },
  };
}
// The leads of one temperature, agent by agent, each with its agent. A lead
// belongs to one agent at a time, so it is written once.
export async function pipelineExportLeads(rpc, temperature) {
  const { agents, totals } = await pipelineTotals(rpc);
  if (totals[temperature] > pipelineExportMax)
    throw Object.assign(
      new Error(
        `There are more than ${pipelineExportMax} ${exportTemperatures[temperature].toLowerCase()} leads to export at once.`,
      ),
      { status: 413 },
    );
  const leads = [];
  for (const agent of agents.filter((a) => a[temperature] > 0))
    for (const lead of await allPages((page) =>
      rpc("admin_agent_pipeline", {
        p_agent: agent.id,
        p_query: { view: "current", temperature, page },
      }),
    ))
      leads.push({ ...lead, agent });
  return leads;
}
// Everything the lead's page shows, added to each lead:
// - full contact numbers, recorded as viewed as in every lead list, at most
//   100 leads at a time (lead_contact_phones);
// - the lead's own record: where and for how much the customer is looking,
//   and why a lost lead was lost;
// - what the customer submitted through advertisements (update 056), read a
//   few leads at a time, the latest inquiry first.
export async function withDetails(db, req, leads) {
  const rows = [];
  for (let i = 0; i < leads.length; i += 100) {
    const batch = await leadContacts(db, req, leads.slice(i, i + 100));
    const { data, error } = await db
      .from("leads")
      .select(
        "id,preferred_location,budget_min,budget_max,lost_reason,lost_note,lost_at",
      )
      .in(
        "id",
        batch.map((r) => r.id),
      );
    if (error)
      throw Object.assign(new Error("Lead details could not be read"), {
        status: 503,
      });
    const record = new Map(data.map((r) => [r.id, r]));
    rows.push(...batch.map((r) => ({ ...r, ...record.get(r.id), id: r.id })));
  }
  for (let i = 0; i < rows.length; i += 8)
    await Promise.all(
      rows.slice(i, i + 8).map(async (row) => {
        row.inquiries = (await leadInquiries(db, req.user, row.id))
          .slice()
          .sort((a, b) => inquiryTime(b) - inquiryTime(a));
      }),
    );
  return rows;
}
const inquiryTime = (item) =>
  new Date(item.submitted_at || item.imported_at || 0).getTime();

export const statusLabels = {
  new: "New",
  contacted: "Contacted",
  interested: "Interested",
  visit_scheduled: "Site visit scheduled",
  visit_done: "Visit done",
  negotiation: "Negotiation",
  won: "Won (booked)",
  lost: "Lost",
};
// "2026-11-16 14:05", in Pakistan time, as spreadsheets sort it.
const pkParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function pkDateTime(value) {
  if (!value) return "";
  const p = Object.fromEntries(
    pkParts.formatToParts(new Date(value)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const lostReasons = {
  price: "Price",
  location: "Location",
  budget: "Budget",
  not_interested: "Not interested",
  no_response: "No response",
  bought_elsewhere: "Bought elsewhere",
  wrong_number: "Wrong number",
  other: "Other",
};
export const platforms = {
  facebook: "Facebook",
  instagram: "Instagram",
  messenger: "Messenger",
  audience_network: "Audience Network",
  other: "Other",
};
// Meta writes multiple-choice answers like 50_lakh_to_1_crore.
const answer = (value) =>
  value === null || value === undefined
    ? ""
    : String(value).replaceAll("_", " ");
const otherAnswers = (extra) =>
  Object.entries(extra && typeof extra === "object" ? extra : {})
    .map(([q, v]) => `${answer(q.replace(/[?_]+$/, ""))}: ${answer(v)}`)
    .join("; ");
export const amount = (value) =>
  value === null || value === undefined || value === "" ? "" : Number(value);
export const leadNo = (value) =>
  /^[1-9]\d*$/.test(String(value ?? ""))
    ? `HD-${String(value).padStart(6, "0")}`
    : "";
export const pipelineExportHeadings = [
  "Lead #",
  "Name",
  "Phone",
  "Phone country",
  "Email",
  "Temperature",
  "Temperature set",
  "Status",
  "Source",
  "Preferred location",
  "Budget from (PKR)",
  "Budget up to (PKR)",
  "Agent",
  "Agent UID",
  "Agent account",
  "Agent's last contact",
  "Last contact outcome",
  "Last call",
  "Last call outcome",
  "Next follow-up",
  "Last activity",
  "Assigned to agent",
  "Lead created",
  "Lost reason",
  "Lost note",
  "Lost on",
  "Agent's latest note",
  "Ad inquiries",
  "Latest ad inquiry",
  "Ad platform",
  "Advertisement",
  "Campaign",
  "Ad form",
  "Ad property interest",
  "Ad budget",
  "Ad city",
  "Other ad answers",
];
// How each column is laid out in Excel (both exports): its width, whether
// long text wraps, and whether it is always text (IDs).
const time = { width: 17 };
export const pipelineExportColumns = {
  "Lead #": { width: 12, text: true },
  Name: { width: 24 },
  Phone: { width: 17, text: true },
  "Phone country": { width: 10 },
  Email: { width: 28 },
  Temperature: { width: 12 },
  "Temperature set": time,
  Status: { width: 20 },
  Source: { width: 10 },
  "Preferred location": { width: 24, wrap: true },
  "Budget from (PKR)": { width: 18 },
  "Budget up to (PKR)": { width: 18 },
  Agent: { width: 22 },
  "Agent UID": { width: 11, text: true },
  "Agent account": { width: 14 },
  "Agent's last contact": time,
  "Last contact outcome": { width: 21 },
  "Last call": time,
  "Last call outcome": { width: 21 },
  "Next follow-up": time,
  "Last activity": time,
  "Assigned to agent": time,
  "Lead created": time,
  "Lost reason": { width: 17 },
  "Lost note": { width: 36, wrap: true },
  "Lost on": time,
  "Agent's latest note": { width: 44, wrap: true },
  "Ad inquiries": { width: 12 },
  "Latest ad inquiry": time,
  "Ad platform": { width: 14 },
  Advertisement: { width: 30, wrap: true },
  Campaign: { width: 28, wrap: true },
  "Ad form": { width: 24, wrap: true },
  "Ad property interest": { width: 26, wrap: true },
  "Ad budget": { width: 20, wrap: true },
  "Ad city": { width: 16 },
  "Other ad answers": { width: 50, wrap: true },
};
export function pipelineExportSheet(rows) {
  return [
    pipelineExportHeadings,
    ...rows.map((r) => {
      const ad = r.inquiries?.[0] || {};
      return [
        leadNo(r.lead_no),
        r.name ?? "",
        r.phone ?? "",
        r.phone_country ?? "",
        r.email ?? "",
        exportTemperatures[r.temperature] ?? "",
        pkDateTime(r.temperature_at),
        statusLabels[r.status] ?? r.status ?? "",
        r.source ?? "",
        r.preferred_location ?? "",
        amount(r.budget_min),
        amount(r.budget_max),
        r.agent.name,
        r.agent.uid ?? "",
        r.agent.active ? "Active" : "Disabled",
        pkDateTime(r.last_contact_at),
        r.last_contact_outcome ?? "",
        pkDateTime(r.last_call_at),
        r.last_call_outcome ?? "",
        pkDateTime(r.next_followup_at),
        pkDateTime(r.last_activity_at),
        pkDateTime(r.assigned_at),
        pkDateTime(r.created_at),
        r.lost_reason ? (lostReasons[r.lost_reason] ?? r.lost_reason) : "",
        r.lost_note ?? "",
        pkDateTime(r.lost_at),
        r.note ?? "",
        r.inquiries?.length || 0,
        pkDateTime(ad.submitted_at || ad.imported_at),
        ad.platform
          ? (platforms[ad.platform] ?? ad.platform) +
            (ad.is_organic ? " (organic)" : "")
          : "",
        ad.ad_name || r.ad_name || "",
        ad.campaign_name ?? "",
        ad.form_name ?? "",
        answer(ad.interest),
        answer(ad.budget),
        ad.city ?? "",
        otherAnswers(ad.extra),
      ];
    }),
  ];
}
// The day in Pakistan, for the file name.
export const pkToday = (now = new Date()) => pkDateTime(now).slice(0, 10);
