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
// Assign Team Task / Assign Individual Task (update 045; staff and departments
// from 047). Each person gets an assignment of their own, decided when the
// task is assigned; the server checks the people, dates and targets.
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
  const people = (Array.isArray(agents.data) ? agents.data : []).filter(
    (u) => (u.role === "agent" || u.role === "staff") && u.active,
  );
  const active = people.filter((u) => u.role === "agent");
  const staff = people.filter((u) => u.role === "staff");
  const departmentList = useQuery({
    queryKey: ["departments"],
    queryFn: ({ signal }) => api("/admin/departments", { signal }),
    retry: false,
  });
  const departments = (
    Array.isArray(departmentList.data) ? departmentList.data : []
  ).filter((d) => d.active && d.members > 0);
  const [form, setForm] = useState(blank("team")),
    [everyone, setEveryone] = useState(true),
    [allStaff, setAllStaff] = useState(false),
    [chosenDepartments, setChosenDepartments] = useState([]),
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
  const toggleDepartment = (id) =>
    setChosenDepartments(
      chosenDepartments.includes(id)
        ? chosenDepartments.filter((x) => x !== id)
        : [...chosenDepartments, id],
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
    const groups = team && (allStaff || chosenDepartments.length > 0);
    if (assignees && !assignees.length && !groups) {
      setError(team ? "Choose who gets this task." : "Choose the employee.");
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
        ...(assignees
          ? assignees.length
            ? { assignees }
            : {}
          : { all_agents: true }),
        ...(team && allStaff ? { all_staff: true } : {}),
        ...(team && chosenDepartments.length
          ? { departments: chosenDepartments }
          : {}),
        ...(allowDuplicate ? { allow_duplicate: true } : {}),
      };
      const task = await api("/admin/tasks", { method: "POST", body });
      invalidateTasks(qc);
      toast(
        `Assigned “${task.title}” to ${task.assignments.length} ${task.assignments.length === 1 ? "person" : "people"}`,
      );
      setForm(blank(form.scope));
      setChosen([]);
      setChosenDepartments([]);
      setAllStaff(false);
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
            "The same task for several people; each is responsible for the full target.",
          ],
          [
            "individual",
            "Individual Task",
            "A task for one agent or staff member.",
          ],
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
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allStaff}
                onChange={(e) => setAllStaff(e.target.checked)}
              />
              All active staff ({staff.length})
            </label>
            {departments.length > 0 && (
              <div
                className="department-picker"
                role="group"
                aria-label="Departments"
              >
                {departments.map((d) => (
                  <label key={d.id} className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={chosenDepartments.includes(d.id)}
                      onChange={() => toggleDepartment(d.id)}
                    />
                    {d.name} team ({d.members})
                  </label>
                ))}
              </div>
            )}
            {!everyone && (
              <>
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
                {staff.length > 0 && !allStaff && (
                  <div className="agent-picker" role="group" aria-label="Staff">
                    {staff.map((a) => (
                      <label key={a.id} className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={chosen.includes(a.id)}
                          onChange={() => toggle(a.id)}
                        />
                        {a.name} <small>Staff · UID {a.uid}</small>
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="field-hint">
              Everyone chosen gets their own copy. People who join a department
              later don&apos;t get tasks already assigned.
            </p>
          </>
        ) : (
          <label>
            Employee
            <select
              required
              value={single}
              onChange={(e) => setSingle(e.target.value)}
            >
              <option value="">Choose an agent or staff member</option>
              <optgroup label="Agents">
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · UID {a.uid}
                  </option>
                ))}
              </optgroup>
              {staff.length > 0 && (
                <optgroup label="Staff">
                  {staff.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · UID {a.uid}
                    </option>
                  ))}
                </optgroup>
              )}
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
