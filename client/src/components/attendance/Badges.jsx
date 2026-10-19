import {
  punctualityInfo,
  requestStatusInfo,
  stateInfo,
} from "../../lib/attendance";
const Pill = ([label, tone] = []) => (
  <span className={`badge plain ${tone || ""}`}>{label || "—"}</span>
);
export const StateBadge = ({ state }) => Pill(stateInfo[state] || [state]);
export const PunctualityBadge = ({ value }) =>
  value ? Pill(punctualityInfo[value]) : <span className="muted">—</span>;
export const RequestBadge = ({ status }) =>
  Pill(requestStatusInfo[status] || [status]);
