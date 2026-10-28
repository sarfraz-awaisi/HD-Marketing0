import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, FileText, ListChecks, LogOut } from "lucide-react";
import { api } from "../../lib/api";
import { pkTime, requestStatusInfo } from "../../lib/attendance";
import { dayLabel, fullDayLabel } from "../../lib/calendar";
import { invalidateTasks, percent } from "../../lib/tasks";
import { KpiTile } from "../../components/dashboard/Widgets";
import {
  Button,
  ErrorBox,
  Loader,
  Table,
  useToast,
} from "../../components/common/UI";
import TaskCard from "../../components/tasks/TaskCard";
import CheckoutPanel from "../../components/tasks/CheckoutPanel";
import "../../styles/dashboard.css";
import "../../styles/tasks.css";
// My tasks (update 045): the signed-in agent's assignments, progress, daily
// report and checkout requests. Everything comes from GET /tasks/my.
const tabs = [
  ["today", "Today"],
  ["overdue", "Overdue"],
  ["upcoming", "Upcoming"],
  ["completed", "Completed"],
  ["reports", "My reports"],
  ["requests", "Checkout requests"],
];

function DailyReport({ data }) {
  const qc = useQueryClient(),
    toast = useToast();
  const report = data.report;
  const [day, setDay] = useState(data.date),
    [remarks, setRemarks] = useState(report?.remarks || ""),
    [amending, setAmending] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const forToday = day === data.date;
  const summary = data.summary || {};
  const reviewed = report?.status === "reviewed";
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/tasks/reports", {
        method: "POST",
        body: {
          ...(forToday ? {} : { date: day }),
          remarks: remarks.trim(),
          amend: forToday && !!report,
        },
      });
      invalidateTasks(qc);
      setAmending(false);
      toast(
        forToday && report ? "Daily report amended" : "Daily report submitted",
      );
      if (!forToday) setDay(data.date);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const showForm = !forToday || !report || amending;
  return (
    <section
      className="panel daily-report"
      id="daily-report"
      aria-labelledby="daily-report-title"
    >
      <div className="panel-heading">
        <h2 id="daily-report-title">Daily work report</h2>
        {forToday && report && (
          <span className={`badge ${reviewed ? "completed" : "warning"}`}>
            {reviewed ? "Reviewed" : "Submitted"}
          </span>
        )}
      </div>
      {data.missing_reports?.length > 0 && (
        <label className="report-day">
          Report for
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value={data.date}>Today, {dayLabel(data.date)}</option>
            {data.missing_reports.map((d) => (
              <option key={d} value={d}>
                {fullDayLabel(d)} (missing)
              </option>
            ))}
          </select>
        </label>
      )}
      {forToday && report && !amending ? (
        <>
          <p>
            Submitted at {pkTime(report.submitted_at)}
            {report.amendment_count > 0 &&
              `, amended ${report.amendment_count === 1 ? "once" : `${report.amendment_count} times`}`}
            : {percent(report.completion_percent)} across {report.task_count}{" "}
            {report.task_count === 1 ? "task" : "tasks"}.
          </p>
          {report.remarks && (
            <p className="report-remarks">“{report.remarks}”</p>
          )}
          {reviewed ? (
            <p className="field-hint">
              Reviewed by {report.reviewed_by_name}
              {report.review_note ? `: “${report.review_note}”` : ""}. It can no
              longer be changed.
            </p>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setRemarks(report.remarks || "");
                setAmending(true);
              }}
            >
              Amend report
            </Button>
          )}
        </>
      ) : null}
      {showForm && (
        <form onSubmit={submit}>
          <p className="field-hint">
            {forToday
              ? summary.task_count
                ? `Your report records each task as it stands now: ${percent(summary.completion_percent)} across ${summary.task_count} ${summary.task_count === 1 ? "task" : "tasks"}. Update your progress first; an honest report with unfinished work is fine.`
                : "You have no tasks today. Submit a short report to confirm your day."
              : "This day had tasks and no report. The report records the tasks as they stand now."}
          </p>
          <label>
            Remarks
            <textarea
              rows={3}
              maxLength={1000}
              placeholder="For example: five customers asked to be called tomorrow."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </label>
          <ErrorBox error={error} />
          <div className="review-buttons">
            {amending && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setAmending(false)}
              >
                Keep the report as it is
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {busy
                ? "Submitting…"
                : amending
                  ? "Submit amended report"
                  : "Submit Daily Report"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export default function MyTasks() {
  const [params, setParams] = useSearchParams();
  const tab = tabs.some(([k]) => k === params.get("tab"))
    ? params.get("tab")
    : "today";
  const q = useQuery({
    queryKey: ["my-tasks"],
    queryFn: ({ signal }) => api("/tasks/my", { signal }),
    refetchInterval: 60000,
  });
  // Notification links such as /my-tasks#daily-report scroll to the report.
  useEffect(() => {
    if (q.data && window.location.hash === "#daily-report")
      document.getElementById("daily-report")?.scrollIntoView();
  }, [q.data]);
  if (q.isPending) return <Loader />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const s = d.summary || {};
  const lists = {
    today: d.today,
    overdue: d.overdue,
    upcoming: d.upcoming,
    completed: d.completed,
  };
  const empty = {
    today: "No tasks for today.",
    overdue: "Nothing overdue.",
    upcoming: "No tasks scheduled for the next two weeks.",
    completed: "No completed tasks in the last two weeks.",
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR DAY, ONE TASK AT A TIME</span>
          <h1>My tasks</h1>
          <p>
            Update your progress as you work, submit your daily report, and ask
            to leave early once everything is done.
          </p>
        </div>
      </div>
      <section className="kpi-grid task-kpis" aria-label="Today at a glance">
        <KpiTile
          label="Today's completion"
          value={percent(s.completion_percent)}
          note={`${s.completed ?? 0} of ${s.task_count ?? 0} tasks done`}
          icon={ListChecks}
          tone="navy"
        />
        <KpiTile
          label="Due today"
          value={`${s.due_completed ?? 0}/${s.due_count ?? 0}`}
          note={s.overdue ? `${s.overdue} overdue` : "Nothing overdue"}
          icon={ClipboardCheck}
          tone={s.overdue ? "gold" : "green"}
        />
        <KpiTile
          label="Daily report"
          value={d.report ? "Submitted" : "Not yet"}
          note={
            d.report
              ? d.report.status === "reviewed"
                ? "Reviewed"
                : `At ${pkTime(d.report.submitted_at)}`
              : "Needed before checkout"
          }
          icon={FileText}
          tone={d.report ? "green" : "gold"}
        />
        <KpiTile
          label="Checkout"
          value={
            !d.checkout?.required
              ? "No rules"
              : d.checkout.can_check_out
                ? "Allowed"
                : d.checkout.pending_request
                  ? "Waiting"
                  : "Not yet"
          }
          note={
            d.checkout?.required
              ? d.checkout.approved_request
                ? `${d.checkout.approved_request.kind === "early" ? "Early" : "Emergency"} checkout approved`
                : "See Checking out today"
              : "Check out as usual"
          }
          icon={LogOut}
          tone="navy"
        />
      </section>
      <CheckoutPanel state={d.checkout} />
      <div
        className="inventory-tabs task-tabs"
        role="tablist"
        aria-label="Task lists"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setParams({ tab: key })}
          >
            {label}
            {key === "overdue" && d.overdue.length > 0 && (
              <span className="tab-count">{d.overdue.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="task-layout" role="tabpanel">
        {lists[tab] && (
          <div className="task-list">
            {lists[tab].length ? (
              lists[tab].map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  editable={tab === "today" || tab === "overdue"}
                />
              ))
            ) : (
              <div className="panel empty">{empty[tab]}</div>
            )}
          </div>
        )}
        {tab === "reports" && (
          <section className="panel">
            <Table
              columns={[
                {
                  key: "work_date",
                  label: "Day",
                  render: (r) => fullDayLabel(r.work_date),
                },
                { key: "task_count", label: "Tasks" },
                {
                  key: "completion_percent",
                  label: "Completion",
                  render: (r) => percent(r.completion_percent),
                },
                {
                  key: "submitted_at",
                  label: "Submitted",
                  render: (r) =>
                    pkTime(r.submitted_at) +
                    (r.amendment_count
                      ? ` · amended ${r.amendment_count}×`
                      : ""),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) =>
                    r.status === "reviewed"
                      ? `Reviewed by ${r.reviewed_by_name}${r.review_note ? `: “${r.review_note}”` : ""}`
                      : "Waiting for review",
                },
              ]}
              rows={d.reports}
            />
          </section>
        )}
        {tab === "requests" && (
          <section className="panel">
            <Table
              columns={[
                {
                  key: "work_date",
                  label: "Day",
                  render: (r) => fullDayLabel(r.work_date),
                },
                {
                  key: "kind",
                  label: "Request",
                  render: (r) =>
                    r.kind === "early"
                      ? "Early checkout"
                      : "Emergency checkout",
                },
                {
                  key: "requested_at",
                  label: "Asked at",
                  render: (r) => pkTime(r.requested_at),
                },
                {
                  key: "status",
                  label: "Decision",
                  render: (r) => {
                    const [label, tone] = r.expired
                      ? ["Expired", ""]
                      : requestStatusInfo[r.status] || [r.status, ""];
                    return (
                      <>
                        <span className={`badge ${tone}`}>{label}</span>
                        {r.decided_by_name && ` by ${r.decided_by_name}`}
                        {r.decision_note && ` — “${r.decision_note}”`}
                        {r.used_at && ` · used at ${pkTime(r.used_at)}`}
                      </>
                    );
                  },
                },
              ]}
              rows={d.requests}
            />
          </section>
        )}
        {(tab === "today" || tab === "overdue") && (
          <DailyReport data={d} key={d.report?.id || "new"} />
        )}
      </div>
    </>
  );
}
