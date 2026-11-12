import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../context/AuthContext";
import { api, download, pkr, reportSearch } from "../../lib/api";
import { lostReasonLabel, statusLabel, statuses } from "../../lib/pipeline";
import {
  canOpenSummary,
  drillInfo,
  relatedNumbers,
  reportNumber,
  sourceName,
} from "../../lib/reportDrilldown";
import { drillParams, useDrillUrl } from "../../lib/useDrillUrl";
import { Button, Table, ErrorBox, Loader } from "../../components/common/UI";
import ReportDrilldown from "../../components/reports/ReportDrilldown";
import TeamPerformance from "../../components/reports/TeamPerformance";
import { dayRange, periodDays, periodOf, periods } from "../../lib/periods";
import "../../styles/reports.css";
// Administrators see everyone's numbers. Agents see the same reports with
// only their own work, as My performance (update 051). Update 063:
// administrators' agent report is Team performance.
const allTabs = [
  ["summary", "Summary"],
  ["sources", "Lead sources"],
  ["team", "Team performance", null, "admin"],
  ["agents", "Agents", "My activity", "agent"],
  ["funnel", "Sales funnel"],
  ["lost", "Lost reasons"],
];
const percent = (part, whole) =>
  whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—";
const minutes = (m) =>
  m == null
    ? "—"
    : m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
const day = /^\d{4}-\d{2}-\d{2}$/;
const longDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
function Bar({ value, max, label }) {
  return (
    <span className="report-bar" title={label}>
      <i style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
// A report number that opens the records behind it.
function Open({ label, value, onOpen, children }) {
  return (
    <button
      type="button"
      className="report-link"
      aria-label={`${label}: ${value ?? 0}. Show the records`}
      onClick={onOpen}
    >
      {children ?? value ?? 0}
    </button>
  );
}
function BarList({ title, rows, empty, onOpen }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="report-block">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((r) => (
          <button
            type="button"
            className="report-row report-row-button"
            key={r.key ?? "none"}
            aria-label={`${r.label}: ${r.count}. Show the leads`}
            onClick={() => onOpen(r.key)}
          >
            <span>{r.label}</span>
            <Bar value={r.count} max={max} label={`${r.label}: ${r.count}`} />
            <b>{r.count}</b>
          </button>
        ))
      ) : (
        <p className="empty">{empty}</p>
      )}
    </section>
  );
}
function Summary({ data, onOpen, own }) {
  const byStatus = data?.by_status || {};
  const rows = Object.entries(data || {})
    .filter(
      ([k, v]) => typeof v === "number" && (!own || canOpenSummary(k, own)),
    )
    .map(([key, value]) => ({
      id: key,
      metric: key.replaceAll("_", " "),
      value: key === "revenue" ? pkr(value) : value,
    }));
  return (
    <>
      <Table
        rows={rows}
        columns={[
          {
            key: "metric",
            label: "Metric",
            render: (r) =>
              canOpenSummary(r.id) ? (
                <Open
                  label={r.metric}
                  value={r.value}
                  onOpen={() => onOpen(r.id)}
                >
                  {r.metric}
                </Open>
              ) : (
                r.metric
              ),
          },
          {
            key: "value",
            label: "Value",
            render: (r) =>
              canOpenSummary(r.id) ? (
                <Open
                  label={r.metric}
                  value={r.value}
                  onOpen={() => onOpen(r.id)}
                />
              ) : (
                r.value
              ),
          },
        ]}
      />
      {data?.by_status && (
        <BarList
          title="Leads created in this range, by current status"
          rows={statuses.map((s) => ({
            key: s,
            label: statusLabel(s),
            count: byStatus[s] || 0,
          }))}
          onOpen={(s) => onOpen("by_status", s)}
        />
      )}
      <h2>Metric definitions</h2>
      <p>
        Calls count when completed, using end time. Visits count when completed,
        using scheduled time. Won deals count once per lead, using close date;
        revenue sums their recorded value. Lead totals use creation time.
        Operational reminders and visits show current due or scheduled records.
        Select any number to see the records behind it.
      </p>
    </>
  );
}
function Sources({ rows, onOpen }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  const cell = (key, label, format) => ({
    key,
    label,
    render: (r) => (
      <Open
        label={`${sourceName(r.source)} ${label}`}
        value={r[key]}
        onOpen={() => onOpen(key, r.source ?? null)}
      >
        {format ? format(r[key]) : r[key]}
      </Open>
    ),
  });
  return (
    <>
      <p className="field-hint">
        Leads created in this range, grouped by source, and how far each group
        has got so far. Select a source or a number to see its leads.
      </p>
      <Table
        rows={rows.map((r) => ({ ...r, id: r.source }))}
        columns={[
          {
            key: "source",
            label: "Source",
            render: (r) => (
              <Open
                label={`${sourceName(r.source)} leads`}
                value={r.leads}
                onOpen={() => onOpen("leads", r.source ?? null)}
              >
                <b>{sourceName(r.source)}</b>
              </Open>
            ),
          },
          {
            key: "leads",
            label: "Leads",
            render: (r) => (
              <span className="report-cell">
                <Bar value={r.leads} max={max} label={`${r.leads} leads`} />
                <Open
                  label={`${sourceName(r.source)} leads`}
                  value={r.leads}
                  onOpen={() => onOpen("leads", r.source ?? null)}
                />
              </span>
            ),
          },
          cell("contacted", "Contacted"),
          cell("visited", "Visited"),
          cell("won", "Won"),
          cell("lost", "Lost"),
          {
            key: "conversion",
            label: "Conversion",
            render: (r) => percent(r.won, r.leads),
          },
          cell("revenue", "Won revenue", pkr),
        ]}
      />
    </>
  );
}
function Agents({ rows, onOpen, own }) {
  const open = (metric, label, render) => ({
    key: metric,
    label,
    render: (r) => (
      <Open
        label={`${r.name} ${label}`}
        value={r[metric]}
        onOpen={() => onOpen(metric, r.agent_id)}
      >
        {render ? render(r) : r[metric]}
      </Open>
    ),
  });
  return (
    <>
      <p className="field-hint">
        {own ? "Your activity" : "Activity"} in this range. First-call speed
        counts working hours only. Select{own ? "" : " an agent or"} a number to
        see the records.
      </p>
      <Table
        rows={rows.map((r) => ({ ...r, id: r.agent_id }))}
        columns={[
          {
            key: "name",
            label: "Agent",
            render: (r) => (
              <Open
                label={`${r.name} assigned`}
                value={r.assigned}
                onOpen={() => onOpen("assigned", r.agent_id)}
              >
                <b>
                  {r.name}
                  {!r.active && " (inactive)"}
                </b>
              </Open>
            ),
          },
          open("assigned", "Assigned"),
          open("first_calls", "First calls"),
          open("first_calls_with_deadline", "On time", (r) =>
            percent(r.on_time_first_calls, r.first_calls_with_deadline),
          ),
          open("avg_first_call_minutes", "Avg first call", (r) =>
            minutes(r.avg_first_call_minutes),
          ),
          open("missed_first_calls", "Missed first calls", (r) =>
            r.missed_first_calls ? (
              <span className="badge overdue">{r.missed_first_calls}</span>
            ) : (
              0
            ),
          ),
          {
            key: "calls",
            label: "Calls (answered)",
            render: (r) => (
              <span className="report-pair">
                <Open
                  label={`${r.name} calls`}
                  value={r.calls}
                  onOpen={() => onOpen("calls", r.agent_id)}
                />
                <Open
                  label={`${r.name} answered calls`}
                  value={r.connected_calls}
                  onOpen={() => onOpen("connected_calls", r.agent_id)}
                >
                  ({r.connected_calls})
                </Open>
              </span>
            ),
          },
          open("talk_minutes", "Talk time", (r) => minutes(r.talk_minutes)),
          open("visits_completed", "Visits done"),
          open("won_deals", "Won deals"),
          open("revenue", "Revenue", (r) => pkr(r.revenue)),
          open("lost", "Lost"),
        ]}
      />
    </>
  );
}
function Funnel({ data, onOpen }) {
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  return (
    <>
      <p className="field-hint">
        Leads created in this range and the furthest stage each has reached.
        Select a stage to see its leads.
      </p>
      {data?.total ? (
        <div className="report-funnel">
          {stages.map((s, i) => (
            <button
              type="button"
              className="report-row report-row-button"
              key={s.stage}
              aria-label={`${statusLabel(s.stage)}: ${s.reached} leads. Show the leads`}
              onClick={() => onOpen("stage", s.stage)}
            >
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
            </button>
          ))}
          <button
            type="button"
            className="report-row report-row-button lost"
            aria-label={`Lost: ${data.lost} leads. Show the leads`}
            onClick={() => onOpen("lost")}
          >
            <span>Lost</span>
            <Bar
              value={data.lost}
              max={data.total}
              label={`${data.lost} lost`}
            />
            <b>{data.lost}</b>
            <small>{percent(data.lost, data.total)} of all</small>
          </button>
        </div>
      ) : (
        <p className="empty">No leads were created in this range.</p>
      )}
    </>
  );
}
function Lost({ data, onOpen, own }) {
  const list = (rows) => (Array.isArray(rows) ? rows : []);
  const empty = "No lost leads in this range.";
  return (
    <>
      <p className="field-hint">
        Leads marked lost in this range:{" "}
        {data?.total ? (
          <Open
            label="Lost leads"
            value={data.total}
            onOpen={() => onOpen("total")}
          />
        ) : (
          0
        )}
        .
      </p>
      <div className="report-blocks">
        <BarList
          title="By reason"
          empty={empty}
          rows={list(data?.by_reason).map((r) => ({
            key: r.reason ?? null,
            label: lostReasonLabel(r.reason),
            count: r.count,
          }))}
          onOpen={(key) => onOpen("reason", key)}
        />
        <BarList
          title="By source"
          empty={empty}
          rows={list(data?.by_source).map((r) => ({
            key: r.source ?? null,
            label: sourceName(r.source),
            count: r.count,
          }))}
          onOpen={(key) => onOpen("source", key)}
        />
        {!own && (
          <BarList
            title="By agent"
            empty={empty}
            rows={list(data?.by_agent).map((r) => ({
              key: r.agent_id ?? null,
              label: r.name,
              count: r.count,
            }))}
            onOpen={(key) => onOpen("agent", key)}
          />
        )}
      </div>
    </>
  );
}
// The tab, filters and any open drill-down live in the address, so returning
// from a lead's details brings back the same report and list.
export default function Reports() {
  const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const { user } = useAuth();
  const own = user.role !== "admin";
  const {
    url,
    change,
    drill,
    open: openDrill,
    close: closeDrill,
    setState,
  } = useDrillUrl();
  const client = useQueryClient();
  const [error, setError] = useState("");
  const tabs = allTabs.filter(
    ([, , , only]) => !only || only === (own ? "agent" : "admin"),
  );
  // An administrator's older Agents link opens Team performance.
  const asked = !own && url.get("tab") === "agents" ? "team" : url.get("tab");
  const tab = tabs.some(([v]) => v === asked) ? asked : "summary";
  const from = day.test(url.get("from") || "")
    ? url.get("from")
    : today.slice(0, 7) + "-01";
  const to = day.test(url.get("to") || "") ? url.get("to") : today;
  // Agents' reports are always their own; the server sets the agent.
  const agent = own ? "" : url.get("agent") || "";
  const source = url.get("source") || "";
  // Each report uses only the filters that apply to it.
  const usesAgent = !["agents", "team"].includes(tab) && !own,
    usesSource = !["sources", "agents", "team"].includes(tab);
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
    enabled: tab !== "team",
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: !own,
  });
  const agentList = (Array.isArray(users.data) ? users.data : []).filter(
    (u) => u.role === "agent",
  );
  const rows = Array.isArray(q.data) ? q.data : [];
  // Agent names for titles, including former agents the report still lists.
  const names = Object.fromEntries([
    [user.id, user.name],
    ...(Array.isArray(users.data) ? users.data : []).map((u) => [u.id, u.name]),
    ...(tab === "agents" ? rows : []).map((r) => [r.agent_id, r.name]),
    ...(tab === "lost" && Array.isArray(q.data?.by_agent)
      ? q.data.by_agent
      : []
    )
      .filter((r) => r.agent_id)
      .map((r) => [r.agent_id, r.name]),
  ]);
  // A drill-down: metric (dm) and key (dk; "none" means not set).
  const { metric, rawKey, key: drillKey } = drill;
  const filterText = [
    `${longDate.format(new Date(from))} – ${longDate.format(new Date(to))}`,
    own
      ? "Your work"
      : usesAgent
        ? agent
          ? `Agent: ${names[agent] || "selected"}`
          : "All agents"
        : null,
    usesSource
      ? source
        ? `Source: ${sourceName(source)}`
        : "All sources"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {own ? "YOUR OWN WORK" : "CLARITY ACROSS YOUR BUSINESS"}
          </span>
          <h1>{own ? "My performance" : "Reports"}</h1>
          <p>
            {own
              ? "Your leads, calls and results. Select any number to see the records behind it. Date ranges use Pakistan time."
              : "Full-dataset reports. Date ranges use Pakistan time."}
          </p>
        </div>
        {!own && tab !== "team" && (
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
        )}
      </div>
      <div className="review-tabs" role="tablist" aria-label="Report">
        {tabs.map(([value, label, mine]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => {
              change({
                tab: value === "summary" ? null : value,
                ...Object.fromEntries(drillParams.map((k) => [k, null])),
              });
              setError("");
            }}
          >
            {own ? mine || label : label}
          </button>
        ))}
      </div>
      <section className="panel report-panel">
        <div className="toolbar">
          {/* Update 063: named periods, weeks Sunday to Saturday. */}
          <select
            aria-label="Report period"
            value={periodOf(from, to)}
            onChange={(e) => {
              const p = periodDays(e.target.value);
              if (p) change(p);
            }}
          >
            {periods.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
            <option value="custom" disabled>
              Custom dates
            </option>
          </select>
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(e) =>
                e.target.value && change({ from: e.target.value })
              }
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={to}
              onChange={(e) => e.target.value && change({ to: e.target.value })}
            />
          </label>
          {usesAgent && (
            <select
              aria-label="Report agent"
              value={agent}
              onChange={(e) => change({ agent: e.target.value })}
            >
              <option value="">All agents</option>
              {agentList.map((u) => (
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
              onChange={(e) => change({ source: e.target.value })}
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
        {tab === "team" ? (
          <TeamPerformance
            range={dayRange(from, to)}
            dayCount={
              Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1
            }
            periodText={`${longDate.format(new Date(from))} – ${longDate.format(new Date(to))}, Pakistan time`}
            agent={url.get("agent") || null}
            onAgent={(id) => change({ agent: id })}
          />
        ) : q.isPending ? (
          <Loader />
        ) : q.error ? null : tab === "summary" ? (
          <Summary data={q.data} onOpen={openDrill} own={own} />
        ) : tab === "sources" ? (
          <Sources rows={rows} onOpen={openDrill} />
        ) : tab === "agents" ? (
          <Agents rows={rows} onOpen={openDrill} own={own} />
        ) : tab === "funnel" ? (
          <Funnel data={q.data} onOpen={openDrill} />
        ) : (
          <Lost data={q.data} onOpen={openDrill} own={own} />
        )}
      </section>
      {metric && q.data && (
        <ReportDrilldown
          key={[tab, metric, rawKey, JSON.stringify(params)].join("|")}
          report={tab}
          metric={metric}
          drillKey={drillKey}
          info={drillInfo(tab, metric, drillKey, names, own)}
          shown={reportNumber(tab, q.data, metric, drillKey)}
          related={relatedNumbers(tab, q.data, metric, drillKey)}
          filters={params}
          filterText={filterText}
          state={drill.state}
          onState={setState}
          onSelect={openDrill}
          onRefreshReport={() =>
            client.invalidateQueries({ queryKey: ["reports", tab] })
          }
          agents={agentList}
          own={own}
          onClose={closeDrill}
        />
      )}
    </>
  );
}
