import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CircleCheck,
  Clock,
  Handshake,
  House,
  Users,
} from "lucide-react";
import { api } from "../../lib/api";
import { KpiTile } from "../dashboard/Widgets";
import { ErrorBox } from "../common/UI";
// Counts come from the server; an agent's summary holds only their own
// inventory and the company total, never other agents' figures.
// Update 044: an agent listing added to Admin Properties is one listing in
// two records. "Admin properties" counts records (copies included); the
// unique count and its availability figures count each listing once.
export default function InventoryStats() {
  const q = useQuery({
    queryKey: ["inventory-summary"],
    queryFn: ({ signal }) => api("/inventory/summary", { signal }),
  });
  // An unavailable database (503) is reported once, by the list below.
  if (q.error)
    return q.error.status === 503 ? null : <ErrorBox error={q.error} />;
  const s = q.data;
  const closed = (c) => (c ? (c.sold || 0) + (c.rented || 0) : undefined);
  // Before update 044 there is no unique count; every record is a listing.
  const unique = s?.unique || s?.all;
  const tiles =
    s?.role === "admin"
      ? [
          [
            "Admin properties",
            s.company?.total,
            Building2,
            "navy",
            s.promoted
              ? `${s.promoted} added from agent inventories`
              : undefined,
          ],
          ["Agent properties", s.agents?.total, Users, "gold"],
          [
            "Unique properties",
            unique?.total,
            House,
            "navy",
            "Each listing counted once",
          ],
          ["Available", unique?.available, CircleCheck, "green"],
          ["Sold or rented", closed(unique), Handshake, "gold"],
          ["Agents with listings", s.agents_with_properties, Users, "navy"],
        ]
      : [
          ["My properties", s?.mine?.total, House, "navy"],
          ["Available", s?.mine?.available, CircleCheck, "green"],
          ["Reserved", s?.mine?.reserved, Clock, "gold"],
          ["Sold", s?.mine?.sold, Handshake, "gold"],
          ["Rented", s?.mine?.rented, Handshake, "navy"],
          ["Company listings", s?.company?.total, Building2, "navy"],
        ];
  return (
    <section
      className="kpi-grid inventory-stats"
      aria-label="Inventory summary"
    >
      {tiles.map(([label, value, icon, tone, note]) => (
        <KpiTile
          key={label}
          label={label}
          value={q.isPending ? "…" : value}
          note={note}
          icon={icon}
          tone={tone}
        />
      ))}
    </section>
  );
}
