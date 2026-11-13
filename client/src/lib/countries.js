import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
// The country of a lead's number (update 065). The server works it out from
// the stored number with the phone-number library (the database does the
// same for the Country filter); here a country code becomes its flag and
// its name in the browser's own words. No country: a globe, never a guess.
export const unknownFlag = "🌐";
export function flagOf(code) {
  if (!/^[A-Z]{2}$/.test(code || "")) return unknownFlag;
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}
const regions = new Intl.DisplayNames(["en"], { type: "region" });
export function countryName(code) {
  if (!code) return "Country not identified";
  if (code === "unknown") return "Unknown country";
  try {
    return regions.of(code) || code;
  } catch {
    return code;
  }
}
// Every country the server's phone-number library knows, by name.
export const useCountries = () =>
  useQuery({
    queryKey: ["phone-countries"],
    queryFn: ({ signal }) => api("/phone-countries", { signal }),
    staleTime: Infinity,
  });
// "🇦🇪 United Arab Emirates", or "🌐 Unknown country", for a filter chip.
export const countryLabel = (code) =>
  `${flagOf(code === "unknown" ? null : code)} ${countryName(code)}`;
