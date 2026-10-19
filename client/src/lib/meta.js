import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
export const metaApi = "/integrations/meta";
export function useMetaSummary(user) {
  return useQuery({
    queryKey: ["meta-summary", user.id],
    queryFn: () => api(metaApi + "/summary"),
    enabled: user.role === "admin",
    staleTime: 20000,
    refetchInterval: 30000,
  });
}
export const platformLabel = (value) =>
  ({ facebook: "Facebook", instagram: "Instagram", meta: "Meta / unknown" })[
    value
  ] || value;
export const metaStatus = (value) =>
  ({
    queued: "Queued",
    processing: "Processing",
    retry: "Retry scheduled",
    created: "New customer",
    duplicate: "Repeat inquiry",
    review: "Needs review",
    failed: "Processing failed",
    connected: "Connected",
    attention: "Reconnect required",
    disconnected: "Disconnected",
  })[value] || value;
