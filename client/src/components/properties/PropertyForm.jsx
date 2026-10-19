import { useState } from "react";
import { RecordForm } from "../common/UI";
import PropertyPhotoPicker from "./PropertyPhotoPicker";
export default function PropertyForm({ initial, onSave }) {
  const [pictures, setPictures] = useState([]);
  return (
    <RecordForm
      initial={initial}
      onSave={(data) =>
        onSave(data, pictures, (uploaded) =>
          setPictures((current) => current.filter((p) => p.id !== uploaded.id)),
        )
      }
      fields={[
        { key: "title", label: "Property title", required: true },
        { key: "location", label: "Location", required: true },
        { key: "price", label: "Price (PKR)", type: "number", required: true },
        {
          key: "type",
          label: "Property type",
          required: true,
          options: ["House", "Apartment", "Plot", "Commercial"],
        },
        { key: "area", label: "Area", type: "number", required: true },
        {
          key: "area_unit",
          label: "Area unit",
          required: true,
          options: ["sq ft", "marla", "kanal"],
          default: "marla",
        },
        {
          key: "availability",
          label: "Availability",
          required: true,
          options: ["available", "reserved", "sold", "archived"],
          default: "available",
        },
        { key: "description", label: "Description", type: "textarea" },
      ]}
    >
      {({ isSubmitting }) => (
        <PropertyPhotoPicker
          pictures={pictures}
          onChange={setPictures}
          disabled={isSubmitting}
        />
      )}
    </RecordForm>
  );
}
