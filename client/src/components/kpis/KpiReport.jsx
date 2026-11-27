import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { addDays, dayLabel, fullDayLabel, todayPk } from "../../lib/calendar";
import {
  answerText,
  completedCallsText,
  dayStates,
  kpiPeriods,
  kpiRange,
  measured,
  weekStates,
} from "../../lib/kpiPeriods";
import { ErrorBox, Loader, Modal } from "../common/UI";
import "../../styles/kpis.css";
// Administrators' Daily KPI results (update 070): one row per agent, one
// column per KPI, for a day, a week, a month or any range. Weeks run Monday
// to Sunday; a week counts in the range holding its Thursday; a week still
// running is in progress, not missed. Missed (no answer on a working day)
// is apart from an explicit No or 0. Update 076: a Yes/No KPI may expect No,
// and a range across a change of daily rules shows each target.
// Update 085: Today calls, next to Calls completed (or after the last KPI),
// counts every call each agent saved an outcome for today, on any lead,
// whatever period is shown; it is not a KPI and leaves Overall alone.
const overallLabels = {
  complete: "On target",
  on_track: "On track",
  below: "Below target",
  pending: "Pending",
  none: "—",
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function weekText(w) {
  return `${w.total}/${w.target} · ${weekStates[w.status] ?? w.status}`;
}
// Update 072: the numbers behind a KPI the CRM fills in.
function detailText(kpi, d) {
  if (!d) return null;
  switch (kpi.measure) {
    case "calls":
      return `${d.on_time ?? 0}/${d.due ?? 0} called on time`;
    case "call_activity":
      return `${d.completed ?? 0}/${d.assigned ?? 0} completed`;
    case "social":
      return `${d.approved ?? 0}/${d.submitted ?? 0} links approved`;
    case "inventory":
      return `${d.verified ?? 0} verified of ${d.uploaded ?? 0} added`;
    case "visits":
      return `${d.approved ?? 0}/${d.submitted ?? 0} photos approved`;
    case "video":
      return `${d.approved ?? 0}/${d.submitted ?? 0} videos approved`;
  }
  return null;
}
const NOTHING_DUE = "No assigned calls due";
// Update 076: each set of daily rules a range used, from the day it took
// over, so a changed target shows with the days it judged.
const ruleGoal = (r) =>
  r.answer_type === "yes_no"
    ? `expects ${r.expected === "no" ? "No" : "Yes"}`
    : `${r.target} a day`;
const dailyRulesText = (rules) =>
  rules.map((r) => `${ruleGoal(r)} from ${dayLabel(r.from)}`).join(", ");
// One agent's result for one KPI.
export function cellText(kpi, cell, single) {
  if (!cell) return "—";
  const auto = measured(kpi);
  const withDetail = (text, d) =>
    [text, auto && detailText(kpi, d)].filter(Boolean).join(" · ");
  if (single) {
    const day = cell.day;
    const w = cell.weekly?.weeks?.[0];
    if (kpi.frequency === "week") {
      if (auto) return w ? withDetail(`Week ${weekText(w)}`, w.detail) : "—";
      const today =
        day?.state === "answered"
          ? `${answerText(kpi.answer_type, day.value)} today`
          : (dayStates[day?.state] ?? "—");
      return w ? `${today} · week ${weekText(w)}` : today;
    }
    if (!day) return "—";
    // Update 081: completed out of assigned, and nothing more.
    if (kpi.measure === "call_activity")
      return completedCallsText(day.detail, day.value, day.state);
    if (day.state === "not_due") return NOTHING_DUE;
    if (day.state !== "answered")
      return withDetail(dayStates[day.state] ?? day.state, day.detail);
    return withDetail(
      kpi.answer_type === "yes_no"
        ? answerText("yes_no", day.value)
        : `${day.value}/${kpi.target}`,
      day.detail,
    );
  }
  const parts = [];
  if (cell.daily) {
    const d = cell.daily;
    // Update 076: one kind of daily rule over the range, or several.
    const kinds = new Set(
      (d.rules ?? []).map((r) => r.answer_type + (r.expected ?? "")),
    );
    const yesNo = kinds.size <= 1 && d.answer_type === "yes_no";
    if (d.days || !d.not_due)
      parts.push(
        yesNo
          ? `${d.rules?.[0]?.expected === "no" ? "No" : "Yes"} ${d.met}/${d.days} days`
          : kinds.size > 1
            ? `Met ${d.met}/${d.days} days`
            : `Met ${d.met}/${d.days} days · ${d.total} total`,
      );
    if (d.rules?.length > 1) parts.push(dailyRulesText(d.rules));
    if (d.missed) parts.push(`${d.missed} missed`);
    if (d.pending) parts.push(`${d.pending} pending`);
    if (d.review) parts.push(`${d.review} awaiting review`);
    if (d.not_due)
      parts.push(
        d.days ? `${plural(d.not_due, "day")} nothing due` : NOTHING_DUE,
      );
    if (auto && d.detail) parts.push(detailText(kpi, d.detail));
  }
  if (cell.weekly) {
    const w = cell.weekly;
    if (w.weeks.length === 1) parts.push(`Week ${weekText(w.weeks[0])}`);
    else {
      const finished = w.met + w.missed;
      if (finished) parts.push(`Met ${w.met}/${plural(finished, "week")}`);
      const running = w.weeks.find((x) => x.status === "in_progress");
      if (running) parts.push(`this week ${running.total}/${running.target}`);
      if (w.review) parts.push(`${plural(w.review, "week")} awaiting review`);
      parts.push(`${w.total} total`);
    }
    if (auto && w.detail) parts.push(detailText(kpi, w.detail));
  }
  return parts.join(" · ") || "—";
}
const cellTone = (kpi, cell, single) => {
  if (!cell) return "";
  if (single && kpi.frequency === "day") {
    if (cell.day?.state !== "answered")
      return cell.day?.state === "missed" ? "missed" : "";
    return cell.day.met ? "met" : "below";
  }
  if (single) {
    const w = cell.weekly?.weeks?.[0];
    return w?.status === "met" ? "met" : "";
  }
  const missed = (cell.daily?.missed || 0) + (cell.weekly?.missed || 0);
  const below = cell.daily?.below || 0;
  return missed || below ? "below" : cell.daily || cell.weekly ? "met" : "";
};

function History({ agent, range, onClose }) {
  // Up to three months: the end of the chosen range and before.
  const from = [range.from, addDays(range.to, -92)].sort().at(-1);
  const q = useQuery({
    queryKey: ["kpis", "history", agent.id, from, range.to],
    queryFn: ({ signal }) =>
      api(
        `/kpis/history?${new URLSearchParams({ agent: agent.id, from, to: range.to })}`,
        { signal },
      ),
  });
  const h = q.data;
  return (
    <Modal
      title={`${agent.name}: Daily KPI history`}
      onClose={onClose}
      className="kpi-history-modal"
    >
      <p className="field-hint">
        {fullDayLabel(from)} to {fullDayLabel(range.to)}
      </p>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader variant="table" />
      ) : (
        <>
          <div className="table-scroll">
            <table className="kpi-history-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {h.kpis.map((k) => (
                    <th key={k.id}>{k.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {h.days.map((d) => (
                  <tr key={d.day}>
                    <td>{dayLabel(d.day)}</td>
                    {h.kpis.map((k) => {
                      const a = d.answers[k.id];
                      return (
                        <td
                          key={k.id}
                          className={
                            a?.met === true
                              ? "met"
                              : a?.met === false
                                ? "below"
                                : a?.state === "missed"
                                  ? "missed"
                                  : ""
                          }
                          title={a?.question || undefined}
                        >
                          {!a
                            ? "—"
                            : a.state === "answered"
                              ? answerText(k.answer_type, a.value)
                              : (dayStates[a.state] ?? a.state)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {h.weeks.length > 0 && (
            <>
              <h3>Weekly KPIs</h3>
              <ul className="kpi-weeks">
                {h.weeks.map((w) => (
                  <li key={w.start}>
                    <b>
                      {dayLabel(w.start)} – {dayLabel(w.end)}
                    </b>
                    {h.kpis
                      .filter((k) => w.kpis[k.id])
                      .map((k) => (
                        <span key={k.id}>
                          {k.title}: {weekText(w.kpis[k.id])}
                        </span>
                      ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export default function KpiReport() {
  const [params, setParams] = useSearchParams();
  const period = params.get("period") || "today";
  const preset = kpiRange(period);
  const range = preset ?? {
    from: params.get("from") || todayPk(),
    to: params.get("to") || todayPk(),
  };
  const agent = params.get("agent") || "";
  const [open, setOpen] = useState(null);
  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch))
      v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };
  const valid = range.from <= range.to && range.to <= todayPk();
  const q = useQuery({
    queryKey: ["kpis", "report", range.from, range.to, agent],
    queryFn: ({ signal }) =>
      api(
        `/kpis/report?${new URLSearchParams({ from: range.from, to: range.to, ...(agent ? { agent } : {}) })}`,
        { signal },
      ),
    enabled: valid,
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (u) => u.role === "agent",
  );
  const r = q.data;
  // Where Today calls goes: after Calls completed, or after the last KPI.
  const callsAfter = r?.today_calls
    ? (r.kpis.find((k) => k.measure === "call_activity") ?? r.kpis.at(-1))?.id
    : undefined;
  const single = range.from === range.to;
  const callsHead = (
    <th>
      Today calls
      <small className="kpi-sub">daily · from the CRM</small>
    </th>
  );
  return (
    <>
      <section className="panel kpi-filters">
        <div className="review-tabs" role="tablist" aria-label="Period">
          {kpiPeriods.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={period === value}
              className={period === value ? "active" : ""}
              onClick={() =>
                update(
                  value === "custom"
                    ? { period: value, from: range.from, to: range.to }
                    : { period: value, from: null, to: null },
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="kpi-filter-fields">
          {period === "custom" && (
            <>
              <label>
                From
                <input
                  type="date"
                  value={range.from}
                  max={todayPk()}
                  onChange={(e) => update({ from: e.target.value })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={range.to}
                  max={todayPk()}
                  onChange={(e) => update({ to: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            Agent
            <select
              aria-label="Agent"
              value={agent}
              onChange={(e) => update({ agent: e.target.value })}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.active ? "" : " (disabled)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint">
          {single
            ? fullDayLabel(range.from)
            : `${fullDayLabel(range.from)} to ${fullDayLabel(range.to)}`}
          . Weeks run Monday to Sunday and count in the period holding their
          Thursday; a week still running shows as in progress.
        </p>
      </section>
      {!valid && (
        <ErrorBox error="Choose a start on or before the end, up to today." />
      )}
      <ErrorBox error={q.error} />
      {valid && q.isPending ? (
        <Loader variant="table" />
      ) : r && !r.agents.length ? (
        <div className="panel empty">No agents had KPIs in this period.</div>
      ) : (
        r && (
          <section className="panel">
            <div className="table-scroll">
              <table className="kpi-report-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Answers</th>
                    {r.kpis.map((k) => (
                      <Fragment key={k.id}>
                        <th>
                          {k.title}
                          <small className="kpi-sub">
                            {k.answer_type === "yes_no"
                              ? `${k.expected === "no" ? "No" : "Yes"} ${k.frequency === "week" ? "weekly" : "daily"}`
                              : `${k.target} a ${k.frequency === "week" ? "week" : "day"}`}
                            {measured(k) ? " · from the CRM" : ""}
                          </small>
                        </th>
                        {k.id === callsAfter && callsHead}
                      </Fragment>
                    ))}
                    {r.today_calls && callsAfter == null && callsHead}
                    <th>Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {r.agents.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setOpen(a)}
                        >
                          {a.name}
                        </button>
                        {!a.active && (
                          <small className="kpi-sub">Disabled</small>
                        )}
                      </td>
                      <td>
                        {a.entries.expected
                          ? `${a.entries.answered}/${a.entries.expected}`
                          : "—"}
                        {a.entries.missing > 0 && (
                          <small className="kpi-sub missed">
                            {a.entries.missing} missed
                          </small>
                        )}
                        {a.entries.pending > 0 && (
                          <small className="kpi-sub">
                            {a.entries.pending} pending
                          </small>
                        )}
                      </td>
                      {r.kpis.map((k) => (
                        <Fragment key={k.id}>
                          <td className={cellTone(k, a.cells[k.id], single)}>
                            {cellText(k, a.cells[k.id], single)}
                          </td>
                          {k.id === callsAfter && <td>{a.today_calls}</td>}
                        </Fragment>
                      ))}
                      {r.today_calls && callsAfter == null && (
                        <td>{a.today_calls}</td>
                      )}
                      <td>
                        <span className={`kpi-overall ${a.overall.status}`}>
                          {overallLabels[a.overall.status]}
                        </span>
                        {a.overall.due > 0 && (
                          <small className="kpi-sub">
                            {a.overall.met}/{a.overall.due} targets met
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      )}
      {open && (
        <History agent={open} range={range} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
