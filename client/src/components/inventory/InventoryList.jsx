import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  propertyTypes,
  purposes,
  sorts,
  statusFor,
  statuses,
} from "../../lib/inventory";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  useToast,
} from "../common/UI";
import PropertyCard from "../properties/PropertyCard";
import PropertyDetails from "../properties/PropertyDetails";
import PropertyForm from "../properties/PropertyForm";
import PhotoGallery from "../properties/PhotoGallery";

const blankFilters = {
  search: "",
  type: "",
  purpose: "",
  status: "",
  city: "",
  min_price: "",
  max_price: "",
  sort: "newest",
};
// scope: company (administrators' listings), mine (the signed-in agent's own)
// or agent (one agent, opened by an administrator). canAdd shows "+ Add
// property"; whether a property can be changed comes from the server (can_edit).
export default function InventoryList({
  scope,
  agentId,
  canAdd = false,
  ownership,
  emptyText = "No properties found.",
  notice,
}) {
  const qc = useQueryClient(),
    toast = useToast();
  const [page, setPage] = useState(1),
    [filters, setFilters] = useState(blankFilters),
    [modal, setModal] = useState(null),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const debounced = useDebouncedValue(filters);
  const params = new URLSearchParams({ scope, page, covers: "true" });
  if (agentId) params.set("agent", agentId);
  for (const [key, value] of Object.entries(debounced))
    if (value !== "" && !(key === "sort" && value === "newest"))
      params.set(key, value);
  const q = useQuery({
    queryKey: ["properties", scope, agentId || null, debounced, page],
    queryFn: ({ signal }) => api("/properties?" + params, { signal }),
  });
  const detail = useQuery({
    queryKey: ["property", modal?.id],
    queryFn: ({ signal }) => api("/properties/" + modal.id, { signal }),
    // Paused while editing: the form must keep the updated_at it started
    // from, so someone else's newer save is reported instead of overwritten.
    enabled: !!modal?.id && !editing,
    placeholderData: modal?.id ? modal : undefined,
  });
  // Edit waits for the full record so private owner contact details are
  // never missing from the form (and so never cleared by a save).
  const current = detail.data || modal;
  const loaded = !!modal?.id && !detail.isPlaceholderData && !!detail.data;
  const canEdit = loaded && current.can_edit;
  const refresh = (id) => {
    for (const key of [
      "properties",
      "property-options",
      "inventory-summary",
      "inventory-agents",
    ])
      qc.invalidateQueries({ queryKey: [key] });
    if (id) qc.invalidateQueries({ queryKey: ["property", id] });
  };
  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };
  const filtered = Object.entries(filters).some(
    ([key, value]) => value !== blankFilters[key],
  );
  const closeModal = () => {
    if (busy) return;
    setModal(null);
    setEditing(false);
    setConfirmDelete(false);
    setActionError("");
  };
  async function change(body, message) {
    setBusy(true);
    setActionError("");
    try {
      const saved = await api("/properties/" + current.id, {
        method: "PATCH",
        body: { ...body, expected_updated_at: current.updated_at },
      });
      qc.setQueryData(["property", saved.id], saved);
      refresh();
      toast(message);
      return saved;
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function removeProperty() {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await api("/properties/" + current.id, { method: "DELETE" });
      qc.removeQueries({ queryKey: ["photos", current.id] });
      qc.removeQueries({ queryKey: ["property", current.id] });
      refresh();
      setPage(1);
      setModal(null);
      setConfirmDelete(false);
      toast("Property deleted");
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(data, pictures, onUploaded) {
    if (busy) return;
    setBusy(true);
    let saved;
    try {
      saved = await api("/properties" + (modal.id ? "/" + modal.id : ""), {
        method: modal.id ? "PATCH" : "POST",
        body: data,
      });
      // Retain the created ID if a picture fails, so retry updates this
      // property and uploads only the remaining pictures.
      qc.setQueryData(["property", saved.id], saved);
      setModal(saved);
      refresh();
      for (const picture of pictures) {
        const body = new FormData();
        body.append("file", picture.file);
        await api(`/properties/${saved.id}/photos`, { method: "POST", body });
        onUploaded(picture);
        qc.invalidateQueries({ queryKey: ["photos", saved.id] });
      }
      toast(pictures.length ? "Property and pictures saved" : "Property saved");
      if (pictures.length) setEditing(false);
      else setModal(null);
    } catch (error) {
      if (saved && pictures.length)
        throw new Error(
          `Property saved, but some pictures could not be uploaded. ${error.message} Click Save record to retry the remaining pictures.`,
        );
      throw error;
    } finally {
      setBusy(false);
    }
  }
  const agent = q.data?.agent;
  return (
    <>
      {agent && (
        <div className="inventory-agent" role="status">
          <strong>{agent.name}</strong>
          {agent.email && <span>{agent.email}</span>}
          {agent.status !== "active" && (
            <span className="badge lost">
              {agent.status === "deleted" ? "Deleted account" : "Disabled"}
            </span>
          )}
        </div>
      )}
      {(notice || canAdd) && (
        <div className="inventory-bar">
          {notice && <p className="field-hint">{notice}</p>}
          {canAdd && (
            <Button
              onClick={() => {
                setModal({});
                setEditing(true);
              }}
            >
              + Add property
            </Button>
          )}
        </div>
      )}
      <div className="toolbar inventory-filters">
        <input
          aria-label="Search properties"
          placeholder="Search title, area or PR number…"
          value={filters.search}
          onChange={(e) => setFilter("search", e.target.value)}
        />
        <select
          aria-label="Filter by type"
          value={filters.type}
          onChange={(e) => setFilter("type", e.target.value)}
        >
          <option value="">All types</option>
          {propertyTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="Filter by purpose"
          value={filters.purpose}
          onChange={(e) => setFilter("purpose", e.target.value)}
        >
          <option value="">Sale and rent</option>
          {purposes.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by city or area"
          placeholder="City or area"
          value={filters.city}
          onChange={(e) => setFilter("city", e.target.value)}
        />
        <input
          aria-label="Minimum price"
          placeholder="Min price (PKR)"
          type="number"
          min="0"
          inputMode="numeric"
          value={filters.min_price}
          onChange={(e) => setFilter("min_price", e.target.value)}
        />
        <input
          aria-label="Maximum price"
          placeholder="Max price (PKR)"
          type="number"
          min="0"
          inputMode="numeric"
          value={filters.max_price}
          onChange={(e) => setFilter("max_price", e.target.value)}
        />
        <select
          aria-label="Sort properties"
          value={filters.sort}
          onChange={(e) => setFilter("sort", e.target.value)}
        >
          {sorts.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
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
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.data?.data.length ? (
        <div className="property-grid fx-stagger">
          {q.data.data.map((p) => (
            <PropertyCard
              key={p.id}
              property={p}
              onView={() => {
                setModal(p);
                setEditing(false);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="panel empty">
          {filtered ? "No properties match these filters." : emptyText}
        </div>
      )}
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
      {modal && (
        <Modal
          className="property-dialog"
          title={
            confirmDelete
              ? "Delete property?"
              : editing
                ? modal.id
                  ? "Edit property"
                  : "Add property"
                : current.title
          }
          onClose={closeModal}
        >
          {confirmDelete ? (
            <>
              <p>
                Permanently delete <strong>{current.title}</strong> and its
                photos? This cannot be undone. Properties linked to leads,
                visits or deals must be archived instead.
              </p>
              <ErrorBox error={actionError} />
              <div className="actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  autoFocus
                  onClick={() => {
                    setConfirmDelete(false);
                    setActionError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={removeProperty}
                >
                  {busy ? "Deleting…" : "Delete permanently"}
                </Button>
              </div>
            </>
          ) : editing ? (
            <PropertyForm
              initial={modal.id ? current : undefined}
              ownership={ownership}
              onSave={save}
            />
          ) : (
            <>
              <ErrorBox error={detail.error} />
              <PropertyDetails property={current} />
              <PhotoGallery propertyId={current.id} canManage={canEdit} />
              {canEdit && (
                <>
                  <ErrorBox error={actionError} />
                  <label className="inventory-status">
                    Change status
                    <select
                      aria-label="Change status"
                      value={current.availability}
                      disabled={busy}
                      onChange={(e) =>
                        change(
                          { availability: e.target.value },
                          "Status updated",
                        )
                      }
                    >
                      {statusFor(current.purpose).map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="actions">
                    <Button disabled={busy} onClick={() => setEditing(true)}>
                      Edit property
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setActionError("");
                        setConfirmDelete(true);
                      }}
                    >
                      Delete property
                    </Button>
                    {current.availability !== "archived" && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              "Archive this property? It is marked Inactive and existing lead and deal history is retained.",
                            )
                          )
                            return;
                          if (
                            await change(
                              { availability: "archived" },
                              "Property archived",
                            )
                          )
                            setModal(null);
                        }}
                      >
                        Archive property
                      </Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
