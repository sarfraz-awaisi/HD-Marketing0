// Dealer affiliate network (update 049). The server checks everything again;
// these rules only let the form explain a problem before it is sent.
export const dealerStatuses = [
  { value: "pending", label: "Pending review", tone: "warning" },
  { value: "approved", label: "Approved", tone: "completed" },
  { value: "rejected", label: "Rejected", tone: "cancelled" },
];
export const dealerStatus = (value) =>
  dealerStatuses.find((s) => s.value === value) || {
    value,
    label: String(value || "—"),
    tone: "",
  };
export const dealerSorts = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "updated", label: "Recently changed" },
];
export const dealerFields = [
  { key: "name", label: "Dealer name", max: 120, required: true },
  { key: "phone", label: "Contact number", max: 30, required: true },
  { key: "address", label: "Address", max: 300, required: true },
  { key: "company_name", label: "Agency or company name", max: 120 },
  { key: "city", label: "City", max: 80 },
  { key: "area", label: "Area or location", max: 120 },
  { key: "notes", label: "Additional notes", max: 1000 },
];
export const blankDealer = Object.fromEntries(
  dealerFields.map((f) => [f.key, ""]),
);

// The database's rule (dealer_phone): 03001234567, +923001234567,
// 923001234567 and 3001234567 are all +923001234567. null: not a number.
export function normalizeDealerPhone(input) {
  let n = String(input ?? "").replace(/[\s()+.-]/g, "");
  if (n.startsWith("00")) n = n.slice(2);
  if (n.startsWith("0")) n = "92" + n.slice(1);
  else if (/^3\d{9}$/.test(n)) n = "92" + n;
  return /^\d{10,15}$/.test(n) ? "+" + n : null;
}

// Trimmed values as the database stores them: one-line details lose extra
// spaces, empty optional details become null.
export function cleanDealer(form) {
  const out = {};
  for (const { key } of dealerFields) {
    let value = String(form[key] ?? "").trim();
    if (key !== "address" && key !== "notes")
      value = value.replace(/\s+/g, " ");
    out[key] = value || null;
  }
  return out;
}

// { field: message } for every problem; empty when the form can be sent.
export function dealerErrors(form) {
  const v = cleanDealer(form),
    errors = {};
  for (const { key, label, max, required } of dealerFields) {
    if (required && !v[key]) errors[key] = `${label} is required`;
    else if (v[key] && v[key].length > max)
      errors[key] = `${label} must be at most ${max} characters`;
  }
  if (!errors.name && v.name.length < 2)
    errors.name = "Dealer name must be at least 2 characters";
  if (!errors.address && v.address.length < 3)
    errors.address = "Address must be at least 3 characters";
  if (!errors.phone && !normalizeDealerPhone(v.phone))
    errors.phone = "Enter a valid contact number, for example 03XX XXXXXXX";
  return errors;
}

// Full numbers only: administrators get every number and agents their own
// dealers' (anything masked, such as +92******567, cannot be dialled).
export const dialable = (phone) => /^\+\d{10,15}$/.test(String(phone || ""));
export const telLink = (phone) => "tel:" + phone;
// Opens a chat with the dealer; nothing is written or sent automatically.
export const whatsappLink = (phone) =>
  "https://wa.me/" + String(phone).replace(/\D/g, "");
// +923001234567 as +92 300 1234567 (other numbers are shown as stored).
export const formatDealerPhone = (phone) => {
  const m = /^\+92(3\d{2})(\d{7})$/.exec(String(phone || ""));
  return m ? `+92 ${m[1]} ${m[2]}` : phone || "—";
};
