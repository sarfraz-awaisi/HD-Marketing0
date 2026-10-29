import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { clockLabel, invalidateAttendance } from "../../../lib/attendance";
import { fullDayLabel } from "../../../lib/calendar";
import { roleLabel, workDaysText } from "../../../lib/roles";
import {
  shiftHours,
  shiftLine,
  shiftSources,
  sourceLabel,
} from "../../../lib/shifts";
import { useDebouncedValue } from "../../../lib/useDebouncedValue";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  useToast,
} from "../../common/UI";
import ShiftTimingForm from "./ShiftTimingForm";
import "../../../styles/tasks.css";
import "../../../styles/staff.css";
import "../../../styles/shifts.css";
// Shift management (update 048): office timings for agents and staff,
// departments and individual employees, and every change made to them.
// An employee follows, highest first, their own timing, their department's,
// their role's, or the company default from Settings.
export const shiftViews = [
  ["roles", "Role timings"],
  ["departments", "Department timings"],
  ["individual", "Individual timings"],
  ["history", "Shift history"],
];
const base = "/admin/attendance/shifts";
// Everything that shows a timing reloads after a change.
function useRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["shifts"] });
    qc.invalidateQueries({ queryKey: ["employees"] });
    qc.invalidateQueries({ queryKey: ["employee"] });
    qc.invalidateQueries({ queryKey: ["my-profile"] });
    invalidateAttendance(qc);
  };
}
// Planned changes not yet started, each with Withdraw, sent with the version
// shown so a newer change from someone else is never withdrawn unseen.
function Planned({ items, path, version, label, onDone }) {
  const toast = useToast(),
    [busy, setBusy] = useState("");
  if (!items?.length) return null;
  async function withdraw(day) {
    if (busy) return;
    setBusy(day);
    try {
      await api(`${path}/${day}?version=${version}`, { method: "DELETE" });
      toast("Planned change withdrawn");
      onDone();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <ul className="shift-planned">
      {items.map((p) => (
        <li key={p.effective_from}>
          <span>
            From {fullDayLabel(p.effective_from)}:{" "}
            {p.inherits ? label : shiftLine(p)}
          </span>
          <button
            type="button"
            className="link-button"
            disabled={busy === p.effective_from}
            onClick={() => withdraw(p.effective_from)}
          >
            Withdraw
          </button>
        </li>
      ))}
    </ul>
  );
}
export function SourceBadge({ shift }) {
  const source = shift?.source === "assigned" ? "individual" : shift?.source;
  return (
    <span className={`badge plain shift-source ${source || ""}`}>
      {sourceLabel(shift)}
    </span>
  );
}
// The timing a role or department has today, or what it falls back to.
function currentTiming(row, fallback) {
  return row.current && !row.current.inherits ? row.current : fallback;
}
const timingCells = (t) => ({
  start: t?.shift_start ? clockLabel(t.shift_start) : "—",
  end: t?.shift_end ? clockLabel(t.shift_end) : "—",
  days: t?.work_days ? workDaysText(t.work_days) : "—",
  grace: t?.grace_minutes != null ? `${t.grace_minutes} min` : "—",
});
function RoleTimings({ data, onEdit }) {
  const company = data.company;
  return (
    <section className="panel" aria-labelledby="shift-roles-title">
      <div className="panel-heading">
        <div>
          <h2 id="shift-roles-title">Role timings</h2>
          <p className="field-hint">
            The default for every agent or every staff member, unless their
            department or their own timing says otherwise. Administrators follow
            the company default.
          </p>
        </div>
      </div>
      <p className="shift-company">
        <strong>Company default shift:</strong>{" "}
        {company ? shiftLine(company) : "Not set yet"}. Change it in Settings.
      </p>
      <Table
        rows={data.roles.map((r) => ({ ...r, id: r.role }))}
        columns={[
          {
            key: "role",
            label: "Role",
            render: (r) => (
              <>
                <strong>{r.name}</strong>
                <small className="employee-sub">
                  {r.current && !r.current.inherits
                    ? `Since ${fullDayLabel(r.current.effective_from)}`
                    : "Follows the company default"}
                  {` · ${r.members} active`}
                </small>
              </>
            ),
          },
          ...["start", "end", "days", "grace"].map((key) => ({
            key,
            label: {
              start: "Start time",
              end: "End time",
              days: "Working days",
              grace: "Grace",
            }[key],
            render: (r) => timingCells(currentTiming(r, company))[key],
          })),
          {
            key: "planned",
            label: "Planned",
            render: (r) =>
              r.planned.length ? (
                <Planned
                  items={r.planned}
                  path={`${base}/roles/${r.role}`}
                  version={r.version}
                  label="Back to the company default"
                  onDone={onEdit.done}
                />
              ) : (
                "—"
              ),
          },
          {
            key: "actions",
            label: "Actions",
            render: (r) => (
              <div className="review-actions">
                <Button
                  variant="secondary"
                  onClick={() => onEdit.open({ kind: "role", row: r })}
                >
                  Edit
                </Button>
                {(r.current && !r.current.inherits) ||
                r.planned.some((p) => !p.inherits) ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      onEdit.open({ kind: "role", row: r, remove: true })
                    }
                  >
                    Use company default
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
function DepartmentTimings({ data, onEdit }) {
  return (
    <section className="panel" aria-labelledby="shift-departments-title">
      <div className="panel-heading">
        <div>
          <h2 id="shift-departments-title">Department timings</h2>
          <p className="field-hint">
            A department&apos;s timing applies to its agents and staff over
            their role default. Employees with their own timing keep it. Add
            departments in Employee management.
          </p>
        </div>
      </div>
      <Table
        rows={data.departments}
        columns={[
          {
            key: "name",
            label: "Department",
            render: (d) => (
              <>
                <strong>{d.name}</strong>
                {!d.active && <small className="employee-sub">Inactive</small>}
                <small className="employee-sub">
                  {d.members === 1 ? "1 employee" : `${d.members} employees`}
                  {d.current && !d.current.inherits
                    ? ` · ${d.following} on this timing`
                    : ""}
                </small>
              </>
            ),
          },
          {
            key: "timing",
            label: "Office timing",
            render: (d) =>
              d.current && !d.current.inherits
                ? shiftHours(d.current)
                : "Role defaults",
          },
          {
            key: "days",
            label: "Working days",
            render: (d) =>
              d.current && !d.current.inherits
                ? workDaysText(d.current.work_days)
                : "—",
          },
          {
            key: "grace",
            label: "Grace",
            render: (d) =>
              d.current && !d.current.inherits
                ? `${d.current.grace_minutes} min`
                : "—",
          },
          {
            key: "planned",
            label: "Planned",
            render: (d) =>
              d.planned.length ? (
                <Planned
                  items={d.planned}
                  path={`${base}/departments/${d.id}`}
                  version={d.version}
                  label="Back to role defaults"
                  onDone={onEdit.done}
                />
              ) : (
                "—"
              ),
          },
          {
            key: "actions",
            label: "Actions",
            render: (d) => (
              <div className="review-actions">
                {d.active && (
                  <Button
                    variant="secondary"
                    onClick={() => onEdit.open({ kind: "department", row: d })}
                  >
                    {d.current && !d.current.inherits ? "Edit" : "Set timing"}
                  </Button>
                )}
                {(d.current && !d.current.inherits) ||
                d.planned.some((p) => !p.inherits) ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      onEdit.open({ kind: "department", row: d, remove: true })
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
const filtersFor = (f) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")),
  );
function IndividualTimings({ data, onEdit }) {
  const [page, setPage] = useState(1);
  const [f, setF] = useState({
    search: "",
    role: "",
    department: "",
    source: "",
    account: "active",
  });
  const search = useDebouncedValue(f.search, 300);
  const params = filtersFor({ ...f, search: search.trim(), page });
  const q = useQuery({
    queryKey: ["shifts", "employees", params.toString()],
    queryFn: ({ signal }) => api(`${base}/employees?${params}`, { signal }),
  });
  const set = (key) => (e) => {
    setF((v) => ({ ...v, [key]: e.target.value }));
    setPage(1);
  };
  const s = q.data?.summary || {};
  return (
    <section className="panel" aria-labelledby="shift-individual-title">
      <div className="panel-heading">
        <div>
          <h2 id="shift-individual-title">Individual timings</h2>
          <p className="field-hint">
            Find an employee by name, UID or email and give them their own
            office timing. It takes priority over their department and role.
          </p>
        </div>
      </div>
      <p className="shift-summary" aria-live="polite">
        Active employees: {s.individual ?? 0} on an individual shift ·{" "}
        {s.department ?? 0} on a department shift · {s.role ?? 0} on a role
        default · {s.company ?? 0} on the company default
      </p>
      <div className="toolbar task-filters employee-filters">
        <input
          type="search"
          aria-label="Search employees"
          placeholder="Search by name, UID or email…"
          value={f.search}
          onChange={set("search")}
        />
        <select aria-label="Role" value={f.role} onChange={set("role")}>
          <option value="">All roles</option>
          <option value="agent">Agents</option>
          <option value="staff">Staff</option>
          <option value="admin">Admins</option>
        </select>
        <select
          aria-label="Department"
          value={f.department}
          onChange={set("department")}
        >
          <option value="">All departments</option>
          {data.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="none">No department</option>
        </select>
        <select
          aria-label="Shift source"
          value={f.source}
          onChange={set("source")}
        >
          <option value="">Any shift source</option>
          {shiftSources.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Account status"
          value={f.account}
          onChange={set("account")}
        >
          <option value="">All accounts</option>
          <option value="active">Active</option>
          <option value="inactive">Disabled</option>
        </select>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <>
          <Table
            rows={q.data?.data || []}
            columns={[
              {
                key: "name",
                label: "Employee",
                render: (r) => (
                  <>
                    <strong>{r.name}</strong>
                    <small className="employee-sub">
                      UID {r.uid}
                      {r.email ? ` · ${r.email}` : ""}
                      {r.active ? "" : " · disabled"}
                    </small>
                  </>
                ),
              },
              {
                key: "role",
                label: "Role",
                render: (r) => (
                  <span className={`badge ${r.role}`}>{roleLabel(r.role)}</span>
                ),
              },
              {
                key: "department",
                label: "Department",
                render: (r) => r.department || "—",
              },
              {
                key: "timing",
                label: "Office timing",
                render: (r) => (
                  <>
                    {shiftHours(r.shift)}
                    {r.shift?.upcoming && (
                      <small className="employee-sub">
                        From {fullDayLabel(r.shift.upcoming.effective_from)}:{" "}
                        {shiftHours(r.shift.upcoming)}
                      </small>
                    )}
                  </>
                ),
              },
              {
                key: "days",
                label: "Working days",
                render: (r) => workDaysText(r.shift?.work_days),
              },
              {
                key: "source",
                label: "Schedule source",
                render: (r) => <SourceBadge shift={r.shift} />,
              },
              {
                key: "actions",
                label: "Actions",
                render: (r) => (
                  <Button
                    variant="secondary"
                    aria-label={`Edit ${r.name}'s timing`}
                    onClick={() => onEdit.employee(r.id)}
                  >
                    Edit
                  </Button>
                ),
              },
            ]}
          />
          <Pagination
            page={page}
            count={q.data?.count || 0}
            limit={q.data?.limit || 20}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
const statusNames = {
  current: ["In effect", "completed"],
  planned: ["Planned", "info"],
  ended: ["Ended", ""],
  replaced: ["Replaced", ""],
  withdrawn: ["Withdrawn", "cancelled"],
};
const scopeNames = {
  individual: "Employee",
  role: "Role",
  department: "Department",
};
const fallbackFor = {
  individual: "Removed: follows the department or role timing",
  department: "Removed: back to role defaults",
  role: "Removed: back to the company default",
};
function ShiftHistory() {
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ search: "", scope: "", status: "" });
  const search = useDebouncedValue(f.search, 300);
  const params = filtersFor({ ...f, search: search.trim(), page });
  const q = useQuery({
    queryKey: ["shifts", "history", params.toString()],
    queryFn: ({ signal }) => api(`${base}/history?${params}`, { signal }),
  });
  const set = (key) => (e) => {
    setF((v) => ({ ...v, [key]: e.target.value }));
    setPage(1);
  };
  return (
    <section className="panel" aria-labelledby="shift-history-title">
      <div className="panel-heading">
        <div>
          <h2 id="shift-history-title">Shift history</h2>
          <p className="field-hint">
            Every timing ever saved, newest first. Nothing is deleted: a newer
            version replaces an older one from the same day, and withdrawn
            changes stay listed.
          </p>
        </div>
      </div>
      <div className="toolbar task-filters">
        <input
          type="search"
          aria-label="Search shift history"
          placeholder="Search by employee, UID, role or department…"
          value={f.search}
          onChange={set("search")}
        />
        <select aria-label="Applies to" value={f.scope} onChange={set("scope")}>
          <option value="">Everyone</option>
          <option value="role">Roles</option>
          <option value="department">Departments</option>
          <option value="individual">Employees</option>
        </select>
        <select aria-label="Status" value={f.status} onChange={set("status")}>
          <option value="">Any status</option>
          {Object.entries(statusNames).map(([value, [label]]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : !q.data?.data?.length ? (
        <div className="empty">No shift changes yet.</div>
      ) : (
        <>
          <Table
            rows={q.data.data}
            columns={[
              {
                key: "target",
                label: "Applies to",
                render: (h) => (
                  <>
                    <strong>{h.target_name}</strong>
                    <small className="employee-sub">
                      {scopeNames[h.scope]}
                      {h.uid ? ` · UID ${h.uid}` : ""}
                    </small>
                  </>
                ),
              },
              {
                key: "effective_from",
                label: "From",
                render: (h) => fullDayLabel(h.effective_from),
              },
              {
                key: "timing",
                label: "Timing",
                render: (h) =>
                  h.inherits ? fallbackFor[h.scope] : shiftLine(h),
              },
              {
                key: "reason",
                label: "Reason",
                render: (h) => h.reason || "—",
              },
              {
                key: "saved",
                label: "Saved",
                render: (h) => (
                  <>
                    {new Date(h.created_at).toLocaleString("en-PK", {
                      timeZone: "Asia/Karachi",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    <small className="employee-sub">
                      by {h.created_by_name || "—"}
                      {h.withdrawn_by_name
                        ? ` · withdrawn by ${h.withdrawn_by_name}`
                        : ""}
                    </small>
                  </>
                ),
              },
              {
                key: "status",
                label: "Status",
                render: (h) => (
                  <span className={`badge plain ${statusNames[h.status][1]}`}>
                    {statusNames[h.status][0]}
                  </span>
                ),
              },
            ]}
          />
          <Pagination
            page={page}
            count={q.data.count}
            limit={q.data.limit}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
// Editing one role or department.
function DefaultDialog({ edit, onClose, onSaved }) {
  const { kind, row, remove } = edit;
  const name =
    kind === "role"
      ? `${roleLabel(row.role)} default`
      : `${row.name} department`;
  const path =
    kind === "role"
      ? `${base}/roles/${row.role}`
      : `${base}/departments/${row.id}`;
  // The form starts from the latest timing saved for it.
  const shown =
    [...row.planned].reverse().find((p) => !p.inherits) ||
    (row.current && !row.current.inherits ? row.current : null);
  return (
    <Modal
      title={remove ? `Remove the ${name} shift` : `${name} shift`}
      onClose={onClose}
      className="task-dialog shift-dialog"
    >
      <p className="shift-current">
        <strong>Now:</strong>{" "}
        {row.current && !row.current.inherits
          ? shiftLine(row.current)
          : kind === "role"
            ? "Follows the company default"
            : "Follows each member's role default"}
      </p>
      <ShiftTimingForm
        initial={shown}
        version={row.version}
        remove={remove}
        removeText={
          kind === "role"
            ? `From the chosen date, ${roleLabel(row.role).toLowerCase()} accounts without a department or individual timing follow the company default shift.`
            : `From the chosen date, ${row.name} employees without an individual timing follow their role default shift.`
        }
        submitLabel={remove ? "Remove timing" : "Save timing"}
        onCancel={onClose}
        onSave={async (body) => {
          await api(path, { method: "POST", body });
          onSaved(remove ? "Timing removed" : "Timing saved");
        }}
      />
    </Modal>
  );
}
// Editing one employee: their details, what they follow now, and their own
// timing (set, change or remove).
export function EmployeeShiftDialog({ id, onClose, onSaved }) {
  const [mode, setMode] = useState("edit");
  const q = useQuery({
    queryKey: ["shifts", "employee", id],
    queryFn: ({ signal }) => api(`${base}/employees/${id}`, { signal }),
  });
  const e = q.data;
  // The form starts from their latest individual timing; without one, from
  // what they follow now, unnamed.
  const own = e?.shifts?.find(
    (s) => !s.withdrawn_at && s.source === "individual",
  );
  const hasOwn =
    e?.shift?.source === "individual" ||
    e?.shifts?.some(
      (s) => s.upcoming && !s.withdrawn_at && s.source === "individual",
    );
  return (
    <Modal
      title={e ? `${e.name}'s office timing` : "Office timing"}
      onClose={onClose}
      className="task-dialog shift-dialog"
    >
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <dl className="task-facts">
            {[
              ["UID", e.uid],
              ["Role", roleLabel(e.role)],
              ["Department", e.department || "Not assigned"],
              ["Current schedule", <SourceBadge key="s" shift={e.shift} />],
              ["Office timing", shiftLine(e.shift)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {e.shift?.upcoming && (
            <p className="field-hint">
              From {fullDayLabel(e.shift.upcoming.effective_from)}:{" "}
              {sourceLabel(e.shift.upcoming)}, {shiftLine(e.shift.upcoming)}.
            </p>
          )}
          <Planned
            items={e.shifts
              ?.filter((s) => s.upcoming)
              .filter(
                (s, i, all) =>
                  all.findIndex(
                    (x) => x.effective_from === s.effective_from,
                  ) === i,
              )}
            path={`${base}/employees/${id}`}
            version={e.shift_version}
            label="Individual timing removed"
            onDone={() => onSaved("")}
          />
          {mode === "edit" ? (
            <>
              <h3>
                {hasOwn
                  ? "Change individual timing"
                  : "Set an individual timing"}
              </h3>
              <ShiftTimingForm
                key={e.shift_version}
                named
                initial={own || { ...e.shift, label: "" }}
                version={e.shift_version}
                submitLabel="Save"
                onCancel={onClose}
                onSave={async (body) => {
                  await api(`${base}/employees/${id}`, {
                    method: "POST",
                    body,
                  });
                  onSaved("Individual timing saved");
                }}
              />
              {hasOwn && (
                <Button
                  variant="secondary"
                  className="shift-remove"
                  onClick={() => setMode("remove")}
                >
                  Remove Individual Override
                </Button>
              )}
            </>
          ) : (
            <>
              <h3>Remove individual override</h3>
              <ShiftTimingForm
                key={`remove-${e.shift_version}`}
                remove
                version={e.shift_version}
                removeText={`From the chosen date, ${e.name} follows ${e.department ? `the ${e.department} department shift, or their role default if it has none` : "their role default shift, or the company default"}.`}
                submitLabel="Remove override"
                onCancel={() => setMode("edit")}
                onSave={async (body) => {
                  await api(`${base}/employees/${id}`, {
                    method: "POST",
                    body,
                  });
                  onSaved("Individual timing removed");
                }}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
export default function ShiftManagement({
  view,
  employee,
  onView,
  onEmployee,
}) {
  const toast = useToast(),
    refresh = useRefresh();
  const [edit, setEdit] = useState(null);
  const q = useQuery({
    queryKey: ["shifts", "overview"],
    queryFn: ({ signal }) => api(base, { signal }),
  });
  const current = shiftViews.some(([key]) => key === view) ? view : "roles";
  const done = (message) => {
    refresh();
    if (message) toast(message);
  };
  const handlers = {
    open: setEdit,
    done: () => done(""),
    employee: onEmployee,
  };
  return (
    <div className="shift-management">
      <div className="review-tabs" role="tablist" aria-label="Shift management">
        {shiftViews.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={current === key}
            className={current === key ? "active" : ""}
            onClick={() => onView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.data ? (
        <>
          {current === "roles" && (
            <RoleTimings data={q.data} onEdit={handlers} />
          )}
          {current === "departments" && (
            <DepartmentTimings data={q.data} onEdit={handlers} />
          )}
          {current === "individual" && (
            <IndividualTimings data={q.data} onEdit={handlers} />
          )}
          {current === "history" && <ShiftHistory />}
        </>
      ) : null}
      {edit && (
        <DefaultDialog
          edit={edit}
          onClose={() => setEdit(null)}
          onSaved={(message) => {
            setEdit(null);
            done(message);
          }}
        />
      )}
      {employee && (
        <EmployeeShiftDialog
          id={employee}
          onClose={() => onEmployee("")}
          onSaved={(message) => {
            if (message) onEmployee("");
            done(message);
          }}
        />
      )}
    </div>
  );
}
