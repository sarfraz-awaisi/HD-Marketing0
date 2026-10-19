export const statuses = [
  "new",
  "contacted",
  "interested",
  "visit_scheduled",
  "visit_done",
  "negotiation",
  "won",
  "lost",
];
export const statusLabels = {
  new: "New",
  contacted: "Contacted",
  interested: "Interested",
  visit_scheduled: "Site visit scheduled",
  visit_done: "Visit done",
  negotiation: "Negotiation",
  won: "Won (booked)",
  lost: "Lost",
};
export const lostReasons = [
  { value: "price", label: "Price" },
  { value: "location", label: "Location" },
  { value: "budget", label: "Budget" },
  { value: "not_interested", label: "Not interested" },
  { value: "no_response", label: "No response" },
  { value: "bought_elsewhere", label: "Bought elsewhere" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "other", label: "Other" },
];
export const statusLabel = (value) =>
  statusLabels[value] || String(value || "—").replaceAll("_", " ");
export const lostReasonLabel = (value) =>
  lostReasons.find((reason) => reason.value === value)?.label || "—";
