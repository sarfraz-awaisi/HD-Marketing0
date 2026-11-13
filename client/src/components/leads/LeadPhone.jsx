import { Phone } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../common/UI";
import { countryName, flagOf } from "../../lib/countries";
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
// The flag of the number's country (update 065), or a globe when the
// number cannot be placed in one country. The number itself is unchanged.
export function PhoneFlag({ country }) {
  const name = countryName(country);
  return (
    <span className="phone-flag" role="img" aria-label={name} title={name}>
      {flagOf(country)}
    </span>
  );
}
export default function LeadPhone({ lead, onCall }) {
  const { user } = useAuth();
  const phone = visiblePhone(lead, user);
  if (!phone)
    return <span className="lead-phone-number">Number unavailable</span>;
  const number = (
    <span className="lead-phone-with-flag">
      <PhoneFlag country={lead.phone_country} />
      <span className="lead-phone-number">{phone}</span>
    </span>
  );
  if (!onCall) return number;
  return (
    <span className="lead-phone-call">
      {number}
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
