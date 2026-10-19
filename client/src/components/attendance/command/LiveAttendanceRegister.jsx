import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { minutesLabel, pkTime, stateInfo } from "../../../lib/attendance";
import { addDays, fullDayLabel, todayPk } from "../../../lib/calendar";
import { registerLimit, useRegister } from "../../../lib/attendanceDashboard";
import { useDebouncedValue } from "../../../lib/useDebouncedValue";
import { Button, Pagination } from "../../common/UI";
import { PunctualityBadge, StateBadge } from "../Badges";
import { PanelError, PanelSkeleton } from "./Skeleton";
const pageSize = 10;
// Everyone expected on the chosen date (including those with no record),
// from the existing daily register API. Filters run on the server; the
// rows are paged here.
export default function LiveAttendanceRegister({ selected, onSelect, go }) {
  const today = todayPk();
  const [day, setDay] = useState(today),
    [search, setSearch] = useState(""),
    [role, setRole] = useState(""),
    [state, setState] = useState(""),
    [page, setPage] = useState(1);
  const term = useDebouncedValue(search.trim());
  const filters = {
    date: day,
    ...(term ? { search: term } : {}),
    ...(role ? { role } : {}),
    ...(state ? { state } : {}),
  };
  const q = useRegister(filters);
  const rows = useMemo(() => q.data?.data || [], [q.data]);
  const shown = rows.slice((page - 1) * pageSize, page * pageSize);
  const update = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };
  return (
    <section
      className="cc-card cc-register"
      aria-labelledby="cc-register-title"
    >
      <header className="cc-card-head">
        <div>
          <h2 id="cc-register-title">Live attendance</h2>
          <small>
            {day === today ? "Today" : fullDayLabel(day)} · everyone expected,
            including those not checked in
          </small>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => go("daily")}
        >
          Full daily register <ChevronRight size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="cc-filters">
        <input
          aria-label="Search employees"
          placeholder="Search name or UID…"
          value={search}
          onChange={update(setSearch)}
        />
        <select aria-label="Role" value={role} onChange={update(setRole)}>
          <option value="">All roles</option>
          <option value="agent">Agents</option>
          <option value="admin">Admins</option>
        </select>
        <select
          aria-label="Attendance status"
          value={state}
          onChange={update(setState)}
        >
          <option value="">All statuses</option>
          {[
            "checked_in",
            "checked_out",
            "not_checked_in",
            "absent",
            "incomplete",
            "leave",
            "holiday",
            "day_off",
          ].map((key) => (
            <option key={key} value={key}>
              {stateInfo[key][0]}
            </option>
          ))}
        </select>
        <span className="cc-date-picker">
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
            max={addDays(today, 31)}
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
        </span>
      </div>
      {q.isPending ? (
        <PanelSkeleton rows={6} />
      ) : q.error ? (
        <PanelError error={q.error} onRetry={q.refetch} />
      ) : !rows.length ? (
        <p className="cc-empty">
          {term || role || state
            ? "No employees match these filters."
            : "Nobody is expected on this date."}
        </p>
      ) : (
        <>
          <div
            className="cc-table-wrap"
            role="region"
            aria-label="Live attendance"
            tabIndex={0}
          >
            <table className="cc-table">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Check-in</th>
                  <th scope="col">Check-out</th>
                  <th scope="col" className="cc-col-worked">
                    Worked
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Arrival</th>
                  <th scope="col">
                    <span className="visually-hidden">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.user_id}
                    className={selected === r.user_id ? "selected" : ""}
                  >
                    <th scope="row" data-label="Employee">
                      <span className="cc-person">
                        <span className="cc-avatar" aria-hidden="true">
                          {r.name.charAt(0)}
                        </span>
                        <span>
                          <b>{r.name}</b>
                          <small>
                            {r.uid ? `UID ${r.uid} · ` : ""}
                            {r.role === "admin" ? "Admin" : "Agent"}
                            {!r.account_active && " · Inactive"}
                          </small>
                        </span>
                      </span>
                    </th>
                    <td data-label="Check-in">{pkTime(r.check_in_at)}</td>
                    <td data-label="Check-out">{pkTime(r.check_out_at)}</td>
                    <td data-label="Worked" className="cc-col-worked">
                      {minutesLabel(r.worked_minutes)}
                    </td>
                    <td data-label="Status">
                      <StateBadge state={r.state} />
                    </td>
                    <td data-label="Arrival">
                      <PunctualityBadge value={r.punctuality} />
                      {r.late_minutes > 0 && (
                        <small className="block-muted">
                          {r.late_minutes} min late
                        </small>
                      )}
                    </td>
                    <td data-label="Details" className="cc-row-action">
                      <Button
                        variant="secondary"
                        aria-label={`View ${r.name}`}
                        onClick={() => onSelect(r.user_id)}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > pageSize && (
            <Pagination
              page={page}
              count={rows.length}
              limit={pageSize}
              onPage={setPage}
            />
          )}
          {q.data.count > registerLimit && (
            <p className="cc-footnote">
              Showing the first {registerLimit} of {q.data.count}. Use the full
              daily register for everyone.
            </p>
          )}
        </>
      )}
    </section>
  );
}
