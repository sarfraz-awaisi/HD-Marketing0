import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { Table, Loader, ErrorBox, Button } from "../../components/common/UI";
export default function AuditLog() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["audit", page],
    queryFn: () => api("/audit?page=" + page),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ACCOUNTABILITY IN EVERY ACTION</span>
          <h1>Audit history</h1>
          <p>Append-only records of important CRM changes.</p>
        </div>
      </div>
      <section className="panel">
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={q.data?.data || []}
            columns={[
              {
                key: "created_at",
                label: "Time",
                render: (r) => date(r.created_at),
              },
              { key: "action", label: "Action" },
              { key: "entity", label: "Entity" },
              { key: "actor_id", label: "Actor" },
              { key: "request_id", label: "Request ID" },
              {
                key: "metadata",
                label: "Safe metadata",
                render: (r) => JSON.stringify(r.metadata),
              },
            ]}
          />
        )}
        <div className="pagination">
          <Button
            variant="secondary"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            variant="secondary"
            disabled={q.data?.data.length < 20}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </section>
    </>
  );
}
