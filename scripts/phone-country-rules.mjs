// Prints the phone-number country rules for crm_private.phone_country_rules
// (update 065), generated from libphonenumber-js's metadata, so the database
// decides a number's country exactly as the library does
// (parsePhoneNumber(...).country):
// * a calling code that belongs to one country gives that country;
// * a shared calling code (+1, +7, +44, …) tries its countries in the
//   library's order: by leading digits when the country has them, otherwise
//   by the country's number pattern and its number-type patterns.
// server/tests/phone-countries.test.js checks that the rules in the migration
// are the ones this prints for the installed library. When the library's
// numbering data changes, a new migration replaces the rows.
//
// Usage: node scripts/phone-country-rules.mjs  (prints SQL values)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../server/package.json", import.meta.url),
);
const metadata = require("libphonenumber-js/metadata.max.json");
const { Metadata } = require("libphonenumber-js/core");

const types = [
  "FIXED_LINE",
  "MOBILE",
  "PREMIUM_RATE",
  "TOLL_FREE",
  "SHARED_COST",
  "VOIP",
  "PERSONAL_NUMBER",
  "PAGER",
  "UAN",
  "VOICEMAIL",
];
// [calling_code, position, country, leading_digits, number_pattern,
// type_pattern]; nulls where the rule does not use them.
export function phoneCountryRules() {
  const data = new Metadata(metadata);
  const rows = [];
  for (const [code, countries] of Object.entries(
    metadata.country_calling_codes,
  ).sort(([a], [b]) => a.localeCompare(b))) {
    const geographic = countries.filter((c) => /^[A-Z]{2}$/.test(c));
    if (geographic.length !== countries.length) continue;
    if (countries.length === 1) {
      rows.push([code, 1, countries[0], null, null, null]);
      continue;
    }
    countries.forEach((country, i) => {
      data.selectNumberingPlan(country);
      const leading = data.leadingDigits() || null;
      const typePatterns = leading
        ? []
        : types
            .map((type) => data.type(type)?.pattern())
            .filter((pattern) => pattern);
      rows.push([
        code,
        i + 1,
        country,
        leading,
        leading ? null : data.nationalNumberPattern(),
        leading || !typePatterns.length ? null : typePatterns.join("|"),
      ]);
    });
  }
  return rows;
}
const literal = (value) =>
  value === null
    ? "null"
    : typeof value === "number"
      ? String(value)
      : "'" + String(value).replaceAll("'", "''") + "'";
export const phoneCountryRulesSql = () =>
  phoneCountryRules()
    .map((row) => " (" + row.map(literal).join(",") + ")")
    .join(",\n");

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(phoneCountryRulesSql());
