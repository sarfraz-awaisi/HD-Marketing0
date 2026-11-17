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
// Then their recordings and KYC files are removed from Storage at once,
// up to 20 batches of 100 each. A failure, or anything left, stays queued
// for the daily job; the leads themselves are already erased.
export async function removeErasedFiles(db, batches = 20) {
  try {
    for (let i = 0; i < batches && (await cleanLeadRecordings(db)) > 0; i++);
    for (
      let i = 0;
      i < batches && (await cleanupKnowledgeFiles(db)).processed > 0;
      i++
    );
    return true;
  } catch {
    return false;
  }
}
