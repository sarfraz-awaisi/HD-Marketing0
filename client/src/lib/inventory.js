// Property inventory (update 041). Values match the server validators and the
// database checks; labels are what agents and administrators read.
export const propertyTypeGroups = [
  [
    "Residential",
    ["House", "Apartment", "Residential Plot", "Portion", "Farmhouse"],
  ],
  [
    "Commercial",
    ["Shop", "Office", "Commercial Plot", "Warehouse", "Building"],
  ],
  ["Other", ["Land", "Other"]],
];
export const propertyTypes = propertyTypeGroups.flatMap(([, types]) => types);
// Plots and land have no rooms, furnishing, construction or age.
export const isPlot = (type) =>
  ["Residential Plot", "Commercial Plot", "Land"].includes(type);
export const purposes = [
  { value: "sale", label: "For sale" },
  { value: "rent", label: "For rent" },
];
// 'archived' is the stored value for Inactive.
export const statuses = [
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "rented", label: "Rented" },
  { value: "archived", label: "Inactive" },
];
export const statusFor = (purpose) =>
  statuses.filter(
    (s) =>
      !(purpose === "rent" && s.value === "sold") &&
      !(purpose === "sale" && s.value === "rented"),
  );
export const areaUnits = [
  { value: "marla", label: "Marla" },
  { value: "kanal", label: "Kanal" },
  { value: "sq ft", label: "Square feet" },
  { value: "sq yd", label: "Square yards" },
  { value: "acre", label: "Acres" },
];
export const provinces = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Islamabad Capital Territory",
  "Gilgit-Baltistan",
  "Azad Jammu and Kashmir",
];
export const furnishings = [
  { value: "unfurnished", label: "Unfurnished" },
  { value: "semi_furnished", label: "Semi-furnished" },
  { value: "furnished", label: "Furnished" },
];
export const constructionStatuses = [
  { value: "new", label: "Brand new" },
  { value: "ready", label: "Ready to move in" },
  { value: "needs_renovation", label: "Needs renovation" },
  { value: "under_construction", label: "Under construction" },
  { value: "grey_structure", label: "Grey structure" },
];
export const amenities = [
  { value: "electricity", label: "Electricity" },
  { value: "gas", label: "Gas" },
  { value: "water", label: "Water" },
  { value: "sewerage", label: "Sewerage" },
  { value: "internet", label: "Internet" },
  { value: "boundary_wall", label: "Boundary wall" },
  { value: "security", label: "Security" },
  { value: "corner", label: "Corner" },
  { value: "park_facing", label: "Park facing" },
  { value: "main_road", label: "Main road" },
  { value: "lift", label: "Lift" },
  { value: "backup_power", label: "Backup power" },
  { value: "solar", label: "Solar" },
  { value: "servant_quarter", label: "Servant quarter" },
  { value: "basement", label: "Basement" },
  { value: "lawn", label: "Lawn" },
  { value: "drawing_room", label: "Drawing room" },
  { value: "store_room", label: "Store room" },
];
export const sorts = [
  { value: "newest", label: "Newest first" },
  { value: "updated", label: "Recently updated" },
  { value: "price_low", label: "Price: low to high" },
  { value: "price_high", label: "Price: high to low" },
  { value: "title", label: "Title A–Z" },
  { value: "oldest", label: "Oldest first" },
];
const labelOf = (list, value) =>
  list.find((item) => item.value === value)?.label || value || "—";
export const statusLabel = (value) => labelOf(statuses, value);
export const purposeLabel = (value) => labelOf(purposes, value);
export const unitLabel = (value) => labelOf(areaUnits, value);
export const furnishingLabel = (value) => labelOf(furnishings, value);
export const constructionLabel = (value) =>
  labelOf(constructionStatuses, value);
export const amenityLabel = (value) => labelOf(amenities, value);
export const propertyRef = (no) =>
  no ? "PR-" + String(no).padStart(6, "0") : "—";
export const sizeLabel = (p) =>
  `${Number(p.area).toLocaleString("en-PK")} ${unitLabel(p.area_unit)}`;
