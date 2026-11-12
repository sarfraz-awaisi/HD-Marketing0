// Update 061: a lead reassigned from another agent opens a fresh workspace
// for its new agent. The database decides what belongs to the current
// assignment (workspace_state on each record, agent_workspaces for leads);
// this shapes what the API returns to agents. Administrators always get the
// full history. Before update 061 nothing changes.
const missing = (error) => ["PGRST202", "42883"].includes(error?.code);
const ready = new WeakMap();
function failed() {
  return Object.assign(
    new Error("The lead could not be loaded. Please try again."),
    { status: 503 },
  );
}
// Whether update 061 is installed; once it is, it stays installed.
export async function workspaceReady(db, user) {
  if (user.role !== "agent") return false;
  if (ready.get(db)) return true;
  const { error } = await db.rpc("agent_workspaces", {
    p_actor: user.id,
    p_leads: [],
  });
  if (error && !missing(error)) throw failed();
  if (!error) ready.set(db, true);
  return !error;
}
// The workspace of each of the agent's leads, by id; null before 061.
export async function agentWorkspaces(db, user, ids) {
  const leads = [...new Set(ids.filter(Boolean))];
  if (user.role !== "agent" || !leads.length) return new Map();
  const { data, error } = await db.rpc("agent_workspaces", {
    p_actor: user.id,
    p_leads: leads,
  });
  if (error) {
    if (missing(error)) return null;
    throw failed();
  }
  ready.set(db, true);
  return new Map(Object.entries(data || {}));
}
// A lead as its agent sees it: the stage of this assignment, the earlier
// assignment's lost reason and note left out, and the indicators.
export function workspaceLead(lead, ws) {
  if (!ws) return lead;
  return {
    ...lead,
    status: ws.status,
    ...(ws.first_call_reopened
      ? { lost_reason: null, lost_note: null, lost_at: null }
      : {}),
    reassigned: ws.reassigned,
    reassigned_at: ws.since,
    previous_result: ws.previous_result,
    first_call_reopened: ws.first_call_reopened,
  };
}
export async function workspaceLeads(db, user, leads) {
  const spaces = await agentWorkspaces(
    db,
    user,
    leads.map((lead) => lead.id),
  );
  return spaces
    ? leads.map((lead) => workspaceLead(lead, spaces.get(lead.id)))
    : leads;
}
// States a list keeps for an agent: earlier assignments' records are left
// out by the database query itself, so pages and counts stay exact.
export const shownStates = ["current", "carried"];
// Records as the agent sees them: a carried-over commitment keeps its time,
// status and property, never the earlier comments.
export function workspaceRecords(rows) {
  return rows
    .filter((row) => row.workspace_state !== "hidden")
    .map(({ workspace_state: state, ...row }) =>
      state === "carried" ? { ...row, notes: null, carried_over: true } : row,
    );
}
// What an agent may change on a carried-over commitment; nothing on an
// earlier assignment's other records. The database checks the same.
const carriedFields = {
  followups: ["due_at", "status"],
  visits: ["scheduled_at", "status", "property_id"],
  deals: [
    "stage",
    "expected_value",
    "close_date",
    "property_id",
    "lost_reason",
    "lost_note",
  ],
};
export function earlierWorkRefusal(table, state, fields) {
  if (state === "hidden")
    return "This was recorded during an earlier assignment of this lead and cannot be changed.";
  if (
    state === "carried" &&
    fields.some((field) => !carriedFields[table]?.includes(field))
  )
    return "Comments from an earlier assignment cannot be changed. Add a note of your own instead.";
  return null;
}
