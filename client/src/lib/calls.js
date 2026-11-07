// Every call outcome. Number off (update 053: the phone is switched off) is
// for a call that did not connect, like the three before it.
export const callOutcomes = [
  "No answer",
  "Busy",
  "Wrong number",
  "Number off",
  "Interested",
  "Not interested",
  "Follow-up required",
  "Site visit scheduled",
  "Deal discussion",
];
// Outcomes of a call that did not connect.
export const unansweredOutcomes = [
  "No answer",
  "Busy",
  "Wrong number",
  "Number off",
];
export const callMethods = ["manual", "mock", "provider"];
export function callMethodLabel(call) {
  const method =
    call.method ||
    (call.provider_call_id?.startsWith("mock-") ? "mock" : "provider");
  return (
    { manual: "Manual", mock: "Mock", provider: "Provider" }[method] ||
    "Provider"
  );
}

// After a call is saved: whether the promised follow-up was scheduled.
export function followUpNotice(result, date) {
  if (result?.followup_error)
    return `Call saved, but its follow-up was not: ${result.followup_error} Schedule it from the lead or under Follow-ups.`;
  if (result?.followup)
    return `Call saved. Follow-up scheduled for ${date(result.followup.due_at)}.`;
  return null;
}
