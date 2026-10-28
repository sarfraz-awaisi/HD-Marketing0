import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Clock3, LogIn, LogOut } from "lucide-react";
import { api, date } from "../../lib/api";
import {
  clockLabel,
  correctionTypeLabel,
  invalidateAttendance,
  leaveTypeLabel,
  minutesLabel,
  percentLabel,
  pkTime,
  useMyAttendance,
  workDaysLabel,
} from "../../lib/attendance";
import { fullDayLabel, dayLabel } from "../../lib/calendar";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Table,
  useToast,
} from "../../components/common/UI";
import {
  PunctualityBadge,
  RequestBadge,
  StateBadge,
} from "../../components/attendance/Badges";
import LeaveRequestForm from "../../components/attendance/LeaveRequestForm";
import CheckoutPanel from "../../components/tasks/CheckoutPanel";
import { useAuth } from "../../context/AuthContext";
import { invalidateTasks } from "../../lib/tasks";
import "../../styles/tasks.css";
import CorrectionRequestForm from "../../components/attendance/CorrectionRequestForm";
// Minutes since check-in, using the server's clock offset; the server still
// calculates the final worked time at check-out.
function useRunningMinutes(checkInAt, serverNow) {
  const offset = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (serverNow) offset.current = Date.parse(serverNow) - Date.now();
  }, [serverNow]);
  useEffect(() => {
    if (!checkInAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [checkInAt]);
  return checkInAt
    ? Math.max(0, (now + offset.current - Date.parse(checkInAt)) / 60000)
    : null;
}
function MyRequests({ kind }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [busy, setBusy] = useState(null),
    [error, setError] = useState("");
  const path =
    kind === "leave" ? "/attendance/leave" : "/attendance/corrections";
  const q = useQuery({
    queryKey: [
      kind === "leave" ? "attendance-leave" : "attendance-corrections",
      "mine",
    ],
    queryFn: ({ signal }) => api(path + "?limit=10", { signal }),
  });
  async function cancel(id) {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await api(`${path}/${id}/cancel`, { method: "POST", body: {} });
      invalidateAttendance(qc);
      toast("Request cancelled");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  const rows = Array.isArray(q.data?.data) ? q.data.data : [];
  return (
    <>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <Table
          rows={rows}
          columns={[
            kind === "leave"
              ? {
                  key: "dates",
                  label: "Dates",
                  render: (r) =>
                    r.start_date === r.end_date
                      ? dayLabel(r.start_date)
                      : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`,
                }
              : {
                  key: "attendance_date",
                  label: "Date",
                  render: (r) => dayLabel(r.attendance_date),
                },
            kind === "leave"
              ? {
                  key: "leave_type",
                  label: "Type",
                  render: (r) => leaveTypeLabel(r.leave_type),
                }
              : {
                  key: "correction_type",
                  label: "Correction",
                  render: (r) => (
                    <span>
                      {correctionTypeLabel(r.correction_type)}
                      <small className="block-muted">
                        {r.requested_check_in_at &&
                          `In ${pkTime(r.requested_check_in_at)} `}
                        {r.requested_check_out_at &&
                          `Out ${pkTime(r.requested_check_out_at)}`}
                      </small>
                    </span>
                  ),
                },
            {
              key: "status",
              label: "Status",
              render: (r) => <RequestBadge status={r.status} />,
            },
            {
              key: "review_note",
              label: "Review note",
              render: (r) =>
                r.review_note ||
                (r.status === "pending" ? "Waiting for review" : "—"),
            },
            {
              key: "created_at",
              label: "Requested",
              render: (r) => date(r.created_at),
            },
            {
              key: "actions",
              label: "Actions",
              render: (r) =>
                r.status === "pending" ? (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => cancel(r.id)}
                  >
                    {busy === r.id ? "Cancelling…" : "Cancel"}
                  </Button>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      )}
    </>
  );
}
export default function MyAttendance() {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useMyAttendance();
  const { user } = useAuth();
  // Task checkout rules (update 045) for agents; nothing shows while they're
  // off or before the database has update 045.
  const rules = useQuery({
    queryKey: ["task-checkout"],
    queryFn: ({ signal }) => api("/tasks/checkout", { signal }),
    enabled: user?.role === "agent",
    retry: false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmOut, setConfirmOut] = useState(false),
    [modal, setModal] = useState(null);
  const data = q.data || {};
  const today = data.today || null;
  const running = useRunningMinutes(
    today?.state === "checked_in" ? today.check_in_at : null,
    data.server_now,
  );
  async function act(kind) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/attendance/${kind}`, {
        method: "POST",
        body: {},
      });
      invalidateAttendance(qc);
      invalidateTasks(qc);
      toast(
        kind === "check-in"
          ? `Checked in at ${pkTime(result.check_in_at)}${
              result.punctuality === "late"
                ? ` · ${result.late_minutes} min late`
                : result.punctuality === "within_grace"
                  ? " · within grace"
                  : " · on time"
            }`
          : `Checked out at ${pkTime(result.check_out_at)} · ${minutesLabel(result.worked_minutes)} worked`,
      );
      setConfirmOut(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const done = (message) => {
    setModal(null);
    invalidateAttendance(qc);
    toast(message);
  };
  if (q.isPending) return <Loader />;
  const policy = data.policy,
    month = data.month || {};
  const canCheckIn =
    today?.scheduled &&
    !today.holiday &&
    !today.leave_type &&
    ["not_checked_in", "absent"].includes(today.state);
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const incomplete = Array.isArray(data.incomplete) ? data.incomplete : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKING DAY</span>
          <h1>My attendance</h1>
          <p>
            {data.employee
              ? `${data.employee.name}${data.employee.uid ? ` · UID ${data.employee.uid}` : ""} · ${data.employee.role === "admin" ? "Admin" : "Agent"}`
              : "Check in when you start work and check out when you finish."}
          </p>
        </div>
        <div className="actions">
          <Button
            variant="secondary"
            onClick={() => setModal({ kind: "leave" })}
          >
            Request leave
          </Button>
          <Button
            variant="secondary"
            onClick={() => setModal({ kind: "correction" })}
          >
            Request correction
          </Button>
        </div>
      </div>
      <ErrorBox error={q.error} />
      {incomplete.some((d) => !d.pending_correction) && (
        <section className="attendance-alert" role="status">
          <b>Check-out missing</b>
          {incomplete
            .filter((d) => !d.pending_correction)
            .map((d) => (
              <span key={d.date}>
                {fullDayLabel(d.date)}: checked in at {pkTime(d.check_in_at)}
                <Button
                  variant="secondary"
                  onClick={() =>
                    setModal({
                      kind: "correction",
                      initial: { date: d.date, type: "missing_check_out" },
                    })
                  }
                >
                  Request correction
                </Button>
              </span>
            ))}
        </section>
      )}
      <section
        className="panel attendance-today fx-card"
        aria-labelledby="today-title"
      >
        <div className="attendance-today-head">
          <div>
            <span className="eyebrow">TODAY · PAKISTAN TIME</span>
            <h2 id="today-title">
              {data.date ? fullDayLabel(data.date) : "Today"}
            </h2>
            <p className="field-hint">
              {policy
                ? `Shift ${clockLabel(policy.shift_start)} – ${clockLabel(policy.shift_end)} · ${policy.grace_minutes} min grace · ${workDaysLabel(policy.work_days)}`
                : "Attendance tracking has not started yet."}
            </p>
          </div>
          {today && <StateBadge state={today.state} />}
        </div>
        {today?.holiday && (
          <p className="attendance-note">Company holiday: {today.holiday}</p>
        )}
        {today?.leave_type && (
          <p className="attendance-note">
            You are on approved {leaveTypeLabel(today.leave_type).toLowerCase()}{" "}
            today.
          </p>
        )}
        <dl className="attendance-facts">
          {[
            ["Check-in", pkTime(today?.check_in_at)],
            ["Check-out", pkTime(today?.check_out_at)],
            [
              "Worked",
              today?.state === "checked_in"
                ? `${minutesLabel(running)} so far`
                : minutesLabel(today?.worked_minutes),
            ],
            [
              "Punctuality",
              <PunctualityBadge key="p" value={today?.punctuality} />,
            ],
            [
              "Late by",
              today?.punctuality ? minutesLabel(today.late_minutes) : "—",
            ],
            [
              "Left early by",
              today?.early_departure_minutes
                ? minutesLabel(today.early_departure_minutes)
                : "—",
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <ErrorBox error={error} />
        <div className="attendance-buttons">
          <Button
            disabled={busy || !canCheckIn}
            onClick={() => act("check-in")}
          >
            <LogIn size={18} />{" "}
            {busy && canCheckIn ? "Checking in…" : "Check in"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || today?.state !== "checked_in"}
            onClick={() => setConfirmOut(true)}
          >
            <LogOut size={18} /> Check out
          </Button>
        </div>
        {today && !today.scheduled && (
          <p className="field-hint">
            {today.state === "day_off"
              ? "Today is a scheduled day off."
              : today.state === "not_tracked"
                ? "Attendance tracking starts on the first day of the policy."
                : "Attendance is not enabled for your account today."}
          </p>
        )}
      </section>
      {rules.data?.required && <CheckoutPanel state={rules.data} compact />}
      <section className="panel" aria-labelledby="month-title">
        <div className="panel-heading">
          <h2 id="month-title">This month</h2>
          <CalendarCheck size={20} />
        </div>
        <div className="attendance-stats">
          {[
            ["Attendance", percentLabel(month.attendance_percent)],
            ["Present days", month.present_days ?? 0],
            ["Absent days", month.absent_days ?? 0],
            ["Late arrivals", month.late_days ?? 0],
            ["Approved leave", month.leave_days ?? 0],
            ["Incomplete", month.incomplete_days ?? 0],
            ["Worked", minutesLabel(month.worked_minutes ?? 0)],
            ["Overtime", minutesLabel(month.overtime_minutes ?? 0)],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <p className="field-hint">
          Attendance is the share of working days so far (not counting holidays
          or approved leave) on which you were present. Incomplete days count as
          not present until a correction is approved.
        </p>
      </section>
      <section className="panel" aria-labelledby="recent-title">
        <div className="panel-heading">
          <h2 id="recent-title">Last 14 days</h2>
          <Clock3 size={20} />
        </div>
        <Table
          rows={recent.map((d) => ({ ...d, id: d.day }))}
          columns={[
            { key: "day", label: "Date", render: (d) => dayLabel(d.day) },
            {
              key: "state",
              label: "Status",
              render: (d) => <StateBadge state={d.state} />,
            },
            {
              key: "check_in_at",
              label: "Check-in",
              render: (d) => pkTime(d.check_in_at),
            },
            {
              key: "check_out_at",
              label: "Check-out",
              render: (d) => pkTime(d.check_out_at),
            },
            {
              key: "worked",
              label: "Worked",
              render: (d) => minutesLabel(d.worked_minutes),
            },
            {
              key: "punctuality",
              label: "Punctuality",
              render: (d) => <PunctualityBadge value={d.punctuality} />,
            },
          ]}
        />
      </section>
      <div className="dashboard-grid attendance-requests">
        <section className="panel" aria-labelledby="my-leave-title">
          <div className="panel-heading">
            <h2 id="my-leave-title">My leave requests</h2>
            <Button
              variant="secondary"
              onClick={() => setModal({ kind: "leave" })}
            >
              Request leave
            </Button>
          </div>
          <MyRequests kind="leave" />
        </section>
        <section className="panel" aria-labelledby="my-corrections-title">
          <div className="panel-heading">
            <h2 id="my-corrections-title">My correction requests</h2>
            <Button
              variant="secondary"
              onClick={() => setModal({ kind: "correction" })}
            >
              Request correction
            </Button>
          </div>
          <MyRequests kind="corrections" />
        </section>
      </div>
      {confirmOut && (
        <Modal
          title="Check out now?"
          onClose={() => !busy && setConfirmOut(false)}
        >
          <p>
            You checked in at {pkTime(today?.check_in_at)}. After checking out
            you cannot check in again today.
          </p>
          {rules.data?.required && !rules.data.can_check_out && (
            <p className="checkout-blocked" role="status">
              {rules.data.blocked_reason}
            </p>
          )}
          <ErrorBox error={error} />
          <footer className="review-buttons">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmOut(false)}
            >
              Keep working
            </Button>
            <Button disabled={busy} onClick={() => act("check-out")}>
              {busy ? "Checking out…" : "Check out"}
            </Button>
          </footer>
        </Modal>
      )}
      {modal?.kind === "leave" && (
        <Modal title="Request leave" onClose={() => setModal(null)}>
          <LeaveRequestForm onDone={done} />
        </Modal>
      )}
      {modal?.kind === "correction" && (
        <Modal
          title="Request an attendance correction"
          onClose={() => setModal(null)}
        >
          <CorrectionRequestForm initial={modal.initial} onDone={done} />
        </Modal>
      )}
    </>
  );
}
