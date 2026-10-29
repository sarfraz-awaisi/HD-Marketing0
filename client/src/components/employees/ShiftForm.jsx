import { useState } from "react";
import { Button, ErrorBox } from "../common/UI";
import { todayPk } from "../../lib/calendar";
import { weekdayOptions } from "../../lib/roles";
// A shift from a date (update 047): the company shift, or the employee's own
// times and working days. Days already worked keep the shift they had.
export default function ShiftForm({ current, onSave, onCancel }) {
  const own = current?.source === "assigned";
  const [form, setForm] = useState({
    effective_from: todayPk(),
    follows_company: !own,
    label: own ? current.label || "" : "",
    shift_start: current?.shift_start || "10:00",
    shift_end: current?.shift_end || "18:00",
    work_days: current?.work_days || [1, 2, 3, 4, 5, 6],
    grace_minutes: current?.grace_minutes ?? 15,
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
    setBusy(true);
    setError("");
    try {
      await onSave(
        form.follows_company
          ? { effective_from: form.effective_from, follows_company: true }
          : {
              effective_from: form.effective_from,
              follows_company: false,
              label: form.label.trim(),
              shift_start: form.shift_start,
              shift_end: form.shift_end,
              work_days: form.work_days,
              grace_minutes: Number(form.grace_minutes),
            },
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="shift-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Starts on
          <input
            type="date"
            required
            min={todayPk()}
            value={form.effective_from}
            onChange={set("effective_from")}
          />
        </label>
        <fieldset className="shift-choice">
          <legend>Shift</legend>
          <label className="checkbox-field">
            <input
              type="radio"
              name="shift-kind"
              checked={form.follows_company}
              onChange={() => setForm((f) => ({ ...f, follows_company: true }))}
            />
            Company shift
          </label>
          <label className="checkbox-field">
            <input
              type="radio"
              name="shift-kind"
              checked={!form.follows_company}
              onChange={() =>
                setForm((f) => ({ ...f, follows_company: false }))
              }
            />
            Own shift
          </label>
        </fieldset>
        {!form.follows_company && (
          <>
            <label className="wide">
              Shift name
              <input
                required
                maxLength={60}
                placeholder="e.g. Media shift"
                value={form.label}
                onChange={set("label")}
              />
            </label>
            <label>
              Starts at
              <input
                type="time"
                required
                value={form.shift_start}
                onChange={set("shift_start")}
              />
            </label>
            <label>
              Ends at
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
      </div>
      <p className="field-hint">
        The shift applies from the chosen day. Days already worked keep the
        shift they were recorded with.
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
          {busy ? "Saving…" : "Save shift"}
        </Button>
      </footer>
    </form>
  );
}
