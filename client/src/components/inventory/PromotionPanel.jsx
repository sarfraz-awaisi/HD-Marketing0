import { CircleCheck } from "lucide-react";
import { propertyRef } from "../../lib/inventory";
import { Button, ErrorBox } from "../common/UI";
// Update 044: an administrator adds an agent's listing to Admin Properties
// as an independent copy. The server decides eligibility (can_promote) and
// reports an existing copy (admin_copy); these components only present it.

// Shown in an agent listing's details, for administrators.
export function PromotionStatus({ property: p, busy, onAdd, onOpenCopy }) {
  if (p.admin_copy)
    return (
      <div className="promotion-status added" role="status">
        <CircleCheck size={18} aria-hidden="true" />
        <div>
          <b>Added to Admin List</b>
          <small>
            Admin copy {propertyRef(p.admin_copy.property_no)} is an independent
            listing.
          </small>
        </div>
        <Button variant="secondary" onClick={onOpenCopy}>
          Open admin copy
        </Button>
      </div>
    );
  if (p.can_promote)
    return (
      <div className="promotion-status">
        <p>
          Show this listing to every agent by adding an independent copy to
          Admin Properties.
        </p>
        <Button disabled={busy} onClick={onAdd}>
          Add to Admin List
        </Button>
      </div>
    );
  if (p.can_promote === false)
    return (
      <p className="field-hint">
        Only available or reserved listings can be added to the Admin list.
      </p>
    );
  return null;
}

// The confirmation, in place of the details.
export function PromoteConfirm({
  property: p,
  agent,
  busy,
  error,
  onCancel,
  onConfirm,
}) {
  const name = agent?.name || p.owner_agent_name || "Agent";
  return (
    <>
      <dl className="property-specs promotion-facts">
        <div>
          <dt>Property</dt>
          <dd>
            {propertyRef(p.property_no)} · {p.title}
          </dd>
        </div>
        <div>
          <dt>Listed by</dt>
          <dd>{name}</dd>
        </div>
        {agent?.uid != null && (
          <div>
            <dt>Agent UID</dt>
            <dd>{agent.uid}</dd>
          </div>
        )}
      </dl>
      <ul className="promotion-points">
        <li>
          This creates an independent copy in Admin Properties, with its own
          reference number and its own copies of the pictures.
        </li>
        <li>{name}'s original property stays unchanged and remains theirs.</li>
        <li>
          Future edits to the agent's property will not change the admin copy,
          and edits to the admin copy will not change the original.
        </li>
        <li>
          Administrators will be notified when the agent updates or deletes the
          original.
        </li>
        <li>
          The owner's contact details are copied for administrators only and are
          not shared with agents.
        </li>
      </ul>
      <ErrorBox error={error} />
      <div className="actions">
        <Button
          variant="secondary"
          disabled={busy}
          autoFocus
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {busy ? "Adding…" : "Add to Admin List"}
        </Button>
      </div>
    </>
  );
}

// Who originally listed a copy: shown to everyone. Administrators also see
// the original's reference and when it was added.
export function PromotedFrom({ promoted: f, dateText }) {
  const account =
    f.agent_status === "deleted"
      ? " (account deleted)"
      : f.agent_status === "inactive"
        ? " (account disabled)"
        : "";
  return (
    <section className="promotion-origin" aria-label="Original listing">
      <h3>Promoted from Agent Inventory</h3>
      <dl className="property-specs">
        <div>
          <dt>Originally listed by</dt>
          <dd>
            {f.agent_name}
            {account}
          </dd>
        </div>
        {f.agent_uid != null && (
          <div>
            <dt>Agent UID</dt>
            <dd>{f.agent_uid}</dd>
          </div>
        )}
        {f.source_property_no != null && (
          <div>
            <dt>Original property</dt>
            <dd>
              {propertyRef(f.source_property_no)}
              {f.source_removed ? " · deleted by the agent" : ""}
            </dd>
          </div>
        )}
        {f.source_property_no != null && f.promoted_at && (
          <div>
            <dt>Added to Admin Properties</dt>
            <dd>
              {[dateText(f.promoted_at), f.promoted_by_name]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
      </dl>
      {f.source_property_no != null && (
        <p className="field-hint">
          An independent copy: changes to the agent's listing do not change it,
          and changes here do not change theirs.
        </p>
      )}
    </section>
  );
}
