import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  clockLabel,
  leaveTypeLabel,
  minutesLabel,
  pkTime,
  stateInfo,
  punctualityInfo,
} from "../../lib/attendance";
import { addDays, fullDayLabel, todayPk } from "../../lib/calendar";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Button, ErrorBox, Loader, Pagination, Table } from "../common/UI";
import { PunctualityBadge, StateBadge } from "./Badges";
import ExportButtons from "./ExportButtons";
// Everyone expected on a date, including those with no record (absent, on
// leave, not yet checked in), never only those who checked in.
export default function AdminDaily({ openEmployee }) {
  const [day, setDay] = useState(todayPk()),
    [search, setSearch] = useState(""),
    [role, setRole] = useState(""),
    [state, setState] = useState(""),
    [punctuality, setPunctuality] = useState(""),
    [account, setAccount] = useState(""),
    [page, setPage] = useState(1);
  const term = useDebouncedValue(search.trim());
  const filters = {
    date: day,
    ...(term ? { search: term } : {}),
    ...(role ? { role } : {}),
    ...(state ? { state } : {}),
    ...(punctuality ? { punctuality } : {}),
    ...(account ? { account } : {}),
  };
  const q = useQuery({
    queryKey: ["attendance-admin", "daily", filters, page],
    queryFn: ({ signal }) =>
      api(
        "/admin/attendance/daily?" +
          new URLSearchParams({ ...filters, page, limit: 25 }),
        { signal },
      ),
  });
  const reset = (fn) => (e) => {
    fn(e.target.value);
    setPage(1);
  };
  const summary = q.data?.summary || {};
  return (
    <>
      <div className="attendance-toolbar">
        <div className="calendar-nav">
          <Button
            variant="secondary"
            aria-label="Previous day"
            onClick={() => (setDay(addDays(day, -1)), setPage(1))}
          >
            ‹
          </Button>
          <input
            type="date"
            aria-label="Register date"
            value={day}
            onChange={(e) =>
              e.target.value && (setDay(e.target.value), setPage(1))
            }
          />
          <Button
            variant="secondary"
            aria-label="Next day"
            onClick={() => (setDay(addDays(day, 1)), setPage(1))}
          >
            ›
          </Button>
          <h2>{fullDayLabel(day)}</h2>
        </div>
        <ExportButtons
          params={{ type: "daily", ...filters }}
          name={`hd-attendance-${day}`}
        />
      </div>
      <div className="toolbar">
        <input
          aria-label="Search employees"
          placeholder="Search by name or UID…"
          value={search}
          onChange={reset(setSearch)}
        />
        <select aria-label="Role" value={role} onChange={reset(setRole)}>
          <option value="">Admins and agents</option>
          <option value="agent">Agents</option>
          <option value="admin">Admins</option>
        </select>
        <select
          aria-label="Attendance state"
          value={state}
          onChange={reset(setState)}
        >
          <option value="">All states</option>
          {Object.entries(stateInfo)
            .filter(
              ([key]) =>
                !["upcoming", "not_tracked", "not_employed"].includes(key),
            )
            .map(([key, [label]]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
        <select
          aria-label="Punctuality"
          value={punctuality}
          onChange={reset(setPunctuality)}
        >
          <option value="">Any arrival</option>
          {Object.entries(punctualityInfo).map(([key, [label]]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Account status"
          value={account}
          onChange={reset(setAccount)}
        >
          <option value="">Active and inactive</option>
          <option value="active">Active accounts</option>
          <option value="inactive">Inactive accounts</option>
        </select>
      </div>
      {q.data && (
        <p className="period-label">
          {summary.total ?? 0} employees ·{" "}
          {Object.entries(summary.states || {})
            .map(([key, n]) => `${stateInfo[key]?.[0] || key}: ${n}`)
            .join(" · ") || "No employees expected"}
        </p>
      )}
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <>
          <Table
            rows={(q.data.data || []).map((r) => ({ ...r, id: r.user_id }))}
            columns={[
              {
                key: "name",
                label: "Employee",
                render: (r) => (
                  <span className="attendance-person">
                    <b>{r.name}</b>
                    <small>
                      {r.uid ? `UID ${r.uid} · ` : ""}
                      {r.role === "admin" ? "Admin" : "Agent"}
                      {!r.account_active && " · Inactive"}
                    </small>
                  </span>
                ),
              },
              {
                key: "shift",
                label: "Shift",
                render: (r) =>
                  r.shift_start
                    ? `${clockLabel(r.shift_start.slice(0, 5))} – ${clockLabel(r.shift_end.slice(0, 5))}`
                    : "—",
              },
              {
                key: "check_in_at",
                label: "Check-in",
                render: (r) => pkTime(r.check_in_at),
              },
              {
                key: "check_out_at",
                label: "Check-out",
                render: (r) => pkTime(r.check_out_at),
              },
              {
                key: "worked",
                label: "Worked",
                render: (r) => minutesLabel(r.worked_minutes),
              },
              {
                key: "late",
                label: "Late",
                render: (r) =>
                  r.punctuality ? minutesLabel(r.late_minutes) : "—",
              },
              {
                key: "punctuality",
                label: "Punctuality",
                render: (r) => <PunctualityBadge value={r.punctuality} />,
              },
              {
                key: "early",
                label: "Left early",
                render: (r) =>
                  r.early_departure_minutes
                    ? minutesLabel(r.early_departure_minutes)
                    : "—",
              },
              {
                key: "overtime",
                label: "Overtime",
                render: (r) =>
                  r.overtime_minutes ? minutesLabel(r.overtime_minutes) : "—",
              },
              {
                key: "state",
                label: "State",
                render: (r) => (
                  <span className="attendance-state-cell">
                    <StateBadge state={r.state} />
                    {r.leave_type && r.state !== "leave" && (
                      <small>Leave: {leaveTypeLabel(r.leave_type)}</small>
                    )}
                    {r.pending_correction && <small>Correction pending</small>}
                    {r.corrected && <small>Corrected</small>}
                  </span>
                ),
              },
              {
                key: "view",
                label: "Details",
                render: (r) => (
                  <Button
                    variant="secondary"
                    onClick={() => openEmployee(r.user_id)}
                  >
                    View
                  </Button>
                ),
              },
            ]}
          />
          <Pagination
            page={page}
            count={q.data.count}
            limit={25}
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}
