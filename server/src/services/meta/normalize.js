import { z } from "zod";
import { normalizePhone } from "../../utils/phoneMask.js";
const aliases = {
  full_name: "name",
  name: "name",
  first_name: "first_name",
  last_name: "last_name",
  phone_number: "phone",
  phone: "phone",
  email: "email",
  city: "preferred_location",
  preferred_location: "preferred_location",
  budget_min: "budget_min",
  budget_max: "budget_max",
  interested_property: "interested_property",
  property_type: "property_type",
  preferred_contact_time: "contact_time",
  message: "message",
  comments: "message",
};
export const mappingTargets = [...new Set(Object.values(aliases))];
export function normalizeSubmission(lead, mapping = {}) {
  if (!Array.isArray(lead.field_data) || lead.field_data.length > 100)
    throw Object.assign(new Error("Invalid Meta response"), {
      code: "invalid_response",
      retry: false,
    });
  const data = {},
    answers = [];
  let warning;
  for (const field of lead.field_data) {
    if (
      typeof field.name !== "string" ||
      !Array.isArray(field.values) ||
      field.name.length > 200
    )
      throw Object.assign(new Error("Invalid Meta answers"), {
        code: "invalid_response",
        retry: false,
      });
    const values = field.values
      .filter((v) => typeof v === "string")
      .slice(0, 20)
      .map((v) => v.slice(0, 2000));
    answers.push({ name: field.name, values });
    const target =
      mapping[field.name] ??
      aliases[field.name.toLowerCase().replace(/\s+/g, "_")];
    if (target && mappingTargets.includes(target))
      data[target] = values.join("; ");
  }
  data.name = (
    data.name || [data.first_name, data.last_name].filter(Boolean).join(" ")
  ).trim();
  delete data.first_name;
  delete data.last_name;
  let reason = null;
  try {
    data.phone = normalizePhone(data.phone || "");
  } catch {
    delete data.phone;
    reason = "phone_missing_or_invalid";
  }
  if (!data.name || data.name.length > 200)
    reason = reason || "name_missing_or_invalid";
  if (data.email && !z.email().safeParse(data.email.trim()).success) {
    delete data.email;
    warning = "Invalid optional email omitted";
  } else if (data.email) data.email = data.email.trim();
  for (const key of ["budget_min", "budget_max"])
    if (data[key] !== undefined) {
      const number = Number(data[key].replace(/,/g, ""));
      if (!Number.isFinite(number) || number < 0 || number > 1e13) {
        delete data[key];
        warning = "Unrecognized budget kept in form answers";
      } else data[key] = number;
    }
  data.budget_min ??= 0;
  if (data.budget_max != null && data.budget_max < data.budget_min) {
    delete data.budget_max;
    warning = "Budget range needs review";
  }
  const platform =
    {
      fb: "facebook",
      facebook: "facebook",
      ig: "instagram",
      instagram: "instagram",
    }[String(lead.platform || "").toLowerCase()] || "meta";
  const attribution = { platform, warning };
  for (const key of [
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
  ])
    if (typeof lead[key] === "string")
      attribution[key] = lead[key].slice(0, 250);
  if (lead.created_time && Number.isFinite(Date.parse(lead.created_time)))
    attribution.submitted_at = new Date(lead.created_time).toISOString();
  return { data, answers, attribution, reason };
}
