import { useState } from "react";
import { Button, ErrorBox } from "../../common/UI";
import { addDays, todayPk } from "../../../lib/calendar";
import { weekdayOptions } from "../../../lib/roles";
import { timingProblem } from "../../../lib/shifts";
// A timing from a date (update 048), for a role, a department or one
// employee. With remove, it ends that timing from the date instead and the
// employees return to the next level (removeText says which). Changes start
// tomorrow unless today is chosen; earlier days keep the timing they had.
export default function ShiftTimingForm({
  initial,
  version,
  named = false,
  remove = false,
  removeText,
  submitLabel = "Save timing",
  onSave,
  onCancel,
}) {
  const today = todayPk();
  const [form, setForm] = useState({
    effective_from: addDays(today, 1),
    label: named && initial?.label ? initial.label : "",
    shift_start: initial?.shift_start || "10:00",
    shift_end: initial?.shift_end || "18:00",
    work_days: initial?.work_days || [1, 2, 3, 4, 5, 6],
    grace_minutes: initial?.grace_minutes ?? 15,
    reason: "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleDay = (day) =>
    setForm((f) => ({
      ...f,
      work_days: f.work_days.includes(day)
        ? f.work_days.filter((d) => d !== day)
        : [...f.work_days, day].sort(),
    }));
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const problem = remove ? "" : timingProblem(form);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    const common = {
      effective_from: form.effective_from,
      expected_version: version,
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    };
    try {
      await onSave(
        remove
          ? { ...common, inherit: true }
          : {
              ...common,
              ...(named && form.label.trim()
                ? { label: form.label.trim() }
                : {}),
              shift_start: form.shift_start,
              shift_end: form.shift_end,
              work_days: form.work_days,
              grace_minutes: Number(form.grace_minutes),
            },
      );
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <form className="shift-form" onSubmit={submit}>
      {remove && <p className="shift-remove-note">{removeText}</p>}
      <fieldset className="form-grid" disabled={busy}>
        <label>
          Applies from
          <input
            type="date"
            required
            min={today}
            max={addDays(today, 365)}
            value={form.effective_from}
            onChange={set("effective_from")}
          />
        </label>
        {!remove && (
          <>
            {named && (
              <label>
                Shift name (optional)
                <input
                  maxLength={60}
                  placeholder="Individual shift"
                  value={form.label}
                  onChange={set("label")}
                />
              </label>
            )}
            <label>
              Shift start
              <input
                type="time"
                required
                value={form.shift_start}
                onChange={set("shift_start")}
              />
            </label>
            <label>
              Shift end
              <input
                type="time"
                required
                value={form.shift_end}
                onChange={set("shift_end")}
              />
            </label>
            <label>
              Grace period (minutes)
              <input
                type="number"
                min={0}
                max={120}
                required
                value={form.grace_minutes}
                onChange={set("grace_minutes")}
              />
            </label>
            <fieldset className="wide">
              <legend>Working days</legend>
              <div className="tag-picker">
                {weekdayOptions.map((d) => (
                  <label key={d.value}>
                    <input
                      type="checkbox"
                      checked={form.work_days.includes(d.value)}
                      onChange={() => toggleDay(d.value)}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <label className="wide">
          Reason for the change (optional)
          <input
            maxLength={300}
            placeholder="e.g. Evening shoots for the new project"
            value={form.reason}
            onChange={set("reason")}
          />
        </label>
      </fieldset>
      <p className="field-hint">
        Pakistan time. Shifts start and end on the same day; overnight shifts
        are not supported. Days before the chosen date, and anyone already
        checked in that day, keep the timing they had.
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
        <Button type="submit" variant={remove ? "danger" : ""} disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </footer>
    </form>
  );
}
