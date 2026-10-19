import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
export function useSecurityAlertSummary(enabled) {
  return useQuery({
    queryKey: ["security-alert-summary"],
    queryFn: () => api("/security-alerts/summary"),
    enabled,
    staleTime: 30000,
    refetchInterval: 60000,
  });
}
export function securityAlertLabel(type) {
  return (
    {
      phone_reveal_warning: "Number limit warning",
      phone_reveal_limit: "Number limit reached",
      mass_lead_deletion: "More than 50 leads deleted today",
      inactive_agent_leads: "Inactive account still owns leads",
      mfa_verification_failures: "Repeated authenticator failures",
      account_login_locked: "Sign-in locked after wrong passwords",
      after_hours_login: "Sign-in outside business hours",
    }[type] || type.replaceAll("_", " ")
  );
}
