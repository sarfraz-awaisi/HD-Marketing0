import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { dayLabel, todayPk } from "../../lib/calendar";
import { kpiPeriods, kpiRange, platformLabels } from "../../lib/kpiPeriods";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
import { EvidenceLink, EvidenceStatus, PhotoViewer } from "./KpiEvidence";
import "../../styles/kpis.css";
// Administrators' review of KPI evidence (update 072): social media links,
// project visit photos and video links, and agents' listings for the
// verified inventory KPI. Approve, or reject with an optional reason; a
// decision can be changed later, and every one is in Audit history. A
// listing is verified only with the owner's name and phone. This is apart
// from "Add to Admin List", which copies a listing to the company inventory.
const kinds = [
  ["social", "Social links"],
  ["visit", "Visit photos"],
  ["video", "Videos"],
  ["inventory", "Inventory"],
];
const statuses = (kind) => [
  ["pending", "Waiting"],
  [
    kind === "inventory" ? "verified" : "approved",
    kind === "inventory" ? "Verified" : "Approved",
  ],
  ["rejected", "Rejected"],
  ["", "All"],
];
const periods = [["all", "All dates"], ...kpiPeriods];
const LIMIT = 25;
const path = (kind, query) =>
  `${kind === "inventory" ? "/kpis/inventory" : "/kpis/evidence"}?${new URLSearchParams(query)}`;

function RejectDialog({ title, error, onClose, onReject }) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onReject(reason.trim() || null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <label>
          Reason (optional; the agent sees it)
          <textarea
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="kpi-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy}>
            {busy ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function KpiReviews() {
  const qc = useQueryClient(),
    toast = useToast();
  const [params, setParams] = useSearchParams();
  const kind = kinds.some(([k]) => k === params.get("kind"))
    ? params.get("kind")
    : "social";
  const status = params.has("status") ? params.get("status") : "pending";
  const period = params.get("period") || "all";
  const range =
    period === "all"
      ? null
      : (kpiRange(period) ?? {
          from: params.get("from") || todayPk(),
          to: params.get("to") || todayPk(),
        });
  const agent = params.get("agent") || "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [photo, setPhoto] = useState(null),
    [rejecting, setRejecting] = useState(null),
    [busy, setBusy] = useState(null),
    [error, setError] = useState("");
  const update = (patch) => {
    const next = new URLSearchParams(params);
    next.set("tab", "reviews");
    for (const [k, v] of Object.entries({ page: null, ...patch }))
      v === null || v === undefined ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };
  const query = {
    ...(kind !== "inventory" ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(agent ? { agent } : {}),
    ...(range ? range : {}),
    page,
    limit: LIMIT,
  };
  const valid = !range || range.from <= range.to;
  const list = useQuery({
    queryKey: ["kpis", "reviews", kind, query],
    queryFn: ({ signal }) => api(path(kind, query), { signal }),
    enabled: valid,
  });
  // How many wait in each list, whatever the other filters.
  const waiting = useQuery({
    queryKey: ["kpis", "reviews", "waiting"],
    queryFn: async ({ signal }) =>
      Object.fromEntries(
        await Promise.all(
          kinds.map(async ([k]) => [
            k,
            (
              await api(
                path(k, {
                  ...(k !== "inventory" ? { kind: k } : {}),
                  status: "pending",
                  limit: 1,
                }),
                { signal },
              )
            ).count,
          ]),
        ),
      ),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (u) => u.role === "agent",
  );
  async function decide(row, next, reason = null) {
    if (busy) return;
    setBusy(row.id);
    setError("");
    try {
      await api(
        kind === "inventory"
          ? `/kpis/inventory/${row.id}/review`
          : `/kpis/evidence/${row.id}/review`,
        { method: "POST", body: { status: next, reason } },
      );
      qc.invalidateQueries({ queryKey: ["kpis"] });
      setRejecting(null);
      toast(
        next === "pending"
          ? "Decision cleared"
          : `${next[0].toUpperCase()}${next.slice(1)}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  const reviewed = (row) =>
    row.status !== "pending" && (
      <small className="kpi-sub">
        {row.reviewed_by?.name ? `by ${row.reviewed_by.name} ` : ""}
        {date(row.reviewed_at)}
        {row.reason ? ` · ${row.reason}` : ""}
      </small>
    );
  const agentColumn = {
    key: "agent",
    label: "Agent",
    render: (row) => (
      <>
        <b>{row.agent?.name ?? "—"}</b>
        {row.agent?.uid != null && (
          <small className="kpi-sub">UID {row.agent.uid}</small>
        )}
      </>
    ),
  };
  const evidenceColumns = [
    agentColumn,
    {
      key: "day",
      label: kind === "social" ? "Day" : "Week",
      render: (row) =>
        kind === "social" ? (
          dayLabel(row.day)
        ) : (
          <>
            Week of {dayLabel(row.week)}
            <small className="kpi-sub">
              {kind === "visit"
                ? `Visit on ${dayLabel(row.day)}`
                : `Added ${dayLabel(row.day)}`}
            </small>
          </>
        ),
    },
    {
      key: "evidence",
      label: kind === "visit" ? "Project" : "Link",
      render: (row) =>
        kind === "visit" ? (
          <>
            <b>{row.project}</b>
            <button
              type="button"
              className="link-button kpi-sub"
              onClick={() => setPhoto(row)}
            >
              View photo
            </button>
          </>
        ) : (
          <>
            <EvidenceLink url={row.url} />
            <small className="kpi-sub">{platformLabels[row.platform]}</small>
          </>
        ),
    },
    {
      key: "submitted_at",
      label: "Submitted",
      render: (row) => date(row.submitted_at),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <>
          <EvidenceStatus status={row.status} />
          {reviewed(row)}
        </>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <div className="kpi-actions">
          {row.status !== "approved" && (
            <Button
              disabled={busy === row.id}
              onClick={() => decide(row, "approved")}
            >
              Approve
            </Button>
          )}
          {row.status !== "rejected" && (
            <Button
              variant="secondary"
              disabled={busy === row.id}
              onClick={() => setRejecting(row)}
            >
              Reject
            </Button>
          )}
        </div>
      ),
    },
  ];
  const inventoryColumns = [
    agentColumn,
    {
      key: "day",
      label: "Added",
      render: (row) => dayLabel(row.day),
    },
    {
      key: "listing",
      label: "Listing",
      render: (row) => (
        <>
          <Link to={`/inventory?property=${row.id}`}>
            #{row.property_no} {row.title}
          </Link>
          <small className="kpi-sub">
            {[row.area, row.city].filter(Boolean).join(", ") || "—"}
          </small>
        </>
      ),
    },
    {
      key: "owner",
      label: "Owner details",
      render: (row) =>
        row.owner_details ? (
          "Name and phone given"
        ) : (
          <span className="kpi-sub missed">Name or phone missing</span>
        ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <>
          <EvidenceStatus status={row.status} />
          {reviewed(row)}
        </>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <div className="kpi-actions">
          {row.status !== "verified" && (
            <Button
              disabled={busy === row.id || !row.owner_details}
              title={
                row.owner_details
                  ? undefined
                  : "The agent must add the owner's name and phone first"
              }
              onClick={() => decide(row, "verified")}
            >
              Verify
            </Button>
          )}
          {row.status !== "rejected" && (
            <Button
              variant="secondary"
              disabled={busy === row.id}
              onClick={() => setRejecting(row)}
            >
              Reject
            </Button>
          )}
          {row.status !== "pending" && (
            <Button
              variant="secondary"
              disabled={busy === row.id}
              onClick={() => decide(row, "pending")}
            >
              Clear
            </Button>
          )}
        </div>
      ),
    },
  ];
  const r = list.data;
  return (
    <>
      <section className="panel kpi-filters">
        <div className="review-tabs" role="tablist" aria-label="Evidence">
          {kinds.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={kind === value}
              className={kind === value ? "active" : ""}
              onClick={() =>
                update({
                  kind: value,
                  status:
                    status === "approved" || status === "verified"
                      ? value === "inventory"
                        ? "verified"
                        : "approved"
                      : status,
                })
              }
            >
              {label}
              {waiting.data?.[value] > 0 && (
                <span className="kpi-waiting-count">
                  {" "}
                  · {waiting.data[value]} waiting
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="kpi-filter-fields">
          <label>
            Status
            <select
              value={status}
              onChange={(e) => update({ status: e.target.value })}
            >
              {statuses(kind).map(([value, label]) => (
                <option key={label} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent
            <select
              aria-label="Agent"
              value={agent}
              onChange={(e) => update({ agent: e.target.value || null })}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.active ? "" : " (disabled)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Period
            <select
              value={period}
              onChange={(e) =>
                update(
                  e.target.value === "custom"
                    ? {
                        period: "custom",
                        from: range?.from ?? todayPk(),
                        to: range?.to ?? todayPk(),
                      }
                    : { period: e.target.value, from: null, to: null },
                )
              }
            >
              {periods.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {period === "custom" && (
            <>
              <label>
                From
                <input
                  type="date"
                  value={range.from}
                  onChange={(e) => update({ period, from: e.target.value })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={range.to}
                  onChange={(e) => update({ period, to: e.target.value })}
                />
              </label>
            </>
          )}
        </div>
        <p className="field-hint">
          {kind === "inventory"
            ? "Agents' listings by the day they were added. Verify needs the owner's name and phone; a verified listing counts for that day, also when verified later."
            : kind === "social"
              ? "Links by the day they were added. The day's KPI is Yes once one link is approved."
              : kind === "visit"
                ? "One photo is one visit: a project on a date. The week counts distinct approved project visits, also when approved after the week."
                : "Video links count in the week they were added, once approved."}{" "}
          Pending and rejected items never count.
        </p>
      </section>
      {!valid && <ErrorBox error="Choose a start on or before the end." />}
      <ErrorBox error={error || list.error} />
      {valid && list.isPending ? (
        <Loader />
      ) : (
        r && (
          <section className="panel kpi-review-list">
            <Table
              columns={
                kind === "inventory" ? inventoryColumns : evidenceColumns
              }
              rows={r.data}
              empty={
                status === "pending"
                  ? "Nothing is waiting for review here."
                  : "Nothing matches these filters."
              }
            />
            {r.count > LIMIT && (
              <Pagination
                page={page}
                count={r.count}
                limit={LIMIT}
                onPage={(p) => update({ page: String(p) })}
              />
            )}
          </section>
        )
      )}
      {photo && <PhotoViewer evidence={photo} onClose={() => setPhoto(null)} />}
      {rejecting && (
        <RejectDialog
          error={error}
          title={
            kind === "inventory"
              ? `Reject #${rejecting.property_no} ${rejecting.title}`
              : `Reject ${rejecting.agent?.name ?? "the agent"}'s ${kind === "visit" ? "visit photo" : "link"}`
          }
          onClose={() => setRejecting(null)}
          onReject={(reason) => decide(rejecting, "rejected", reason)}
        />
      )}
    </>
  );
}
