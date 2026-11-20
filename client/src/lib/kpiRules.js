import { addDays } from "./calendar";
// Update 076: a KPI's rules as administrators set them. What each way of
// measuring supports comes from the server (sources, kpi_rules_problem in
// the database); when new rules start follows the database's
// kpi_apply_rules.
export const frequencyLabel = { day: "Daily", week: "Weekly" };
export const typeLabel = { yes_no: "Yes / No", number: "Number" };
export const per = (frequency) => (frequency === "week" ? "week" : "day");
export const targetText = (r) =>
  !r
    ? "—"
    : r.answer_type === "yes_no"
      ? `Expects ${r.expected === "no" ? "No" : "Yes"}`
      : `${r.target} a ${per(r.frequency)}`;

// Why a KPI measured this way cannot have these rules, or null when it
// can (the database gives the same reason).
export function rulesProblem(sources, measure, r) {
  const s = sources?.[measure];
  if (!s || measure === "self") return null;
  if (r.answer_type === "yes_no" && r.expected === "no")
    return s.reasons?.expected ?? null;
  if (!s.frequencies.includes(r.frequency)) return s.reasons?.week ?? null;
  if (!s.answer_types.includes(r.answer_type)) return s.reasons?.number ?? null;
  if (
    r.answer_type === "number" &&
    s.max?.[r.frequency] &&
    Number(r.target) > s.max[r.frequency]
  )
    return s.reasons?.max ?? null;
  return null;
}

// The rules that decide results (wording never does).
const ruleKeys = ["frequency", "answer_type", "target", "expected", "active"];
const sameAgents = (a, b) =>
  JSON.stringify([...(a ?? [])].sort()) ===
  JSON.stringify([...(b ?? [])].sort());
export function sameRules(a, b) {
  if (!a || !b) return false;
  const norm = (r) => ({
    ...r,
    target: r.answer_type === "yes_no" ? 1 : Number(r.target),
    expected: r.answer_type === "yes_no" ? (r.expected ?? "yes") : null,
  });
  const x = norm(a),
    y = norm(b);
  return (
    ruleKeys.every((k) => x[k] === y[k]) &&
    (x.agent_ids == null) === (y.agent_ids == null) &&
    sameAgents(x.agent_ids, y.agent_ids)
  );
}

// When saved rules would start, as the database decides it: a new KPI
// today (this week's Monday when weekly); a change tomorrow, or next Monday
// when the KPI is weekly before or after it, unless an agents' own KPI
// that no one has answered under its current rules is corrected now.
// { date, now, cancels, keeps } or null when the rules do not change.
export function rulesStart(list, kpi, next) {
  if (!list?.next_day) return null;
  if (!kpi)
    return {
      date:
        next.frequency === "week" ? addDays(list.next_monday, -7) : list.today,
      now: true,
    };
  const cur = kpi.rules;
  if (sameRules(next, cur))
    return kpi.scheduled ? { cancels: kpi.scheduled.effective_from } : null;
  if (kpi.scheduled && sameRules(next, kpi.scheduled))
    return { date: kpi.scheduled.effective_from, keeps: true };
  if (next.frequency === cur.frequency && kpi.corrects_now)
    return { date: list.today, now: true };
  return {
    date:
      cur.frequency === "week" || next.frequency === "week"
        ? list.next_monday
        : list.next_day,
    now: false,
  };
}
