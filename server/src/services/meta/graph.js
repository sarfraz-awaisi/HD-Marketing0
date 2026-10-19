import { createHmac } from "node:crypto";
export const leadFields =
  "id,created_time,form_id,field_data,platform,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name";
const failure = (code, retry = false) =>
  Object.assign(
    new Error(
      {
        authorization_expired:
          "Meta authorization expired or was revoked. Reconnect your account.",
        permission_denied:
          "Meta permission or Page lead access is missing. Review access and reconnect.",
        rate_limited: "Meta's request limit was reached. Try again later.",
        network_timeout: "Meta could not be reached. Try again shortly.",
      }[code] || "Meta request could not be completed.",
    ),
    {
      code,
      retry,
      status: 502,
    },
  );
export function graphClient(config, fetcher = fetch) {
  async function request(path, token, params = {}, method = "GET") {
    if (!/^[a-zA-Z0-9_/-]+$/.test(path)) throw failure("invalid_graph_path");
    const url = new URL(`https://graph.facebook.com/${config.version}/${path}`),
      body = new URLSearchParams(params);
    if (token)
      body.set(
        "appsecret_proof",
        createHmac("sha256", config.secret).update(token).digest("hex"),
      );
    if (method === "GET") url.search = body.toString();
    let response, payload;
    try {
      response = await fetcher(url, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(method === "GET" ? {} : { body }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw failure("response_too_large");
        chunks.push(Buffer.from(chunk));
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error.code === "response_too_large") throw error;
      throw failure("network_timeout", true);
    }
    if (!response.ok || payload.error) {
      const code = payload.error?.code;
      if (code === 190) throw failure("authorization_expired");
      if ([10, 200, 294].includes(code)) throw failure("permission_denied");
      if (response.status === 429 || [4, 17, 32, 613].includes(code))
        throw failure("rate_limited", true);
      if (response.status >= 500 || payload.error?.is_transient)
        throw failure("provider_unavailable", true);
      throw failure("provider_rejected");
    }
    return payload;
  }
  async function list(path, token, params = {}, maxPages = 10) {
    let rows = [],
      after;
    for (let i = 0; i < maxPages; i++) {
      const response = await request(path, token, {
        ...params,
        limit: "100",
        ...(after ? { after } : {}),
      });
      if (!Array.isArray(response.data) || response.data.length > 100)
        throw failure("invalid_response");
      rows.push(...response.data);
      after = response.paging?.cursors?.after;
      if (!response.paging?.next || !after)
        return { data: rows, truncated: false };
      if (typeof after !== "string" || after.length > 3000)
        throw failure("invalid_cursor");
    }
    return { data: rows, truncated: true };
  }
  return { request, list };
}
