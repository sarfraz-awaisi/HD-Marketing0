import { useQuery } from "@tanstack/react-query";
import { api, date, pkr } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { lostReasonLabel, statusLabel } from "../../lib/pipeline";
import { followUpState, followUpStateLabel } from "../../lib/followups";
import { temperatureOf } from "../../lib/temperature";
import {
  historySummary,
  periodRecords,
  periodWork,
  recordedBy,
  summaryText,
  usageChoices,
  usageOption,
  usedTimes,
} from "../../lib/leadUsage";
import { ErrorBox, Loader, Modal } from "../common/UI";
import { TemperatureBadge } from "./LeadCells";
import "../../styles/lead-usage.css";
// Update 075: Lead Usage on administrators' All leads. The choices are
// exact numbers of different agents, each with how many leads it would show
// with the list's other search and filters; the database counts them.
// counts: the list's usage counts; undefined while loading, null when the
// database has no update 075 yet.
export function LeadUsageFilter({ value = "", counts, onChange }) {
  const n = (v) => Number(v ?? 0).toLocaleString();
  const text = (label, v) => (counts ? `${label} (${n(v)})` : label);
  const missing = counts === null && !value;
  return (
    <label
      className="lead-usage-filter"
      title={
        missing
          ? "Lead Usage needs CRM database update 075."
          : "The number of different agents each lead has been assigned to."
      }
    >
      <span>Lead Usage</span>
      <select
        value={value}
        disabled={missing}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{text("All Leads", counts?.all)}</option>
        {usageChoices.map((u) => (
          <option key={u} value={String(u)}>
            {text(usageOption(u), counts?.[u])}
          </option>
        ))}
      </select>
    </label>
  );
}
// A lead's usage in its row, when more than one agent has had it: opens its
// agent history.
export function LeadUsageButton({ lead, onOpen }) {
  if (!(lead.agents_used >= 2)) return null;
  return (
    <button
      type="button"
      className="lead-usage-button"
      title={`Assigned to ${lead.agents_used} different agents`}
      aria-label={`${usedTimes(lead.agents_used)}: open the agent history of ${lead.name}`}
      onClick={() => onOpen(lead)}
    >
      {usedTimes(lead.agents_used)}
    </button>
  );
}

export function LeadHistoryDialog({ lead, onClose }) {
  const q = useQuery({
    queryKey: ["lead-agent-history", lead.id],
    queryFn: ({ signal }) => api(`/leads/${lead.id}/agent-history`, { signal }),
    retry: false,
  });
  return (
    <Modal
      title={`Agent history · ${lead.name}`}
      className="lead-history"
      onClose={onClose}
    >
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <History history={q.data} />
      )}
    </Modal>
  );
}

const unavailable = "Historical value unavailable";
function History({ history }) {
  const people = history.people || {};
  const person = (id) =>
    id ? people[id] || { name: "Former employee", deleted: true } : null;
  const summary = historySummary(history);
  const current = person(history.lead.assigned_agent);
  // Which time each agent has the lead (Ali's second assignment…).
  const turns = new Map();
  const turn = history.periods.map((p) => {
    if (!p.agent_id) return 0;
    turns.set(p.agent_id, (turns.get(p.agent_id) || 0) + 1);
    return turns.get(p.agent_id);
  });
  return (
    <div className="lead-history-body">
      <dl className="lead-history-facts">
        <div>
          <dt>Lead</dt>
          <dd>
            <b>{history.lead.name}</b>
            <small>{formatLeadNo(history.lead.lead_no)}</small>
          </dd>
        </div>
        <div>
          <dt>Different agents</dt>
          <dd>
            <b>{summary.used}</b>
          </dd>
        </div>
        <div>
          <dt>Current agent</dt>
          <dd>
            {current ? (
              <>
                <b>{current.name}</b>
                {current.active === false && <small>Disabled account</small>}
              </>
            ) : (
              <span className="lead-muted">No agent (admin team)</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Stage now</dt>
          <dd>{statusLabel(history.lead.status)}</dd>
        </div>
      </dl>
      <p className="lead-history-summary">{summaryText(summary)}</p>
      {!history.current_recorded && (
        <p className="lead-history-warning" role="note">
          The current agent&apos;s assignment has no assignment record, so it is
          not in the timeline below.
        </p>
      )}
      <ol className="lead-history-periods">
        {history.periods.map((p, i) => (
          <Period key={p.seq} period={p} person={person} turn={turn[i]} />
        ))}
      </ol>
      <p className="field-hint">
        Times are Pakistan time. Each record is shown in the assignment it was
        saved in, with who saved it; a call an administrator logged is the
        administrator&apos;s, not the agent&apos;s. Calls, comments and notes
        are shown exactly as saved.
      </p>
    </div>
  );
}

const levels = {
  never: ["Assigned but never worked", "neutral"],
  attempted: ["Call attempted, not reached", "warning"],
  contacted: ["Successfully contacted", "completed"],
  responded: ["Successfully contacted", "completed"],
  other: ["Worked without a call", "info"],
};
const reasons = {
  missed_first_call: "Reassigned after a missed first call",
  no_activity: "Reassigned for no activity",
};
function Period({ period, person, turn }) {
  const agent = person(period.agent_id);
  const work = periodWork(period);
  const records = periodRecords(period);
  const by = person(period.assigned_by);
  const isAgent = period.kind === "agent";
  const title =
    period.kind === "before"
      ? "Before the first assignment"
      : period.kind === "admin_team"
        ? "Admin team (no agent)"
        : agent.name;
  const [level, tone] = levels[work.level];
  const response = work.responded.at(-1);
  const comment = [...work.calls]
    .reverse()
    .find((c) => c.notes && c.notes.trim());
  return (
    <li className={`lead-history-period ${period.kind}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {isAgent && (
            <small className="lead-history-id">
              {agent.uid ? `Agent ID ${agent.uid}` : "Agent ID unavailable"}
              {agent.active === false && " · Disabled account"}
              {agent.deleted && " · Former employee"}
            </small>
          )}
        </div>
        <span className="lead-history-flags">
          {period.end === "current" ? (
            <span className="badge plain completed">Current</span>
          ) : (
            <span className="badge plain">Earlier</span>
          )}
          {turn > 1 && (
            <span className="badge plain info">Assignment {turn}</span>
          )}
        </span>
      </header>
      <p className="lead-history-when">
        {period.kind === "before" ? (
          <>Lead added {date(period.started_at)}</>
        ) : (
          <>
            Assigned {date(period.started_at)}
            {by && ` by ${by.name}`}
          </>
        )}
        <br />
        {period.end === "next" ? (
          <>Until {date(period.ended_at)}</>
        ) : period.end === "current" ? (
          <>Current, no end yet</>
        ) : (
          <span className="lead-history-missing">
            End not recorded: the agent was removed without an assignment record
            (this happens when a lead is moved to Deleted leads and restored).
          </span>
        )}
        {reasons[period.reason] && (
          <>
            <br />
            {reasons[period.reason]}
          </>
        )}
        {period.assigned_again.length > 0 && (
          <>
            <br />
            Assigned to {agent?.name || "the same agent"} again{" "}
            {period.assigned_again.map((a) => date(a.at)).join(", ")}, with no
            one in between
          </>
        )}
      </p>
      {isAgent && (
        <>
          <p className="lead-history-badges">
            <span className={`badge plain ${tone}`}>{level}</span>
            {response && (
              <span className="badge plain interested">
                Customer response: {response.outcome}
              </span>
            )}
            {work.followupsDone.length > 0 && (
              <span className="badge plain completed">Follow-up performed</span>
            )}
          </p>
          <dl className="lead-history-numbers">
            <div>
              <dt>Calls</dt>
              <dd>{work.calls.length}</dd>
            </div>
            <div>
              <dt>Successful contacts</dt>
              <dd>{work.connected.length}</dd>
            </div>
            <div>
              <dt>First call</dt>
              <dd>
                {period.first_call_at
                  ? date(period.first_call_at)
                  : period.missed_at
                    ? "Deadline missed"
                    : "—"}
              </dd>
            </div>
          </dl>
          {work.outcomes.length > 0 && (
            <p className="lead-history-line">
              <span>Call outcomes</span>
              {work.outcomes.map((o) => (
                <span
                  key={o.outcome}
                  className={`badge plain ${work.connected.some((c) => c.outcome === o.outcome) ? "completed" : "warning"}`}
                >
                  {o.outcome}
                  {o.count > 1 ? ` ×${o.count}` : ""}
                </span>
              ))}
            </p>
          )}
          <p className="lead-history-line">
            <span>Temperature</span>
            {work.temperatures.length ? (
              work.temperatures.map((t, i) => (
                <TemperatureBadge key={i} value={t} />
              ))
            ) : (
              <span className="lead-muted">
                {unavailable}: none saved in this assignment
              </span>
            )}
          </p>
          {comment && (
            <p className="lead-history-comment">
              <span>Latest call comment</span>
              {comment.notes}
            </p>
          )}
          {work.others > 0 && (
            <p className="lead-muted">
              {work.others} {work.others === 1 ? "record" : "records"} in this
              period saved by someone else (shown below), not counted as{" "}
              {agent.name}&apos;s work.
            </p>
          )}
        </>
      )}
      {records.length > 0 ? (
        <details className="lead-history-records">
          <summary>
            All records in this period ({records.length}): calls, comments,
            notes, stages, follow-ups, visits and deals
          </summary>
          <ol>
            {records.map((r) => (
              <Record
                key={r.kind + r.item.id}
                kind={r.kind}
                item={r.item}
                person={person}
                agent={period.agent_id}
                start={period.started_at}
              />
            ))}
          </ol>
        </details>
      ) : (
        <p className="lead-muted">Nothing saved in this period.</p>
      )}
    </li>
  );
}

// start: when the period began. A manual call can be logged later with the
// time it happened; it belongs to the period it was saved in, which says so
// when the call itself is earlier.
function Record({ kind, item, person, agent, start }) {
  const actor = recordedBy(kind, item);
  const who = person(actor);
  const role =
    who?.role === "admin"
      ? " (administrator)"
      : who?.role === "staff"
        ? " (staff)"
        : "";
  const byline = who
    ? `By ${who.name}${role}${agent && actor !== agent ? " · not this agent's" : ""}`
    : `By: ${unavailable}`;
  const logged =
    kind === "calls" &&
    item.started_at &&
    Date.parse(item.started_at) < Date.parse(start)
      ? ` · saved ${date(item.saved_at)}`
      : "";
  return (
    <li className={`lead-history-record ${kind}`}>
      <div className="lead-history-record-head">
        <b>{recordTitle(kind, item)}</b>
        <small>{date(recordTime(kind, item))}</small>
      </div>
      <small className="lead-history-by">
        {byline}
        {logged}
      </small>
      <RecordBody kind={kind} item={item} />
    </li>
  );
}
const recordTime = (kind, item) =>
  ({
    calls: item.started_at || item.saved_at,
    notes: item.at,
    status_changes: item.at,
  })[kind] ?? item.created_at;
function recordTitle(kind, item) {
  if (kind === "calls")
    return `${item.method === "manual" ? "Manual call" : "Call"}`;
  if (kind === "notes") return "Note";
  if (kind === "status_changes")
    return `Stage: ${item.from ? statusLabel(item.from) + " → " : ""}${statusLabel(item.to)}`;
  if (kind === "followups") return `Follow-up for ${date(item.due_at)}`;
  if (kind === "visits") return `Site visit for ${date(item.scheduled_at)}`;
  return `Deal: ${statusLabel(item.stage)}`;
}
function RecordBody({ kind, item }) {
  if (kind === "calls") {
    const temperature = (item.tags || []).find((t) => temperatureOf(t));
    const others = (item.tags || []).filter((t) => !temperatureOf(t));
    return (
      <>
        <p className="lead-history-line">
          <span
            className={`badge plain ${item.connected ? "completed" : "warning"}`}
          >
            {item.outcome || "No outcome saved"}
          </span>
          {temperature && <TemperatureBadge value={temperature} />}
          {others.map((t) => (
            <span key={t} className="badge plain">
              {t}
            </span>
          ))}
          <small>
            {item.connected ? "Answered" : "Not answered"}
            {item.duration_seconds ? ` · ${item.duration_seconds}s` : ""}
          </small>
        </p>
        {item.notes && <p className="lead-history-text">{item.notes}</p>}
      </>
    );
  }
  if (kind === "notes") return <p className="lead-history-text">{item.body}</p>;
  if (kind === "status_changes")
    return item.lost_reason ? (
      <p>Lost reason: {lostReasonLabel(item.lost_reason)}</p>
    ) : null;
  if (kind === "followups")
    return (
      <>
        <p>
          {followUpStateLabel(followUpState(item))}
          {item.completed_at && ` ${date(item.completed_at)}`}
          {item.cancelled_on_reassignment &&
            " when the lead moved to another agent"}
        </p>
        {item.notes && <p className="lead-history-text">{item.notes}</p>}
      </>
    );
  if (kind === "visits")
    return (
      <>
        <p>
          {statusLabel(item.status)}
          {item.property && ` · ${item.property}`}
          {item.cancelled_on_reassignment &&
            " · cancelled when the lead moved to another agent"}
        </p>
        {item.notes && <p className="lead-history-text">{item.notes}</p>}
      </>
    );
  return (
    <>
      <p>
        {item.expected_value != null && `Value ${pkr(item.expected_value)}`}
        {item.property && ` · ${item.property}`}
        {item.lost_reason && ` · Lost: ${lostReasonLabel(item.lost_reason)}`}
      </p>
      {item.lost_note && <p className="lead-history-text">{item.lost_note}</p>}
      {item.notes && <p className="lead-history-text">{item.notes}</p>}
    </>
  );
}
