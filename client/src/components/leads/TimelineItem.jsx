import { date } from "../../lib/api";
import { callMethodLabel } from "../../lib/calls";
import { followUpState, followUpStateLabel } from "../../lib/followups";
import { lostReasonLabel, statusLabel } from "../../lib/pipeline";
import { Badge, Button } from "../common/UI";
// One entry in a lead's activity timeline: what happened, who did it, and the
// details that matter for that kind of activity. The server adds actor_name
// (who did it), agent_name (who is responsible) and later updates from the
// existing audit log.
const titles = {
  notes: "Note",
  calls: "Call",
  followups: "Follow-up",
  visits: "Site visit",
  deals: "Deal",
  assignments: "Lead assigned",
  lead_status_history: "Stage changed",
  lead_update: "Lead details updated",
};
const list = (items) =>
  items.length > 1
    ? items.slice(0, -1).join(", ") + " and " + items.at(-1)
    : items[0] || "";
// Who did it, from the audit log, and who is responsible. When no record of
// the actor exists, only the responsible agent is shown, never as "By".
function byline(item) {
  const parts = [];
  if (item.actor_name) parts.push(`By ${item.actor_name}`);
  if (item.agent_name && ["followups", "visits", "deals"].includes(item.kind))
    parts.push(`Responsible: ${item.agent_name}`);
  if (
    item.kind === "calls" &&
    item.agent_name &&
    item.agent_name !== item.actor_name
  )
    parts.push(`Agent: ${item.agent_name}`);
  return parts.join(" · ");
}
export default function TimelineItem({ item, onOutcome }) {
  const updates = item.updates || [];
  return (
    <article className="timeline-item">
      <div className="timeline-dot" />
      <div>
        <div className="timeline-title">
          <b>{titles[item.kind] || item.kind}</b>
          <small>{date(item.created_at)}</small>
        </div>
        {byline(item) && <small className="timeline-by">{byline(item)}</small>}
        {item.kind === "notes" && <p>{item.body}</p>}
        {item.kind === "calls" && (
          <>
            <p>
              <b>{item.outcome || "No outcome yet"}</b>
            </p>
            {item.notes && <p>{item.notes}</p>}
            {item.deal_tags?.length > 0 && (
              <p className="timeline-tags" aria-label="Lead tags">
                {item.deal_tags.map((tag) => (
                  <span key={tag} className="badge plain">
                    {tag}
                  </span>
                ))}
              </p>
            )}
            <p>
              {callMethodLabel(item)} call · {item.status}
              {item.method === "manual" &&
                ` · ${item.answered ? "Answered" : "Unanswered"}`}
              {` · ${item.duration_seconds || 0}s`}
            </p>
            <small>Started {date(item.started_at)}</small>
            <Button variant="secondary" onClick={() => onOutcome(item)}>
              {item.outcome ? "Edit outcome" : "Add outcome"}
            </Button>
          </>
        )}
        {item.kind === "followups" && (
          <>
            <p>
              Due {date(item.due_at)} ·{" "}
              <Badge value={followUpStateLabel(followUpState(item))} />
            </p>
            {item.notes && <p>{item.notes}</p>}
            {item.completed_at && (
              <small>Completed {date(item.completed_at)}</small>
            )}
          </>
        )}
        {item.kind === "visits" && (
          <>
            <p>
              Visit {date(item.scheduled_at)} · <Badge value={item.status} />
            </p>
            {item.notes && <p>{item.notes}</p>}
          </>
        )}
        {item.kind === "deals" && (
          <>
            <p>
              <Badge value={item.stage} />
            </p>
            {item.notes && <p>{item.notes}</p>}
          </>
        )}
        {item.kind === "assignments" && (
          <p>
            {item.agent_name ? `Assigned to ${item.agent_name}` : "Unassigned"}
          </p>
        )}
        {item.kind === "lead_status_history" && (
          <>
            <p>
              {statusLabel(item.from_status)} → {statusLabel(item.to_status)}
            </p>
            {item.lost_reason && (
              <small>Lost reason: {lostReasonLabel(item.lost_reason)}</small>
            )}
          </>
        )}
        {item.kind === "lead_update" && <p>Changed {list(item.fields)}.</p>}
        {updates.length > 0 && (
          <ul className="timeline-updates" aria-label="Later changes">
            {updates.slice(-3).map((u) => (
              <li key={u.at + u.fields.join()}>
                <small>
                  {date(u.at)}:{" "}
                  {u.actor_name ? `${u.actor_name} changed` : "Changed"}{" "}
                  {list(u.fields)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
