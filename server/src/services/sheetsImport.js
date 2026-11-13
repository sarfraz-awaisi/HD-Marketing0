import { randomBytes } from "node:crypto";
import { z } from "zod";
import { digest } from "./accountsSecurity.js";
import { phoneCountry, readPhone } from "../utils/internationalPhone.js";
// Google Sheets lead import (update 056). Meta Lead Ads write each
// advertisement's submissions to a Sheet; the Apps Script in
// integrations/google-sheets sends the rows here with the integration key.
// This module reads a row the way Meta writes it, by column heading, and
// checks it; the database decides what is new and imports it.

// The integration key: shown once to the administrator who creates it, kept
// only as a SHA-256 hash. 32 random bytes, so a fast hash is enough.
const keyPattern = /^hdcrm_sheets_[A-Za-z0-9_-]{43}$/;
export function newSyncKey() {
  const key = "hdcrm_sheets_" + randomBytes(32).toString("base64url");
  return { key, hash: digest(key), hint: key.slice(-4) };
}
export const syncKeyHash = (header) => {
  const match = /^Bearer (\S+)$/.exec(header || "");
  return match && keyPattern.test(match[1]) ? digest(match[1]) : null;
};

const failure = (message, status, code) =>
  Object.assign(new Error(message), { status, code });
export async function sheetsRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code))
    throw failure(
      "Google Sheets import needs CRM database update 056.",
      503,
      "SHEETS_UPDATE_REQUIRED",
    );
  const known = {
    HS401: ["Invalid integration key.", 401, "SHEETS_INVALID_KEY"],
    HS403: [
      "The administrator who created this integration key is no longer active. Create a new key in the CRM.",
      403,
      "SHEETS_KEY_OWNER_INACTIVE",
    ],
    HS409: [
      "This Sheet is turned off or not configured in the CRM.",
      409,
      "SHEETS_SOURCE_UNAVAILABLE",
    ],
    // Turning on a Sheet whose earlier rows would be imported (update 056).
    HS428: [
      "Confirm the historical import: turning this Sheet on imports rows submitted before it was added.",
      409,
      "SHEETS_CONFIRM_HISTORY",
    ],
    42501: ["Administrator access required.", 403],
  }[error.code];
  if (known) throw failure(...known);
  // The CRM's own messages for these, written for administrators.
  if (["22023", "23505", "P0002"].includes(error.code))
    throw failure(
      error.message,
      { 22023: 400, 23505: 409, P0002: 404 }[error.code],
    );
  if (["22P02", "22007", "22008"].includes(error.code))
    throw failure("Check the details and try again.", 400);
  throw failure(
    "The Google Sheets import could not be completed. Please try again.",
    503,
  );
}

// ------------------------------------------------------------ reading a row
// Headings as Meta writes them; the comparison ignores case and spacing, so
// "Full Name" finds full_name. Columns may come in any order, extra columns
// are kept, and a missing optional column is simply empty.
export const headingKey = (heading) =>
  String(heading).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "_");
const columns = {
  id: ["id", "lead_id"],
  created_time: ["created_time"],
  ad_id: ["ad_id"],
  ad_name: ["ad_name"],
  adset_id: ["adset_id"],
  adset_name: ["adset_name"],
  campaign_id: ["campaign_id"],
  campaign_name: ["campaign_name"],
  form_id: ["form_id"],
  form_name: ["form_name"],
  is_organic: ["is_organic"],
  platform: ["platform"],
  full_name: ["full_name", "name"],
  first_name: ["first_name"],
  last_name: ["last_name"],
  phone: ["phone_number", "phone"],
  email: ["email"],
  city: ["city"],
  lead_status: ["lead_status"],
};
const mapped = new Set(Object.values(columns).flat());
// The form's own questions: the first other column that mentions an
// interest or a budget, such as "what_are_you_interested_in?_" and
// "what_is_your_preferred_investment_budget?_".
const questions = { interest: /interest/, budget: /budget/ };
export const rejectionReasons = {
  id_invalid: "Meta lead ID missing or not recognised",
  phone_missing: "Phone number missing",
  phone_invalid: "Phone number not valid for its country",
  phone_needs_country:
    "Phone number has no country code and is not a Pakistani number",
  name_missing: "Customer name missing",
  name_too_long: "Customer name longer than 200 characters",
  date_missing: "Submission date missing or unreadable",
  value_too_long: "A cell is longer than 5,000 characters",
  lead_deleted: "This number is in Deleted leads",
};
const platforms = {
  fb: "facebook",
  facebook: "facebook",
  ig: "instagram",
  instagram: "instagram",
  msg: "messenger",
  messenger: "messenger",
  an: "audience_network",
  audience_network: "audience_network",
};
const text = (value) =>
  String(value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .trim();
const cut = (value, max) => (value ? value.slice(0, max) : null);
// Meta prefixes its IDs in Sheets (l:, ag:, as:, c:, f:); the prefix is kept
// in the original values only.
const plainId = (value) => cut(value.replace(/^[a-z]{1,3}:/i, ""), 100);
export const metaLeadId = (value) => {
  const id = text(value).replace(/^l:/i, "");
  return /^\d{1,40}$/.test(id) ? id : null;
};
// Meta writes "p:+923001234567". Numbers from any country are read with
// their country's rules (update 064, utils/internationalPhone.js); one
// without a country code is read for the row's country column when it says
// clearly which country, otherwise as Pakistani (03XX…, or 3XX… whose
// leading zero a number cell dropped). Throws with the rejection reason.
export function sheetPhone(value, country = "") {
  const read = readPhone(
    text(value).replace(/^p:\s*/i, ""),
    phoneCountry(country),
  );
  if (read.error)
    throw Object.assign(new Error("Phone number not accepted"), {
      code: read.error,
    });
  return read.phone;
}
// Meta's created_time, such as 2026-11-01T10:15:30+0500 or the script's
// 2026-11-01T05:15:30.000Z. A time without a zone is Pakistan time.
export function submittedAt(value) {
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      text(value),
    );
  if (!m) return null;
  const zone = !m[3]
    ? "+05:00"
    : m[3].toUpperCase() === "Z"
      ? "Z"
      : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const time = new Date(
    `${m[1]}T${m[2].replace(/(\.\d{3})\d+$/, "$1")}${zone}`,
  );
  return Number.isNaN(time.getTime()) ||
    time < new Date("2010-01-01T00:00:00Z") ||
    time.getTime() > Date.now() + 86400000
    ? null
    : time.toISOString();
}
const yesNo = (value) =>
  /^(true|yes|1)$/i.test(value)
    ? true
    : /^(false|no|0)$/i.test(value)
      ? false
      : null;
const email = z.email().max(320);

// One Sheet row ({row, values: {heading: text}}) as the database imports it:
// a rejection with its reason, or the lead and the inquiry. The customer's
// phone number goes only to the lead's protected number.
export function readSheetRow({ row, values }) {
  const byKey = new Map();
  for (const heading of Object.keys(values)) {
    const key = headingKey(heading);
    if (key && !byKey.has(key)) byKey.set(key, heading);
  }
  const get = (field) => {
    for (const key of columns[field]) {
      const value = text(values[byKey.get(key)]);
      if (value) return value;
    }
    return "";
  };
  const question = (pattern) => {
    for (const [key, heading] of byKey)
      if (!mapped.has(key) && pattern.test(key)) return [heading, key];
    return [];
  };
  const id = metaLeadId(get("id"));
  if (!id) return { row, meta_lead_id: null, error: "id_invalid" };
  const reject = (error) => ({ row, meta_lead_id: id, error });
  if (Object.values(values).some((v) => String(v ?? "").length > 5000))
    return reject("value_too_long");
  const name = (
    get("full_name") || [get("first_name"), get("last_name")].join(" ")
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return reject("name_missing");
  if (name.length > 200) return reject("name_too_long");
  let phone;
  try {
    // A country column, when the form asks for one, stays in the answers.
    phone = sheetPhone(get("phone"), text(values[byKey.get("country")]));
  } catch (error) {
    return reject(error.code || "phone_invalid");
  }
  const [interestHeading, interestKey] = question(questions.interest);
  const [budgetHeading, budgetKey] = question(questions.budget);
  const phoneHeadings = new Set(
    columns.phone.map((key) => byKey.get(key)).filter(Boolean),
  );
  const answers = {},
    extra = {};
  for (const [heading, value] of Object.entries(values)) {
    const kept = text(value);
    if (!kept || phoneHeadings.has(heading)) continue;
    answers[heading] = kept;
    const key = headingKey(heading);
    if (!mapped.has(key) && key !== interestKey && key !== budgetKey)
      extra[heading] = kept;
  }
  const mail = get("email");
  const city = get("city");
  const platform = get("platform").toLowerCase();
  return {
    row,
    meta_lead_id: id,
    phone,
    lead: {
      name,
      email: email.safeParse(mail).success ? mail : null,
      preferred_location: cut(city, 200),
    },
    inquiry: {
      submitted_at: submittedAt(get("created_time")),
      platform: platform ? platforms[platform] || "other" : null,
      is_organic: yesNo(get("is_organic")),
      ad_id: plainId(get("ad_id")),
      ad_name: cut(get("ad_name"), 500),
      adset_id: plainId(get("adset_id")),
      adset_name: cut(get("adset_name"), 500),
      campaign_id: plainId(get("campaign_id")),
      campaign_name: cut(get("campaign_name"), 500),
      form_id: plainId(get("form_id")),
      form_name: cut(get("form_name"), 500),
      full_name: name,
      email: cut(mail, 320),
      city: cut(city, 500),
      interest: cut(text(values[interestHeading]), 1000),
      budget: cut(text(values[budgetHeading]), 1000),
      meta_lead_status: cut(get("lead_status"), 100),
      answers,
      extra,
    },
  };
}

// ------------------------------------------------------------ requests
const cell = z.union([z.string().max(50000), z.number(), z.boolean()]);
export const pendingBody = z
  .object({
    ids: z.array(z.union([z.string().max(200), z.number()])).max(10000),
  })
  .strict();
export const rowsBody = z
  .object({
    rows: z
      .array(
        z
          .object({
            row: z.number().int().min(2).max(1000000),
            values: z
              .record(z.string().min(1).max(200), cell)
              .refine((v) => Object.keys(v).length <= 100, {
                message: "At most 100 columns",
              }),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const reportBody = z
  .object({
    ok: z.boolean(),
    complete: z.boolean().optional(),
    error: z
      .enum([
        "spreadsheet_unavailable",
        "worksheet_missing",
        "headers_missing",
        "read_failed",
        "rows_failed",
        "too_many_rows",
      ])
      .optional(),
    rows: z.number().int().min(0).max(1000000).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
// A spreadsheet's link or its ID.
export const spreadsheetId = (value) => {
  const input = text(value);
  const id =
    /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:[/?#]|$)/.exec(input)?.[1] ||
    input;
  return /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : null;
};
// A start date (YYYY-MM-DD) is the start of that day in Pakistan.
const startDate = z
  .union([
    z.iso.date(),
    z.iso.datetime({ offset: true }),
    z.literal(""),
    z.null(),
  ])
  .transform((v) => (!v ? null : /T/.test(v) ? v : `${v}T00:00:00+05:00`));
// confirm_history: the administrator confirmed importing the rows submitted
// before the Sheet was added (needed to turn such a Sheet on).
const sourceFields = {
  name: z.string().trim().min(1).max(200),
  worksheet: z.string().trim().min(1).max(100),
  import_from: startDate,
  enabled: z.boolean(),
  confirm_history: z.literal(true),
};
export const sourceCreate = z
  .object({
    ...sourceFields,
    spreadsheet: z
      .string()
      .max(500)
      .transform((v, ctx) => {
        const id = spreadsheetId(v);
        if (!id)
          ctx.addIssue({
            code: "custom",
            message: "Paste the Google Sheet's link or its ID",
          });
        return id;
      }),
    import_from: startDate.optional(),
    enabled: z.boolean().default(false),
    confirm_history: z.literal(true).optional(),
  })
  .strict();
export const sourceUpdate = z
  .object(sourceFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

// The lead page's advertisement inquiries; none before update 056.
export async function leadInquiries(db, user, leadId) {
  try {
    return await sheetsRpc(db, "lead_ad_inquiries", {
      p_actor: user.id,
      p_lead: leadId,
    });
  } catch (error) {
    if (error.code === "SHEETS_UPDATE_REQUIRED") return [];
    throw error;
  }
}
