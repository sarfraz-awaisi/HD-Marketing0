import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCircle2, FileText, LogOut } from "lucide-react";
import { api } from "../../lib/api";
import {
  addDays,
  dayLabel,
  startOfMonth,
  startOfWeek,
  todayPk,
} from "../../lib/calendar";
import { percent } from "../../lib/tasks";
import { KpiTile } from "../dashboard/Widgets";
import { ErrorBox, Loader, Table } from "../common/UI";
import { ProgressBar } from "./TaskCard";
// Performance history (update 045), from the actual assignments, reports and
// requests. Every task counts equally in an average; measurable tasks count
// up to 100%, simple tasks 100% when completed and 0% otherwise.
const ranges = {
  week: () => [startOfWeek(todayPk()), todayPk()],
  month: () => [startOfMonth(todayPk()), todayPk()],
  last30: () => [addDays(todayPk(), -29), todayPk()],
};
export default function TaskPerformance() {
  const [preset, setPreset] = useState("week"),
    [custom, setCustom] = useState(() => ranges.week()),
    [user, setUser] = useState("");
  const [from, to] = preset === "custom" ? custom : ranges[preset]();
  const agents = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const params = new URLSearchParams({ from, to, ...(user ? { user } : {}) });
  const q = useQuery({
    queryKey: ["task-performance", params.toString()],
    queryFn: ({ signal }) =>
      api("/admin/tasks/performance?" + params, { signal }),
    enabled: from <= to,
  });
  const d = q.data;
  return (
    <section className="task-performance">
      <div className="panel toolbar task-filters">
        <select
          aria-label="Period"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="last30">Last 30 days</option>
          <option value="custom">Choose dates</option>
        </select>
        {preset === "custom" && (
          <>
            <label>
              From
              <input
                type="date"
                value={custom[0]}
                onChange={(e) => setCustom([e.target.value, custom[1]])}
              />
            </label>
            <label>
              Through
              <input
                type="date"
                value={custom[1]}
                onChange={(e) => setCustom([custom[0], e.target.value])}
              />
            </label>
          </>
        )}
        <select
          aria-label="Agent"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        >
          <option value="">All agents</option>
          {(agents.data || [])
            .filter((u) => u.role === "agent")
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.active ? "" : " (disabled)"}
              </option>
            ))}
        </select>
      </div>
      {from > to && (
        <ErrorBox error="The period must end on or after its start." />
      )}
      <ErrorBox error={q.error} />
      {q.isPending && from <= to ? (
        <Loader />
      ) : d ? (
        <>
          <section className="kpi-grid task-kpis" aria-label="Period totals">
            <KpiTile
              label="Average completion"
              value={percent(d.totals.average_percent)}
              note={`${d.totals.completed} of ${d.totals.assignments} assignments completed`}
              icon={BarChart3}
              tone="navy"
            />
            <KpiTile
              label="Verified average"
              value={percent(d.totals.verified_average_percent)}
              note={`${d.totals.verified} verified by an administrator`}
              icon={CheckCircle2}
              tone="green"
            />
            <KpiTile
              label="Daily reports"
              value={d.totals.reports}
              icon={FileText}
              tone="gold"
            />
            <KpiTile
              label="Approved checkouts"
              value={d.totals.early_approved + d.totals.emergency_approved}
              note={`${d.totals.early_approved} early · ${d.totals.emergency_approved} emergency`}
              icon={LogOut}
              tone="navy"
            />
          </section>
          <section className="panel">
            <h2>By agent</h2>
            <Table
              columns={[
                {
                  key: "name",
                  label: "Agent",
                  render: (e) => (
                    <>
                      {e.name}
                      {!e.active && <small> (disabled)</small>}
                    </>
                  ),
                },
                {
                  key: "assignments",
                  label: "Tasks",
                  render: (e) => `${e.completed} of ${e.assignments} completed`,
                },
                {
                  key: "average_percent",
                  label: "Reported",
                  render: (e) => percent(e.average_percent),
                },
                {
                  key: "verified_average_percent",
                  label: "Verified",
                  render: (e) =>
                    e.verified
                      ? `${percent(e.verified_average_percent)} (${e.verified})`
                      : "—",
                },
                {
                  key: "reports",
                  label: "Reports",
                  render: (e) =>
                    `${e.reports} of ${e.task_days} task days${e.missing_reports ? ` · ${e.missing_reports} missing` : ""}`,
                },
                {
                  key: "early",
                  label: "Early checkouts",
                  render: (e) =>
                    `${e.early.approved} approved · ${e.early.rejected} rejected`,
                },
                {
                  key: "emergency",
                  label: "Emergency",
                  render: (e) =>
                    `${e.emergency.approved} approved · ${e.emergency.rejected} rejected`,
                },
              ]}
              rows={d.employees}
            />
          </section>
          <section className="panel">
            <h2>By day</h2>
            <ul className="trend-list">
              {d.days
                .filter((x) => x.assignments || x.reports)
                .map((x) => (
                  <li key={x.date}>
                    <span>{dayLabel(x.date)}</span>
                    <ProgressBar
                      value={x.average_percent}
                      label={`${dayLabel(x.date)} average completion`}
                    />
                    <span>
                      {percent(x.average_percent)} · {x.completed}/
                      {x.assignments} done · {x.reports} reports
                    </span>
                  </li>
                ))}
              {!d.days.some((x) => x.assignments || x.reports) && (
                <li className="empty">No tasks were due in this period.</li>
              )}
            </ul>
          </section>
        </>
      ) : null}
    </section>
  );
}
