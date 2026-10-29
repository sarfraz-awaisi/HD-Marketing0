import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  clockLabel,
  pkTime,
  requestStatusInfo,
  stateLabel,
} from "../../lib/attendance";
import { fullDayLabel } from "../../lib/calendar";
import { invalidateTasks, percent } from "../../lib/tasks";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  useToast,
} from "../common/UI";
import { ReportDetail } from "./AdminReports";
// Early and emergency checkout requests (update 045). An approval lets that
// agent use the normal check-out on that workday only; nobody is checked out
// here. The server re-checks everything when you decide.
function Decide({ request: r, decision, onDone }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [note, setNote] = useState(""),
    [waive, setWaive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const approve = decision === "approve";
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/admin/tasks/checkout-requests/${r.id}/decide`, {
        method: "POST",
        body: {
          decision,
          ...(note.trim() ? { note: note.trim() } : {}),
          waive_report: r.kind === "emergency" && approve && waive,
        },
      });
      invalidateTasks(qc);
      toast(
        `${r.kind === "early" ? "Early" : "Emergency"} checkout ${approve ? "approved" : "rejected"}; ${r.user_name} was told`,
      );
      onDone();
    } catch (e) {
      setError(e.message);
      invalidateTasks(qc);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <p>
        {approve
          ? `${r.user_name} will be able to check out from My attendance${r.expired ? "" : " today"}. Attendance records the real time and any early departure; tasks stay as they are.`
          : `${r.user_name} stays checked in, and the normal checkout rules apply.`}
      </p>
      {approve && r.kind === "emergency" && !r.report_id && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={waive}
            onChange={(e) => setWaive(e.target.checked)}
          />
          Waive today's daily report for this checkout (it stays owed for later)
        </label>
      )}
      <label>
        {approve ? "Note (optional)" : "Reason (optional)"}
        <input
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" variant={approve ? "" : "danger"} disabled={busy}>
          {busy ? "Saving…" : approve ? "Approve" : "Reject"}
        </Button>
      </footer>
    </form>
  );
}

export default function CheckoutRequests() {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState("pending"),
    [kind, setKind] = useState(""),
    [deciding, setDeciding] = useState(null),
    [report, setReport] = useState(null);
  const params = new URLSearchParams({
    page,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
  });
  const q = useQuery({
    queryKey: ["checkout-requests", params.toString()],
    queryFn: ({ signal }) =>
      api("/admin/tasks/checkout-requests?" + params, { signal }),
    refetchInterval: 30000,
  });
  const rows = q.data?.data || [];
  return (
    <section className="panel">
      <div className="toolbar task-filters">
        <select
          aria-label="Request status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="pending">Waiting</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <select
          aria-label="Request type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Early and emergency</option>
          <option value="early">Early checkout</option>
          <option value="emergency">Emergency checkout</option>
        </select>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : rows.length ? (
        <ul className="request-list">
          {rows.map((r) => {
            const [label, tone] = r.expired
              ? ["Expired", ""]
              : requestStatusInfo[r.status] || [r.status, ""];
            const t = r.tasks_now || {};
            return (
              <li key={r.id} className={`request-card ${r.kind}`}>
                <header>
                  <div>
                    <b>
                      {r.kind === "early"
                        ? "Early checkout"
                        : "Emergency checkout"}
                    </b>{" "}
                    · {r.user_name}
                    <small> UID {r.user_uid}</small>
                  </div>
                  <span className={`badge ${tone}`}>{label}</span>
                </header>
                <dl className="task-facts">
                  <div>
                    <dt>Workday</dt>
                    <dd>{fullDayLabel(r.work_date)}</dd>
                  </div>
                  <div>
                    <dt>Asked at</dt>
                    <dd>
                      {pkTime(r.requested_at)} (shift ends{" "}
                      {clockLabel(r.shift_end?.slice(0, 5))})
                    </dd>
                  </div>
                  <div>
                    <dt>Completion</dt>
                    <dd>
                      {percent(r.completion_percent)} at the request
                      {t.due_count != null &&
                        ` · now ${t.due_completed} of ${t.due_count} due tasks done`}
                    </dd>
                  </div>
                  <div>
                    <dt>Daily report</dt>
                    <dd>
                      {r.report_id ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setReport(r.report_id)}
                        >
                          Submitted — view
                        </button>
                      ) : (
                        "Not submitted"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Attendance</dt>
                    <dd>{stateLabel(r.attendance_state)}</dd>
                  </div>
                  {r.decided_by_name && (
                    <div>
                      <dt>Decision</dt>
                      <dd>
                        {label} by {r.decided_by_name}
                        {r.decision_note && ` — “${r.decision_note}”`}
                        {r.waive_report && " · report waived"}
                        {r.used_at && ` · used at ${pkTime(r.used_at)}`}
                      </dd>
                    </div>
                  )}
                </dl>
                {r.reason && (
                  <p className="request-reason">
                    {r.kind === "emergency" ? "Reason: " : "Remarks: "}“
                    {r.reason}”
                  </p>
                )}
                {r.status === "pending" && (
                  <div className="review-buttons">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setDeciding({ request: r, decision: "reject" })
                      }
                    >
                      Reject
                    </Button>
                    {!(r.expired && r.kind === "early") && (
                      <Button
                        onClick={() =>
                          setDeciding({ request: r, decision: "approve" })
                        }
                      >
                        Approve
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty">
          {status === "pending"
            ? "No requests are waiting."
            : "No requests match."}
        </div>
      )}
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
      {deciding && (
        <Modal
          title={`${deciding.decision === "approve" ? "Approve" : "Reject"} ${deciding.request.kind} checkout?`}
          onClose={() => setDeciding(null)}
        >
          <Decide {...deciding} onDone={() => setDeciding(null)} />
        </Modal>
      )}
      {report && <ReportDetail id={report} onClose={() => setReport(null)} />}
    </section>
  );
}
