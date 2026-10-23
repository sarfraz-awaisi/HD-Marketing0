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
export default function InventoryStats() {
  const q = useQuery({
    queryKey: ["inventory-summary"],
    queryFn: ({ signal }) => api("/inventory/summary", { signal }),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data;
  const closed = (c) => (c ? (c.sold || 0) + (c.rented || 0) : undefined);
  const tiles =
    s?.role === "admin"
      ? [
          ["Company properties", s.company?.total, Building2, "navy"],
          ["Agent properties", s.agents?.total, Users, "gold"],
          ["All properties", s.all?.total, House, "navy"],
          ["Available", s.all?.available, CircleCheck, "green"],
          ["Sold or rented", closed(s.all), Handshake, "gold"],
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
      {tiles.map(([label, value, icon, tone]) => (
        <KpiTile
          key={label}
          label={label}
          value={q.isPending ? "…" : value}
          icon={icon}
          tone={tone}
        />
      ))}
    </section>
  );
}
