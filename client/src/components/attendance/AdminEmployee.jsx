import { useEffect, useState } from "react";
import { roleLabel } from "../../lib/roles";
import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import {
  correctionTypeLabel,
  leaveTypeLabel,
  minutesLabel,
  percentLabel,
  pkTime,
} from "../../lib/attendance";
import { dayLabel, startOfMonth, todayPk } from "../../lib/calendar";
import { Button, ErrorBox, Loader, Table } from "../common/UI";
import { PunctualityBadge, RequestBadge, StateBadge } from "./Badges";
import { ManageDayDialog } from "./AttendanceManage";
// One employee's attendance over a date range. Update 089: Active
// employees and Inactive employees (disabled accounts, kept with their
// attendance history until their final salary is settled) are separate
// tabs; deleted accounts are never listed.
const groups = [
  ["active", "Active employees"],
  ["inactive", "Inactive employees"],
];
export default function AdminEmployee({ userId, onSelect }) {
  const today = todayPk();
  const [from, setFrom] = useState(startOfMonth(today)),
    [to, setTo] = useState(today),
    [managing, setManaging] = useState(null),
    [picked, setPicked] = useState(null);
  const people = useQuery({
    queryKey: ["attendance-admin", "employees"],
    queryFn: ({ signal }) => api("/admin/attendance/employees", { signal }),
  });
  const list = Array.isArray(people.data) ? people.data : [];
  const inGroup = (key) => list.filter((p) => p.active === (key === "active"));
  // The tab chosen, or else the one of the employee in the address.
  const current = list.find((p) => p.id === userId);
  const group = picked || (current && !current.active ? "inactive" : "active");
  const shown = inGroup(group);
  const chosen = shown.some((p) => p.id === userId) ? userId : null;
  const first = shown[0]?.id;
  useEffect(() => {
    if (!chosen && first) onSelect(first);
  }, [chosen, first, onSelect]);
  const q = useQuery({
    queryKey: ["attendance-admin", "employee", chosen, from, to],
    queryFn: ({ signal }) =>
      api(
        `/admin/attendance/employees/${chosen}?` +
          new URLSearchParams({ from, to }),
        { signal },
      ),
    enabled: Boolean(chosen) && from <= to,
  });
  const d = q.data,
    t = d?.totals || {};
  return (
    <>
      <div className="review-tabs" role="tablist" aria-label="Employees">
        {groups.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={group === key}
            className={group === key ? "active" : ""}
            onClick={() => setPicked(key)}
          >
            {label}
            {people.data && (
              <>
                {" "}
                <b>{inGroup(key).length}</b>
              </>
            )}
          </button>
        ))}
      </div>
      {group === "inactive" && (
        <p className="field-hint">
          Disabled accounts, with their attendance history kept for the final
          salary. Deleting an account removes the employee from Attendance
          Management.
        </p>
      )}
      {people.data && !shown.length && (
        <div className="empty">
          {group === "inactive"
            ? "No inactive employees. When an employee leaves, disable their account in Accounts to review their attendance here."
            : "No active employees with attendance yet."}
        </div>
      )}
      <div className="toolbar">
        {shown.length > 0 && (
          <select
            aria-label="Employee"
            value={chosen || ""}
            onChange={(e) => onSelect(e.target.value)}
          >
            {shown.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.uid ? ` · UID ${p.uid}` : ""}
              </option>
            ))}
          </select>
        )}
        <label>
          From
          <input
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
      </div>
      <ErrorBox
        error={
          people.error ||
          q.error ||
          (from > to && "The range must end on or after its start.")
        }
      />
      {q.isPending && chosen ? (
        <Loader variant="cards" />
      ) : d ? (
        <>
          <section className="panel attendance-profile">
            <h2>{d.employee.name}</h2>
            <p>
              {d.employee.uid ? `UID ${d.employee.uid} · ` : ""}
              {roleLabel(d.employee.role)}
              {d.employee.department
                ? ` · ${d.employee.department}`
                : ""} ·{" "}
              {d.employee.active ? "Active account" : "Inactive account"}
            </p>
            <p className="field-hint">
              Attendance counted:{" "}
              {(d.employee.periods || [])
                .map(
                  (p) =>
                    `${dayLabel(p.starts_on)} – ${p.ends_on ? dayLabel(p.ends_on) : "now"}`,
                )
                .join("; ") || "not yet"}
            </p>
            <div className="attendance-stats">
              {[
                ["Attendance", percentLabel(t.attendance_percent)],
                ["Present", t.present_days ?? 0],
                ["Absent", t.absent_days ?? 0],
                ["Late", t.late_days ?? 0],
                ["Within grace", t.within_grace_days ?? 0],
                ["Leave", t.leave_days ?? 0],
                ["Incomplete", t.incomplete_days ?? 0],
                ["Worked", minutesLabel(t.worked_minutes ?? 0)],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Daily record</h2>
            <Table
              rows={(d.days || []).map((x) => ({ ...x, id: x.day }))}
              columns={[
                { key: "day", label: "Date", render: (x) => dayLabel(x.day) },
                {
                  key: "state",
                  label: "State",
                  render: (x) => <StateBadge state={x.state} />,
                },
                {
                  key: "in",
                  label: "Check-in",
                  render: (x) => pkTime(x.check_in_at),
                },
                {
                  key: "out",
                  label: "Check-out",
                  render: (x) => pkTime(x.check_out_at),
                },
                {
                  key: "worked",
                  label: "Worked",
                  render: (x) => minutesLabel(x.worked_minutes),
                },
                {
                  key: "punctuality",
                  label: "Arrival",
                  render: (x) => (
                    <span>
                      <PunctualityBadge value={x.punctuality} />
                      {x.late_minutes > 0 && (
                        <small className="block-muted">
                          {x.late_minutes} min late
                        </small>
                      )}
                    </span>
                  ),
                },
                {
                  key: "notes",
                  label: "Notes",
                  render: (x) =>
                    [
                      x.corrected && "Corrected",
                      x.pending_correction && "Correction pending",
                      x.holiday,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—",
                },
                {
                  key: "manage",
                  label: "Actions",
                  render: (x) =>
                    x.day < today ? (
                      <Button
                        variant="secondary"
                        aria-label={`Manage ${dayLabel(x.day)}`}
                        onClick={() => setManaging(x.day)}
                      >
                        Manage
                      </Button>
                    ) : (
                      "—"
                    ),
                },
              ]}
            />
            {managing && (
              <ManageDayDialog
                userId={chosen}
                day={managing}
                name={d.employee.name}
                onClose={() => setManaging(null)}
              />
            )}
          </section>
          <div className="dashboard-grid">
            <section className="panel">
              <h2>Leave history</h2>
              <Table
                rows={d.leave || []}
                columns={[
                  {
                    key: "dates",
                    label: "Dates",
                    render: (l) =>
                      l.start_date === l.end_date
                        ? dayLabel(l.start_date)
                        : `${dayLabel(l.start_date)} – ${dayLabel(l.end_date)}`,
                  },
                  {
                    key: "type",
                    label: "Type",
                    render: (l) => leaveTypeLabel(l.leave_type),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (l) => <RequestBadge status={l.status} />,
                  },
                ]}
              />
            </section>
            <section className="panel">
              <h2>Corrections</h2>
              <Table
                rows={d.corrections || []}
                columns={[
                  {
                    key: "date",
                    label: "Date",
                    render: (c) => dayLabel(c.attendance_date),
                  },
                  {
                    key: "type",
                    label: "Correction",
                    render: (c) => correctionTypeLabel(c.correction_type),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (c) => <RequestBadge status={c.status} />,
                  },
                  {
                    key: "created",
                    label: "Requested",
                    render: (c) => date(c.created_at),
                  },
                ]}
              />
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
