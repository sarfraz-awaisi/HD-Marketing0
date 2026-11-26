import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Clock, Copy, Pencil, Store } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { api, date } from "../../lib/api";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { dealerSorts, formatDealerPhone } from "../../lib/dealers";
import { KpiTile } from "../../components/dashboard/Widgets";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  useToast,
} from "../../components/common/UI";
import DealerForm from "../../components/dealers/DealerForm";
import DealerDetails, {
  DealerStatus,
} from "../../components/dealers/DealerDetails";
import "../../styles/dashboard.css";
import "../../styles/dealers.css";

// Dealer affiliate network (update 049). Agents add dealers and follow their
// review; administrators review, change, delete and restore every dealer.
// The server decides what each person may see: an agent's list, counts and
// search only ever contain their own dealers. Update 059: agents edit their
// own dealers; changes to an approved dealer wait for an administrator, and
// Edit requests lists those dealers. Administrators select dealers (kept
// while paging, cleared when the tab or a filter changes) and act on them
// together: Delete, or Approve or Reject pending dealers (BulkDialog).
const tabsFor = (admin) => [
  ["all", "All"],
  ["pending", "Pending"],
  ["changes", "Edit requests"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ...(admin ? [["deleted", "Deleted"]] : []),
];
const blankFilters = {
  search: "",
  sort: "newest",
  agent: "",
  duplicates: false,
};
const limit = 20;
// Bulk actions: up to 200 dealers at a time.
const bulkMax = 200;
const bulkActions = {
  delete: ["Delete", "Deleting…", "deleted"],
  approve: ["Approve", "Approving…", "approved"],
  reject: ["Reject", "Rejecting…", "rejected"],
};
const plural = (n, one = "dealer") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : one + "s"}`;

// Confirms a bulk action on the selected dealers and shows what was done.
// The server checks each dealer again and leaves out any changed since it
// was selected; the button is busy until the reply, so it is sent once.
function BulkDialog({ action, dealers, onClose, onDone }) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  const [verb, busyText, past] = bulkActions[action];
  const names = new Map(dealers.map((d) => [d.id, d]));
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const reply = await api("/dealers/bulk", {
        method: "POST",
        body: {
          action,
          dealers: dealers.map((d) => ({
            id: d.id,
            expected_updated_at: d.updated_at,
          })),
          ...(action !== "approve" && reason.trim()
            ? { reason: reason.trim() }
            : {}),
        },
      });
      const failed = reply.results.filter((r) => r.result === "failed");
      onDone(reply, failed);
      if (failed.length) setResult(reply);
      else onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${verb} ${plural(dealers.length)}`}
      onClose={() => !busy && onClose()}
    >
      <ErrorBox error={error} />
      {result ? (
        <>
          <p role="status">
            {plural(result.done + result.unchanged)} {past}.{" "}
            {plural(result.failed)} not {past}:
          </p>
          <ul className="dealer-bulk-failed">
            {result.results
              .filter((r) => r.result === "failed")
              .map((r) => (
                <li key={r.id}>
                  <strong>
                    {names.get(r.id)?.reference} {names.get(r.id)?.name}
                  </strong>
                  : {r.reason}
                </li>
              ))}
          </ul>
          <p className="field-hint">
            They stay selected, so you can check them and try again.
          </p>
          <div className="actions">
            <Button onClick={onClose}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <p>
            {action === "delete"
              ? "These dealers leave every list, including the agents'. Each can be restored from Deleted; their details, change requests and history stay."
              : action === "approve"
                ? "These pending dealers become approved."
                : "These pending dealers are rejected; their agents see the reason and can correct and resubmit them."}{" "}
            A dealer changed after you selected it is left as it is.
          </p>
          <ul className="dealer-bulk-list">
            {dealers.slice(0, 10).map((d) => (
              <li key={d.id}>
                {d.reference} · {d.name}
              </li>
            ))}
            {dealers.length > 10 && (
              <li>and {plural(dealers.length - 10, "more dealer")}</li>
            )}
          </ul>
          {action !== "approve" && (
            <label>
              Reason (optional)
              <input
                maxLength={300}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              autoFocus
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant={action === "approve" ? undefined : "danger"}
              disabled={busy}
              onClick={confirm}
            >
              {busy ? busyText : `${verb} ${plural(dealers.length)}`}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Tabs({ tabs, tab, counts, onChange }) {
  const refs = useRef({});
  function onKeyDown(event) {
    const keys = tabs.map(([key]) => key);
    const index = keys.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? keys[(index + 1) % keys.length]
        : event.key === "ArrowLeft"
          ? keys[(index - 1 + keys.length) % keys.length]
          : null;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  }
  return (
    <div
      className="inventory-tabs"
      role="tablist"
      aria-label="Dealer status"
      onKeyDown={onKeyDown}
    >
      {tabs.map(([key, label]) => (
        <button
          key={key}
          ref={(el) => (refs.current[key] = el)}
          type="button"
          role="tab"
          id={`dealer-tab-${key}`}
          aria-selected={tab === key}
          aria-controls="dealer-panel"
          tabIndex={tab === key ? 0 : -1}
          className={tab === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {label}
          {counts?.[key] != null && (
            <span className="dealer-tab-count">{counts[key]}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export default function Dealers() {
  const { user } = useAuth(),
    admin = user.role === "admin";
  const qc = useQueryClient(),
    toast = useToast();
  const [params, setParams] = useSearchParams();
  const tabs = tabsFor(admin);
  const tab = tabs.some(([key]) => key === params.get("tab"))
    ? params.get("tab")
    : "all";
  const [filters, setFilters] = useState(blankFilters),
    [page, setPage] = useState(1),
    [modal, setModal] = useState(null),
    [menu, setMenu] = useState(false),
    [bulk, setBulk] = useState(null),
    [error, setError] = useState("");
  const debounced = useDebouncedValue(filters);
  const query = new URLSearchParams({ page, limit });
  if (tab === "deleted") query.set("view", "deleted");
  else if (tab === "changes") query.set("changes", "true");
  else if (tab !== "all") query.set("status", tab);
  if (debounced.search.trim()) query.set("search", debounced.search.trim());
  if (debounced.sort !== "newest") query.set("sort", debounced.sort);
  if (admin && debounced.agent) query.set("agent", debounced.agent);
  if (admin && debounced.duplicates) query.set("duplicates", "true");
  const list = useQuery({
    queryKey: ["dealers", tab, debounced, page],
    queryFn: ({ signal }) => api("/dealers?" + query, { signal }),
    placeholderData: (previous) => previous,
  });
  // Selection for bulk actions (administrators; not in Deleted): the list
  // without its page, so paging keeps it and any other change clears it.
  // Each selected dealer is remembered as last listed, for its version.
  const selectable = admin && tab !== "deleted";
  const listKey = new URLSearchParams(query);
  listKey.delete("page");
  const selection = useLeadSelection(listKey.toString(), bulkMax);
  const seen = useRef(new Map());
  for (const d of list.data?.data || []) seen.current.set(d.id, d);
  const selected = selection.ids.map((id) => seen.current.get(id));
  const allPending =
    selected.length > 0 && selected.every((d) => d?.status === "pending");
  const clearSelection = () => {
    selection.clear();
    setMenu(false);
  };
  async function selectAll() {
    setError("");
    const total = list.data?.count ?? 0;
    if (total > bulkMax)
      return setError(
        `Select all takes up to ${bulkMax} dealers. Narrow the filters first.`,
      );
    try {
      const found = [];
      for (let p = 1; p <= Math.ceil(total / 100); p++) {
        const q = new URLSearchParams(listKey);
        q.set("page", p);
        q.set("limit", 100);
        found.push(...(await api("/dealers?" + q)).data);
      }
      for (const d of found) seen.current.set(d.id, d);
      selection.replace(found.map((d) => d.id));
    } catch (e) {
      setError(e.message);
    }
  }
  const people = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: admin,
  });
  const detail = useQuery({
    queryKey: ["dealer", modal?.id],
    queryFn: ({ signal }) => api("/dealers/" + modal.id, { signal }),
    // Paused while editing: the form keeps the updated_at it started from,
    // so a newer change by someone else is reported instead of overwritten.
    enabled: !!modal?.id && modal.mode !== "edit",
  });
  const summary = list.data?.summary;
  const counts = summary && {
    all: summary.total,
    pending: summary.pending,
    changes: summary.changes,
    approved: summary.approved,
    rejected: summary.rejected,
    ...(admin ? { deleted: summary.deleted } : {}),
  };
  const filtered =
    filters.search.trim() !== "" ||
    filters.agent !== "" ||
    filters.duplicates ||
    filters.sort !== "newest";
  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };
  const refresh = (id) => {
    qc.invalidateQueries({ queryKey: ["dealers"] });
    if (id) qc.invalidateQueries({ queryKey: ["dealer", id] });
  };
  const close = () => setModal(null);
  const rows = list.data?.data || [];
  const columns = [
    { key: "reference", label: "Ref." },
    {
      key: "name",
      label: "Dealer",
      render: (d) => (
        <span className="dealer-name">
          <strong>{d.name}</strong>
          {d.company_name && <small>{d.company_name}</small>}
        </span>
      ),
    },
    {
      key: "phone",
      label: "Contact",
      render: (d) => formatDealerPhone(d.phone),
    },
    {
      key: "location",
      label: "Location",
      render: (d) => [d.area, d.city].filter(Boolean).join(", ") || "—",
    },
    {
      key: "status",
      label: "Status",
      render: (d) => (
        <span className="dealer-status">
          <DealerStatus status={d.status} />
          {d.pending_change && (
            <span className="badge fx-badge warning">Changes pending</span>
          )}
          {admin && d.duplicates > 0 && (
            <span
              className="badge fx-badge warning"
              title="Other records have this contact number"
            >
              Same number ×{d.duplicates}
            </span>
          )}
        </span>
      ),
    },
    ...(admin
      ? [
          {
            key: "submitted_by",
            label: "Added by",
            render: (d) => d.submitted_by?.name || "—",
          },
        ]
      : []),
    {
      key: "created_at",
      label: "Submitted",
      render: (d) => date(d.created_at),
    },
    {
      key: "open",
      label: "Actions",
      render: (d) => (
        <span className="dealer-row-actions">
          <Button
            variant="secondary"
            aria-label={`View ${d.name}`}
            onClick={() => setModal({ id: d.id, mode: "view" })}
          >
            View
          </Button>
          {/* Agents see only their own dealers; a deleted one stays as it is. */}
          {!d.deleted_at && (
            <Button
              variant="secondary"
              className="icon-button dealer-edit"
              aria-label={`Edit ${d.name}`}
              title="Edit"
              onClick={() => setModal({ id: d.id, mode: "edit", dealer: d })}
            >
              <Pencil size={16} aria-hidden="true" />
            </Button>
          )}
        </span>
      ),
    },
  ];
  const tiles = [
    ["Total dealers", summary?.total, Store, "navy"],
    ["Pending review", summary?.pending, Clock, "gold"],
    ["Approved", summary?.approved, CircleCheck, "green"],
    ["Rejected", summary?.rejected, CircleX, "navy"],
    ...(admin
      ? [
          [
            "Shared numbers",
            summary?.duplicates,
            Copy,
            "gold",
            "Dealers whose number another record also has",
          ],
        ]
      : []),
  ];
  const current = detail.data;
  // Edit from the list starts from the row; from the details, the dealer.
  const editing = modal?.dealer || current;
  const saved = (result) =>
    admin
      ? result.unchanged
        ? "No change was needed"
        : "Dealer updated"
      : result.unchanged
        ? "No change was needed"
        : result.withdrawn
          ? "Your proposed changes were withdrawn"
          : result.pending_change
            ? "Changes sent for approval"
            : result.status === "pending" && editing?.status === "rejected"
              ? "Dealer submitted again for review"
              : "Changes saved; still waiting for review";
  const agents = (people.data || []).filter((p) =>
    ["admin", "agent"].includes(p.role),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEALER AFFILIATE NETWORK</span>
          <h1>{admin ? "Dealers" : "My dealers"}</h1>
          <p>
            {admin
              ? "Review dealers submitted by agents and manage the whole network."
              : "Add the dealers you work with and follow their review. Only you and administrators can see them."}
          </p>
        </div>
        <Button onClick={() => setModal({ mode: "add" })}>+ Add dealer</Button>
      </div>
      <section className="kpi-grid dealer-stats" aria-label="Dealer summary">
        {tiles.map(([label, value, icon, tone, note]) => (
          <KpiTile
            key={label}
            label={label}
            value={list.isPending ? "…" : value}
            note={note}
            icon={icon}
            tone={tone}
          />
        ))}
      </section>
      <Tabs
        tabs={tabs}
        tab={tab}
        counts={counts}
        onChange={(key) => {
          setParams(key === "all" ? {} : { tab: key });
          setPage(1);
        }}
      />
      <section
        id="dealer-panel"
        role="tabpanel"
        aria-labelledby={`dealer-tab-${tab}`}
        className="dealer-panel"
      >
        <div className="toolbar dealer-filters">
          <input
            type="search"
            aria-label="Search dealers"
            placeholder="Search name, agency, address or number…"
            value={filters.search}
            maxLength={100}
            onChange={(e) => setFilter("search", e.target.value)}
          />
          {admin && (
            <select
              aria-label="Added by"
              value={filters.agent}
              onChange={(e) => setFilter("agent", e.target.value)}
            >
              <option value="">Everyone</option>
              {agents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.role === "admin" ? " (admin)" : ""}
                  {p.active ? "" : " (disabled)"}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Sort dealers"
            value={filters.sort}
            onChange={(e) => setFilter("sort", e.target.value)}
          >
            {dealerSorts.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {admin && (
            <label>
              <input
                type="checkbox"
                checked={filters.duplicates}
                onChange={(e) => setFilter("duplicates", e.target.checked)}
              />
              Shared numbers only
            </label>
          )}
          {filtered && (
            <Button
              variant="secondary"
              onClick={() => {
                setFilters(blankFilters);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
        <ErrorBox error={error || list.error} />
        {selectable && rows.length > 0 && (
          <div className="lead-selection-tools dealer-selection-tools">
            <div>
              <Button variant="secondary" onClick={selectAll}>
                Select all {plural(list.data.count, "matching dealer")}
              </Button>
            </div>
            {selection.ids.length > 0 && (
              <div
                className="bulk-action-bar"
                role="toolbar"
                aria-label="Selected dealer actions"
              >
                <b>{plural(selection.ids.length)} selected</b>
                <Button
                  aria-expanded={menu}
                  aria-controls="dealer-bulk-menu"
                  onClick={() => setMenu((open) => !open)}
                >
                  Bulk actions
                </Button>
                <Button variant="secondary" onClick={clearSelection}>
                  Clear selection
                </Button>
                {menu && (
                  <div
                    id="dealer-bulk-menu"
                    className="dealer-bulk-menu"
                    role="group"
                    aria-label="Bulk actions"
                  >
                    <Button variant="danger" onClick={() => setBulk("delete")}>
                      Delete selected
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!allPending}
                      onClick={() => setBulk("approve")}
                    >
                      Approve selected
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!allPending}
                      onClick={() => setBulk("reject")}
                    >
                      Reject selected
                    </Button>
                    {!allPending && (
                      <p className="field-hint">
                        Approve and Reject are for pending dealers only: select
                        them in Pending.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {list.isPending ? (
          <Loader />
        ) : rows.length ? (
          <Table
            columns={columns}
            rows={rows}
            selection={selectable ? selection : undefined}
          />
        ) : list.error ? null : (
          <div className="panel empty">
            {filtered || tab !== "all"
              ? "No dealers match these filters."
              : admin
                ? "No dealers yet. Choose + Add dealer to add the first one."
                : "You haven't added any dealers yet. Choose + Add dealer to submit your first one."}
          </div>
        )}
        <Pagination
          page={page}
          count={list.data?.count}
          limit={limit}
          onPage={setPage}
        />
      </section>
      {bulk && (
        <BulkDialog
          action={bulk}
          dealers={selected.filter(Boolean)}
          onClose={() => setBulk(null)}
          onDone={(reply, failed) => {
            refresh();
            // Only the dealers not done stay selected.
            selection.replace(failed.map((r) => r.id));
            setMenu(false);
            toast(
              `${plural(reply.done + reply.unchanged)} ${bulkActions[bulk][2]}` +
                (failed.length ? `, ${plural(failed.length)} not` : ""),
            );
          }}
        />
      )}
      {modal && (
        <Modal
          className="dealer-dialog"
          title={
            modal.mode === "add"
              ? "Add dealer"
              : modal.mode === "edit"
                ? "Edit dealer"
                : current
                  ? `${current.reference} · ${current.name}`
                  : "Dealer"
          }
          onClose={close}
        >
          {modal.mode === "add" ? (
            <DealerForm
              admin={admin}
              onCancel={close}
              onSaved={(saved) => {
                refresh();
                close();
                toast(
                  saved.status === "approved"
                    ? `Dealer ${saved.reference} added and approved`
                    : `Dealer ${saved.reference} submitted for review`,
                );
              }}
            />
          ) : modal.mode === "edit" && editing ? (
            <DealerForm
              admin={admin}
              initial={editing}
              onCancel={() => setModal({ id: modal.id, mode: "view" })}
              onSaved={(result) => {
                refresh(result.id);
                setModal({ id: result.id, mode: "view" });
                toast(saved(result));
              }}
            />
          ) : detail.error ? (
            <ErrorBox error={detail.error} />
          ) : !current ? (
            <Loader />
          ) : (
            <DealerDetails
              key={current.id}
              dealer={current}
              admin={admin}
              onEdit={() => setModal({ id: current.id, mode: "edit" })}
              onOpen={(id) => setModal({ id, mode: "view" })}
              onChanged={(saved, message) => {
                refresh(saved.id);
                toast(message);
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
}
