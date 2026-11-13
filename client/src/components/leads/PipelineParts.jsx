import { date } from "../../lib/api";
import { callOutcomes } from "../../lib/calls";
import { temperatures, temperatureText } from "../../lib/temperature";
import { LeadSearch } from "./LeadSearch";
import CountryFilter from "./CountryFilter";
import { countryLabel } from "../../lib/countries";
// The Lead pipeline's filters and contact cell (updates 052 and 053), shared
// by an agent's own pipeline and administrators' view of one agent's
// pipeline (update 055). `f` holds the filters from the address; `set`
// changes some of them and goes back to page 1.
export const temperatureChoices = [
  ...temperatures.map((t) => [t.value, `${t.emoji} ${t.label}`]),
  ["none", "Not recorded yet"],
];
export function PipelineFilters({ f, set }) {
  return (
    <>
      <LeadSearch value={f.q} onSearch={(q) => set({ q })} />
      <select
        aria-label="Filter by temperature"
        value={f.temperature}
        onChange={(e) => set({ temperature: e.target.value })}
      >
        <option value="">All temperatures</option>
        {temperatureChoices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by call outcome"
        value={f.outcome}
        onChange={(e) => set({ outcome: e.target.value })}
      >
        <option value="">All outcomes</option>
        {callOutcomes.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <CountryFilter
        value={f.country}
        onChange={(country) => set({ country })}
      />
    </>
  );
}
// The chips for the filters in use, each removing its own filter.
export const pipelineFilterChips = (f, set) => [
  ...(f.q ? [[`Search: ${f.q}`, () => set({ q: null })]] : []),
  ...(f.temperature
    ? [
        [
          `Temperature: ${temperatureText(f.temperature)}`,
          () => set({ temperature: null }),
        ],
      ]
    : []),
  ...(f.outcome
    ? [[`Latest call: ${f.outcome}`, () => set({ outcome: null })]]
    : []),
  ...(f.country
    ? [[`Country: ${countryLabel(f.country)}`, () => set({ country: null })]]
    : []),
];
// Who recorded the latest answered call when it was not the agent (update
// 055, agents' own pipeline only); a call with no audit entry has no known
// caller, never a guessed one.
const answeredBy = {
  admin: "Logged by an administrator",
  agent: "Logged by another agent",
  unknown: "Caller not recorded",
};
// The latest answered call and, below it, a later call that did not
// connect, such as Number off; calls logged in the same minute share a start
// time, so the outcome decides.
export function ContactCell({ lead }) {
  return (
    <span className="lead-contact">
      <b>{date(lead.last_contact_at)}</b>
      <small>{lead.last_contact_outcome || "No outcome"}</small>
      {answeredBy[lead.answered_by] && (
        <small className="lead-answered-by">
          {answeredBy[lead.answered_by]}
        </small>
      )}
      {lead.last_call_at && !lead.last_call_connected && (
        <small className="lead-later-call">
          Later call: {lead.last_call_outcome || "in progress"}
        </small>
      )}
    </span>
  );
}
