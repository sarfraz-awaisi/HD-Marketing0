import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, date, download } from "../../lib/api";
import { statusLabel } from "../../lib/pipeline";
import { assignmentHow, metricHint, metricLabel } from "../../lib/teamReport";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
} from "../common/UI";
import "../../styles/reports.css";
// Team performance (update 063): every agent's numbers for a period, one
// agent's day by day with their assignment history, and the records behind
// any number. The database counts every number from the same records it
// lists, so a number and its list always agree. Update 071: eight columns
// (Agent, Leads received, New, From another agent, Moved away, Total calls,
// Follow-ups, Time), sorting, a name search and the CSV export.
// A Pakistan day (YYYY-MM-DD) with its weekday, as "Fri, 13 Nov".
const dayName = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const person = (p, missing = "—") =>
  p ? p.name + (p.role === "admin" ? " (admin)" : "") : missing;
// One number that opens its records.
function Count({ value, metric, agentName, onOpen }) {
  return (
    <button
      type="button"
      className="report-link"
      aria-label={`${agentName}: ${metricLabel(metric)} ${value ?? 0}. Show the records`}
      onClick={onOpen}
    >
      {value ?? 0}
    </button>
  );
}
// What one record is: an assignment, call, follow-up, note or lead.
function Details({ row }) {
  const r = row.record;
  if (row.kind === "assignment" && r)
    return (
      <span className="team-record">
        <span>
          {person(r.from, "No agent")} → {person(r.agent, "No agent")}
        </span>
        <small>
          {assignmentHow[r.how] || "Single assignment"} · by{" "}
          {person(r.by, "not recorded")}
        </small>
        <small>
          {r.first_call_at
            ? `First call ${date(r.first_call_at)}${r.call_due_at ? (Date.parse(r.first_call_at) <= Date.parse(r.call_due_at) ? " (on time)" : " (late)") : ""}`
            : r.call_due_at
              ? `First call due ${date(r.call_due_at)}`
              : "No first-call deadline"}
        </small>
      </span>
    );
  if (row.kind === "call" && r)
    return (
      <span className="team-record">
        <span>{r.outcome || statusLabel(r.status)}</span>
        <small>
          {r.status === "completed" ? "Answered" : "Not answered"}
          {r.duration_seconds
            ? ` · ${Math.round(r.duration_seconds / 60)} min`
            : ""}
        </small>
        <small>Recorded by {person(r.caller, "not recorded")}</small>
      </span>
    );
  if (row.kind === "followup" && r)
    return (
      <span className="team-record">
        <span>
          {r.status === "completed"
            ? `Completed ${date(r.completed_at)}`
            : `Due ${date(r.due_at)}`}
        </span>
        <small>Added by {person(r.added_by, "not recorded")}</small>
        {r.notes && <small>{r.notes}</small>}
      </span>
    );
  if (row.kind === "note" && r)
    return (
      <span className="team-record">
        <span>{r.body}</span>
      </span>
    );
  return (
    <span className="team-record">
      <span>{statusLabel(row.lead?.status)}</span>
      <small>
        {row.lead?.call_due_at
          ? `First call due ${date(row.lead.call_due_at)}`
          : "No first-call deadline"}
      </small>
    </span>
  );
}
// The records behind one number, 25 at a time.
export function TeamRecords({
  metric,
  agent,
  agentName,
  range,
  periodText,
  onClose,
}) {
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({
    metric,
    ...range,
    ...(agent ? { agent } : {}),
    page,
    limit: 25,
  });
  const q = useQuery({
    queryKey: ["team-records", params.toString()],
    queryFn: ({ signal }) => api("/reports/team/records?" + params, { signal }),
  });
  const rows = q.data?.data || [];
  return (
    <Modal
      title={`${metricLabel(metric)} · ${agentName || "All agents"}`}
      onClose={onClose}
      className="team-records"
    >
      <p className="field-hint">
        {metricHint(metric)} {metric.endsWith("_now") ? "" : periodText}
      </p>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <>
          <Table
            rows={rows.map((r, i) => ({ ...r, id: `${r.id}-${i}` }))}
            empty="Nothing to show."
            columns={[
              {
                key: "lead",
                label: "Lead",
                render: (r) =>
                  r.lead ? (
                    <Link to={"/leads/" + r.lead.id}>
                      {r.lead.number} · {r.lead.name}
                    </Link>
                  ) : (
                    "—"
                  ),
              },
              ...(agent
                ? []
                : [
                    {
                      key: "agent",
                      label: "Agent",
                      render: (r) => person(r.agent),
                    },
                  ]),
              {
                key: "details",
                label: "Details",
                render: (r) => <Details row={r} />,
              },
              { key: "at", label: "When", render: (r) => date(r.at) },
            ]}
          />
          <Pagination
            page={page}
            count={q.data?.count}
            limit={25}
            onPage={setPage}
          />
        </>
      )}
    </Modal>
  );
}
// The eight columns (update 071): [metric, heading, sortable]. Agent comes
// first and Time last; every number opens the records behind it.
const columns = [
  ["received", "Leads received", true],
  ["received_first_time", "New", false],
  ["received_reassigned", "From another agent", false],
  ["moved_away", "Moved away", false],
  ["calls", "Total calls", true],
  ["followup_leads", "Follow-ups", true],
];
const sortable = {
  name: "Agent",
  ...Object.fromEntries(columns.filter((c) => c[2]).map((c) => [c[0], c[1]])),
};
// Worked minutes as "7h 45m".
const workTime = (m) => `${Math.floor((m || 0) / 60)}h ${(m || 0) % 60}m`;
// Days the agent checked in and has not checked out (still open, or never).
function TimeCell({ row }) {
  if (row.attendance_tracked === false)
    return <span title="Attendance is not tracked for this agent">—</span>;
  if (row.worked_minutes == null) return "—";
  const open = (row.open_days || 0) + (row.incomplete_days || 0);
  return (
    <span className="team-time">
      {workTime(row.worked_minutes)}
      {open > 0 && (
        <small>
          {open} {open === 1 ? "day" : "days"} without checkout
        </small>
      )}
    </span>
  );
}
// The rows shown, added up: a lead two agents each received counts for both.
function sum(rows) {
  const total = {};
  for (const key of [
    ...columns.map(([k]) => k),
    "worked_minutes",
    "open_days",
    "incomplete_days",
  ])
    total[key] = rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return total;
}
function Overview({ rows, total, totalName, sort, onSort, onOpen, onAgent }) {
  const header = (key, label) =>
    sortable[key] ? (
      <button
        type="button"
        className="team-sort"
        onClick={() => onSort(key)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
        </span>
      </button>
    ) : (
      label
    );
  const ariaSort = (key) =>
    sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined;
  const line = (r, isTotal) => (
    <tr
      key={isTotal ? "total" : r.agent_id}
      className={isTotal ? "team-total" : undefined}
    >
      <th scope="row" data-field="name">
        {isTotal ? (
          <b>{totalName}</b>
        ) : (
          <button
            type="button"
            className="report-link"
            aria-label={`Open ${r.name}'s performance`}
            onClick={() => onAgent(r.agent_id)}
          >
            <b>{r.name}</b>
            {!r.active && <small> (inactive)</small>}
          </button>
        )}
      </th>
      {columns.map(([metric, label]) => (
        <td key={metric} data-field={metric} data-label={label}>
          {r[metric] == null ? (
            "—"
          ) : isTotal && !total.open ? (
            r[metric]
          ) : (
            <Count
              value={r[metric]}
              metric={metric}
              agentName={isTotal ? "All agents" : r.name}
              onOpen={() =>
                onOpen(
                  metric,
                  isTotal ? null : r.agent_id,
                  isTotal ? null : r.name,
                )
              }
            />
          )}
        </td>
      ))}
      <td data-field="time" data-label="Time">
        <TimeCell row={r} />
      </td>
    </tr>
  );
  return (
    <div className="team-table">
      <div
        className="table-scroll"
        role="region"
        aria-label="Team performance"
        tabIndex={0}
      >
        <table className="fx-table">
          <thead>
            <tr>
              <th scope="col" data-field="name" aria-sort={ariaSort("name")}>
                {header("name", "Agent")}
              </th>
              {columns.map(([metric, label]) => (
                <th
                  key={metric}
                  scope="col"
                  data-field={metric}
                  aria-sort={ariaSort(metric)}
                  title={metricHint(metric)}
                >
                  {header(metric, label)}
                </th>
              ))}
              <th
                scope="col"
                data-field="time"
                title={metricHint("worked_minutes")}
              >
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => line(r, false))}
            {total.row && line(total.row, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
// One agent below the table: day by day, and every assignment.
function AgentDays({ row, dayParams, onOpen }) {
  const days = useQuery({
    queryKey: ["team-days", row.agent_id, dayParams.toString()],
    queryFn: ({ signal }) =>
      api(`/reports/team/days?${dayParams}&agent=${row.agent_id}`, { signal }),
    enabled: dayParams.has("from"),
  });
  return (
    <div className="agent-performance">
      <p>
        <button
          type="button"
          className="report-link"
          onClick={() => onOpen("assignment_events", row.agent_id, row.name)}
        >
          Assignment history: every lead given to or taken from {row.name} in
          this period
        </button>
      </p>
      <h3>{row.name}: day by day</h3>
      <ErrorBox error={days.error} />
      {!dayParams.has("from") ? (
        <p className="field-hint">
          Choose 62 days or fewer to see this agent day by day.
        </p>
      ) : days.isPending ? (
        <Loader />
      ) : days.data ? (
        <Table
          rows={days.data.days.map((d) => ({ ...d, id: d.day }))}
          columns={[
            {
              key: "day",
              label: "Day",
              render: (d) => dayName.format(new Date(d.day + "T00:00:00Z")),
            },
            ...days.data.metrics.map((metric) => ({
              key: metric,
              label: metricLabel(metric),
            })),
          ]}
        />
      ) : null}
    </div>
  );
}
export default function TeamPerformance({
  range,
  dayCount,
  periodText,
  agent,
  onAgent,
}) {
  const [open, setOpen] = useState(null),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState({ key: "name", desc: false }),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState("");
  const params = new URLSearchParams(range);
  const q = useQuery({
    queryKey: ["team-report", params.toString()],
    queryFn: ({ signal }) => api("/reports/team?" + params, { signal }),
  });
  const openRecords = (metric, id, name) => setOpen({ metric, id, name });
  const agents = Array.isArray(q.data?.agents) ? q.data.agents : [];
  const words = search.trim().toLowerCase();
  // The filters choose rows; the database counted every number.
  const shown = agents.filter(
    (a) =>
      (!agent || a.agent_id === agent) &&
      (!words || (a.name || "").toLowerCase().includes(words)),
  );
  const rows =
    sort.key === "name"
      ? sort.desc
        ? [...shown].reverse()
        : shown
      : [...shown].sort(
          (a, b) =>
            (sort.desc ? -1 : 1) * ((a[sort.key] || 0) - (b[sort.key] || 0)) ||
            a.name.localeCompare(b.name),
        );
  const selected = agent ? agents.find((a) => a.agent_id === agent) : null;
  // Before update 071 the report has no Follow-ups or Time.
  const needs071 = agents.length > 0 && !("followup_leads" in agents[0]);
  // All agents' total opens their records; a searched total only adds up.
  const total =
    agent || !rows.length
      ? {}
      : words
        ? { row: sum(rows), open: false }
        : { row: { ...sum(rows), ...(q.data?.total || {}) }, open: true };
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    setError("");
    try {
      download(
        await api(
          "/reports/team/export?" +
            new URLSearchParams({
              ...range,
              ...(agent ? { agent } : {}),
              ...(words ? { search: search.trim() } : {}),
            }),
          { download: true },
        ),
        "hd-marketing-team-performance.csv",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <p className="field-hint">
        {periodText}. Each number counts different leads, except Total calls,
        which counts every recorded call. Calls count for whoever recorded them;
        an administrator's calls are never an agent's. Select a name or any
        number to see the records behind it.
      </p>
      <div className="toolbar team-toolbar">
        <input
          type="search"
          aria-label="Search agents"
          placeholder="Search agent name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Team performance agent"
          value={agent || ""}
          onChange={(e) => onAgent(e.target.value || null)}
        >
          <option value="">All agents</option>
          {agent && !selected && <option value={agent}>Selected agent</option>}
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.name}
              {a.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          disabled={!q.data || exporting}
          onClick={exportCsv}
        >
          {exporting ? "Preparing…" : "Export CSV"}
        </Button>
      </div>
      <ErrorBox error={q.error || error} />
      {needs071 && (
        <p className="field-hint">
          Follow-ups and Time need CRM database update 071.
        </p>
      )}
      {q.isPending ? (
        <Loader />
      ) : !q.data ? null : agent && !selected ? (
        <p className="empty">
          This agent has nothing in this period.{" "}
          <button
            type="button"
            className="report-link"
            onClick={() => onAgent(null)}
          >
            Back to all agents
          </button>
        </p>
      ) : !rows.length ? (
        <p className="empty">No agents match “{search.trim()}”.</p>
      ) : (
        <>
          <Overview
            rows={rows}
            total={total}
            totalName={words ? "Agents shown" : "All agents"}
            sort={sort}
            onSort={(key) =>
              setSort((s) => ({
                key,
                desc: s.key === key ? !s.desc : key !== "name",
              }))
            }
            onOpen={openRecords}
            onAgent={onAgent}
          />
          {selected && (
            <AgentDays
              row={selected}
              dayParams={dayCount <= 62 ? params : new URLSearchParams()}
              onOpen={openRecords}
            />
          )}
        </>
      )}
      {open && (
        <TeamRecords
          metric={open.metric}
          agent={open.id}
          agentName={open.name}
          range={range}
          periodText={periodText}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
