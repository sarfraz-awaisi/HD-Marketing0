import { temperatureOf } from "./temperature";
// Update 075: Lead Usage, the number of different agents a lead has been
// assigned to (never the admin team, never the same agent twice), and what
// each agent did while they had it. The choices are exact: Used 3 Times is
// three agents, not three or more.
export const usageChoices = [2, 3, 4, 5];
export const usageOption = (n) => `Used ${n} Times`;
export const usedTimes = (n) =>
  `Used ${n} ${Number(n) === 1 ? "time" : "times"}`;
// Outcomes of a call where the customer answered and said something.
const responses = [
  "Interested",
  "Not interested",
  "Follow-up required",
  "Site visit scheduled",
  "Deal discussion",
  "Closed lost",
];
export const recordKinds = [
  "calls",
  "notes",
  "status_changes",
  "followups",
  "visits",
  "deals",
];
// Who saved a record: its first audit entry, or the row itself for stage
// changes. Null when no record of it was kept.
export const recordedBy = (kind, item) =>
  ({
    calls: item.recorded_by,
    notes: item.written_by,
    status_changes: item.by,
    followups: item.created_by,
    visits: item.created_by,
    deals: item.created_by,
  })[kind] ?? null;
// When a record was saved, which is what places it in a period.
export const savedAt = (kind, item) =>
  ({
    calls: item.saved_at,
    notes: item.at,
    status_changes: item.at,
  })[kind] ?? item.created_at;
// Every record of a period, oldest first.
export const periodRecords = (period) =>
  recordKinds
    .flatMap((kind) => (period[kind] || []).map((item) => ({ kind, item })))
    .sort((a, b) =>
      savedAt(a.kind, a.item).localeCompare(savedAt(b.kind, b.item)),
    );
// A period's work by its own agent. Whatever an administrator (or anyone
// else) saved meanwhile is counted apart, never as the agent's.
export function periodWork(period) {
  const agent = period.agent_id;
  const mine = (kind) =>
    agent
      ? (period[kind] || []).filter((x) => recordedBy(kind, x) === agent)
      : [];
  const calls = mine("calls");
  const connected = calls.filter((c) => c.connected);
  const responded = connected.filter((c) => responses.includes(c.outcome));
  const followups = mine("followups");
  const records = periodRecords(period);
  const own = agent
    ? records.filter((r) => recordedBy(r.kind, r.item) === agent).length
    : 0;
  const outcomes = [];
  for (const c of calls) {
    const label = c.outcome || "No outcome saved";
    const found = outcomes.find((o) => o.outcome === label);
    if (found) found.count++;
    else outcomes.push({ outcome: label, count: 1 });
  }
  return {
    calls,
    connected,
    responded,
    followups,
    followupsDone: followups.filter((f) => f.status === "completed"),
    others: records.length - own,
    own,
    outcomes,
    temperatures: calls
      .map((c) => (c.tags || []).map(temperatureOf).find(Boolean)?.value)
      .filter(Boolean),
    level: !own
      ? "never"
      : responded.length
        ? "responded"
        : connected.length
          ? "contacted"
          : calls.length
            ? "attempted"
            : "other",
  };
}
// Across every period: how many different agents had the lead, how many of
// them saved any work on it, and how many reached the customer.
export function historySummary(history) {
  const agents = new Map();
  for (const period of history.periods || []) {
    if (!period.agent_id) continue;
    const work = periodWork(period);
    const seen = agents.get(period.agent_id) || {
      worked: false,
      reached: false,
    };
    seen.worked ||= work.own > 0;
    seen.reached ||= work.connected.length > 0;
    agents.set(period.agent_id, seen);
  }
  const list = [...agents.values()];
  return {
    used: history.agents_used ?? agents.size,
    worked: list.filter((a) => a.worked).length,
    reached: list.filter((a) => a.reached).length,
  };
}
// Precise wording: assigned is not worked, and worked is not reached.
export function summaryText({ used, worked, reached }) {
  if (!used) return "Not assigned to any agent yet.";
  if (used === 1)
    return worked
      ? `Assigned to 1 agent, who saved work on it and ${reached ? "reached" : "did not reach"} the customer.`
      : "Assigned to 1 agent, who saved no work on it.";
  const first = `Assigned to ${used} different agents.`;
  if (!worked) return `${first} None of them saved any work on it.`;
  const part = (n) => (n === used ? "All" : String(n));
  return `${first} ${part(worked)} of them saved work on it; ${
    reached ? `${part(reached).toLowerCase()} reached` : "none reached"
  } the customer.`;
}
