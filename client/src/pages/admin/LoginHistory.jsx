import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import { api, date, localISO } from "../../lib/api";
import {
  ErrorBox,
  Loader,
  Pagination,
  Table,
} from "../../components/common/UI";
const results = {
  success: ["Signed in", "active"],
  failed: ["Wrong password", "pending"],
  locked: ["Locked", "disabled"],
};
// A short, readable device label; the full browser text stays in the tooltip.
export function deviceLabel(agent = "") {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Chrome\//.test(agent)
      ? "Chrome"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iPhone/iPad"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS X/.test(agent)
          ? "Mac"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return agent ? [browser, system].filter(Boolean).join(" on ") : "—";
}
const nextDay = (day) =>
  new Date(Date.parse(day + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
export default function LoginHistory() {
  const [page, setPage] = useState(1),
    [user, setUser] = useState(""),
    [outcome, setOutcome] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api("/users") });
  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (user) params.set("user", user);
  if (outcome) params.set("outcome", outcome);
  // Dates are chosen in Pakistan time; the end date is inclusive.
  if (from) params.set("from", localISO(from + "T00:00"));
  if (to) params.set("to", localISO(nextDay(to) + "T00:00"));
  const list = useQuery({
    queryKey: ["login-history", params.toString()],
    queryFn: ({ signal }) => api("/login-history?" + params, { signal }),
    refetchInterval: 60000,
  });
  const filter = (set) => (event) => {
    set(event.target.value);
    setPage(1);
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WHO SIGNED IN, AND WHEN</span>
          <h1>Login history</h1>
          <p>
            Every CRM sign-in attempt. Five wrong passwords lock an account for
            15 minutes.
          </p>
        </div>
      </div>
      {list.data?.summary && (
        <div className="metric-grid fx-stagger">
          {[
            [
              "Failed attempts (24 hours)",
              list.data.summary.failed_24h,
              ShieldAlert,
            ],
            ["Accounts locked now", list.data.summary.locked_now, LockKeyhole],
          ].map(([label, value, Icon]) => (
            <section className="metric fx-card" key={label}>
              <div>
                <span>{label}</span>
                <Icon size={20} />
              </div>
              <strong>{value}</strong>
            </section>
          ))}
        </div>
      )}
      <section className="panel">
        <div className="toolbar">
          <select
            aria-label="Filter by account"
            value={user}
            onChange={filter(setUser)}
          >
            <option value="">All accounts</option>
            {(users.data || []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.uid ? ` · UID ${u.uid}` : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by result"
            value={outcome}
            onChange={filter(setOutcome)}
          >
            <option value="">All results</option>
            <option value="success">Signed in</option>
            <option value="failed">Wrong password</option>
            <option value="locked">Locked</option>
          </select>
          <input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={filter(setFrom)}
          />
          <input
            type="date"
            aria-label="To date"
            value={to}
            min={from || undefined}
            onChange={filter(setTo)}
          />
        </div>
        <ErrorBox error={list.error} />
        {list.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={list.data?.data || []}
            columns={[
              {
                key: "created_at",
                label: "Time",
                render: (r) => date(r.created_at),
              },
              {
                key: "user_name",
                label: "Account",
                render: (r) =>
                  r.user_name
                    ? `${r.user_name}${r.user_uid ? " · UID " + r.user_uid : ""}`
                    : "Unknown account",
              },
              { key: "email", label: "Email" },
              {
                key: "portal",
                label: "Portal",
                render: (r) =>
                  r.portal === "admin" ? "Admin" : r.portal ? "Agent" : "—",
              },
              {
                key: "outcome",
                label: "Result",
                render: (r) => (
                  <span className={`account-status ${results[r.outcome][1]}`}>
                    {results[r.outcome][0]}
                  </span>
                ),
              },
              { key: "ip", label: "IP address", render: (r) => r.ip || "—" },
              {
                key: "user_agent",
                label: "Device",
                render: (r) => (
                  <span title={r.user_agent || ""}>
                    {deviceLabel(r.user_agent || "")}
                  </span>
                ),
              },
            ]}
          />
        )}
        <Pagination
          page={page}
          count={list.data?.count || 0}
          onPage={setPage}
        />
      </section>
    </>
  );
}
