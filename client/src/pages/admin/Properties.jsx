import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  Button,
  Modal,
  ErrorBox,
  Loader,
  Pagination,
  useToast,
} from "../../components/common/UI";
import PropertyCard from "../../components/properties/PropertyCard";
import PropertyDetails from "../../components/properties/PropertyDetails";
import PropertyForm from "../../components/properties/PropertyForm";
import PhotoGallery from "../../components/properties/PhotoGallery";
export default function Properties() {
  const { user } = useAuth(),
    admin = user.role === "admin",
    qc = useQueryClient(),
    toast = useToast();
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState(null),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const closeModal = () => {
    if (busy) return;
    setModal(null);
    setConfirmDelete(false);
    setActionError("");
  };
  const removeProperty = async () => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await api("/properties/" + modal.id, { method: "DELETE" });
      qc.removeQueries({ queryKey: ["photos", modal.id] });
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property-options"] });
      setPage(1);
      setModal(null);
      setConfirmDelete(false);
      toast("Property deleted");
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const debouncedSearch = useDebouncedValue(search);
  const q = useQuery({
    queryKey: ["properties", page, debouncedSearch],
    queryFn: ({ signal }) =>
      api(
        "/properties?" +
          new URLSearchParams({
            page,
            search: debouncedSearch,
            covers: "true",
          }),
        { signal },
      ),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE RIGHT PLACE FOR EVERY CUSTOMER</span>
          <h1>Properties</h1>
          <p>Explore and manage your property portfolio.</p>
        </div>
        {admin && (
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
      <div className="toolbar">
        <input
          aria-label="Search properties"
          placeholder="Search properties…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
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
        <div className="panel empty">No properties found.</div>
      )}
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
      {modal && (
        <Modal
          title={
            confirmDelete
              ? "Delete property?"
              : editing
                ? modal.id
                  ? "Edit property"
                  : "Add property"
                : modal.title
          }
          onClose={closeModal}
        >
          {confirmDelete ? (
            <>
              <p>
                Permanently delete <strong>{modal.title}</strong> and its
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
              initial={modal.id ? modal : undefined}
              onSave={async (data, pictures, onUploaded) => {
                if (busy) return;
                setBusy(true);
                let saved;
                try {
                  saved = await api(
                    "/properties" + (modal.id ? "/" + modal.id : ""),
                    {
                      method: modal.id ? "PATCH" : "POST",
                      body: data,
                    },
                  );
                  // Retain the created ID if a picture fails, so retry updates
                  // this property and uploads only the remaining pictures.
                  setModal(saved);
                  qc.invalidateQueries({ queryKey: ["properties"] });
                  qc.invalidateQueries({ queryKey: ["property-options"] });
                  for (const picture of pictures) {
                    const body = new FormData();
                    body.append("file", picture.file);
                    await api(`/properties/${saved.id}/photos`, {
                      method: "POST",
                      body,
                    });
                    onUploaded(picture);
                    qc.invalidateQueries({ queryKey: ["photos", saved.id] });
                  }
                  toast(
                    pictures.length
                      ? "Property and pictures saved"
                      : "Property saved",
                  );
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
              }}
            />
          ) : (
            <>
              <PropertyDetails property={modal} />
              <PhotoGallery propertyId={modal.id} admin={admin} />
              {admin && (
                <>
                  <ErrorBox error={actionError} />
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
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "Archive this property? Existing lead and deal history will be retained.",
                          )
                        )
                          return;
                        setBusy(true);
                        setActionError("");
                        try {
                          await api("/properties/" + modal.id, {
                            method: "PATCH",
                            body: { availability: "archived" },
                          });
                          qc.invalidateQueries({ queryKey: ["properties"] });
                          toast("Property archived");
                          setModal(null);
                        } catch (e) {
                          setActionError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Archive property
                    </Button>
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
