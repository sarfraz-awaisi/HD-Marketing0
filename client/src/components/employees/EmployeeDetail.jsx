import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  addDays,
  fullDayLabel,
  startOfMonth,
  todayPk,
} from "../../lib/calendar";
import { leaveTypeLabel, minutesLabel } from "../../lib/attendance";
import { percent } from "../../lib/tasks";
import { roleLabel } from "../../lib/roles";
import { shiftLine, shiftText, sourceLabel } from "../../lib/shifts";
import { Button, ErrorBox, Loader, Modal, useToast } from "../common/UI";
import { RequestBadge } from "../attendance/Badges";
// One employee in Employee management (update 047): working details, with
// this month's attendance, leave and the last 30 days of tasks from the
// existing attendance and task reports. Office timings are shown here and
// changed in Attendance management → Shift management (update 048).
function DetailsForm({ employee, departments, onSaved, onCancel }) {
  const [form, setForm] = useState({
    department_id: employee.department_id || "",
    job_title: employee.job_title || "",
    joined_on: employee.joined_on || "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSaved({
        department_id: form.department_id || null,
        job_title: form.job_title.trim() || null,
        joined_on: form.joined_on || null,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="employee-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Department
          <select value={form.department_id} onChange={set("department_id")}>
            <option value="">Not assigned</option>
            {departments
              .filter((d) => d.active || d.id === employee.department_id)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? "" : " (inactive)"}
                </option>
              ))}
          </select>
        </label>
        <label>
          Job title
          <input
            maxLength={80}
            placeholder="e.g. Video Editor"
            value={form.job_title}
            onChange={set("job_title")}
          />
        </label>
        <label>
          Joining date
          <input
            type="date"
            value={form.joined_on}
            onChange={set("joined_on")}
          />
        </label>
      </div>
      <p className="field-hint">
        Changing the department keeps every earlier task and report as it was;
        tasks assigned to a department go to its members at that moment.
      </p>
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save details"}
        </Button>
      </footer>
    </form>
  );
}

export default function EmployeeDetail({ id, departments, onClose }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [editing, setEditing] = useState(null);
  const today = todayPk(),
    month = startOfMonth(today),
    from30 = addDays(today, -29);
  const q = useQuery({
    queryKey: ["employee", id],
    queryFn: ({ signal }) => api(`/admin/employees/${id}`, { signal }),
  });
  const attendance = useQuery({
    queryKey: ["employee-attendance", id, month],
    queryFn: ({ signal }) =>
      api(`/admin/attendance/employees/${id}?from=${month}&to=${today}`, {
        signal,
      }),
    retry: false,
  });
  const performance = useQuery({
    queryKey: ["employee-performance", id, from30],
    queryFn: ({ signal }) =>
      api(`/admin/tasks/performance?from=${from30}&to=${today}&user=${id}`, {
        signal,
      }),
    retry: false,
  });
  const e = q.data;
  const totals = attendance.data?.totals || {};
  const work = performance.data?.employees?.find((p) => p.id === id);
  async function save(path, body, method, message) {
    const result = await api(path, { method, body });
    qc.setQueryData(["employee", id], result);
    qc.invalidateQueries({ queryKey: ["employees"] });
    setEditing(null);
    toast(message);
  }
  return (
    <Modal
      title={e ? e.name : "Employee"}
      onClose={onClose}
      className="task-dialog employee-dialog"
    >
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <dl className="task-facts">
            {[
              ["Role", roleLabel(e.role)],
              ["UID", e.uid],
              ["Email", e.email || "—"],
              ["Account", e.active ? "Active" : "Disabled"],
              ["Department", e.department || "Not assigned"],
              ["Job title", e.job_title || "—"],
              ["Joined", e.joined_on ? fullDayLabel(e.joined_on) : "—"],
              ["Office timing", shiftLine(e.shift)],
              ["Schedule source", sourceLabel(e.shift)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {e.shift?.upcoming && (
            <p className="field-hint">
              From {fullDayLabel(e.shift.upcoming.effective_from)}:{" "}
              {shiftText(e.shift.upcoming)}.
            </p>
          )}
          {editing === "details" ? (
            <DetailsForm
              employee={e}
              departments={departments}
              onCancel={() => setEditing(null)}
              onSaved={(body) =>
                save(
                  `/admin/employees/${id}`,
                  body,
                  "PATCH",
                  "Employee details saved",
                )
              }
            />
          ) : (
            <div className="assignment-actions">
              <Button variant="secondary" onClick={() => setEditing("details")}>
                Edit department and title
              </Button>
              <Link
                className="button secondary"
                to={`/attendance-management?tab=shifts&view=individual&employee=${id}`}
              >
                Change office timing in Shift management
              </Link>
              <Link className="button secondary" to="/accounts">
                Role and access in Accounts
              </Link>
            </div>
          )}
          <h3>This month&apos;s attendance</h3>
          {attendance.error ? (
            <ErrorBox error={attendance.error} />
          ) : (
            <dl className="task-facts">
              {[
                ["Present", totals.present_days ?? "—"],
                ["Late", totals.late_days ?? "—"],
                ["Absent", totals.absent_days ?? "—"],
                ["On leave", totals.leave_days ?? "—"],
                ["Left early", totals.early_departure_days ?? "—"],
                ["Worked", minutesLabel(totals.worked_minutes)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <h3>Tasks, last 30 days</h3>
          {performance.error ? (
            <ErrorBox error={performance.error} />
          ) : (
            <dl className="task-facts">
              {[
                ["Assigned", work?.assignments ?? 0],
                ["Completed", work?.completed ?? 0],
                [
                  "Incomplete",
                  Math.max(
                    (work?.assignments ?? 0) - (work?.completed ?? 0),
                    0,
                  ),
                ],
                ["Average completion", percent(work?.average_percent)],
                ["Verified average", percent(work?.verified_average_percent)],
                [
                  "Daily reports",
                  work
                    ? `${work.reports} · ${work.missing_reports} missing`
                    : "—",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <h3>Leave</h3>
          {attendance.data?.leave?.length ? (
            <ul className="request-list employee-leave">
              {attendance.data.leave.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <RequestBadge status={l.status} />{" "}
                  {leaveTypeLabel(l.leave_type)}:{" "}
                  {l.start_date === l.end_date
                    ? fullDayLabel(l.start_date)
                    : `${fullDayLabel(l.start_date)} – ${fullDayLabel(l.end_date)}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">No leave requests yet.</p>
          )}
          {e.shifts?.length > 0 && (
            <>
              <h3>Individual timing history</h3>
              <ul className="request-list">
                {e.shifts.map((s) => (
                  <li key={s.id || s.effective_from}>
                    From {fullDayLabel(s.effective_from)}:{" "}
                    {s.inherits
                      ? "individual timing removed"
                      : shiftText({ ...s, source: "individual" })}
                    {s.withdrawn_at
                      ? " (withdrawn)"
                      : s.upcoming
                        ? " (planned)"
                        : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <footer className="review-buttons">
            <Link
              className="button secondary"
              to={`/attendance-management?tab=employee&user=${id}`}
            >
              Open in Attendance management
            </Link>
            <Link
              className="button secondary"
              to="/task-management?tab=performance"
            >
              Task performance
            </Link>
          </footer>
        </>
      )}
    </Modal>
  );
}
