export const unansweredOutcomes = ["No answer", "Busy", "Wrong number"];
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
