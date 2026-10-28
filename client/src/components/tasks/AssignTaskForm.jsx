import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { addDays, todayPk } from "../../lib/calendar";
import {
  invalidateTasks,
  taskCategories,
  taskPriorities,
} from "../../lib/tasks";
import { Button, ErrorBox, useToast } from "../common/UI";
// Assign Team Task / Assign Individual Task (update 045). Each agent gets an
// assignment of their own; the server checks the agents, dates and targets.
const blank = (scope) => ({
  scope,
  title: "",
  kind: "measurable",
  target_quantity: "",
  unit: "",
  category: "",
  priority: "normal",
  task_date: todayPk(),
  due_on: "",
  description: "",
  instructions: "",
});
export default function AssignTaskForm({ onAssigned }) {
  const qc = useQueryClient(),
    toast = useToast();
  const agents = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const active = (agents.data || []).filter(
    (u) => u.role === "agent" && u.active,
  );
  const [form, setForm] = useState(blank("team")),
    [everyone, setEveryone] = useState(true),
    [chosen, setChosen] = useState([]),
    [single, setSingle] = useState(""),
    // One key per form: a repeated click returns the same task.
    [key, setKey] = useState(() => crypto.randomUUID()),
    [duplicate, setDuplicate] = useState(false),
    [allowDuplicate, setAllowDuplicate] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (field) => (e) => {
    setForm({ ...form, [field]: e.target.value });
    setDuplicate(false);
    setAllowDuplicate(false);
  };
  const team = form.scope === "team";
  const toggle = (id) =>
    setChosen(
      chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
    );
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const assignees = team
      ? everyone
        ? null
        : chosen
      : single
        ? [single]
        : [];
    if (assignees && !assignees.length) {
      setError(team ? "Choose at least one agent." : "Choose the agent.");
      return;
    }
    setBusy(true);
    try {
      const body = {
        scope: form.scope,
        title: form.title.trim(),
        kind: form.kind,
        priority: form.priority,
        task_date: form.task_date,
        client_key: key,
        ...(form.due_on ? { due_on: form.due_on } : {}),
        ...(form.category ? { category: form.category } : {}),
        ...(form.description.trim()
          ? { description: form.description.trim() }
          : {}),
        ...(form.instructions.trim()
          ? { instructions: form.instructions.trim() }
          : {}),
        ...(form.kind === "measurable"
          ? {
              target_quantity: Number(form.target_quantity),
              unit: form.unit.trim(),
            }
          : {}),
        ...(assignees ? { assignees } : { all_agents: true }),
        ...(allowDuplicate ? { allow_duplicate: true } : {}),
      };
      const task = await api("/admin/tasks", { method: "POST", body });
      invalidateTasks(qc);
      toast(
        `Assigned “${task.title}” to ${task.assignments.length} ${task.assignments.length === 1 ? "agent" : "agents"}`,
      );
      setForm(blank(form.scope));
      setChosen([]);
      setSingle("");
      setKey(crypto.randomUUID());
      setAllowDuplicate(false);
      onAssigned?.(task);
    } catch (e) {
      setError(e.message);
      setDuplicate(e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel assign-task" onSubmit={submit}>
      <fieldset className="assign-scope">
        <legend>Assign</legend>
        {[
          [
            "team",
            "Team Task",
            "The same task for several agents; each is responsible for the full target.",
          ],
          ["individual", "Individual Task", "A task for one agent."],
        ].map(([value, label, hint]) => (
          <label
            key={value}
            className={`scope-option${form.scope === value ? " active" : ""}`}
          >
            <input
              type="radio"
              name="scope"
              value={value}
              checked={form.scope === value}
              onChange={() => setForm({ ...form, scope: value })}
            />
            <span>
              <b>{label}</b>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Assign to</legend>
        <ErrorBox error={agents.error} />
        {team ? (
          <>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={everyone}
                onChange={(e) => setEveryone(e.target.checked)}
              />
              All active agents ({active.length})
            </label>
            {!everyone && (
              <div className="agent-picker" role="group" aria-label="Agents">
                {active.map((a) => (
                  <label key={a.id} className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={chosen.includes(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    {a.name} <small>UID {a.uid}</small>
                  </label>
                ))}
              </div>
            )}
          </>
        ) : (
          <label>
            Agent
            <select
              required
              value={single}
              onChange={(e) => setSingle(e.target.value)}
            >
              <option value="">Choose an agent</option>
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · UID {a.uid}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="field-hint">Disabled accounts can't be given tasks.</p>
      </fieldset>
      <fieldset>
        <legend>Task</legend>
        <div className="form-grid">
          <label className="wide">
            Title
            <input
              required
              minLength={3}
              maxLength={120}
              value={form.title}
              onChange={set("title")}
              placeholder="For example: Contact potential property buyers"
            />
          </label>
          <label>
            Type
            <select value={form.kind} onChange={set("kind")}>
              <option value="measurable">Measurable (has a target)</option>
              <option value="simple">Simple (done or not done)</option>
            </select>
          </label>
          {form.kind === "measurable" && (
            <>
              <label>
                Target
                <input
                  type="number"
                  required
                  min={1}
                  max={100000}
                  inputMode="numeric"
                  value={form.target_quantity}
                  onChange={set("target_quantity")}
                  placeholder="50"
                />
              </label>
              <label>
                Unit
                <input
                  required
                  maxLength={30}
                  value={form.unit}
                  onChange={set("unit")}
                  placeholder="calls"
                />
              </label>
            </>
          )}
          <label>
            Category
            <select value={form.category} onChange={set("category")}>
              <option value="">None</option>
              {taskCategories.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={form.priority} onChange={set("priority")}>
              {taskPriorities.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task date
            <input
              type="date"
              required
              min={todayPk()}
              max={addDays(todayPk(), 60)}
              value={form.task_date}
              onChange={set("task_date")}
            />
          </label>
          <label>
            Due date
            <input
              type="date"
              min={form.task_date}
              max={addDays(form.task_date, 31)}
              value={form.due_on || form.task_date}
              onChange={set("due_on")}
            />
          </label>
          <label className="wide">
            Description
            <textarea
              rows={2}
              maxLength={1000}
              value={form.description}
              onChange={set("description")}
            />
          </label>
          <label className="wide">
            Instructions
            <textarea
              rows={2}
              maxLength={1000}
              value={form.instructions}
              onChange={set("instructions")}
              placeholder="For example: record each outcome in the lead."
            />
          </label>
        </div>
      </fieldset>
      <ErrorBox error={error} />
      {duplicate && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allowDuplicate}
            onChange={(e) => setAllowDuplicate(e.target.checked)}
          />
          Assign anyway, as a second task
        </label>
      )}
      <div className="review-buttons">
        <Button type="submit" disabled={busy || (duplicate && !allowDuplicate)}>
          {busy
            ? "Assigning…"
            : team
              ? "Assign Team Task"
              : "Assign Individual Task"}
        </Button>
      </div>
    </form>
  );
}
