export const followUpReminders = (db) =>
  db.rpc("run_crm_job", { p_job: "followups", p_settings: {} });
