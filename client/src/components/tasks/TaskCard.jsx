import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { dayLabel } from "../../lib/calendar";
import {
  categoryLabel,
  invalidateTasks,
  percent,
  priorityLabel,
  progressText,
  statusLabel,
  statusTone,
  verifiedLabels,
} from "../../lib/tasks";
import { Button, ErrorBox, useToast } from "../common/UI";
// One task assignment. Agents update their own progress here; admins see the
// same card read-only. editable comes from the page (today's and overdue
// tasks); the server refuses anything else.
export function ProgressBar({ value, label }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div
      className="task-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
    >
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

export default function TaskCard({ task: t, editable = false }) {
  const qc = useQueryClient(),
    toast = useToast();
  const locked = !!t.verified_status || t.status === "cancelled";
  const [quantity, setQuantity] = useState(String(t.completed_quantity ?? 0)),
    [status, setStatus] = useState(
      t.status === "cancelled" ? "pending" : t.status,
    ),
    [note, setNote] = useState(t.employee_note || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/assignments/${t.id}/progress`, {
        method: "POST",
        body: {
          ...(t.kind === "measurable"
            ? { quantity: Number(quantity) }
            : { status }),
          note: note.trim(),
        },
      });
      invalidateTasks(qc);
      toast("Progress saved");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`task-card priority-${t.priority}`}>
      <header>
        <div>
          <h3>{t.title}</h3>
          <p className="task-meta">
            {t.category && <>{categoryLabel(t.category)} · </>}
            Assigned by {t.assigned_by || "an administrator"} ·{" "}
            {t.task_date === t.due_on
              ? dayLabel(t.task_date)
              : `${dayLabel(t.task_date)} – due ${dayLabel(t.due_on)}`}
          </p>
        </div>
        <div className="task-badges">
          {t.priority !== "normal" && (
            <span className={`badge priority ${t.priority}`}>
              {priorityLabel(t.priority)}
            </span>
          )}
          <span className={`badge ${statusTone(t.status)}`}>
            {statusLabel(t.status)}
          </span>
        </div>
      </header>
      {t.description && <p className="task-description">{t.description}</p>}
      {t.instructions && (
        <details className="task-instructions">
          <summary>Instructions</summary>
          <p>{t.instructions}</p>
        </details>
      )}
      <div className="task-progress-row">
        <ProgressBar value={t.percent} label={`${t.title} progress`} />
        <span className="task-percent">{percent(t.percent)}</span>
      </div>
      <p className="task-progress-text">
        {progressText(t)}
        {t.kind === "measurable" && t.remaining_quantity > 0 && (
          <> · {t.remaining_quantity} to go</>
        )}
      </p>
      {t.verified_status && (
        <p className="task-verified">
          {verifiedLabels[t.verified_status]}
          {t.verified_quantity != null &&
            t.kind === "measurable" &&
            ` · ${t.verified_quantity} ${t.unit}`}
          {t.verified_by_name && ` by ${t.verified_by_name}`}
          {t.review_note && ` — “${t.review_note}”`}
        </p>
      )}
      {t.status === "cancelled" && (
        <p className="task-verified">
          Cancelled{t.cancel_reason ? `: ${t.cancel_reason}` : ""}
        </p>
      )}
      {editable && !locked && (
        <form className="task-update" onSubmit={save}>
          {t.kind === "measurable" ? (
            <label>
              Completed ({t.unit})
              <input
                type="number"
                min={0}
                max={1000000}
                step={1}
                inputMode="numeric"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
          ) : (
            <label>
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </select>
            </label>
          )}
          <label className="task-note">
            Note (optional)
            <input
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save progress"}
          </Button>
          <ErrorBox error={error} />
        </form>
      )}
    </article>
  );
}
