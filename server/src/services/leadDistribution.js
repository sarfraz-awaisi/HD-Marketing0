import { createHash } from "node:crypto";
// Assign to agents from the Never assigned page (update 086): up to 2,000
// selected leads, worked through in parts of at most 500, the most update
// 084's function takes in one call, so each call stays well inside the
// database's time limit (8 seconds). Each part has the function's own
// preview, token and stale check; the token shown is one for every part.
// Confirming works every part out again first and moves nothing if any of
// them changed since the preview. A part that changes in the moment between
// that check and its own move is not moved, nor are the parts after it:
// their leads come back as failed, and the parts before it stay assigned.
export const partSize = 500;
const moves = ["assigned", "reassigned"];

// Sorted, so a preview and its confirmation split the leads the same way.
// With several agents each part but the last holds whole rounds (a multiple
// of the number of agents), so shares stay even across parts.
export function parts(ids, agents) {
  const sorted = [...ids].sort();
  if (sorted.length <= partSize) return [sorted];
  const size = partSize - (partSize % agents);
  const out = [];
  for (let i = 0; i < sorted.length; i += size)
    out.push(sorted.slice(i, i + size));
  return out;
}

const joint = (plans) =>
  createHash("md5")
    .update(plans.map((p) => p.token).join(","))
    .digest("hex");

// One result in the function's own shape, counted again from the leads.
export function merge(plans, state) {
  const rows = plans.flatMap((p) => p.results);
  const count = (kind) => rows.filter((r) => r.result === kind).length;
  const from = new Map();
  for (const r of rows)
    if (r.result === "reassigned") {
      const name = r.from_name || "an agent";
      const key = `${r.from}|${name}`;
      from.set(key, {
        id: r.from,
        name,
        count: (from.get(key)?.count || 0) + 1,
      });
    }
  const text = (v) => v ?? "￿";
  return {
    ...state,
    never_assigned: true,
    assigned: count("assigned"),
    reassigned: count("reassigned"),
    skipped: 0,
    kept: count("kept"),
    failed: count("failed"),
    agents: plans[0].agents.map((a) => {
      const mine = rows.filter(
        (r) => moves.includes(r.result) && r.agent === a.id,
      );
      const assigned = mine.filter((r) => r.result === "assigned").length;
      return {
        ...a,
        kept: 0,
        assigned,
        reassigned: mine.length - assigned,
        total: mine.length,
      };
    }),
    moved_from: [...from.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    results: rows.sort(
      (a, b) =>
        a.result.localeCompare(b.result) ||
        text(a.name).localeCompare(text(b.name)) ||
        a.id.localeCompare(b.id),
    ),
  };
}

// Leads of parts not carried out: a planned move is reported as failed.
const notMoved = (plan, reason) => ({
  ...plan,
  results: plan.results.map((r) =>
    moves.includes(r.result)
      ? {
          id: r.id,
          name: r.name,
          result: "failed",
          reason,
        }
      : r,
  ),
});

// call(ids, apply, token) runs update 084's function on one part; agents
// are the chosen agents' IDs.
export async function distributeInParts(call, { ids, agents, apply, token }) {
  const groups = parts(ids, agents.length);
  if (groups.length === 1) return call(groups[0], apply, token ?? null);
  const plans = [];
  for (const group of groups) plans.push(await call(group, false, null));
  const now = joint(plans);
  if (!apply || (token && token !== now))
    return merge(plans, {
      applied: false,
      stale: !!token && token !== now,
      token: now,
    });
  const done = [];
  for (const [i, group] of groups.entries()) {
    let result;
    try {
      result = await call(group, true, plans[i].token);
    } catch (error) {
      if (!i) throw error;
      result = null;
    }
    if (result?.applied) {
      done.push(result);
      continue;
    }
    // Changed since the check: nothing moved yet, the new plan to confirm.
    if (!i) {
      const fresh = [result, ...plans.slice(1)];
      return merge(fresh, { applied: false, stale: true, token: joint(fresh) });
    }
    const reason = result
      ? "Changed while the leads were being assigned: not assigned. Check it and assign it again."
      : "The CRM could not finish assigning: not assigned. Check it and assign it again.";
    return merge(
      [
        ...done,
        notMoved(result || plans[i], reason),
        ...plans.slice(i + 1).map((p) => notMoved(p, reason)),
      ],
      { applied: true, stale: false, partial: true, token: now },
    );
  }
  return merge(done, { applied: true, stale: false, token: now });
}
