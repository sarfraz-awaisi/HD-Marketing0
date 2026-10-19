import { useMemo } from "react";
import { todayPk } from "../../../lib/calendar";
import {
  todaySummary,
  useAttendanceOverview,
  useAttendancePolicy,
  useRegister,
} from "../../../lib/attendanceDashboard";
import AttendanceKpiStrip from "./AttendanceKpiStrip";
import AttendanceDistributionChart from "./AttendanceDistributionChart";
import AttendanceAttentionPanel from "./AttendanceAttentionPanel";
import LiveAttendanceRegister from "./LiveAttendanceRegister";
import WeeklyAttendanceChart from "./WeeklyAttendanceChart";
import MonthlyAttendanceInsights from "./MonthlyAttendanceInsights";
import { PanelError } from "./Skeleton";
// The command-center overview: headline figures, today's distribution,
// issues to act on, the live register and weekly/monthly trends.
export default function AttendanceOverview({ go, selected, openDrawer }) {
  const overview = useAttendanceOverview();
  const policy = useAttendancePolicy();
  // Today's full register feeds the attention panel (same request as the
  // live register's default view, so it is fetched once).
  const today = useRegister({ date: todayPk() });
  const summary = useMemo(() => todaySummary(overview.data), [overview.data]);
  const workDays = policy.data?.current?.work_days || [];
  const day = overview.data;
  return (
    <div className="cc-overview">
      {overview.error ? (
        <PanelError error={overview.error} onRetry={overview.refetch} />
      ) : (
        day &&
        !day.is_workday && (
          <p className="cc-banner">
            {day.holiday
              ? `Today is a company holiday: ${day.holiday}.`
              : "Today is a scheduled day off."}{" "}
            No check-in is expected.
          </p>
        )
      )}
      <AttendanceKpiStrip summary={summary} loading={overview.isPending} />
      <div className="cc-grid-two">
        <AttendanceDistributionChart
          summary={summary}
          overview={day}
          loading={overview.isPending}
          error={overview.error}
          onRetry={overview.refetch}
        />
        <AttendanceAttentionPanel
          overview={day}
          register={today.data}
          loading={overview.isPending || today.isPending}
          error={overview.error || today.error}
          onRetry={() => (overview.refetch(), today.refetch())}
          go={go}
          openEmployee={openDrawer}
        />
      </div>
      <LiveAttendanceRegister
        selected={selected}
        onSelect={openDrawer}
        go={go}
      />
      <div className="cc-grid-two">
        <WeeklyAttendanceChart workDays={workDays} go={go} />
        <MonthlyAttendanceInsights workDays={workDays} go={go} />
      </div>
    </div>
  );
}
