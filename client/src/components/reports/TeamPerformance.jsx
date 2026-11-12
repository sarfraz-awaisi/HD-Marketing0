import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { statusLabel } from "../../lib/pipeline";
import { assignmentHow, metricHint, metricLabel } from "../../lib/teamReport";
import { ErrorBox, Loader, Modal, Pagination, Table } from "../common/UI";
import "../../styles/reports.css";
// Team performance (update 063): every agent's numbers for a period, one
// agent's day by day with their assignment history, and the records behind
// any number. The database counts every number from the same records it
// lists, so a number and its list always agree.
const minutes = (m) =>
  m == null
    ? "—"
    : m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
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
// Numbers grouped as the admin reads them; [metric, column label].
const groups = [
  [
    "Leads received",
    [
      ["received", "Leads"],
      ["received_first_time", "First time"],
      ["received_reassigned", "From another agent"],
      ["moved_away", "Moved away"],
    ],
  ],
  [
    "Calls the agent recorded",
    [
      ["calls", "Calls"],
      ["answered", "Answered"],
      ["not_answered", "Not answered"],
      ["leads_called", "Leads called"],
      ["leads_answered", "Leads answered"],
    ],
  ],
  [
    "Outcomes",
    [
      ["interested", "Interested"],
      ["not_interested", "Not interested"],
      ["followup_required", "Follow-up required"],
    ],
  ],
  [
    "First calls",
    [
      ["first_calls", "First calls"],
      ["on_time", "On time"],
      ["deadlines_missed", "Deadlines missed"],
    ],
  ],
  [
    "Follow-ups and notes",
    [
      ["followups_created", "Follow-ups created"],
      ["followups_completed", "Follow-ups completed"],
      ["notes", "Notes"],
    ],
  ],
  ["Administrators", [["admin_calls", "Admin calls on their leads"]]],
  [
    "Now",
    [
      ["waiting_now", "Waiting for first call"],
      ["missed_now", "Missed first call"],
      ["not_connected_now", "Not connected"],
      ["followups_overdue_now", "Overdue follow-ups"],
    ],
  ],
];
// The all-agents table: one row per agent, then all agents together.
function Overview({ data, onOpen, onAgent }) {
  const rows = [
    ...data.agents.map((a) => ({ ...a, id: a.agent_id })),
    { ...data.total, id: "total", name: "All agents", agent_id: null },
  ];
  const cell = (metric) => (r) => (
    <Count
      value={r[metric]}
      metric={metric}
      agentName={r.name}
      onOpen={() => onOpen(metric, r.agent_id, r.name)}
    />
  );
  return (
    <div className="team-overview">
      <Table
        rows={rows}
        columns={[
          {
            key: "name",
            label: "Agent",
            render: (r) =>
              r.agent_id ? (
                <button
                  type="button"
                  className="report-link"
                  aria-label={`Open ${r.name}'s performance`}
                  onClick={() => onAgent(r.agent_id)}
                >
                  <b>
                    {r.name}
                    {!r.active && " (inactive)"}
                  </b>
                </button>
              ) : (
                <b>All agents</b>
              ),
          },
          ...groups.flatMap(([group, metrics]) =>
            metrics.map(([metric, label], i) => ({
              key: metric,
              // Phones show each row as a card, labelled with this.
              cardLabel: metricLabel(metric),
              label: (
                <span className="team-col" title={metricHint(metric)}>
                  {i === 0 && <small>{group}</small>}
                  {label}
                </span>
              ),
              render: cell(metric),
            })),
          ),
          {
            key: "talk",
            label: "Talk time",
            render: (r) => minutes(r.talk_minutes),
          },
        ]}
      />
    </div>
  );
}
// One agent: their numbers by group, day by day, and every assignment.
function AgentView({ data, agent, dayParams, onOpen, onBack }) {
  const row = data.agents.find((a) => a.agent_id === agent);
  const days = useQuery({
    queryKey: ["team-days", agent, dayParams.toString()],
    queryFn: ({ signal }) =>
      api(`/reports/team/days?${dayParams}&agent=${agent}`, { signal }),
    enabled: !!row && dayParams.has("from"),
  });
  if (!row)
    return (
      <p className="empty">
        This agent has nothing in this period.{" "}
        <button type="button" className="report-link" onClick={onBack}>
          Back to all agents
        </button>
      </p>
    );
  return (
    <div className="agent-performance">
      <button type="button" className="back-link report-link" onClick={onBack}>
        ← All agents
      </button>
      <h2>{row.name}</h2>
      <div className="team-groups">
        {groups.map(([group, metrics]) => (
          <section key={group} className="report-block">
            <h3>{group}</h3>
            {metrics.map(([metric, label]) => (
              <button
                type="button"
                key={metric}
                className="report-row report-row-button"
                aria-label={`${label}: ${row[metric]}. Show the records`}
                onClick={() => onOpen(metric, agent, row.name)}
              >
                <span>{label}</span>
                <b>{row[metric]}</b>
              </button>
            ))}
          </section>
        ))}
      </div>
      <p>
        <button
          type="button"
          className="report-link"
          onClick={() => onOpen("assignment_events", agent, row.name)}
        >
          Assignment history: every lead given to or taken from {row.name} in
          this period
        </button>
      </p>
      <h3>Day by day</h3>
      <ErrorBox error={days.error} />
      {days.isPending ? (
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
  const [open, setOpen] = useState(null);
  const params = new URLSearchParams(range);
  const q = useQuery({
    queryKey: ["team-report", params.toString()],
    queryFn: ({ signal }) => api("/reports/team?" + params, { signal }),
  });
  const openRecords = (metric, id, name) => setOpen({ metric, id, name });
  return (
    <>
      <p className="field-hint">
        {periodText}. Calls count for whoever recorded them; an administrator's
        calls are shown apart. Select a name for one agent, or any number to see
        its records.
      </p>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.data ? (
        agent ? (
          <AgentView
            data={q.data}
            agent={agent}
            dayParams={dayCount <= 62 ? params : new URLSearchParams()}
            onOpen={openRecords}
            onBack={() => onAgent(null)}
          />
        ) : (
          <Overview data={q.data} onOpen={openRecords} onAgent={onAgent} />
        )
      ) : null}
      {agent && dayCount > 62 && (
        <p className="field-hint">
          Choose 62 days or fewer to see this agent day by day.
        </p>
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
