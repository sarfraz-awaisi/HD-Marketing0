import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, FileText, ListChecks, Target } from "lucide-react";
import { api } from "../../lib/api";
import {
  clockLabel,
  pkTime,
  stateLabel,
  useMyAttendance,
} from "../../lib/attendance";
import { fullDayLabel } from "../../lib/calendar";
import { percent } from "../../lib/tasks";
import { workDaysText } from "../../lib/roles";
import { useAuth } from "../../context/AuthContext";
import { KpiTile, RecentActivity } from "../../components/dashboard/Widgets";
import { ErrorBox, Loader } from "../../components/common/UI";
import { StateBadge } from "../../components/attendance/Badges";
import TaskCard from "../../components/tasks/TaskCard";
import CheckoutPanel from "../../components/tasks/CheckoutPanel";
import "../../styles/dashboard.css";
import "../../styles/tasks.css";
import "../../styles/staff.css";
// Staff dashboard (update 047): today's attendance, tasks, report and
// notices for office staff. Everything comes from the same endpoints as My
// tasks, My attendance and My profile; nothing is calculated here.
export default function StaffDashboard() {
  const { user } = useAuth();
  const profile = useQuery({
    queryKey: ["my-profile"],
    queryFn: ({ signal }) => api("/profile", { signal }),
    retry: false,
  });
  const tasks = useQuery({
    queryKey: ["my-tasks"],
    queryFn: ({ signal }) => api("/tasks/my", { signal }),
    refetchInterval: 60000,
  });
  const attendance = useMyAttendance();
  const p = profile.data || {};
  const t = tasks.data || {};
  const s = t.summary || {};
  const today = attendance.data?.today;
  const policy = attendance.data?.policy;
  const first = (user?.name || "").split(" ")[0];
  const role = [p.department, p.job_title].filter(Boolean).join(" · ");
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {t.date ? fullDayLabel(t.date).toUpperCase() : "TODAY"}
          </span>
          <h1>Welcome, {first}</h1>
          <p>
            {role ||
              "Your tasks, daily report and attendance for today, in one place."}
          </p>
        </div>
      </div>
      <ErrorBox error={tasks.error || attendance.error} />
      <section className="kpi-grid staff-kpis" aria-label="Today at a glance">
        <KpiTile
          label="Attendance today"
          value={today ? stateLabel(today.state) : "—"}
          note={
            today?.check_in_at
              ? `Checked in at ${pkTime(today.check_in_at)}${today.check_out_at ? ` · out at ${pkTime(today.check_out_at)}` : ""}`
              : policy
                ? `Shift ${clockLabel(policy.shift_start)} – ${clockLabel(policy.shift_end)}`
                : "Attendance tracking has not started"
          }
          icon={CalendarCheck}
          tone="navy"
          to="/attendance"
        />
        <KpiTile
          label="Tasks today"
          value={s.task_count ?? 0}
          note={`${s.completed ?? 0} completed · ${Math.max((s.task_count ?? 0) - (s.completed ?? 0), 0)} pending`}
          icon={ListChecks}
          tone="gold"
          to="/my-tasks"
        />
        <KpiTile
          label="Daily completion"
          value={percent(s.completion_percent)}
          note={s.overdue ? `${s.overdue} overdue` : "Each task counts equally"}
          icon={Target}
          tone={s.overdue ? "gold" : "green"}
        />
        <KpiTile
          label="Daily report"
          value={t.report ? "Submitted" : "Not yet"}
          note={
            t.report
              ? t.report.status === "reviewed"
                ? `Reviewed by ${t.report.reviewed_by_name}`
                : `At ${pkTime(t.report.submitted_at)}`
              : "Submit it before you check out"
          }
          icon={FileText}
          tone={t.report ? "green" : "gold"}
          to="/my-tasks#daily-report"
        />
      </section>
      {t.checkout && <CheckoutPanel state={t.checkout} compact />}
      <div className="staff-grid">
        <section className="panel" aria-labelledby="staff-tasks-title">
          <div className="panel-heading">
            <h2 id="staff-tasks-title">Today's tasks</h2>
            <Link className="button secondary" to="/my-tasks">
              Open My tasks
            </Link>
          </div>
          {tasks.isPending ? (
            <Loader />
          ) : t.today?.length ? (
            <div className="task-list">
              {t.today.slice(0, 5).map((task) => (
                <TaskCard key={task.id} task={task} editable />
              ))}
              {t.today.length > 5 && (
                <p className="field-hint">
                  {t.today.length - 5} more in My tasks.
                </p>
              )}
            </div>
          ) : (
            <div className="empty">
              No tasks for today. You can still submit a short daily report.
            </div>
          )}
        </section>
        <div className="staff-side">
          <section
            className="panel staff-shift"
            aria-labelledby="staff-shift-title"
          >
            <div className="panel-heading">
              <h2 id="staff-shift-title">Today's attendance</h2>
              {today && <StateBadge state={today.state} />}
            </div>
            <dl className="task-facts">
              <div>
                <dt>Shift</dt>
                <dd>
                  {policy
                    ? `${clockLabel(policy.shift_start)} – ${clockLabel(policy.shift_end)}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Working days</dt>
                <dd>{policy ? workDaysText(policy.work_days) : "—"}</dd>
              </div>
              <div>
                <dt>Check-in</dt>
                <dd>{pkTime(today?.check_in_at)}</dd>
              </div>
              <div>
                <dt>Check-out</dt>
                <dd>{pkTime(today?.check_out_at)}</dd>
              </div>
            </dl>
            <Link className="button" to="/attendance">
              {today?.state === "checked_in"
                ? "Check out on Attendance"
                : today?.check_in_at
                  ? "Open Attendance"
                  : "Check in on Attendance"}
            </Link>
          </section>
          <RecentActivity limit={5} />
        </div>
      </div>
    </>
  );
}
