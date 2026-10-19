import { formatLeadNo } from "../../lib/formatLeadNo";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import {
  Button,
  Modal,
  Table,
  Pagination,
  Badge,
  ErrorBox,
  Loader,
  useToast,
} from "../../components/common/UI";
import OutcomeForm from "../../components/calls/OutcomeForm";
import { callMethodLabel, callMethods } from "../../lib/calls";
export default function CallReview() {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState(""),
    [agent, setAgent] = useState(""),
    [method, setMethod] = useState(""),
    [modal, setModal] = useState(null),
    [recording, setRecording] = useState(null),
    [error, setError] = useState("");
  const qc = useQueryClient(),
    toast = useToast();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api("/users") });
  const q = useQuery({
    queryKey: ["calls", page, status, agent, method],
    queryFn: () =>
      api(
        "/calls?" +
          new URLSearchParams({
            page,
            ...(status ? { status } : {}),
            ...(agent ? { agent } : {}),
            ...(method ? { method } : {}),
          }),
      ),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">BETTER CONVERSATIONS, BETTER RESULTS</span>
          <h1>Call review</h1>
          <p>Review outcomes, notes and follow-through.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="toolbar">
          <select
            aria-label="Call method"
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All methods</option>
            {callMethods.map((value) => (
              <option key={value} value={value}>
                {callMethodLabel({ method: value })}
              </option>
            ))}
          </select>
          <select
            aria-label="Call status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {["initiated", "ringing", "completed", "failed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            aria-label="Agent"
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All agents</option>
            {users.data
              ?.filter((u) => u.role === "agent")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <>
            <Table
              showSerial
              page={page}
              count={q.data?.count}
              rows={q.data?.data || []}
              columns={[
                {
                  key: "method",
                  label: "Method",
                  render: (r) => <Badge value={callMethodLabel(r)} />,
                },
                {
                  key: "lead_id",
                  label: "Lead",
                  render: (r) => (
                    <Link to={"/leads/" + r.lead_id}>
                      {formatLeadNo(r.leads?.lead_no)} ·{" "}
                      {r.leads?.name || "Customer"} ↗
                    </Link>
                  ),
                },
                {
                  key: "started_at",
                  label: "Started",
                  render: (r) => date(r.started_at),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) => <Badge value={r.status} />,
                },
                { key: "duration_seconds", label: "Duration (s)" },
                {
                  key: "outcome",
                  label: "Outcome",
                  render: (r) => (
                    <>
                      {r.outcome || "Not submitted"}
                      {r.method === "manual" && (
                        <small>
                          {r.answered ? " · Answered" : " · Unanswered"}
                        </small>
                      )}
                      {r.missing_outcome && <Badge value="overdue" />}
                    </>
                  ),
                },
                { key: "notes", label: "Notes" },
                {
                  key: "deal_tags",
                  label: "Tags",
                  render: (r) => r.deal_tags?.join(", ") || "—",
                },
                {
                  key: "actions",
                  label: "Review",
                  render: (r) => (
                    <div className="actions">
                      <Button
                        variant="secondary"
                        style={{ minWidth: 104, whiteSpace: "nowrap" }}
                        onClick={() => setModal(r)}
                      >
                        Outcome
                      </Button>
                      {r.method !== "manual" && (
                        <Button
                          variant="secondary"
                          onClick={async () => {
                            try {
                              setRecording(
                                await api("/calls/" + r.id + "/recording"),
                              );
                              setError("");
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          Recording
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination page={page} count={q.data?.count} onPage={setPage} />
          </>
        )}
      </section>
      {modal && (
        <Modal title="Review call outcome" onClose={() => setModal(null)}>
          <OutcomeForm
            call={modal}
            onSave={async (data) => {
              await api("/calls/" + modal.id, { method: "PATCH", body: data });
              qc.invalidateQueries();
              toast("Outcome saved");
              setModal(null);
            }}
          />
        </Modal>
      )}
      {recording && (
        <Modal
          title="Authorized recording playback"
          onClose={() => setRecording(null)}
        >
          <p>This playback link expires after one minute.</p>
          <audio controls src={recording.signedUrl} />
        </Modal>
      )}
    </>
  );
}
