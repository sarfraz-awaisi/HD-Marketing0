import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Button, ErrorBox, Loader, Pagination, Table } from "../common/UI";

const statusText = {
  active: "Active",
  inactive: "Disabled",
  deleted: "Deleted",
};
// Administrators only. Agents come from the existing accounts; an account that
// was deleted or disabled still appears while it has properties.
export default function AgentDirectory({ onOpen }) {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search);
  const q = useQuery({
    queryKey: ["inventory-agents", page, debounced],
    queryFn: ({ signal }) =>
      api(
        "/inventory/agents?" +
          new URLSearchParams({
            page,
            ...(debounced && { search: debounced }),
          }),
        { signal },
      ),
  });
  return (
    <>
      <div className="toolbar">
        <input
          aria-label="Search agents"
          placeholder="Search by name, email or UID…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <ErrorBox error={q.error} />
      <section className="panel">
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={q.data?.data || []}
            columns={[
              {
                key: "name",
                label: "Agent",
                render: (a) => (
                  <>
                    <strong>{a.name}</strong>
                    {a.uid && (
                      <small className="field-hint"> · UID {a.uid}</small>
                    )}
                  </>
                ),
              },
              { key: "email", label: "Email", render: (a) => a.email || "—" },
              {
                key: "status",
                label: "Account",
                render: (a) => (
                  <span
                    className={`badge ${a.status === "active" ? "available" : a.status === "deleted" ? "lost" : ""}`}
                  >
                    {statusText[a.status] || a.status}
                  </span>
                ),
              },
              { key: "total", label: "Properties" },
              { key: "available", label: "Available" },
              {
                key: "closed",
                label: "Sold / rented",
                render: (a) => a.sold + a.rented,
              },
              {
                key: "last_updated",
                label: "Last update",
                render: (a) => date(a.last_updated),
              },
              {
                key: "open",
                label: "Inventory",
                render: (a) => (
                  <Button
                    variant="secondary"
                    aria-label={`Open ${a.name}'s inventory`}
                    onClick={() => onOpen(a)}
                  >
                    Open inventory
                  </Button>
                ),
              },
            ]}
          />
        )}
      </section>
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
    </>
  );
}
