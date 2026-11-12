import { lostReasonLabel, statusLabel, statuses } from "./pipeline";
// Report drill-down (update 050): what each report number is called, what it
// counts, and the number the report showed. The server lists the records
// using the report's own conditions; these words describe the same rules.
// Update 051: agents open their own numbers ("own", worded as "you"), and
// the dashboard's Today's calling numbers open as the "today" report.
export const sourceName = (s) =>
  s === "CSV" ? "CSV / Excel" : s || "No source";
const summary = {
  total_leads: ["All leads", "Every lead, whenever it was created."],
  assigned_leads: [
    "Assigned leads",
    "Every lead that matches the agent and source filters, whenever it was created.",
  ],
  leads: ["Leads created", "Leads created in this range."],
  today_completed_calls: [
    "Calls completed today",
    "Calls completed today (Pakistan time), whatever range is chosen.",
  ],
  completed_calls: [
    "Completed calls",
    "Calls completed in this range, by the time they ended.",
  ],
  completed_visits: [
    "Completed visits",
    "Site visits completed, by their scheduled time in this range.",
  ],
  won_deals: ["Won deals", "Won deals closed in this range, by close date."],
  revenue: [
    "Won revenue",
    "The won deals closed in this range; revenue adds up their value.",
  ],
  due_followups: [
    "Follow-ups due",
    "Pending follow-ups due from the start of today until 24 hours from now.",
  ],
  overdue_followups: [
    "Overdue follow-ups",
    "Pending follow-ups past their due time.",
  ],
  scheduled_visits: ["Upcoming visits", "Scheduled site visits from now on."],
  first_calls: [
    "First calls",
    "First calls made in this range, one for each assignment.",
  ],
  on_time_first_calls: [
    "On-time first calls",
    "First calls made in this range before their deadline.",
  ],
  first_calls_with_deadline: [
    "First calls with a deadline",
    "First calls made in this range that had a deadline, on time or late.",
  ],
  avg_first_call_minutes: [
    "First-call speed",
    "First calls made in this range; the average counts working minutes from assignment to call.",
  ],
  missed_in_period: [
    "First-call deadlines missed",
    "Assignments whose first-call deadline was missed in this range.",
  ],
  uncalled_leads: [
    "Waiting for a first call",
    "Leads not called yet whose first-call deadline has not passed.",
  ],
  missed_first_calls: [
    "Missed first calls",
    "Leads not called yet whose first-call deadline has passed.",
  ],
  leads_contacted: [
    "Contacted leads",
    "Leads with at least one call started in this range, each counted once.",
  ],
  followups_completed: [
    "Completed follow-ups",
    "Follow-ups completed in this range.",
  ],
};
// Summary numbers that count something other than leads or their activity.
export const summaryNotes = {
  active_agents: {
    title: "Active agents",
    about:
      "This counts active agent accounts, not leads, so it has no lead list.",
    link: ["/team", "Open employee management"],
  },
  deleted_today: {
    title: "Leads deleted today",
    about:
      "Deleted leads are left out of every report. They are listed in the deleted leads bin.",
    link: ["/deleted-leads", "Open deleted leads"],
  },
};
export const summaryLabel = (metric) =>
  summary[metric]?.[0] ||
  summaryNotes[metric]?.title ||
  metric.replaceAll("_", " ");
// Agents' summaries leave out the numbers that are not about their work.
export const canOpenSummary = (metric, own = false) =>
  metric in summary || (!own && metric in summaryNotes);
// The same words for an agent looking at their own numbers.
const yours = {
  total_leads: [
    "All my leads",
    "Every lead assigned to you, whenever it was created.",
  ],
  assigned_leads: [
    "My leads",
    "Every lead assigned to you that matches the source filter, whenever it was created.",
  ],
};
const personal = (text) =>
  text
    .replace(/\bThis agent's\b/g, "Your")
    .replace(/\bthis agent's\b/g, "your")
    .replace(/\bthis agent\b/g, "you");
const sources = {
  leads: ["Leads", "Leads from this source created in this range."],
  contacted: [
    "Contacted",
    "Leads from this source created in this range that have had a call at any time.",
  ],
  visited: [
    "Visited",
    "Leads from this source created in this range with a completed site visit.",
  ],
  won: [
    "Won",
    "Leads from this source created in this range that are now won.",
  ],
  lost: [
    "Lost",
    "Leads from this source created in this range that are now lost.",
  ],
  revenue: [
    "Won revenue",
    "Leads from this source created in this range with a won deal; revenue adds up the deals' value.",
  ],
};
const agents = {
  assigned: [
    "Assigned",
    "Leads assigned to this agent in this range. A lead assigned twice appears twice.",
  ],
  first_calls: [
    "First calls",
    "This agent's first calls on assigned leads, made in this range.",
  ],
  on_time_first_calls: [
    "On-time first calls",
    "This agent's first calls made in this range before their deadline.",
  ],
  first_calls_with_deadline: [
    "First calls with a deadline",
    "This agent's first calls made in this range that had a deadline, marked on time or late.",
  ],
  avg_first_call_minutes: [
    "First-call speed",
    "This agent's first calls made in this range; the average counts working minutes.",
  ],
  missed_first_calls: [
    "Missed first calls",
    "Assignments to this agent whose first-call deadline passed in this range.",
  ],
  calls: [
    "Calls",
    "Calls started in this range and recorded under this agent. “Called by” shows who actually made each call.",
  ],
  connected_calls: [
    "Answered calls",
    "Completed calls recorded under this agent that ended in this range.",
  ],
  talk_minutes: [
    "Talk time",
    "This agent's answered calls in this range; talk time adds up their length.",
  ],
  visits_completed: [
    "Visits done",
    "Site visits by this agent completed in this range.",
  ],
  won_deals: ["Won deals", "This agent's won deals closed in this range."],
  revenue: [
    "Won revenue",
    "This agent's won deals closed in this range; revenue adds up their value.",
  ],
  lost: [
    "Lost",
    "This agent's current leads that were marked lost in this range.",
  ],
};
// call_activity (update 038): the dashboard's Today's calling numbers.
const today = {
  calls_today: [
    "Calls today",
    "Calls this agent recorded that started today (Pakistan time). An administrator's calls on the agent's leads are counted apart (update 063).",
  ],
  connected_today: [
    "Answered calls today",
    "Calls this agent recorded today that were answered.",
  ],
  first_calls_today: [
    "First calls today",
    "This agent's leads that had their first call today.",
  ],
  waiting: [
    "Waiting for a first call",
    "This agent's leads not called yet whose first-call deadline has not passed.",
  ],
  missed: [
    "Missed first call",
    "This agent's open leads not called yet in their current assignment, past the first-call deadline.",
  ],
  idle: [
    "No recent activity",
    "This agent's open leads with no activity for the set number of days and no follow-up planned.",
  ],
  followups_overdue: [
    "Overdue follow-ups",
    "Pending follow-ups on this agent's leads that are past their due time.",
  ],
};
export const todayMetrics = Object.keys(today);
export const kindNouns = {
  lead: ["lead", "leads"],
  call: ["call", "calls"],
  visit: ["visit", "visits"],
  deal: ["deal", "deals"],
  followup: ["follow-up", "follow-ups"],
  assignment: ["assignment", "assignments"],
};
// Title and definition of one report number. names: agent id -> name; own:
// an agent's own numbers.
export function drillInfo(report, metric, key, names = {}, own = false) {
  const info = wording(report, metric, key, names, own);
  return own ? { ...info, about: personal(info.about) } : info;
}
function wording(report, metric, key, names, own) {
  const agent = key ? names[key] || "Former agent" : "No agent";
  if (report === "today") {
    const [title, about] = today[metric];
    return { title: own ? title : `${agent}: ${title}`, about };
  }
  if (report === "summary" && own && yours[metric]) {
    const [title, about] = yours[metric];
    return { title, about };
  }
  if (report === "summary") {
    if (metric === "by_status")
      return {
        title: `${statusLabel(key)} leads`,
        about: `Leads created in this range whose current status is ${statusLabel(key)}.`,
      };
    const [title, about] = summary[metric] || [summaryLabel(metric), ""];
    return { title, about };
  }
  if (report === "sources") {
    const [title, about] = sources[metric];
    return { title: `${sourceName(key)}: ${title}`, about };
  }
  if (report === "agents") {
    const [title, about] = agents[metric];
    return { title: own ? title : `${agent}: ${title}`, about };
  }
  if (report === "funnel")
    return metric === "lost"
      ? {
          title: "Lost leads",
          about: "Leads created in this range that are now lost.",
        }
      : metric === "total"
        ? { title: "All leads", about: "Leads created in this range." }
        : {
            title: `${statusLabel(key)} leads`,
            about: `Leads created in this range that reached ${statusLabel(key)} or a later stage at any time, even if they have since moved back or been lost.`,
          };
  const lost = "Leads marked lost in this range";
  if (metric === "reason")
    return {
      title: `Lost: ${lostReasonLabel(key)}`,
      about: `${lost} with this reason.`,
    };
  if (metric === "source")
    return {
      title: `Lost from ${sourceName(key)}`,
      about: `${lost} from this source.`,
    };
  if (metric === "agent")
    return {
      title: `Lost: ${agent}`,
      about: `${lost}, by the agent they are assigned to now.`,
    };
  return { title: "Lost leads", about: `${lost}.` };
}
const find = (list, test) => (Array.isArray(list) ? list.find(test) : null);
// The number the report shows for this drill-down, or undefined.
export function reportNumber(report, data, metric, key) {
  if (!data) return undefined;
  if (report === "today")
    return find(data.agents, (a) => a.agent_id === key)?.[metric];
  if (report === "summary")
    return metric === "by_status" ? (data.by_status?.[key] ?? 0) : data[metric];
  if (report === "sources")
    return find(data, (r) => (r.source ?? null) === key)?.[metric];
  if (report === "agents")
    return find(data, (r) => r.agent_id === key)?.[metric];
  if (report === "funnel")
    return metric === "stage"
      ? find(data.stages, (s) => s.stage === key)?.reached
      : data[metric];
  if (metric === "total") return data.total;
  const [list, field] = {
    reason: [data.by_reason, "reason"],
    source: [data.by_source, "source"],
    agent: [data.by_agent, "agent_id"],
  }[metric] || [[], ""];
  return find(list, (r) => (r[field] ?? null) === key)?.count;
}
// Neighbouring numbers offered inside a drill-down, to switch between them.
export function relatedNumbers(report, data, metric, key) {
  if (!data) return [];
  const item = (m, k, label, value) => ({ metric: m, key: k, label, value });
  if (report === "today") {
    const row = find(data.agents, (a) => a.agent_id === key);
    return row
      ? todayMetrics.map((m) => item(m, key, today[m][0], row[m]))
      : [];
  }
  if (report === "summary" && metric === "by_status")
    return statuses.map((s) =>
      item("by_status", s, statusLabel(s), data.by_status?.[s] ?? 0),
    );
  if (report === "funnel")
    return [
      ...(Array.isArray(data.stages) ? data.stages : []).map((s) =>
        item("stage", s.stage, statusLabel(s.stage), s.reached),
      ),
      item("lost", undefined, "Lost", data.lost),
    ];
  if (report === "sources") {
    const row = find(data, (r) => (r.source ?? null) === key);
    return row
      ? ["leads", "contacted", "visited", "won", "lost"].map((m) =>
          item(m, key, sources[m][0], row[m]),
        )
      : [];
  }
  if (report === "agents") {
    const row = find(data, (r) => r.agent_id === key);
    return row
      ? [
          "assigned",
          "first_calls",
          "missed_first_calls",
          "calls",
          "connected_calls",
          "visits_completed",
          "won_deals",
          "lost",
        ].map((m) => item(m, key, agents[m][0], row[m]))
      : [];
  }
  if (report === "lost") {
    const groups = {
      reason: [data.by_reason, "reason", (r) => lostReasonLabel(r.reason)],
      source: [data.by_source, "source", (r) => sourceName(r.source)],
      agent: [data.by_agent, "agent_id", (r) => r.name],
    };
    if (!groups[metric]) return [];
    const [list, field, label] = groups[metric];
    return (Array.isArray(list) ? list : []).map((r) =>
      item(metric, r[field] ?? null, label(r), r.count),
    );
  }
  return [];
}
