import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  FileText,
  ListChecks,
  LogOut,
  TriangleAlert,
  Users,
} from "lucide-react";
import { api } from "../../lib/api";
import { fullDayLabel, todayPk } from "../../lib/calendar";
import { invalidateTasks, percent } from "../../lib/tasks";
import { roleLabel } from "../../lib/roles";
import { KpiTile } from "../../components/dashboard/Widgets";
import {
  Button,
  ErrorBox,
  Loader,
  Table,
  useToast,
} from "../../components/common/UI";
import AssignTaskForm from "../../components/tasks/AssignTaskForm";
import AdminTaskList from "../../components/tasks/AdminTaskList";
import AdminReports, {
  ReportDetail,
} from "../../components/tasks/AdminReports";
import CheckoutRequests from "../../components/tasks/CheckoutRequests";
import TaskPerformance from "../../components/tasks/TaskPerformance";
import "../../styles/dashboard.css";
import "../../styles/tasks.css";
// Task management (update 045): assign tasks, follow progress, review daily
// reports and decide checkout requests. The server enforces every rule.
const tabs = [
  ["overview", "Overview"],
  ["assign", "Assign Tasks"],
  ["team", "Team Tasks"],
  ["individual", "Individual Tasks"],
  ["reports", "Daily Reports"],
  ["requests", "Checkout Requests"],
  ["performance", "Performance History"],
  ["settings", "Checkout Rules"],
];

function Overview({ onTab }) {
  const [day, setDay] = useState(todayPk()),
    [report, setReport] = useState(null);
  const q = useQuery({
    queryKey: ["task-overview", day],
    queryFn: ({ signal }) =>
      api(`/admin/tasks/overview?date=${day}`, { signal }),
    refetchInterval: 60000,
  });
  const o = q.data;
  return (
    <>
      <div className="panel toolbar task-filters">
        <label>
          Day
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value || todayPk())}
          />
        </label>
        {o && (
          <span className={`badge ${o.rules_active ? "completed" : ""}`}>
            Checkout rules {o.rules_active ? "on" : "off"} for this day
          </span>
        )}
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : o ? (
        <>
          <section className="kpi-grid task-kpis" aria-label="Day totals">
            <KpiTile
              label="Active tasks"
              value={o.active_tasks}
              note={`${o.assigned_today} assigned for this day`}
              icon={ClipboardList}
              tone="navy"
            />
            <KpiTile
              label="Completed"
              value={`${o.completed}/${o.assignments}`}
              note={`${o.pending} still open · average ${percent(o.average_percent)}`}
              icon={ListChecks}
              tone="green"
            />
            <KpiTile
              label="Reports submitted"
              value={`${o.reports_submitted}/${o.agents_with_tasks}`}
              note={`${o.missing_reports.length === 1 ? "1 person with tasks hasn't" : `${o.missing_reports.length} people with tasks haven't`} reported · ${o.reports_to_review} to review`}
              icon={FileText}
              tone="gold"
            />
            <KpiTile
              label="Checkout requests"
              value={o.pending_early + o.pending_emergency}
              note={`${o.pending_early} early · ${o.pending_emergency} emergency waiting`}
              icon={LogOut}
              tone={o.pending_emergency ? "gold" : "navy"}
            />
          </section>
          {o.overdue_reports > 0 && (
            <div className="panel task-alert" role="status">
              <FileText size={18} aria-hidden="true" />
              <span>
                {o.overdue_reports === 1
                  ? "1 daily report from the last 7 days is overdue."
                  : `${o.overdue_reports} daily reports from the last 7 days are overdue.`}
              </span>
              <Button variant="secondary" onClick={() => onTab("reports")}>
                See overdue reports
              </Button>
            </div>
          )}
          {o.pending_early + o.pending_emergency > 0 && (
            <div className="panel task-alert" role="status">
              <TriangleAlert size={18} aria-hidden="true" />
              <span>
                {o.pending_early + o.pending_emergency} checkout request(s) are
                waiting for a decision.
              </span>
              <Button variant="secondary" onClick={() => onTab("requests")}>
                Open Checkout Requests
              </Button>
            </div>
          )}
          <section className="panel">
            <div className="panel-heading">
              <h2>
                <Users size={18} aria-hidden="true" /> Agents and staff on{" "}
                {fullDayLabel(o.date)}
              </h2>
            </div>
            <Table
              columns={[
                {
                  key: "name",
                  label: "Employee",
                  render: (p) => (
                    <>
                      {p.name} <small>UID {p.uid}</small>
                      <small className="employee-sub">
                        {[roleLabel(p.role), p.department]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </>
                  ),
                },
                {
                  key: "tasks",
                  label: "Tasks",
                  render: (p) =>
                    p.tasks
                      ? `${p.completed} of ${p.tasks} completed`
                      : "No tasks",
                },
                {
                  key: "percent",
                  label: "Completion",
                  render: (p) => percent(p.percent),
                },
                {
                  key: "report",
                  label: "Daily report",
                  render: (p) =>
                    p.report ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setReport(p.report.id)}
                      >
                        {p.report.status === "reviewed"
                          ? "Reviewed"
                          : "Submitted"}{" "}
                        · {percent(p.report.completion_percent)}
                      </button>
                    ) : p.tasks ? (
                      <span className="badge warning">Not submitted</span>
                    ) : (
                      "—"
                    ),
                },
              ]}
              rows={o.people}
            />
          </section>
        </>
      ) : null}
      {report && <ReportDetail id={report} onClose={() => setReport(null)} />}
    </>
  );
}

function RulesSettings() {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["task-settings"],
    queryFn: ({ signal }) => api("/admin/tasks/settings", { signal }),
  });
  const [from, setFrom] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(value) {
    setBusy(true);
    setError("");
    try {
      await api("/admin/tasks/settings", {
        method: "PATCH",
        body: { rules_from: value },
      });
      invalidateTasks(qc);
      toast(
        value
          ? `Checkout rules start on ${fullDayLabel(value)}`
          : "Checkout rules turned off",
      );
      setFrom("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (q.isPending) return <Loader />;
  const s = q.data || {};
  return (
    <section className="panel task-settings">
      <h2>Checkout rules</h2>
      <p>
        <b>Status:</b>{" "}
        {s.rules_from
          ? `${s.rules_active_today ? "On" : "Scheduled"} from ${fullDayLabel(s.rules_from)}`
          : "Off. Agents and staff check out as before."}
      </p>
      <p>When the rules are on, for agents and staff (never administrators):</p>
      <ul>
        <li>
          Checking out needs the daily work report (an honest report with
          unfinished work is fine).
        </li>
        <li>
          Checking out before the shift ends needs an approved early checkout
          (every task due that day completed and the report submitted) or an
          approved emergency checkout.
        </li>
        <li>
          Days before the start date and every earlier check-out stay exactly as
          they are. Administrators are never affected.
        </li>
        <li>
          Nobody is ever checked out automatically. If someone leaves during an
          emergency without approval, the day is fixed afterwards with a
          check-out correction.
        </li>
      </ul>
      <div className="task-filters">
        <label>
          Start the rules on
          <input
            type="date"
            min={s.today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <Button disabled={busy || !from} onClick={() => save(from)}>
          {busy ? "Saving…" : "Save start date"}
        </Button>
        {s.rules_from && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => save(null)}
          >
            Turn the rules off
          </Button>
        )}
      </div>
      <ErrorBox error={error || q.error} />
    </section>
  );
}

export default function TaskManagement() {
  const [params, setParams] = useSearchParams();
  const tab = tabs.some(([k]) => k === params.get("tab"))
    ? params.get("tab")
    : "overview";
  const open = (key) => setParams({ tab: key });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CLEAR GOALS, HONEST REPORTING</span>
          <h1>Task management</h1>
          <p>
            Assign daily tasks, follow each person's progress, review end-of-day
            reports and decide checkout requests.
          </p>
        </div>
      </div>
      <div
        className="inventory-tabs task-tabs"
        role="tablist"
        aria-label="Task management sections"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => open(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="task-panel">
        {tab === "overview" && <Overview onTab={open} />}
        {tab === "assign" && (
          <AssignTaskForm
            onAssigned={(t) => open(t.scope === "team" ? "team" : "individual")}
          />
        )}
        {tab === "team" && <AdminTaskList key="team" scope="team" />}
        {tab === "individual" && (
          <AdminTaskList key="individual" scope="individual" />
        )}
        {tab === "reports" && (
          <AdminReports initialDate={params.get("date") || ""} />
        )}
        {tab === "requests" && <CheckoutRequests />}
        {tab === "performance" && <TaskPerformance />}
        {tab === "settings" && <RulesSettings />}
      </div>
    </>
  );
}
