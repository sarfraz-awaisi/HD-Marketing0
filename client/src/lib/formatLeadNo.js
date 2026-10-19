export function formatLeadNo(value) {
  const number = String(value ?? "");
  return /^[1-9]\d*$/.test(number) ? `HD-${number.padStart(6, "0")}` : "—";
}
