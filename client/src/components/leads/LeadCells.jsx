import { useState } from "react";
import { Link } from "react-router-dom";
import { date } from "../../lib/api";
import { temperatureOf } from "../../lib/temperature";
// Table cells shared by an agent's Assigned leads and Lead pipeline
// (updates 052 and 053). `back` is the list's address, so Back to leads
// returns to the same search, filters and page.
// email={false}: the name only (administrators' All leads, update 057).
export function CustomerCell({ lead, back, email = true }) {
  return (
    <Link className="customer-link" to={"/leads/" + lead.id} state={{ back }}>
      <span className="avatar small">{lead.name[0]}</span>
      <div>
        <b>{lead.name}</b>
        {email && <small>{lead.email || "No email"}</small>}
        <WorkspaceBadges lead={lead} />
      </div>
    </Link>
  );
}
// Update 061: a lead that came to the agent from another agent. Reassigned
// stays for the whole assignment; New, and the previous assignment's result
// when it was Not interested, only until the agent's first call.
export function WorkspaceBadges({ lead }) {
  if (!lead.reassigned) return null;
  const fresh = !lead.first_call_at;
  return (
    <span className="workspace-flags">
      <span className="workspace-flag reassigned">Reassigned</span>
      {fresh && <span className="workspace-flag new">New</span>}
      {fresh && lead.previous_result === "not_interested" && (
        <span className="workspace-flag previous">
          Previously not interested
        </span>
      )}
    </span>
  );
}
export function DetailsLink({ lead, back }) {
  return (
    <Link
      className="button secondary lead-details-link"
      to={"/leads/" + lead.id}
      state={{ back }}
      aria-label={`View details for ${lead.name}`}
    >
      View details
    </Link>
  );
}
// The lead's latest call: its outcome, whether it connected, and when.
export function LastCallCell({ lead }) {
  if (!lead.last_call_at)
    return <span className="lead-muted">Not called yet</span>;
  return (
    <span className="lead-last-call">
      <span
        className={`badge plain ${lead.last_call_connected ? "completed" : "warning"}`}
      >
        {lead.last_call_outcome || "Call in progress"}
      </span>
      <small>{date(lead.last_call_at)}</small>
    </span>
  );
}
// The agent's own latest note, two lines at first; Read more shows it all.
export function NoteCell({ lead }) {
  const [open, setOpen] = useState(false);
  if (!lead.note) return <span className="lead-muted">No notes yet</span>;
  const long = lead.note.length > 90 || lead.note.includes("\n");
  return (
    <span className="lead-note">
      <span className={open ? "lead-note-text open" : "lead-note-text"}>
        {lead.note}
      </span>
      <small>
        {date(lead.note_at)}
        {long && (
          <>
            {" · "}
            <button
              type="button"
              className="lead-note-more"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Show less" : "Read more"}
            </button>
          </>
        )}
      </small>
    </span>
  );
}
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
});
// The next pending follow-up, marked overdue or due today (Pakistan time).
export function FollowUpCell({ lead, now = Date.now() }) {
  if (!lead.next_followup_at) return "—";
  const at = Date.parse(lead.next_followup_at);
  const state =
    at < now
      ? ["overdue", "Overdue"]
      : dayFormatter.format(at) === dayFormatter.format(now)
        ? ["warning", "Due today"]
        : null;
  return (
    <span className="lead-followup">
      {state && <span className={`badge plain ${state[0]}`}>{state[1]}</span>}
      <small>{date(lead.next_followup_at)}</small>
    </span>
  );
}
export function TemperatureBadge({ value }) {
  const t = temperatureOf(value);
  if (!t) return <span className="temperature none">Not recorded</span>;
  return (
    <span className={`temperature ${t.value}`}>
      <span aria-hidden="true">{t.emoji}</span> {t.label}
    </span>
  );
}
