import { useState } from "react";
import { api } from "../../lib/api";
import { correctionTypes, pkMoment } from "../../lib/attendance";
import { todayPk } from "../../lib/calendar";
import { Button, ErrorBox } from "../common/UI";
const needsIn = (type) =>
  ["missing_check_in", "incorrect_check_in"].includes(type);
const needsOut = (type) =>
  ["missing_check_out", "incorrect_check_out"].includes(type);
// Ask an administrator to fix a day's check-in or check-out (Pakistan time).
export default function CorrectionRequestForm({ initial = {}, onDone }) {
  const [form, setForm] = useState({
      attendance_date: initial.date || todayPk(),
      correction_type: initial.type || "missing_check_out",
      check_in: "",
      check_out: "",
      reason: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const type = form.correction_type;
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (needsIn(type) && !form.check_in)
      return setError("Enter the check-in time.");
    if (needsOut(type) && !form.check_out)
      return setError("Enter the check-out time.");
    if (form.check_in && form.check_out && form.check_out <= form.check_in)
      return setError("Check-out must be after check-in.");
    if (form.reason.trim().length < 3)
      return setError("Explain what happened (at least 3 characters).");
    setBusy(true);
    try {
      const body = {
        attendance_date: form.attendance_date,
        correction_type: type,
        reason: form.reason.trim(),
      };
      const wantIn = pkMoment(form.attendance_date, form.check_in),
        wantOut = pkMoment(form.attendance_date, form.check_out);
      if (wantIn && (needsIn(type) || type === "missing_check_in"))
        body.requested_check_in_at = wantIn;
      if (wantOut && (needsOut(type) || type === "missing_check_in"))
        body.requested_check_out_at = wantOut;
      await api("/attendance/corrections", { method: "POST", body });
      onDone("Correction request sent for review");
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
          Date
          <input
            type="date"
            required
            max={todayPk()}
            value={form.attendance_date}
            onChange={set("attendance_date")}
          />
        </label>
        <label>
          What needs fixing
          <select value={type} onChange={set("correction_type")}>
            {correctionTypes.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(needsIn(type) || type === "missing_check_in") && (
          <label>
            {type === "missing_check_in"
              ? "Time you started"
              : "Correct check-in"}{" "}
            (Pakistan time)
            <input
              type="time"
              value={form.check_in}
              onChange={set("check_in")}
            />
          </label>
        )}
        {(needsOut(type) || type === "missing_check_in") && (
          <label>
            {type === "missing_check_in"
              ? "Time you finished (optional)"
              : type === "missing_check_out"
                ? "Time you finished"
                : "Correct check-out"}{" "}
            (Pakistan time)
            <input
              type="time"
              value={form.check_out}
              onChange={set("check_out")}
            />
          </label>
        )}
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
        An administrator reviews every correction. The original times are kept
        in the audit history.
      </p>
      <ErrorBox error={error} />
      <footer>
        <Button disabled={busy}>{busy ? "Sending…" : "Send request"}</Button>
      </footer>
    </form>
  );
}
