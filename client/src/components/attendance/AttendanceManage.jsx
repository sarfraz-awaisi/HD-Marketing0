import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  arrivalPreview,
  clockLabel,
  invalidateAttendance,
  leaveTypeLabel,
  leaveTypes,
  manualStatuses,
  minutesLabel,
  pkClock,
  pkTime,
  punctualityLabel,
  stateLabel,
  suggestedTimes,
  workedStatus,
} from "../../lib/attendance";
import {
  addDays,
  dayLabel,
  fullDayLabel,
  pkDate,
  todayPk,
  weekday,
} from "../../lib/calendar";
import { Button, ErrorBox, Loader, Modal, Table, useToast } from "../common/UI";
import { StateBadge } from "./Badges";
// Administrators enter or correct another employee's attendance for earlier
// days (update 042): one day, or up to 31 at once. The server decides every
// date; a preview is shown and confirmed before anything is saved.

const resultInfo = {
  create: ["Will add", "completed"],
  update: ["Will change", "warning"],
  unchanged: ["No change", ""],
  skip: ["Kept as is", ""],
  error: ["Can't save", "overdue"],
};
const doneLabels = {
  create: "Added",
  update: "Changed",
  unchanged: "No change",
  skip: "Kept as is",
  error: "Not saved",
};
const historyLabels = {
  "attendance.manual_create": "Entered by an administrator",
  "attendance.manual_update": "Changed by an administrator",
  "attendance.check_in": "Checked in",
  "attendance.check_out": "Checked out",
  "attendance.correction_approved": "Correction approved",
  "attendance.correction_rejected": "Correction not approved",
};
// A before or after snapshot as one line, e.g. "Checked out 10:00 AM – 6:00 PM".
export function describeDay(d) {
  if (!d) return "—";
  if (d.state === "leave")
    return d.leave_type
      ? `Leave: ${leaveTypeLabel(d.leave_type)}`
      : "Approved leave";
  if (d.state === "not_counted") return "Not counted";
  const times = d.check_in_at
    ? ` ${pkTime(d.check_in_at)} – ${pkTime(d.check_out_at)}`
    : "";
  const arrival =
    d.punctuality && d.punctuality !== "on_time"
      ? ` · ${punctualityLabel(d.punctuality)}`
      : "";
  return `${stateLabel(d.state)}${times}${arrival}`;
}
const Pill = ({ info }) => (
  <span className={`badge plain ${info[1] || ""}`}>{info[0]}</span>
);
// Why a day cannot be changed here; the server checks the same rules.
function blockedReason(info) {
  if (info.self)
    return "You can't change your own attendance. Another administrator must do it.";
  if (info.date >= info.today)
    return "Only earlier days can be entered here. Today's attendance uses check-in and check-out.";
  if (!info.rules) return "Attendance rules are not set up yet.";
  if (!info.rules.work_days.includes(weekday(info.date) + 1))
    return "This is a scheduled day off, so there is nothing to record.";
  if (info.holiday) return `This is a company holiday (${info.holiday}).`;
  if (info.pending_correction)
    return "A correction request for this day is waiting. Review it under Corrections first.";
  return "";
}
function startingForm(info) {
  const shift = suggestedTimes("present", info.rules);
  const base = {
    status: "present",
    ...shift,
    leave_type: info.leave?.leave_type || "casual",
    reason: "",
  };
  if (info.record)
    return {
      ...base,
      status: info.record.punctuality === "late" ? "late" : "present",
      check_in: pkClock(info.record.check_in_at),
      check_out: pkClock(info.record.check_out_at) || shift.check_out,
    };
  return info.leave ? { ...base, status: "leave" } : base;
}
const formProblem = (form) =>
  workedStatus(form.status) && (!form.check_in || !form.check_out)
    ? "Enter both the check-in and check-out times."
    : workedStatus(form.status) && form.check_out <= form.check_in
      ? "Check-out must be after check-in."
      : "";
const entryOf = (date, form) => ({
  date,
  status: form.status,
  ...(workedStatus(form.status)
    ? { check_in: form.check_in, check_out: form.check_out }
    : {}),
  ...(form.status === "leave" ? { leave_type: form.leave_type } : {}),
});
function StatusChoice({ value, onChange, name }) {
  return (
    <fieldset className="am-status">
      <legend>Attendance</legend>
      {manualStatuses.map(([key, label]) => (
        <label key={key} className={value === key ? "selected" : ""}>
          <input
            type="radio"
            name={name}
            value={key}
            checked={value === key}
            onChange={() => onChange(key)}
          />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
function EntryFields({ form, setForm, rules, name }) {
  const preview = workedStatus(form.status)
    ? arrivalPreview(rules, form.check_in, form.check_out)
    : null;
  function choose(status) {
    const times =
      status === "late" || status === "half_day"
        ? suggestedTimes(status, rules)
        : workedStatus(status) && !form.check_in
          ? suggestedTimes(status, rules)
          : {};
    setForm({ ...form, status, ...times });
  }
  return (
    <>
      <StatusChoice value={form.status} onChange={choose} name={name} />
      {workedStatus(form.status) && (
        <div className="form-grid">
          <label>
            Check-in (Pakistan time)
            <input
              type="time"
              required
              value={form.check_in}
              onChange={(e) => setForm({ ...form, check_in: e.target.value })}
            />
          </label>
          <label>
            Check-out (Pakistan time)
            <input
              type="time"
              required
              value={form.check_out}
              onChange={(e) => setForm({ ...form, check_out: e.target.value })}
            />
          </label>
          {preview && (
            <p className="field-hint wide" aria-live="polite">
              Arrival: {punctualityLabel(preview.punctuality)}
              {preview.late_minutes > 0 &&
                ` (${minutesLabel(preview.late_minutes)} after the shift starts)`}
              {preview.early_minutes > 0 &&
                ` · leaves ${minutesLabel(preview.early_minutes)} early`}
            </p>
          )}
        </div>
      )}
      {form.status === "absent" && (
        <p className="field-hint">
          An absence stores no times: the day counts as absent because there is
          no attendance for it.
        </p>
      )}
      {form.status === "leave" && (
        <label>
          Leave type
          <select
            value={form.leave_type}
            onChange={(e) => setForm({ ...form, leave_type: e.target.value })}
          >
            {leaveTypes.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Reason or note (optional)
        <textarea
          rows="2"
          maxLength={300}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
      </label>
    </>
  );
}
// What saving also changes: days before the employee's own attendance that
// become counted, and an earlier start of tracking.
function StartNotice({ result }) {
  const name = result.employee?.name || "this employee";
  const counted = result.counted_days || [];
  if (!counted.length && !result.tracking_start) return null;
  return (
    <div className="notice am-notice">
      {counted.length > 0 && (
        <p>
          {counted.length === 1
            ? "This day comes"
            : `These ${counted.length} days come`}{" "}
          before {name}'s own attendance and will now be counted:{" "}
          {counted.map(dayLabel).join(", ")}. Days nobody entered stay uncounted
          and never count as absent.
        </p>
      )}
      {result.tracking_start && (
        <p>
          Attendance tracking will start on {dayLabel(result.tracking_start.to)}{" "}
          instead of {dayLabel(result.tracking_start.from)}, under the same
          rules. Other employees are not affected.
        </p>
      )}
    </div>
  );
}
function History({ items }) {
  if (!items?.length) return null;
  return (
    <section className="am-history" aria-label="Change history">
      <h3>Change history</h3>
      <ul>
        {items.map((h, index) => (
          <li key={index}>
            <span>
              <b>{historyLabels[h.action] || h.action}</b> · {h.by} ·{" "}
              {dayLabel(pkDate(h.at))} {pkTime(h.at)}
            </span>
            {(h.before || h.after) && (
              <small>
                {describeDay(h.before)} → {describeDay(h.after)}
              </small>
            )}
            {h.reason && <small>Reason: {h.reason}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// One employee's day: current attendance, the form, a confirmation of the
// change and the day's history.
export function DayEditor({ userId, day, onSaved }) {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["attendance-admin", "manage", userId, day],
    queryFn: ({ signal }) =>
      api(
        "/admin/attendance/manage?" +
          new URLSearchParams({ user: userId, date: day }),
        { signal },
      ),
    enabled: Boolean(userId && day),
  });
  const info = q.data;
  const [form, setForm] = useState(null),
    [plan, setPlan] = useState(null),
    [pending, setPending] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    setPlan(null);
    setError("");
    setNote("");
    setForm(info ? startingForm(info) : null);
  }, [info]);
  if (q.isPending) return <Loader />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!form) return null;
  const blocked = blockedReason(info);
  const existing = Boolean(info.record || info.leave);
  // A day counted only because it was entered can be removed again.
  const removable = info.entered && (existing || info.state === "absent");
  const send = (dry_run, f) =>
    api("/admin/attendance/manage", {
      method: "POST",
      body: {
        user_id: userId,
        entries: [entryOf(day, f)],
        ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
        replace: existing || f.status === "clear",
        dry_run,
      },
    });
  async function check(f) {
    if (busy) return;
    const problem = formProblem(f);
    setNote("");
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      const result = await send(true, f);
      const r = result.results[0];
      if (r.result === "error") setError(r.message);
      else if (r.result === "unchanged" || r.result === "skip")
        setNote(r.message);
      else {
        setPending(f);
        setPlan(result);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function review(event) {
    event.preventDefault();
    check(form);
  }
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await send(false, pending);
      const r = result.results[0];
      if (r.result === "error" || r.result === "skip") {
        setPlan(null);
        setError(r.message);
        return;
      }
      toast(
        `Attendance ${pending.status === "clear" ? "entry removed" : r.result === "create" ? "added" : "updated"} for ${info.employee.name} on ${dayLabel(day)}`,
      );
      setPlan(null);
      invalidateAttendance(qc);
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const r = plan?.results[0];
  return (
    <div className="am-day">
      <div className="am-current">
        <div>
          <span className="am-label">Now</span>
          <StateBadge state={info.state} />
          {info.record && (
            <span>
              {pkTime(info.record.check_in_at)} –{" "}
              {pkTime(info.record.check_out_at)}
            </span>
          )}
          {info.leave && info.state === "leave" && (
            <span>{leaveTypeLabel(info.leave.leave_type)}</span>
          )}
          {info.record?.corrected && <small>Corrected</small>}
        </div>
        <p className="field-hint">
          {info.employee.name} · {fullDayLabel(day)}
          {info.rules &&
            ` · Shift ${clockLabel(info.rules.shift_start)} – ${clockLabel(info.rules.shift_end)}, ${info.rules.grace_minutes} min grace`}
          {info.attendance_start &&
            ` · Own attendance from ${dayLabel(info.attendance_start)}`}
          {info.entered && " · Counted because it was entered"}
          {!info.counted && " · Not counted until entered"}
        </p>
      </div>
      {blocked ? (
        <p className="notice">{blocked}</p>
      ) : plan ? (
        <div className="am-confirm" role="group" aria-label="Confirm change">
          <h3>
            {pending?.status === "clear"
              ? "Remove this entry?"
              : r.result === "update"
                ? "Change this day?"
                : "Add this day?"}
          </h3>
          <dl className="am-compare">
            <div>
              <dt>Now</dt>
              <dd>{describeDay(r.before)}</dd>
            </div>
            <div>
              <dt>After saving</dt>
              <dd>{describeDay(r.after)}</dd>
            </div>
          </dl>
          <StartNotice result={plan} />
          <ErrorBox error={error} />
          <footer className="review-buttons">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              Back
            </Button>
            <Button disabled={busy} onClick={confirm}>
              {busy ? "Saving…" : "Confirm and save"}
            </Button>
          </footer>
        </div>
      ) : (
        <form onSubmit={review} className="am-form">
          <fieldset disabled={busy} className="am-fields">
            <EntryFields
              form={form}
              setForm={setForm}
              rules={info.rules}
              name={`am-status-${userId}-${day}`}
            />
          </fieldset>
          <ErrorBox error={error} />
          {note && <p className="notice">{note}</p>}
          <footer className="review-buttons">
            {removable && (
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => check({ ...form, status: "clear" })}
              >
                Remove entry
              </Button>
            )}
            <Button disabled={busy}>
              {busy ? "Checking…" : existing ? "Review change" : "Review entry"}
            </Button>
          </footer>
        </form>
      )}
      <History items={info.history} />
    </div>
  );
}

// Several days at once: the same entry for every date in a range, previewed
// per date (days off and holidays are left out), then saved together.
export function RangeEditor({ userId }) {
  const qc = useQueryClient(),
    toast = useToast(),
    today = todayPk();
  const settings = useQuery({
    queryKey: ["attendance-admin", "settings"],
    queryFn: ({ signal }) => api("/admin/attendance/settings", { signal }),
  });
  const current = settings.data?.current;
  const rules = current
    ? {
        shift_start: current.shift_start.slice(0, 5),
        shift_end: current.shift_end.slice(0, 5),
        grace_minutes: current.grace_minutes,
        work_days: current.work_days,
      }
    : null;
  const [form, setFormState] = useState(() => ({
    from: addDays(today, -6),
    to: addDays(today, -1),
    status: "present",
    ...suggestedTimes("present"),
    leave_type: "casual",
    reason: "",
    replace: false,
  }));
  const [plan, setPlan] = useState(null),
    [selected, setSelected] = useState([]),
    [done, setDone] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Any change makes an earlier preview stale.
  const setForm = (next) => {
    setFormState(next);
    setPlan(null);
    setDone(null);
  };
  const dates = useMemo(() => {
    const list = [];
    for (
      let d = form.from;
      d && form.to && d <= form.to && list.length < 32;
      d = addDays(d, 1)
    )
      list.push(d);
    return list;
  }, [form.from, form.to]);
  const problem =
    !form.from || !form.to
      ? "Choose the first and last day."
      : form.from > form.to
        ? "The range must end on or after its start."
        : form.to >= today
          ? "Choose days before today. Today's attendance uses check-in and check-out."
          : dates.length > 31
            ? "Choose up to 31 days at a time."
            : formProblem(form);
  const body = (list, dry_run) => ({
    user_id: userId,
    entries: list.map((date) => entryOf(date, form)),
    ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    replace: form.replace,
    dry_run,
  });
  async function preview(event) {
    event.preventDefault();
    if (busy) return;
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const result = await api("/admin/attendance/manage", {
        method: "POST",
        body: body(dates, true),
      });
      setPlan(result);
      setSelected(
        result.results
          .filter((x) => x.result === "create" || x.result === "update")
          .map((x) => x.date),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (busy || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("/admin/attendance/manage", {
        method: "POST",
        body: body(selected, false),
      });
      setDone(result);
      setPlan(null);
      invalidateAttendance(qc);
      const s = result.summary;
      toast(
        `${s.created} added, ${s.updated} changed${s.failed ? `, ${s.failed} not saved` : ""}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (date, on) =>
    setSelected(on ? [...selected, date] : selected.filter((d) => d !== date));
  const rows =
    (plan || done)?.results?.map((x) => ({ ...x, id: x.date })) || [];
  return (
    <div className="am-range">
      <form onSubmit={preview} className="am-form">
        <fieldset disabled={busy} className="am-fields">
          <div className="form-grid">
            <label>
              First day
              <input
                type="date"
                required
                max={addDays(today, -1)}
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </label>
            <label>
              Last day
              <input
                type="date"
                required
                max={addDays(today, -1)}
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            </label>
          </div>
          <EntryFields
            form={form}
            setForm={setForm}
            rules={rules}
            name={`am-range-status-${userId}`}
          />
          <label className="am-check">
            <input
              type="checkbox"
              checked={form.replace}
              onChange={(e) => setForm({ ...form, replace: e.target.checked })}
            />
            <span>
              Replace attendance that already exists on these days. Without
              this, existing days are kept as they are.
            </span>
          </label>
        </fieldset>
        <ErrorBox error={error} />
        <footer className="review-buttons">
          <Button disabled={busy}>
            {busy && !plan ? "Checking…" : "Preview"}
          </Button>
        </footer>
      </form>
      {plan && (
        <section className="am-preview" aria-label="Preview">
          <h3>Preview</h3>
          <p className="field-hint">
            Days off and holidays are left out. Untick any day you don't want to
            save.
          </p>
          <StartNotice result={plan} />
          <Table
            rows={rows}
            columns={[
              {
                key: "pick",
                label: "Save",
                render: (x) => (
                  <input
                    type="checkbox"
                    aria-label={`Save ${dayLabel(x.date)}`}
                    disabled={x.result !== "create" && x.result !== "update"}
                    checked={selected.includes(x.date)}
                    onChange={(e) => toggle(x.date, e.target.checked)}
                  />
                ),
              },
              { key: "date", label: "Date", render: (x) => dayLabel(x.date) },
              {
                key: "before",
                label: "Now",
                render: (x) => describeDay(x.before),
              },
              {
                key: "after",
                label: "After saving",
                render: (x) => (x.after ? describeDay(x.after) : "—"),
              },
              {
                key: "result",
                label: "Result",
                render: (x) => (
                  <span className="attendance-state-cell">
                    <Pill info={resultInfo[x.result] || [x.result]} />
                    {x.message && <small>{x.message}</small>}
                  </span>
                ),
              },
            ]}
          />
          <footer className="review-buttons">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              Back
            </Button>
            <Button disabled={busy || !selected.length} onClick={save}>
              {busy
                ? "Saving…"
                : `Save ${selected.length} day${selected.length === 1 ? "" : "s"}`}
            </Button>
          </footer>
        </section>
      )}
      {done && (
        <section className="am-preview" aria-label="Saved">
          <h3>Saved</h3>
          <p className="period-label">
            {done.summary.created} added · {done.summary.updated} changed ·{" "}
            {done.summary.unchanged} unchanged · {done.summary.skipped} kept as
            is · {done.summary.failed} not saved
          </p>
          <StartNotice result={done} />
          <Table
            rows={rows}
            columns={[
              { key: "date", label: "Date", render: (x) => dayLabel(x.date) },
              {
                key: "result",
                label: "Result",
                render: (x) => (
                  <span className="attendance-state-cell">
                    <b>{doneLabels[x.result] || x.result}</b>
                    {x.message && <small>{x.message}</small>}
                  </span>
                ),
              },
              {
                key: "after",
                label: "Attendance",
                render: (x) =>
                  describeDay(
                    x.after || (x.result === "error" ? null : x.before),
                  ),
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}

function EmployeePicker({ value, onChange }) {
  const { user } = useAuth();
  const [term, setTerm] = useState("");
  const people = useQuery({
    queryKey: ["attendance-admin", "employees"],
    queryFn: ({ signal }) => api("/admin/attendance/employees", { signal }),
  });
  const list = Array.isArray(people.data) ? people.data : [];
  const t = term.trim().toLowerCase();
  const shown = list.filter(
    (p) =>
      !t ||
      p.id === value ||
      p.name.toLowerCase().includes(t) ||
      String(p.uid ?? "").includes(t),
  );
  return (
    <>
      <label>
        Find employee
        <input
          type="search"
          placeholder="Name or UID…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </label>
      <label>
        Employee
        <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Choose an employee
          </option>
          {shown.map((p) => (
            <option key={p.id} value={p.id} disabled={p.id === user?.id}>
              {p.name}
              {p.uid ? ` · UID ${p.uid}` : ""}
              {p.role === "admin" ? " · Admin" : ""}
              {p.active ? "" : " (inactive)"}
              {p.id === user?.id ? " (you)" : ""}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox error={people.error} />
    </>
  );
}

// The Manage tab: choose an employee, then one day or several.
export default function AttendanceManage({ userId, date, onChange }) {
  const today = todayPk(),
    yesterday = addDays(today, -1);
  const [mode, setMode] = useState("day");
  const day = date && date < today ? date : yesterday;
  return (
    <>
      <section className="panel am-intro">
        <h2>Manage attendance</h2>
        <p className="field-hint">
          Add or correct attendance for earlier days, for example the days
          before the CRM started tracking. Today's attendance uses check-in and
          check-out. Every entry is checked and shown to you before it is saved,
          and kept in the day's history.
        </p>
        <div className="form-grid">
          <EmployeePicker
            value={userId}
            onChange={(id) => onChange({ user: id, date: day })}
          />
          <fieldset className="am-status am-mode wide">
            <legend>Enter</legend>
            {[
              ["day", "One day"],
              ["range", "Several days"],
            ].map(([key, label]) => (
              <label key={key} className={mode === key ? "selected" : ""}>
                <input
                  type="radio"
                  name="am-mode"
                  value={key}
                  checked={mode === key}
                  onChange={() => setMode(key)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          {mode === "day" && (
            <label>
              Date
              <input
                type="date"
                max={yesterday}
                value={day}
                onChange={(e) =>
                  e.target.value &&
                  onChange({ user: userId, date: e.target.value })
                }
              />
            </label>
          )}
        </div>
      </section>
      {!userId ? (
        <p className="empty">Choose an employee to begin.</p>
      ) : (
        <section className="panel">
          {mode === "day" ? (
            <DayEditor key={`${userId}:${day}`} userId={userId} day={day} />
          ) : (
            <RangeEditor key={userId} userId={userId} />
          )}
        </section>
      )}
    </>
  );
}

// The same day editor in a dialog, opened from a register or history row.
export function ManageDayDialog({ userId, day, name, onClose }) {
  return (
    <Modal
      title={`Manage attendance${name ? ` · ${name}` : ""}`}
      onClose={onClose}
      className="am-dialog"
    >
      <DayEditor userId={userId} day={day} onSaved={onClose} />
    </Modal>
  );
}
