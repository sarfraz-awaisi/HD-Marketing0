import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { minutesLabel, percentLabel, stateInfo } from "../../lib/attendance";
import {
  addDays,
  addMonths,
  dayLabel,
  monthLabel,
  startOfMonth,
  startOfWeek,
  todayPk,
} from "../../lib/calendar";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Button, ErrorBox, Loader, Table } from "../common/UI";
import ExportButtons from "./ExportButtons";
// Short code per day for the breakdown grid.
const dayCode = {
  checked_out: ["P", "Present"],
  checked_in: ["P", "Present"],
  incomplete: ["I", "Incomplete"],
  absent: ["A", "Absent"],
  leave: ["LV", "Approved leave"],
  holiday: ["H", "Holiday"],
  day_off: ["–", "Day off"],
  not_checked_in: ["·", "Not checked in yet"],
  upcoming: ["", "Upcoming"],
  not_employed: ["", "Not active"],
  not_tracked: ["", "Not tracked"],
};
function DayCell({ d }) {
  const late = d.punctuality === "late";
  const [code, label] = dayCode[d.state] || ["?", d.state];
  return (
    <span
      className={`day-cell ${d.state}${late ? " late" : ""}`}
      title={`${dayLabel(d.date)}: ${late ? "Late · " : ""}${label}`}
      aria-label={`${dayLabel(d.date)}: ${late ? "Late, " : ""}${label}`}
    >
      {late ? "LT" : code}
    </span>
  );
}
function Bars({ title, rows, max, unit = "" }) {
  return (
    <section className="report-block">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((r) => (
          <div className="report-row" key={r.key}>
            <span>{r.label}</span>
            <span className="report-bar stacked" title={r.title}>
              {r.parts.map((part) => (
                <i
                  key={part.tone}
                  className={part.tone}
                  style={{ width: `${max ? (part.value / max) * 100 : 0}%` }}
                />
              ))}
            </span>
            <b>
              {r.total}
              {unit}
            </b>
          </div>
        ))
      ) : (
        <p className="empty">No employees in this period.</p>
      )}
    </section>
  );
}
// Weekly (Monday–Sunday) or monthly totals per employee, each day's state
// and charts. All numbers are calculated by the server from daily records.
export default function AdminPeriod({ mode, openEmployee }) {
  const [anchor, setAnchor] = useState(todayPk()),
    [search, setSearch] = useState(""),
    [role, setRole] = useState(""),
    [account, setAccount] = useState("");
  const term = useDebouncedValue(search.trim());
  const start = mode === "weekly" ? startOfWeek(anchor) : startOfMonth(anchor);
  const key =
    mode === "weekly" ? { week_start: start } : { month: start.slice(0, 7) };
  const filters = {
    ...key,
    ...(term ? { search: term } : {}),
    ...(role ? { role } : {}),
    ...(account ? { account } : {}),
  };
  const q = useQuery({
    queryKey: ["attendance-admin", mode, filters],
    queryFn: ({ signal }) =>
      api(`/admin/attendance/${mode}?` + new URLSearchParams(filters), {
        signal,
      }),
  });
  const move = (n) =>
    setAnchor(mode === "weekly" ? addDays(start, 7 * n) : addMonths(start, n));
  const employees = Array.isArray(q.data?.employees) ? q.data.employees : [];
  const trend = Array.isArray(q.data?.trend) ? q.data.trend : [];
  const title =
    mode === "weekly"
      ? `${dayLabel(start)} – ${dayLabel(addDays(start, 6))}`
      : monthLabel(start);
  const maxDays = Math.max(
    1,
    ...employees.map((e) => e.eligible_days + e.leave_days),
  );
  const maxLate = Math.max(1, ...employees.map((e) => e.late_days));
  const maxHours = Math.max(1, ...employees.map((e) => e.worked_minutes));
  const maxTrend = Math.max(
    1,
    ...trend.map((t) => t.present + t.absent + t.leave + t.incomplete),
  );
  return (
    <>
      <div className="attendance-toolbar">
        <div className="calendar-nav">
          <Button
            variant="secondary"
            aria-label={mode === "weekly" ? "Previous week" : "Previous month"}
            onClick={() => move(-1)}
          >
            ‹
          </Button>
          <input
            type={mode === "weekly" ? "date" : "month"}
            aria-label={mode === "weekly" ? "Week containing" : "Month"}
            value={mode === "weekly" ? start : start.slice(0, 7)}
            onChange={(e) =>
              e.target.value &&
              setAnchor(
                mode === "weekly" ? e.target.value : e.target.value + "-01",
              )
            }
          />
          <Button
            variant="secondary"
            aria-label={mode === "weekly" ? "Next week" : "Next month"}
            onClick={() => move(1)}
          >
            ›
          </Button>
          <h2>{title}</h2>
        </div>
        <ExportButtons
          params={{ type: mode, ...filters }}
          name={`hd-attendance-${mode === "weekly" ? "week-" + start : start.slice(0, 7)}`}
        />
      </div>
      <div className="toolbar">
        <input
          aria-label="Search employees"
          placeholder="Search by name or UID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">Admins and agents</option>
          <option value="agent">Agents</option>
          <option value="admin">Admins</option>
        </select>
        <select
          aria-label="Account status"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">Active and inactive</option>
          <option value="active">Active accounts</option>
          <option value="inactive">Inactive accounts</option>
        </select>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <>
          <Table
            rows={employees.map((e) => ({ ...e, id: e.user_id }))}
            columns={[
              {
                key: "name",
                label: "Employee",
                render: (e) => (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => openEmployee(e.user_id)}
                  >
                    <b>{e.name}</b>
                    <small>
                      {e.uid ? `UID ${e.uid} · ` : ""}
                      {e.role === "admin" ? "Admin" : "Agent"}
                      {!e.active && " · Inactive"}
                    </small>
                  </button>
                ),
              },
              { key: "scheduled_days", label: "Scheduled" },
              { key: "present_days", label: "Present" },
              { key: "absent_days", label: "Absent" },
              { key: "leave_days", label: "Leave" },
              { key: "late_days", label: "Late" },
              ...(mode === "monthly"
                ? [{ key: "within_grace_days", label: "Within grace" }]
                : []),
              { key: "incomplete_days", label: "Incomplete" },
              {
                key: "worked",
                label: "Worked",
                render: (e) => minutesLabel(e.worked_minutes),
              },
              ...(mode === "monthly"
                ? [
                    {
                      key: "average",
                      label: "Avg per day",
                      render: (e) =>
                        e.completed_days
                          ? minutesLabel(e.worked_minutes / e.completed_days)
                          : "—",
                    },
                  ]
                : []),
              {
                key: "early",
                label: "Left early",
                render: (e) => minutesLabel(e.early_departure_minutes),
              },
              {
                key: "overtime",
                label: "Overtime",
                render: (e) => minutesLabel(e.overtime_minutes),
              },
              {
                key: "attendance_percent",
                label: "Attendance",
                render: (e) => <b>{percentLabel(e.attendance_percent)}</b>,
              },
              ...(mode === "weekly"
                ? [
                    {
                      key: "days",
                      label: "Mon–Sun",
                      render: (e) => (
                        <span className="day-strip">
                          {(e.days || []).map((d) => (
                            <DayCell key={d.date} d={d} />
                          ))}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <p className="field-hint">
            Attendance is the share of eligible days with a completed or ongoing
            check-in. Eligible days are elapsed working days, not counting
            holidays or approved leave. Incomplete days count as not present
            until a correction is approved.
          </p>
          {mode === "monthly" && (
            <div className="report-blocks attendance-charts">
              <Bars
                title="Present and absent days"
                max={maxDays}
                rows={employees.map((e) => ({
                  key: e.user_id,
                  label: e.name,
                  total: `${e.present_days}/${e.eligible_days}`,
                  title: `${e.present_days} present, ${e.absent_days} absent, ${e.incomplete_days} incomplete, ${e.leave_days} leave`,
                  parts: [
                    { tone: "present", value: e.present_days },
                    { tone: "incomplete", value: e.incomplete_days },
                    { tone: "absent", value: e.absent_days },
                    { tone: "leave", value: e.leave_days },
                  ],
                }))}
              />
              <Bars
                title="Late arrivals"
                max={maxLate}
                rows={employees.map((e) => ({
                  key: e.user_id,
                  label: e.name,
                  total: e.late_days,
                  title: `${e.late_days} late arrivals`,
                  parts: [{ tone: "absent", value: e.late_days }],
                }))}
              />
              <Bars
                title="Worked hours"
                max={maxHours}
                unit=" h"
                rows={employees.map((e) => ({
                  key: e.user_id,
                  label: e.name,
                  total: Math.round(e.worked_minutes / 6) / 10,
                  title: minutesLabel(e.worked_minutes),
                  parts: [{ tone: "present", value: e.worked_minutes }],
                }))}
              />
              <section className="report-block trend-block">
                <h3>Daily trend</h3>
                <div
                  className="trend-chart"
                  role="img"
                  aria-label="Present, late and absent employees per day"
                >
                  {trend.map((t) => (
                    <span
                      key={t.date}
                      title={`${dayLabel(t.date)}: ${t.present} present (${t.late} late), ${t.absent} absent, ${t.leave} on leave`}
                    >
                      <i
                        className="absent"
                        style={{ height: `${(t.absent / maxTrend) * 100}%` }}
                      />
                      <i
                        className="incomplete"
                        style={{
                          height: `${(t.incomplete / maxTrend) * 100}%`,
                        }}
                      />
                      <i
                        className="present"
                        style={{ height: `${(t.present / maxTrend) * 100}%` }}
                      />
                      <small>{Number(t.date.slice(8))}</small>
                    </span>
                  ))}
                </div>
                <p className="chart-key">
                  <i className="present" /> Present <i className="incomplete" />{" "}
                  Incomplete <i className="absent" /> Absent
                </p>
              </section>
            </div>
          )}
          {mode === "weekly" && (
            <p className="chart-key">
              {Object.entries(dayCode)
                .filter(([key]) =>
                  [
                    "checked_out",
                    "absent",
                    "leave",
                    "holiday",
                    "incomplete",
                    "day_off",
                  ].includes(key),
                )
                .map(([key, [code, label]]) => (
                  <span key={key}>
                    <span className={`day-cell ${key}`}>{code}</span> {label}
                  </span>
                ))}
              <span>
                <span className="day-cell checked_out late">LT</span> Late
              </span>
              <span>{stateInfo.upcoming[0]} days are blank</span>
            </p>
          )}
        </>
      )}
    </>
  );
}
