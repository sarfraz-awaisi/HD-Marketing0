export const reportInactiveLeadOwners = (db) =>
  db.rpc("report_inactive_lead_owners", {});
