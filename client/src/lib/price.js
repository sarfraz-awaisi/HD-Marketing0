// Property prices (update 054). Agents enter an amount and a unit as prices
// are said in Pakistan (2.3 Crore, 75 Lakh, 45K); the CRM stores PKR as
// before. Conversion uses whole-number arithmetic, so 2.3 Crore is exactly
// 23,000,000, never 22,999,999.99.
export const priceUnits = [
  { value: "pkr", label: "PKR", factor: 1n, places: 2 },
  { value: "thousand", label: "Thousand", factor: 1000n, places: 3 },
  { value: "lakh", label: "Lakh", factor: 100000n, places: 5 },
  { value: "crore", label: "Crore", factor: 10000000n, places: 7 },
];
// The largest price the server accepts.
export const maxPrice = 1e13;
const unitWords = new Map(
  Object.entries({
    pkr: ["pkr", "rs", "rs.", "rupee", "rupees"],
    thousand: ["k", "thousand", "thousands", "hazar", "hazaar"],
    lakh: ["l", "lakh", "lakhs", "lac", "lacs", "lak"],
    crore: ["cr", "crs", "crore", "crores", "karor", "karore"],
  }).flatMap(([unit, words]) => words.map((w) => [w, unit])),
);
// "2.3 cr" → { amount: "2.3", unit: "crore" }; "45000" → { amount: "45000",
// unit: null }. Anything else (two amounts, an unknown word) → null.
export function splitPrice(text) {
  const typed = String(text ?? "")
    .trim()
    .toLowerCase();
  // "Rs. 85,000" or "PKR 85,000" is in rupees.
  const rupees = /^(pkr|rs\.?)\s*/.exec(typed);
  const value = typed.slice(rupees?.[0].length || 0);
  const match = /^([-\d.,\s]*?)\s*([a-z.]+)?$/.exec(value);
  if (!match) return null;
  const amount = match[1].replace(/\s+/g, "");
  if (!match[2]) return { amount, unit: rupees ? "pkr" : null };
  const unit = unitWords.get(match[2]);
  return unit ? { amount, unit } : null;
}
// Commas in the Pakistani (1,50,000) or the international (150,000) style.
const grouped = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d+)?$/;
// { value } in PKR, or { error } in words.
export function priceFrom(amountText, unitValue = "pkr") {
  const split = splitPrice(amountText);
  if (!split)
    return { error: "Enter one amount and unit, for example 2.5 Crore" };
  const unit = priceUnits.find((u) => u.value === (split.unit || unitValue));
  let amount = split.amount;
  if (!unit) return { error: "Choose a unit" };
  if (amount === "") return { error: "Enter the price" };
  if (amount.startsWith("-")) return { error: "A price cannot be negative" };
  if (amount.includes(",")) {
    if (!grouped.test(amount))
      return { error: "Check the commas, for example 1,50,000 or 150,000" };
    amount = amount.replaceAll(",", "");
  }
  if (!/^\d+(\.\d+)?$/.test(amount) && !/^\.\d+$/.test(amount))
    return { error: "Enter the amount as a number, for example 2.3" };
  const [whole, fraction = ""] = amount.split(".");
  // In paisa, so a price may keep two decimal places, as before.
  const scaled = BigInt((whole || "0") + fraction) * unit.factor * 100n;
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n)
    return {
      error: `Use at most ${unit.places} decimal places for ${unit.label}`,
    };
  const paisa = scaled / divisor;
  // Converted prices are whole rupees; a price in PKR may keep paisa.
  if (unit.value !== "pkr" && paisa % 100n !== 0n)
    return {
      error: `Use at most ${unit.places} decimal places for ${unit.label}`,
    };
  if (paisa > BigInt(maxPrice) * 100n)
    return { error: "Enter a price up to PKR 1,000,000 Crore" };
  return { value: Number(paisa) / 100 };
}
// A saved price shown in the largest unit that keeps it exact (up to three
// decimal places), for editing: 23,000,000 → 2.3 Crore; 23,456,789 → PKR.
export function priceForEditing(price) {
  if (price === null || price === undefined || price === "")
    return { amount: "", unit: "pkr" };
  const n = Number(price),
    paisa = BigInt(Math.round(n * 100));
  for (const unit of [priceUnits[3], priceUnits[2]])
    if (paisa >= unit.factor * 100n && paisa % (unit.factor / 10n) === 0n)
      return { amount: String(n / Number(unit.factor)), unit: unit.value };
  return { amount: String(n), unit: "pkr" };
}
const whole = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const short = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 });
// PKR 85,000 · PKR 75 Lakh · PKR 2.3 Crore (two decimal places at most).
export function pricePK(value) {
  const n = Number(value) || 0;
  const lakh = Math.round((n / 1e5) * 100) / 100;
  if (n >= 1e7 || lakh >= 100) return `PKR ${short.format(n / 1e7)} Crore`;
  if (n >= 1e5) return `PKR ${short.format(lakh)} Lakh`;
  return `PKR ${whole.format(n)}`;
}
// The exact amount, for when the short form is rounded.
export const exactPrice = (value) => `PKR ${whole.format(Number(value) || 0)}`;
// Rent is recorded per month.
export const propertyPrice = (p) =>
  pricePK(p.price) + (p.purpose === "rent" ? "/month" : "");
