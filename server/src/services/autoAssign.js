import { salesRpc } from "../routes/sales.routes.js";
// Update 091: automatic lead distribution. The database's own message for a
// setting changed meanwhile (HA409); anything else as every sales call.
export async function autoAssignRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const custom = /^HA(\d{3})$/.exec(error.code || "");
  if (custom)
    throw Object.assign(new Error(error.message), {
      status: Number(custom[1]),
    });
  return salesRpc(
    { rpc: async () => ({ error }) },
    name,
    args,
    "091 after 090",
  );
}

// Complete batches one database call at a time (each batch is all or
// nothing), while another is waiting: at most 10 batches and 500 leads, the
// most one bulk action takes, per run. p_actor: the administrator pressing
// Run now, or null for the worker.
export async function runAutoAssign(
  db,
  actor,
  request,
  { maxBatches = 10, maxLeads = 500 } = {},
) {
  const batches = [];
  let last;
  while (batches.length < maxBatches) {
    last = await autoAssignRpc(db, "auto_assign_run", {
      p_actor: actor,
      p_request: request,
    });
    if (last?.status !== "assigned") break;
    batches.push(last);
    const done = batches.reduce((n, b) => n + b.assigned, 0);
    if (!last.more || done + last.assigned > maxLeads) break;
  }
  return {
    status: batches.length ? "assigned" : last?.status,
    reason: batches.length ? undefined : last?.reason,
    waiting: last?.waiting,
    assigned: batches.reduce((n, b) => n + b.assigned, 0),
    batches: batches.map(({ batch_id, assigned, allocation }) => ({
      batch_id,
      assigned,
      allocation,
    })),
  };
}
