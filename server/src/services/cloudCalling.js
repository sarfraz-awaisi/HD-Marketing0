import { randomUUID } from "node:crypto";
export function callCapabilities() {
  return {
    manual: true,
    mock:
      process.env.CALL_PROVIDER === "mock" &&
      process.env.NODE_ENV !== "production",
    provider: false,
  };
}
export function callingProvider() {
  if (callCapabilities().mock)
    return {
      name: "development mock",
      async initiate() {
        return { id: "mock-" + randomUUID(), status: "initiated" };
      },
      async deleteRecording() {
        return true;
      },
    };
  throw Object.assign(new Error("Real calling provider is not configured"), {
    status: 503,
  });
}
