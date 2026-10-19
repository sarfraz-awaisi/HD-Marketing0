import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Table, ErrorBox, Loader, Badge } from "../../components/common/UI";
export default function Team() {
  const q = useQuery({ queryKey: ["users"], queryFn: () => api("/users") });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR PEOPLE, YOUR MOMENTUM</span>
          <h1>Team</h1>
          <p>
            Your team directory. Manage account access securely in Accounts.
          </p>
        </div>
        <Link className="button" to="/accounts">
          Manage accounts
        </Link>
      </div>
      <ErrorBox error={q.error} />
      <section className="panel">
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={q.data || []}
            columns={[
              { key: "uid", label: "UID", render: (r) => r.uid ?? "—" },
              { key: "name", label: "Name" },
              {
                key: "role",
                label: "Role",
                render: (r) => <Badge value={r.role} />,
              },
              {
                key: "active",
                label: "Access",
                render: (r) => (r.active ? "Active" : "Disabled"),
              },
            ]}
          />
        )}
      </section>
    </>
  );
}
