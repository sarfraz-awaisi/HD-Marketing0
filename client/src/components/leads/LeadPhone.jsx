import { Phone } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../common/UI";
// The number a signed-in user may see: admins see every lead, agents only
// their own; anything not in +country format is treated as unavailable.
export function visiblePhone(lead, user) {
  const permitted =
    user?.role === "admin" ||
    (user?.role === "agent" && lead.assigned_agent === user.id);
  return permitted &&
    typeof lead.phone === "string" &&
    /^\+\d{10,15}$/.test(lead.phone)
    ? lead.phone
    : null;
}
export default function LeadPhone({ lead, onCall }) {
  const { user } = useAuth();
  const phone = visiblePhone(lead, user);
  if (!phone)
    return <span className="lead-phone-number">Number unavailable</span>;
  if (!onCall) return <span className="lead-phone-number">{phone}</span>;
  return (
    <span className="lead-phone-call">
      <span className="lead-phone-number">{phone}</span>
      <Button
        type="button"
        variant="secondary"
        className="call-button"
        aria-label={`Call ${lead.name}`}
        onClick={() => onCall(lead)}
      >
        <Phone size={15} aria-hidden="true" />
        Call
      </Button>
    </span>
  );
}
