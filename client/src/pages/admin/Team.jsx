import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  CalendarCheck,
  CalendarX,
  Clock3,
  UsersRound,
} from "lucide-react";
import { api } from "../../lib/api";
import { pkTime } from "../../lib/attendance";
import { percent } from "../../lib/tasks";
import { roleLabel } from "../../lib/roles";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { KpiTile } from "../../components/dashboard/Widgets";
import {
  Button,
  ErrorBox,
  Loader,
  Pagination,
  Table,
} from "../../components/common/UI";
import {
  PunctualityBadge,
  StateBadge,
} from "../../components/attendance/Badges";
import EmployeeDetail from "../../components/employees/EmployeeDetail";
import { shiftHours, sourceLabel } from "../../lib/shifts";
import Departments from "../../components/employees/Departments";
import "../../styles/dashboard.css";
import "../../styles/tasks.css";
import "../../styles/staff.css";
// Employee management (update 047, formerly the Team directory): every Admin,
// Agent and Staff account with department, job title, shift and today's
// attendance and tasks. Roles and access stay in Accounts.
const count = (n = 0, one) => `${n} ${n === 1 ? one : one + "s"}`;
const filtersFor = (f) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")),
  );
export default function Team() {
  const [page, setPage] = useState(1),
    [open, setOpen] = useState(null),
    [showDepartments, setShowDepartments] = useState(false);
  const [f, setF] = useState({
    search: "",
    role: "",
    department: "",
    account: "active",
    attendance: "",
    tasks: "",
  });
  const search = useDebouncedValue(f.search, 300);
  const params = filtersFor({ ...f, search: search.trim(), page });
  const q = useQuery({
    queryKey: ["employees", params.toString()],
    queryFn: ({ signal }) => api("/admin/employees?" + params, { signal }),
  });
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: ({ signal }) => api("/admin/departments", { signal }),
  });
  const set = (key) => (e) => {
    setF((v) => ({ ...v, [key]: e.target.value }));
    setPage(1);
  };
  const s = q.data?.summary || {};
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR PEOPLE, YOUR MOMENTUM</span>
          <h1>Employee management</h1>
          <p>
            Sales agents and office staff with their department, shift and
            today&apos;s attendance and tasks. Roles and access are managed in
            Accounts.
          </p>
        </div>
        <div className="actions">
          <Button variant="secondary" onClick={() => setShowDepartments(true)}>
            Departments
          </Button>
          <Link className="button" to="/accounts">
            Manage accounts
          </Link>
        </div>
      </div>
      <section className="kpi-grid task-kpis" aria-label="Today's team">
        <KpiTile
          label="Active employees"
          value={s.active ?? "—"}
          note={`${count(s.agents, "agent")} · ${s.staff ?? 0} staff · ${count(s.admins, "admin")}`}
          icon={UsersRound}
          tone="navy"
        />
        <KpiTile
          label="Present today"
          value={s.present ?? "—"}
          note={`${s.late ?? 0} late`}
          icon={CalendarCheck}
          tone="green"
        />
        <KpiTile
          label="Absent or on leave"
          value={(s.absent ?? 0) + (s.on_leave ?? 0)}
          note={`${s.absent ?? 0} absent · ${s.on_leave ?? 0} on leave`}
          icon={CalendarX}
          tone="gold"
        />
        <KpiTile
          label="Without a department"
          value={s.without_department ?? "—"}
          note="Assign one in the employee's details"
          icon={Briefcase}
          tone={s.without_department ? "gold" : "navy"}
        />
      </section>
      <section className="panel">
        <div className="toolbar task-filters employee-filters">
          <input
            type="search"
            aria-label="Search employees"
            placeholder="Search by name, email, UID or job title…"
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
            {(departments.data || []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value="none">No department</option>
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
          <select
            aria-label="Attendance today"
            value={f.attendance}
            onChange={set("attendance")}
          >
            <option value="">Any attendance</option>
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="not_checked_in">Not checked in</option>
            <option value="absent">Absent</option>
            <option value="leave">On leave</option>
            <option value="day_off">Day off</option>
          </select>
          <select
            aria-label="Tasks today"
            value={f.tasks}
            onChange={set("tasks")}
          >
            <option value="">Any tasks</option>
            <option value="incomplete">Tasks open</option>
            <option value="complete">All tasks done</option>
            <option value="none">No tasks</option>
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={q.data?.data || []}
            columns={[
              {
                key: "name",
                label: "Employee",
                render: (r) => (
                  <>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setOpen(r.id)}
                    >
                      {r.name}
                    </button>
                    <small className="employee-sub">
                      UID {r.uid}
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
                render: (r) => (
                  <>
                    {r.department || "—"}
                    {r.job_title && (
                      <small className="employee-sub">{r.job_title}</small>
                    )}
                  </>
                ),
              },
              {
                key: "shift",
                label: "Office timing",
                render: (r) => (
                  <>
                    <small>
                      <Clock3 size={13} aria-hidden="true" />{" "}
                      {shiftHours(r.shift)}
                    </small>
                    <small className="employee-sub">
                      {sourceLabel(r.shift)}
                    </small>
                  </>
                ),
              },
              {
                key: "attendance_state",
                label: "Today",
                render: (r) => (
                  <>
                    <StateBadge state={r.attendance_state} />{" "}
                    {r.punctuality && (
                      <PunctualityBadge value={r.punctuality} />
                    )}
                    {r.check_in_at && (
                      <small className="employee-sub">
                        In {pkTime(r.check_in_at)}
                        {r.check_out_at
                          ? ` · out ${pkTime(r.check_out_at)}`
                          : ""}
                      </small>
                    )}
                  </>
                ),
              },
              {
                key: "tasks",
                label: "Tasks today",
                render: (r) =>
                  r.tasks ? (
                    <>
                      {r.completed} of {r.tasks} done ·{" "}
                      {percent(r.task_percent)}
                      <small className="employee-sub">
                        Report {r.report_submitted ? "submitted" : "not yet"}
                      </small>
                    </>
                  ) : (
                    "No tasks"
                  ),
              },
            ]}
          />
        )}
        <Pagination page={page} count={q.data?.count} onPage={setPage} />
      </section>
      {open && (
        <EmployeeDetail
          id={open}
          departments={departments.data || []}
          onClose={() => setOpen(null)}
        />
      )}
      {showDepartments && (
        <Departments
          departments={departments.data || []}
          onClose={() => setShowDepartments(false)}
        />
      )}
    </>
  );
}
