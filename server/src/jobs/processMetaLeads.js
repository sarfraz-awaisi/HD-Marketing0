import { metaConfig, metaReady } from "../services/meta/config.js";
import { decryptToken } from "../services/meta/crypto.js";
import { graphClient, leadFields } from "../services/meta/graph.js";
import { normalizeSubmission } from "../services/meta/normalize.js";
import { metaRpc } from "../services/meta/rpc.js";
export async function processMetaLeads(db, options = {}) {
  if (!metaReady()) {
    const result = await db.rpc("meta_cleanup", {});
    if (result.error && !["PGRST202", "42883"].includes(result.error.code))
      throw new Error("Meta retention cleanup failed");
    return { skipped: true };
  }
  const retention = Number(process.env.META_ANSWER_RETENTION_DAYS || 30);
  if (!Number.isInteger(retention) || retention < 1 || retention > 90)
    throw new Error("Set Meta answer retention between 1 and 90 days.");
  const config = metaConfig(),
    graph = graphClient(config, options.metaFetch),
    rows = await metaRpc(db, "meta_claim", { p_limit: 10 });
  for (const row of rows) {
    try {
      const token = decryptToken(
          row.ciphertext,
          config.key,
          "page:" + row.page_id,
        ),
        lead = await graph.request(row.provider_lead_id, token, {
          fields: leadFields,
        });
      if (
        String(lead.id) !== row.provider_lead_id ||
        String(lead.form_id) !== row.form_id
      )
        throw Object.assign(new Error("Invalid response identity"), {
          code: "identity_mismatch",
          retry: false,
        });
      const normalized = normalizeSubmission(lead, row.mapping);
      await metaRpc(db, "meta_finish", {
        p_id: row.id,
        p_lease: row.lease_id,
        p_data: normalized.data,
        p_answers: normalized.answers,
        p_attribution: normalized.attribution,
        p_reason: normalized.reason,
        p_retention: retention,
      });
    } catch (error) {
      await metaRpc(db, "meta_fail", {
        p_id: row.id,
        p_lease: row.lease_id,
        p_code: [
          "authorization_expired",
          "permission_denied",
          "rate_limited",
          "provider_unavailable",
          "provider_rejected",
          "network_timeout",
          "identity_mismatch",
          "invalid_response",
          "credential_error",
          "response_too_large",
        ].includes(error.code)
          ? error.code
          : "processing_failed",
        p_retry: error.retry !== false,
      });
    }
  }
  await metaRpc(db, "meta_cleanup");
  return { processed: rows.length };
}
