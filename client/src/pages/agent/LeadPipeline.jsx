import "../../styles/leads.css";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { followUpNotice } from "../../lib/calls";
import { statuses, statusLabel } from "../../lib/pipeline";
import { temperatures, temperatureText } from "../../lib/temperature";
import {
  Badge,
  ErrorBox,
  Loader,
  Pagination,
  Table,
  useToast,
} from "../../components/common/UI";
import LeadPhone from "../../components/leads/LeadPhone";
import CallDialog from "../../components/calls/CallDialog";
import { ActiveFilters, LeadSearch } from "../../components/leads/LeadSearch";
import {
  CustomerCell,
  FileNumber,
  FollowUpCell,
  TemperatureBadge,
} from "../../components/leads/LeadCells";
// Lead pipeline (update 052): the agent's own leads with an answered call,
// whatever their status now. Status, temperature and search work together
// in the database, across every page.
const sorts = {
  contact: "Latest contact",
  followup: "Next follow-up",
  activity: "Recent activity",
  temperature: "Hottest first",
};
const temperatureChoices = [
  ...temperatures.map((t) => [t.value, `${t.emoji} ${t.label}`]),
  ["none", "Not recorded yet"],
];
export default function LeadPipeline() {
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  const back = location.pathname + location.search;
  const [f, change] = useUrlFilters([
    "q",
    "status",
    "temperature",
    "sort",
    "page",
  ]);
  const [dialLead, setDialLead] = useState(null);
  const page = Math.max(1, Number(f.page) || 1);
  const set = (values) => change({ ...values, page: null });
  const params = new URLSearchParams({
    view: "pipeline",
    page,
    ...(f.q ? { search: f.q } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.temperature ? { temperature: f.temperature } : {}),
    ...(f.sort ? { sort: f.sort } : {}),
  });
  const q = useQuery({
    queryKey: ["my-leads", user.id, params.toString()],
    queryFn: ({ signal }) => api("/my-leads?" + params, { signal }),
    // The current results stay while the next ones load; the table and
    // pages then show the page those results are for.
    placeholderData: (previous) => previous,
  });
  const filters = [
    ...(f.q ? [[`Search: ${f.q}`, () => set({ q: null })]] : []),
    ...(f.status
      ? [[`Status: ${statusLabel(f.status)}`, () => set({ status: null })]]
      : []),
    ...(f.temperature
      ? [
          [
            `Temperature: ${temperatureText(f.temperature)}`,
            () => set({ temperature: null }),
          ],
        ]
      : []),
    ...(f.sort
      ? [[`Sorted by ${sorts[f.sort]}`, () => set({ sort: null })]]
      : []),
  ];
  const reset = () =>
    change({
      q: null,
      status: null,
      temperature: null,
      sort: null,
      page: null,
    });
  const counts = q.data?.temperatures;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">LEADS YOU HAVE SPOKEN TO</span>
          <h1>Lead pipeline</h1>
          <p>
            Every lead of yours with an answered call. Plan your next calls by
            status and temperature.
          </p>
        </div>
        <div className="actions">
          <Link className="button secondary" to="/leads">
            Assigned leads
          </Link>
        </div>
      </div>
      {counts && (
        <div
          className="temperature-summary"
          role="group"
          aria-label="Pipeline leads by temperature"
        >
          {temperatureChoices.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`temperature-count ${value}`}
              aria-pressed={f.temperature === value}
              onClick={() =>
                set({ temperature: f.temperature === value ? null : value })
              }
            >
              <span>{label}</span>
              <b>{counts[value]}</b>
            </button>
          ))}
        </div>
      )}
      <section className="panel">
        <div className="toolbar lead-toolbar">
          <LeadSearch value={f.q} onSearch={(q) => set({ q })} />
          <select
            aria-label="Filter by status"
            value={f.status}
            onChange={(e) => set({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by temperature"
            value={f.temperature}
            onChange={(e) => set({ temperature: e.target.value })}
          >
            <option value="">All temperatures</option>
            {temperatureChoices.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort leads"
            value={f.sort || "contact"}
            onChange={(e) => set({ sort: e.target.value })}
          >
            {Object.entries(sorts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <ActiveFilters items={filters} onReset={reset} />
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : q.error ? null : (
          <>
            <div className="pipeline-table">
              <Table
                showSerial
                serialOf={(r) => <FileNumber lead={r} withFile />}
                page={q.data.page ?? page}
                count={q.data.count}
                rows={q.data.data}
                empty={
                  filters.length
                    ? "No pipeline leads match these filters. Reset filters to see your whole pipeline."
                    : "No contacted leads yet. A lead appears here after an answered call."
                }
                columns={[
                  {
                    key: "name",
                    label: "Customer",
                    render: (r) => <CustomerCell lead={r} back={back} />,
                  },
                  {
                    key: "phone",
                    label: "Contact phone",
                    render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (r) => <Badge value={r.status} />,
                  },
                  {
                    key: "temperature",
                    label: "Temperature",
                    render: (r) => <TemperatureBadge value={r.temperature} />,
                  },
                  {
                    key: "last_contact_at",
                    label: "Latest contact",
                    render: (r) => (
                      <span className="lead-contact">
                        <b>{date(r.last_contact_at)}</b>
                        <small>{r.last_contact_outcome || "No outcome"}</small>
                      </span>
                    ),
                  },
                  {
                    key: "next_followup_at",
                    label: "Next follow-up",
                    render: (r) => <FollowUpCell lead={r} />,
                  },
                  {
                    key: "details",
                    label: "Details",
                    render: (r) => (
                      <Link
                        className="button secondary"
                        to={"/leads/" + r.id}
                        state={{ back }}
                        aria-label={`View details for ${r.name}`}
                      >
                        View details
                      </Link>
                    ),
                  },
                ]}
              />
            </div>
            <Pagination
              page={q.data.page ?? page}
              count={q.data.count}
              onPage={(p) => change({ page: p > 1 ? p : null })}
            />
          </>
        )}
      </section>
      {dialLead && (
        <CallDialog
          lead={dialLead}
          role={user.role}
          onClose={() => setDialLead(null)}
          onSaved={(result) => {
            setDialLead(null);
            invalidateWorkspace(qc);
            toast(followUpNotice(result, date) || "Call saved");
          }}
        />
      )}
    </>
  );
}
