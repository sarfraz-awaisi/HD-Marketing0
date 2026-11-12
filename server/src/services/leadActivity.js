import { followUpOutcome } from "../utils/validators.js";
import { workspaceReady } from "./leadWorkspace.js";
// Lead follow-ups and activity. Nothing here adds a table: follow-ups stay in
// followups (saved through crm_mutate, which checks the lead owner and writes
// the audit entry), and "who did what" comes from the existing audit_log.
function unwrap(result) {
  if (result.error)
    throw Object.assign(new Error("Request failed"), { status: 500 });
  return result.data;
}
// A follow-up promised on a call. The same pending time for the same lead is
// never saved twice (for example when a call form is submitted again).
export async function scheduleFollowUp(db, mutate, req, leadId, dueAt, notes) {
  const due = new Date(dueAt).toISOString();
  const existing = unwrap(
    await db
      .from("followups")
      .select("*")
      .eq("lead_id", leadId)
      .eq("status", "pending")
      .eq("due_at", due)
      .limit(1),
  );
  if (existing?.length) return { ...existing[0], duplicate: true };
  return mutate(req, "followups", null, {
    lead_id: leadId,
    due_at: due,
    status: "pending",
    ...(notes ? { notes: notes.slice(0, 4000) } : {}),
  });
}
// Notes for a follow-up made from a call: what was agreed on the call.
export const callFollowUpNotes = (call) =>
  [`Call outcome: ${call.outcome}`, call.notes?.trim()]
    .filter(Boolean)
    .join(" · ");
const auditActions = {
  notes: ["create"],
  followups: ["create", "update"],
  visits: ["create", "update"],
  deals: ["create", "update"],
  calls: ["create", "update", "call.manual_logged"],
};
const fieldLabels = {
  due_at: "follow-up time",
  scheduled_at: "visit time",
  status: "status",
  notes: "notes",
  outcome: "outcome",
  deal_tags: "lead tags",
  stage: "stage",
  expected_value: "value",
  close_date: "close date",
  name: "name",
  email: "email",
  source: "source",
  property_id: "property",
  budget_min: "minimum budget",
  budget_max: "maximum budget",
  preferred_location: "preferred location",
  lost_reason: "lost reason",
  lost_note: "lost note",
};
const fieldsOf = (entry) =>
  (Array.isArray(entry?.metadata?.fields) ? entry.metadata.fields : [])
    .filter(
      (f) =>
        !["outcome_submitted_at", "missing_outcome", "ended_at"].includes(f),
    )
    .map((f) => fieldLabels[f] || f.replaceAll("_", " "));
// Adds to each timeline item who did it (actor) and, for follow-ups, visits
// and deals, who is responsible; adds later changes from the audit log; and
// adds lead detail edits that have no row of their own. Historical items get
// the same details, because the audit log has recorded every change. With
// since (update 061: an agent's current assignment), changes made before it
// are left out.
export async function enrichTimeline(db, lead, items, since = null) {
  const byTable = {};
  for (const item of items)
    if (auditActions[item.kind]) (byTable[item.kind] ||= []).push(item.id);
  const [entries, leadEntries] = await Promise.all([
    Promise.all(
      Object.entries(byTable).map(async ([table, ids]) =>
        unwrap(
          await db
            .from("audit_log")
            .select("entity,entity_id,actor_id,action,created_at,metadata")
            .eq("entity", table)
            .in("entity_id", ids.map(String))
            .in("action", auditActions[table])
            .order("created_at", { ascending: true }),
        ),
      ),
    ).then((lists) => lists.flat()),
    (async () =>
      unwrap(
        await db
          .from("audit_log")
          .select("entity,entity_id,actor_id,action,created_at,metadata")
          .eq("entity", "leads")
          .eq("entity_id", String(lead.id))
          .in("action", ["update", "lead.phone_changed"])
          .order("created_at", { ascending: true }),
      ))(),
  ]);
  const people = new Set();
  for (const e of [...entries, ...leadEntries])
    if (e.actor_id) people.add(e.actor_id);
  for (const item of items)
    for (const key of ["agent_id", "actor_id"])
      if (item[key]) people.add(item[key]);
  const names = new Map(
    people.size
      ? unwrap(
          await db
            .from("profiles")
            .select("id,name")
            .in("id", [...people]),
        ).map((p) => [p.id, p.name])
      : [],
  );
  const name = (id) => (id ? names.get(id) || "Former employee" : null);
  const current = (e) =>
    !since || Date.parse(e.created_at) >= Date.parse(since);
  const audits = new Map();
  for (const e of entries.filter(current)) {
    const key = e.entity + ":" + e.entity_id;
    (audits.get(key) || audits.set(key, []).get(key)).push(e);
  }
  const enriched = items.map((item) => {
    const log = audits.get(item.kind + ":" + item.id) || [];
    const created = log.find(
      (e) => e.action === "create" || e.action === "call.manual_logged",
    );
    // The actor is whoever the audit log (or the row itself, for assignments
    // and stage changes) recorded. agent_id is never used as the actor: it is
    // the lead's agent even when an administrator acted. Without a record the
    // actor is left out rather than guessed.
    const actor =
      item.kind === "assignments" || item.kind === "lead_status_history"
        ? item.actor_id
        : created?.actor_id;
    return {
      ...item,
      actor_name: name(actor),
      ...(["followups", "visits", "deals", "assignments", "calls"].includes(
        item.kind,
      )
        ? { agent_name: name(item.agent_id) }
        : {}),
      updates: log
        .filter((e) => e.action === "update")
        .map((e) => ({
          at: e.created_at,
          actor_name: name(e.actor_id),
          fields: fieldsOf(e),
        }))
        .filter((u) => u.fields.length),
    };
  });
  // Lead detail edits. Stage changes already have their own history rows.
  for (const e of leadEntries.filter(current)) {
    const fields =
      e.action === "lead.phone_changed"
        ? ["phone number"]
        : fieldsOf(e).filter(
            (f) => !["status", "lost reason", "lost note"].includes(f),
          );
    if (fields.length)
      enriched.push({
        kind: "lead_update",
        id: `${e.action}:${e.created_at}`,
        lead_id: lead.id,
        created_at: e.created_at,
        actor_name: name(e.actor_id),
        fields,
      });
  }
  return enriched.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
// Leads whose latest call ended with "Follow-up required" but have no
// follow-up scheduled since: calls logged before follow-ups could be scheduled
// from the call form, or follow-ups that were never created. They are listed
// for the owner (all for administrators) to schedule; no date is guessed. An
// agent's list leaves out calls from an earlier assignment (update 061).
export async function unscheduledFollowUps(db, user, cap = 100) {
  const scoped = await workspaceReady(db, user);
  let query = db
    .from("calls")
    .select(
      "id,lead_id,started_at,created_at,outcome," +
        (scoped ? "workspace_state," : "") +
        "leads!inner(lead_no,name,status,assigned_agent,deleted_at)",
    )
    .eq("outcome", followUpOutcome)
    .is("leads.deleted_at", null);
  if (user.role !== "admin") query = query.eq("leads.assigned_agent", user.id);
  if (scoped) query = query.in("workspace_state", ["current"]);
  const flagged = unwrap(
    await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(500),
  );
  const leads = new Map();
  for (const call of flagged)
    if (
      !leads.has(call.lead_id) &&
      !["won", "lost"].includes(call.leads?.status)
    )
      leads.set(call.lead_id, call);
  const ids = [...leads.keys()].slice(0, cap);
  if (!ids.length) return { data: [], count: 0 };
  const [calls, followups] = await Promise.all([
    db
      .from("calls")
      .select("lead_id,created_at,outcome")
      .in("lead_id", ids)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .then(unwrap),
    db
      .from("followups")
      .select("lead_id,status,created_at")
      .in("lead_id", ids)
      .then(unwrap),
  ]);
  const latest = new Map();
  for (const call of calls)
    if (!latest.has(call.lead_id)) latest.set(call.lead_id, call);
  const data = ids
    .map((id) => leads.get(id))
    .filter((call) => {
      if (latest.get(call.lead_id)?.outcome !== followUpOutcome) return false;
      return !followups.some(
        (f) =>
          f.lead_id === call.lead_id &&
          (f.status === "pending" ||
            Date.parse(f.created_at) >= Date.parse(call.created_at)),
      );
    })
    .map((call) => ({
      lead_id: call.lead_id,
      lead_no: call.leads.lead_no,
      name: call.leads.name,
      assigned_agent: call.leads.assigned_agent,
      call_id: call.id,
      called_at: call.started_at || call.created_at,
    }))
    .sort((a, b) => a.called_at.localeCompare(b.called_at));
  return { data, count: data.length, capped: leads.size > cap };
}
