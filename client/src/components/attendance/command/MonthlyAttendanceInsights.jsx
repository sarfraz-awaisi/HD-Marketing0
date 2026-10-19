import { ChevronRight } from "lucide-react";
import { minutesLabel, percentLabel } from "../../../lib/attendance";
import { dayLabel, monthLabel, todayPk } from "../../../lib/calendar";
import {
  currentMonth,
  monthGrid,
  monthTotals,
  useMonthReport,
} from "../../../lib/attendanceDashboard";
import { PanelError, PanelSkeleton } from "./Skeleton";
// This month from the monthly report: team totals (sums of each employee's
// server totals) and a calendar coloured by the share present each day.
export default function MonthlyAttendanceInsights({ workDays, go }) {
  const month = currentMonth();
  const q = useMonthReport(month);
  const totals = monthTotals(q.data?.employees);
  const cells = monthGrid(month, q.data?.trend);
  const today = todayPk();
  const weekday = (day) => {
    const n = new Date(day + "T00:00:00Z").getUTCDay();
    return n === 0 ? 7 : n;
  };
  return (
    <section className="cc-card cc-monthly" aria-labelledby="cc-monthly-title">
      <header className="cc-card-head">
        <div>
          <h2 id="cc-monthly-title">{monthLabel(`${month}-01`)}</h2>
          <small>Team attendance this month</small>
        </div>
      </header>
      {q.isPending ? (
        <PanelSkeleton rows={5} />
      ) : q.error ? (
        <PanelError error={q.error} onRetry={q.refetch} />
      ) : (
        <div className="cc-monthly-body">
          <div className="cc-month-score">
            <b>{percentLabel(totals.percent)}</b>
            <small>
              {totals.present} present of {totals.eligible} eligible days
            </small>
          </div>
          <ul className="cc-month-facts">
            <li>
              <span>Absent days</span>
              <b>{totals.absent}</b>
            </li>
            <li>
              <span>Late arrivals</span>
              <b>{totals.late}</b>
            </li>
            <li>
              <span>Approved leave</span>
              <b>{totals.leave}</b>
            </li>
            <li>
              <span>Incomplete</span>
              <b>{totals.incomplete}</b>
            </li>
            <li>
              <span>Hours worked</span>
              <b>{minutesLabel(totals.worked)}</b>
            </li>
          </ul>
          <div
            className="cc-heatmap"
            role="list"
            aria-label="Share of expected employees present each day"
          >
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <span key={i} className="cc-heat-head" aria-hidden="true">
                {d}
              </span>
            ))}
            {cells.map((c) => {
              if (!c.date)
                return (
                  <span
                    key={c.key}
                    className="cc-heat blank"
                    aria-hidden="true"
                  />
                );
              const off =
                workDays?.length && !workDays.includes(weekday(c.date));
              const counted =
                (c.present || 0) + (c.absent || 0) + (c.incomplete || 0);
              const share = counted ? c.present / counted : null;
              const future = c.date > today;
              const level =
                future || off || share == null
                  ? "none"
                  : share >= 0.9
                    ? "high"
                    : share >= 0.6
                      ? "mid"
                      : "low";
              return (
                <span
                  key={c.key}
                  role="listitem"
                  className={`cc-heat ${level}${off ? " off" : ""}`}
                  title={`${dayLabel(c.date)}: ${off ? "day off" : future ? "upcoming" : share == null ? "no attendance expected" : `${c.present} present, ${c.absent} absent`}`}
                  aria-label={`${dayLabel(c.date)}: ${off ? "day off" : future ? "upcoming" : share == null ? "no attendance expected" : `${c.present} present, ${c.absent} absent`}`}
                >
                  {Number(c.date.slice(8))}
                </span>
              );
            })}
          </div>
          <p className="chart-key">
            <span>
              <i className="cc-heat-key high" /> 90%+ present
            </span>
            <span>
              <i className="cc-heat-key mid" /> 60–89%
            </span>
            <span>
              <i className="cc-heat-key low" /> under 60%
            </span>
          </p>
        </div>
      )}
      <button
        type="button"
        className="text-button"
        onClick={() => go("monthly")}
      >
        Full monthly report <ChevronRight size={14} aria-hidden="true" />
      </button>
    </section>
  );
}
