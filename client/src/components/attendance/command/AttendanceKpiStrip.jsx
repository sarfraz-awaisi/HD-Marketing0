import { CalendarOff, CheckCircle2, Clock4, LogIn, Users } from "lucide-react";
import { Skeleton } from "./Skeleton";
// Five headline figures. They are mutually exclusive states except
// "Expected", which is their total (leave excluded).
export default function AttendanceKpiStrip({ summary, loading }) {
  const items = [
    [
      "expected",
      "Expected today",
      summary?.expected,
      Users,
      "Scheduled to work today and not on approved leave.",
    ],
    [
      "working",
      "Working now",
      summary?.working,
      LogIn,
      "Checked in and not yet checked out.",
    ],
    [
      "completed",
      "Checked out",
      summary?.completed,
      CheckCircle2,
      "Completed today's attendance.",
    ],
    [
      "waiting",
      "Not checked in",
      summary?.waiting,
      Clock4,
      "Expected today with no check-in yet. Counted as absent only after the shift ends.",
    ],
    ["leave", "On leave", summary?.leave, CalendarOff, "Approved leave today."],
  ];
  return (
    <dl className="cc-kpis" aria-busy={loading || undefined}>
      {items.map(([key, label, value, Icon, help]) => (
        <div key={key} className={`cc-kpi ${key}`} title={help}>
          <dt>
            <Icon size={16} aria-hidden="true" />
            {label}
            <span className="visually-hidden">: {help}</span>
          </dt>
          <dd>{loading ? <Skeleton width="2.5ch" /> : value}</dd>
        </div>
      ))}
    </dl>
  );
}
