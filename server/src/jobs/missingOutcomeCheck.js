export const missingOutcomeCheck = (db) =>
  db.rpc("run_crm_job", {
    p_job: "outcomes",
    p_settings: {
      grace_minutes: Number(process.env.OUTCOME_GRACE_MINUTES || 30),
    },
  });
