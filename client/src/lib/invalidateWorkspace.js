const leadKeys = new Set([
  "leads",
  "deleted-leads",
  "deleted-lead-imports",
  "security-alerts",
  "security-alert-summary",
  "lead",
  "timeline",
  "lead-options",
  "lead-imports",
  "lead-import",
  "dashboard",
  "metrics",
  "leaderboard",
  "dashboard-targets",
  "dashboard-followups",
  "dashboard-visits",
  "targets",
  "target-metrics",
  "followups",
  "visits",
  "deals",
  "calls",
  "reminders",
  "reports",
  "documents",
  "document",
  "meta-inbox",
  "meta-summary",
  "meta-report",
  "meta-submission",
  "audit",
  "kyc-clients",
  "kyc-client",
  "lead-review",
  "call-activity",
  "first-call-queue",
  "notifications",
  "visit-calendar",
  "visit-conflicts",
]);
export function invalidateWorkspace(client, family = "leads") {
  const keys =
    family === "properties"
      ? new Set([
          "properties",
          "property-options",
          "photos",
          "leads",
          "lead",
          "dashboard",
        ])
      : family === "documents"
        ? new Set(["documents", "document"])
        : leadKeys;
  return client.invalidateQueries({
    predicate: (query) => keys.has(query.queryKey[0]),
  });
}
