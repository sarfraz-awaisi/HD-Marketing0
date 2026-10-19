import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { ErrorBox } from "../common/UI";
export default function KycClientPicker({ value, onChange, selectedName }) {
  const { user } = useAuth(),
    [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["kyc-clients", user.id, search],
    queryFn: () =>
      api("/documents/clients?" + new URLSearchParams({ search, limit: "20" })),
  });
  const selected = useQuery({
    queryKey: ["kyc-client", user.id, value],
    queryFn: () =>
      api("/documents/clients?" + new URLSearchParams({ selected: value })),
    enabled: !!value,
  });
  const choices = q.data || [],
    current = selected.data?.[0];
  return (
    <div className="kyc-client-picker wide">
      <label>
        Find a client
        <input
          type="search"
          aria-label="Search clients for KYC"
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer name…"
        />
      </label>
      <ErrorBox error={q.error || selected.error} />
      <label>
        Client (lead) *
        <select
          aria-label="Client (lead)"
          required
          value={value || ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Choose a client</option>
          {value && !choices.some((c) => c.id === value) && (
            <option value={value}>
              {current
                ? `${current.name} · ${current.masked_phone}`
                : selectedName || "Selected client"}
            </option>
          )}
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.masked_phone}
            </option>
          ))}
        </select>
      </label>
      <small>
        {q.isPending
          ? "Searching clients…"
          : "Only masked phone numbers appear in this picker."}
      </small>
    </div>
  );
}
