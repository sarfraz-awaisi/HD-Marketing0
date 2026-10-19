import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  Clock4,
  FileClock,
  UserX,
} from "lucide-react";
import { minutesLabel } from "../../../lib/attendance";
import { PanelError, PanelSkeleton } from "./Skeleton";
const names = (rows, max = 3) => {
  const list = rows
    .slice(0, max)
    .map((r) => r.name)
    .join(", ");
  return rows.length > max ? `${list} and ${rows.length - max} more` : list;
};
// Issues an administrator can act on today, built from today's register
// and the overview. Before the shift ends a missing check-in is "not checked
// in yet", never an absence.
export default function AttendanceAttentionPanel({
  overview,
  register,
  loading,
  error,
  onRetry,
  go,
  openEmployee,
}) {
  const rows = register?.data || [];
  const late = rows.filter((r) => r.punctuality === "late");
  const waiting = rows.filter((r) => r.state === "not_checked_in");
  const absent = rows.filter((r) => r.state === "absent");
  const items = [
    absent.length && {
      key: "absent",
      tone: "high",
      Icon: UserX,
      title: `${absent.length} absent today`,
      text: `${names(absent)} did not check in before the shift ended.`,
      action:
        absent.length === 1
          ? ["View employee", () => openEmployee(absent[0].user_id)]
          : ["Open register", () => go("daily")],
    },
    late.length && {
      key: "late",
      tone: "medium",
      Icon: Clock4,
      title: `${late.length} late arrival${late.length === 1 ? "" : "s"}`,
      text: late
        .slice(0, 3)
        .map((r) => `${r.name} (${minutesLabel(r.late_minutes)})`)
        .join(", "),
      action:
        late.length === 1
          ? ["View employee", () => openEmployee(late[0].user_id)]
          : ["Open register", () => go("daily")],
    },
    waiting.length && {
      key: "waiting",
      tone: "low",
      Icon: CalendarClock,
      title: `${waiting.length} not checked in yet`,
      text: `${names(waiting)}. The shift is still running.`,
      action: ["Open register", () => go("daily")],
    },
    overview?.incomplete_30_days && {
      key: "incomplete",
      tone: "medium",
      Icon: AlertTriangle,
      title: `${overview.incomplete_30_days} missing check-out${overview.incomplete_30_days === 1 ? "" : "s"}`,
      text: "In the last 30 days. Employees were asked to request a correction.",
      action: ["Review corrections", () => go("corrections")],
    },
    overview?.pending_leave && {
      key: "leave",
      tone: "low",
      Icon: ClipboardList,
      title: `${overview.pending_leave} leave request${overview.pending_leave === 1 ? "" : "s"} waiting`,
      text: "Approve or reject them in Leave requests.",
      action: ["Review leave", () => go("leave")],
    },
    overview?.pending_corrections && {
      key: "corrections",
      tone: "low",
      Icon: FileClock,
      title: `${overview.pending_corrections} correction${overview.pending_corrections === 1 ? "" : "s"} waiting`,
      text: "Check the proposed times before approving.",
      action: ["Review corrections", () => go("corrections")],
    },
  ].filter(Boolean);
  return (
    <section
      className="cc-card cc-attention"
      aria-labelledby="cc-attention-title"
    >
      <header className="cc-card-head">
        <h2 id="cc-attention-title">Needs attention</h2>
        {!loading && !error && (
          <small>
            {items.length
              ? `${items.length} item${items.length === 1 ? "" : "s"}`
              : "All clear"}
          </small>
        )}
      </header>
      {loading ? (
        <PanelSkeleton rows={4} />
      ) : error ? (
        <PanelError error={error} onRetry={onRetry} />
      ) : items.length ? (
        <ul className="cc-attention-list">
          {items.map(
            ({ key, tone, Icon, title, text, action: [label, onClick] }) => (
              <li key={key} className={`cc-attention-item ${tone}`}>
                <Icon size={18} aria-hidden="true" />
                <div>
                  <b>{title}</b>
                  <small>{text}</small>
                </div>
                <button type="button" className="text-button" onClick={onClick}>
                  {label}
                </button>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="cc-empty">Nothing needs your attention right now.</p>
      )}
    </section>
  );
}
