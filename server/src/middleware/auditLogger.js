export async function audit(db, req, action, entity, id, metadata = {}) {
  const { error } = await db.from("audit_log").insert({
    actor_id: req.user?.id,
    action,
    entity,
    entity_id: id,
    request_id: req.id,
    metadata,
  });
  if (error)
    throw Object.assign(new Error("Audit persistence failed"), { status: 503 });
}
