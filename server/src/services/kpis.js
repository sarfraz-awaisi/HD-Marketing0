// Daily KPIs (update 070). The database keeps the KPIs, their rules over
// time (kpi_versions) and one answer per agent, KPI and Pakistan day, and
// checks who may read or write them. This file turns those facts into what
// the pages show: an agent's day, an agent's history and the administrators'
// report. Rules used everywhere:
// - Days are Pakistan days (YYYY-MM-DD); weeks run Monday to Sunday.
// - The rules for a day are the latest version that took effect by then.
//   Weekly rules only ever start on a Monday, so a week has one version.
// - A daily KPI is met on a day when the answer is Yes, or the count reaches
//   the target. A weekly KPI is met when the week's daily entries add up to
//   the target; it stays met once reached.
// - A working day (from attendance: shift days, holidays, leave, employment)
//   with no answer is missed once the day is over, and pending until then.
//   A weekly KPI's day stays pending until its week closes, because the
//   agent can still enter it. An explicit No or 0 is an answer.
// - A week counts in a report when its Thursday falls in the range, so a
//   week spanning two months counts in the month holding most of its days.
//   A single day, or a range without a Thursday, shows the weeks it touches.
//   A week still running is "in progress" until met, never "missed".
// - Update 072: a KPI's rules also say how it is measured. "self": the agent
//   answers, as above. The others are filled in by the CRM (kpi_facts
//   measures) and read as the day's answer (autoAnswer): calls, social,
//   inventory (daily) and visits, video (weekly totals of what was
//   approved). Such an answer is settled once it can no longer change; until
//   then the day is pending, or "review" while evidence waits for an
//   administrator. A day on which no first call was due is "not_due", never
//   missed, and so is a day without evidence for a weekly KPI.
// - Update 076: a KPI the CRM fills in may take other rules its records can
//   measure (kpiSources). Each count can be read as a number, or as Yes once
//   at least one counts; assigned calls stay a daily Yes/No. A Yes/No KPI
//   has an expected answer (Yes unless an administrator chose No for an
//   agents' own KPI): the day is met when the answer is the expected one,
//   and a weekly Yes/No KPI once a day of the week has it.
// - Update 081: call_activity ("Calls completed") is Yes when the agent
//   saved a call outcome, the same day, for every lead assigned to them
//   that day (any outcome); a day with nothing assigned is "not_due". The
//   first-call deadline KPI (calls) is unchanged.
const DAY = 86400000;
export const addDays = (day, n) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
export const weekStart = (day) =>
  addDays(day, -((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7));
// The Pakistan day now: UTC+5 all year.
export const pkToday = (ms = Date.now()) =>
  new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
function* daysOf(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export async function kpiRpc(db, name, args) {
  const update = /^kpi_(evidence|inventory)/.test(name) ? "072" : "070";
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
          : ["23505", "40001", "40P01"].includes(error.code)
            ? 409
            : 503;
  // Evidence already added (update 072) says so: the function's own words,
  // or, when two arrive at once, the unique index's.
  const duplicate = update === "072" && error.code === "23505";
  throw Object.assign(
    new Error(
      missing
        ? `Daily KPIs need CRM database update ${update}.`
        : duplicate
          ? /already/.test(error.message || "")
            ? error.message
            : "This was already added."
          : status === 409
            ? "This was changed at the same moment. Refresh and try again."
            : status === 503
              ? "Daily KPIs could not be loaded. Please try again."
              : error.message,
    ),
    { status },
  );
}

const measureOf = (v) => v?.measure ?? "self";
const measured = (v) => !!v && measureOf(v) !== "self";
// Update 076: the expected answer of a Yes/No KPI (rules before 076: Yes).
const expectsYes = (v) => v?.expected !== "no";

// Update 076: the rules each way of measuring a KPI supports, as the
// database's kpi_rules_problem checks them, and the reason for any other.
// The administrators' page reads this to offer only what can be measured.
const expectsYesOnly =
  "A KPI the CRM fills in expects Yes: it counts work that was done and approved, so No cannot be its expected answer.";
const anyRules = {
  frequencies: ["day", "week"],
  answer_types: ["yes_no", "number"],
};
export const kpiSources = {
  self: { ...anyRules, expected: ["yes", "no"], max: {} },
  calls: {
    frequencies: ["day"],
    answer_types: ["yes_no"],
    expected: ["yes"],
    max: {},
    counts: null,
    yes: "Every lead due that day got its first call by its deadline",
    reasons: {
      expected: expectsYesOnly,
      week: "Assigned calls is decided day by day: Yes when every lead due that day got its first call by its deadline. There is no rule for a whole week, so it stays Daily.",
      number:
        "Assigned calls has no number to reach: the CRM checks that every lead due that day was called by its deadline. Keep Yes / No; each day still shows the calls due, on time and late.",
    },
  },
  social: {
    ...anyRules,
    expected: ["yes"],
    max: { day: 5, week: 35 },
    counts: "approved social media links",
    yes: "At least one social media link approved",
    reasons: {
      expected: expectsYesOnly,
      max: "Agents can add up to 5 social media links a day, so the target can be at most 5 a day or 35 a week.",
    },
  },
  inventory: {
    ...anyRules,
    expected: ["yes"],
    max: {},
    counts: "verified listings with the owner's name and phone",
    yes: "At least one listing verified with the owner's details",
    reasons: { expected: expectsYesOnly },
  },
  call_activity: {
    frequencies: ["day"],
    answer_types: ["yes_no"],
    expected: ["yes"],
    max: {},
    counts: null,
    yes: "Every lead assigned that day was called that day",
    reasons: {
      expected: expectsYesOnly,
      week: "Calls completed is decided day by day: Yes when every lead assigned that day was called that day. There is no rule for a whole week, so it stays Daily.",
      number:
        "Calls completed has no fixed number: each day's assigned leads are its target. Keep Yes / No; each day still shows the calls assigned and completed.",
    },
  },
  visits: {
    ...anyRules,
    expected: ["yes"],
    max: {},
    counts: "approved project visits (one per project and date)",
    yes: "At least one project visit approved",
    reasons: { expected: expectsYesOnly },
  },
  video: {
    ...anyRules,
    expected: ["yes"],
    max: { day: 2, week: 20 },
    counts: "approved video links",
    yes: "At least one video link approved",
    reasons: {
      expected: expectsYesOnly,
      max: "Agents can add up to 20 video links a week, so the target can be at most 2 a day (a week can have 7 working days) or 20 a week.",
    },
  },
};
// Why a KPI measured this way cannot have these rules, or null when it can.
export function rulesProblem(
  measure,
  { frequency, answer_type, target, expected = "yes" },
) {
  const s = kpiSources[measure];
  if (!s) return "This KPI's CRM source is not known.";
  if (measure === "self") return null;
  if (answer_type === "yes_no" && expected === "no") return s.reasons.expected;
  if (!s.frequencies.includes(frequency)) return s.reasons.week;
  if (!s.answer_types.includes(answer_type)) return s.reasons.number;
  if (answer_type === "number" && s.max[frequency] && target > s.max[frequency])
    return s.reasons.max;
  return null;
}
// Adds up the numbers of two measured details.
const addUp = (sum, detail) => {
  const out = { ...sum };
  for (const [key, n] of Object.entries(detail || {}))
    if (typeof n === "number") out[key] = (out[key] || 0) + n;
  return out;
};
// What the CRM measured for an agent's day (m), as the answer to a KPI it
// fills in: { yes | count, auto, settled, detail }; { none } when no first
// call was due; null when there is nothing to show yet.
// - calls: Yes when every lead due that day got the agent's first call by
//   its deadline, whatever the outcome; No once one deadline passed without
//   it; unsettled while a deadline is still ahead.
// - social: Yes once one of the day's links is approved; unsettled while one
//   waits for review, or on the day itself; No when all were rejected.
// - inventory: the listings added that day that are verified with the
//   owner's name and phone; unsettled while one waits for verification, or
//   on the day itself below the target.
// - visits, video: what was approved that day (distinct projects, links);
//   unsettled while one waits for review.
// Update 076: social, inventory, visits and video are each a day's count
// (approved links, verified listings, distinct approved visits, approved
// videos), read as the KPI's rules ask: the number, or Yes once at least
// one counts. A daily KPI's day is settled once met, or once it is over
// with nothing waiting; a weekly KPI's day once nothing waits, as before.
const dayCount = {
  social: (e) => e.approved,
  inventory: (e) => e.verified,
  visits: (e) => e.visits,
  video: (e) => e.approved,
};
function autoAnswer(v, m, day, today) {
  const answer = (value, settled, detail) => ({
    ...value,
    auto: true,
    settled,
    detail,
  });
  if (v.measure === "calls") {
    const c = m?.calls;
    if (!c?.due) return { auto: true, none: true, detail: null };
    if (c.late + c.not_called - c.waiting > 0)
      return answer({ yes: false }, true, c);
    return c.waiting
      ? answer({ yes: null }, false, c)
      : answer({ yes: true }, true, c);
  }
  // Update 081: the day's assigned leads, each completed that day.
  if (v.measure === "call_activity") {
    const c = m?.call_activity;
    if (!c?.assigned) return { auto: true, none: true, detail: c ?? null };
    if (c.completed >= c.assigned) return answer({ yes: true }, true, c);
    return day < today
      ? answer({ yes: false }, true, c)
      : answer({ yes: null }, false, c);
  }
  const count = dayCount[v.measure];
  const e = m?.[v.measure];
  if (!count || !e) return null;
  const n = count(e);
  const met = v.answer_type === "yes_no" ? n >= 1 : n >= v.target;
  const done =
    v.frequency === "week" ? !e.pending : met || (!e.pending && day < today);
  return answer(
    v.answer_type === "yes_no"
      ? { yes: n >= 1 ? true : done ? false : null }
      : { count: n },
    done,
    e,
  );
}
// An answer that counts: the agent's own, or a settled measured one.
const settled = (a) => !!a && !a.none && (!a.auto || a.settled);
// The state of a measured KPI's day when its numbers decide it (see the
// rules at the top); null when the day reads like any answer.
const autoState = (v, a, d, today) =>
  !measured(v)
    ? null
    : a?.none || (!a && v.frequency === "week")
      ? d > today
        ? "upcoming"
        : "not_due"
      : a && !a.settled
        ? a.detail?.pending
          ? "review"
          : "pending"
        : null;

// Lookups over one kpi_facts or kpi_admin_list result.
function lookup(facts) {
  const versions = new Map();
  for (const v of facts.versions) {
    if (!versions.has(v.kpi_id)) versions.set(v.kpi_id, []);
    versions.get(v.kpi_id).push(v);
  }
  for (const list of versions.values())
    list.sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  const status = new Map(
    (facts.days || []).map(([agent, day, s]) => [agent + "|" + day, s]),
  );
  const answers = new Map(
    (facts.answers || []).map((a) => [`${a.kpi_id}|${a.agent_id}|${a.day}`, a]),
  );
  const measures = new Map(
    (facts.measures || []).map((m) => [m.agent_id + "|" + m.day, m]),
  );
  const versionOn = (kpi, day) => {
    let found = null;
    for (const v of versions.get(kpi) || []) {
      if (v.effective_from > day) break;
      found = v;
    }
    return found;
  };
  return {
    versionOn,
    versionsOf: (kpi) => versions.get(kpi) || [],
    // An agent with no attendance days for it counts the day as working.
    dayStatus: (agent, day) => status.get(agent + "|" + day) ?? "work",
    // The agent's answer, or what the CRM measured for a KPI it fills in.
    answer(kpi, agent, day) {
      const v = versionOn(kpi, day);
      return measured(v)
        ? autoAnswer(v, measures.get(agent + "|" + day), day, facts.today)
        : (answers.get(`${kpi}|${agent}|${day}`) ?? null);
    },
  };
}
const applies = (v, agent) =>
  !!v && v.active && (!v.agent_ids || v.agent_ids.includes(agent));
const valueOf = (v, a) =>
  (!a ? null : v.answer_type === "yes_no" ? a.yes : a.count) ?? null;
// What a day's answer adds to a weekly total: the count, or 1 for the
// expected answer (update 076; Yes before).
const amountOf = (v, a) =>
  !a
    ? 0
    : a.count != null
      ? a.count
      : a.yes != null && a.yes === expectsYes(v)
        ? 1
        : 0;
// Can a missing answer for this day still be given? Today always; for a
// weekly KPI, any earlier day of the current week.
const stillOpen = (v, d, today) =>
  d === today || (v.frequency === "week" && weekStart(d) === weekStart(today));
const dayMet = (v, a) =>
  !!a &&
  (v.answer_type === "yes_no"
    ? a.yes != null && a.yes === expectsYes(v)
    : a.count >= v.target);
const rules = (v) =>
  v && {
    frequency: v.frequency,
    answer_type: v.answer_type,
    target: v.target,
    expected: v.answer_type === "yes_no" ? (v.expected ?? "yes") : null,
    active: v.active,
    agent_ids: v.agent_ids,
    effective_from: v.effective_from,
    version: v.version,
    measure: measureOf(v),
  };
// A weekly KPI's week for one agent: its total of daily entries and status.
function week(look, kpi, agent, start, today) {
  const v = look.versionOn(kpi, start);
  if (!applies(v, agent) || v.frequency !== "week") return null;
  const end = addDays(start, 6);
  let total = 0,
    working = false,
    detail = null;
  const days = [];
  for (const d of daysOf(start, end)) {
    const a = look.answer(kpi, agent, d);
    total += amountOf(v, a);
    if (look.dayStatus(agent, d) === "work") working = true;
    if (a?.detail) detail = addUp(detail, a.detail);
    days.push({ day: d, value: valueOf(v, a) });
  }
  // A measured week that ended below its target while evidence still waits
  // for review is "review": an approval can still meet it.
  const status =
    total >= v.target
      ? "met"
      : !working && total === 0 && !detail
        ? "not_expected"
        : end < today
          ? detail?.pending
            ? "review"
            : "missed"
          : "in_progress";
  return {
    start,
    end,
    total,
    target: v.target,
    status,
    days,
    ...(measured(v) && { measure: v.measure, detail }),
  };
}
// The weeks a range reports: those whose Thursday falls in it; a single
// day, or a range without a Thursday, reports the weeks it touches.
export function reportWeeks(from, to) {
  const touched = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) touched.push(w);
  if (from === to) return touched;
  const counted = touched.filter((w) => {
    const thursday = addDays(w, 3);
    return thursday >= from && thursday <= to;
  });
  return counted.length ? counted : touched;
}

// The administrators' list: each KPI with the rules in effect today and any
// change waiting for the next period.
export function kpiList(data) {
  const look = lookup({ ...data, days: [], answers: [] });
  const today = data.today;
  return {
    today,
    // Update 076: when a change of rules would start, as kpi_apply_rules
    // decides it: tomorrow, or next Monday when the KPI is weekly before or
    // after the change.
    next_day: addDays(today, 1),
    next_monday: addDays(weekStart(today), 7),
    sources: kpiSources,
    kpis: data.kpis.map((k) => {
      const current = look.versionOn(k.id, today);
      const scheduled = look
        .versionsOf(k.id)
        .find((v) => v.effective_from > today);
      return {
        ...k,
        rules: rules(current),
        scheduled: rules(scheduled ?? null),
        // An agents' own KPI whose rules started this period and that no
        // one has answered under them is corrected at once instead, when
        // its frequency stays the same.
        corrects_now:
          !!current &&
          !measured(current) &&
          current.effective_from ===
            (current.frequency === "week" ? weekStart(today) : today) &&
          k.current_answers === 0,
      };
    }),
  };
}

// One agent's day: each KPI that applies to them, their answer, whether they
// can still change it, and for weekly KPIs the week so far.
export function agentDay(facts, agentId, day) {
  const look = lookup(facts);
  const today = facts.today;
  const agent = facts.agents.find((a) => a.id === agentId) || { id: agentId };
  const items = [];
  for (const k of facts.kpis) {
    const v = look.versionOn(k.id, day);
    const a = look.answer(k.id, agentId, day);
    if (!v || (!applies(v, agentId) && (!a || a.auto))) continue;
    const rule = v;
    const item = {
      id: k.id,
      title: k.title,
      question: a && !applies(v, agentId) && !a.auto ? a.question : k.question,
      description: k.description,
      frequency: rule.frequency,
      answer_type: rule.answer_type,
      target: rule.target,
      expected: rules(rule).expected,
      measure: measureOf(rule),
      answer: valueOf(rule, a),
      answered_question: a?.question ?? null,
      submitted_at: a?.submitted_at ?? null,
      updated_at: a?.updated_at ?? null,
      editable:
        !measured(rule) &&
        applies(v, agentId) &&
        day <= today &&
        (rule.frequency === "day" ? day === today : day >= weekStart(today)),
    };
    if (rule.frequency === "day")
      item.met = settled(a) ? dayMet(rule, a) : null;
    else item.week = week(look, k.id, agentId, weekStart(day), today);
    if (measured(rule)) {
      item.state =
        autoState(rule, a, day, today) ??
        (a
          ? "answered"
          : look.dayStatus(agentId, day) !== "work"
            ? look.dayStatus(agentId, day)
            : day >= today
              ? "pending"
              : "missed");
      item.detail = a?.detail ?? null;
    }
    items.push(item);
  }
  return {
    agent: { id: agent.id, name: agent.name ?? null },
    today,
    day,
    day_status: look.dayStatus(agentId, day),
    week: { start: weekStart(day), end: addDays(weekStart(day), 6) },
    editable_from: weekStart(today),
    kpis: items,
    // The KPIs the agent answers themselves; the CRM fills in the others.
    answered: items.filter((i) => i.measure === "self" && i.answer != null)
      .length,
    expected: items.filter(
      (i) => i.measure === "self" && (i.editable || i.answer != null),
    ).length,
  };
}

// One agent's answers day by day (newest first), and their weekly KPIs'
// weeks, for an administrator's look at an agent or the agent's own page.
export function agentHistory(facts, agentId, from, to) {
  const look = lookup(facts);
  const today = facts.today;
  const used = new Set();
  const days = [];
  for (const d of daysOf(from, to)) {
    const answers = {};
    for (const k of facts.kpis) {
      const v = look.versionOn(k.id, d);
      const a = look.answer(k.id, agentId, d);
      if (!v || (!applies(v, agentId) && (!a || a.auto))) continue;
      used.add(k.id);
      const status = look.dayStatus(agentId, d);
      answers[k.id] = {
        value: valueOf(v, a),
        met: v.frequency === "day" && settled(a) ? dayMet(v, a) : null,
        state:
          autoState(v, a, d, today) ??
          (a
            ? "answered"
            : d > today
              ? "upcoming"
              : status !== "work"
                ? status
                : stillOpen(v, d, today)
                  ? "pending"
                  : "missed"),
        question: a?.question ?? null,
        updated_at: a?.updated_at ?? null,
        ...(measured(v) && { measure: v.measure, detail: a?.detail ?? null }),
      };
    }
    days.push({ day: d, status: look.dayStatus(agentId, d), answers });
  }
  const weeks = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) {
    const totals = {};
    for (const k of facts.kpis) {
      const result = week(look, k.id, agentId, w, today);
      if (result) {
        used.add(k.id);
        totals[k.id] = { ...result, days: undefined };
      }
    }
    if (Object.keys(totals).length)
      weeks.push({ start: w, end: addDays(w, 6), kpis: totals });
  }
  return {
    agent: facts.agents.find((a) => a.id === agentId) ?? { id: agentId },
    from,
    to,
    today,
    kpis: columns(facts, look, used, to),
    days: days.reverse(),
    weeks: weeks.reverse(),
  };
}
// The KPIs to show, in order, labelled with the rules in effect at the end
// of the range (or the last rules they had).
function columns(facts, look, used, to) {
  return facts.kpis
    .filter((k) => used.has(k.id))
    .map((k) => {
      const v =
        look.versionOn(k.id, to) ?? look.versionsOf(k.id).at(-1) ?? null;
      return {
        id: k.id,
        title: k.title,
        frequency: v?.frequency,
        answer_type: v?.answer_type,
        target: v?.target,
        expected: v ? rules(v).expected : null,
        measure: measureOf(v),
        archived: !!k.archived_at,
      };
    });
}

// The administrators' report for every agent (or one) over from..to.
export function kpiReport(facts, from, to, todayMeasures = null) {
  const look = lookup(facts);
  const today = facts.today;
  const weeks = reportWeeks(from, to);
  const used = new Set();
  const agents = [];
  // Update 085: Today calls, every call each agent saved an outcome for
  // today (Pakistan time), on any lead, whatever period is shown. A count to
  // read, not a KPI. A period ending before today brings today's measures
  // apart (todayMeasures).
  const measures = todayMeasures ?? facts.measures ?? [];
  const todayCalls = new Map(
    measures
      .filter((m) => m.day === today && m.today_calls)
      .map((m) => [m.agent_id, m.today_calls]),
  );
  for (const agent of facts.agents) {
    let present = false;
    const cells = {};
    const entries = { expected: 0, answered: 0, missing: 0, pending: 0 };
    const overall = { met: 0, due: 0, pending: 0, missing: 0 };
    for (const k of facts.kpis) {
      const cell = {
        entries: { expected: 0, answered: 0, missing: 0, pending: 0 },
      };
      let relevant = false;
      // Every day: was it answered? Daily KPIs: was the target met?
      for (const d of daysOf(from, to)) {
        const status = look.dayStatus(agent.id, d);
        if (status === "work") present = true;
        if (d > today) continue;
        const v = look.versionOn(k.id, d);
        if (!applies(v, agent.id)) continue;
        const a = look.answer(k.id, agent.id, d);
        const auto = measured(v);
        // Measured weekly KPIs count by the week, below; the CRM's answers
        // are not entries the agent makes.
        if (auto && v.frequency === "week") continue;
        if (a && !a.none) present = true;
        if (status !== "work" && !(a && !a.none)) continue;
        relevant = true;
        if (!auto) {
          cell.entries.expected++;
          if (a) cell.entries.answered++;
          else if (stillOpen(v, d, today)) cell.entries.pending++;
          else cell.entries.missing++;
        }
        if (v.frequency !== "day") continue;
        cell.daily ??= {
          days: 0,
          met: 0,
          below: 0,
          missed: 0,
          pending: 0,
          total: 0,
          answer_type: v.answer_type,
          target: v.target,
          rules: [],
          ...(auto && {
            measure: v.measure,
            review: 0,
            not_due: 0,
            detail: null,
          }),
        };
        // Update 076: each set of daily rules over the range and the day it
        // took over, so a changed target shows with the days it judged.
        const last = cell.daily.rules.at(-1),
          now = rules(v);
        if (
          !last ||
          last.answer_type !== now.answer_type ||
          last.target !== now.target ||
          last.expected !== now.expected
        )
          cell.daily.rules.push({
            from: d,
            answer_type: now.answer_type,
            target: now.target,
            expected: now.expected,
          });
        if (a?.detail) cell.daily.detail = addUp(cell.daily.detail, a.detail);
        if (a?.none) {
          cell.daily.not_due++;
          continue;
        }
        cell.daily.days++;
        if (settled(a)) {
          if (dayMet(v, a)) cell.daily.met++;
          else cell.daily.below++;
          cell.daily.total += amountOf(v, a);
        } else if (a) cell.daily[a.detail?.pending ? "review" : "pending"]++;
        else if (d < today) cell.daily.missed++;
        else cell.daily.pending++;
      }
      // Weekly KPIs: each reported week's total against its target.
      for (const w of weeks) {
        const result = week(look, k.id, agent.id, w, today);
        if (!result || result.status === "not_expected") continue;
        relevant = true;
        cell.weekly ??= {
          weeks: [],
          met: 0,
          missed: 0,
          in_progress: 0,
          total: 0,
          ...(result.measure && {
            measure: result.measure,
            review: 0,
            detail: null,
          }),
        };
        cell.weekly.weeks.push({
          start: result.start,
          end: result.end,
          total: result.total,
          target: result.target,
          status: result.status,
          ...(result.measure && { detail: result.detail }),
        });
        cell.weekly[result.status]++;
        cell.weekly.total += result.total;
        if (result.detail)
          cell.weekly.detail = addUp(cell.weekly.detail, result.detail);
      }
      // A single day: that day's answer, and its week for weekly KPIs.
      if (from === to) {
        const v = look.versionOn(k.id, from);
        const a = look.answer(k.id, agent.id, from);
        if (applies(v, agent.id) || (a && !a.auto)) {
          relevant = true;
          cell.day = {
            value: v ? valueOf(v, a) : null,
            met: v?.frequency === "day" && settled(a) ? dayMet(v, a) : null,
            state:
              (v && autoState(v, a, from, today)) ??
              (a
                ? "answered"
                : look.dayStatus(agent.id, from) !== "work"
                  ? look.dayStatus(agent.id, from)
                  : from > today
                    ? "upcoming"
                    : v && stillOpen(v, from, today)
                      ? "pending"
                      : "missed"),
            ...(measured(v) && { detail: a?.detail ?? null }),
          };
        }
      }
      if (!relevant) continue;
      used.add(k.id);
      cells[k.id] = cell;
      for (const key of Object.keys(entries)) entries[key] += cell.entries[key];
      if (cell.daily) {
        overall.met += cell.daily.met;
        overall.due += cell.daily.met + cell.daily.below + cell.daily.missed;
        overall.pending += cell.daily.pending + (cell.daily.review || 0);
        overall.missing += cell.daily.missed;
      }
      if (cell.weekly) {
        overall.met += cell.weekly.met;
        overall.due += cell.weekly.met + cell.weekly.missed;
        overall.pending += cell.weekly.in_progress + (cell.weekly.review || 0);
      }
    }
    if (!present && !Object.keys(cells).length) continue;
    overall.status =
      overall.due === 0
        ? overall.pending
          ? "pending"
          : "none"
        : overall.met === overall.due
          ? overall.pending
            ? "on_track"
            : "complete"
          : "below";
    agents.push({
      id: agent.id,
      name: agent.name,
      uid: agent.uid,
      active: agent.active,
      entries,
      cells,
      overall,
      today_calls: todayCalls.get(agent.id) || 0,
    });
  }
  return {
    from,
    to,
    today,
    // Before update 085 the database has no such count.
    today_calls: !measures.length || measures.some((m) => "today_calls" in m),
    weeks: weeks.map((w) => ({ start: w, end: addDays(w, 6) })),
    kpis: columns(facts, look, used, to),
    agents,
  };
}
