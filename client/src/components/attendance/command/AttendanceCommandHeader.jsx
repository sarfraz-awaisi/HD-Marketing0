import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { clockLabel } from "../../../lib/attendance";
import { fullDayLabel, todayPk } from "../../../lib/calendar";
import {
  useAttendancePolicy,
  workDayRange,
} from "../../../lib/attendanceDashboard";
import { Button } from "../../common/UI";
import ExportButtons from "../ExportButtons";
// Page header: title, today's date, the current policy (from settings), a
// refresh for every attendance panel and an export of today's register.
export default function AttendanceCommandHeader() {
  const qc = useQueryClient();
  const policy = useAttendancePolicy();
  const fetching = useIsFetching({ queryKey: ["attendance-admin"] }) > 0;
  const today = todayPk();
  const current = policy.data?.current;
  return (
    <header className="cc-header">
      <div className="cc-title">
        <span className="eyebrow">TEAM ATTENDANCE</span>
        <h1>Attendance Command Center</h1>
        <p>Monitor daily attendance, employee activity, and team trends.</p>
        <p className="cc-policy" aria-live="polite">
          {current
            ? `${clockLabel(current.shift_start.slice(0, 5))} – ${clockLabel(current.shift_end.slice(0, 5))} | ${workDayRange(current.work_days)} | ${current.grace_minutes}-minute grace`
            : policy.isPending
              ? "Loading attendance rules…"
              : "Attendance rules unavailable"}
        </p>
      </div>
      <div className="cc-actions">
        <span className="cc-date">
          <small>Today · Pakistan time</small>
          <b>{fullDayLabel(today)}</b>
        </span>
        <Button
          variant="secondary"
          className="cc-refresh"
          aria-label="Refresh attendance"
          disabled={fetching}
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["attendance-admin"] })
          }
        >
          <RefreshCw size={16} className={fetching ? "spinning" : ""} />
          {fetching ? "Refreshing…" : "Refresh"}
        </Button>
        <ExportButtons
          params={{ type: "daily", date: today }}
          name={`hd-attendance-${today}`}
        />
      </div>
    </header>
  );
}
