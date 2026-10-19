import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import {
  clockLabel,
  invalidateAttendance,
  weekdayNames,
  workDaysLabel,
} from "../../lib/attendance";
import { addDays, dayLabel, todayPk } from "../../lib/calendar";
import { Button, ErrorBox, Loader, Table, useToast } from "../common/UI";
const minutes = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
// Attendance rules are versioned: a change starts on a chosen date and the
// days before keep the rules they were recorded under.
export default function AdminAttendanceSettings() {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["attendance-admin", "settings"],
    queryFn: ({ signal }) => api("/admin/attendance/settings", { signal }),
  });
  const [form, setForm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const p = q.data?.current;
    if (p && !form)
      setForm({
        name: p.name,
        shift_start: p.shift_start.slice(0, 5),
        shift_end: p.shift_end.slice(0, 5),
        work_days: p.work_days,
        grace_minutes: String(p.grace_minutes),
        effective_from: addDays(todayPk(), 1),
      });
  }, [q.data, form]);
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const grace = Number(form.grace_minutes);
    if (!form.work_days.length)
      return setError("Choose at least one working day.");
    if (minutes(form.shift_end) <= minutes(form.shift_start))
      return setError("The shift must end after it starts.");
    if (!Number.isInteger(grace) || grace < 0 || grace > 120)
      return setError("Use a grace period of 0 to 120 minutes.");
    if (form.effective_from < todayPk())
      return setError(
        "Changes can start today or later; past days keep their rules.",
      );
    setBusy(true);
    try {
      await api("/admin/attendance/settings", {
        method: "PATCH",
        body: {
          name: form.name.trim(),
          shift_start: form.shift_start,
          shift_end: form.shift_end,
          work_days: [...form.work_days].sort(),
          grace_minutes: grace,
          effective_from: form.effective_from,
        },
      });
      invalidateAttendance(qc);
      toast(`Attendance rules saved from ${dayLabel(form.effective_from)}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (q.isPending) return <Loader />;
  if (q.error) return <ErrorBox error={q.error} />;
  const current = q.data.current;
  return (
    <>
      <section className="panel">
        <h2>Current rules</h2>
        {current ? (
          <dl className="profile-details">
            {[
              ["Policy", current.name],
              ["Working days", workDaysLabel(current.work_days)],
              [
                "Shift",
                `${clockLabel(current.shift_start.slice(0, 5))} – ${clockLabel(current.shift_end.slice(0, 5))}`,
              ],
              ["Grace period", `${current.grace_minutes} minutes`],
              ["Time zone", "Asia/Karachi (Pakistan time, fixed)"],
              ["Break tracking", "Off: worked time is check-in to check-out"],
              ["In force since", dayLabel(current.effective_from)],
              ["Attendance tracked since", dayLabel(q.data.tracking_started)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>No rules are in force today.</p>
        )}
      </section>
      {form && (
        <section className="panel">
          <h2>Schedule a change</h2>
          <form onSubmit={save}>
            <fieldset disabled={busy} className="work-days">
              <legend>Working days</legend>
              {weekdayNames.map(([value, label]) => (
                <label key={value} className="day-choice">
                  <input
                    type="checkbox"
                    checked={form.work_days.includes(value)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        work_days: e.target.checked
                          ? [...form.work_days, value]
                          : form.work_days.filter((d) => d !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <fieldset disabled={busy} className="form-grid">
              <label>
                Policy name
                <input
                  required
                  maxLength={80}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Shift starts
                <input
                  type="time"
                  required
                  value={form.shift_start}
                  onChange={(e) =>
                    setForm({ ...form, shift_start: e.target.value })
                  }
                />
              </label>
              <label>
                Shift ends
                <input
                  type="time"
                  required
                  value={form.shift_end}
                  onChange={(e) =>
                    setForm({ ...form, shift_end: e.target.value })
                  }
                />
              </label>
              <label>
                Grace period (minutes)
                <input
                  type="number"
                  min="0"
                  max="120"
                  required
                  value={form.grace_minutes}
                  onChange={(e) =>
                    setForm({ ...form, grace_minutes: e.target.value })
                  }
                />
              </label>
              <label>
                Takes effect on
                <input
                  type="date"
                  required
                  min={todayPk()}
                  value={form.effective_from}
                  onChange={(e) =>
                    setForm({ ...form, effective_from: e.target.value })
                  }
                />
              </label>
            </fieldset>
            <p className="field-hint">
              Days before the chosen date keep the rules they were recorded
              under.
            </p>
            <ErrorBox error={error} />
            <footer>
              <Button disabled={busy}>{busy ? "Saving…" : "Save rules"}</Button>
            </footer>
          </form>
        </section>
      )}
      <section className="panel">
        <h2>Rule history</h2>
        <Table
          rows={q.data.versions || []}
          columns={[
            { key: "name", label: "Policy" },
            {
              key: "dates",
              label: "In force",
              render: (v) =>
                `${dayLabel(v.effective_from)} – ${v.effective_to ? dayLabel(v.effective_to) : "open"}`,
            },
            {
              key: "shift",
              label: "Shift",
              render: (v) =>
                `${clockLabel(v.shift_start.slice(0, 5))} – ${clockLabel(v.shift_end.slice(0, 5))}`,
            },
            {
              key: "days",
              label: "Days",
              render: (v) => workDaysLabel(v.work_days),
            },
            {
              key: "grace",
              label: "Grace",
              render: (v) => `${v.grace_minutes} min`,
            },
            { key: "records", label: "Days recorded" },
            {
              key: "updated_at",
              label: "Saved",
              render: (v) => date(v.updated_at),
            },
          ]}
        />
      </section>
    </>
  );
}
