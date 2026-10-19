import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { securityAlertLabel } from "../../lib/securityAlerts";
import {
  Button,
  Table,
  Pagination,
  Loader,
  ErrorBox,
  Badge,
  useToast,
} from "../../components/common/UI";
export default function SecurityAlerts() {
  const [page, setPage] = useState(1),
    [view, setView] = useState("unreviewed"),
    [severity, setSeverity] = useState("");
  const [busy, setBusy] = useState(null),
    [error, setError] = useState("");
  const pending = useRef(false),
    qc = useQueryClient(),
    toast = useToast();
  const list = useQuery({
    queryKey: ["security-alerts", page, view, severity],
    queryFn: () =>
      api(
        "/security-alerts?" +
          new URLSearchParams({
            page,
            view,
            ...(severity ? { severity } : {}),
          }),
      ),
    refetchInterval: 60000,
  });
  async function review(alert) {
    if (pending.current) return;
    pending.current = true;
    setBusy(alert.id);
    setError("");
    try {
      await api(`/security-alerts/${alert.id}`, {
        method: "PATCH",
        body: { reviewed: true },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["security-alerts"] }),
        qc.invalidateQueries({ queryKey: ["security-alert-summary"] }),
      ]);
      toast("Alert reviewed");
    } catch (failure) {
      setError(failure.message);
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CUSTOMER ACCESS OVERSIGHT</span>
          <h1>Security alerts</h1>
          <p>
            Review customer-access warnings and work held by inactive accounts.
          </p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="toolbar">
          <select
            aria-label="Alert review status"
            value={view}
            onChange={(event) => {
              setView(event.target.value);
              setPage(1);
            }}
          >
            <option value="unreviewed">Unreviewed alerts</option>
            <option value="all">All alerts</option>
            <option value="reviewed">Reviewed alerts</option>
          </select>
          <select
            aria-label="Alert severity"
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <ErrorBox error={list.error} />
        {list.isPending ? (
          <Loader />
        ) : (
          <>
            <Table
              rows={list.data?.data || []}
              columns={[
                {
                  key: "created_at",
                  label: "When",
                  render: (row) => date(row.created_at),
                },
                {
                  key: "severity",
                  label: "Severity",
                  render: (row) => <Badge value={row.severity} />,
                },
                {
                  key: "type",
                  label: "Alert",
                  render: (row) => securityAlertLabel(row.type),
                },
                { key: "user_name", label: "Team member" },
                {
                  key: "message",
                  label: "Details",
                  render: (row) => (
                    <>
                      {row.message}
                      {Number.isInteger(row.metadata?.shown_today) && (
                        <small className="alert-usage">
                          {row.metadata.shown_today} numbers shown · Daily limit{" "}
                          {row.metadata.limit}
                        </small>
                      )}
                      {row.type === "inactive_agent_leads" &&
                        Number.isInteger(row.metadata?.leads) && (
                          <small className="alert-usage">
                            {row.metadata.leads} leads need an administrator's
                            handover decision
                          </small>
                        )}
                    </>
                  ),
                },
                {
                  key: "reviewed_at",
                  label: "Review",
                  render: (row) =>
                    row.reviewed_at ? (
                      <span>Reviewed {date(row.reviewed_at)}</span>
                    ) : (
                      <Button
                        variant="secondary"
                        style={{ minWidth: 140, whiteSpace: "nowrap" }}
                        disabled={busy !== null}
                        onClick={() => review(row)}
                      >
                        {busy === row.id ? "Saving…" : "Mark reviewed"}
                      </Button>
                    ),
                },
              ]}
            />
            <Pagination page={page} count={list.data?.count} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}
