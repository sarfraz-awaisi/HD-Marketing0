export function normalizePhone(input) {
  let n = String(input).replace(/[\s()+.-]/g, "");
  if (n.startsWith("00")) n = n.slice(2);
  if (n.startsWith("0")) n = "92" + n.slice(1);
  if (!/^\d{10,15}$/.test(n))
    throw Object.assign(new Error("Use a valid international phone number"), {
      status: 400,
    });
  return "+" + n;
}
export const phoneMask = (n) => n.slice(0, 3) + "******" + n.slice(-3);
export const csvCell = (value) =>
  '"' +
  String(value ?? "")
    .replace(/^[\s]*[=+@-]/, "'$&")
    .replaceAll('"', '""') +
  '"';
