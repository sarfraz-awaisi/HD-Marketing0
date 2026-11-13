import "../../styles/leads.css";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { followUpNotice, unansweredOutcomes } from "../../lib/calls";
import {
  ErrorBox,
  Loader,
  Pagination,
  Table,
  useToast,
} from "../../components/common/UI";
import LeadPhone from "../../components/leads/LeadPhone";
import CallDialog from "../../components/calls/CallDialog";
import { ActiveFilters } from "../../components/leads/LeadSearch";
import {
  ContactCell,
  PipelineFilters,
  pipelineFilterChips,
  temperatureChoices,
} from "../../components/leads/PipelineParts";
import {
  CustomerCell,
  DetailsLink,
  FollowUpCell,
  NoteCell,
  TemperatureBadge,
} from "../../components/leads/LeadCells";
// Lead pipeline (updates 052 and 053): the agent's own leads with an
// answered call, latest contact first. Search, temperature and the latest
// call's outcome work together in the database, across every page. A
// lead whose calls never connected (Number off, say) is never here; it is
// found in Assigned leads. Update 055 adds My pipeline and Personally
// contacted, and marks a lead whose last answered call someone else logged.
export default function LeadPipeline() {
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  const back = location.pathname + location.search;
  const [f, change] = useUrlFilters([
    "q",
    "temperature",
    "outcome",
    "country",
    "page",
  ]);
  const [dialLead, setDialLead] = useState(null);
  const page = Math.max(1, Number(f.page) || 1);
  const set = (values) => change({ ...values, page: null });
  const params = new URLSearchParams({
    view: "pipeline",
    page,
    ...(f.q ? { search: f.q } : {}),
    ...(f.temperature ? { temperature: f.temperature } : {}),
    ...(f.outcome ? { outcome: f.outcome } : {}),
    ...(f.country ? { country: f.country } : {}),
  });
  const q = useQuery({
    queryKey: ["my-leads", user.id, params.toString()],
    queryFn: ({ signal }) => api("/my-leads?" + params, { signal }),
    // The current results stay while the next ones load; the table and
    // pages then show the page those results are for.
    placeholderData: (previous) => previous,
  });
  const filters = pipelineFilterChips(f, set);
  const reset = () =>
    change({
      q: null,
      temperature: null,
      outcome: null,
      country: null,
      page: null,
    });
  const counts = q.data?.temperatures;
  // Update 055: both counts cover every lead, whatever the filters.
  const totals = q.data?.pipeline_counts;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR LEADS WITH AN ANSWERED CALL</span>
          <h1>Lead pipeline</h1>
          <p>
            Every lead assigned to you with an answered call, latest contact
            first, including calls made before a lead became yours.
          </p>
        </div>
        <div className="actions">
          <Link className="button secondary" to="/leads">
            Assigned leads
          </Link>
        </div>
      </div>
      {totals && (
        <>
          <div
            className="pipeline-stats"
            role="group"
            aria-label="Pipeline counts"
          >
            <div className="pipeline-stat">
              <span>My pipeline</span>
              <b>{totals.pipeline}</b>
            </div>
            <div className="pipeline-stat">
              <span>Personally contacted</span>
              <b>{totals.personally_contacted}</b>
            </div>
          </div>
          <p className="pipeline-count-note">
            My pipeline counts every lead of yours with an answered call.
            Personally contacted counts those with an answered call you made
            yourself. On a lead reassigned to you, only calls made since it
            reached you count.
          </p>
        </>
      )}
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
          <PipelineFilters f={f} set={set} />
        </div>
        <ActiveFilters items={filters} onReset={reset} />
        {unansweredOutcomes.includes(f.outcome) && (
          <p className="pipeline-hint" role="note">
            These are leads you have spoken to before whose latest call was{" "}
            {f.outcome}. Leads never reached are in{" "}
            <Link
              to={`/leads?view=all&outcome=${encodeURIComponent(f.outcome)}`}
            >
              Assigned leads (last call: {f.outcome})
            </Link>
            .
          </p>
        )}
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : q.error ? null : (
          <>
            <div className="pipeline-table">
              <Table
                showSerial
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
                    label: "Phone",
                    render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
                  },
                  {
                    key: "temperature",
                    label: "Temperature",
                    render: (r) => <TemperatureBadge value={r.temperature} />,
                  },
                  {
                    key: "note",
                    label: "Agent notes",
                    render: (r) => <NoteCell lead={r} />,
                  },
                  {
                    key: "last_contact_at",
                    label: "Latest contact",
                    render: (r) => <ContactCell lead={r} />,
                  },
                  {
                    key: "next_followup_at",
                    label: "Next follow-up",
                    render: (r) => <FollowUpCell lead={r} />,
                  },
                  {
                    key: "details",
                    label: "Details",
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
