import { useEffect, useState } from "react";
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
import { ErrorBox, Loader, Table } from "../common/UI";
import { PunctualityBadge, RequestBadge, StateBadge } from "./Badges";
// One employee's attendance over a date range, including disabled accounts.
export default function AdminEmployee({ userId, onSelect }) {
  const today = todayPk();
  const [from, setFrom] = useState(startOfMonth(today)),
    [to, setTo] = useState(today);
  const people = useQuery({
    queryKey: ["attendance-admin", "employees"],
    queryFn: ({ signal }) => api("/admin/attendance/employees", { signal }),
  });
  const list = Array.isArray(people.data) ? people.data : [];
  useEffect(() => {
    if (!userId && list[0]) onSelect(list[0].id);
  }, [userId, list, onSelect]);
  const q = useQuery({
    queryKey: ["attendance-admin", "employee", userId, from, to],
    queryFn: ({ signal }) =>
      api(
        `/admin/attendance/employees/${userId}?` +
          new URLSearchParams({ from, to }),
        { signal },
      ),
    enabled: Boolean(userId) && from <= to,
  });
  const d = q.data,
    t = d?.totals || {};
  return (
    <>
      <div className="toolbar">
        <select
          aria-label="Employee"
          value={userId || ""}
          onChange={(e) => onSelect(e.target.value)}
        >
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.uid ? ` · UID ${p.uid}` : ""}
              {p.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
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
      {q.isPending && userId ? (
        <Loader />
      ) : d ? (
        <>
          <section className="panel attendance-profile">
            <h2>{d.employee.name}</h2>
            <p>
              {d.employee.uid ? `UID ${d.employee.uid} · ` : ""}
              {d.employee.role === "admin" ? "Admin" : "Agent"} ·{" "}
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
              ]}
            />
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
      ) : (
        !people.isPending &&
        !list.length && <div className="empty">No employees yet.</div>
      )}
    </>
  );
}
