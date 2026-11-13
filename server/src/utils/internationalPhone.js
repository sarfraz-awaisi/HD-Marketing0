import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";
// Phone numbers from any country (update 064), checked against each
// country's numbering rules (Google's libphonenumber data) and returned in
// E.164: + country code and digits, as the CRM stores every number.
//
// * +971 50 123 4567, (+971) 50-123-4567 and 00971501234567 are read for the
//   country their code names. A 0 written by mistake after the code (+92 0300
//   …) is dropped when the number is valid without it.
// * A number without a country code is read for the explicit country given
//   (a country column), then as Pakistani, as the CRM always has: 03XX…,
//   3XX… (ten digits) and 92…. It is never guessed to be from anywhere else.
// * Arabic-Indic, Urdu and full-width digits, and invisible direction marks
//   copied with a number, are read as plain digits.

const results = {
  missing: "phone_missing",
  invalid: "phone_invalid",
  needsCountry: "phone_needs_country",
};
export const phoneProblems = results;

// The characters a number may be written with, once cleaned.
const shape = /^\(?\+?[\d\s().-]+$/;

export function cleanPhoneText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[\p{Cf}\p{Cc}]/gu, "")
    .trim();
}

// ------------------------------------------------------------ the country
const simple = (name) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z]+/g, " ")
    .trim();
// Short names people write that are not a country's English name.
const aliases = {
  uae: "AE",
  ksa: "SA",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  usa: "US",
  us: "US",
  "united states of america": "US",
  america: "US",
  turkey: "TR",
};
let names;
function countryNames() {
  if (names) return names;
  const display = new Intl.DisplayNames("en", { type: "region" });
  names = new Map(Object.entries(aliases));
  for (const code of getCountries()) {
    const name = display.of(code);
    if (name && name !== code) names.set(simple(name), code);
  }
  return names;
}
const callingCodes = new Set(
  getCountries().map((code) => getCountryCallingCode(code)),
);

// What a country cell says, when it is clear: a country ({country: "AE"})
// or a calling code ({callingCode: "971"}). Anything else is null, and the
// number is then read as if there were no country column.
export function phoneCountry(value) {
  const text = cleanPhoneText(value);
  if (!text) return null;
  const code = /^(?:\+|00)?(\d{1,3})$/.exec(text.replace(/[\s()-]/g, ""));
  if (code) return callingCodes.has(code[1]) ? { callingCode: code[1] } : null;
  if (/^[A-Za-z]{2}$/.test(text)) {
    const upper = text.toUpperCase();
    if (getCountries().includes(upper)) return { country: upper };
  }
  const country = countryNames().get(simple(text));
  return country ? { country } : null;
}

// ------------------------------------------------------------ flags
// A stored number's country (update 065), as the library decides it, and as
// the database's phone_country() does: one country per calling code, and for
// shared codes (+1, +7, +44, …) by the area code or leading digits. Null when
// the number cannot be placed in one country: shown as a globe, never as a
// guessed flag.
export function numberCountry(phone) {
  if (typeof phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(phone))
    return null;
  const country = parsePhoneNumberFromString(phone)?.country;
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}
// Every country the library knows, for the Country filter.
let listed;
export function phoneCountries() {
  if (listed) return listed;
  const display = new Intl.DisplayNames("en", { type: "region" });
  listed = getCountries()
    .map((code) => ({
      code,
      name: display.of(code) || code,
      calling_code: getCountryCallingCode(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return listed;
}
export const isPhoneCountry = (code) =>
  phoneCountries().some((c) => c.code === code);

// ------------------------------------------------------------ the number
// The CRM keeps and protects numbers of 10 to 15 digits (its masking shows
// three characters at each end), so the few valid shorter ones, from small
// territories such as Niue, are refused.
const valid = (number) =>
  number?.isValid() && /^\+\d{10,15}$/.test(number.number)
    ? number.number
    : null;

// {phone: "+971501234567"}, or {error} with one of phoneProblems.
export function readPhone(value, country = null) {
  const text = cleanPhoneText(value);
  if (!text) return { error: results.missing };
  if (!shape.test(text)) return { error: results.invalid };
  const digits = text.replace(/\D/g, "");
  if (!digits) return { error: results.missing };
  if (text.replace(/^\(/, "").startsWith("+") || digits.startsWith("00")) {
    const phone = valid(
      parsePhoneNumberFromString(
        "+" + (digits.startsWith("00") ? digits.slice(2) : digits),
      ),
    );
    return phone ? { phone } : { error: results.invalid };
  }
  const phone =
    (country?.country &&
      valid(parsePhoneNumberFromString(digits, country.country))) ||
    (country?.callingCode &&
      valid(
        parsePhoneNumberFromString(digits, {
          defaultCallingCode: country.callingCode,
        }),
      )) ||
    valid(parsePhoneNumberFromString(digits, "PK"));
  if (phone) return { phone };
  // A mistyped Pakistani mobile (03…, 3…, 92…), or too few or too many
  // digits for any number, is invalid rather than missing its country.
  const pakistani = /^(?:0?3\d{7,11}|92\d{8,12})$/.test(digits);
  const plausible = digits.length >= 6 && digits.length <= 15;
  return {
    error:
      country || pakistani || !plausible
        ? results.invalid
        : results.needsCountry,
  };
}
