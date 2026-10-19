import { useState } from "react";
import { api, pkr } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { Badge, Button, Modal } from "../common/UI";
import OutcomeForm from "./OutcomeForm";
// Calls a lead through the device's phone app (a tel: link, so Windows can
// hand it to Microsoft Phone Link) and logs the result with the existing
// manual-call endpoint. The number comes from the already-loaded lead, so
// opening the dialog makes no extra phone request.
export default function CallDialog({ lead, role, onClose, onSaved }) {
  const [started, setStarted] = useState(false),
    [saving, setSaving] = useState(false),
    [confirming, setConfirming] = useState(false);
  function requestClose() {
    if (saving) return;
    if (started && !confirming) {
      setConfirming(true);
      return;
    }
    onClose();
  }
  return (
    <Modal
      className="call-dialog"
      title={`Call ${lead.name}`}
      onClose={requestClose}
      animateClose={!started}
    >
      <dl className="call-dialog-lead">
        <div>
          <dt>Lead</dt>
          <dd>{formatLeadNo(lead.lead_no)}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>
            <Badge value={lead.status} />
          </dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{lead.preferred_location || "—"}</dd>
        </div>
        {lead.budget_max || lead.budget_min ? (
          <div>
            <dt>Budget</dt>
            <dd>
              {pkr(lead.budget_min)} –{" "}
              {lead.budget_max ? pkr(lead.budget_max) : "Open"}
            </dd>
          </div>
        ) : null}
      </dl>
      {confirming && (
        <div role="alert" className="call-dialog-confirm">
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
        dial={lead.phone}
        role={role}
        onDialStart={() => setStarted(true)}
        onPending={setSaving}
        onSave={async (data) => {
          await api(`/leads/${lead.id}/calls/manual`, {
            method: "POST",
            body: data,
          });
          onSaved();
        }}
      />
    </Modal>
  );
}
