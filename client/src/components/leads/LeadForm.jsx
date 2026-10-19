import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { RecordForm } from "../common/UI";
export default function LeadForm({ initial, onSave }) {
  const users = useQuery({ queryKey: ["users"], queryFn: () => api("/users") });
  const props = useQuery({
    queryKey: ["property-options"],
    queryFn: () => api("/properties?limit=100"),
  });
  return (
    <RecordForm
      initial={initial}
      fields={[
        { key: "name", label: "Customer name", required: true },
        ...[
          {
            key: "phone",
            label: "Private phone (e.g. 03001234567)",
            required: true,
          },
        ],
        { key: "email", label: "Email", type: "email" },
        {
          key: "source",
          label: "Source",
          options: ["manual", "CSV", "Meta", "WhatsApp", "other"],
          required: true,
          default: "manual",
        },
        {
          key: "budget_min",
          label: "Minimum budget (PKR)",
          type: "number",
          default: 0,
        },
        {
          key: "budget_max",
          label: "Maximum budget (PKR)",
          type: "number",
          default: 0,
        },
        { key: "preferred_location", label: "Preferred location" },
        {
          key: "property_id",
          label: "Interested property",
          options: (props.data?.data || []).map((p) => ({
            value: p.id,
            label: p.title,
          })),
        },
        ...[
          {
            key: "assigned_agent",
            label: "Assigned agent",
            options: (users.data || [])
              .filter((u) => u.role === "agent" && u.active)
              .map((u) => ({ value: u.id, label: u.name })),
          },
        ],
      ]}
      onSave={(data) => {
        if (data.budget_max && data.budget_max < data.budget_min)
          throw new Error("Maximum budget must exceed minimum");
        return onSave({
          ...data,
          budget_max: data.budget_max || null,
          property_id: data.property_id || null,
          assigned_agent: data.assigned_agent || null,
        });
      }}
    />
  );
}
