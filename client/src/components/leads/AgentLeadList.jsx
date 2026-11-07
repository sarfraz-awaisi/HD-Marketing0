import "../../styles/leads.css";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { followUpNotice } from "../../lib/calls";
import { firstCallState } from "../../lib/firstCall";
import { lostReasonLabel } from "../../lib/pipeline";
import {
  Badge,
  ErrorBox,
  Loader,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
import LeadPhone from "./LeadPhone";
import CallDialog from "../calls/CallDialog";
import { ActiveFilters, LeadSearch } from "./LeadSearch";
import {
  ContactCell,
  CustomerCell,
  FileNumber,
  FollowUpCell,
} from "./LeadCells";
// An agent's Assigned leads (update 052): one file's leads, or all of them.
// The database searches every page by name, contact number or # (the
// lead's fixed place in its file) and returns only the agent's own leads.
const sources = ["manual", "CSV", "Meta", "WhatsApp", "other"];
const sourceLabel = (s) => (s === "CSV" ? "CSV / Excel" : s);
const sorts = {
  file: "# order",
  activity: "Recent activity",
  added: "Newest added",
  call_due: "First-call deadline",
};
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
  const [f, change] = useUrlFilters(["q", "source", "call", "sort", "page"]);
  const [dialLead, setDialLead] = useState(null);
  const page = Math.max(1, Number(f.page) || 1);
  const sort = f.sort || (f.call ? "call_due" : importId ? "file" : "activity");
  const set = (values) => change({ ...values, page: null });
  const params = new URLSearchParams({
    view: "assigned",
    page,
    ...(importId ? { import_id: importId } : {}),
    ...(f.q ? { search: f.q } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.call ? { call: f.call } : {}),
    ...(f.sort ? { sort: f.sort } : {}),
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
    ...(f.source
      ? [[`Source: ${sourceLabel(f.source)}`, () => set({ source: null })]]
      : []),
    ...(f.call ? [[callLabels[f.call], () => set({ call: null })]] : []),
    ...(f.sort
      ? [[`Sorted by ${sorts[f.sort]}`, () => set({ sort: null })]]
      : []),
  ];
  const reset = () =>
    change({ q: null, source: null, call: null, sort: null, page: null });
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
            aria-label="Filter by source"
            value={f.source}
            onChange={(e) => set({ source: e.target.value })}
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
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
            aria-label="Sort leads"
            value={sort}
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
            <Table
              showSerial
              serialOf={(r) => <FileNumber lead={r} withFile={!importId} />}
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
                  label: "Contact phone",
                  render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) => (
                    <span className="lead-status">
                      <Badge value={r.status} />
                      {r.status === "lost" && r.lost_reason && (
                        <small>{lostReasonLabel(r.lost_reason)}</small>
                      )}
                    </span>
                  ),
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
                  key: "contact",
                  label: "Contact",
                  render: (r) => <ContactCell lead={r} />,
                },
                {
                  key: "next_followup_at",
                  label: "Next follow-up",
                  render: (r) => <FollowUpCell lead={r} />,
                },
                {
                  key: "source",
                  label: "Source",
                  render: (r) => sourceLabel(r.source),
                },
                { key: "preferred_location", label: "Location" },
                {
                  key: "created_at",
                  label: "Added",
                  render: (r) => date(r.created_at),
                },
              ]}
            />
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
