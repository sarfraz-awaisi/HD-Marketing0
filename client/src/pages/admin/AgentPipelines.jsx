import "../../styles/leads.css";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useUrlFilters } from "../../lib/useUrlFilters";
import {
  ErrorBox,
  Loader,
  Pagination,
  Table,
} from "../../components/common/UI";
import { LeadSearch } from "../../components/leads/LeadSearch";
// Administrators' Lead pipeline (update 055): every agent with the leads
// assigned to them that they personally contacted, found by name or UID; an
// agent opens their own pipeline. Numbers cover every lead, not one page.
// The list's address, search and page included, is kept for this tab so
// "All agents" returns to it, even after a lead's details.
const directoryKey = "hd-pipeline-directory";
export function lastDirectory() {
  try {
    const path = sessionStorage.getItem(directoryKey);
    if (path?.startsWith("/leads/pipeline")) return path;
  } catch {
    // Storage may be unavailable; the plain list is fine.
  }
  return "/leads/pipeline";
}
export default function AgentPipelines() {
  const location = useLocation();
  const back = location.pathname + location.search;
  useEffect(() => {
    try {
      sessionStorage.setItem(directoryKey, back);
    } catch {
      // As above.
    }
  }, [back]);
  const [f, change] = useUrlFilters(["q", "page"]);
  const page = Math.max(1, Number(f.page) || 1);
  const params = new URLSearchParams({
    page,
    ...(f.q ? { search: f.q } : {}),
  });
  const q = useQuery({
    queryKey: ["pipeline-agents", params.toString()],
    queryFn: ({ signal }) => api("/pipeline/agents?" + params, { signal }),
    placeholderData: (previous) => previous,
  });
  const to = (agent) => "/leads/pipeline/" + agent.id;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT BY AGENT</span>
          <h1>Lead pipeline</h1>
          <p>
            Choose an agent to see the leads assigned to them that they
            personally contacted. Only answered calls the agent made count.
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar lead-toolbar">
          <LeadSearch
            value={f.q}
            onSearch={(text) => change({ q: text, page: null })}
            label="Search agents"
            placeholder="Search by agent name or UID…"
          />
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : q.error ? null : (
          <>
            <div className="agent-directory">
              <Table
                rows={q.data.data}
                empty={
                  f.q
                    ? "No agent matches this search."
                    : "No agents yet. Agents appear here once their accounts exist."
                }
                columns={[
                  {
                    key: "name",
                    label: "Agent",
                    render: (a) => (
                      <Link
                        className="customer-link"
                        to={to(a)}
                        state={{ back }}
                      >
                        <span className="avatar small">{a.name[0]}</span>
                        <div>
                          <b>{a.name}</b>
                          <small>
                            UID {a.uid ?? "—"}
                            {!a.active && (
                              <span className="account-status disabled">
                                Disabled
                              </span>
                            )}
                          </small>
                        </div>
                      </Link>
                    ),
                  },
                  {
                    key: "contacted",
                    label: "Personally contacted",
                    render: (a) => <b>{a.contacted}</b>,
                  },
                  {
                    key: "hot",
                    label: "Hot",
                    render: (a) => (
                      <span className="temperature hot">{a.hot}</span>
                    ),
                  },
                  {
                    key: "warm",
                    label: "Warm",
                    render: (a) => (
                      <span className="temperature warm">{a.warm}</span>
                    ),
                  },
                  {
                    key: "cold",
                    label: "Cold",
                    render: (a) => (
                      <span className="temperature cold">{a.cold}</span>
                    ),
                  },
                  {
                    key: "followups_due",
                    label: "Follow-ups due",
                    render: (a) => <FollowUpsDue numbers={a} />,
                  },
                  {
                    key: "open",
                    label: "Pipeline",
                    render: (a) => (
                      <Link
                        className="button secondary lead-details-link"
                        to={to(a)}
                        state={{ back }}
                        aria-label={`Open ${a.name}'s pipeline`}
                      >
                        Open pipeline
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
    </>
  );
}
// Pending follow-ups due by the end of today, with the overdue ones marked.
export function FollowUpsDue({ numbers }) {
  return (
    <span className="lead-followup">
      <b>{numbers.followups_due}</b>
      {numbers.followups_overdue > 0 && (
        <span className="badge plain overdue">
          {numbers.followups_overdue} overdue
        </span>
      )}
    </span>
  );
}
