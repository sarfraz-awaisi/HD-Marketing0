import { cloneElement, useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, ErrorBox } from "../common/UI";
import PropertyPhotoPicker from "./PropertyPhotoPicker";
import PropertyDocumentPicker from "./PropertyDocumentPicker";
import {
  amenities,
  areaUnits,
  buildingCategoryGroups,
  constructionStatuses,
  floorLabel,
  furnishings,
  groundLevels,
  hasFloor,
  isPlot,
  maxFloor,
  propertyTypeGroups,
  propertyTypes,
  provinces,
  purposes,
  statusFor,
} from "../../lib/inventory";
import {
  exactPrice,
  priceForEditing,
  priceFrom,
  pricePK,
  priceUnits,
  splitPrice,
} from "../../lib/price";

const text = (max) => z.string().trim().max(max, `Use up to ${max} characters`);
const count = (max) =>
  z
    .string()
    .trim()
    .refine(
      (v) => v === "" || (/^\d+$/.test(v) && Number(v) <= max),
      `Enter a whole number up to ${max}`,
    );
const phone = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || /^\+?[\d\s().-]{10,20}$/.test(v),
    "Enter a phone number such as 0300 1234567",
  );
const schema = z
  .object({
    title: text(200).min(1, "Enter a title"),
    type: z.string().min(1, "Choose a property type"),
    purpose: z.enum(["sale", "rent"]),
    availability: z.string().min(1),
    description: text(4000),
    city: text(80).min(1, "Enter the city"),
    area_society: text(120),
    block_sector: text(60),
    province: z.string(),
    street: text(120),
    plot_number: text(40),
    address: text(300),
    map_url: text(500).refine(
      (v) => v === "" || /^https:\/\/\S+$/.test(v),
      "Use a map link that starts with https://",
    ),
    area: z
      .string()
      .trim()
      .refine((v) => Number(v) > 0 && Number(v) <= 1e9, "Enter the size"),
    area_unit: z.string().min(1),
    // Update 054: an amount and a unit (PKR, Thousand, Lakh or Crore).
    price_amount: z.string(),
    price_unit: z.string(),
    price_negotiable: z.boolean(),
    price_notes: text(300),
    bedrooms: count(50),
    bathrooms: count(50),
    kitchens: count(20),
    floors: count(200),
    // Update 054: "" none, -2 to 0 a named level, "upper" a numbered floor.
    floor_choice: z.string(),
    floor_number: z.string().trim(),
    parking_spaces: count(100),
    property_age: count(200),
    furnishing: z.string(),
    construction_status: z.string(),
    amenities: z.array(z.string()),
    building_categories: z.array(z.string()),
    owner_name: text(120),
    owner_phone: phone,
    owner_alt_phone: phone,
    owner_notes: text(1000),
    share_with_agents: z.boolean(),
  })
  .refine((v) => statusFor(v.purpose).some((s) => s.value === v.availability), {
    message: "Use Sold for sale listings and Rented for rent listings",
    path: ["availability"],
  })
  .superRefine((v, ctx) => {
    const price = priceFrom(v.price_amount, v.price_unit);
    if (price.error)
      ctx.addIssue({
        code: "custom",
        message: price.error,
        path: ["price_amount"],
      });
    if (!hasFloor(v.type) || v.floor_choice !== "upper") return;
    const floor = v.floor_number;
    if (!/^\d+$/.test(floor) || Number(floor) < 1 || Number(floor) > maxFloor)
      ctx.addIssue({
        code: "custom",
        message: `Enter a floor number from 1 to ${maxFloor}`,
        path: ["floor_number"],
      });
    else if (/^\d+$/.test(v.floors) && Number(floor) > Number(v.floors))
      ctx.addIssue({
        code: "custom",
        message: `The floor cannot be above the building's ${v.floors} floors`,
        path: ["floor_number"],
      });
  });
const asText = (v) => (v === null || v === undefined ? "" : String(v));
function defaults(p = {}) {
  const contact = p.owner_contact || {};
  return {
    title: asText(p.title),
    // Older free-text types (for example "Plot") must be chosen again.
    type: propertyTypes.includes(p.type) ? p.type : "",
    purpose: p.purpose || "sale",
    availability: p.availability || "available",
    description: asText(p.description),
    city: asText(p.city),
    area_society: asText(p.area_society),
    block_sector: asText(p.block_sector),
    province: asText(p.province),
    street: asText(p.street),
    plot_number: asText(p.plot_number),
    address: asText(p.address),
    map_url: asText(p.map_url),
    area: asText(p.area),
    area_unit: p.area_unit || "marla",
    price_amount: priceForEditing(p.price).amount,
    price_unit: priceForEditing(p.price).unit,
    price_negotiable: !!p.price_negotiable,
    price_notes: asText(p.price_notes),
    bedrooms: asText(p.bedrooms),
    bathrooms: asText(p.bathrooms),
    kitchens: asText(p.kitchens),
    floors: asText(p.floors),
    floor_choice:
      p.floor_level === null || p.floor_level === undefined
        ? ""
        : p.floor_level > 0
          ? "upper"
          : String(p.floor_level),
    floor_number: p.floor_level > 0 ? String(p.floor_level) : "",
    parking_spaces: asText(p.parking_spaces),
    property_age: asText(p.property_age),
    furnishing: asText(p.furnishing),
    construction_status: asText(p.construction_status),
    amenities: p.amenities || [],
    building_categories: p.building_categories || [],
    owner_name: asText(contact.owner_name),
    owner_phone: asText(contact.owner_phone),
    owner_alt_phone: asText(contact.owner_alt_phone),
    owner_notes: asText(contact.owner_notes),
    share_with_agents: !!contact.share_with_agents,
  };
}
const orNull = (v) => v.trim() || null;
// The floor to save: none for types that are not on a floor.
function floorLevel(v) {
  if (!hasFloor(v.type) || v.floor_choice === "") return null;
  return v.floor_choice === "upper"
    ? Number(v.floor_number)
    : Number(v.floor_choice);
}
const buildingKeys = [
  "bedrooms",
  "bathrooms",
  "kitchens",
  "floors",
  "parking_spaces",
  "property_age",
  "furnishing",
  "construction_status",
];
// What a change of type would remove from what is already saved.
export function removedByType(initial, type) {
  if (!initial?.id || !type || type === initial.type) return [];
  const removed = [];
  if (
    isPlot(type) &&
    !isPlot(initial.type) &&
    (buildingKeys.some(
      (k) => initial[k] !== null && initial[k] !== undefined,
    ) ||
      initial.building_categories?.length)
  )
    removed.push("the building details");
  if (!hasFloor(type) && floorLabel(initial.floor_level))
    removed.push(`the floor (${floorLabel(initial.floor_level)})`);
  return removed;
}
const numberOrNull = (v) => (v.trim() === "" ? null : Number(v));
// The owner is never sent: the server takes it from the signed-in account.
export function propertyPayload(v, { ownership, initial } = {}) {
  const payload = {
    title: v.title.trim(),
    type: v.type,
    purpose: v.purpose,
    availability: v.availability,
    description: v.description.trim(),
    city: v.city.trim(),
    area_society: orNull(v.area_society),
    block_sector: orNull(v.block_sector),
    province: v.province || null,
    street: orNull(v.street),
    plot_number: orNull(v.plot_number),
    address: orNull(v.address),
    map_url: orNull(v.map_url),
    area: Number(v.area),
    area_unit: v.area_unit,
    price: priceFrom(v.price_amount, v.price_unit).value,
    price_negotiable: v.price_negotiable,
    price_notes: orNull(v.price_notes),
    amenities: v.amenities,
    owner_contact: {
      owner_name: orNull(v.owner_name),
      owner_phone: orNull(v.owner_phone),
      owner_alt_phone: orNull(v.owner_alt_phone),
      owner_notes: orNull(v.owner_notes),
      share_with_agents: ownership === "company" && v.share_with_agents,
    },
  };
  if (!isPlot(v.type))
    Object.assign(payload, {
      bedrooms: numberOrNull(v.bedrooms),
      bathrooms: numberOrNull(v.bathrooms),
      kitchens: numberOrNull(v.kitchens),
      floors: numberOrNull(v.floors),
      floor_level: floorLevel(v),
      parking_spaces: numberOrNull(v.parking_spaces),
      property_age: numberOrNull(v.property_age),
      furnishing: v.furnishing || null,
      construction_status: v.construction_status || null,
      building_categories: v.building_categories,
    });
  // Refuse to overwrite a newer save made by someone else meanwhile.
  if (initial?.updated_at) payload.expected_updated_at = initial.updated_at;
  return payload;
}
function Field({ label, error, hint, required, wide, disabled, children }) {
  const id = useId();
  return (
    <label className={wide ? "wide" : undefined}>
      {label}
      {required && " *"}
      {cloneElement(children, {
        "aria-label": label,
        "aria-invalid": error ? "true" : undefined,
        "aria-describedby": error || hint ? id : undefined,
        disabled,
      })}
      {error ? (
        <span id={id} className="field-error">
          {error}
        </span>
      ) : (
        hint && (
          <span id={id} className="field-hint">
            {hint}
          </span>
        )
      )}
    </label>
  );
}
const Options = ({ list, empty }) => (
  <>
    {empty && <option value="">{empty}</option>}
    {list.map((o) => (
      <option key={o.value ?? o} value={o.value ?? o}>
        {o.label ?? o}
      </option>
    ))}
  </>
);
// ownership: "company" for administrators, "agent" for an agent's own form.
export default function PropertyForm({ initial, ownership, onSave }) {
  const [pictures, setPictures] = useState([]);
  const [documents, setDocuments] = useState([]);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: defaults(initial),
  });
  const [
    type,
    purpose,
    availability,
    chosen,
    categories,
    priceAmount,
    priceUnit,
    floorChoice,
  ] = watch([
    "type",
    "purpose",
    "availability",
    "amenities",
    "building_categories",
    "price_amount",
    "price_unit",
    "floor_choice",
  ]);
  const price = priceFrom(priceAmount, priceUnit);
  const amountField = register("price_amount");
  const removed = removedByType(initial, type);
  useEffect(() => {
    if (!statusFor(purpose).some((s) => s.value === availability))
      setValue("availability", "available");
  }, [purpose, availability, setValue]);
  const field = (name, label, control, extra = {}) => (
    <Field
      label={label}
      error={errors[name]?.message}
      disabled={isSubmitting}
      {...extra}
    >
      {control}
    </Field>
  );
  const input = (name, props = {}) => <input {...props} {...register(name)} />;
  const numberInput = (name) =>
    input(name, { type: "number", min: 0, step: 1, inputMode: "numeric" });
  const legacyLocation = initial?.id && !initial.city ? initial.location : "";
  return (
    <form
      className="property-form"
      noValidate
      onSubmit={handleSubmit(async (values) => {
        // A new type that has no building details or floor clears them.
        if (
          removed.length &&
          !window.confirm(
            `Saving as ${values.type} removes ${removed.join(" and ")} recorded for this property. Save anyway?`,
          )
        )
          return;
        try {
          await onSave(
            propertyPayload(values, { ownership, initial }),
            pictures,
            (uploaded) =>
              setPictures((current) =>
                current.filter((p) => p.id !== uploaded.id),
              ),
            documents,
            (uploaded) =>
              setDocuments((current) =>
                current.filter((d) => d.id !== uploaded.id),
              ),
          );
        } catch (e) {
          setError("root", { message: e.message });
        }
      })}
    >
      <fieldset>
        <legend>Basic information</legend>
        <div className="form-grid">
          {field(
            "title",
            "Property title",
            input("title", { autoComplete: "off" }),
            { required: true, wide: true },
          )}
          {field(
            "type",
            "Property type",
            <select {...register("type")}>
              <option value="">Choose a type</option>
              {propertyTypeGroups.map(([group, types]) => (
                <optgroup key={group} label={group}>
                  {types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </optgroup>
              ))}
            </select>,
            {
              required: true,
              hint: removed.length
                ? `Saving as ${type} removes ${removed.join(" and ")}.`
                : initial?.type && !propertyTypes.includes(initial.type)
                  ? `Previously recorded as "${initial.type}"`
                  : undefined,
            },
          )}
          {field(
            "purpose",
            "Purpose",
            <select {...register("purpose")}>
              <Options list={purposes} />
            </select>,
            { required: true },
          )}
          {field(
            "availability",
            "Status",
            <select {...register("availability")}>
              <Options list={statusFor(purpose)} />
            </select>,
            { required: true },
          )}
          {field(
            "description",
            "Description",
            <textarea rows="3" {...register("description")} />,
            { wide: true },
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Location</legend>
        <div className="form-grid">
          {field("city", "City", input("city", { autoComplete: "off" }), {
            required: true,
            hint: legacyLocation
              ? `Previously recorded location: ${legacyLocation}`
              : undefined,
          })}
          {field(
            "area_society",
            "Area / society",
            input("area_society", { placeholder: "e.g. DHA Phase 6" }),
          )}
          {field(
            "block_sector",
            "Block / sector / phase",
            input("block_sector"),
          )}
          {field(
            "province",
            "Province",
            <select {...register("province")}>
              <Options list={provinces} empty="Not specified" />
            </select>,
          )}
          {field("street", "Street", input("street"))}
          {field("plot_number", "Plot / house number", input("plot_number"), {
            hint: "Optional",
          })}
          {field("address", "Full address", input("address"), {
            wide: true,
            hint: "Optional",
          })}
          {field(
            "map_url",
            "Map link",
            input("map_url", {
              type: "url",
              inputMode: "url",
              placeholder: "https://maps.google.com/…",
            }),
            { wide: true },
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Size and price</legend>
        <div className="form-grid">
          {field(
            "area",
            "Size",
            input("area", { type: "number", min: 0, step: "any" }),
            { required: true },
          )}
          {field(
            "area_unit",
            "Size unit",
            <select {...register("area_unit")}>
              <Options list={areaUnits} />
            </select>,
            { required: true, hint: "Saved as entered, never converted" },
          )}
          {/* Update 054: an amount and its unit; saved in PKR. */}
          <div className="price-entry wide">
            {field(
              "price_amount",
              purpose === "rent" ? "Monthly rent" : "Price",
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder={priceUnit === "pkr" ? "e.g. 85,000" : "e.g. 2.3"}
                {...amountField}
                onBlur={(e) => {
                  amountField.onBlur(e);
                  // "2.3 cr" typed in full: the unit moves to the list.
                  const split = splitPrice(e.target.value);
                  if (split?.unit) {
                    setValue("price_unit", split.unit);
                    setValue("price_amount", split.amount, {
                      shouldValidate: !!errors.price_amount,
                    });
                  }
                }}
              />,
              {
                required: true,
                hint:
                  !priceAmount.trim() || price.error
                    ? purpose === "rent"
                      ? "Rent is recorded per month. You can type 45K or 1.5 Lakh."
                      : "You can type 2.3 Crore, 75 Lakh or 45K."
                    : undefined,
              },
            )}
            {field(
              "price_unit",
              "Price unit",
              <select {...register("price_unit")}>
                <Options list={priceUnits} />
              </select>,
            )}
            {!price.error && (
              <p className="price-preview" role="status">
                = {exactPrice(price.value)}
                {price.value >= 1e5 && <> · {pricePK(price.value).slice(4)}</>}
                {purpose === "rent" && " per month"}
              </p>
            )}
          </div>
          {field("price_notes", "Price notes", input("price_notes"))}
          <label className="checkbox-field wide">
            <input
              type="checkbox"
              disabled={isSubmitting}
              {...register("price_negotiable")}
            />
            Price is negotiable
          </label>
        </div>
      </fieldset>
      {!isPlot(type) && (
        <fieldset>
          <legend>Building details</legend>
          <div className="form-grid">
            {field("bedrooms", "Bedrooms", numberInput("bedrooms"))}
            {field("bathrooms", "Bathrooms", numberInput("bathrooms"))}
            {field("kitchens", "Kitchens", numberInput("kitchens"))}
            {hasFloor(type) && (
              <>
                {field(
                  "floor_choice",
                  "Floor",
                  <select {...register("floor_choice")}>
                    <option value="">Not specified</option>
                    <Options list={groundLevels} />
                    <option value="upper">
                      Upper floor (enter the number)
                    </option>
                  </select>,
                )}
                {floorChoice === "upper" &&
                  field(
                    "floor_number",
                    "Floor number",
                    input("floor_number", {
                      type: "number",
                      min: 1,
                      max: maxFloor,
                      step: 1,
                      inputMode: "numeric",
                      placeholder: "e.g. 7",
                    }),
                    { required: true },
                  )}
              </>
            )}
            {field(
              "floors",
              hasFloor(type) ? "Total building floors" : "Floors",
              numberInput("floors"),
              hasFloor(type) ? { hint: "Optional" } : {},
            )}
            {field(
              "parking_spaces",
              "Parking spaces",
              numberInput("parking_spaces"),
            )}
            {field(
              "property_age",
              "Property age (years)",
              numberInput("property_age"),
            )}
            {field(
              "furnishing",
              "Furnishing",
              <select {...register("furnishing")}>
                <Options list={furnishings} empty="Not specified" />
              </select>,
            )}
            {field(
              "construction_status",
              "Construction",
              <select {...register("construction_status")}>
                <Options list={constructionStatuses} empty="Not specified" />
              </select>,
            )}
          </div>
          {/* Update 046: every kind of unit or space on offer, several at once. */}
          <fieldset className="category-picker">
            <legend>Building categories</legend>
            <p className="field-hint">
              Tick every kind of unit or space this property or building offers.
              This is separate from the bedroom count above.
            </p>
            <div className="category-groups">
              {buildingCategoryGroups.map((g) => (
                <fieldset key={g.label} className="category-group">
                  <legend>{g.label}</legend>
                  <div className="tag-picker">
                    {g.options.map((o) => (
                      <label key={o.value}>
                        <input
                          type="checkbox"
                          aria-label={
                            g.options.length > 1
                              ? `${g.label} — ${o.label}`
                              : o.label
                          }
                          disabled={isSubmitting}
                          checked={categories.includes(o.value)}
                          onChange={(e) =>
                            setValue(
                              "building_categories",
                              e.target.checked
                                ? [...categories, o.value]
                                : categories.filter((v) => v !== o.value),
                            )
                          }
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </fieldset>
        </fieldset>
      )}
      <fieldset>
        <legend>Utilities and features</legend>
        <div className="tag-picker">
          {amenities.map((a) => (
            <label key={a.value}>
              <input
                type="checkbox"
                disabled={isSubmitting}
                checked={chosen.includes(a.value)}
                onChange={(e) =>
                  setValue(
                    "amenities",
                    e.target.checked
                      ? [...chosen, a.value]
                      : chosen.filter((v) => v !== a.value),
                  )
                }
              />
              {a.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Owner contact (private)</legend>
        <p className="field-hint">
          {ownership === "company"
            ? "Visible to administrators. Agents see the name and numbers only if you share them below; notes stay private."
            : "Visible only to you and administrators."}
        </p>
        <div className="form-grid">
          {field(
            "owner_name",
            "Owner name",
            input("owner_name", { autoComplete: "off" }),
          )}
          {field(
            "owner_phone",
            "Owner phone",
            input("owner_phone", { type: "tel", autoComplete: "off" }),
          )}
          {field(
            "owner_alt_phone",
            "Alternate phone",
            input("owner_alt_phone", { type: "tel", autoComplete: "off" }),
          )}
          {field(
            "owner_notes",
            "Owner notes",
            <textarea rows="2" {...register("owner_notes")} />,
            { wide: true },
          )}
          {ownership === "company" && (
            <label className="checkbox-field wide">
              <input
                type="checkbox"
                disabled={isSubmitting}
                {...register("share_with_agents")}
              />
              Share owner name and phone with agents
            </label>
          )}
        </div>
      </fieldset>
      <PropertyPhotoPicker
        pictures={pictures}
        onChange={setPictures}
        disabled={isSubmitting}
      />
      <PropertyDocumentPicker
        documents={documents}
        onChange={setDocuments}
        disabled={isSubmitting}
        existing={!!initial?.id}
      />
      <ErrorBox error={errors.root?.message} />
      <footer>
        <Button disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save record"}
        </Button>
      </footer>
    </form>
  );
}
