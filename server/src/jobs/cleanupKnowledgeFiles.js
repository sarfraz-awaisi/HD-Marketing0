export async function cleanupKnowledgeFiles(db, documentId) {
  let query = db
    .from("knowledge_file_cleanup")
    .select("id,storage_path")
    .lte("not_before", new Date().toISOString())
    .order("created_at")
    .limit(100);
  if (documentId) query = query.eq("document_id", documentId);
  const rows = await query;
  if (rows.error) throw new Error("Document file cleanup queue unavailable");
  if (!rows.data?.length) return { processed: 0 };
  const removed = await db.storage
    .from("knowledge-files")
    .remove(rows.data.map((r) => r.storage_path));
  if (removed.error) throw new Error("Document file cleanup will retry");
  const completed = await db
    .from("knowledge_file_cleanup")
    .delete()
    .in(
      "id",
      rows.data.map((r) => r.id),
    );
  if (completed.error) throw new Error("Document file cleanup will retry");
  return { processed: rows.data.length };
}
