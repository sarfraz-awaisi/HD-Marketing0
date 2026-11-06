import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, date, pkr } from "../../lib/api";
import { lostReasonLabel, statusLabel, statuses } from "../../lib/pipeline";
import { kindNouns, summaryNotes } from "../../lib/reportDrilldown";
import {
  Badge,
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
} from "../common/UI";
import "../../styles/reports.css";
// The records behind one report number (update 050). The server lists them
// with the report's own conditions and the report's filters; search, status
// and agent only narrow that list. "Called by" is the person the records
// show made the call, never assumed from the lead's agent.
// own (update 051): an agent's own numbers. The server lists only their
// work; a lead now handled by someone else ("hidden") comes with its number
// and the agent's own record only, and has no details to open.
const limit = 25;
const sorts = [
  ["recent", "Newest first"],
  ["created", "Lead created"],
  ["activity", "Last activity"],
  ["call", "Latest call"],
];
function person(p, missing) {
  if (!p) return missing;
  return (
    p.name +
    (p.role === "admin" ? " (admin)" : "") +
    (p.former ? " (former)" : "")
  );
}
const minutes = (m) => (m == null ? "—" : `${Math.round(Number(m))} min`);
const callText = (c) =>
  [
    c.outcome || statusLabel(c.status),
    c.duration_seconds ? minutes(c.duration_seconds / 60) : null,
  ]
    .filter(Boolean)
    .join(" · ");
// "Called by": the recorded caller, and the agent the call is filed under
// when that is someone else.
function Caller({ call }) {
  const by = person(call.caller, null);
  return (
    <small>
      {by ? `Called by ${by}` : "Caller not recorded"}
      {call.recorded_agent &&
        call.recorded_agent.id !== call.caller?.id &&
        ` · filed under ${person(call.recorded_agent)}`}
    </small>
  );
}
function Why({ row, report, metric }) {
  const lead = row.lead;
  const parts = [];
  if (report === "funnel" && row.reason)
    parts.push(`Furthest stage: ${statusLabel(row.reason)}`);
  if (row.stage_change)
    parts.push(
      `Reached ${statusLabel(row.stage_change.to)} ${date(row.stage_change.at)} · ${person(row.stage_change.by, "by: not recorded")}`,
    );
  if (lead.status === "lost") {
    parts.push(`Lost: ${lostReasonLabel(lead.lost_reason)}`);
    if (row.lost_change)
      parts.push(
        `Marked lost ${date(row.lost_change.at)} · ${person(row.lost_change.by, "by: not recorded")}`,
      );
    if (lead.lost_note) parts.push(lead.lost_note);
  }
  if (metric === "leads_contacted" && row.amount)
    parts.push(
      `${row.amount} call${Number(row.amount) === 1 ? "" : "s"} in this range`,
    );
  return parts.map((p) => <small key={p}>{p}</small>);
}
function Record({ row }) {
  const r = row.record;
  if (!r) return "—";
  if (row.kind === "call")
    return (
      <>
        <span>{date(r.started_at)}</span>
        <small>{callText(r)}</small>
        <Caller call={r} />
      </>
    );
  if (row.kind === "visit")
    return (
      <>
        <span>{date(r.scheduled_at)}</span>
        <small>
          {statusLabel(r.status)}
          {r.property && ` · ${r.property}`}
        </small>
        <small>
          {person(r.agent, "No agent")} · added by{" "}
          {person(r.added_by, "not recorded")}
        </small>
      </>
    );
  if (row.kind === "deal")
    return (
      <>
        <span>{pkr(r.expected_value)}</span>
        <small>
          Closed {r.close_date || "—"}
          {r.property && ` · ${r.property}`}
        </small>
        <small>
          {person(r.agent, "No agent")} · added by{" "}
          {person(r.added_by, "not recorded")}
        </small>
      </>
    );
  if (row.kind === "followup")
    return (
      <>
        <span>
          {r.status === "completed"
            ? `Completed ${date(r.completed_at)}`
            : `Due ${date(r.due_at)}`}
        </span>
        <small>
          {person(r.agent, "No agent")} · added by{" "}
          {person(r.added_by, "not recorded")}
        </small>
        {r.notes && <small>{r.notes}</small>}
      </>
    );
  const timing =
    row.reason === "on_time"
      ? "on time"
      : row.reason === "late"
        ? "late"
        : row.reason === "no_deadline"
          ? "no deadline"
          : null;
  return (
    <>
      <span>
        Assigned {date(r.assigned_at)} to {person(r.agent, "no agent")}
      </span>
      <small>by {person(r.assigned_by, "not recorded")}</small>
      <small>
        {r.first_call_at
          ? `First call ${date(r.first_call_at)}${timing ? ` (${timing})` : ""}`
          : r.missed_at
            ? `Deadline missed ${date(r.missed_at)}`
            : r.call_due_at
              ? `First call due ${date(r.call_due_at)}`
              : "No first call yet"}
        {row.amount != null && ` · ${minutes(row.amount)} working`}
      </small>
    </>
  );
}
const recordLabel = {
  call: "Call",
  visit: "Visit",
  deal: "Deal",
  followup: "Follow-up",
  assignment: "Assignment",
};
// The calls on one lead, from the lead's timeline (loaded only when asked).
function CallHistory({ lead, onClose }) {
  const q = useQuery({
    queryKey: ["lead-timeline", lead.id],
    queryFn: ({ signal }) => api(`/leads/${lead.id}/timeline`, { signal }),
  });
  const calls = (Array.isArray(q.data) ? q.data : []).filter(
    (item) => item.kind === "calls",
  );
  return (
    <section
      className="drill-history"
      aria-label={`Call history for ${lead.number}`}
    >
      <header>
        <h3>
          Call history · {lead.number} {lead.name}
        </h3>
        <Button variant="secondary" onClick={onClose}>
          Hide
        </Button>
      </header>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        !q.error && (
          <Table
            rows={calls}
            columns={[
              {
                key: "started_at",
                label: "When",
                render: (c) => date(c.started_at || c.created_at),
              },
              { key: "outcome", label: "Outcome", render: (c) => callText(c) },
              {
                key: "actor",
                label: "Called by",
                render: (c) => c.actor_name || "Not recorded",
              },
              {
                key: "agent",
                label: "Filed under",
                render: (c) => c.agent_name || "—",
              },
            ]}
          />
        )
      )}
    </section>
  );
}
export default function ReportDrilldown({
  report,
  metric,
  drillKey,
  info,
  shown,
  related,
  filters,
  filterText,
  state,
  onState,
  onSelect,
  onRefreshReport,
  agents,
  own = false,
  onClose,
}) {
  const note = report === "summary" ? summaryNotes[metric] : null;
  const [search, setSearch] = useState(state.search || "");
  const [history, setHistory] = useState(null);
  const [checked, setChecked] = useState(null);
  // Searching waits for a pause in typing.
  useEffect(() => {
    if (search === (state.search || "")) return;
    const timer = setTimeout(() => onState({ search, page: 1 }), 350);
    return () => clearTimeout(timer);
  }, [search, state.search, onState]);
  const params = {
    report,
    metric,
    ...(drillKey !== undefined ? { key: drillKey ?? "none" } : {}),
    ...filters,
    ...(state.search ? { search: state.search } : {}),
    ...(state.status ? { status: state.status } : {}),
    ...(state.owner ? { owner: state.owner } : {}),
    ...(state.sort ? { sort: state.sort } : {}),
    page: String(state.page || 1),
    limit: String(limit),
  };
  const q = useQuery({
    queryKey: ["report-drilldown", params],
    queryFn: ({ signal }) =>
      api("/reports/drilldown?" + new URLSearchParams(params), { signal }),
    enabled: !note,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  // Page 1 carries the report's own number, worked out with the records.
  useEffect(() => {
    if (data?.page === 1 && data.report_value !== undefined) setChecked(data);
  }, [data]);
  const [one, many] = kindNouns[data?.kind] || kindNouns.lead;
  const narrowed = !!(state.search || state.status || state.owner);
  const gone = (r, render) => (r.hidden ? "—" : render());
  const value = (v) => (v == null ? null : Number(v));
  const mismatch =
    checked && value(checked.value) !== value(checked.report_value);
  const changed =
    checked &&
    shown !== undefined &&
    value(shown) !== value(checked.report_value);
  const rows = data?.data || [];
  const page = data?.page || 1;
  return (
    <Modal title={info.title} onClose={onClose} className="report-drill-dialog">
      <div className="drill-context">
        <p>{info.about}</p>
        <p className="field-hint">{filterText}</p>
        {own && (
          <p className="field-hint">
            Only your own work is listed. A lead now handled by another agent
            shows only its number and your record.
          </p>
        )}
      </div>
      {related.length > 1 && (
        <div
          className="drill-related"
          role="group"
          aria-label="Related numbers"
        >
          {related.map((r) => {
            const current = r.metric === metric && r.key === drillKey;
            return (
              <button
                key={r.metric + ":" + r.key}
                type="button"
                aria-pressed={current}
                className={current ? "active" : ""}
                onClick={() => !current && onSelect(r.metric, r.key)}
              >
                {r.label} <b>{r.value ?? 0}</b>
              </button>
            );
          })}
        </div>
      )}
      {note ? (
        <div className="drill-note">
          <p>{note.about}</p>
          <Link className="button secondary" to={note.link[0]}>
            {note.link[1]}
          </Link>
        </div>
      ) : (
        <>
          <div className="toolbar drill-toolbar">
            <input
              type="search"
              aria-label="Search these records"
              placeholder="Lead number, name or contact number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Current status"
              value={state.status || ""}
              onChange={(e) => onState({ status: e.target.value, page: 1 })}
            >
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
            {!own && (
              <select
                aria-label="Assigned agent"
                value={state.owner || ""}
                onChange={(e) => onState({ owner: e.target.value, page: 1 })}
              >
                <option value="">Any assigned agent</option>
                <option value="none">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Sort by"
              value={state.sort || "recent"}
              onChange={(e) =>
                onState({
                  sort: e.target.value === "recent" ? "" : e.target.value,
                  page: 1,
                })
              }
            >
              {sorts.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {mismatch && (
            <p className="drill-notice error" role="alert">
              These records add up to {value(checked.value) ?? "—"}, but the
              report works out {value(checked.report_value) ?? "—"}. Please
              report this to your CRM developer.
            </p>
          )}
          {!mismatch && changed && (
            <p className="drill-notice" role="status">
              The report showed {shown ?? 0} when it loaded; it is{" "}
              {value(checked.report_value) ?? 0} now.{" "}
              <button
                type="button"
                className="report-link"
                onClick={onRefreshReport}
              >
                Refresh the report
              </button>
            </p>
          )}
          <ErrorBox error={q.error} />
          {q.isPending ? (
            <Loader />
          ) : (
            data && (
              <>
                <p className="lead-count" role="status">
                  {data.count
                    ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, data.count)} of ${data.count} ${data.count === 1 ? one : many}`
                    : `No ${many} match`}
                  {data.kind !== "lead" &&
                    data.count > 0 &&
                    ` across ${data.leads} lead${data.leads === 1 ? "" : "s"}`}
                  {narrowed && ` (narrowed from ${data.records})`}
                  {data.measure === "sum" && ` · total ${pkr(data.value)}`}
                  {data.measure === "avg" &&
                    ` · average ${minutes(data.value)} (working time)`}
                  {data.measure === "minutes" &&
                    ` · talk time ${minutes(data.value)}`}
                </p>
                <Table
                  rows={rows}
                  columns={[
                    {
                      key: "lead",
                      label: "Lead",
                      render: (r) =>
                        r.hidden ? (
                          <span className="drill-cell">
                            <b>{r.lead.number}</b>
                            <small>Now handled by another agent</small>
                          </span>
                        ) : (
                          <span className="drill-cell">
                            <Link
                              to={`/leads/${r.lead.id}`}
                              aria-label={`Open lead ${r.lead.number} ${r.lead.name}`}
                            >
                              {r.lead.number}
                            </Link>
                            <b>{r.lead.name}</b>
                            <small>{r.lead.masked_phone || "No number"}</small>
                            <small>{r.lead.source}</small>
                          </span>
                        ),
                    },
                    {
                      key: "status",
                      label: "Status and reason",
                      render: (r) =>
                        r.hidden ? (
                          <span className="drill-cell">
                            <small>Not your lead now</small>
                            {data.kind === "lead" && r.at && (
                              <small>Your latest call {date(r.at)}</small>
                            )}
                            <Why row={r} report={report} metric={metric} />
                          </span>
                        ) : (
                          <span className="drill-cell">
                            <Badge value={r.lead.status} />
                            <Why row={r} report={report} metric={metric} />
                          </span>
                        ),
                    },
                    ...(own
                      ? []
                      : [
                          {
                            key: "agent",
                            label: "Assigned agent",
                            render: (r) =>
                              person(r.lead.assigned_agent, "Unassigned"),
                          },
                        ]),
                    ...(data.kind !== "lead"
                      ? [
                          {
                            key: "record",
                            label: recordLabel[data.kind],
                            render: (r) => (
                              <span className="drill-cell">
                                <Record row={r} />
                              </span>
                            ),
                          },
                        ]
                      : []),
                    {
                      key: "last_call",
                      label: "Last call",
                      render: (r) =>
                        r.hidden ? (
                          "—"
                        ) : r.last_call ? (
                          <span className="drill-cell">
                            <span>{date(r.last_call.started_at)}</span>
                            <small>{callText(r.last_call)}</small>
                            <Caller call={r.last_call} />
                            {r.temperature && (
                              <small className="badge">{r.temperature}</small>
                            )}
                          </span>
                        ) : (
                          "No call recorded"
                        ),
                    },
                    {
                      key: "next",
                      label: "Follow-up and visit",
                      render: (r) =>
                        gone(r, () => (
                          <span className="drill-cell">
                            {r.next_followup ? (
                              <span>
                                Next follow-up {date(r.next_followup.due_at)}
                                {r.next_followup.overdue && (
                                  <b className="badge overdue"> overdue</b>
                                )}
                              </span>
                            ) : (
                              <small>No follow-up pending</small>
                            )}
                            {r.latest_visit && (
                              <small>
                                Visit {statusLabel(r.latest_visit.status)}{" "}
                                {date(r.latest_visit.scheduled_at)}
                                {r.latest_visit.property &&
                                  ` · ${r.latest_visit.property}`}
                              </small>
                            )}
                            {r.deal && (
                              <small>
                                Deal {statusLabel(r.deal.stage)} ·{" "}
                                {pkr(r.deal.expected_value)}
                              </small>
                            )}
                          </span>
                        )),
                    },
                    {
                      key: "dates",
                      label: "Created · last activity",
                      render: (r) =>
                        gone(r, () => (
                          <span className="drill-cell">
                            <span>{date(r.lead.created_at)}</span>
                            <small>{date(r.lead.last_activity_at)}</small>
                          </span>
                        )),
                    },
                    {
                      key: "open",
                      label: "Calls",
                      render: (r) =>
                        r.hidden ? (
                          "—"
                        ) : r.calls ? (
                          <Button
                            variant="secondary"
                            aria-label={`Call history for ${r.lead.number}`}
                            onClick={() => setHistory(r.lead)}
                          >
                            {r.calls} call{r.calls === 1 ? "" : "s"}
                          </Button>
                        ) : (
                          "None"
                        ),
                    },
                  ]}
                />
                <Pagination
                  page={page}
                  count={data.count}
                  limit={limit}
                  onPage={(next) => onState({ page: next })}
                />
              </>
            )
          )}
          {history && (
            <CallHistory lead={history} onClose={() => setHistory(null)} />
          )}
        </>
      )}
    </Modal>
  );
}
