import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { dayLabel } from "../../lib/calendar";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  categoryLabel,
  invalidateTasks,
  percent,
  priorityLabel,
  progressText,
  statusLabel,
  statusTone,
  taskPriorities,
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
import { ProgressBar } from "./TaskCard";
// Team tasks and individual tasks for administrators (update 045): the list,
// then one task with every agent's progress, verification and changes.
function VerifyForm({ assignment: a, onDone }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [status, setStatus] = useState("confirmed"),
    [quantity, setQuantity] = useState(String(a.completed_quantity)),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/admin/tasks/assignments/${a.id}/verify`, {
        method: "POST",
        body: {
          status,
          ...(status === "adjusted" ? { quantity: Number(quantity) } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      invalidateTasks(qc);
      toast(`Verified ${a.user_name}'s task`);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="verify-form" onSubmit={submit}>
      <p>
        {a.user_name} reported <b>{progressText(a)}</b> ({percent(a.percent)}).
        Your check is kept separately; their report is not changed.
      </p>
      <fieldset>
        <legend>Your check</legend>
        {[
          ["confirmed", "Confirmed as reported"],
          ...(a.kind === "measurable"
            ? [["adjusted", "Adjusted quantity"]]
            : []),
          ["not_done", "Not done"],
        ].map(([v, l]) => (
          <label key={v} className="checkbox-field">
            <input
              type="radio"
              name="verify"
              value={v}
              checked={status === v}
              onChange={() => setStatus(v)}
            />
            {l}
          </label>
        ))}
      </fieldset>
      {status === "adjusted" && (
        <label>
          Verified quantity ({a.unit})
          <input
            type="number"
            min={0}
            max={1000000}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
      )}
      <label>
        Note (optional)
        <input
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          type="button"
          variant="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save check"}
        </Button>
      </footer>
    </form>
  );
}

function EditTask({ task: t, onDone }) {
  const qc = useQueryClient(),
    toast = useToast();
  const agents = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const assigned = new Set(
    t.assignments.filter((a) => a.status !== "cancelled").map((a) => a.user_id),
  );
  const addable = (agents.data || []).filter(
    (u) => u.role === "agent" && u.active && !assigned.has(u.id),
  );
  const [f, setF] = useState({
      title: t.title,
      description: t.description || "",
      instructions: t.instructions || "",
      priority: t.priority,
      target_quantity: t.target_quantity ?? "",
      unit: t.unit || "",
      due_on: t.due_on,
    }),
    [add, setAdd] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const body = { expected_updated_at: t.updated_at };
    for (const k of [
      "title",
      "description",
      "instructions",
      "priority",
      "due_on",
    ])
      if ((f[k] || "") !== (t[k] || "")) body[k] = f[k];
    if (t.kind === "measurable") {
      if (Number(f.target_quantity) !== t.target_quantity)
        body.target_quantity = Number(f.target_quantity);
      if (f.unit !== t.unit) body.unit = f.unit;
    }
    if (add.length) body.add_assignees = add;
    try {
      await api(`/admin/tasks/${t.id}`, { method: "PATCH", body });
      invalidateTasks(qc);
      toast("Task updated; its agents were told");
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="edit-task" onSubmit={submit}>
      <p className="field-hint">
        Changes apply to every agent with this task. Reports already submitted
        keep the values they were submitted with.
      </p>
      <div className="form-grid">
        <label className="wide">
          Title
          <input
            required
            minLength={3}
            maxLength={120}
            value={f.title}
            onChange={set("title")}
          />
        </label>
        {t.kind === "measurable" && (
          <>
            <label>
              Target
              <input
                type="number"
                min={1}
                max={100000}
                required
                value={f.target_quantity}
                onChange={set("target_quantity")}
              />
            </label>
            <label>
              Unit
              <input
                maxLength={30}
                required
                value={f.unit}
                onChange={set("unit")}
              />
            </label>
          </>
        )}
        <label>
          Priority
          <select value={f.priority} onChange={set("priority")}>
            {taskPriorities.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due date
          <input
            type="date"
            min={t.task_date}
            value={f.due_on}
            onChange={set("due_on")}
          />
        </label>
        <label className="wide">
          Description
          <textarea
            rows={2}
            maxLength={1000}
            value={f.description}
            onChange={set("description")}
          />
        </label>
        <label className="wide">
          Instructions
          <textarea
            rows={2}
            maxLength={1000}
            value={f.instructions}
            onChange={set("instructions")}
          />
        </label>
      </div>
      {t.scope === "team" && addable.length > 0 && (
        <fieldset>
          <legend>Add agents</legend>
          <div className="agent-picker">
            {addable.map((a) => (
              <label key={a.id} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={add.includes(a.id)}
                  onChange={() =>
                    setAdd(
                      add.includes(a.id)
                        ? add.filter((x) => x !== a.id)
                        : [...add, a.id],
                    )
                  }
                />
                {a.name} <small>UID {a.uid}</small>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          type="button"
          variant="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </footer>
    </form>
  );
}

export function TaskDetail({ id, onClose }) {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["admin-task", id],
    queryFn: ({ signal }) => api(`/admin/tasks/${id}`, { signal }),
  });
  const [mode, setMode] = useState(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const t = q.data;
  async function act(path, message) {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method: "POST",
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      invalidateTasks(qc);
      toast(message);
      setMode(null);
      setReason("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t ? t.title : "Task"}
      onClose={onClose}
      className="task-dialog"
    >
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : mode === "edit" ? (
        <EditTask task={t} onDone={() => setMode(null)} />
      ) : mode?.verify ? (
        <VerifyForm assignment={mode.verify} onDone={() => setMode(null)} />
      ) : mode === "cancel" || mode?.remove ? (
        <div>
          <p>
            {mode === "cancel"
              ? `Cancel “${t.title}” for every agent? Their reported progress is kept, and they are told.`
              : `Take ${mode.remove.user_name} off “${t.title}”? Their reported progress is kept.`}
          </p>
          <label>
            Reason (optional)
            <input
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <ErrorBox error={error} />
          <footer className="review-buttons">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                mode === "cancel"
                  ? act(`/admin/tasks/${t.id}/cancel`, "Task cancelled")
                  : act(
                      `/admin/tasks/assignments/${mode.remove.id}/cancel`,
                      `${mode.remove.user_name} taken off the task`,
                    )
              }
            >
              {busy
                ? "Saving…"
                : mode === "cancel"
                  ? "Cancel task"
                  : "Take off task"}
            </Button>
          </footer>
        </div>
      ) : (
        <>
          <dl className="task-facts">
            <div>
              <dt>Type</dt>
              <dd>
                {t.scope === "team" ? "Team task" : "Individual task"} ·{" "}
                {t.kind === "measurable"
                  ? `target ${t.target_quantity} ${t.unit} each`
                  : "simple"}
              </dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>
                {dayLabel(t.task_date)}
                {t.due_on !== t.task_date && ` – due ${dayLabel(t.due_on)}`}
              </dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{priorityLabel(t.priority)}</dd>
            </div>
            {t.category && (
              <div>
                <dt>Category</dt>
                <dd>{categoryLabel(t.category)}</dd>
              </div>
            )}
            <div>
              <dt>Assigned by</dt>
              <dd>{t.created_by_name}</dd>
            </div>
            {t.cancelled_at && (
              <div>
                <dt>Cancelled</dt>
                <dd>
                  by {t.cancelled_by_name}
                  {t.cancel_reason ? `: ${t.cancel_reason}` : ""}
                </dd>
              </div>
            )}
          </dl>
          {t.description && <p>{t.description}</p>}
          {t.instructions && (
            <p className="field-hint">Instructions: {t.instructions}</p>
          )}
          <h3>Agents</h3>
          <ul className="assignment-list">
            {t.assignments.map((a) => (
              <li key={a.id}>
                <div className="assignment-head">
                  <b>{a.user_name}</b>
                  <small>
                    UID {a.user_uid}
                    {!a.user_active && " · account disabled"}
                  </small>
                  <span className={`badge ${statusTone(a.status)}`}>
                    {statusLabel(a.status)}
                  </span>
                </div>
                <div className="task-progress-row">
                  <ProgressBar
                    value={a.percent}
                    label={`${a.user_name} progress`}
                  />
                  <span className="task-percent">{percent(a.percent)}</span>
                </div>
                <p className="task-progress-text">
                  {progressText(a)}
                  {a.employee_note && ` · “${a.employee_note}”`}
                </p>
                {a.verified_status && (
                  <p className="task-verified">
                    {verifiedLabels[a.verified_status]}
                    {a.verified_quantity != null &&
                      a.kind === "measurable" &&
                      ` · ${a.verified_quantity} ${a.unit} (${percent(a.verified_percent)})`}
                    {` by ${a.verified_by_name}`}
                    {a.review_note && ` — “${a.review_note}”`}
                  </p>
                )}
                {!t.cancelled_at && a.status !== "cancelled" && (
                  <div className="assignment-actions">
                    {!a.verified_status && (
                      <Button
                        variant="secondary"
                        onClick={() => setMode({ verify: a })}
                      >
                        Verify
                      </Button>
                    )}
                    {t.scope === "team" && (
                      <Button
                        variant="secondary"
                        onClick={() => setMode({ remove: a })}
                      >
                        Take off task
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!t.cancelled_at && (
            <footer className="review-buttons">
              <Button variant="secondary" onClick={() => setMode("edit")}>
                Edit task
              </Button>
              <Button variant="danger" onClick={() => setMode("cancel")}>
                Cancel task
              </Button>
            </footer>
          )}
        </>
      )}
    </Modal>
  );
}

export default function AdminTaskList({ scope }) {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState("open"),
    [search, setSearch] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [open, setOpen] = useState(null);
  const term = useDebouncedValue(search.trim());
  const params = new URLSearchParams({
    scope,
    page,
    ...(status ? { status } : {}),
    ...(term ? { search: term } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const q = useQuery({
    queryKey: ["admin-tasks", params.toString()],
    queryFn: ({ signal }) => api("/admin/tasks?" + params, { signal }),
  });
  const reset = (fn) => (e) => {
    fn(e.target.value);
    setPage(1);
  };
  return (
    <section className="panel">
      <div className="toolbar task-filters">
        <input
          aria-label="Search tasks"
          placeholder="Search task titles…"
          value={search}
          onChange={reset(setSearch)}
        />
        <select aria-label="Status" value={status} onChange={reset(setStatus)}>
          <option value="open">Open</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <label>
          From
          <input type="date" value={from} onChange={reset(setFrom)} />
        </label>
        <label>
          Through
          <input type="date" value={to} onChange={reset(setTo)} />
        </label>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <Table
          columns={[
            {
              key: "title",
              label: "Task",
              render: (t) => (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setOpen(t.id)}
                >
                  {t.title}
                </button>
              ),
            },
            {
              key: "task_date",
              label: "Date",
              render: (t) =>
                dayLabel(t.task_date) +
                (t.due_on !== t.task_date ? ` – ${dayLabel(t.due_on)}` : ""),
            },
            {
              key: "kind",
              label: "Target",
              render: (t) =>
                t.kind === "measurable"
                  ? `${t.target_quantity} ${t.unit}`
                  : "Simple",
            },
            {
              key: "assignees",
              label: scope === "team" ? "Agents" : "Agent",
              render: (t) =>
                `${t.assignee_names.join(", ")}${t.assignees > t.assignee_names.length ? ` +${t.assignees - t.assignee_names.length}` : ""}`,
            },
            {
              key: "completed",
              label: "Completed",
              render: (t) => `${t.completed} of ${t.assignees}`,
            },
            {
              key: "average_percent",
              label: "Average",
              render: (t) => percent(t.average_percent),
            },
            {
              key: "priority",
              label: "Priority",
              render: (t) =>
                t.cancelled_at ? (
                  <span className="badge lost">Cancelled</span>
                ) : (
                  priorityLabel(t.priority)
                ),
            },
          ]}
          rows={q.data?.data || []}
        />
      )}
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
      {open && <TaskDetail id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
