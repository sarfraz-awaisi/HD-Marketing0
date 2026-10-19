export async function reminders(db) {
  return db.rpc("run_crm_job", { p_job: "followups", p_settings: {} });
}
