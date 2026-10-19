// Flags missed first calls for admin review and sends the sales reminders
// (update 038). It never reassigns leads; an administrator decides.
export const leadResponseCheck = (db) =>
  db.rpc("run_crm_job", { p_job: "response", p_settings: {} });
