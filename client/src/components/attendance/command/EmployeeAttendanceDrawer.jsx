import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { minutesLabel, percentLabel, pkTime } from "../../../lib/attendance";
import { addDays, dayLabel, todayPk } from "../../../lib/calendar";
import { Button, Modal } from "../../common/UI";
import { PunctualityBadge, StateBadge } from "../Badges";
import { PanelError, PanelSkeleton } from "./Skeleton";
// Read-only side panel: today and the last two weeks for one employee, from
// the existing employee history API.
export default function EmployeeAttendanceDrawer({
  userId,
  onClose,
  onOpenHistory,
}) {
  const to = todayPk(),
    from = addDays(to, -13);
  const q = useQuery({
    queryKey: ["attendance-admin", "employee", userId, from, to],
    queryFn: ({ signal }) =>
      api(
        `/admin/attendance/employees/${userId}?` +
          new URLSearchParams({ from, to }),
        { signal },
      ),
  });
  const d = q.data;
  const today = d?.days?.find((x) => x.day === to);
  return (
    <Modal
      className="cc-drawer"
      title={d?.employee?.name || "Employee attendance"}
      onClose={onClose}
    >
      {q.isPending ? (
        <PanelSkeleton rows={6} />
      ) : q.error ? (
        <PanelError error={q.error} onRetry={q.refetch} />
      ) : (
        <>
          <p className="cc-drawer-meta">
            {d.employee.uid ? `UID ${d.employee.uid} · ` : ""}
            {d.employee.role === "admin" ? "Admin" : "Agent"} ·{" "}
            {d.employee.active ? "Active account" : "Inactive account"}
          </p>
          <section className="cc-drawer-today" aria-label="Today">
            <div>
              <small>Today</small>
              {today ? (
                <StateBadge state={today.state} />
              ) : (
                <span>Not scheduled</span>
              )}
            </div>
            <dl>
              {[
                ["Check-in", pkTime(today?.check_in_at)],
                ["Check-out", pkTime(today?.check_out_at)],
                ["Worked", minutesLabel(today?.worked_minutes)],
                [
                  "Arrival",
                  <PunctualityBadge key="p" value={today?.punctuality} />,
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <p className="cc-drawer-total">
            Last 14 days: <b>{percentLabel(d.totals?.attendance_percent)}</b>{" "}
            attendance · {d.totals?.present_days ?? 0} present ·{" "}
            {d.totals?.late_days ?? 0} late · {d.totals?.absent_days ?? 0}{" "}
            absent
          </p>
          <ol className="cc-drawer-days">
            {(d.days || []).map((x) => (
              <li key={x.day}>
                <span>{dayLabel(x.day)}</span>
                <StateBadge state={x.state} />
                <small>
                  {!x.check_in_at
                    ? ""
                    : x.check_out_at
                      ? `${pkTime(x.check_in_at)} – ${pkTime(x.check_out_at)}`
                      : `In at ${pkTime(x.check_in_at)}`}
                </small>
              </li>
            ))}
          </ol>
          <footer>
            <Button onClick={() => onOpenHistory(userId)}>
              Full employee history
            </Button>
          </footer>
        </>
      )}
    </Modal>
  );
}
