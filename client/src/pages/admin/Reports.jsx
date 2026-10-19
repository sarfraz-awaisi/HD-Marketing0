import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, download, pkr, reportSearch } from "../../lib/api";
import { lostReasonLabel, statusLabel } from "../../lib/pipeline";
import { Button, Table, ErrorBox, Loader } from "../../components/common/UI";
const tabs = [
  ["summary", "Summary"],
  ["sources", "Lead sources"],
  ["agents", "Agents"],
  ["funnel", "Sales funnel"],
  ["lost", "Lost reasons"],
];
const sourceName = (s) => (s === "CSV" ? "CSV / Excel" : s);
const percent = (part, whole) =>
  whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—";
const minutes = (m) =>
  m == null
    ? "—"
    : m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
function Bar({ value, max, label }) {
  return (
    <span className="report-bar" title={label}>
      <i style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
function BarList({ title, rows }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="report-block">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((r) => (
          <div className="report-row" key={r.key}>
            <span>{r.label}</span>
            <Bar value={r.count} max={max} label={`${r.label}: ${r.count}`} />
            <b>{r.count}</b>
          </div>
        ))
      ) : (
        <p className="empty">No lost leads in this range.</p>
      )}
    </section>
  );
}
function Summary({ data }) {
  return (
    <>
      <Table
        rows={Object.entries(data || {})
          .filter(([, v]) => typeof v === "number")
          .map(([key, value]) => ({
            id: key,
            metric: key.replaceAll("_", " "),
            value: key === "revenue" ? pkr(value) : value,
          }))}
        columns={[
          { key: "metric", label: "Metric" },
          { key: "value", label: "Value" },
        ]}
      />
      <h2>Metric definitions</h2>
      <p>
        Calls count when completed, using end time. Visits count when completed,
        using scheduled time. Won deals count once per lead, using close date;
        revenue sums their recorded value. Lead totals use creation time.
        Operational reminders and visits show current due or scheduled records.
      </p>
    </>
  );
}
function Sources({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <>
      <p className="field-hint">
        Leads created in this range, grouped by source, and how far each group
        has got so far.
      </p>
      <Table
        rows={rows.map((r) => ({ ...r, id: r.source }))}
        columns={[
          {
            key: "source",
            label: "Source",
            render: (r) => <b>{sourceName(r.source)}</b>,
          },
          {
            key: "leads",
            label: "Leads",
            render: (r) => (
              <span className="report-cell">
                <Bar value={r.leads} max={max} label={`${r.leads} leads`} />
                {r.leads}
              </span>
            ),
          },
          { key: "contacted", label: "Contacted" },
          { key: "visited", label: "Visited" },
          { key: "won", label: "Won" },
          { key: "lost", label: "Lost" },
          {
            key: "conversion",
            label: "Conversion",
            render: (r) => percent(r.won, r.leads),
          },
          {
            key: "revenue",
            label: "Won revenue",
            render: (r) => pkr(r.revenue),
          },
        ]}
      />
    </>
  );
}
function Agents({ rows }) {
  return (
    <>
      <p className="field-hint">
        Activity in this range. First-call speed counts working hours only.
      </p>
      <Table
        rows={rows.map((r) => ({ ...r, id: r.agent_id }))}
        columns={[
          {
            key: "name",
            label: "Agent",
            render: (r) => (
              <b>
                {r.name}
                {!r.active && " (inactive)"}
              </b>
            ),
          },
          { key: "assigned", label: "Assigned" },
          { key: "first_calls", label: "First calls" },
          {
            key: "on_time",
            label: "On time",
            render: (r) =>
              percent(r.on_time_first_calls, r.first_calls_with_deadline),
          },
          {
            key: "speed",
            label: "Avg first call",
            render: (r) => minutes(r.avg_first_call_minutes),
          },
          {
            key: "missed_first_calls",
            label: "Missed first calls",
            render: (r) =>
              r.missed_first_calls ? (
                <span className="badge overdue">{r.missed_first_calls}</span>
              ) : (
                0
              ),
          },
          {
            key: "calls",
            label: "Calls (answered)",
            render: (r) => `${r.calls} (${r.connected_calls})`,
          },
          {
            key: "talk",
            label: "Talk time",
            render: (r) => minutes(r.talk_minutes),
          },
          { key: "visits_completed", label: "Visits done" },
          { key: "won_deals", label: "Won deals" },
          { key: "revenue", label: "Revenue", render: (r) => pkr(r.revenue) },
          { key: "lost", label: "Lost" },
        ]}
      />
    </>
  );
}
function Funnel({ data }) {
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  return (
    <>
      <p className="field-hint">
        Leads created in this range and the furthest stage each has reached.
      </p>
      {data?.total ? (
        <div className="report-funnel">
          {stages.map((s, i) => (
            <div className="report-row" key={s.stage}>
              <span>{statusLabel(s.stage)}</span>
              <Bar
                value={s.reached}
                max={data.total}
                label={`${s.reached} of ${data.total}`}
              />
              <b>{s.reached}</b>
              <small>
                {percent(s.reached, data.total)} of all
                {i > 0 &&
                  ` · ${percent(s.reached, stages[i - 1].reached)} of previous`}
              </small>
            </div>
          ))}
          <div className="report-row lost">
            <span>Lost</span>
            <Bar
              value={data.lost}
              max={data.total}
              label={`${data.lost} lost`}
            />
            <b>{data.lost}</b>
            <small>{percent(data.lost, data.total)} of all</small>
          </div>
        </div>
      ) : (
        <p className="empty">No leads were created in this range.</p>
      )}
    </>
  );
}
function Lost({ data }) {
  const list = (rows) => (Array.isArray(rows) ? rows : []);
  return (
    <>
      <p className="field-hint">
        Leads marked lost in this range: {data?.total ?? 0}.
      </p>
      <div className="report-blocks">
        <BarList
          title="By reason"
          rows={list(data?.by_reason).map((r) => ({
            key: r.reason,
            label: lostReasonLabel(r.reason),
            count: r.count,
          }))}
        />
        <BarList
          title="By source"
          rows={list(data?.by_source).map((r) => ({
            key: r.source,
            label: sourceName(r.source),
            count: r.count,
          }))}
        />
        <BarList
          title="By agent"
          rows={list(data?.by_agent).map((r) => ({
            key: r.agent_id || "unassigned",
            label: r.name,
            count: r.count,
          }))}
        />
      </div>
    </>
  );
}
export default function Reports() {
  const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const [tab, setTab] = useState("summary"),
    [from, setFrom] = useState(today.slice(0, 7) + "-01"),
    [to, setTo] = useState(today),
    [agent, setAgent] = useState(""),
    [source, setSource] = useState(""),
    [error, setError] = useState("");
  // Each report uses only the filters that apply to it.
  const usesAgent = tab !== "agents",
    usesSource = !["sources", "agents"].includes(tab);
  const params = {
    from: new Date(from + "T00:00:00+05:00").toISOString(),
    to: new Date(
      new Date(to + "T00:00:00+05:00").getTime() + 86400000,
    ).toISOString(),
    ...(agent && usesAgent ? { agent } : {}),
    ...(source && usesSource ? { source } : {}),
  };
  const path = tab === "summary" ? "/reports" : "/reports/" + tab;
  const q = useQuery({
    queryKey: ["reports", tab, params],
    queryFn: ({ signal }) => api(path + "?" + reportSearch(params), { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const rows = Array.isArray(q.data) ? q.data : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CLARITY ACROSS YOUR BUSINESS</span>
          <h1>Reports</h1>
          <p>Full-dataset reports. Date ranges use Pakistan time.</p>
        </div>
        <Button
          disabled={!q.data}
          onClick={async () => {
            setError("");
            try {
              download(
                await api(path + "/export?" + reportSearch(params), {
                  download: true,
                }),
                tab === "summary"
                  ? "hd-marketing-report.csv"
                  : `hd-marketing-${tab}-report.csv`,
              );
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          Export CSV
        </Button>
      </div>
      <div className="review-tabs" role="tablist" aria-label="Report">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => {
              setTab(value);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel report-panel">
        <div className="toolbar">
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={to}
              onChange={(e) => e.target.value && setTo(e.target.value)}
            />
          </label>
          {usesAgent && (
            <select
              aria-label="Report agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">All agents</option>
              {(Array.isArray(users.data) ? users.data : [])
                .filter((u) => u.role === "agent")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          )}
          {usesSource && (
            <select
              aria-label="Report source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All sources</option>
              {["manual", "CSV", "Meta", "WhatsApp", "other"].map((s) => (
                <option key={s} value={s}>
                  {sourceName(s)}
                </option>
              ))}
            </select>
          )}
        </div>
        <ErrorBox error={error || q.error} />
        {q.isPending ? (
          <Loader />
        ) : q.error ? null : tab === "summary" ? (
          <Summary data={q.data} />
        ) : tab === "sources" ? (
          <Sources rows={rows} />
        ) : tab === "agents" ? (
          <Agents rows={rows} />
        ) : tab === "funnel" ? (
          <Funnel data={q.data} />
        ) : (
          <Lost data={q.data} />
        )}
      </section>
    </>
  );
}
