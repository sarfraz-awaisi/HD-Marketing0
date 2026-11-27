import { createHash } from "node:crypto";
// Assign to agents (update 086; any list and any number of leads since
// update 087): the selected leads are worked through in parts of at most
// 500, the most the database's functions take in one call, so each call
// stays well inside the database's time limit (8 seconds). Each part has
// the function's own preview, token and stale check; the token shown is
// one for every part. Confirming works every part out again first and
// moves nothing if any of them changed since the preview. A part that
// changes in the moment between that check and its own move is not moved,
// nor are the parts after it: their leads come back as failed, and the
// parts before it stay assigned.
export const partSize = 500;
const moves = ["assigned", "reassigned"];

// Sorted, so a preview and its confirmation split the leads the same way.
// With several agents each part but the last holds whole rounds (a multiple
// of the number of agents), so shares stay even across parts.
export const wholeRounds = (agents) =>
  partSize - (partSize % Math.max(1, agents));
export function parts(ids, agents) {
  const sorted = [...ids].sort();
  if (sorted.length <= partSize) return [sorted];
  const size = wholeRounds(agents);
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
  // Each agent keeps the leads already theirs (skipped, update 062); leads
  // kept elsewhere (updates 082 and 084) are nobody's share.
  return {
    ...state,
    ...(plans[0].never_assigned ? { never_assigned: true } : {}),
    assigned: count("assigned"),
    reassigned: count("reassigned"),
    skipped: count("skipped"),
    kept: count("kept"),
    failed: count("failed"),
    agents: plans[0].agents.map((a) => {
      const mine = rows.filter((r) => r.agent === a.id);
      const n = (kind) => mine.filter((r) => r.result === kind).length;
      return {
        ...a,
        kept: n("skipped"),
        assigned: n("assigned"),
        reassigned: n("reassigned"),
        total: n("skipped") + n("assigned") + n("reassigned"),
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

// call(ids, apply, token) runs the list's function (updates 062, 082 and
// 084) on one part; agents are the chosen agents' IDs.
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

// Never Worked (update 090): how many of the selected leads to take from
// each current agent, unassigned leads as a group of their own. The plan
// for every selected lead is worked out first, as a preview; from each
// group, of the leads that plan can move, the newest are taken first
// (highest HD number), as many as asked, and only those go through Assign
// to agents with its own preview, token and stale check. The rest stay
// where they are. A number above what a group can give takes nothing from
// any group (over). The token covers the whole plan, the leads taken and
// their plan, so confirming moves nothing if any selected lead, its group
// or the numbers changed since the preview: the new plan comes back.
const sourceKey = (id) => id ?? "unassigned";
export function takeByQuotas(results, quotas) {
  const groups = new Map();
  for (const r of results)
    if (moves.includes(r.result)) {
      if (r.lead_no == null)
        throw Object.assign(
          new Error("Never Worked needs CRM database update 090 after 089."),
          { status: 503 },
        );
      const key = sourceKey(r.from);
      if (!groups.has(key))
        groups.set(key, {
          id: r.from ?? null,
          name: r.from ? r.from_name || "an agent" : "Unassigned leads",
          leads: [],
        });
      groups.get(key).leads.push(r);
    }
  const asked = new Map(quotas.map((q) => [sourceKey(q.from), q.take]));
  // A number for a group with nothing to give (it may have changed).
  for (const [key, take] of asked)
    if (take > 0 && !groups.has(key))
      groups.set(key, {
        id: key === "unassigned" ? null : key,
        name: null,
        leads: [],
      });
  const sources = [...groups.entries()]
    .map(([key, g]) => ({
      id: g.id,
      name: g.name,
      available: g.leads.length,
      take: asked.get(key) ?? 0,
      leads: g.leads.sort(
        (a, b) => b.lead_no - a.lead_no || (a.id < b.id ? -1 : 1),
      ),
    }))
    .sort(
      (a, b) =>
        (a.id === null) - (b.id === null) ||
        b.available - a.available ||
        String(a.name).localeCompare(String(b.name)),
    );
  const over = sources.some((s) => s.take > s.available);
  return {
    over,
    ids: over
      ? []
      : sources.flatMap((s) => s.leads.slice(0, s.take).map((r) => r.id)),
    sources: sources.map(({ leads, ...s }) => s),
  };
}

export async function distributeByQuotas(
  call,
  { ids, agents, quotas, apply, token },
) {
  const whole = await distributeInParts(call, { ids, agents, apply: false });
  const picked = takeByQuotas(whole.results, quotas);
  const plan = picked.ids.length
    ? await distributeInParts(call, { ids: picked.ids, agents, apply: false })
    : null;
  const now = createHash("md5")
    .update(
      [whole.token, [...picked.ids].sort().join(","), plan?.token ?? ""].join(
        "|",
      ),
    )
    .digest("hex");
  // Leads that cannot move, from the whole plan, stay listed with why.
  const others = whole.results.filter((r) => !moves.includes(r.result));
  const shape = (base, state) => ({
    ...merge(
      [
        {
          ...base,
          results: [...(base === whole ? [] : base.results), ...others],
        },
      ],
      state,
    ),
    sources: picked.sources,
    over: picked.over,
  });
  const preview = (stale) =>
    shape(plan ?? whole, { applied: false, stale, token: now });
  if (!apply || token !== now || !plan)
    return preview(!!token && token !== now);
  const done = await distributeInParts(call, {
    ids: picked.ids,
    agents,
    apply: true,
    token: plan.token,
  });
  // Changed in the moment before the move: the new plan to confirm.
  if (!done.applied)
    return {
      ...(await distributeByQuotas(call, {
        ids,
        agents,
        quotas,
        apply: false,
      })),
      stale: true,
    };
  return shape(done, {
    applied: true,
    stale: false,
    token: now,
    ...(done.partial ? { partial: true } : {}),
  });
}

// Round-robin unassigned, Delete and Delete's preview (update 087): any
// number of leads, in parts of 500 one after another, counts added up and
// each lead's result kept. If a part fails after earlier ones were done,
// its leads and the later ones are reported as failed (notDone), and the
// earlier parts stay done. Round-robin passes size, whole rounds of the
// active agents: each call starts again with the agent assigned least
// recently, so whole rounds keep the shares even.
export async function eachPart(call, ids, notDone = null, size = partSize) {
  const sorted = [...ids].sort();
  const groups = [];
  for (let i = 0; i < sorted.length; i += size)
    groups.push(sorted.slice(i, i + size));
  if (groups.length === 1) return call(groups[0]);
  const out = [];
  for (const [i, group] of groups.entries()) {
    try {
      out.push(await call(group));
    } catch (error) {
      if (!i || !notDone) throw error;
      const rest = groups.slice(i).flat();
      out.push({
        failed: rest.length,
        results: rest.map((id) => ({ id, result: "failed", reason: notDone })),
      });
      return { ...addUp(out), partial: true };
    }
  }
  return addUp(out);
}

// Numbers added up, lists joined, anything else as the first part has it.
export function addUp(results) {
  const total = {};
  for (const result of results)
    for (const [key, value] of Object.entries(result))
      if (typeof value === "number") total[key] = (total[key] || 0) + value;
      else if (Array.isArray(value))
        total[key] = [...(total[key] || []), ...value];
      else if (!(key in total)) total[key] = value;
  return total;
}
