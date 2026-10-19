import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dayLabel, startOfWeek, todayPk } from "../../../lib/calendar";
import { useWeekReport, weekSeries } from "../../../lib/attendanceDashboard";
import { PanelError, PanelSkeleton } from "./Skeleton";
// Present, incomplete, absent and leave per day from the weekly report.
// Late arrivals are shown separately because a late employee is present.
const parts = [
  ["present", "Present", "var(--att-present)"],
  ["incomplete", "Incomplete", "var(--att-incomplete)"],
  ["absent", "Absent", "var(--att-absent)"],
  ["leave", "Leave", "var(--att-leave)"],
];
export default function WeeklyAttendanceChart({ workDays, go }) {
  const [start, setStart] = useState(startOfWeek(todayPk()));
  const [focus, setFocus] = useState(null);
  const q = useWeekReport(start);
  const days = weekSeries(q.data?.trend, workDays);
  const max = Math.max(1, ...days.map((d) => d.total));
  const hasData = days.some((d) => d.total > 0);
  return (
    <section className="cc-card cc-weekly" aria-labelledby="cc-weekly-title">
      <header className="cc-card-head">
        <div>
          <h2 id="cc-weekly-title">Weekly trend</h2>
          <small>
            {dayLabel(start)} – {dayLabel(addDays(start, 6))}
          </small>
        </div>
        <span className="cc-stepper">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous week"
            onClick={() => setStart(addDays(start, -7))}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next week"
            disabled={start >= startOfWeek(todayPk())}
            onClick={() => setStart(addDays(start, 7))}
          >
            <ChevronRight size={18} />
          </button>
        </span>
      </header>
      {q.isPending ? (
        <PanelSkeleton rows={5} />
      ) : q.error ? (
        <PanelError error={q.error} onRetry={q.refetch} />
      ) : !hasData ? (
        <p className="cc-empty">No attendance recorded this week yet.</p>
      ) : (
        <>
          <ul className="cc-bars" aria-label="Attendance per day">
            {days.map((d, i) => {
              const label = `${dayLabel(d.date)}: ${
                d.dayOff
                  ? "scheduled day off"
                  : d.upcoming
                    ? "upcoming"
                    : `${d.present} present (${d.late} late), ${d.incomplete} incomplete, ${d.absent} absent, ${d.leave} on leave`
              }`;
              return (
                <li
                  key={d.date}
                  tabIndex={0}
                  aria-label={label}
                  onMouseEnter={() => setFocus(i)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(i)}
                  onBlur={() => setFocus(null)}
                  className={d.dayOff ? "off" : d.upcoming ? "upcoming" : ""}
                >
                  <span className="cc-bar" aria-hidden="true">
                    {parts.map(([key, , color]) =>
                      d[key] ? (
                        <i
                          key={key}
                          style={{
                            height: `${(d[key] / max) * 100}%`,
                            background: color,
                          }}
                        />
                      ) : null,
                    )}
                  </span>
                  {d.late > 0 && (
                    <span className="cc-late-dot" aria-hidden="true">
                      {d.late}
                    </span>
                  )}
                  <small aria-hidden="true">
                    {dayLabel(d.date).slice(0, 3)}
                  </small>
                  {focus === i && (
                    <span className="cc-tooltip" role="tooltip">
                      {label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="chart-key">
            {parts.map(([key, label, color]) => (
              <span key={key}>
                <i style={{ background: color }} /> {label}
              </span>
            ))}
            <span>
              <i className="cc-late-key" /> Late arrivals (number)
            </span>
          </p>
        </>
      )}
      <button
        type="button"
        className="text-button"
        onClick={() => go("weekly")}
      >
        Full weekly report <ChevronRight size={14} aria-hidden="true" />
      </button>
    </section>
  );
}
