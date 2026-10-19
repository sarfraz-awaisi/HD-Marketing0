export async function assign(db, req, lead, agent) {
  return db.rpc("assign_lead", {
    p_lead: lead,
    p_actor: req.user.id,
    p_agent: agent || null,
    p_request: req.id,
  });
}
