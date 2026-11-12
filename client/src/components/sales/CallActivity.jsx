import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PhoneCall } from "lucide-react";
import { api } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { dueLabel, firstCallState } from "../../lib/firstCall";
import { WorkspaceBadges } from "../leads/LeadCells";
import { ErrorBox, Loader, Table } from "../common/UI";
import "../../styles/reports.css";
export const useCallActivity = () =>
  useQuery({
    queryKey: ["call-activity"],
    queryFn: ({ signal }) => api("/call-activity", { signal }),
    refetchInterval: 120000,
  });
const workdayStarted = (activity, now = new Date()) => {
  if (!activity?.is_workday) return false;
  const local = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Karachi",
  }).format(now);
  return local >= activity.work_start;
};
// A number that opens the records behind it (update 051), where the page
// offers that (onOpen).
function Count({ value, label, onOpen, children }) {
  if (!onOpen) return children ?? value;
  return (
    <button
      type="button"
      className="report-link"
      aria-label={`${label}: ${value}. Show the records`}
      onClick={onOpen}
    >
      {children ?? value}
    </button>
  );
}
// Admin view: how each agent's calling is going today. onOpen(metric, agent)
// shows the records behind a number.
export function TeamCallActivity({ onOpen }) {
  const q = useCallActivity();
  const started = workdayStarted(q.data);
  const count = (a, metric, label, children) => (
    <Count
      value={a[metric]}
      label={`${a.name}: ${label}`}
      onOpen={onOpen && (() => onOpen(metric, a.agent_id))}
    >
      {children}
    </Count>
  );
  return (
    <section className="panel team-calls" aria-labelledby="team-calls-title">
      <div className="panel-heading">
        <div>
          <h2 id="team-calls-title">Today's calling</h2>
          <p className="field-hint">
            {q.data
              ? q.data.is_workday
                ? `Working hours ${q.data.work_start}–${q.data.work_end} Pakistan time`
                : "Today is not a working day"
              : "Pakistan time"}
          </p>
        </div>
        <PhoneCall size={20} />
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <Table
          rows={(q.data?.agents || []).map((a) => ({ ...a, id: a.agent_id }))}
          columns={[
            {
              key: "name",
              label: "Agent",
              render: (a) => (
                <span className="call-agent">
                  <b>{a.name}</b>
                  {started && a.calls_today === 0 && (
                    <span className="account-status disabled">
                      No calls yet today
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "calls_today",
              label: "Calls today",
              render: (a) => (
                <span>
                  {count(a, "calls_today", "calls today")} (
                  {count(
                    a,
                    "connected_today",
                    "answered calls today",
                    `${a.connected_today} answered`,
                  )}
                  )
                </span>
              ),
            },
            {
              key: "first_calls_today",
              label: "First calls today",
              render: (a) => count(a, "first_calls_today", "first calls today"),
            },
            {
              key: "waiting",
              label: "Waiting for first call",
              render: (a) => count(a, "waiting", "waiting for a first call"),
            },
            {
              key: "missed",
              label: "Missed first calls",
              render: (a) =>
                count(
                  a,
                  "missed",
                  "missed first calls",
                  a.missed ? (
                    <span className="badge overdue">{a.missed}</span>
                  ) : (
                    0
                  ),
                ),
            },
            {
              key: "followups_overdue",
              label: "Overdue follow-ups",
              render: (a) =>
                count(
                  a,
                  "followups_overdue",
                  "overdue follow-ups",
                  a.followups_overdue ? (
                    <span className="badge overdue">{a.followups_overdue}</span>
                  ) : (
                    0
                  ),
                ),
            },
            {
              key: "idle",
              label: `No activity ${q.data.idle_days}+ days`,
              render: (a) => count(a, "idle", "no recent activity"),
            },
          ]}
        />
      )}
    </section>
  );
}
// Agent view: today's numbers and the leads still waiting for a first call.
// onOpen(metric, agent) shows the records behind a number.
export function MyCalls({ onOpen }) {
  const activity = useCallActivity();
  // Names and deadlines only: the dashboard never loads contact numbers.
  const queue = useQuery({
    queryKey: ["first-call-queue"],
    queryFn: ({ signal }) => api("/first-call-queue", { signal }),
    refetchInterval: 120000,
  });
  const me = Array.isArray(activity.data?.agents)
    ? activity.data.agents[0]
    : null;
  const rows = Array.isArray(queue.data?.data) ? queue.data.data : [];
  return (
    <section className="panel" aria-labelledby="my-calls-title">
      <div className="panel-heading">
        <h2 id="my-calls-title">My calls today</h2>
        <Link to="/leads?view=all&call=uncalled">All leads to call ↗</Link>
      </div>
      <ErrorBox error={activity.error || queue.error} />
      {me && (
        <div className="my-call-stats">
          {[
            ["Calls today", "calls_today"],
            ["First calls today", "first_calls_today"],
            ["Waiting for first call", "waiting"],
            ["Missed first calls", "missed"],
            ["Overdue follow-ups", "followups_overdue"],
          ].map(([label, metric]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>
                <Count
                  value={me[metric]}
                  label={label}
                  onOpen={onOpen && (() => onOpen(metric, me.agent_id))}
                />
              </strong>
            </div>
          ))}
        </div>
      )}
      {queue.isPending ? (
        <Loader />
      ) : rows.length ? (
        rows.map((lead) => {
          const state = firstCallState(lead);
          return (
            <Link to={"/leads/" + lead.id} className="list-row" key={lead.id}>
              <div>
                <b>
                  {formatLeadNo(lead.lead_no)} · {lead.name}
                </b>
                <small>Due {dueLabel(lead.call_due_at)}</small>
                <WorkspaceBadges lead={lead} />
              </div>
              {state && (
                <span className={`badge plain ${state.tone}`}>
                  {state.label}
                </span>
              )}
            </Link>
          );
        })
      ) : (
        <div className="empty">
          No new leads waiting for a first call. Well done.
        </div>
      )}
    </section>
  );
}
