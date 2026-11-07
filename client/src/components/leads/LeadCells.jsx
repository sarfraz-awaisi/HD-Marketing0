import { Link } from "react-router-dom";
import { date } from "../../lib/api";
import { temperatureOf } from "../../lib/temperature";
// Table cells shared by an agent's Assigned leads and Lead pipeline
// (update 052). `back` is the list's address, so Back to leads returns to
// the same search, filters and page.
export function CustomerCell({ lead, back }) {
  return (
    <Link className="customer-link" to={"/leads/" + lead.id} state={{ back }}>
      <span className="avatar small">{lead.name[0]}</span>
      <div>
        <b>{lead.name}</b>
        <small>{lead.email || "No email"}</small>
      </div>
    </Link>
  );
}
// The lead's place in its file, the same on every page and after any filter.
export function FileNumber({ lead, withFile = false }) {
  if (!lead.file_row)
    return (
      <span className="file-number">
        <span aria-label="No file number">—</span>
        {withFile && <small>No file</small>}
      </span>
    );
  return (
    <span className="file-number">
      <b>{lead.file_row}</b>
      {withFile && <small title={lead.file_name}>{lead.file_name}</small>}
    </span>
  );
}
// Contacted (an answered call), attempted (calls, none answered) or never.
export function ContactCell({ lead }) {
  if (lead.contact === "contacted")
    return (
      <span className="lead-contact">
        <span className="badge plain completed">Contacted</span>
        <small>{date(lead.last_contact_at)}</small>
      </span>
    );
  if (lead.contact === "attempted")
    return <span className="badge plain warning">Attempted, no answer</span>;
  return <span className="badge plain">Never contacted</span>;
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
