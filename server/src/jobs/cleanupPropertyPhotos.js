// Queue rows remain until Storage confirms removal. Repeating removal is safe
// if another worker or a previous interrupted attempt already removed a file.
export async function cleanupPropertyPhotos(db, propertyId) {
  let query = db
    .from("property_photo_cleanup")
    .select("id,storage_path")
    .order("created_at")
    .limit(100);
  if (propertyId) query = query.eq("property_id", propertyId);
  const queued = await query;
  if (queued.error) throw new Error("Property photo cleanup queue unavailable");
  const rows = queued.data || [];
  if (!rows.length) return { processed: 0 };
  const removed = await db.storage
    .from("property-photos")
    .remove(rows.map((row) => row.storage_path));
  if (removed.error) throw new Error("Property photo cleanup will retry");
  const completed = await db
    .from("property_photo_cleanup")
    .delete()
    .in(
      "id",
      rows.map((row) => row.id),
    );
  if (completed.error) throw new Error("Property photo cleanup will retry");
  return { processed: rows.length };
}
