export const documentCategories = [
  { value: "property_deeds", label: "Property Deeds" },
  { value: "legal_noc", label: "Legal & NOC" },
  { value: "policy", label: "Agency Policy" },
  { value: "client_kyc", label: "Client KYC" },
  { value: "tenancy_agreements", label: "Tenancy Agreements" },
  { value: "documentation", label: "Documentation" },
];
export const documentCategoryLabel = (value) =>
  documentCategories.find((category) => category.value === value)?.label ||
  "Documentation";
