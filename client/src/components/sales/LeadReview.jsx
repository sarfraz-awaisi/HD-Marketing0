import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneMissed } from "lucide-react";
import { api } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { dueLabel, idleFor, lateBy } from "../../lib/firstCall";
import {
  Button,
  ErrorBox,
  Loader,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
const limit = 10;
// Admin decision list: leads whose first call was missed, or that have had no
// activity for the configured days. Nothing moves until the admin decides.
export default function LeadReview() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState(
      params.get("review") === "idle" ? "idle" : "missed",
    ),
    [page, setPage] = useState(1),
    [target, setTarget] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const panel = useRef(null),
    pending = useRef(false);
  const qc = useQueryClient(),
    toast = useToast();
  const selection = useLeadSelection(kind);
  const q = useQuery({
    queryKey: ["lead-review", kind, page],
    queryFn: ({ signal }) =>
      api(`/lead-review?kind=${kind}&page=${page}&limit=${limit}`, { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (a) => a.active && a.role === "agent",
  );
  const rows = Array.isArray(q.data?.data) ? q.data.data : [];
  useEffect(() => {
    if (params.get("review")) panel.current?.scrollIntoView?.();
  }, [params]);
  async function decide(ids, action, agent = "") {
    if (pending.current || !ids.length) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "keep") {
        const result = await api("/lead-review/keep", {
          method: "POST",
          body: { lead_ids: ids, kind },
        });
        toast(
          `${result.kept} kept with their agent${result.skipped ? `, ${result.skipped} no longer need review` : ""}`,
        );
      } else {
        const result = await api("/lead-review/reassign", {
          method: "POST",
          body: {
            lead_ids: ids,
            kind,
            mode: agent ? "agent" : "unassign",
            ...(agent ? { agent_id: agent } : {}),
          },
        });
        toast(
          `${result.assigned} reassigned${result.skipped ? `, ${result.skipped} already with that agent` : ""}${result.failed ? `, ${result.failed} failed` : ""}`,
        );
      }
      selection.clear();
      setTarget("");
      invalidateWorkspace(qc);
    } catch (e) {
      setError(e.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const counts = q.data?.counts || {};
  const tabs = [
    ["missed", "Missed first call", counts.missed],
    ["idle", `No activity ${q.data?.idle_days ?? 7}+ days`, counts.idle],
  ];
  return (
    <section
      className="panel lead-review"
      id="lead-review"
      ref={panel}
      aria-labelledby="lead-review-title"
    >
      <div className="panel-heading">
        <div>
          <h2 id="lead-review-title">Leads waiting for your decision</h2>
          <p className="field-hint">
            Keep each lead with its agent for a new deadline, or reassign it.
            Nothing moves until you decide.
          </p>
        </div>
        <PhoneMissed size={20} />
      </div>
      <div className="review-tabs" role="tablist" aria-label="Review lists">
        {tabs.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={kind === value ? "active" : ""}
            onClick={() => {
              setKind(value);
              setPage(1);
              setTarget("");
              setError("");
            }}
          >
            {label} <b>{count ?? "—"}</b>
          </button>
        ))}
      </div>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : !rows.length ? (
        <div className="empty">
          {kind === "missed"
            ? "Every assigned lead has had its first call on time."
            : "No leads have gone quiet. Every open lead has recent activity or a planned follow-up."}
        </div>
      ) : (
        <>
          {selection.ids.length > 0 && (
            <div
              className="bulk-action-bar"
              role="toolbar"
              aria-label="Selected review actions"
            >
              <b>{selection.ids.length} selected</b>
              <Button
                disabled={busy}
                onClick={() => decide(selection.ids, "keep")}
              >
                Keep with agent
              </Button>
              <select
                aria-label="Reassign selected leads to"
                disabled={busy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose a new owner</option>
                <option value="unassigned">Unassigned (admin team)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={busy || !target}
                onClick={() =>
                  decide(
                    selection.ids,
                    "reassign",
                    target === "unassigned" ? "" : target,
                  )
                }
              >
                Reassign selected
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={selection.clear}
              >
                Clear selection
              </Button>
            </div>
          )}
          <Table
            selection={selection}
            rows={rows}
            columns={[
              {
                key: "lead",
                label: "Lead",
                render: (r) => (
                  <Link className="customer-link" to={"/leads/" + r.id}>
                    <div>
                      <b>{r.name}</b>
                      <small className="lead-number">
                        {formatLeadNo(r.lead_no)}
                      </small>
                    </div>
                  </Link>
                ),
              },
              {
                key: "agent",
                label: "Agent",
                render: (r) => r.agent_name,
              },
              kind === "missed"
                ? {
                    key: "due",
                    label: "First call was due",
                    render: (r) => (
                      <span>
                        {dueLabel(r.call_due_at)}
                        <small className="review-late">
                          {lateBy(r.call_due_at)}
                        </small>
                      </span>
                    ),
                  }
                : {
                    key: "quiet",
                    label: "Quiet for",
                    render: (r) => (
                      <span>
                        {idleFor(r.last_activity_at)}
                        <small className="review-late">
                          Last activity {dueLabel(r.last_activity_at)}
                        </small>
                      </span>
                    ),
                  },
              {
                key: "decide",
                label: "Decision",
                render: (r) => (
                  <div className="review-actions">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => decide([r.id], "keep")}
                    >
                      Keep
                    </Button>
                    <select
                      aria-label={`Reassign ${r.name}`}
                      disabled={busy}
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        decide(
                          [r.id],
                          "reassign",
                          e.target.value === "unassigned" ? "" : e.target.value,
                        )
                      }
                    >
                      <option value="">Reassign to…</option>
                      <option value="unassigned">
                        Unassigned (admin team)
                      </option>
                      {agents
                        .filter((a) => a.id !== r.assigned_agent)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </div>
                ),
              },
            ]}
          />
          <Pagination
            page={page}
            count={q.data.count}
            limit={limit}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
