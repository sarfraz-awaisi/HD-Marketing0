import { useState } from "react";
import { api, date } from "../../lib/api";
import { copyText } from "../../lib/accountFields";
import {
  dealerStatus,
  dialable,
  formatDealerPhone,
  telLink,
  whatsappLink,
} from "../../lib/dealers";
import { Button, ErrorBox } from "../common/UI";

const historyLabels = {
  "dealer.create": "Added",
  "dealer.approve": "Approved",
  "dealer.reject": "Rejected",
  "dealer.update": "Details changed",
  "dealer.delete": "Deleted",
  "dealer.restore": "Restored",
};
const changeLabels = {
  name: "Dealer name",
  company_name: "Agency or company",
  address: "Address",
  city: "City",
  area: "Area or location",
  notes: "Notes",
};
export function DealerStatus({ status }) {
  const s = dealerStatus(status);
  return <span className={`badge fx-badge ${s.tone}`}>{s.label}</span>;
}
const personText = (p) =>
  p ? `${p.name}${p.uid ? ` (UID ${p.uid})` : ""}` : "—";

// One dealer. Agents see their own dealer's details and decision; the server
// sends administrators who added, reviewed and changed it, its history and
// the other records with the same number. Each action is one request, and
// buttons stay disabled until it finishes.
export default function DealerDetails({
  dealer: d,
  admin,
  onEdit,
  onChanged,
  onOpen,
}) {
  const [step, setStep] = useState(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  async function act(path, body, message) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/dealers/${d.id}/${path}`, {
        method: "POST",
        body,
      });
      setStep(null);
      setReason("");
      onChanged(saved, saved.unchanged ? "No change was needed" : message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const deleted = !!d.deleted_at;
  const rows = [
    ["Reference", d.reference],
    ["Status", <DealerStatus key="s" status={d.status} />],
    [
      "Contact number",
      <span key="p" className="dealer-phone">
        {formatDealerPhone(d.phone)}
        {dialable(d.phone) && (
          <span className="dealer-phone-actions">
            <a href={telLink(d.phone)}>Call</a>
            <a href={whatsappLink(d.phone)} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
            <button
              type="button"
              className="dealer-link"
              onClick={async () => setCopied(await copyText(d.phone))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
      </span>,
    ],
    ["Address", d.address],
    ["Agency or company", d.company_name],
    ["City", d.city],
    ["Area or location", d.area],
    ["Notes", d.notes],
    ["Submitted", date(d.created_at)],
    ...(d.reviewed_at
      ? [
          [
            d.status === "approved" ? "Approved" : "Rejected",
            date(d.reviewed_at),
          ],
        ]
      : []),
    ...(admin
      ? [
          [
            "Added by",
            d.submitted_by && (
              <span key="a">
                {personText(d.submitted_by)} ·{" "}
                {d.submitted_by.role === "admin" ? "Admin" : "Agent"}
                {d.submitted_by.active === false && " · account disabled"}
              </span>
            ),
          ],
          ["Reviewed by", d.reviewed_by?.name],
          [
            "Last changed by",
            d.updated_by && `${d.updated_by.name} · ${date(d.updated_at)}`,
          ],
          ...(deleted
            ? [
                [
                  "Deleted",
                  `${date(d.deleted_at)} by ${d.deleted_by?.name || "an administrator"}`,
                ],
                ["Delete reason", d.delete_reason],
              ]
            : []),
        ]
      : []),
  ];
  return (
    <div className="dealer-details">
      {d.status === "rejected" && (
        <div className="notice dealer-rejection" role="note">
          <strong>Rejected.</strong>{" "}
          {d.rejection_reason
            ? `Reason: ${d.rejection_reason}`
            : "No reason was given."}
          {!admin && " You can add this dealer again if the details change."}
        </div>
      )}
      {d.status === "pending" && !admin && (
        <p className="field-hint">Waiting for an administrator to review.</p>
      )}
      <dl className="dealer-fields">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || "—"}</dd>
          </div>
        ))}
      </dl>
      {admin && d.possible_duplicates?.length > 0 && (
        <section className="dealer-section" aria-label="Same contact number">
          <h3>Same contact number ({d.possible_duplicates.length})</h3>
          <p className="field-hint">
            Other records with this number. They are kept separately and never
            merged.
          </p>
          <ul className="dealer-list">
            {d.possible_duplicates.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className="dealer-link"
                  onClick={() => onOpen(o.id)}
                >
                  {o.reference} · {o.name}
                </button>{" "}
                — {personText(o.submitted_by)} ·{" "}
                {o.deleted ? "Deleted" : dealerStatus(o.status).label} ·{" "}
                {date(o.created_at)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {admin && d.history?.length > 0 && (
        <section className="dealer-section" aria-label="History">
          <h3>History</h3>
          <ol className="dealer-list">
            {d.history.map((h) => (
              <li key={h.id}>
                <strong>{historyLabels[h.action] || h.action}</strong> by{" "}
                {h.actor?.name || "Unknown user"} · {date(h.at)}
                {h.reason && <> · Reason: {h.reason}</>}
                {h.changes &&
                  Object.entries(h.changes).map(([key, c]) => (
                    <div key={key} className="field-hint">
                      {changeLabels[key] || key}: {c.before || "—"} →{" "}
                      {c.after || "—"}
                    </div>
                  ))}
                {h.action === "dealer.update" &&
                  h.fields?.includes("phone") && (
                    <div className="field-hint">Contact number changed</div>
                  )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <ErrorBox error={error} />
      {admin && step === "reject" && (
        <div className="dealer-confirm">
          <label>
            Reason for rejecting (optional; the agent sees it)
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setStep(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                act(
                  "reject",
                  { reason: reason.trim() || undefined },
                  "Dealer rejected",
                )
              }
            >
              {busy ? "Rejecting…" : "Reject dealer"}
            </Button>
          </div>
        </div>
      )}
      {admin && step === "delete" && (
        <div className="dealer-confirm">
          <p>
            Delete <strong>{d.reference}</strong> {d.name}? It leaves every
            list, including the agent's, and can be restored from Deleted.
          </p>
          <label>
            Reason (optional)
            <input
              maxLength={300}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              autoFocus
              onClick={() => setStep(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                act(
                  "delete",
                  { reason: reason.trim() || undefined },
                  "Dealer deleted",
                )
              }
            >
              {busy ? "Deleting…" : "Delete dealer"}
            </Button>
          </div>
        </div>
      )}
      {admin && !step && (
        <div className="actions">
          {deleted ? (
            <Button
              disabled={busy}
              onClick={() => act("restore", {}, "Dealer restored")}
            >
              {busy ? "Restoring…" : "Restore dealer"}
            </Button>
          ) : (
            <>
              {d.status === "pending" && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => act("approve", {}, "Dealer approved")}
                  >
                    {busy ? "Saving…" : "Approve"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setReason("");
                      setStep("reject");
                    }}
                  >
                    Reject
                  </Button>
                </>
              )}
              <Button variant="secondary" disabled={busy} onClick={onEdit}>
                Edit details
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setReason("");
                  setStep("delete");
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
