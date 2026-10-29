import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleAlert, Clock } from "lucide-react";
import { api } from "../../lib/api";
import { clockLabel, pkTime } from "../../lib/attendance";
import { fullDayLabel } from "../../lib/calendar";
import { invalidateTasks, percent } from "../../lib/tasks";
import { useAuth } from "../../context/AuthContext";
import { Button, ErrorBox, Modal, useToast } from "../common/UI";
// Checkout rules (update 045) for the signed-in agent: what checking out
// needs today and the early and emergency requests. The server decides every
// rule (task_checkout_state); this only explains it.
function Requirement({ ok, children }) {
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <li className={ok ? "met" : "unmet"}>
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
      <span className="visually-hidden">{ok ? "(done)" : "(not yet)"}</span>
    </li>
  );
}

export function CheckoutRequestForm({ kind, state, onDone, onCancel }) {
  const qc = useQueryClient(),
    toast = useToast(),
    { user } = useAuth();
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const t = state.tasks || {};
  const emergency = kind === "emergency";
  // After a rejection the server needs a new explanation (update 045).
  const again = state[`${kind}_resubmission`] || {};
  const explain = !!again.explanation_required;
  async function send(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/tasks/checkout-requests", {
        method: "POST",
        body: { kind, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      invalidateTasks(qc);
      toast("Request sent to the administrators");
      onDone();
    } catch (e) {
      setError(e.message);
      invalidateTasks(qc);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="checkout-request-form">
      <dl className="task-facts">
        <div>
          <dt>Employee</dt>
          <dd>{user?.name}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{fullDayLabel(state.date)}</dd>
        </div>
        <div>
          <dt>Time now</dt>
          <dd>{pkTime(new Date())}</dd>
        </div>
        <div>
          <dt>Normal shift end</dt>
          <dd>{clockLabel(state.shift_end)}</dd>
        </div>
        <div>
          <dt>Tasks due today</dt>
          <dd>
            {t.due_completed ?? 0} of {t.due_count ?? 0} completed
          </dd>
        </div>
        <div>
          <dt>Completion</dt>
          <dd>{percent(t.completion_percent)}</dd>
        </div>
        <div>
          <dt>Daily report</dt>
          <dd>{state.report_submitted ? "Submitted" : "Not submitted"}</dd>
        </div>
      </dl>
      {explain && (
        <div className="checkout-rejected" role="note">
          <p>
            Your last {emergency ? "emergency" : "early"} checkout request was
            rejected
            {again.last_rejected_by ? ` by ${again.last_rejected_by}` : ""}
            {again.last_rejected_at
              ? ` at ${pkTime(again.last_rejected_at)}`
              : ""}
            {again.last_rejection_note
              ? `: “${again.last_rejection_note}”`
              : "."}
          </p>
          <p className="field-hint">
            You can ask again by explaining what has changed. Request{" "}
            {again.count + 1} of {again.limit} today.
          </p>
        </div>
      )}
      <label>
        {explain
          ? "What has changed since your last request? (required)"
          : emergency
            ? "What happened? (required)"
            : "Remarks (optional)"}
        <textarea
          rows={3}
          maxLength={500}
          required={emergency || explain}
          minLength={explain ? 10 : emergency ? 5 : undefined}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {emergency && (
        <p className="field-hint">
          Only administrators see your reason. If you must leave before anyone
          answers, leave safely: your request stays on record, and you can
          request a check-out correction for the time you left.
        </p>
      )}
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send Request to Admin"}
        </Button>
      </footer>
    </form>
  );
}

export default function CheckoutPanel({ state, compact = false }) {
  const qc = useQueryClient(),
    toast = useToast();
  const [asking, setAsking] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (!state?.required) return null;
  const t = state.tasks || {};
  const pending = state.pending_request,
    approved = state.approved_request;
  const checkedIn = state.attendance_state === "checked_in";
  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/checkout-requests/${pending.id}/cancel`, {
        method: "POST",
        body: {},
      });
      invalidateTasks(qc);
      toast("Request cancelled");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`panel checkout-panel${compact ? " compact" : ""}`}
      aria-labelledby="checkout-rules-title"
    >
      <div className="panel-heading">
        <h2 id="checkout-rules-title">Checking out today</h2>
        {checkedIn && (
          <span
            className={`badge ${state.can_check_out ? "completed" : "warning"}`}
          >
            {state.can_check_out ? "You can check out" : "Not yet"}
          </span>
        )}
      </div>
      <ul className="checkout-requirements">
        <Requirement ok={state.report_submitted}>
          Daily work report{" "}
          {state.report_submitted ? "submitted" : "not submitted yet"}
        </Requirement>
        <Requirement ok={!state.before_shift_end || !!approved}>
          {approved
            ? `${approved.kind === "early" ? "Early" : "Emergency"} checkout approved by ${approved.decided_by_name}${approved.waive_report ? " (report waived)" : ""}`
            : `Shift ends at ${clockLabel(state.shift_end)}; leaving earlier needs approval`}
        </Requirement>
        <Requirement ok={!!t.all_due_completed}>
          {t.due_count
            ? `${t.due_completed} of ${t.due_count} tasks due today completed`
            : "No tasks due today"}
          {t.overdue ? ` · ${t.overdue} overdue` : ""}
        </Requirement>
      </ul>
      {checkedIn && state.blocked_reason && (
        <p className="checkout-blocked" role="status">
          {state.blocked_reason}
        </p>
      )}
      {pending && (
        <div className="checkout-pending" role="status">
          <Clock size={16} aria-hidden="true" />
          <span>
            Your {pending.kind} checkout request from{" "}
            {pkTime(pending.requested_at)} is waiting for an administrator.
          </span>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            Cancel request
          </Button>
        </div>
      )}
      <ErrorBox error={error} />
      {checkedIn && (
        <div className="checkout-actions">
          {!state.report_submitted && (
            <Link className="button" to="/my-tasks#daily-report">
              Submit Daily Report
            </Link>
          )}
          {!approved && !pending && state.before_shift_end && (
            <>
              <Button
                variant={state.can_request_early ? "" : "secondary"}
                disabled={!state.can_request_early}
                onClick={() => setAsking("early")}
              >
                Request Early Checkout
              </Button>
              {state.can_request_emergency && (
                <Button
                  variant="secondary"
                  onClick={() => setAsking("emergency")}
                >
                  Request Emergency Checkout
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {checkedIn &&
        !approved &&
        !pending &&
        state.before_shift_end &&
        !state.can_request_early &&
        state.early_blockers?.length > 0 && (
          <p className="field-hint">
            Early checkout: {state.early_blockers.join(" ")}
          </p>
        )}
      {checkedIn &&
        !approved &&
        !pending &&
        state.before_shift_end &&
        state.emergency_resubmission?.limit_reached && (
          <p className="field-hint">
            You have used today's {state.emergency_resubmission.limit} emergency
            checkout requests. Please speak to an administrator.
          </p>
        )}
      {asking && (
        <Modal
          title={
            asking === "early"
              ? "Request Early Checkout"
              : "Request Emergency Checkout"
          }
          onClose={() => setAsking(null)}
        >
          <CheckoutRequestForm
            kind={asking}
            state={state}
            onDone={() => setAsking(null)}
            onCancel={() => setAsking(null)}
          />
        </Modal>
      )}
    </section>
  );
}
