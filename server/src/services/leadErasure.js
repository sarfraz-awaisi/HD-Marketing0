import { leadManagementRpc } from "./leadManagement.js";
import { cleanLeadRecordings } from "../jobs/purgeDeletedLeads.js";
import { cleanupKnowledgeFiles } from "../jobs/cleanupKnowledgeFiles.js";
// Delete instantly (update 069): leads in Deleted leads, or a deleted
// file's leads, erased now by the database, as the daily job erases them.
export async function eraseRpc(db, name, args) {
  try {
    return await leadManagementRpc(db, name, args);
  } catch (error) {
    if (/^Lead management needs/.test(error.message))
      error.message = "Delete instantly needs CRM database update 069.";
    throw error;
  }
}
// Selecting every matching deleted lead, and the review before Delete
// instantly (update 071). Both only read.
export async function eraseReviewRpc(db, name, args) {
  try {
    return await leadManagementRpc(db, name, args);
  } catch (error) {
    if (/^Lead management needs/.test(error.message))
      error.message =
        "Selecting all deleted leads needs CRM database update 071.";
    throw error;
  }
}
// Then their recordings and KYC files are removed from Storage at once,
// up to 20 batches of 100 of each. The queues hold every erased lead's files
// not yet removed, this request's and any earlier ones, so a later Delete
// instantly (or the background job, when it runs) removes what is left.
// Update 071: the answer says what was removed, what is still queued and
// whether Storage failed; done only when nothing is left.
export async function removeErasedFiles(db, batches = 20) {
  const removed = { recordings: 0, documents: 0 };
  let failed = false;
  try {
    for (let i = 0; i < batches; i++)
      if (!(await cleanLeadRecordings(db, () => removed.recordings++))) break;
  } catch {
    failed = true;
  }
  try {
    for (let i = 0; i < batches; i++) {
      const { processed } = await cleanupKnowledgeFiles(db);
      removed.documents += processed;
      if (!processed) break;
    }
  } catch {
    failed = true;
  }
  const pending = await pendingErasedFiles(db);
  return {
    removed,
    pending,
    failed,
    done: !failed && !!pending && !pending.recordings && !pending.documents,
  };
}
// How many erased leads' files wait in the queues: counts only, never a file
// or customer, and at most 100 of each ("more" when there may be more). Null
// when the queues cannot be read.
export async function pendingErasedFiles(db) {
  try {
    const recordings = await db.rpc("lead_recording_cleanup_batch");
    const documents = await db
      .from("knowledge_file_cleanup")
      .select("id")
      .lte("not_before", new Date().toISOString())
      .limit(100);
    if (recordings.error || documents.error) return null;
    const pending = {
      recordings: (recordings.data || []).length,
      documents: (documents.data || []).length,
    };
    return {
      ...pending,
      more: pending.recordings >= 100 || pending.documents >= 100,
    };
  } catch {
    return null;
  }
}
// The answer to an erase: the leads, then their files (none to remove when no
// lead was erased).
export async function eraseAnswer(db, result) {
  const storage = result.erased ? await removeErasedFiles(db) : null;
  return { ...result, files_removed: storage ? storage.done : true, storage };
}
