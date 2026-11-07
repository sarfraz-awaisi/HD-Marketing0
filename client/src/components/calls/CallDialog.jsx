import { useEffect, useRef, useState } from "react";
import { api, pkr } from "../../lib/api";
import { Button, Modal } from "../common/UI";
import OutcomeForm from "./OutcomeForm";
// Calls a lead through the device's phone app (a tel: link, so Windows can
// hand it to Microsoft Phone Link), or opens WhatsApp, and logs the result
// with the existing manual-call endpoint. The number comes from the
// already-loaded lead, so opening the dialog makes no extra phone request.
export default function CallDialog({ lead, role, onClose, onSaved }) {
  const [started, setStarted] = useState(false),
    [saving, setSaving] = useState(false),
    [confirming, setConfirming] = useState(false);
  const confirm = useRef(null);
  // The question appears above the form; bring it into view and to focus.
  useEffect(() => {
    if (!confirming) return;
    confirm.current?.scrollIntoView?.({ block: "nearest" });
    confirm.current?.querySelector("button")?.focus();
  }, [confirming]);
  function requestClose() {
    if (saving) return;
    if (started && !confirming) {
      setConfirming(true);
      return;
    }
    onClose();
  }
  const budget =
    lead.budget_max || lead.budget_min
      ? `${pkr(lead.budget_min)} – ${lead.budget_max ? pkr(lead.budget_max) : "Open"}`
      : null;
  return (
    <Modal
      className="call-dialog"
      title={`Call ${lead.name}`}
      onClose={requestClose}
      animateClose={!started}
    >
      {confirming && (
        <div role="alert" className="call-dialog-confirm" ref={confirm}>
          <p>This call is not saved yet. Close without saving it?</p>
          <div className="actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirming(false)}
            >
              Keep logging
            </Button>
            <Button type="button" variant="danger" onClick={onClose}>
              Close without saving
            </Button>
          </div>
        </div>
      )}
      <OutcomeForm
        manual
        customer={{
          name: lead.name,
          phone: lead.phone,
          details: [lead.preferred_location, budget]
            .filter(Boolean)
            .join(" · "),
        }}
        role={role}
        onDialStart={() => setStarted(true)}
        onPending={setSaving}
        onCancel={requestClose}
        onSave={async (data) => {
          // The page that opened the dialog reports the result, including a
          // follow-up that could not be saved.
          onSaved(
            await api(`/leads/${lead.id}/calls/manual`, {
              method: "POST",
              body: data,
            }),
          );
        }}
      />
    </Modal>
  );
}
