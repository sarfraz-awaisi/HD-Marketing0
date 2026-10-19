import { formatLeadNo } from "../../lib/formatLeadNo";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date, pkr } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  Button,
  Modal,
  Loader,
  ErrorBox,
  Badge,
  RecordForm,
  useToast,
} from "../../components/common/UI";
import { statusLabel, lostReasonLabel } from "../../lib/pipeline";
import LeadStatusControl from "../../components/leads/LeadStatusControl";
import LeadForm from "../../components/leads/LeadForm";
import LeadPhone from "../../components/leads/LeadPhone";
import OutcomeForm from "../../components/calls/OutcomeForm";
import CallDialog from "../../components/calls/CallDialog";
import { ActivityForm } from "../../components/common/RecordsPage";
import { callMethodLabel } from "../../lib/calls";
import LeadKycDocuments from "../../components/documents/LeadKycDocuments";
export default function LeadDetail() {
  const { id } = useParams(),
    { user } = useAuth(),
    qc = useQueryClient(),
    toast = useToast();
  const [modal, setModal] = useState(""),
    [error, setError] = useState(""),
    [call, setCall] = useState(null),
    [busy, setBusy] = useState(false);
  const manualPending = useRef(false);
  const capabilities = useQuery({
    queryKey: ["call-capabilities"],
    queryFn: ({ signal }) => api("/call-capabilities", { signal }),
  });
  const q = useQuery({
    queryKey: ["lead", user.id, user.role, id],
    queryFn: ({ signal }) => api("/leads/" + id, { signal }),
  });
  const timeline = useQuery({
    queryKey: ["timeline", user.id, user.role, id],
    queryFn: ({ signal }) => api("/leads/" + id + "/timeline", { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: user.role === "admin",
  });
  const refresh = () => {
    invalidateWorkspace(qc);
    toast("Saved");
    setModal("");
    setCall(null);
  };
  async function act(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (q.isPending) return <Loader />;
  if (q.error) return <ErrorBox error={q.error} />;
  const lead = q.data;
  return (
    <>
      <Link
        className="back-link"
        to={
          lead.import_id
            ? `/leads?import_id=${lead.import_id}`
            : user.role === "agent"
              ? "/leads?view=all"
              : "/leads"
        }
      >
        ← Back to leads
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CUSTOMER PROFILE</span>
          <h1>{lead.name}</h1>
          <p className="lead-number">{formatLeadNo(lead.lead_no)}</p>
          <p>
            {lead.email || "No email"} · {lead.source}
          </p>
        </div>
        <div className="actions">
          <Badge value={lead.status} />
          <Button disabled={busy} onClick={() => setModal("manual")}>
            Log a call
          </Button>
          {capabilities.data?.mock === true && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const c = await api("/leads/" + id + "/call", {
                    method: "POST",
                  });
                  setCall(c);
                  setModal("call");
                  invalidateWorkspace(qc);
                })
              }
            >
              Development mock call
            </Button>
          )}
          {user.role === "admin" && (
            <Button variant="secondary" onClick={() => setModal("edit")}>
              Edit lead
            </Button>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="detail-grid">
        <section className="panel">
          <h2>Lead details</h2>
          <dl>
            <dt>Contact phone</dt>
            <dd>
              <LeadPhone lead={lead} onCall={() => setModal("dial")} />
            </dd>
            <dt>Preferred location</dt>
            <dd>{lead.preferred_location || "—"}</dd>
            <dt>Budget</dt>
            <dd>
              {pkr(lead.budget_min)} –{" "}
              {lead.budget_max ? pkr(lead.budget_max) : "Open"}
            </dd>
            <dt>Last activity</dt>
            <dd>{date(lead.last_activity_at)}</dd>
            <dt>Created</dt>
            <dd>{date(lead.created_at)}</dd>
            {lead.status === "lost" && (
              <>
                <dt>Lost reason</dt>
                <dd>{lostReasonLabel(lead.lost_reason)}</dd>
                {lead.lost_note && (
                  <>
                    <dt>Lost note</dt>
                    <dd>{lead.lost_note}</dd>
                  </>
                )}
                <dt>Lost at</dt>
                <dd>{date(lead.lost_at)}</dd>
              </>
            )}
          </dl>
          <LeadStatusControl
            lead={lead}
            disabled={busy}
            onSave={async (data) => {
              await api("/leads/" + id, { method: "PATCH", body: data });
              refresh();
            }}
          />
          {user.role === "admin" && (
            <>
              <Button variant="secondary" onClick={() => setModal("assign")}>
                Assign / round-robin
              </Button>
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Activity timeline · {formatLeadNo(lead.lead_no)}</h2>
            <Button variant="secondary" onClick={() => setModal("note")}>
              + Note
            </Button>
          </div>
          <div className="actions activity-actions">
            {[
              ["followups", "Follow-up"],
              ["visits", "Site visit"],
              ["deals", "Deal"],
            ].map(([key, label]) => (
              <Button
                key={key}
                variant="secondary"
                onClick={() => setModal(key)}
              >
                + {label}
              </Button>
            ))}
          </div>
          <ErrorBox error={timeline.error} />
          {timeline.isPending ? (
            <Loader />
          ) : !timeline.data?.length ? (
            <div className="empty">No activity yet. Start a conversation.</div>
          ) : (
            timeline.data.map((item) => (
              <article className="timeline-item" key={item.kind + item.id}>
                <div className="timeline-dot" />
                <div>
                  <div className="timeline-title">
                    <b>
                      {item.kind === "lead_status_history"
                        ? "Stage changed"
                        : item.kind === "assignments"
                          ? "Lead assigned"
                          : item.kind}
                    </b>
                    <small>{date(item.created_at)}</small>
                  </div>
                  <p>
                    {item.kind === "lead_status_history"
                      ? `${statusLabel(item.from_status)} → ${statusLabel(item.to_status)}`
                      : item.body ||
                        item.notes ||
                        item.outcome ||
                        item.stage ||
                        item.status ||
                        "Assignment updated"}
                  </p>
                  {item.kind === "lead_status_history" && item.lost_reason && (
                    <small>
                      Lost reason: {lostReasonLabel(item.lost_reason)}
                    </small>
                  )}
                  {item.due_at && <small>Due {date(item.due_at)}</small>}
                  {item.scheduled_at && (
                    <small>Visit {date(item.scheduled_at)}</small>
                  )}
                  {item.kind === "calls" && (
                    <>
                      <p>
                        {callMethodLabel(item)} call · {item.status}
                        {item.method === "manual" &&
                          ` · ${item.answered ? "Answered" : "Unanswered"}`}
                        {` · ${item.duration_seconds || 0}s`}
                      </p>
                      <small>Started {date(item.started_at)}</small>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setCall(item);
                          setModal("outcome");
                        }}
                      >
                        {item.outcome ? "Edit outcome" : "Add outcome"}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      </div>
      <LeadKycDocuments key={id} leadId={id} />
      {modal === "dial" && (
        <CallDialog
          lead={lead}
          role={user.role}
          onClose={() => setModal("")}
          onSaved={refresh}
        />
      )}
      {modal && modal !== "dial" && (
        <Modal
          title={
            {
              edit: "Edit lead",
              assign: "Assign lead",
              note: "Add note",
              call: "Development mock call",
              manual: "Log a call",
              outcome: "Call outcome",
              followups: "Schedule follow-up",
              visits: "Schedule site visit",
              deals: "Add deal",
            }[modal]
          }
          onClose={() => {
            if (manualPending.current || busy) return;
            setModal("");
            setCall(null);
          }}
        >
          {modal === "edit" ? (
            <LeadForm
              initial={lead}
              onSave={async (data) => {
                await api("/leads/" + id, { method: "PATCH", body: data });
                refresh();
              }}
            />
          ) : modal === "assign" ? (
            <RecordForm
              fields={[
                {
                  key: "agent_id",
                  label: "Agent (leave blank for round-robin)",
                  options: (users.data || [])
                    .filter((u) => u.role === "agent" && u.active)
                    .map((u) => ({ value: u.id, label: u.name })),
                },
              ]}
              onSave={async (data) => {
                await api("/leads/" + id + "/assign", {
                  method: "POST",
                  body: { agent_id: data.agent_id || null },
                });
                refresh();
              }}
            />
          ) : modal === "note" ? (
            <RecordForm
              fields={[
                {
                  key: "body",
                  label: "Note",
                  type: "textarea",
                  required: true,
                },
              ]}
              onSave={async (data) => {
                await api("/notes", {
                  method: "POST",
                  body: { ...data, lead_id: id },
                });
                refresh();
              }}
            />
          ) : modal === "manual" ? (
            <OutcomeForm
              manual
              role={user.role}
              onPending={(value) => {
                manualPending.current = value;
                setBusy(value);
              }}
              onSave={async (data) => {
                await api(`/leads/${id}/calls/manual`, {
                  method: "POST",
                  body: data,
                });
                refresh();
              }}
            />
          ) : modal === "call" ? (
            <>
              <p className="notice">
                Development mock only. No real phone call has been placed.
              </p>
              <p>Call reference: {call?.id}</p>
              <Button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const c = await api(
                      "/calls/" + call.id + "/mock-complete",
                      { method: "POST" },
                    );
                    setCall(c);
                    setModal("outcome");
                    invalidateWorkspace(qc);
                  })
                }
              >
                Complete mock call & add outcome
              </Button>
            </>
          ) : modal === "outcome" ? (
            <OutcomeForm
              call={call}
              onSave={async (data) => {
                await api("/calls/" + call.id, { method: "PATCH", body: data });
                refresh();
              }}
            />
          ) : (
            <ActivityForm
              entity={modal}
              leadId={id}
              onSave={async (data) => {
                await api("/" + modal, { method: "POST", body: data });
                refresh();
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
}
