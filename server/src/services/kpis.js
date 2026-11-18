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
function autoAnswer(v, m, day, today) {
  const answer = (value, settled, detail) => ({
    ...value,
    auto: true,
    settled,
    detail,
  });
  switch (v.measure) {
    case "calls": {
      const c = m?.calls;
      if (!c?.due) return { auto: true, none: true, detail: null };
      if (c.late + c.not_called - c.waiting > 0)
        return answer({ yes: false }, true, c);
      return c.waiting
        ? answer({ yes: null }, false, c)
        : answer({ yes: true }, true, c);
    }
    case "social": {
      const e = m?.social;
      if (!e) return null;
      if (e.approved) return answer({ yes: true }, true, e);
      if (e.pending || day >= today) return answer({ yes: null }, false, e);
      return answer({ yes: false }, true, e);
    }
    case "inventory": {
      const e = m?.inventory;
      if (!e) return null;
      return answer(
        { count: e.verified },
        e.verified >= v.target || (!e.pending && day < today),
        e,
      );
    }
    case "visits":
    case "video": {
      const e = m?.[v.measure];
      if (!e) return null;
      return answer(
        { count: v.measure === "visits" ? e.visits : e.approved },
        !e.pending,
        e,
      );
    }
  }
  return null;
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
// What a day's answer adds to a weekly total: the count, or 1 for Yes.
const amountOf = (a) => (!a ? 0 : a.count != null ? a.count : a.yes ? 1 : 0);
// Can a missing answer for this day still be given? Today always; for a
// weekly KPI, any earlier day of the current week.
const stillOpen = (v, d, today) =>
  d === today || (v.frequency === "week" && weekStart(d) === weekStart(today));
const dayMet = (v, a) =>
  !!a && (v.answer_type === "yes_no" ? a.yes === true : a.count >= v.target);
const rules = (v) =>
  v && {
    frequency: v.frequency,
    answer_type: v.answer_type,
    target: v.target,
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
    total += amountOf(a);
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
  return {
    today: data.today,
    kpis: data.kpis.map((k) => {
      const current = look.versionOn(k.id, data.today);
      const scheduled = look
        .versionsOf(k.id)
        .find((v) => v.effective_from > data.today);
      return {
        ...k,
        rules: rules(current),
        scheduled: rules(scheduled ?? null),
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
        measure: measureOf(v),
        archived: !!k.archived_at,
      };
    });
}

// The administrators' report for every agent (or one) over from..to.
export function kpiReport(facts, from, to) {
  const look = lookup(facts);
  const today = facts.today;
  const weeks = reportWeeks(from, to);
  const used = new Set();
  const agents = [];
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
          ...(auto && {
            measure: v.measure,
            review: 0,
            not_due: 0,
            detail: null,
          }),
        };
        if (a?.detail) cell.daily.detail = addUp(cell.daily.detail, a.detail);
        if (a?.none) {
          cell.daily.not_due++;
          continue;
        }
        cell.daily.days++;
        if (settled(a)) {
          if (dayMet(v, a)) cell.daily.met++;
          else cell.daily.below++;
          cell.daily.total += amountOf(a);
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
    });
  }
  return {
    from,
    to,
    today,
    weeks: weeks.map((w) => ({ start: w, end: addDays(w, 6) })),
    kpis: columns(facts, look, used, to),
    agents,
  };
}
