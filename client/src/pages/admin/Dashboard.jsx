import { formatLeadNo } from "../../lib/formatLeadNo";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Users,
  Phone,
  Calendar,
  CalendarDays,
  Handshake,
  ShieldAlert,
  PhoneCall,
  PhoneMissed,
  Timer,
  Inbox,
} from "lucide-react";
import { api, pkr, monthRange, reportSearch, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { statuses } from "../../lib/pipeline";
import TargetCard from "../../components/targets/TargetCard";
import { Loader, ErrorBox, Badge } from "../../components/common/UI";
import { useSecurityAlertSummary } from "../../lib/securityAlerts";
import { useMetaSummary } from "../../lib/meta";
import SystemStatus from "../../components/common/SystemStatus";
import {
  KpiTile,
  MonthHighlight,
  RecentActivity,
  RingProgress,
} from "../../components/dashboard/Widgets";
import "../../styles/dashboard.css";
import LeadReview from "../../components/sales/LeadReview";
import { TeamCallActivity, MyCalls } from "../../components/sales/CallActivity";
// Working minutes as "2 h 15 min" (first-call speed counts working hours only).
const workingTime = (minutes) =>
  minutes == null
    ? "—"
    : minutes < 60
      ? `${minutes} min`
      : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
// "Good morning" and today's date, both in Pakistan time.
function greeting(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Asia/Karachi",
    }).format(now),
  );
  return hour < 12
    ? "Good morning"
    : hour < 17
      ? "Good afternoon"
      : "Good evening";
}
const todayLabel = (now = new Date()) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(now);
// An agent's targets running today: the day's, this week's and this month's.
function CurrentTargets() {
  const q = useQuery({
    queryKey: ["targets", "current"],
    queryFn: ({ signal }) => api("/targets?current=true&limit=10", { signal }),
  });
  const rows = Array.isArray(q.data?.data) ? q.data.data : [];
  return (
    <section className="panel" aria-labelledby="current-targets-title">
      <div className="panel-heading">
        <h2 id="current-targets-title">My targets now</h2>
        <Link to="/targets">View all targets ↗</Link>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : rows.length ? (
        <div className="target-grid">
          {rows.map((t) => (
            <TargetCard key={t.id} target={t} admin={false} />
          ))}
        </div>
      ) : (
        !q.error && <div className="empty">No targets are running today.</div>
      )}
    </section>
  );
}
export default function Dashboard() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const security = useSecurityAlertSummary(admin);
  const social = useMetaSummary(user);
  const range = monthRange();
  const snapshot = useQuery({
    queryKey: ["dashboard", user.id, user.role, range],
    queryFn: ({ signal }) =>
      api("/dashboard?" + reportSearch(range), { signal }),
  });
  const metrics = { ...snapshot, data: snapshot.data?.metrics };
  const followups = snapshot.data?.followups || [];
  const visits = snapshot.data?.visits || [];
  const leaders = snapshot.data?.leaders || [];
  if (metrics.isPending) return <Loader />;
  const d = metrics.data || {};
  const onTime = d.first_calls_with_deadline
    ? Math.round((d.on_time_first_calls / d.first_calls_with_deadline) * 100)
    : null;
  const pipelineTotal = Math.max(1, d.leads || 0);
  return (
    <div className="dashboard">
      <div className="page-heading dash-heading">
        <div>
          <h1>{admin ? "Workspace overview" : "My overview"}</h1>
          <p className="dash-greeting">
            {greeting()}, <span>{user.name.split(" ")[0]}</span>! Here is what
            is happening in your sales workspace this month.
          </p>
        </div>
        <div className="actions">
          <span className="date-chip">
            <CalendarDays size={16} aria-hidden="true" />
            {todayLabel()}
          </span>
          <Link className="button" to="/leads">
            Open leads <ArrowUpRight size={16} />
          </Link>
        </div>
      </div>
      <ErrorBox error={metrics.error} />
      {admin && d.deleted_today > 50 && (
        <section className="error" role="alert">
          {d.deleted_today} leads deleted today.{" "}
          <Link to="/deleted-leads">Review Deleted leads</Link>
        </section>
      )}
      <div className="dash-layout">
        <div className="dash-main">
          <section
            className="panel dash-section"
            aria-labelledby="sales-summary"
          >
            <div className="panel-heading">
              <h2 id="sales-summary">Sales summary</h2>
              <span className="panel-meta">
                This month · Pakistan time · Live CRM records
              </span>
            </div>
            <div className="kpi-grid fx-stagger">
              <KpiTile
                label={admin ? "Total leads" : "My leads"}
                value={admin ? d.total_leads : d.assigned_leads}
                note={admin ? "All leads in the CRM" : "Assigned to you"}
                icon={Users}
                tone="navy"
                to="/leads"
              />
              <KpiTile
                label={admin ? "Completed calls" : "Today's completed calls"}
                value={admin ? d.completed_calls : d.today_completed_calls}
                note={admin ? "Answered calls this month" : "Answered today"}
                icon={Phone}
                tone="green"
              />
              <KpiTile
                label="Completed visits"
                value={d.completed_visits}
                note="Site visits this month"
                icon={Calendar}
                tone="blue"
                to="/visits"
              />
              <KpiTile
                label="Won deals"
                value={d.won_deals}
                note={`${pkr(d.revenue)} closed`}
                icon={Handshake}
                tone="gold"
                to="/deals"
              />
            </div>
          </section>
          {d.first_calls !== undefined && (
            <section
              className="panel dash-section first-call-metrics"
              aria-labelledby="first-call-title"
            >
              <div className="panel-heading">
                <h2 id="first-call-title">First calls</h2>
                <span className="panel-meta">Due the same working day</span>
              </div>
              <div className="kpi-grid fx-stagger">
                <KpiTile
                  label="Waiting for first call"
                  value={d.uncalled_leads}
                  note="Due before today's close or later"
                  icon={PhoneCall}
                  tone="blue"
                  to="/leads?view=all&call=uncalled"
                />
                <KpiTile
                  label="Missed first calls"
                  value={d.missed_first_calls}
                  note={
                    admin
                      ? "Waiting for your decision"
                      : "Call these customers now"
                  }
                  icon={PhoneMissed}
                  tone="red"
                  to="/leads?view=all&call=missed"
                />
                <section className="kpi kpi-ring fx-card">
                  <div className="kpi-top">
                    <span className="kpi-label">On-time first calls</span>
                  </div>
                  <div className="kpi-ring-body">
                    <RingProgress
                      value={onTime ?? 0}
                      label={
                        onTime == null
                          ? "No first calls with a deadline yet"
                          : `${onTime}% on time`
                      }
                    />
                    <div>
                      <strong className="kpi-value">
                        {onTime == null ? "—" : `${onTime}%`}
                      </strong>
                      <small className="kpi-note">
                        {`${d.on_time_first_calls ?? 0} of ${d.first_calls_with_deadline ?? 0} this month`}
                      </small>
                    </div>
                  </div>
                </section>
                <KpiTile
                  label="Average time to first call"
                  value={workingTime(d.avg_first_call_minutes)}
                  note="Working hours · this month"
                  icon={Timer}
                  tone="gold"
                />
              </div>
            </section>
          )}
          <div className="dash-two fx-stagger">
            <section className="panel fx-card" aria-labelledby="pipeline-title">
              <div className="panel-heading">
                <h2 id="pipeline-title">Lead pipeline</h2>
                <Link to="/leads">View leads ↗</Link>
              </div>
              {Object.keys(d.by_status || {}).length ? (
                <>
                  <div className="pipeline-stack" aria-hidden="true">
                    {statuses.map((status) =>
                      d.by_status[status] ? (
                        <span
                          key={status}
                          data-stage={status}
                          style={{
                            flexGrow: d.by_status[status],
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                  {statuses
                    .map((status) => [status, d.by_status[status] || 0])
                    .map(([status, count]) => (
                      <div className="pipeline-row" key={status}>
                        <Badge value={status} />
                        <div className="track" data-stage={status}>
                          <span
                            className="fx-progress"
                            style={{
                              width: `${Math.max(2, (count / pipelineTotal) * 100)}%`,
                            }}
                          />
                        </div>
                        <b>{count}</b>
                      </div>
                    ))}
                </>
              ) : (
                <div className="empty">
                  Your pipeline starts with the first lead.
                </div>
              )}
            </section>
            <section
              className="panel fx-card"
              aria-labelledby="followups-title"
            >
              <div className="panel-heading">
                <h2 id="followups-title">Follow-ups due</h2>
                <Link to="/followups">View all ↗</Link>
              </div>
              {followups.length ? (
                followups.map((f) => (
                  <Link
                    to={"/leads/" + f.lead_id}
                    className="list-row"
                    key={f.id}
                  >
                    <div>
                      <b>
                        {formatLeadNo(f.lead_no ?? f.leads?.lead_no)} ·{" "}
                        {f.notes || "Customer follow-up"}
                      </b>
                      <small>{date(f.due_at)}</small>
                    </div>
                    <Badge value={f.status} />
                  </Link>
                ))
              ) : (
                <div className="empty">No follow-ups due.</div>
              )}
            </section>
          </div>
        </div>
        <aside className="dash-side" aria-label="Highlights">
          <MonthHighlight metrics={d} admin={admin} />
          <RecentActivity />
        </aside>
      </div>
      {admin ? (
        <>
          <LeadReview />
          <TeamCallActivity />
        </>
      ) : (
        <MyCalls />
      )}
      <div className="dash-cards fx-stagger">
        <section className="panel fx-card" aria-labelledby="attention-title">
          <div className="panel-heading">
            <h2 id="attention-title">What needs attention</h2>
            <span className="gold-label">NEXT STEPS</span>
          </div>
          <Link className="attention" to="/followups">
            <span className="attention-icon">
              <Calendar size={17} aria-hidden="true" />
            </span>
            <div>
              <b>{d.overdue_followups ?? 0} overdue follow-ups</b>
              <small>Reconnect with your customers</small>
            </div>
            <ArrowUpRight size={18} />
          </Link>
          <Link className="attention" to="/visits">
            <span className="attention-icon">
              <CalendarDays size={17} aria-hidden="true" />
            </span>
            <div>
              <b>{d.scheduled_visits ?? 0} upcoming site visits</b>
              <small>Prepare for the next conversation</small>
            </div>
            <ArrowUpRight size={18} />
          </Link>
          <Link className="attention" to="/deals">
            <span className="attention-icon">
              <Handshake size={17} aria-hidden="true" />
            </span>
            <div>
              <b>{d.won_deals ?? 0} deals won this month</b>
              <small>Review your closed business</small>
            </div>
            <ArrowUpRight size={18} />
          </Link>
        </section>
        {admin && (
          <section className="panel fx-card dash-mini">
            <div className="panel-heading">
              <h2>Incoming social leads</h2>
              <Inbox size={18} aria-hidden="true" />
            </div>
            <strong>{social.data?.unassigned ?? "—"}</strong>
            <p>
              New customers awaiting your assignment ·{" "}
              {social.data?.review ?? "—"} need review
            </p>
            <ErrorBox error={social.error} />
            <Link className="button secondary" to="/incoming-social">
              Open social inbox
            </Link>
          </section>
        )}
        {admin && (
          <section className="panel fx-card security-overview dash-mini">
            <div className="panel-heading">
              <h2>Unreviewed security alerts</h2>
              <ShieldAlert size={18} aria-hidden="true" />
            </div>
            <strong>{security.data?.count ?? "—"}</strong>
            <p>Review number-access warnings and daily-limit alerts.</p>
            <ErrorBox error={security.error} />
            <Link className="button secondary" to="/security-alerts">
              Review security alerts
            </Link>
          </section>
        )}
        {admin && <SystemStatus />}
        <section className="panel fx-card" aria-labelledby="leaders-title">
          <div className="panel-heading">
            <h2 id="leaders-title">Team leaderboard</h2>
            <Link to="/targets">Targets ↗</Link>
          </div>
          {leaders.length ? (
            leaders.map((a, i) => (
              <div className="list-row" key={i}>
                <span className="rank">{i + 1}</span>
                <div>
                  <b>{a.name}</b>
                  <small>{a.completed_calls} completed calls</small>
                </div>
                <strong>
                  {a.won_deals} <small>won</small>
                </strong>
              </div>
            ))
          ) : (
            <div className="empty">No ranked activity yet this month.</div>
          )}
        </section>
      </div>
      <section className="panel" aria-labelledby="visits-title">
        <div className="panel-heading">
          <h2 id="visits-title">Scheduled visits</h2>
          <Link to="/visits">Manage visits ↗</Link>
        </div>
        {visits.length ? (
          visits.map((v) => (
            <Link className="list-row" to={"/leads/" + v.lead_id} key={v.id}>
              <b>
                {formatLeadNo(v.lead_no ?? v.leads?.lead_no)} ·{" "}
                {v.notes || "Property site visit"}
              </b>
              <span>{date(v.scheduled_at)}</span>
              <Badge value={v.status} />
            </Link>
          ))
        ) : (
          <div className="empty">No scheduled visits.</div>
        )}
      </section>
      {!admin && <CurrentTargets />}
    </div>
  );
}
