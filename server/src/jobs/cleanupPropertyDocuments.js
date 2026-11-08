// Property documents (update 054), as for property photos: queue rows remain
// until Storage confirms removal, and repeating a removal is safe. Rows not
// yet due are reservations for uploads in progress.
export async function cleanupPropertyDocuments(db, propertyId) {
  let query = db
    .from("property_document_cleanup")
    .select("id,storage_path")
    .lte("not_before", new Date().toISOString())
    .order("created_at")
    .limit(100);
  if (propertyId) query = query.eq("property_id", propertyId);
  const queued = await query;
  if (queued.error)
    throw new Error("Property document cleanup queue unavailable");
  const rows = queued.data || [];
  if (!rows.length) return { processed: 0 };
  const removed = await db.storage
    .from("property-documents")
    .remove(rows.map((row) => row.storage_path));
  if (removed.error) throw new Error("Property document cleanup will retry");
  const completed = await db
    .from("property_document_cleanup")
    .delete()
    .in(
      "id",
      rows.map((row) => row.id),
    );
  if (completed.error) throw new Error("Property document cleanup will retry");
  return { processed: rows.length };
}
