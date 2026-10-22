import { supabase } from "./supabase";
export async function api(path, options = {}) {
  const token =
    typeof options.headers?.Authorization === "string"
      ? null
      : (await supabase.auth.getSession()).data.session?.access_token;
  const headers = {
    Authorization: `Bearer ${token || ""}`,
    ...options.headers,
  };
  if (options.body && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch((import.meta.env.VITE_API_URL || "/api") + path, {
      ...options,
      headers,
      body:
        options.body instanceof FormData
          ? options.body
          : options.body
            ? JSON.stringify(options.body)
            : undefined,
    });
  } catch (cause) {
    if (options.signal?.aborted || cause?.name === "AbortError") throw cause;
    const error = new Error(
      "The CRM server could not be reached. Reload the page or contact your administrator.",
    );
    error.code = "API_UNREACHABLE";
    throw error;
  }
  if (!response.ok) {
    // Nginx refuses with a plain page when its own per-address limit is hit.
    const err = await response.json().catch(() => ({
      error:
        response.status === 429
          ? "Too many requests. Please wait a moment and try again."
          : "API unreachable",
    }));
    const error = new Error(err.error || "Request failed");
    error.status = response.status;
    if (
      typeof err.code === "string" &&
      (/^ACCOUNTS_[A-Z_]+$/.test(err.code) ||
        err.code === "EMAIL_CONFIRMATION_REQUIRED")
    ) {
      error.code = err.code;
      if (typeof err.locked_until === "string")
        error.lockedUntil = err.locked_until;
    }
    if (
      err.code === "mfa_required" ||
      String(err.code || "").startsWith("MFA_")
    )
      error.code = err.code;
    if (err.code === "mfa_required")
      window.dispatchEvent(new Event("hd:mfa-required"));
    if (err.code === "IMPORT_COLUMNS_REQUIRED" && Array.isArray(err.columns))
      Object.assign(error, {
        code: err.code,
        columns: err.columns,
        format: err.format,
        worksheet: err.worksheet,
      });
    throw error;
  }
  if (response.status === 204) return null;
  if (options.download) return response.blob();
  return response.json();
}
// React Query retry rule: one retry after a network or server error. A
// refusal (4xx, including 429 Too many requests) would only be refused again.
export const retryQuery = (failures, error) =>
  failures < 1 && !(error?.status >= 400 && error.status < 500);
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const moneyFormatter = new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});
export const pkr = (v) => moneyFormatter.format(v || 0);
const dateFormatter = new Intl.DateTimeFormat("en-PK", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Karachi",
});
export const date = (v) => (v ? dateFormatter.format(new Date(v)) : "—");
export const localISO = (v) =>
  v ? new Date(v + "+05:00").toISOString() : null;
export const localInput = (v) =>
  v
    ? new Date(new Date(v).getTime() + 5 * 3600000).toISOString().slice(0, 16)
    : "";
export function monthRange(
  month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .replace("/", "-"),
) {
  const parts = month.match(/^(\d{4})-(\d{2})$/);
  const m = parts
    ? month
    : new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7);
  const [y, n] = m.split("-").map(Number);
  return {
    from: new Date(Date.UTC(y, n - 1, 1) - 5 * 3600000).toISOString(),
    to: new Date(Date.UTC(y, n, 1) - 5 * 3600000).toISOString(),
  };
}
export const reportSearch = (range) => new URLSearchParams(range).toString();
