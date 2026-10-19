import { useQuery } from "@tanstack/react-query";
import { api, localISO } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { visitTime } from "../../lib/calendar";
// Warns (without blocking) when the lead's agent already has a scheduled
// visit within 60 minutes of the chosen time.
export default function VisitConflicts({ leadId, at, exclude }) {
  const when = useDebouncedValue(at ? localISO(at) : "");
  const valid = Boolean(leadId && when && !Number.isNaN(Date.parse(when)));
  const q = useQuery({
    queryKey: ["visit-conflicts", leadId, when, exclude],
    queryFn: ({ signal }) =>
      api(
        "/visits/conflicts?" +
          new URLSearchParams({
            lead_id: leadId,
            at: when,
            ...(exclude ? { exclude } : {}),
          }),
        { signal },
      ),
    enabled: valid,
  });
  const conflicts = Array.isArray(q.data?.conflicts) ? q.data.conflicts : [];
  if (!valid || !conflicts.length) return null;
  return (
    <div className="visit-conflict" role="status">
      <b>
        {conflicts[0].agent_name || "This agent"} already has{" "}
        {conflicts.length === 1 ? "a visit" : `${conflicts.length} visits`}{" "}
        within an hour of this time:
      </b>
      <ul>
        {conflicts.map((c) => (
          <li key={c.id}>
            {visitTime(c.scheduled_at)} · {formatLeadNo(c.lead_no)}{" "}
            {c.lead_name} · {c.property_title}
          </li>
        ))}
      </ul>
      <small>You can still save; check the travel time between visits.</small>
    </div>
  );
}
