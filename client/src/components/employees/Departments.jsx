import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Button, ErrorBox, Modal, useToast } from "../common/UI";
// Departments (update 047): added, renamed or deactivated, never deleted, so
// every past link stays readable. Roles are separate from departments.
export default function Departments({ departments, onClose }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [name, setName] = useState(""),
    [renaming, setRenaming] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(work, message) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      qc.invalidateQueries({ queryKey: ["departments"] });
      qc.invalidateQueries({ queryKey: ["employees"] });
      toast(message);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Departments" onClose={onClose} className="task-dialog">
      <p className="field-hint">
        Departments group employees for tasks, attendance and performance. Their
        role (Agent or Staff) decides what they can use.
      </p>
      <ul className="assignment-list">
        {departments.map((d) => (
          <li key={d.id}>
            {renaming?.id === d.id ? (
              <form
                className="department-rename"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await run(
                      () =>
                        api(`/admin/departments/${d.id}`, {
                          method: "PATCH",
                          body: { name: renaming.name.trim() },
                        }),
                      "Department renamed",
                    )
                  )
                    setRenaming(null);
                }}
              >
                <input
                  aria-label={`New name for ${d.name}`}
                  value={renaming.name}
                  maxLength={60}
                  onChange={(e) =>
                    setRenaming({ ...renaming, name: e.target.value })
                  }
                />
                <Button type="submit" disabled={busy}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="assignment-head">
                <strong>{d.name}</strong>
                <small>
                  {d.members} active · {d.agents} agents · {d.staff} staff
                </small>
                <span className={`badge ${d.active ? "completed" : ""}`}>
                  {d.active ? "Active" : "Inactive"}
                </span>
              </div>
            )}
            {renaming?.id !== d.id && (
              <div className="assignment-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setRenaming({ id: d.id, name: d.name })}
                >
                  Rename
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api(`/admin/departments/${d.id}`, {
                          method: "PATCH",
                          body: { active: !d.active },
                        }),
                      d.active
                        ? "Department deactivated"
                        : "Department reactivated",
                    )
                  }
                >
                  {d.active ? "Deactivate" : "Reactivate"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="task-filters"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run(
              () =>
                api("/admin/departments", {
                  method: "POST",
                  body: { name: name.trim() },
                }),
              "Department added",
            )
          )
            setName("");
        }}
      >
        <label>
          New department
          <input
            value={name}
            maxLength={60}
            placeholder="e.g. Customer Care"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || name.trim().length < 2}>
          Add department
        </Button>
      </form>
      <ErrorBox error={error} />
    </Modal>
  );
}
