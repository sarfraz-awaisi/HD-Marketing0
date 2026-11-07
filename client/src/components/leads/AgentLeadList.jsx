import "../../styles/leads.css";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { callOutcomes, followUpNotice } from "../../lib/calls";
import { firstCallState } from "../../lib/firstCall";
import { ErrorBox, Loader, Pagination, Table, useToast } from "../common/UI";
import LeadPhone from "./LeadPhone";
import CallDialog from "../calls/CallDialog";
import { ActiveFilters, LeadSearch } from "./LeadSearch";
import { CustomerCell, DetailsLink, LastCallCell } from "./LeadCells";
// An agent's Assigned leads (updates 052 and 053): one file's leads, or all
// of them, for the day's calling. # is the row's place in the list. The
// database searches every page by name or contact number and returns only
// the agent's own leads; a file keeps its import order.
const callLabels = {
  uncalled: "Waiting for first call",
  missed: "Missed first call",
};
export default function AgentLeadList({ importId }) {
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  const back = location.pathname + location.search;
  const [f, change] = useUrlFilters(["q", "call", "outcome", "page"]);
  const [dialLead, setDialLead] = useState(null);
  const page = Math.max(1, Number(f.page) || 1);
  const set = (values) => change({ ...values, page: null });
  const params = new URLSearchParams({
    view: "assigned",
    page,
    ...(importId ? { import_id: importId } : {}),
    ...(f.q ? { search: f.q } : {}),
    ...(f.call ? { call: f.call } : {}),
    ...(f.outcome ? { outcome: f.outcome } : {}),
  });
  const q = useQuery({
    queryKey: ["my-leads", user.id, params.toString()],
    queryFn: ({ signal }) => api("/my-leads?" + params, { signal }),
    // The current results stay while the next ones load; the table and
    // pages then show the page those results are for.
    placeholderData: (previous) => previous,
  });
  const file = useQuery({
    queryKey: ["lead-import", user.id, user.role, importId],
    queryFn: ({ signal }) => api("/lead-imports/" + importId, { signal }),
    enabled: !!importId,
  });
  const filters = [
    ...(f.q ? [[`Search: ${f.q}`, () => set({ q: null })]] : []),
    ...(f.call ? [[callLabels[f.call], () => set({ call: null })]] : []),
    ...(f.outcome
      ? [[`Last call: ${f.outcome}`, () => set({ outcome: null })]]
      : []),
  ];
  const reset = () =>
    change({ q: null, call: null, outcome: null, page: null });
  return (
    <>
      <Link className="back-link" to="/leads">
        ← Assigned files
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">RELATIONSHIPS THAT MOVE BUSINESS</span>
          <h1>Assigned leads</h1>
          <p>
            {importId
              ? `File: ${file.data?.file_name || "Loading file…"}`
              : "Every lead assigned to you, from every file and source."}
          </p>
        </div>
        <div className="actions">
          <Link className="button secondary" to="/leads/pipeline">
            Lead pipeline
          </Link>
        </div>
      </div>
      <ErrorBox error={file.error} />
      <section className="panel">
        <div className="toolbar lead-toolbar">
          <LeadSearch value={f.q} onSearch={(q) => set({ q })} />
          <select
            aria-label="Filter by first call"
            value={f.call}
            onChange={(e) => set({ call: e.target.value })}
          >
            <option value="">Any first-call state</option>
            {Object.entries(callLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by last call"
            value={f.outcome}
            onChange={(e) => set({ outcome: e.target.value })}
          >
            <option value="">Any last call</option>
            {callOutcomes.map((o) => (
              <option key={o} value={o}>
                {o}
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
            <div className="assigned-table">
              <Table
                showSerial
                page={q.data.page ?? page}
                count={q.data.count}
                rows={q.data.data}
                empty={
                  filters.length
                    ? "No leads match your search or filters. Reset filters to see every lead."
                    : importId
                      ? "None of this file's leads are assigned to you."
                      : "No leads are assigned to you yet."
                }
                columns={[
                  {
                    key: "name",
                    label: "Customer",
                    render: (r) => <CustomerCell lead={r} back={back} />,
                  },
                  {
                    key: "phone",
                    label: "Phone",
                    render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
                  },
                  {
                    key: "first_call",
                    label: "First call",
                    render: (r) => {
                      const state = firstCallState(r);
                      return state ? (
                        <span className={`badge plain ${state.tone}`}>
                          {state.label}
                        </span>
                      ) : (
                        "—"
                      );
                    },
                  },
                  {
                    key: "last_call",
                    label: "Last contact",
                    render: (r) => <LastCallCell lead={r} />,
                  },
                  {
                    key: "details",
                    label: "Actions",
                    render: (r) => <DetailsLink lead={r} back={back} />,
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
