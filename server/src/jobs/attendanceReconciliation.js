// Closes attendance sessions left open on earlier days as incomplete (never
// inventing a check-out) and sends the admins' daily attendance summary
// (update 040). It never changes lead ownership.
export const attendanceReconciliation = (db) =>
  db.rpc("run_crm_job", { p_job: "attendance", p_settings: {} });
