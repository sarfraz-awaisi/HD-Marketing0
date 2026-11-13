import "../../styles/leads.css";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { countryLabel } from "../../lib/countries";
import { followUpNotice } from "../../lib/calls";
import { temperatures } from "../../lib/temperature";
import {
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
  DetailsLink,
  FollowUpCell,
  NoteCell,
  TemperatureBadge,
} from "../../components/leads/LeadCells";
import {
  ContactCell,
  PipelineFilters,
  pipelineFilterChips,
} from "../../components/leads/PipelineParts";
import { FollowUpsDue, lastDirectory } from "./AgentPipelines";
// One agent's Lead pipeline, for administrators (update 055). Current: the
// leads assigned to the agent now that the agent personally contacted (an
// answered call the agent made), with the
// agent's own search and filters. Earlier contacts: leads the agent spoke to
// that are now someone else's, kept out of the agent's numbers. The latest
// contact, latest call and notes are always the agent's own.
export default function AgentPipeline() {
  const { agent: agentId } = useParams();
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  // Back to the agent list as it was left, search and page included.
  const [directory] = useState(() => location.state?.back || lastDirectory());
  const back = location.pathname + location.search;
  const [f, change] = useUrlFilters([
    "view",
    "q",
    "temperature",
    "outcome",
    "country",
    "page",
  ]);
  const [dialLead, setDialLead] = useState(null);
  const earlier = f.view === "earlier";
  const page = Math.max(1, Number(f.page) || 1);
  const set = (values) => change({ ...values, page: null });
  const params = new URLSearchParams({
    page,
    ...(earlier ? { view: "earlier" } : {}),
    ...(f.q ? { search: f.q } : {}),
    ...(!earlier && f.temperature ? { temperature: f.temperature } : {}),
    ...(!earlier && f.outcome ? { outcome: f.outcome } : {}),
    ...(!earlier && f.country ? { country: f.country } : {}),
  });
  const q = useQuery({
    queryKey: ["agent-pipeline", agentId, params.toString()],
    queryFn: ({ signal }) =>
      api(`/pipeline/agents/${agentId}?` + params, { signal }),
    // The current results stay while the next page or filter loads, but
    // never under another agent or the other tab's columns.
    placeholderData: (previous) =>
      previous?.agent?.id === agentId &&
      previous.view === (earlier ? "earlier" : "current")
        ? previous
        : undefined,
  });
  const agent = q.data?.agent;
  const numbers = q.data?.summary;
  // Update 065: with a country chosen, the contacted and temperature
  // numbers are those of the leads listed (that country's), not the
  // agent's whole pipeline.
  const byCountry = !earlier && f.country ? q.data?.temperatures : null;
  const shown = byCountry && numbers ? { ...numbers, ...byCountry } : numbers;
  const name = agent?.name || "This agent";
  const filters = earlier
    ? f.q
      ? [[`Search: ${f.q}`, () => set({ q: null })]]
      : []
    : pipelineFilterChips(f, set);
  const reset = () =>
    change({
      q: null,
      temperature: null,
      outcome: null,
      country: null,
      page: null,
    });
  const showView = (view) =>
    change({
      view: view === "earlier" ? "earlier" : null,
      q: null,
      temperature: null,
      outcome: null,
      country: null,
      page: null,
    });
  const lead = {
    key: "name",
    label: "Customer",
    render: (r) => <CustomerCell lead={r} back={back} />,
  };
  const phone = {
    key: "phone",
    label: "Phone",
    render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
  };
  const contact = {
    key: "last_contact_at",
    label: earlier ? `${name}'s latest contact` : "Latest contact",
    render: (r) => <ContactCell lead={r} />,
  };
  const note = {
    key: "note",
    label: "Agent notes",
    render: (r) => <NoteCell lead={r} />,
  };
  const details = {
    key: "details",
    label: "Details",
    render: (r) => <DetailsLink lead={r} back={back} />,
  };
  const columns = earlier
    ? [
        lead,
        phone,
        {
          key: "owner",
          label: "Now assigned to",
          render: (r) =>
            r.owner ? (
              <span className="lead-owner">
                {r.owner.name}
                {r.owner.former && <small>Former account</small>}
              </span>
            ) : (
              <span className="lead-muted">No one</span>
            ),
        },
        contact,
        note,
        details,
      ]
    : [
        lead,
        phone,
        {
          key: "temperature",
          label: "Temperature",
          render: (r) => <TemperatureBadge value={r.temperature} />,
        },
        note,
        contact,
        {
          key: "next_followup_at",
          label: "Next follow-up",
          render: (r) => <FollowUpCell lead={r} />,
        },
        details,
      ];
  return (
    <>
      <Link className="back-link" to={directory}>
        ← All agents
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT PIPELINE</span>
          <h1>{agent ? agent.name : "Agent pipeline"}</h1>
          {agent && (
            <p>
              UID {agent.uid ?? "—"}
              {!agent.active && (
                <span className="account-status disabled">Disabled</span>
              )}
              {" · "}Leads assigned to them now that they personally contacted
              (an answered call they made), latest contact first.
            </p>
          )}
        </div>
      </div>
      {numbers && (
        <div
          className="pipeline-stats"
          role="group"
          aria-label={`${name}'s pipeline numbers`}
        >
          <div className="pipeline-stat">
            <span>Personally contacted</span>
            <b>{shown.contacted}</b>
          </div>
          {temperatures.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`temperature-count ${t.value}`}
              aria-pressed={!earlier && f.temperature === t.value}
              onClick={() =>
                earlier
                  ? change({
                      view: null,
                      q: null,
                      page: null,
                      temperature: t.value,
                    })
                  : set({
                      temperature: f.temperature === t.value ? null : t.value,
                    })
              }
            >
              <span>
                {t.emoji} {t.label}
              </span>
              <b>{shown[t.value]}</b>
            </button>
          ))}
          <div className="pipeline-stat">
            <span>Follow-ups due</span>
            <FollowUpsDue numbers={numbers} />
          </div>
        </div>
      )}
      {byCountry && (
        <p className="pipeline-count-note">
          Personally contacted and temperatures: {countryLabel(f.country)} only
          {f.q || f.outcome ? ", with your search and filters" : ""}. Follow-ups
          due: every country.
        </p>
      )}
      {numbers?.answered_by_others > 0 && (
        <p className="pipeline-hint" role="note">
          On the agent's own Lead pipeline, My pipeline shows{" "}
          {numbers.contacted + numbers.answered_by_others}: these{" "}
          {numbers.contacted} personally contacted leads and{" "}
          {numbers.answered_by_others} more with an answered call from someone
          else only (
          {[
            [numbers.answered_by_admins, "last answered by an administrator"],
            [
              numbers.answered_by_other_agents,
              "last answered by another agent, before the lead was reassigned",
            ],
            [
              numbers.answered_unrecorded,
              "last answered in an older call with no recorded caller",
            ],
          ]
            .filter(([n]) => n > 0)
            .map(([n, text]) => `${n} ${text}`)
            .join("; ")}
          ). Only personally contacted leads count here and in the agent list.
        </p>
      )}
      <section className="panel">
        <div
          className="review-tabs"
          role="tablist"
          aria-label={`${name}'s leads`}
        >
          {[
            ["current", "Current pipeline", numbers?.contacted],
            ["earlier", "Earlier contacts", numbers?.earlier],
          ].map(([view, label, count]) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={(view === "earlier") === earlier}
              className={(view === "earlier") === earlier ? "active" : ""}
              onClick={() => showView(view)}
            >
              {label} <b>{count ?? "—"}</b>
            </button>
          ))}
        </div>
        {earlier && (
          <p className="pipeline-hint" role="note">
            Leads {name} spoke to that are now assigned to someone else or no
            one. They are not part of this agent's workload or numbers.
          </p>
        )}
        <div className="toolbar lead-toolbar">
          {earlier ? (
            <LeadSearch value={f.q} onSearch={(text) => set({ q: text })} />
          ) : (
            <PipelineFilters f={f} set={set} />
          )}
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
                page={q.data.page ?? page}
                count={q.data.count}
                rows={q.data.data}
                empty={
                  filters.length
                    ? "No leads match these filters. Reset filters to see them all."
                    : earlier
                      ? "No earlier contacts: every lead this agent personally contacted is still theirs."
                      : "No contacted leads yet. A lead appears here after an answered call this agent makes."
                }
                columns={columns}
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
