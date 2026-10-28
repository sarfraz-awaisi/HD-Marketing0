import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Building2,
  CalendarCheck,
  CalendarDays,
  Clock,
  ListChecks,
  LogOut,
  PhoneMissed,
  PhoneOutgoing,
  Repeat,
  Trophy,
  UserPlus,
} from "lucide-react";
import { api, pkr } from "../../lib/api";
import { statusLabel, statuses } from "../../lib/pipeline";
// Compact figure tile: label and icon on top, the value, then a short note.
export function KpiTile({ label, value, note, icon: Icon, tone = "gold", to }) {
  const body = (
    <>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {Icon && (
          <span className={`kpi-icon ${tone}`} aria-hidden="true">
            <Icon size={17} />
          </span>
        )}
      </div>
      <strong className="kpi-value">{value ?? "—"}</strong>
      {note && <small className="kpi-note">{note}</small>}
    </>
  );
  return to ? (
    <Link className="kpi fx-card" to={to}>
      {body}
    </Link>
  ) : (
    <section className="kpi fx-card">{body}</section>
  );
}
// Circular percentage gauge; the number is also written out for readers.
export function RingProgress({ value, size = 64, label }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const r = 26,
    c = 2 * Math.PI * r;
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={label || `${Math.round(pct)}%`}
    >
      <circle className="ring-track" cx="32" cy="32" r={r} />
      <circle
        className="ring-value fx-ring"
        cx="32"
        cy="32"
        r={r}
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}
// Navy highlight card: the month's closed business and the pipeline shape.
export function MonthHighlight({ metrics, admin }) {
  const d = metrics || {};
  const counts = statuses.map((s) => [s, d.by_status?.[s] || 0]);
  const top = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <section className="dash-feature" aria-labelledby="month-highlight-title">
      <div className="dash-feature-head">
        <h2 id="month-highlight-title">
          {admin ? "Business this month" : "My month so far"}
        </h2>
        <Trophy size={18} aria-hidden="true" />
      </div>
      <dl className="dash-feature-figures">
        <div className="dash-feature-main">
          <dt>Closed revenue</dt>
          <dd>{pkr(d.revenue)}</dd>
        </div>
        <div>
          <dt>Won deals</dt>
          <dd className="gold">{d.won_deals ?? 0}</dd>
        </div>
        <div>
          <dt>Upcoming visits</dt>
          <dd>{d.scheduled_visits ?? 0}</dd>
        </div>
      </dl>
      <div className="dash-feature-chart">
        <span className="dash-feature-caption">Leads by stage</span>
        <ol className="stage-bars" aria-label="Leads by stage">
          {counts.map(([status, n]) => (
            <li
              key={status}
              data-stage={status}
              title={`${statusLabel(status)}: ${n}`}
            >
              <span
                className="stage-bar fx-bar"
                style={{ height: `${Math.max(4, (n / top) * 100)}%` }}
              />
              <span className="visually-hidden">
                {statusLabel(status)}: {n}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
// One icon per notification type (updates 038, 040, 044 and 045).
const noticeIcons = {
  task_assigned: ListChecks,
  task_updated: ListChecks,
  task_cancelled: ListChecks,
  task_report: ListChecks,
  task_report_reviewed: ListChecks,
  checkout_request: LogOut,
  checkout_decision: LogOut,
  property_source_updated: Building2,
  property_source_removed: Building2,
  lead_assigned: UserPlus,
  lead_moved_away: Repeat,
  lead_kept: UserPlus,
  first_call_missed: PhoneMissed,
  missed_calls_review: PhoneMissed,
  calls_due_soon: PhoneOutgoing,
  daily_call_summary: PhoneOutgoing,
  followup_due: Clock,
  visit_tomorrow: CalendarDays,
  attendance_request: CalendarCheck,
  attendance_review: CalendarCheck,
  attendance_incomplete: CalendarCheck,
  attendance_summary: CalendarCheck,
};
const noticeIcon = (type) => noticeIcons[type] || Bell;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function timeAgo(value, now = Date.now()) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (!Number.isFinite(seconds)) return "";
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (Math.abs(seconds) >= size)
      return relative.format(Math.round(seconds / size), unit);
  return "just now";
}
// The signed-in person's latest notifications, from the same query the bell
// uses, so this panel adds no extra request.
export function RecentActivity({ limit = 6 }) {
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: ({ signal }) => api("/notifications", { signal }),
    refetchInterval: 60000,
  });
  // Before database update 038 there is no notification list to show.
  if (q.error?.status === 503) return null;
  const rows = Array.isArray(q.data?.data) ? q.data.data.slice(0, limit) : [];
  return (
    <section className="panel recent-activity" aria-labelledby="recent-title">
      <div className="panel-heading">
        <h2 id="recent-title">Recent activity</h2>
        {q.data?.unread > 0 && (
          <span className="badge warning">{q.data.unread} unread</span>
        )}
      </div>
      {q.isPending ? (
        <div className="activity-skeleton" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="fx-skeleton" />
          ))}
        </div>
      ) : q.error ? (
        <p className="field-hint">Recent activity could not load.</p>
      ) : rows.length ? (
        <ul className="activity-list">
          {rows.map((n) => {
            const Icon = noticeIcon(n.type);
            const title = n.link ? (
              <Link to={n.link}>{n.title}</Link>
            ) : (
              <b>{n.title}</b>
            );
            return (
              <li key={n.id} className={n.read_at ? "" : "unread"}>
                <span className="activity-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <div>
                  {title}
                  {n.body && <p>{n.body}</p>}
                  <small>{timeAgo(n.updated_at || n.created_at)}</small>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty">No recent activity yet.</div>
      )}
    </section>
  );
}
