import { useState } from "react";
import { api } from "../../lib/api";
import { leaveTypes } from "../../lib/attendance";
import { todayPk } from "../../lib/calendar";
import { Button, ErrorBox } from "../common/UI";
// Full-day leave for the signed-in employee; another administrator reviews it.
export default function LeaveRequestForm({ onDone }) {
  const today = todayPk();
  const [form, setForm] = useState({
      leave_type: "casual",
      start_date: today,
      end_date: today,
      reason: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (form.end_date < form.start_date)
      return setError("The leave must end on or after its start date.");
    if (form.reason.trim().length < 3)
      return setError("Give a short reason (at least 3 characters).");
    setBusy(true);
    try {
      await api("/attendance/leave", {
        method: "POST",
        body: { ...form, reason: form.reason.trim() },
      });
      onDone("Leave request sent for review");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="form-grid">
        <label>
          Leave type
          <select value={form.leave_type} onChange={set("leave_type")}>
            {leaveTypes.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          First day
          <input
            type="date"
            required
            value={form.start_date}
            onChange={set("start_date")}
          />
        </label>
        <label>
          Last day
          <input
            type="date"
            required
            min={form.start_date}
            value={form.end_date}
            onChange={set("end_date")}
          />
        </label>
        <label className="wide">
          Reason
          <textarea
            rows="3"
            required
            maxLength={500}
            value={form.reason}
            onChange={set("reason")}
          />
        </label>
      </fieldset>
      <p className="field-hint">
        Full days only. Pending leave does not excuse an absence until an
        administrator approves it.
      </p>
      <ErrorBox error={error} />
      <footer>
        <Button disabled={busy}>{busy ? "Sending…" : "Send request"}</Button>
      </footer>
    </form>
  );
}
