import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { pkTime } from "../../lib/attendance";
import { fullDayLabel } from "../../lib/calendar";
import {
  invalidateTasks,
  percent,
  statusLabel,
  verifiedLabels,
} from "../../lib/tasks";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
// Daily reports for administrators (update 045): the list, one report with the
// snapshot the agent submitted beside each task as it stands now, and review.
export function ReportDetail({ id, onClose }) {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["task-report", id],
    queryFn: ({ signal }) => api(`/admin/tasks/reports/${id}`, { signal }),
  });
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const r = q.data;
  async function review() {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/tasks/reports/${id}/review`, {
        method: "POST",
        body: note.trim() ? { note: note.trim() } : {},
      });
      invalidateTasks(qc);
      toast("Report reviewed; it can no longer be changed");
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const now = new Map((r?.assignments || []).map((a) => [a.id, a]));
  return (
    <Modal
      title={
        r ? `${r.user_name} · ${fullDayLabel(r.work_date)}` : "Daily report"
      }
      onClose={onClose}
      className="task-dialog"
    >
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <dl className="task-facts">
            <div>
              <dt>Employee</dt>
              <dd>
                {r.user_name} · UID {r.user_uid}
              </dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>
                {pkTime(r.submitted_at)}
                {r.amendment_count > 0 &&
                  ` · amended ${r.amendment_count}× (last ${pkTime(r.amended_at)})`}
              </dd>
            </div>
            <div>
              <dt>Completion</dt>
              <dd>
                {percent(r.completion_percent)} across {r.task_count}{" "}
                {r.task_count === 1 ? "task" : "tasks"}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {r.status === "reviewed"
                  ? `Reviewed by ${r.reviewed_by_name}`
                  : "Waiting for review"}
              </dd>
            </div>
          </dl>
          {r.remarks && <p className="report-remarks">“{r.remarks}”</p>}
          {r.tasks.length ? (
            <div className="table-scroll">
              <table className="report-tasks">
                <caption>Tasks as reported</caption>
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Reported</th>
                    <th scope="col">%</th>
                    <th scope="col">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {r.tasks.map((t) => {
                    const a = now.get(t.assignment_id);
                    return (
                      <tr key={t.assignment_id}>
                        <th scope="row">{t.title}</th>
                        <td>
                          {t.kind === "measurable"
                            ? `${t.completed_quantity} of ${t.target_quantity} ${t.unit}`
                            : statusLabel(t.status)}
                        </td>
                        <td>{percent(t.percent)}</td>
                        <td>
                          {a
                            ? a.kind === "measurable"
                              ? `${a.completed_quantity} ${a.unit}`
                              : statusLabel(a.status)
                            : "—"}
                          {a?.verified_status &&
                            ` · ${verifiedLabels[a.verified_status]}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="field-hint">
              No tasks that day: this report confirms the workday.
            </p>
          )}
          {r.status === "reviewed" ? (
            r.review_note && (
              <p className="field-hint">Review note: “{r.review_note}”</p>
            )
          ) : (
            <>
              <p className="field-hint">
                Verify individual tasks under Team tasks or Individual tasks.
                Reviewing locks the report and its tasks for the employee.
              </p>
              <label>
                Review note (optional)
                <input
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <ErrorBox error={error} />
              <footer className="review-buttons">
                <Button variant="secondary" disabled={busy} onClick={onClose}>
                  Close
                </Button>
                <Button disabled={busy} onClick={review}>
                  {busy ? "Saving…" : "Mark reviewed"}
                </Button>
              </footer>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// Days with tasks due and no report: the last 7 days by default, which agents
// can still submit, or the chosen range.
function OverdueReports({ from, to }) {
  const params = new URLSearchParams({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const q = useQuery({
    queryKey: ["task-reports", "missing", params.toString()],
    queryFn: ({ signal }) =>
      api("/admin/tasks/missing-reports?" + params, { signal }),
  });
  const rows = (q.data?.data || []).map((r) => ({
    ...r,
    id: `${r.user_id}:${r.work_date}`,
  }));
  return (
    <section className="panel overdue-reports" aria-labelledby="overdue-title">
      <div className="panel-heading">
        <h2 id="overdue-title">Overdue reports</h2>
        {rows.length > 0 && (
          <span className="badge warning">{rows.length} missing</span>
        )}
      </div>
      <p className="field-hint">
        {from || to
          ? "Days in the chosen range when someone had tasks due and sent no report."
          : "The last 7 days: agents and staff had tasks due and sent no report. They can still submit these from My tasks."}
      </p>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : rows.length ? (
        <Table
          columns={[
            {
              key: "work_date",
              label: "Day",
              render: (r) => fullDayLabel(r.work_date),
            },
            {
              key: "name",
              label: "Employee",
              render: (r) => (
                <>
                  {r.name} <small>UID {r.uid}</small>
                  {!r.active && <small> · inactive</small>}
                </>
              ),
            },
            { key: "tasks", label: "Tasks" },
            {
              key: "completion_percent",
              label: "Completion now",
              render: (r) => percent(r.completion_percent),
            },
            {
              key: "can_still_submit",
              label: "Status",
              render: (r) =>
                r.report_waived ? (
                  <span className="badge">Waived by emergency approval</span>
                ) : r.can_still_submit ? (
                  <span className="badge warning">
                    Can submit until {fullDayLabel(r.submit_until)}
                  </span>
                ) : (
                  <span className="badge overdue">Window closed</span>
                ),
            },
          ]}
          rows={rows}
        />
      ) : (
        <p className="empty">No overdue reports.</p>
      )}
    </section>
  );
}

export default function AdminReports({ initialDate }) {
  const [page, setPage] = useState(1),
    [from, setFrom] = useState(initialDate || ""),
    [to, setTo] = useState(initialDate || ""),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState(null);
  const params = new URLSearchParams({
    page,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(status ? { status } : {}),
  });
  const q = useQuery({
    queryKey: ["task-reports", params.toString()],
    queryFn: ({ signal }) => api("/admin/tasks/reports?" + params, { signal }),
  });
  const reset = (fn) => (e) => {
    fn(e.target.value);
    setPage(1);
  };
  return (
    <>
      <OverdueReports from={from} to={to} />
      <section className="panel" aria-label="Submitted reports">
        <div className="toolbar task-filters">
          <label>
            From
            <input type="date" value={from} onChange={reset(setFrom)} />
          </label>
          <label>
            Through
            <input type="date" value={to} onChange={reset(setTo)} />
          </label>
          <select
            aria-label="Review status"
            value={status}
            onChange={reset(setStatus)}
          >
            <option value="">Any status</option>
            <option value="submitted">Waiting for review</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            columns={[
              {
                key: "work_date",
                label: "Day",
                render: (r) => fullDayLabel(r.work_date),
              },
              {
                key: "user_name",
                label: "Employee",
                render: (r) => (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setOpen(r.id)}
                  >
                    {r.user_name}
                  </button>
                ),
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
                  (r.amendment_count ? " · amended" : ""),
              },
              {
                key: "status",
                label: "Status",
                render: (r) => (
                  <span
                    className={`badge ${r.status === "reviewed" ? "completed" : "warning"}`}
                  >
                    {r.status === "reviewed" ? "Reviewed" : "To review"}
                  </span>
                ),
              },
            ]}
            rows={q.data?.data || []}
          />
        )}
        <Pagination page={page} count={q.data?.count} onPage={setPage} />
        {open && <ReportDetail id={open} onClose={() => setOpen(null)} />}
      </section>
    </>
  );
}
